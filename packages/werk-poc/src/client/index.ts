// The programmatic client: one connection to the daemon, plain async
// functions over the protocol. No terminal handling here; the CLI puts raw
// mode and the detach key on top.
//
// One connection holds at most one attachment. `run` does not attach; call
// `attach` after it. A render frame's bytes start with a clear and are
// written to the terminal verbatim; output frames are written verbatim
// too. A `snapshot` attacher gets `GHOSTSNP` bytes instead of renders and
// feeds the output frames into its own decoded emulator. Detaching drops
// this connection from the session and the session carries on.

import type { Socket } from "bun";
import { clientHello, ensureDaemon } from "../daemon/launch.ts";
import {
  daemonPaths,
  defaultRuntimeDir,
  type DaemonPaths,
} from "../daemon/paths.ts";
import {
  decodeControl,
  encodeControl,
  encodeFrame,
  FrameParser,
  FrameType,
  type AttachMode,
  type AttachResult,
  type ClientMessage,
  type DaemonMessage,
  type DaemonStats,
  type DetachResult,
  type HelloInfo,
  type KillResult,
  type LogsResult,
  type RunResult,
  type ScreenResult,
  type SessionInfo,
  type SnapshotResult,
} from "../protocol/index.ts";

export type {
  DaemonStats,
  DetachResult,
  ScreenResult,
  SessionInfo,
  HelloInfo,
  SnapshotResult,
} from "../protocol/index.ts";

export interface ConnectOptions {
  /** The runtime directory holding `wp.sock`; defaults to `$XDG_RUNTIME_DIR/werk-poc`. */
  dir?: string;
  /**
   * An explicit socket path, for a daemon whose runtime directory is not
   * this machine's: an `ssh -L` forward of a remote daemon's `wp.sock`, say.
   * Overrides `dir`, and implies `autostart: false` — nothing here could
   * start a daemon at the far end of a forward.
   */
  socket?: string;
  /** Start a daemon if none answers. Default true. */
  autostart?: boolean;
  /** Override the hello the client sends; for testing the mismatch path. */
  hello?: HelloInfo;
  timeoutMs?: number;
  /** Reject a request the daemon has not answered within this long; unbounded by default. */
  requestTimeoutMs?: number;
}

export interface RunOptions {
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  engine?: string;
}

export interface AttachOptions {
  cols: number;
  rows: number;
  readOnly?: boolean;
  /** `vt` (default): paints arrive as `render` frames. `snapshot`: as `GHOSTSNP` bytes for a client running the same emulator. */
  mode?: AttachMode;
  onOutput?(bytes: Uint8Array): void;
  /** Starts with a clear; write verbatim. */
  onRender?(bytes: Uint8Array): void;
  /** `GHOSTSNP` bytes; decode with the engine, then feed every `onOutput` that follows into the decoded terminal. */
  onSnapshot?(bytes: Uint8Array): void;
  onExited?(info: { exitCode: number | null; signalCode: string | null }): void;
  onLag?(info: { droppedBytes: number }): void;
  onResumed?(): void;
  onEffect?(e: { kind: "title" | "pwd" | "bell"; value?: string }): void;
  /** A line the daemon wants shown to the user; a corpse ignoring input, for one. */
  onNotice?(message: string): void;
}

export interface Attachment extends AttachResult {
  input(bytes: Uint8Array | string): void;
  resize(cols: number, rows: number): Promise<void>;
  /** A fresh paint in the frame stream: `onRender` or `onSnapshot` fires before this resolves. */
  repaint(): Promise<void>;
  /** Leaves the session running. Reports whether it was on the alternate screen. */
  detach(): Promise<DetachResult>;
}

export class DaemonError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type DistributiveOmit<T, K extends keyof T> = T extends unknown
  ? Omit<T, K>
  : never;

interface Pending {
  resolve(v: unknown): void;
  reject(e: Error): void;
}

export class Client {
  private rid = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly parser = new FrameParser();
  private attachment: AttachOptions | null = null;
  private attachedId: string | null = null;
  private closed = false;
  private closeWaiters: (() => void)[] = [];
  /** The daemon's hello. */
  daemon!: HelloInfo & { pid: number };
  requestTimeoutMs: number | null = null;
  /**
   * Bytes the kernel would not take yet. Bun's `socket.write` returns what
   * it wrote and queues nothing; under load it was seen to return 0 for a
   * 23-byte frame on an idle Unix socket, and a request dropped there is a
   * reply that never comes. So every frame goes through `send`, which keeps
   * the remainder and continues on `drain` (findings/m2.md).
   */
  private outbound: { bytes: Uint8Array; offset: number }[] = [];
  shortWrites = 0;

  private constructor(
    private readonly socket: Socket<unknown>,
    readonly paths: DaemonPaths,
  ) {}

