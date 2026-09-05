// One session: a child under a PTY, the VT terminal that taps its output,
// and the connections attached to it.
//
// The PTY's `data` callback is the hot path and never blocks: feed the VT,
// encode one output frame, hand it to every attached connection's queue,
// return. The child's fate comes from `proc.exited`, never from the
// terminal's `exit` callback, which reports PTY lifecycle and on Bun 1.3.14
// fires again on `close()` (findings/m0.md §4).
//
// A session has two ways of coming into being. `new Session(opts)` spawns
// a child and taps it. `Session.restore(opts)` builds a corpse from a
// snapshot file: the emulator comes from `engine.decodeState()`, there is
// no child and no PTY, input is ignored, and the screen never changes
// again. A corpse whose snapshot was encoded by a different libghostty
// commit has no emulator at all and only its listing survives.

import type { Subprocess } from "bun";
import type { Effect, VtEngine, VtTerminal } from "../engine/types.ts";
import { isUnsupported } from "../engine/types.ts";
import { platform, type ProcessTree } from "../platform/index.ts";
import {
  encodeFrame,
  FrameType,
  RENDER_CLEAR,
  type AttachMode,
  type CorpseInfo,
  type KillMode,
  type KillRecord,
  type RestoreStats,
  type ScreenResult,
  type SessionInfo,
  WP_VERSION,
} from "../protocol/index.ts";
import type { Connection, Paint } from "./connection.ts";
import type { SnapshotHeader } from "./snapshot.ts";

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
  /** Called once the child is reaped and its last output is in the emulator; the daemon snapshots there. */
  onExit?(session: Session): void;
}

export interface RestoreOptions {
  header: SnapshotHeader;
  /** The `GHOSTSNP` bytes; empty for a header-only file. */
  bytes: Uint8Array;
  /** Null when the snapshot's libghostty commit is not the daemon's: listed, not decoded. */
  engine: VtEngine | null;
  /** The daemon's libghostty commit, for the mismatch notice. */
  daemonGhostty: string;
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
  readonly createdAt: number;
  status: "running" | "exited" | "corpse" = "running";
  exitCode: number | null = null;
  signalCode: string | null = null;
  exitedAt: number | null = null;
  title = "";
  pwd = "";
  cols: number;
  rows: number;
  /** When this session's snapshot file was last written. */
  snapshotAt: number | null = null;
  /** State needs saving: initially, after output, or after a resize. */
  dirty = true;
  corpse: CorpseInfo | null = null;
  restore: RestoreStats | null = null;
  /** The last kill this session was asked for; what came of it is `status`. */
  killRecord: KillRecord | null = null;

  readonly clients = new Set<Connection>();
  /** Null only for a mismatch corpse, which has nothing to render. */
  private readonly vt: VtTerminal | null;
  private readonly terminal: Bun.Terminal | null;
  private readonly proc: Subprocess | null;
  /** What holds the child's descendants, so a kill can take them too. */
  private readonly tree: ProcessTree | null;
  private ptyDone: () => void = () => {};
  private readonly ptyDonePromise = new Promise<void>(
    (r) => (this.ptyDone = r),
  );
  private disposed = false;
  private readonly log: (line: string) => void;
  private readonly onExit: ((s: Session) => void) | undefined;
  bytesFromPty = 0;

  constructor(opts: SessionOptions | RestoreOptions) {
    if ("header" in opts) {
      const h = opts.header;
      this.id = h.id;
      this.argv = h.argv;
      this.cwd = h.cwd;
      this.engineId = h.engine;
      this.createdAt = h.createdAt;
      this.cols = h.cols;
      this.rows = h.rows;
      this.title = h.title;
      this.pwd = h.pwd;
      this.exitCode = h.exitCode;
      this.signalCode = h.signalCode;
      this.exitedAt = h.exitedAt;
      this.snapshotAt = h.snapshotAt;
      this.status = "corpse";
      this.log = opts.log;
      this.terminal = null;
      this.proc = null;
      this.tree = null;
      this.vt = this.decode(opts);
      return;
    }
    this.id = opts.id;
    this.argv = opts.argv;
    this.cwd = opts.cwd;
    this.engineId = opts.engine.id;
    this.createdAt = Date.now();
    this.cols = opts.cols;
    this.rows = opts.rows;
    this.log = opts.log;
    this.onExit = opts.onExit;

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
    // Before the child can start anything of its own: on Windows the tree is
    // a Job Object and membership is inherited, so what is assigned here is
    // everything that follows (../platform/).
    this.tree = platform.adoptTree({
      pid: this.proc.pid,
      kill: (signal) => this.proc?.kill(signal as NodeJS.Signals),
      writePty: (bytes) => this.terminal?.write(bytes),
    });
    this.log(
      `session ${this.id}: spawned pid ${this.proc.pid} ${JSON.stringify(opts.argv)} at ${opts.cols}x${opts.rows}, tree held by ${this.tree.holds}`,
    );
    void this.proc.exited.then(() => this.onExited());
  }

