// M4, headless: `wp serve` against a real daemon in a temporary runtime
// directory, driven with `fetch` and Bun's WebSocket client. The page's
// core (`client/replica.ts`) runs here under Bun with no DOM, decoding the
// snapshot the socket delivers and applying the output after it, so the
// data path is proved without a browser; the visual check is the browser
// run recorded in findings/m4.md.

import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import { connect, type Client } from "../client/index.ts";
import { loadGhosttyWasmEngine } from "../engine/ghostty-wasm/bun.ts";
import type { Frame, VtEngine } from "../engine/types.ts";
import { sleep, stopDaemon, tempDir, waitFor } from "../daemon/_testlib.ts";
import { BUNDLE_FILE, buildBundle } from "./build.ts";
import { Replica } from "./client/replica.ts";
import { WsTag, type WsNotice } from "./wire.ts";
import type { WebServer } from "./server.ts";

const dir = tempDir();
let client: Client;
let engine: VtEngine;
let web: WebServer;
let cookie: string;

beforeAll(async () => {
  if (!fs.existsSync(BUNDLE_FILE)) await buildBundle();
  const { serveWeb } = await import("./server.ts");
  client = await connect({ dir, requestTimeoutMs: 20_000 });
  engine = await loadGhosttyWasmEngine();
  web = await serveWeb({ dir });
}, 60_000);

afterAll(async () => {
  web?.stop();
  await stopDaemon(dir, client);
}, 30_000);

const sh = (script: string) => ["sh", "-c", script];
const base = () => `http://127.0.0.1:${web.port}`;
const get = (path: string, init: RequestInit = {}) =>
  fetch(base() + path, {
    redirect: "manual",
    ...init,
    headers: { cookie, ...(init.headers ?? {}) },
  });

/** A page stand-in: a WebSocket, a Replica painting into a frame log, the notices, in arrival order. */
class Tab {
  ws!: WebSocket;
  replica: Replica;
  frames: Frame[] = [];
  notices: WsNotice[] = [];
  snapshots = 0;
  outputBytes = 0;
  order: string[] = [];
  historyDone = 0;

  constructor(cols = 80, rows = 24) {
    this.replica = new Replica(
      engine,
      {
        paint: (f) => this.frames.push(f),
        raf: (fn) => setTimeout(fn, 0),
        defer: (fn) => setTimeout(fn, 0),
        onHistoryDone: () => this.historyDone++,
      },
      { cols, rows },
    );
  }

  open(id: string, cols = 80, rows = 24): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(
        `ws://127.0.0.1:${web.port}/ws/${id}?cols=${cols}&rows=${rows}`,
        { headers: { cookie } } as unknown as string[],
      );
      this.ws.binaryType = "arraybuffer";
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(new Error(`ws error: ${String(e)}`));
      this.ws.onmessage = (ev) => {
        if (typeof ev.data === "string") {
          const n = JSON.parse(ev.data) as WsNotice;
          this.order.push(n.t);
          this.notices.push(n);
          return;
        }
        const bytes = new Uint8Array(ev.data as ArrayBuffer);
        if (bytes[0] === WsTag.snapshot) {
          this.order.push("snapshot");
          this.snapshots++;
          this.replica.loadSnapshot(bytes.subarray(1));
        } else {
          this.order.push("output");
          this.outputBytes += bytes.length - 1;
          this.replica.write(bytes.subarray(1));
        }
      };
    });
  }

  text(): string {
    return this.replica.term!.plainText();
  }

  close(): void {
    this.ws.close();
    this.replica.dispose();
  }
}

async function screenHas(id: string, marker: string): Promise<boolean> {
  const end = Date.now() + 10_000;
  while (Date.now() < end) {
    if ((await client.screen(id)).text.includes(marker)) return true;
    await sleep(30);
  }
  return false;
}

