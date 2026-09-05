import type { Transport } from "@werk/session";
import { openLocalTransport, type LocalEndpoint } from "@werk/session-daemon";
export function authoriseUpgrade(request: Request, token: string): boolean {
  const url = new URL(request.url);
  return (
    request.headers.get("origin") === url.origin &&
    url.searchParams.get("token") === token &&
    url.pathname === "/connect"
  );
}
type Peer = {
  transport: Transport;
  writer: WritableStreamDefaultWriter<Uint8Array>;
  pending: number;
  drain?: () => void;
};
export async function startWebBridge(options: {
  endpoint: LocalEndpoint;
  port?: number;
  assetsDir: string;
  token?: string;
}) {
  const token = options.token ?? crypto.randomUUID();
  const server = Bun.serve<Peer>({
    hostname: "127.0.0.1",
    port: options.port ?? 4319,
    async fetch(request, server) {
      const url = new URL(request.url);
      if (url.host !== `${server.hostname}:${server.port}`)
        return new Response("Invalid host", { status: 403 });
      if (url.pathname === "/connect") {
        if (!authoriseUpgrade(request, token))
          return new Response("Forbidden", { status: 403 });
        let transport: Transport;
        try {
          transport = await openLocalTransport(options.endpoint);
        } catch {
          return new Response("Daemon unavailable", { status: 503 });
        }
        const writer = transport.writable.getWriter();
        if (
          server.upgrade(request, { data: { transport, writer, pending: 0 } })
        )
          return;
        await transport.close();
        return new Response("WebSocket upgrade required", { status: 400 });
      }
      if (url.pathname === "/" || url.pathname === "/index.html") {
        const html = await Bun.file(`${options.assetsDir}/index.html`).text();
        return new Response(
          html
            .replace("__BRIDGE_TOKEN__", token)
            .replace(
              "__DAEMON_CREDENTIAL__",
              encodeURIComponent(
                options.endpoint.kind === "tcp"
                  ? options.endpoint.credential
                  : "",
              ),
            ),
          {
            headers: {
              "content-type": "text/html",
              "cache-control": "no-store",
              "content-security-policy":
                "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
            },
          },
        );
      }
      if (!/^\/[a-zA-Z0-9_.-]+$/.test(url.pathname))
        return new Response("Not found", { status: 404 });
      const file = Bun.file(`${options.assetsDir}${url.pathname}`);
      if (!(await file.exists()))
        return new Response("Not found", { status: 404 });
      return new Response(file);
    },
    websocket: {
      maxPayloadLength: 8 * 1024 * 1024 + 4,
      backpressureLimit: 16 * 1024 * 1024,
      closeOnBackpressureLimit: true,
      open(socket) {
        void (async () => {
          const reader = socket.data.transport.readable.getReader();
          try {
            while (true) {
              const next = await reader.read();
              if (next.done) break;
              const sent = socket.sendBinary(next.value);
              if (sent === 0) throw new Error("Browser socket closed");
              if (sent === -1)
                await new Promise<void>((resolve) => {
                  socket.data.drain = resolve;
                });
            }
          } catch {
          } finally {
            reader.releaseLock();
            socket.close();
            await socket.data.transport.close();
          }
        })();
      },
      message(socket, message) {
        if (typeof message === "string") {
          socket.close(1003, "Binary frames required");
          return;
        }
        const bytes = new Uint8Array(message);
        socket.data.pending += bytes.byteLength;
        if (socket.data.pending > 16 * 1024 * 1024) {
          socket.close(1009, "Input queue exceeded limit");
          return;
        }
        void socket.data.writer
          .write(bytes)
          .catch(() => socket.close())
          .finally(() => {
            socket.data.pending -= bytes.byteLength;
          });
      },
      drain(socket) {
        socket.data.drain?.();
        socket.data.drain = undefined;
      },
      close(socket) {
        socket.data.drain?.();
        void socket.data.transport.close();
      },
    },
  });
  return { port: server.port!, stop: () => server.stop(true) };
}
