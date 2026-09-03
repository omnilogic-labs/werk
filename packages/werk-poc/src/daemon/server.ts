// The socket server: accepts connections, runs the hello handshake,
// dispatches control messages to sessions, and owns the snapshot cycle:
// restore corpses from the state directory before listening, encode dirty
// sessions to disk on a timer, once more when a child exits, and every
// session on shutdown. Lifecycle (lock, bind, rename, readiness) is in
// main.ts; this file only needs the directories.

import fs from "node:fs";
import path from "node:path";
import type { Socket, TCPSocketListener } from "bun";
import { heapStats } from "bun:jsc";
import { GHOSTTY_COMMIT } from "../engine/ghostty-wasm/bytes.ts";
import { getEngine, peekEngine } from "../engine/registry.ts";
import type { VtEngine } from "../engine/types.ts";
import {
  decodeControl,
  FrameType,
  PROTOCOL_VERSION,
  WP_VERSION,
  type AttachResult,
  type ClientMessage,
  type DaemonStats,
  type DetachResult,
  type Frame,
  type HelloInfo,
  type KillResult,
  type LogsResult,
  type LoopLagStats,
  type RunResult,
  type ScreenResult,
  type SessionInfo,
  type SnapshotResult,
  type SnapshotStats,
} from "../protocol/index.ts";
import {
  modeForSignal,
  platform,
  socketBufferBytes,
} from "../platform/index.ts";
import { Connection, QUEUE_BOUND } from "./connection.ts";
import type { DaemonPaths } from "./paths.ts";
import { Session } from "./session.ts";
import { newToken, tcpListenPort, tokenPath, writeToken } from "./tcp.ts";
import {
  deleteSnapshot,
  listSnapshotFiles,
  readSnapshot,
  writeSnapshot,
} from "./snapshot.ts";

export interface DaemonServer {
  paths: DaemonPaths;
  sessions: Map<string, Session>;
  /**
   * Called by the `shutdown` message on every platform, and by a signal
   * where one can reach a detached daemon: snapshots every session, then
   * exits.
   */
  shutdown(reason: string): void;
  log(line: string): void;
}

export interface ServerOptions {
  /** How often dirty sessions are written to disk. Default 30 s. */
  snapshotIntervalMs?: number;
}

export const DEFAULT_SNAPSHOT_INTERVAL_MS = 30_000;

export function helloInfo(): HelloInfo {
  return { protocol: PROTOCOL_VERSION, wp: WP_VERSION, engine: GHOSTTY_COMMIT };
}

class ProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function startServer(
  paths: DaemonPaths,
  log: (line: string) => void,
  opts: ServerOptions = {},
): Promise<DaemonServer> {
  await import("../engine/all.ts");
  const sessions = new Map<string, Session>();
  const connections = new Set<Connection>();
  // Off unless `WP_TCP_LISTEN` asks for it; the socket is the transport
  // and this is the experiment beside it (./tcp.ts).
  const tcpPort = tcpListenPort();
  const tcpToken = tcpPort === null ? null : newToken();
  const overTcp = new WeakSet<Connection>();
  const startedAt = Date.now();
  let seq = 0;
  let stopping = false;
  const snapshotIntervalMs =
    opts.snapshotIntervalMs ?? DEFAULT_SNAPSHOT_INTERVAL_MS;
  const snapStats: SnapshotStats = {
    stateDir: paths.state,
    intervalMs: snapshotIntervalMs,
    ticks: 0,
    written: { timer: 0, exit: 0, shutdown: 0 },
    slowest: null,
    restore: { files: 0, ms: 0 },
    lastPass: null,
  };
  const lag = new LagSampler(LAG_INTERVAL_MS);

  // -- snapshots -------------------------------------------------------------

  /**
   * Encode one session and write its file. A corpse is never re-encoded:
   * its screen cannot change and its file is already on disk (a mismatch
   * corpse has no emulator to encode anyway).
   */
  function snapshot(s: Session, why: keyof SnapshotStats["written"]): boolean {
    if (s.status === "corpse") return false;
    const at = Date.now();
    const snap = s.snapshot();
    if (!snap) return false;
    const t0 = performance.now();
    const size = writeSnapshot(
      paths.state,
      s.snapshotHeader(GHOSTTY_COMMIT, at),
      snap.bytes,
    );
    const writeMs = performance.now() - t0;
    s.snapshotAt = at;
    snapStats.written[why]++;
    if (!snapStats.slowest || snap.encodeMs > snapStats.slowest.encodeMs)
      snapStats.slowest = {
        id: s.id,
        bytes: snap.bytes.byteLength,
        encodeMs: snap.encodeMs,
      };
    log(
      `snapshot ${s.id} (${why}): ${snap.bytes.byteLength} B encoded in ${snap.encodeMs.toFixed(2)} ms, ${size} B written in ${writeMs.toFixed(2)} ms`,
    );
    return true;
  }

  function onTimer(): void {
    snapStats.ticks++;
    const t0 = performance.now();
    let written = 0;
    for (const s of sessions.values())
      if (s.dirty && snapshot(s, "timer")) written++;
    snapStats.lastPass = {
      at: Date.now(),
      sessions: sessions.size,
      written,
      ms: performance.now() - t0,
    };
  }

  /** Restore every file in the state directory as a corpse; runs before the socket is up. */
  async function restoreAll(): Promise<void> {
    const files = listSnapshotFiles(paths.state);
    if (files.length === 0) return;
    const t0 = performance.now();
    const engine = await getEngine("ghostty-wasm");
    for (const file of files) {
      let snap;
      try {
        snap = readSnapshot(file);
      } catch (e) {
        log(`snapshot ${file}: unreadable, left in place: ${String(e)}`);
        continue;
      }
      if (sessions.has(snap.header.id)) {
        log(`snapshot ${file}: id ${snap.header.id} already restored; skipped`);
        continue;
      }
      try {
        const s = Session.restore({
          header: snap.header,
          bytes: snap.bytes,
          engine: snap.header.engine === engine.id ? engine : null,
          daemonGhostty: GHOSTTY_COMMIT,
          log,
        });
        sessions.set(s.id, s);
      } catch (e) {
        log(`snapshot ${file}: decode failed, left in place: ${String(e)}`);
      }
    }
    snapStats.restore = { files: files.length, ms: performance.now() - t0 };
    log(
      `restored ${sessions.size} of ${files.length} snapshot files in ${snapStats.restore.ms.toFixed(1)} ms`,
    );
  }

  await restoreAll();
  const timer = setInterval(onTimer, snapshotIntervalMs);

  const host = {
    log,
    paintFor(conn: Connection) {
      const s = conn.attached ? sessions.get(conn.attached.id) : undefined;
      return s ? s.paint(conn.attached!.mode, conn) : null;
    },
  };

  function freshId(): string {
    for (;;) {
      const id = Array.from(crypto.getRandomValues(new Uint8Array(3)), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("");
      if (!sessions.has(id)) return id;
    }
  }

  function session(id: string): Session {
    const s = sessions.get(id);
    if (!s) throw new ProtocolError("no-such-session", `no session ${id}`);
    return s;
  }

  function detach(conn: Connection): void {
    if (!conn.attached) return;
    sessions.get(conn.attached.id)?.detach(conn);
    conn.attached = null;
  }

  async function handleRequest(
    conn: Connection,
    msg: ClientMessage & { rid: number },
  ): Promise<unknown> {
    switch (msg.t) {
      case "run": {
        // Loaded on demand; an engine that cannot load (the ffi library
        // failing to open, say) is reported with its own reason.
        const engine: VtEngine = await getEngine(msg.engine).catch((e) => {
          throw new ProtocolError(
            "no-such-engine",
            `engine "${msg.engine}": ${(e as Error).message}`,
          );
        });
        if (!Array.isArray(msg.argv) || msg.argv.length === 0)
          throw new ProtocolError("bad-request", "argv is empty");
        const id = freshId();
        const s = new Session({
          id,
          argv: msg.argv,
          cwd: msg.cwd,
          env: msg.env,
          cols: msg.cols,
          rows: msg.rows,
          engine,
          log,
          // The final screen, once the child's last bytes are in.
          onExit: (ended) => {
            if (!stopping && sessions.get(ended.id) === ended)
              snapshot(ended, "exit");
          },
        });
        sessions.set(id, s);
        return { id } satisfies RunResult;
      }
      case "attach": {
        const s = session(msg.id);
        detach(conn);
        s.attach(conn, msg.cols, msg.rows, msg.readOnly, msg.mode ?? "vt");
        return {
          id: s.id,
          status: s.status,
          exitCode: s.exitCode,
          signalCode: s.signalCode,
          altScreen: s.altScreen(),
        } satisfies AttachResult;
      }
      case "detach": {
        // The session's screen state at the moment of leaving, so a CLI
        // can put the user's terminal back on the primary screen.
        const s = conn.attached ? sessions.get(conn.attached.id) : undefined;
        detach(conn);
        return { altScreen: s?.altScreen() ?? false } satisfies DetachResult;
      }
      case "repaint": {
        if (!conn.attached)
          throw new ProtocolError(
            "not-attached",
            "repaint with nothing attached",
          );
        const paint = session(conn.attached.id).paint(conn.attached.mode, conn);
        if (paint) conn.sendPaint(paint);
        return {};
      }
      case "resize": {
        if (!conn.attached)
          throw new ProtocolError(
            "not-attached",
            "resize with nothing attached",
          );
        session(conn.attached.id).resize(msg.cols, msg.rows);
        return {};
      }
      case "ls":
        return [...sessions.values()].map((s) =>
          s.info(),
        ) satisfies SessionInfo[];
      case "kill": {
        const s = session(msg.id);
        if (s.status === "running") {
          // The mode is the request; a POSIX signal name is one way of
          // spelling it, and where the platform has signals it is the one
          // that gets sent.
          const mode =
            msg.mode ??
            (msg.signal ? modeForSignal(msg.signal) : null) ??
            "terminate";
          const kill = s.kill(mode, msg.signal);
          return { id: s.id, action: "killed", kill } satisfies KillResult;
        }
        s.dispose();
        sessions.delete(s.id);
        deleteSnapshot(paths.state, s.id);
        return {
          id: s.id,
          action: "removed",
          kill: s.killRecord,
        } satisfies KillResult;
      }
      case "logs": {
        const s = session(msg.id);
        return {
          id: s.id,
          format: msg.format,
          data: s.logs(msg.format),
        } satisfies LogsResult;
      }
      case "screen":
        return session(msg.id).screen() satisfies ScreenResult;
      case "snapshot": {
        // The live emulator as GHOSTSNP bytes, for a client running the same
        // libghostty. Does not touch the file or `dirty`: this is a read,
        // not a checkpoint. (Attaching with `mode: "snapshot"` is the
        // ordered way to get one; this request is a point in time.)
        const s = session(msg.id);
        const snap = s.encode();
        if (!snap)
          throw new ProtocolError(
            "no-snapshot",
            `session ${s.id} has nothing to encode`,
          );
        return {
          id: s.id,
          engine: s.engineId,
          ghostty: GHOSTTY_COMMIT,
          cols: s.cols,
          rows: s.rows,
          bytes: Buffer.from(snap.bytes).toString("base64"),
          encodeMs: snap.encodeMs,
        } satisfies SnapshotResult;
      }
      case "stats": {
        if (msg.gc) Bun.gc(true);
        const wasm = peekEngine("ghostty-wasm") as
          { module?: { memory?: WebAssembly.Memory } } | undefined;
        const mem = process.memoryUsage();
        let jsc: DaemonStats["jsc"] = null;
        try {
          const h = heapStats();
          jsc = {
            heapSize: h.heapSize,
            heapCapacity: h.heapCapacity,
            extraMemorySize: h.extraMemorySize,
            objectCount: h.objectCount,
          };
        } catch {}
        return {
          pid: process.pid,
          rssBytes: readRss(),
          uptimeMs: Date.now() - startedAt,
          sessions: sessions.size,
          connections: [...connections].map((c) => c.stats()),
          queueBound: QUEUE_BOUND,
          snapshots: snapStats,
          wasmMemoryBytes: wasm?.module?.memory?.buffer.byteLength ?? null,
          memory: {
            rss: mem.rss,
            heapTotal: mem.heapTotal,
            heapUsed: mem.heapUsed,
            external: mem.external,
            arrayBuffers: mem.arrayBuffers,
          },
          jsc,
          loop: lag.stats(),
        } satisfies DaemonStats;
      }
      case "shutdown":
        queueMicrotask(() => server.shutdown("shutdown message"));
        return {};
      default:
        throw new ProtocolError(
          "bad-request",
          `unknown message ${(msg as { t: string }).t}`,
        );
    }
  }

  function onFrame(conn: Connection, frame: Frame): void {
    if (frame.type === FrameType.input) {
      if (!conn.helloDone)
        throw new ProtocolError("hello-first", "input before hello");
      if (conn.attached) {
        // A read-only attacher's bytes are dropped here; a corpse (always
        // read-only) sees them so it can say once that they go nowhere.
        const s = sessions.get(conn.attached.id);
        if (s && (!conn.attached.readOnly || s.status === "corpse"))
          s.input(frame.payload, conn);
      }
      return;
    }
    if (frame.type !== FrameType.control)
      throw new ProtocolError(
        "bad-frame",
        `client sent frame type ${frame.type}`,
      );
    const msg = decodeControl<ClientMessage>(frame.payload);
    if (msg.t === "hello") {
      const mine = helloInfo();
      const mismatch =
        msg.protocol !== mine.protocol
          ? `protocol ${msg.protocol} vs daemon ${mine.protocol}`
          : msg.wp !== mine.wp
            ? `wp ${msg.wp} vs daemon ${mine.wp}`
            : msg.engine !== mine.engine
              ? `engine pin ${msg.engine} vs daemon ${mine.engine}`
              : null;
      if (mismatch) {
        conn.sendControl({
          t: "error",
          code: "version-mismatch",
          message: `client and daemon differ: ${mismatch}. Stop the daemon and start it from this wp; that ends its sessions.`,
        });
        conn.end();
        return;
      }
      // A connection that came in over the loopback landing has no
      // filesystem permission behind it, so it names the token from the
      // runtime directory or it is closed (./tcp.ts).
      if (overTcp.has(conn) && msg.token !== tcpToken) {
        log(`conn ${conn.seq}: tcp hello without the token; closing`);
        conn.sendControl({
          t: "error",
          code: "unauthorised",
          message: "this daemon's TCP listener needs the token from wp.tcp",
        });
        conn.end();
        return;
      }
      conn.helloDone = true;
      conn.sendControl({ t: "hello", pid: process.pid, ...mine });
      return;
    }
    if (!conn.helloDone)
      throw new ProtocolError("hello-first", `${msg.t} before hello`);
    if (typeof msg.rid !== "number")
      throw new ProtocolError("bad-request", `${msg.t} without rid`);
    const rid = msg.rid;
    handleRequest(conn, msg as ClientMessage & { rid: number }).then(
      (result) => conn.sendControl({ t: "reply", rid, result }),
      (e) => {
        const code = e instanceof ProtocolError ? e.code : "internal";
        if (!(e instanceof ProtocolError))
          log(`conn ${conn.seq}: ${msg.t} failed: ${e?.stack ?? e}`);
        conn.sendControl({
          t: "error",
          rid,
          code,
          message: String(e?.message ?? e),
        });
      },
    );
  }

  const tmp = path.join(paths.dir, `.wp.sock.${process.pid}.tmp`);
  try {
    fs.unlinkSync(tmp);
  } catch {}
  // The lock says this daemon is the only one, so whatever sits at the final
  // path is stale; some platforms have to say so before the rename below can
  // put the new socket in place (../platform/).
  platform.clearStaleSocket(paths.socket);
  const handlers = (tcp: boolean) => ({
    open(socket: Socket<Connection>) {
      const conn = new Connection(socket, host, ++seq);
      socket.data = conn;
      connections.add(conn);
      if (tcp) overTcp.add(conn);
    },
    data(socket: Socket<Connection>, chunk: Uint8Array) {
      const conn = socket.data;
      try {
        for (const frame of conn.parser.push(chunk)) onFrame(conn, frame);
      } catch (e) {
        const code = e instanceof ProtocolError ? e.code : "bad-frame";
        log(`conn ${conn.seq}: ${String(e)}; closing`);
        conn.sendControl({
          t: "error",
          code,
          message: String((e as Error)?.message ?? e),
        });
        conn.end();
      }
    },
    drain(socket: Socket<Connection>) {
      socket.data.onDrain();
    },
    close(socket: Socket<Connection>) {
      const conn = socket.data;
      if (!conn) return;
      conn.closed = true;
      detach(conn);
      connections.delete(conn);
    },
    error(socket: Socket<Connection>, err: Error) {
      log(`conn ${socket.data?.seq}: socket error ${String(err)}`);
    },
  });
  const listener = Bun.listen<Connection>({
    unix: tmp,
    socket: handlers(false),
  });
  // macOS gives the listener 8 KiB socket buffers and accepted sockets
  // inherit them, so raise both before the first client can connect.
  // Linux is left on the kernel's own figure; see ../platform/posix.ts.
  const socketBuffer = socketBufferBytes();
  if (socketBuffer !== null) {
    const fd = (listener as { fd?: unknown }).fd;
    if (typeof fd !== "number") {
      log(`socket buffers left at default: listener fd is ${typeof fd}`);
    } else {
      try {
        log(
          `socket buffers set to ${socketBuffer}: ${platform.setSocketBuffers(fd, socketBuffer)}`,
        );
      } catch (e) {
        log(`socket buffers left at default: ${String(e)}`);
      }
    }
  }
  // The socket is this user's, where the filesystem has a way of saying so.
  platform.restrictSocket(tmp);
  // rename(2) is atomic and replaces a stale socket left by a dead daemon
  // without a separate unlink step, which is what closes the unlink/bind race.
  fs.renameSync(tmp, paths.socket);
  log(`listening on ${paths.socket} (pid ${process.pid}, bun ${Bun.version})`);

  // The loopback landing, when it was asked for: the same handlers, plus a
  // token the runtime directory keeps to this user, since a port has no
  // permissions of its own.
  let tcpListener: TCPSocketListener<Connection> | null = null;
  if (tcpPort !== null && tcpToken !== null) {
    const l = Bun.listen<Connection>({
      hostname: "127.0.0.1",
      port: tcpPort,
      socket: handlers(true),
    });
    tcpListener = l;
    writeToken(paths.dir, { port: l.port, token: tcpToken });
    log(
      `also listening on 127.0.0.1:${l.port} with a token in ${tokenPath(paths.dir)}`,
    );
  }

  const server: DaemonServer = {
    paths,
    sessions,
    log,
    shutdown(reason) {
      if (stopping) return;
      stopping = true;
      log(`shutting down: ${reason}`);
      clearInterval(timer);
      lag.stop();
      // Every session to disk before the children go, dirty or not: the
      // file's header records the status and exit code at this moment.
      const t0 = performance.now();
      let n = 0;
      for (const s of sessions.values()) if (snapshot(s, "shutdown")) n++;
      log(
        `shutdown snapshots: ${n} of ${sessions.size} sessions in ${(performance.now() - t0).toFixed(1)} ms`,
      );
      for (const c of connections) c.end();
      for (const s of sessions.values()) s.dispose();
      sessions.clear();
      listener.stop(true);
      tcpListener?.stop(true);
      try {
        fs.unlinkSync(paths.socket);
      } catch {}
      if (tcpListener)
        try {
          fs.unlinkSync(tokenPath(paths.dir));
        } catch {}
      setTimeout(() => process.exit(0), 50);
    },
  };
  return server;
}

const LAG_INTERVAL_MS = 100;
const LAG_RECENT = 600;
const LAG_BUCKETS_MS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];

