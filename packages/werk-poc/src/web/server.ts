// `wp serve`: a loopback web UI over the daemon. `Bun.serve` on 127.0.0.1,
// a one-time token in the printed URL that becomes a cookie, a session
// list, one terminal page per session, the pinned WASM bytes for the page,
// and a WebSocket per open terminal that is one snapshot-mode attach to
// the daemon.
//
// The WebSocket is the second stage of the proposal's §4 backpressure
// rule. The first is the daemon's queue to this process, which lags and
// resumes on its own and hands this process a fresh snapshot frame; this
// process forwards it. The second is Bun's `ws.send`, which returns -1
// when it enqueued under backpressure, 0 when it dropped the message, and
// the byte count otherwise, with a `drain` handler for when the enqueued
// bytes are gone. Bun exposes no `bufferedAmount` on a server socket, so
// the rule here is the simplest one that never needs it: the first -1
// marks the socket lagging, output is dropped for it until `drain`, and on
// drain the daemon is asked to `repaint`, which puts a fresh snapshot into
// the frame stream in order with the output that follows it.

import type { ServerWebSocket } from "bun";
import {
  GHOSTTY_COMMIT,
  ghosttyWasmPath,
} from "../engine/ghostty-wasm/bytes.ts";
import { connect, type Attachment, type Client } from "../client/index.ts";
import type { SessionInfo } from "../protocol/index.ts";
import APP_JS from "./bundle/app.js" with { type: "text" };
import { listPage, listRows, terminalPage } from "./pages.ts";
import {
  tagged,
  WsTag,
  type WsCommand,
  type WsNotice,
  type WsStats,
} from "./wire.ts";

export interface ServeOptions {
  /** Fixed port; a free one by default. */
  port?: number;
  /** The daemon's runtime directory; `$XDG_RUNTIME_DIR/werk-poc` by default. */
  dir?: string;
  log?(line: string): void;
}

export interface WebServer {
  /** The URL to open, one-time token included. */
  url: string;
  port: number;
  token: string;
  /** Per-socket backpressure accounting, for `/api/ws` and the tests. */
  sockets(): WsStats[];
  stop(): void;
}

interface SocketData {
  id: string;
  seq: number;
  /** The page's grid at connect time, from the upgrade URL. */
  cols: number;
  rows: number;
  client: Client | null;
  att: Attachment | null;
  stats: WsStats;
  /** When the send that started the current lag happened. */
  lagStartedAt: number | null;
  /** A repaint is on its way; output before it arrives is still pre-snapshot. */
  repainting: boolean;
  closed: boolean;
}

const COOKIE = "wp";