test("the one-time token becomes a cookie; without it every route is refused", async () => {
  const noCookie = await fetch(base() + "/", { redirect: "manual" });
  expect(noCookie.status).toBe(403);
  const bad = await fetch(base() + "/?t=nope", { redirect: "manual" });
  expect(bad.status).toBe(403);
  const first = await fetch(web.url, { redirect: "manual" });
  expect(first.status).toBe(302);
  expect(first.headers.get("location")).toBe("/");
  const set = first.headers.get("set-cookie")!;
  expect(set).toContain(`wp=${web.token}`);
  expect(set).toContain("HttpOnly");
  cookie = set.split(";")[0]!;
  const wsNoCookie = await fetch(base() + "/ws/x", {
    headers: { upgrade: "websocket", connection: "upgrade" },
  });
  expect(wsNoCookie.status).toBe(403);
});

test("the list, the bundle and the wasm are served from the same bytes the daemon uses", async () => {
  const { id } = await client.run({ argv: sh("echo listed; sleep 30") });
  expect(await screenHas(id, "listed")).toBe(true);
  const list = await get("/");
  expect(list.status).toBe(200);
  const body = await list.text();
  expect(body).toContain(`/s/${id}`);
  expect(body).toContain("echo listed");
  const rows = await get("/api/ls");
  expect(await rows.text()).toContain(id);

  const js = await get("/app.js");
  expect(js.headers.get("content-type")).toContain("javascript");
  const src = await js.text();
  expect(src).toContain("ghostty_type_json");
  expect(src).not.toMatch(/\bBun\.|bun:/);

  const wasm = await get("/wasm");
  expect(wasm.headers.get("content-type")).toBe("application/wasm");
  const bytes = new Uint8Array(await wasm.arrayBuffer());
  expect(bytes.byteLength).toBe(738_713);
  expect([...bytes.subarray(0, 4)]).toEqual([0x00, 0x61, 0x73, 0x6d]);
  // The page's own load path: instantiate what /wasm served and decode with it.
  const { GhosttyWasmEngine } = await import("../engine/ghostty-wasm/index.ts");
  const fromWire = await GhosttyWasmEngine.load(bytes);
  expect(fromWire.module.exportCount).toBe(189);
  await client.kill(id, "SIGKILL");
});

test("a socket delivers hello, a snapshot, then only the output after it; the replica matches the daemon; input goes back", async () => {
  const { id } = await client.run({
    argv: sh(
      `seq 1 2000; printf '\\033[32mgreen\\033[0m ONE\\n'; sleep 0.5; echo TWO; cat`,
    ),
    cols: 80,
    rows: 24,
  });
  expect(await screenHas(id, "ONE")).toBe(true);
  const tab = new Tab();
  await tab.open(id);
  expect(await waitFor(() => tab.snapshots === 1, 5000)).toBe(true);
  expect(tab.order[0]).toBe("snapshot");
  expect(
    await waitFor(() => tab.notices.some((n) => n.t === "hello"), 3000),
  ).toBe(true);
  const hello = tab.notices.find((n) => n.t === "hello")!;
  expect(hello.t === "hello" && hello.status).toBe("running");
  expect(tab.frames.length).toBeGreaterThanOrEqual(1); // painted after ready()
  expect(tab.frames[0]!.dirtyAll).toBe(true);
  expect(tab.frames[0]!.changed.length).toBe(24);
  expect(await waitFor(() => tab.historyDone === 1, 5000)).toBe(true);
  const t = tab.replica.timings!;
  expect(t.readyRows).toBeLessThan(t.totalRows!);
  expect(t.pages).toBeGreaterThanOrEqual(1);
  expect(tab.text()).toBe((await client.screen(id)).text);

  // Live output after the snapshot point. The daemon having it on its screen
  // does not mean the socket has carried it to the page yet, so wait for the
  // page rather than sleeping a guess at it.
  expect(await screenHas(id, "TWO")).toBe(true);
  expect(await waitFor(() => tab.outputBytes > 0, 5000)).toBe(true);
  expect(await waitFor(() => tab.text().includes("TWO"), 5000)).toBe(true);
  expect(tab.text()).toBe((await client.screen(id)).text);

  // Input: bytes the page sends are written to the PTY and echoed back.
  tab.ws.send(new TextEncoder().encode("typed by the page\r"));
  expect(await screenHas(id, "typed by the page")).toBe(true);
  expect(
    await waitFor(() => tab.text().includes("typed by the page"), 5000),
  ).toBe(true);
  expect(tab.text()).toBe((await client.screen(id)).text);

  // Resize: the daemon and the replica reflow the same way.
  tab.ws.send(JSON.stringify({ t: "resize", cols: 60, rows: 20 }));
  tab.replica.resize(60, 20);
  expect(
    await waitFor(async () => {
      const now = await client.screen(id);
      return now.cols === 60 && now.rows === 20 && tab.text() === now.text;
    }, 5000),
  ).toBe(true);
  const s = await client.screen(id);
  expect([s.cols, s.rows]).toEqual([60, 20]);
  expect(tab.text()).toBe(s.text);

  // The styled cell survived the snapshot.
  const cells = tab.replica.term!.styledCells();
  const greenRow = cells.find((r) =>
    r
      .map((c) => c.text)
      .join("")
      .startsWith("green"),
  );
  expect(greenRow?.[0]?.fg).toEqual({ kind: "palette", index: 2 });

  console.log(
    `headless page: snapshot ${t.snapshotBytes} B, ready ${t.readyMs.toFixed(2)} ms, first paint ${t.firstPaintMs.toFixed(2)} ms (${t.readyRows} rows, ${t.pendingRows} pending), history ${t.historyMs?.toFixed(2)} ms (${t.pages} pages, ${t.totalRows} rows), ${tab.outputBytes} output bytes after`,
  );
  tab.close();
  await sleep(100);
  await client.kill(id, "SIGKILL");
}, 30_000);

