// The socket server: accepts connections, runs the hello handshake,
// dispatches control messages to sessions. Lifecycle (lock, bind, rename,
// readiness) is in main.ts; this file only needs a directory to bind in.

import fs from "node:fs";
import path from "node:path";
import { GHOSTTY_COMMIT } from "../engine/ghostty-wasm/bytes.ts";
import { getEngine } from "../engine/registry.ts";
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
  type RunResult,
  type ScreenResult,
  type SessionInfo,
} from "../protocol/index.ts";
import { Connection, QUEUE_BOUND } from "./connection.ts";
import type { DaemonPaths } from "./paths.ts";
import { Session } from "./session.ts";

export interface DaemonServer {
  paths: DaemonPaths;
  sessions: Map<string, Session>;
  /** Called by the shutdown message and by SIGTERM; M3's snapshot-on-exit goes in here. */
  shutdown(reason: string): void;
  log(line: string): void;
}

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
): Promise<DaemonServer> {
  await import("../engine/ghostty-wasm/bun.ts");
  const sessions = new Map<string, Session>();
  const connections = new Set<Connection>();
  const startedAt = Date.now();
  let seq = 0;
  let stopping = false;

  const host = {
    log,
    renderFor(conn: Connection) {
      const s = conn.attached ? sessions.get(conn.attached.id) : undefined;
      return s ? s.render() : null;
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
        const engine: VtEngine = await getEngine(msg.engine).catch(() => {
          throw new ProtocolError(
            "no-such-engine",
            `no engine "${msg.engine}"`,
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
        });
        sessions.set(id, s);
        return { id } satisfies RunResult;
      }
      case "attach": {
        const s = session(msg.id);
        detach(conn);
        s.attach(conn, msg.cols, msg.rows, msg.readOnly);
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
          s.kill(msg.signal ?? "SIGTERM");
          return { id: s.id, action: "signalled" } satisfies KillResult;
        }
        s.dispose();
        sessions.delete(s.id);
        return { id: s.id, action: "removed" } satisfies KillResult;
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
      case "stats":
        return {
          pid: process.pid,
          rssBytes: readRss(),
          uptimeMs: Date.now() - startedAt,
          sessions: sessions.size,
          connections: [...connections].map((c) => c.stats()),
          queueBound: QUEUE_BOUND,
        } satisfies DaemonStats;
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
      if (conn.attached && !conn.attached.readOnly)
        sessions.get(conn.attached.id)?.input(frame.payload);
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
  const listener = Bun.listen<Connection>({
    unix: tmp,
    socket: {
      open(socket) {
        const conn = new Connection(socket, host, ++seq);
        socket.data = conn;
        connections.add(conn);
      },
      data(socket, chunk) {
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
      drain(socket) {
        socket.data.onDrain();
      },
      close(socket) {
        const conn = socket.data;
        if (!conn) return;
        conn.closed = true;
        detach(conn);
        connections.delete(conn);
      },
      error(socket, err) {
        log(`conn ${socket.data?.seq}: socket error ${String(err)}`);
      },
    },
  });
  fs.chmodSync(tmp, 0o600);
  // rename(2) is atomic and replaces a stale socket left by a dead daemon
  // without a separate unlink step, which is what closes the unlink/bind race.
  fs.renameSync(tmp, paths.socket);
  log(`listening on ${paths.socket} (pid ${process.pid}, bun ${Bun.version})`);

  const server: DaemonServer = {
    paths,
    sessions,
    log,
    shutdown(reason) {
      if (stopping) return;
      stopping = true;
      log(`shutting down: ${reason}`);
      // M3: snapshot every session to disk here, before the children go.
      for (const c of connections) c.end();
      for (const s of sessions.values()) s.dispose();
      sessions.clear();
      listener.stop(true);
      try {
        fs.unlinkSync(paths.socket);
      } catch {}
      setTimeout(() => process.exit(0), 50);
    },
  };
  return server;
}

function readRss(): number | null {
  try {
    const m = /VmRSS:\s+(\d+) kB/.exec(
      fs.readFileSync("/proc/self/status", "utf8"),
    );
    return m ? Number(m[1]) * 1024 : null;
  } catch {
    return null;
  }
}