  /** A corpse from a snapshot file; see the header comment. */
  static restore(opts: RestoreOptions): Session {
    return new Session(opts);
  }

  /**
   * The two-stage decode. `ready()` gives a terminal with the active screen
   * and the newest page of scrollback, attachable at once; `next()` then
   * prepends the rest of the history a page at a time. Here the pages are
   * driven to completion synchronously — the restore is at daemon start,
   * before the socket is listening — and both phases are timed for the
   * findings. A product would probably run the history phase lazily, on
   * first attach or on a timer, since `ready()` is all a first paint needs.
   */
  private decode(opts: RestoreOptions): VtTerminal | null {
    const h = opts.header;
    if (h.corpse?.reason === "mismatch") {
      // Carried forward from an earlier daemon that already found the
      // mismatch; the bytes were never decodable here.
      this.corpse = h.corpse;
      return null;
    }
    if (!opts.engine || h.ghostty !== opts.daemonGhostty) {
      this.corpse = {
        reason: "mismatch",
        snapshotEngine: h.ghostty,
        daemonEngine: opts.daemonGhostty,
      };
      this.log(
        `session ${this.id}: snapshot from ghostty ${h.ghostty.slice(0, 8)}, daemon runs ${opts.daemonGhostty.slice(0, 8)}; listed, not decoded`,
      );
      return null;
    }
    if (opts.bytes.byteLength === 0) {
      this.corpse = { reason: "restored" };
      this.log(`session ${this.id}: snapshot has no bytes; listed only`);
      return null;
    }
    const t0 = performance.now();
    const d = opts.engine.decodeState(opts.bytes);
    if (isUnsupported(d)) {
      this.corpse = { reason: "restored" };
      this.log(`session ${this.id}: engine cannot decode: ${d.reason}`);
      return null;
    }
    const vt = d.ready();
    const readyMs = performance.now() - t0;
    const rowsOf = (t: VtTerminal) => {
      const f = (t as { getNumber?: (d: string) => number }).getNumber;
      return typeof f === "function" ? f.call(t, "TOTAL_ROWS") : -1;
    };
    const readyRows = rowsOf(vt);
    const t1 = performance.now();
    let pages = 0;
    for (let p = d.next(); p; p = d.next()) pages++;
    const historyMs = performance.now() - t1;
    this.restore = {
      readyMs,
      historyMs,
      readyRows,
      totalRows: rowsOf(vt),
      pages,
      snapshotBytes: opts.bytes.byteLength,
    };
    this.corpse = { reason: "restored" };
    // The header's size is the size the snapshot was taken at; the decoded
    // terminal carries it too, but keep the two in step explicitly.
    const size = (vt as { size?: { cols: number; rows: number } }).size;
    if (size) {
      this.cols = size.cols;
      this.rows = size.rows;
    }
    this.log(
      `session ${this.id}: restored corpse from ${opts.bytes.byteLength} B: ready() ${readyMs.toFixed(2)} ms (${readyRows} rows), history ${historyMs.toFixed(2)} ms (${pages} pages, ${this.restore.totalRows} rows)`,
    );
    return vt;
  }

  get pid(): number | null {
    return this.proc?.pid ?? null;
  }

  // -- the hot path ---------------------------------------------------------

