// One session: a child under a PTY, the VT terminal that taps its output,
// and the connections attached to it.
//
// The PTY's `data` callback is the hot path and never blocks: feed the VT,
// encode one output frame, hand it to every attached connection's queue,
// return. The child's fate comes from `proc.exited`, never from the
// terminal's `exit` callback, which reports PTY lifecycle and on Bun 1.3.14
// fires again on `close()` (findings/m0.md §4).

import type { Subprocess } from "bun";
import type { Effect, VtEngine, VtTerminal } from "../engine/types.ts";
import { isUnsupported } from "../engine/types.ts";
import {
  encodeFrame,
  FrameType,
  RENDER_CLEAR,
  type SessionInfo,
} from "../protocol/index.ts";
import type { Connection } from "./connection.ts";

export interface SessionOptions {
  id: string;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  engine: VtEngine;
  scrollback?: number;
  log(line: string): void;
}

/** How long to wait, after the child is reaped, for the PTY to report EIO before closing it anyway. */
const PTY_CLOSE_GRACE_MS = 500;

const enc = new TextEncoder();

export class Session {
  readonly id: string;
  readonly argv: string[];
  readonly cwd: string;
  readonly engineId: string;
  readonly createdAt = Date.now();
  status: "running" | "exited" | "corpse" = "running";
  exitCode: number | null = null;
  signalCode: string | null = null;
  exitedAt: number | null = null;
  title = "";
  pwd = "";
  cols: number;
  rows: number;

  readonly clients = new Set<Connection>();
  private readonly vt: VtTerminal;
  private readonly terminal: Bun.Terminal;
  private readonly proc: Subprocess;
  private ptyDone: () => void = () => {};
  private readonly ptyDonePromise = new Promise<void>(
    (r) => (this.ptyDone = r),
  );
  private disposed = false;
  private readonly log: (line: string) => void;
  bytesFromPty = 0;

  constructor(opts: SessionOptions) {
    this.id = opts.id;
    this.argv = opts.argv;
    this.cwd = opts.cwd;
    this.engineId = opts.engine.id;
    this.cols = opts.cols;
    this.rows = opts.rows;
    this.log = opts.log;

    this.vt = opts.engine.create({
      cols: opts.cols,
      rows: opts.rows,
      scrollback: opts.scrollback ?? 2000,
    });

    // Subscribed before the child's first byte: with no listener libghostty
    // answers no query at all (findings/m1.md, effects).
    const sub = this.vt.onEffect((e) => this.onEffect(e));
    if (isUnsupported(sub))
      this.log(
        `session ${this.id}: engine has no effects; queries will go unanswered`,
      );

    // The terminal is passed as inline options, not as a pre-made
    // `Bun.Terminal`: on Bun 1.3.14 only the inline form makes the child a
    // session leader with the PTY as its controlling terminal. With a
    // Terminal object the child stays in the daemon's session with no tty,
    // so ^C and SIGWINCH never reach it (findings/m2.md).
    this.proc = Bun.spawn(opts.argv, {
      cwd: opts.cwd,
      env: { ...opts.env, TERM: "xterm-256color" },
      terminal: {
        cols: opts.cols,
        rows: opts.rows,
        name: "xterm-256color",
        data: (_t, bytes) => this.onData(bytes),
        exit: () => this.ptyDone(),
      },
    });
    this.terminal = this.proc.terminal!;
    this.log(
      `session ${this.id}: spawned pid ${this.proc.pid} ${JSON.stringify(opts.argv)} at ${opts.cols}x${opts.rows}`,
    );
    void this.proc.exited.then(() => this.onExited());
  }

  get pid(): number {
    return this.proc.pid;
  }

  // -- the hot path ---------------------------------------------------------

  private onData(bytes: Uint8Array): void {
    this.bytesFromPty += bytes.length;
    try {
      this.vt.write(bytes);
    } catch (e) {
      this.log(`session ${this.id}: vt.write threw: ${String(e)}`);
    }
    if (this.clients.size === 0) return;
    const frame = encodeFrame(FrameType.output, bytes);
    for (const c of this.clients) c.sendOutputFrame(frame);
  }

