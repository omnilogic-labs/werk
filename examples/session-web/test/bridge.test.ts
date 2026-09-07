import { expect, test } from "bun:test";
import { authoriseUpgrade, startWebBridge } from "../src/bridge.js";
import { connectSessionClient } from "@werk/session";
import { FramedTransport } from "@werk/session/protocol";
import { socketTransport } from "@werk/session-daemon";
import { openWebSocketTransport } from "../src/websocket.js";
import net from "node:net";
import { mkdtemp, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
test("bridge requires exact origin and launch token", () => {
  const request = (origin: string, token: string) =>
    new Request(`http://127.0.0.1:4319/connect?token=${token}`, {
      headers: { origin },
    });
  expect(
    authoriseUpgrade(request("http://127.0.0.1:4319", "secret"), "secret"),
  ).toBe(true);
  expect(
    authoriseUpgrade(request("https://example.com", "secret"), "secret"),
  ).toBe(false);
  expect(
    authoriseUpgrade(request("http://127.0.0.1:4319", "wrong"), "secret"),
  ).toBe(false);
});
test("bridge carries the session protocol and disconnect preserves backend", async () => {
  const root = await mkdtemp(join(tmpdir(), "werk-web-"));
  await writeFile(join(root, "index.html"), "__BRIDGE_TOKEN__");
  let requests = 0;
  const sockets = new Set<net.Socket>();
  const listener = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    const wire = new FramedTransport(socketTransport(socket));
    void (async () => {
      for await (const message of wire.messages()) {
        if (message.type === "hello")
          await wire.send({
            type: "hello",
            protocolVersion: 2,
            principal: { id: "owner" },
            daemon: {
              id: "test",
              version: "1",
              protocolVersion: 2,
              engine: { buildId: "x", snapshotFormatVersion: 1 },
              capabilities: { termination: [], snapshots: true },
            },
          });
        if (message.type === "request") {
          requests++;
          await wire.send({ type: "response", id: message.id, result: [] });
        }
      }
    })().catch(() => {});
  });
  await new Promise<void>((resolve) =>
    listener.listen(join(root, "daemon.sock"), resolve),
  );
  await chmod(join(root, "daemon.sock"), 0o600);
  const bridge = await startWebBridge({
    endpoint: { kind: "unix", path: join(root, "daemon.sock") },
    port: 0,
    assetsDir: root,
    token: "test-token",
  });
  try {
    const url = `http://127.0.0.1:${bridge.port}`;
    expect((await fetch(`${url}/connect?token=test-token`)).status).toBe(403);
    expect(await (await fetch(url)).text()).toBe("test-token");
    // Bun's WebSocket accepts explicit origin headers; the browser adds this itself.
    const original = globalThis.WebSocket;
    globalThis.WebSocket = class extends original {
      constructor(address: string | URL) {
        super(address, { headers: { origin: url } } as never);
      }
    };
    try {
      const client = await connectSessionClient({
        transport: await openWebSocketTransport(
          url.replace("http", "ws") + "/connect?token=test-token",
        ),
      });
      expect(await client.list()).toEqual([]);
      await client.close();
      expect(requests).toBe(1);
      expect(listener.listening).toBe(true);
    } finally {
      globalThis.WebSocket = original;
    }
  } finally {
    bridge.stop();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