  /** Connects (starting the daemon when allowed) and completes the hello. */
  static async connect(opts: ConnectOptions = {}): Promise<Client> {
    const dir = opts.dir ?? defaultRuntimeDir();
    const hello = opts.hello ?? clientHello();
    let client: Client | null = null;
    if (opts.socket) {
      const paths = { ...daemonPaths(dir), socket: opts.socket };
      client = await Client.open(paths, hello, opts.timeoutMs ?? 5000);
      client.requestTimeoutMs = opts.requestTimeoutMs ?? null;
      return client;
    }
    const probe = async (paths: DaemonPaths) => {
      try {
        client = await Client.open(paths, hello, opts.timeoutMs ?? 5000);
        return true;
      } catch (e) {
        if (e instanceof DaemonError) throw e; // it answered; a mismatch is not "absent"
        return false;
      }
    };
    if (opts.autostart === false) {
      if (!(await probe(daemonPaths(dir))))
        throw new Error(`no daemon at ${daemonPaths(dir).socket}`);
    } else {
      await ensureDaemon({ dir, probe, timeoutMs: opts.timeoutMs });
    }
    client!.requestTimeoutMs = opts.requestTimeoutMs ?? null;
    return client!;
  }

  private static open(
    paths: DaemonPaths,
    hello: HelloInfo,
    timeoutMs: number,
  ): Promise<Client> {
    return new Promise<Client>((resolve, reject) => {
      let client: Client | undefined;
      let settled = false;
      const fail = (e: Error) => {
        if (settled) return;
        settled = true;
        reject(e);
      };
      const timer = setTimeout(
        () => fail(new Error("hello timed out")),
        timeoutMs,
      );
      Bun.connect({
        unix: paths.socket,
        socket: {
          open(socket) {
            client = new Client(socket, paths);
            client.onHello = (msg) => {
              clearTimeout(timer);
              if (msg.t === "error") {
                fail(new DaemonError(msg.code, msg.message));
                return;
              }
              client!.daemon = {
                protocol: msg.protocol,
                wp: msg.wp,
                engine: msg.engine,
                pid: msg.pid,
              };
              settled = true;
              resolve(client!);
            };
            client.send(encodeControl({ t: "hello", ...hello }));
          },
          data(_socket, chunk) {
            client?.onChunk(chunk);
          },
          drain() {
            client?.onDrain();
          },
          close() {
            client?.onClose();
            fail(new Error("connection closed before hello"));
          },
          error(_socket, err) {
            fail(err);
          },
          connectError(_socket, err) {
            clearTimeout(timer);
            fail(err);
          },
        },
      }).catch(fail);
    });
  }

  private onHello:
    ((msg: DaemonMessage & ({ t: "hello" } | { t: "error" })) => void) | null =
    null;

  private onChunk(chunk: Uint8Array): void {
    let frames;
    try {
      frames = this.parser.push(chunk);
    } catch (e) {
      this.socket.end();
      this.onClose(e as Error);
      return;
    }
    for (const f of frames) {
      if (f.type === FrameType.output) this.attachment?.onOutput?.(f.payload);
      else if (f.type === FrameType.render)
        this.attachment?.onRender?.(f.payload);
      else if (f.type === FrameType.snapshot)
        this.attachment?.onSnapshot?.(f.payload);
      else if (f.type === FrameType.control)
        this.onControl(decodeControl<DaemonMessage>(f.payload));
    }
  }

  private onControl(msg: DaemonMessage): void {
    switch (msg.t) {
      case "hello":
        this.onHello?.(msg);
        this.onHello = null;
        return;
      case "reply": {
        const p = this.pending.get(msg.rid);
        this.pending.delete(msg.rid);
        p?.resolve(msg.result);
        return;
      }
      case "error": {
        if (msg.rid === undefined) {
          if (this.onHello) {
            this.onHello(msg);
            this.onHello = null;
          }
          return;
        }
        const p = this.pending.get(msg.rid);
        this.pending.delete(msg.rid);
        p?.reject(new DaemonError(msg.code, msg.message));
        return;
      }
      case "exited":
        if (msg.id === this.attachedId)
          this.attachment?.onExited?.({
            exitCode: msg.exitCode,
            signalCode: msg.signalCode,
          });
        return;
      case "lagging":
        if (msg.id === this.attachedId)
          this.attachment?.onLag?.({ droppedBytes: msg.droppedBytes });
        return;
      case "resumed":
        if (msg.id === this.attachedId) this.attachment?.onResumed?.();
        return;
      case "effect":
        if (msg.id === this.attachedId)
          this.attachment?.onEffect?.({ kind: msg.kind, value: msg.value });
        return;
      case "notice":
        if (msg.id === this.attachedId)
          this.attachment?.onNotice?.(msg.message);
        return;
    }
  }

  /** Writes `bytes` in order, keeping what the kernel refuses until `drain`. */
  private send(bytes: Uint8Array): void {
    if (this.closed) return;
    this.outbound.push({ bytes, offset: 0 });
    if (this.outbound.length === 1) this.flush();
  }