/**
 * A `setInterval` whose drift past its due time is the daemon's event-loop
 * lag: whatever held the loop — a GC pause, a synchronous encode, a long
 * PTY callback — shows up as a late tick. The proposal's soak asks for a
 * GC pause distribution; this is the proxy a JavaScript process can give
 * without a profiler attached.
 */
class LagSampler {
  private readonly recent: number[] = [];
  private samples = 0;
  private maxMs = 0;
  private readonly buckets = new Map<string, number>();
  private last: number;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(readonly intervalMs: number) {
    for (const b of LAG_BUCKETS_MS) this.buckets.set(`<${b}`, 0);
    this.buckets.set(`>=${LAG_BUCKETS_MS[LAG_BUCKETS_MS.length - 1]}`, 0);
    this.last = performance.now();
    this.timer = setInterval(() => this.tick(), intervalMs);
  }

  private tick(): void {
    // Each tick is measured against the previous one, not against a fixed
    // schedule: `setInterval` re-arms after the callback, so a schedule
    // would accumulate the timer's own drift as though it were lag.
    const now = performance.now();
    const lag = Math.max(0, now - this.last - this.intervalMs);
    this.last = now;
    this.samples++;
    if (lag > this.maxMs) this.maxMs = lag;
    let key = `>=${LAG_BUCKETS_MS[LAG_BUCKETS_MS.length - 1]}`;
    for (const b of LAG_BUCKETS_MS)
      if (lag < b) {
        key = `<${b}`;
        break;
      }
    this.buckets.set(key, (this.buckets.get(key) ?? 0) + 1);
    this.recent.push(lag);
    if (this.recent.length > LAG_RECENT) this.recent.shift();
  }

  stats(): LoopLagStats {
    const sorted = [...this.recent].sort((a, b) => a - b);
    const q = (p: number) =>
      sorted.length === 0
        ? 0
        : sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
    return {
      intervalMs: this.intervalMs,
      recent: {
        samples: sorted.length,
        p50Ms: q(0.5),
        p99Ms: q(0.99),
        maxMs: sorted.length ? sorted[sorted.length - 1]! : 0,
      },
      total: {
        samples: this.samples,
        maxMs: this.maxMs,
        buckets: Object.fromEntries(this.buckets),
      },
    };
  }

  stop(): void {
    clearInterval(this.timer);
  }
}

function readRss(): number | null {
  return platform.rss(process.pid);
}