test("two tabs on one session each hold their own replica and both stay exact", async () => {
  const { id } = await client.run({
    argv: sh(`echo first; cat`),
    cols: 80,
    rows: 24,
  });
  expect(await screenHas(id, "first")).toBe(true);
  const a = new Tab();
  const b = new Tab();
  await a.open(id);
  expect(await waitFor(() => a.snapshots === 1, 5000)).toBe(true);
  await b.open(id);
  expect(await waitFor(() => b.snapshots === 1, 5000)).toBe(true);
  // Both attached: the daemon counts two clients.
  expect((await client.ls()).find((s) => s.id === id)!.attachedClients).toBe(2);
  a.ws.send(new TextEncoder().encode("from tab a\r"));
  expect(await screenHas(id, "from tab a")).toBe(true);
  b.ws.send(new TextEncoder().encode("from tab b\r"));
  expect(await screenHas(id, "from tab b")).toBe(true);
  await sleep(200);
  const screen = (await client.screen(id)).text;
  expect(a.text()).toBe(screen);
  expect(b.text()).toBe(screen);
  // Each tab painted from its own consumer: a's frames are not b's.
  expect(a.frames.length).toBeGreaterThanOrEqual(2);
  expect(b.frames.length).toBeGreaterThanOrEqual(2);
  a.close();
  await sleep(200);
  expect((await client.ls()).find((s) => s.id === id)!.attachedClients).toBe(1);
  b.ws.send(new TextEncoder().encode("after a left\r"));
  expect(await screenHas(id, "after a left")).toBe(true);
  await sleep(200);
  expect(b.text()).toBe((await client.screen(id)).text);
  b.close();
  await sleep(100);
  await client.kill(id, "SIGKILL");
}, 30_000);

test("an exited session's page gets its final screen and the exited notice; an unknown id an error", async () => {
  const { id } = await client.run({ argv: sh(`echo bye; exit 3`) });
  const exited = async () => {
    const end = Date.now() + 5000;
    while (Date.now() < end) {
      if ((await client.ls()).find((s) => s.id === id)?.status === "exited")
        return true;
      await sleep(30);
    }
    return false;
  };
  expect(await exited()).toBe(true);
  const tab = new Tab();
  await tab.open(id);
  expect(
    await waitFor(() => tab.notices.some((n) => n.t === "exited"), 5000),
  ).toBe(true);
  expect(tab.snapshots).toBe(1);
  expect(tab.text().split("\n")[0]).toBe("bye");
  tab.close();

  const nope = new Tab();
  await nope.open("nope");
  expect(
    await waitFor(() => nope.notices.some((n) => n.t === "error"), 5000),
  ).toBe(true);
  const err = nope.notices.find((n) => n.t === "error")!;
  expect(err.t === "error" && err.message).toContain("no session");
  nope.replica.dispose();
  await client.kill(id);
});