  private flush(): void {
    while (this.outbound.length > 0) {
      const head = this.outbound[0]!;
      const remaining = head.bytes.length - head.offset;
      const n = this.socket.write(head.bytes, head.offset, remaining);
      if (n < 0) return; // closing; onClose rejects what is pending
      if (n < remaining) {
        head.offset += n;
        this.shortWrites++;
        return; // drain will call flush again
      }
      this.outbound.shift();
    }
  }

  private onDrain(): void {
    this.flush();
  }

  private onClose(err?: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values())
      p.reject(err ?? new Error("connection closed"));
    this.pending.clear();
    for (const w of this.closeWaiters) w();
  }

  private request<T>(
    msg: DistributiveOmit<Extract<ClientMessage, { rid: number }>, "rid">,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error("connection closed"));
    const rid = ++this.rid;
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      if (this.requestTimeoutMs !== null) {
        timer = setTimeout(() => {
          this.pending.delete(rid);
          reject(
            new Error(
              `daemon did not answer ${msg.t} (rid ${rid}) within ${this.requestTimeoutMs} ms`,
            ),
          );
        }, this.requestTimeoutMs);
      }
      this.pending.set(rid, {
        resolve: (v) => {
          if (timer) clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          if (timer) clearTimeout(timer);
          reject(e);
        },
      });
      this.send(encodeControl({ ...msg, rid } as ClientMessage));
    });
  }

  run(opts: RunOptions): Promise<RunResult> {
    return this.request<RunResult>({
      t: "run",
      argv: opts.argv,
      cwd: opts.cwd ?? process.cwd(),
      env: opts.env ?? envSubset(),
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      engine: opts.engine ?? "ghostty-wasm",
    });
  }

  async attach(id: string, opts: AttachOptions): Promise<Attachment> {
    // Handlers are installed before the request so the render frame that
    // follows the reply cannot be missed.
    this.attachment = opts;
    this.attachedId = id;
    let result: AttachResult;
    try {
      result = await this.request<AttachResult>({
        t: "attach",
        id,
        cols: opts.cols,
        rows: opts.rows,
        readOnly: opts.readOnly ?? false,
        mode: opts.mode ?? "vt",
      });
    } catch (e) {
      this.attachment = null;
      this.attachedId = null;
      throw e;
    }
    return {
      ...result,
      input: (bytes) => {
        this.send(
          encodeFrame(
            FrameType.input,
            typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes,
          ),
        );
      },
      resize: (cols, rows) => this.request<void>({ t: "resize", cols, rows }),
      repaint: () => this.request<void>({ t: "repaint" }),
      detach: async () => {
        if (this.attachedId !== id) return { altScreen: false };
        this.attachment = null;
        this.attachedId = null;
        if (this.closed) return { altScreen: false };
        return this.request<DetachResult>({ t: "detach" });
      },
    };
  }

  ls(): Promise<SessionInfo[]> {
    return this.request<SessionInfo[]>({ t: "ls" });
  }

  /** Signals a running session (default SIGTERM); removes an exited one. */
  kill(id: string, signal?: string): Promise<KillResult> {
    return this.request<KillResult>({ t: "kill", id, signal });
  }

  /** `text`: the whole active screen, scrollback included, as plain text. `vt`: the same as escape sequences. */
  async logs(id: string, format: "text" | "vt" = "text"): Promise<string> {
    return (await this.request<LogsResult>({ t: "logs", id, format })).data;
  }

  /** The session's viewport as the daemon's emulator holds it. */
  screen(id: string): Promise<ScreenResult> {
    return this.request<ScreenResult>({ t: "screen", id });
  }

  /** The session's emulator as `GHOSTSNP` bytes, decoded from the reply's base64. */
  async snapshot(
    id: string,
  ): Promise<Omit<SnapshotResult, "bytes"> & { bytes: Uint8Array }> {
    const r = await this.request<SnapshotResult>({ t: "snapshot", id });
    return { ...r, bytes: new Uint8Array(Buffer.from(r.bytes, "base64")) };
  }

  stats(): Promise<DaemonStats> {
    return this.request<DaemonStats>({ t: "stats" });
  }

  /** Asks the daemon to exit; its sessions are killed. A socket round trip, not a signal. */
  async shutdown(): Promise<void> {
    await this.request<void>({ t: "shutdown" }).catch(() => {});
  }

  /** Stop reading from the socket, so the kernel buffer fills. For backpressure tests. */
  pauseReading(): void {
    this.socket.pause();
  }

  resumeReading(): void {
    this.socket.resume();
  }

  close(): void {
    if (this.closed) return;
    this.socket.end();
    this.onClose();
  }

  /** Resolves when the connection has closed. */
  waitClosed(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((r) => this.closeWaiters.push(r));
  }
}

/** The environment a session inherits: the caller's, minus nothing for now. */
export function envSubset(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined) out[k] = v;
  return out;
}

export const connect = Client.connect;