  private onEffect(e: Effect): void {
    switch (e.kind) {
      case "write-pty":
        if (this.status === "running") this.terminal.write(e.bytes);
        return;
      case "title":
        this.title = e.title;
        this.notify({
          t: "effect",
          id: this.id,
          kind: "title",
          value: e.title,
        });
        return;
      case "pwd":
        this.pwd = e.pwd;
        this.notify({ t: "effect", id: this.id, kind: "pwd", value: e.pwd });
        return;
      case "bell":
        this.notify({ t: "effect", id: this.id, kind: "bell" });
        return;
      default:
        this.log(`session ${this.id}: effect ${JSON.stringify(e)}`);
    }
  }

  private notify(msg: Parameters<Connection["sendControl"]>[0]): void {
    for (const c of this.clients) c.sendControl(msg);
  }

  private async onExited(): Promise<void> {
    this.status = "exited";
    this.exitCode = this.proc.exitCode;
    this.signalCode = this.proc.signalCode;
    this.exitedAt = Date.now();
    this.log(
      `session ${this.id}: exited code=${this.exitCode} signal=${this.signalCode}`,
    );
    // Let the PTY deliver whatever the child wrote last; EIO on the master
    // means the slave side is gone and everything has been read. A
    // grandchild holding the slave open would delay EIO, so bound the wait.
    await Promise.race([this.ptyDonePromise, Bun.sleep(PTY_CLOSE_GRACE_MS)]);
    if (!this.disposed) this.terminal.close();
    this.notify({
      t: "exited",
      id: this.id,
      exitCode: this.exitCode,
      signalCode: this.signalCode,
    });
  }

  // -- attach / detach ------------------------------------------------------

  attach(
    conn: Connection,
    cols: number,
    rows: number,
    readOnly: boolean,
  ): void {
    this.clients.add(conn);
    conn.attached = { id: this.id, readOnly };
    this.resize(cols, rows);
    conn.sendRender(this.render());
    if (this.status !== "running") {
      conn.sendControl({
        t: "exited",
        id: this.id,
        exitCode: this.exitCode,
        signalCode: this.signalCode,
      });
    }
  }

  detach(conn: Connection): void {
    this.clients.delete(conn);
    conn.attached = null;
  }

  /** The daemon owns the size; whoever attached or resized most recently sets it. */
  resize(cols: number, rows: number): void {
    if (cols < 1 || rows < 1) return;
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    this.vt.resize(cols, rows);
    if (this.status === "running") this.terminal.resize(cols, rows);
  }

  input(bytes: Uint8Array): void {
    if (this.status !== "running") return;
    this.terminal.write(bytes);
  }

  /**
   * A re-emission of the viewport: clear, then the screen with the cursor
   * placed and the pending SGR restored. Viewport only; `logs` is the way
   * to see history from a CLI.
   */
  render(): Uint8Array {
    const vt = this.vt.emitVt({ cursor: true, style: true, scrollback: false });
    const body = isUnsupported(vt)
      ? enc.encode(this.vt.plainText().replace(/\n/g, "\r\n"))
      : vt;
    const clear = enc.encode(RENDER_CLEAR);
    const out = new Uint8Array(clear.length + body.length);
    out.set(clear, 0);
    out.set(body, clear.length);
    return out;
  }

  logs(format: "text" | "vt"): string {
    if (format === "vt") {
      const vt = this.vt.emitVt({
        cursor: false,
        style: false,
        scrollback: true,
      });
      return isUnsupported(vt)
        ? this.vt.plainText()
        : new TextDecoder().decode(vt);
    }
    // The seam's plainText is the viewport; the wasm adapter also has the
    // whole active screen as text, which is what a log wants.
    const full = (this.vt as { fullText?: () => string }).fullText;
    return typeof full === "function"
      ? full.call(this.vt)
      : this.vt.plainText();
  }

  kill(signal: string): void {
    this.proc.kill(signal as NodeJS.Signals);
  }

  info(): SessionInfo {
    return {
      id: this.id,
      argv: this.argv,
      cwd: this.cwd,
      engine: this.engineId,
      status: this.status,
      exitCode: this.exitCode,
      signalCode: this.signalCode,
      title: this.title,
      pwd: this.pwd,
      createdAt: this.createdAt,
      exitedAt: this.exitedAt,
      attachedClients: this.clients.size,
      cols: this.cols,
      rows: this.rows,
    };
  }

  /** Tears everything down; the child gets SIGKILL if it is still running. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const c of this.clients) c.attached = null;
    this.clients.clear();
    if (this.status === "running") {
      try {
        this.proc.kill("SIGKILL");
      } catch {}
    }
    try {
      this.terminal.close();
    } catch {}
    this.vt.dispose();
  }
}