  private onData(bytes: Uint8Array): void {
    this.bytesFromPty += bytes.length;
    this.dirty = true;
    try {
      this.vt?.write(bytes);
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
        if (this.status === "running") this.terminal?.write(e.bytes);
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
    const proc = this.proc!;
    this.status = "exited";
    this.exitCode = proc.exitCode;
    // Only where an exit status names a signal. On Windows Bun reports the
    // name that was passed to `proc.kill()` even though `TerminateProcess`
    // is what ran, and reporting that would be reporting a request as an
    // outcome (../platform/win32.ts).
    this.signalCode = platform.signalsExits ? proc.signalCode : null;
    this.exitedAt = Date.now();
    this.log(
      `session ${this.id}: exited code=${this.exitCode} signal=${this.signalCode}`,
    );
    // Let the PTY deliver whatever the child wrote last; EIO on the master
    // means the slave side is gone and everything has been read. A
    // grandchild holding the slave open would delay EIO, so bound the wait.
    await Promise.race([this.ptyDonePromise, Bun.sleep(PTY_CLOSE_GRACE_MS)]);
    if (!this.disposed) this.terminal?.close();
    this.notify({
      t: "exited",
      id: this.id,
      exitCode: this.exitCode,
      signalCode: this.signalCode,
    });
    if (!this.disposed) this.onExit?.(this);
  }

  // -- attach / detach ------------------------------------------------------

  /**
   * Registers the client, sizes the session to it, and sends the first
   * paint. Everything here is one synchronous step: the client is in
   * `clients` before the paint is taken, and nothing can run the PTY's
   * `data` callback between the paint and the client's enqueue, so the
   * `output` frames that follow carry exactly the bytes the emulator
   * consumed after it. For a `snapshot` attacher that is what makes a
   * decoded replica exact rather than approximately right.
   */
  attach(
    conn: Connection,
    cols: number,
    rows: number,
    readOnly: boolean,
    mode: AttachMode = "vt",
  ): void {
    this.clients.add(conn);
    conn.noticed = false;
    // A corpse is read-only whatever the client asked for, and its size is
    // fixed: the emulator is the snapshot's, and there is no child to tell.
    conn.attached = {
      id: this.id,
      readOnly: readOnly || this.status === "corpse",
      mode,
    };
    if (this.status !== "corpse") this.resize(cols, rows);
    const paint = this.paint(mode, conn);
    if (paint) conn.sendPaint(paint);
    if (this.status === "exited") {
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
    if (this.status === "corpse") return;
    this.cols = cols;
    this.rows = rows;
    this.vt?.resize(cols, rows);
    this.dirty = true;
    if (this.status === "running") this.terminal?.resize(cols, rows);
  }

  /** Bytes for the PTY. A corpse tells the sender once that it is being ignored. */
  input(bytes: Uint8Array, from?: Connection): void {
    if (this.status === "running") {
      this.terminal?.write(bytes);
      return;
    }
    if (this.status === "corpse" && from && !from.noticed) {
      from.noticed = true;
      from.sendControl({
        t: "notice",
        id: this.id,
        message: "input ignored: this session is a snapshot, read-only",
      });
    }
  }

  /** Text for a session that has no emulator to render. */
  private placeholder(): string {
    const c = this.corpse;
    if (c?.reason === "mismatch")
      return (
        `[${this.id}: snapshot encoded by ghostty ${c.snapshotEngine.slice(0, 12)}, ` +
        `this daemon runs ${c.daemonEngine.slice(0, 12)}; not decoded]`
      );
    return `[${this.id}: snapshot has no screen]`;
  }

  /**
   * The first paint for an attacher, and the repaint after a lag: a
   * `render` for a `vt` client, a `snapshot` for a `snapshot` client. A
   * session with no emulator (a mismatch corpse) has nothing a snapshot
   * client could decode, so it gets the placeholder as a notice and no
   * frame; a live emulator that cannot encode right now (a continuation
   * past its limit, findings/m1.md) is told so the same way.
   */
  paint(mode: AttachMode, conn?: Connection): Paint | null {
    if (mode === "vt") return { kind: "render", bytes: this.render() };
    if (!this.vt) {
      conn?.sendControl({
        t: "notice",
        id: this.id,
        message: this.placeholder(),
      });
      return null;
    }
    const snap = this.encode();
    if (!snap) {
      conn?.sendControl({
        t: "notice",
        id: this.id,
        message: "snapshot unavailable: the emulator could not be encoded",
      });
      return null;
    }
    return { kind: "snapshot", bytes: snap.bytes };
  }

  /**
   * A re-emission of the viewport: clear, then the screen with the cursor
   * placed and the pending SGR restored. Viewport only; `logs` is the way
   * to see history from a CLI.
   */
  render(): Uint8Array {
    if (!this.vt) return enc.encode(RENDER_CLEAR + this.placeholder() + "\r\n");
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
    if (!this.vt) return this.placeholder() + "\n";
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

  /** Whether the emulator is on the alternate screen (DEC 1049); false when the engine cannot say. */
  altScreen(): boolean {
    if (!this.vt) return false;
    const dec = (this.vt as { decMode?: (m: number) => boolean }).decMode;
    if (typeof dec !== "function") return false;
    try {
      return dec.call(this.vt, 1049);
    } catch {
      return false;
    }
  }

  /** The viewport as plain text with the cursor, for comparing against a client's terminal. */
  screen(): ScreenResult {
    if (!this.vt)
      return {
        id: this.id,
        cols: this.cols,
        rows: this.rows,
        text: this.placeholder(),
        cursor: { x: 0, y: 0 },
        altScreen: false,
      };
    const cur = (this.vt as { cursor?: () => { x: number; y: number } }).cursor;
    return {
      id: this.id,
      cols: this.cols,
      rows: this.rows,
      text: this.vt.plainText(),
      cursor: typeof cur === "function" ? cur.call(this.vt) : { x: 0, y: 0 },
      altScreen: this.altScreen(),
    };
  }

  /**
   * Asks the platform to end this session's tree. Returns what was asked and
   * how it was delivered; whether the child went is `status`, which the
   * `exited` notice carries when it does.
   */
  kill(mode: KillMode, signal?: string): KillRecord {
    const outcome = this.tree
      ? mode === "interrupt"
        ? this.tree.interrupt(signal)
        : this.tree.kill(mode, signal)
      : { delivery: "terminate" as const, signal: null };
    const record: KillRecord = { mode, ...outcome, at: Date.now() };
    this.killRecord = record;
    this.log(
      `session ${this.id}: kill ${mode} delivered as ${record.delivery}${record.signal ? ` (${record.signal})` : ""}`,
    );
    return record;
  }

  /**
   * The emulator as `GHOSTSNP` bytes, and how long the encode held the
   * event loop. Null when there is no emulator or it cannot encode (a
   * continuation past its limit, findings/m1.md). A read: `dirty` is left
   * alone, so an attach or a `snapshot` request does not stop the timer
   * from writing the file.
   */
  encode(): { bytes: Uint8Array; encodeMs: number } | null {
    if (!this.vt) return null;
    const t0 = performance.now();
    let bytes: Uint8Array;
    try {
      const r = this.vt.encodeState();
      if (isUnsupported(r)) return null;
      bytes = r;
    } catch (e) {
      this.log(`session ${this.id}: encodeState failed: ${String(e)}`);
      return null;
    }
    return { bytes, encodeMs: performance.now() - t0 };
  }

  /** The header for this session's snapshot file. */
  snapshotHeader(ghostty: string, at: number): SnapshotHeader {
    return {
      wp: WP_VERSION,
      engine: this.engineId,
      ghostty:
        this.corpse?.reason === "mismatch"
          ? this.corpse.snapshotEngine
          : ghostty,
      id: this.id,
      argv: this.argv,
      cwd: this.cwd,
      cols: this.cols,
      rows: this.rows,
      createdAt: this.createdAt,
      title: this.title,
      pwd: this.pwd,
      status: this.status,
      exitCode: this.exitCode,
      signalCode: this.signalCode,
      exitedAt: this.exitedAt,
      snapshotAt: at,
      corpse: this.corpse,
      bytes: 0,
    };
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
      snapshotAt: this.snapshotAt,
      corpse: this.corpse,
      restore: this.restore,
      kill: this.killRecord,
    };
  }

  /** Tears everything down; a running child's whole tree goes with it. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const c of this.clients) c.attached = null;
    this.clients.clear();
    if (this.status === "running") {
      try {
        this.tree?.kill("force");
      } catch {}
    }
    try {
      // On Windows this is a second tree kill, since the job carries
      // KILL_ON_JOB_CLOSE; on POSIX there is nothing to release.
      this.tree?.close();
    } catch {}
    try {
      this.terminal?.close();
    } catch {}
    this.vt?.dispose();
  }
}