export async function serveWeb(opts: ServeOptions = {}): Promise<WebServer> {
  const log = opts.log ?? (() => {});
  const token = crypto.randomUUID().replace(/-/g, "");
  const sockets = new Set<SocketData>();
  let seq = 0;

  function authed(req: Request): boolean {
    const cookie = req.headers.get("cookie") ?? "";
    return cookie.split(";").some((c) => c.trim() === `${COOKIE}=${token}`);
  }

  async function withDaemon<T>(
    fn: (c: Client) => Promise<T>,
    autostart: boolean,
  ): Promise<T> {
    const c = await connect({
      dir: opts.dir,
      autostart,
      requestTimeoutMs: 10_000,
    });
    try {
      return await fn(c);
    } finally {
      c.close();
    }
  }

  const html = (body: string, status = 200) =>
    new Response(body, {
      status,
      headers: { "content-type": "text/html; charset=utf-8" },
    });

  function notice(ws: ServerWebSocket<SocketData>, n: WsNotice): void {
    if (ws.data.closed) return;
    account(ws, ws.send(JSON.stringify(n)), 0);
  }

  /** Bookkeeping for one `ws.send` result. */
  function account(
    ws: ServerWebSocket<SocketData>,
    r: number,
    bytes: number,
  ): void {
    const s = ws.data.stats;
    s.sends++;
    if (r === -1) {
      s.backpressured++;
      s.bytesSent += bytes;
      if (!s.lagging) {
        s.lagging = true;
        s.lagEpisodes++;
        ws.data.lagStartedAt = performance.now();
      }
    } else if (r === 0) s.droppedByBun++;
    else s.bytesSent += r;
  }

  function sendOutput(
    ws: ServerWebSocket<SocketData>,
    bytes: Uint8Array,
  ): void {
    const d = ws.data;
    if (d.closed) return;
    if (d.stats.lagging || d.repainting) {
      d.stats.droppedBytes += bytes.length;
      return;
    }
    const before = d.stats.lagging;
    account(ws, ws.send(tagged(WsTag.output, bytes)), bytes.length + 1);
    if (!before && d.stats.lagging) {
      log(
        `ws ${d.seq}: backpressure after ${d.stats.bytesSent} B; dropping output until drain`,
      );
      notice(ws, { t: "lagging", where: "ws", droppedBytes: 0 });
    }
  }

  function sendSnapshot(
    ws: ServerWebSocket<SocketData>,
    bytes: Uint8Array,
  ): void {
    const d = ws.data;
    if (d.closed) return;
    d.stats.snapshots++;
    d.repainting = false;
    // Never dropped: it is what makes the output after it meaningful.
    account(ws, ws.send(tagged(WsTag.snapshot, bytes)), bytes.length + 1);
  }

  async function open(
    ws: ServerWebSocket<SocketData>,
    cols: number,
    rows: number,
  ) {
    const d = ws.data;
    let client: Client;
    try {
      client = await connect({
        dir: opts.dir,
        autostart: false,
        requestTimeoutMs: 10_000,
      });
    } catch (e) {
      notice(ws, { t: "error", message: `no daemon: ${(e as Error).message}` });
      ws.close(1011, "no daemon");
      return;
    }
    if (d.closed) {
      client.close();
      return;
    }
    d.client = client;
    let info: SessionInfo | undefined;
    try {
      info = (await client.ls()).find((s) => s.id === d.id);
      d.att = await client.attach(d.id, {
        cols,
        rows,
        mode: "snapshot",
        onSnapshot: (b) => sendSnapshot(ws, b),
        onOutput: (b) => sendOutput(ws, b),
        onRender: () => {},
        onExited: (i) => notice(ws, { t: "exited", ...i }),
        onLag: (i) => {
          d.stats.daemonLagEpisodes++;
          notice(ws, {
            t: "lagging",
            where: "daemon",
            droppedBytes: i.droppedBytes,
          });
        },
        onResumed: () => notice(ws, { t: "resumed", where: "daemon" }),
        onNotice: (message) => notice(ws, { t: "notice", message }),
        onEffect: (e) =>
          notice(ws, { t: "effect", kind: e.kind, value: e.value }),
      });
    } catch (e) {
      notice(ws, { t: "error", message: (e as Error).message });
      ws.close(1011, "attach failed");
      return;
    }
    // The hello goes after the attach so the snapshot frame, which the
    // attach reply can share a socket read with, is already on its way;
    // the page tolerates either order.
    notice(ws, {
      t: "hello",
      id: d.id,
      argv: info?.argv ?? [],
      status: d.att.status,
      corpse:
        info?.corpse?.reason === "mismatch"
          ? `mismatch ${info.corpse.snapshotEngine.slice(0, 8)}/${info.corpse.daemonEngine.slice(0, 8)}`
          : (info?.corpse?.reason ?? null),
      exitCode: d.att.exitCode,
      signalCode: d.att.signalCode,
      cols: info?.cols ?? cols,
      rows: info?.rows ?? rows,
      title: info?.title ?? "",
    });
    void client.waitClosed().then(() => {
      if (!d.closed) ws.close(1011, "daemon connection closed");
    });
  }

  const server = Bun.serve<SocketData>({
    hostname: "127.0.0.1",
    port: opts.port ?? 0,
    async fetch(req, server) {
      const url = new URL(req.url);
      const t = url.searchParams.get("t");
      if (t !== null) {
        if (t !== token) return new Response("bad token", { status: 403 });
        url.searchParams.delete("t");
        return new Response(null, {
          status: 302,
          headers: {
            location: url.pathname + url.search,
            "set-cookie": `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`,
          },
        });
      }
      if (!authed(req))
        return new Response("open the URL printed by wp serve", {
          status: 403,
        });

      const p = url.pathname;
      if (p === "/") {
        try {
          const sessions = await withDaemon((c) => c.ls(), true);
          return html(listPage(sessions));
        } catch (e) {
          return html(listPage(null, (e as Error).message), 503);
        }
      }
      if (p === "/api/ls") {
        try {
          const sessions = await withDaemon((c) => c.ls(), false);
          return html(listRows(sessions));
        } catch (e) {
          return html(
            `<tr><td colspan="7">daemon unreachable: ${(e as Error).message}</td></tr>`,
            503,
          );
        }
      }
      if (p === "/api/ws")
        return Response.json({ sockets: [...sockets].map((s) => s.stats) });
      if (p === "/app.js")
        return new Response(APP_JS, {
          headers: { "content-type": "text/javascript; charset=utf-8" },
        });
      if (p === "/wasm")
        return new Response(Bun.file(ghosttyWasmPath), {
          headers: {
            "content-type": "application/wasm",
            "x-ghostty-commit": GHOSTTY_COMMIT,
          },
        });
      if (p.startsWith("/s/"))
        return html(terminalPage(decodeURIComponent(p.slice(3))));
      if (p.startsWith("/ws/")) {
        const id = decodeURIComponent(p.slice(4));
        const cols = Number(url.searchParams.get("cols")) || 80;
        const rows = Number(url.searchParams.get("rows")) || 24;
        const data: SocketData = {
          id,
          seq: ++seq,
          cols,
          rows,
          client: null,
          att: null,
          stats: {
            id,
            sends: 0,
            backpressured: 0,
            droppedByBun: 0,
            bytesSent: 0,
            droppedBytes: 0,
            lagEpisodes: 0,
            lagging: false,
            drains: 0,
            lastDrainLatencyMs: null,
            snapshots: 0,
            daemonLagEpisodes: 0,
          },
          lagStartedAt: null,
          repainting: false,
          closed: false,
        };
        if (server.upgrade(req, { data })) return;
        return new Response("upgrade failed", { status: 400 });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      // Bun's own cap on what it will hold for a socket; past it, with
      // closeOnBackpressureLimit off, `send` returns 0 and the message is
      // gone. The rule above stops sending long before this is reached.
      backpressureLimit: 4 * 1024 * 1024,
      closeOnBackpressureLimit: false,
      open(ws) {
        sockets.add(ws.data);
        log(
          `ws ${ws.data.seq}: open for ${ws.data.id} at ${ws.data.cols}x${ws.data.rows}`,
        );
        void open(ws, ws.data.cols, ws.data.rows);
      },
      message(ws, message) {
        const d = ws.data;
        if (!d.att) return;
        if (typeof message === "string") {
          let cmd: WsCommand;
          try {
            cmd = JSON.parse(message) as WsCommand;
          } catch {
            return;
          }
          if (cmd.t === "resize" && cmd.cols > 0 && cmd.rows > 0)
            d.att.resize(cmd.cols, cmd.rows).catch(() => {});
          return;
        }
        d.att.input(new Uint8Array(message as ArrayBuffer | Uint8Array));
      },
      drain(ws) {
        const d = ws.data;
        d.stats.drains++;
        if (!d.stats.lagging) return;
        if (d.lagStartedAt !== null)
          d.stats.lastDrainLatencyMs = performance.now() - d.lagStartedAt;
        d.lagStartedAt = null;
        d.stats.lagging = false;
        // Output keeps being dropped until the repaint's snapshot arrives
        // in the frame stream; everything after it applies on top.
        d.repainting = true;
        log(
          `ws ${d.seq}: drained after ${d.stats.lastDrainLatencyMs?.toFixed(0)} ms, ${d.stats.droppedBytes} B dropped so far; repainting`,
        );
        d.att
          ?.repaint()
          .then(() => notice(ws, { t: "resumed", where: "ws" }))
          .catch((e) => {
            d.repainting = false;
            notice(ws, {
              t: "error",
              message: `repaint failed: ${(e as Error).message}`,
            });
          });
      },
      close(ws, code, reason) {
        const d = ws.data;
        d.closed = true;
        sockets.delete(d);
        log(
          `ws ${d.seq}: closed (${code}${reason ? ` ${reason}` : ""}); ${d.stats.bytesSent} B sent, ${d.stats.droppedBytes} B dropped, ${d.stats.lagEpisodes} lag episode(s)`,
        );
        const client = d.client;
        const att = d.att;
        d.client = null;
        d.att = null;
        if (client) {
          // Detach so the session's client count drops, then close.
          void (async () => {
            try {
              if (att) await Promise.race([att.detach(), Bun.sleep(1000)]);
            } catch {}
            client.close();
          })();
        }
      },
    },
  });

  const port = server.port ?? opts.port ?? 0;
  const url = `http://127.0.0.1:${port}/?t=${token}`;
  log(`serving on ${url} (daemon dir ${opts.dir ?? "default"})`);
  return {
    url,
    port,
    token,
    sockets: () => [...sockets].map((s) => s.stats),
    stop() {
      for (const s of sockets) s.closed = true;
      server.stop(true);
    },
  };
}
