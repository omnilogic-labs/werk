// M4: attaching with `mode: "snapshot"`. The daemon encodes the session
// inside `attach` and sends a `snapshot` frame in place of `render`; the
// `output` frames after it are exactly the bytes the emulator consumed
// after the encode, so a client decoding the snapshot with the same engine
// and feeding it those frames holds an exact replica. The lag → resume
// path sends a fresh snapshot the same way. A real daemon in a temporary
// runtime directory, as in daemon.test.ts.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { connect, type Client, type Attachment } from "../client/index.ts";
import { loadGhosttyWasmEngine } from "../engine/ghostty-wasm/bun.ts";
import type { GhosttyWasmTerminal } from "../engine/ghostty-wasm/index.ts";
import { isUnsupported, type VtEngine } from "../engine/types.ts";
import { sleep, stopDaemon, tempDir, waitFor } from "./_testlib.ts";

const dir = tempDir();
let client: Client;
let engine: VtEngine;

beforeAll(async () => {
  client = await connect({ dir, requestTimeoutMs: 20_000 });
  engine = await loadGhosttyWasmEngine();
}, 30_000);

afterAll(async () => {
  await stopDaemon(dir, client);
}, 30_000);

const sh = (script: string) => ["sh", "-c", script];

/** Everything a snapshot-mode attacher receives, in the order it arrived. */
class Replica {
  /** "snapshot" or "output", in order, for checking that no output precedes the snapshot. */
  order: string[] = [];
  snapshots: Uint8Array[] = [];
  /** Output frames received after the most recent snapshot and not yet applied. */
  pendingOutput: Uint8Array[] = [];
  outputBytes = 0;
  renders = 0;
  lagged = 0;
  resumed = 0;
  notices: string[] = [];
  exited: { exitCode: number | null; signalCode: string | null } | null = null;
  term: GhosttyWasmTerminal | null = null;
  ready = { ms: 0, rows: 0 };
  history = { ms: 0, pages: 0, rows: 0 };
  att!: Attachment;

  constructor(readonly client: Client) {}

  async attach(id: string, cols = 80, rows = 24): Promise<Attachment> {
    this.att = await this.client.attach(id, {
      cols,
      rows,
      mode: "snapshot",
      onSnapshot: (b) => {
        this.order.push("snapshot");
        this.snapshots.push(b);
        this.pendingOutput = [];
      },
      onOutput: (b) => {
        this.order.push("output");
        this.outputBytes += b.length;
        this.pendingOutput.push(b);
      },
      onRender: () => this.renders++,
      onLag: () => this.lagged++,
      onResumed: () => this.resumed++,
      onNotice: (m) => this.notices.push(m),
      onExited: (i) => (this.exited = i),
    });
    return this.att;
  }

  /** The two-stage decode of the latest snapshot, then every output frame since it. */
  decodeLatest(): GhosttyWasmTerminal {
    const bytes = this.snapshots.at(-1)!;
    this.term?.dispose();
    const t0 = performance.now();
    const d = engine.decodeState(bytes);
    if (isUnsupported(d)) throw new Error(d.reason);
    const term = d.ready() as GhosttyWasmTerminal;
    this.ready = {
      ms: performance.now() - t0,
      rows: term.getNumber("TOTAL_ROWS"),
    };
    const t1 = performance.now();
    let pages = 0;
    for (let p = d.next(); p; p = d.next()) pages++;
    this.history = {
      ms: performance.now() - t1,
      pages,
      rows: term.getNumber("TOTAL_ROWS"),
    };
    this.term = term;
    this.applyPending();
    return term;
  }

  applyPending(): void {
    for (const b of this.pendingOutput.splice(0)) this.term!.write(b);
  }
}

/** Polls `pred` until it holds; false after `ms`. */
async function until(
  pred: () => Promise<boolean>,
  ms: number,
): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return true;
    await sleep(30);
  }
  return pred();
}

/** Waits until the daemon's screen shows `marker`, then a little longer for the frames carrying it to land. */
async function settled(id: string, marker: string): Promise<void> {
  expect(
    await until(
      async () => (await client.screen(id)).text.includes(marker),
      10_000,
    ),
  ).toBe(true);
  await sleep(150);
}

test("a snapshot-mode attach gets a snapshot, then only the output written after it; the replica stays exact", async () => {
  const { id } = await client.run({
    argv: sh(
      `printf '\\033[1;31mred bold\\033[0m plain \\033[38;5;208mtwo-five-six\\033[0m\\n'; ` +
        `seq 1 3000; echo ONE; sleep 0.6; echo TWO; sleep 0.6; printf '\\033[3;10Hcursor here'; sleep 30`,
    ),
    cols: 80,
    rows: 24,
  });
  await settled(id, "ONE");
  const rep = new Replica(client);
  const att = await rep.attach(id);
  expect(att.status).toBe("running");
  expect(await waitFor(() => rep.snapshots.length === 1, 3000)).toBe(true);
  expect(rep.order[0]).toBe("snapshot");
  expect(rep.renders).toBe(0);
  const snap = rep.snapshots[0]!;
  expect(new TextDecoder().decode(snap.subarray(0, 8))).toBe("GHOSTSNP");

  // Decode, and the replica agrees with the daemon before anything else arrives.
  const term = rep.decodeLatest();
  expect(rep.ready.rows).toBeLessThan(rep.history.rows); // history exceeded a page
  expect(rep.history.pages).toBeGreaterThanOrEqual(1);
  let screen = await client.screen(id);
  expect(term.plainText()).toBe(screen.text);
  expect(term.cursor()).toEqual(screen.cursor);

  // Output after the snapshot point: TWO and a cursor move land only in
  // output frames, and applying them keeps the replica exact.
  await settled(id, "cursor here");
  expect(rep.outputBytes).toBeGreaterThan(0);
  rep.applyPending();
  screen = await client.screen(id);
  expect(screen.text).toContain("TWO");
  expect(term.plainText()).toBe(screen.text);
  expect(term.cursor()).toEqual(screen.cursor);
  expect(rep.snapshots.length).toBe(1);
  console.log(
    `snapshot attach: ${snap.byteLength} B; ready() ${rep.ready.ms.toFixed(2)} ms (${rep.ready.rows} rows), history ${rep.history.ms.toFixed(2)} ms (${rep.history.pages} pages, ${rep.history.rows} rows); ${rep.outputBytes} output bytes applied after it`,
  );

  // A resize through the attachment reflows both ends the same way.
  await att.resize(60, 20);
  term.resize(60, 20);
  await sleep(200);
  rep.applyPending();
  screen = await client.screen(id);
  expect([screen.cols, screen.rows]).toEqual([60, 20]);
  expect(term.plainText()).toBe(screen.text);

  await att.detach();
  term.dispose();
  await client.kill(id, "SIGKILL");
}, 30_000);

test("a lagging snapshot-mode client is resumed with a fresh snapshot, not a render", async () => {
  const bytes = 4 * 1024 * 1024;
  const { id } = await client.run({
    argv: sh(`sleep 0.3; yes | head -c ${bytes}; echo DONE; sleep 30`),
  });
  const slowClient = await connect({ dir, requestTimeoutMs: 20_000 });
  const slow = new Replica(slowClient);
  await slow.attach(id);
  expect(await waitFor(() => slow.snapshots.length === 1, 3000)).toBe(true);
  slowClient.pauseReading();

  const watcher = new Replica(client);
  await watcher.attach(id);
  expect(
    await waitFor(
      () =>
        watcher.pendingOutput.some((b) =>
          new TextDecoder().decode(b).includes("DONE"),
        ),
      15_000,
    ),
  ).toBe(true);
  await sleep(300);
  slowClient.resumeReading();
  expect(await waitFor(() => slow.resumed >= 1, 5000)).toBe(true);
  expect(slow.lagged).toBeGreaterThanOrEqual(1);
  expect(slow.renders).toBe(0);
  expect(slow.snapshots.length).toBeGreaterThanOrEqual(2);
  expect(slow.outputBytes).toBeLessThan(bytes);

  // The resume snapshot is the screen at the moment of the resume, and the
  // output after it (none is expected, the session is idle) applies on top.
  await sleep(200);
  const term = slow.decodeLatest();
  const screen = await client.screen(id);
  expect(term.plainText()).toContain("DONE");
  expect(term.plainText()).toBe(screen.text);
  expect(term.cursor()).toEqual(screen.cursor);
  console.log(
    `lagging snapshot client: ${slow.snapshots.length} snapshots (${slow.snapshots.map((s) => s.byteLength).join(", ")} B), lagged ${slow.lagged}x, ${slow.outputBytes} output bytes kept of ${(bytes * 3) / 2}`,
  );

  term.dispose();
  await slow.att.detach();
  await watcher.att.detach();
  slowClient.close();
  await client.kill(id, "SIGKILL");
}, 30_000);

// The order this asserts is the order on one connection that carries
// nothing else, so the attacher is a connection of its own. Over a
// connection still attached to another session, `attach` installs its
// handlers before the daemon has processed the request, and whatever that
// session writes in between reaches the new handlers as `output` ahead of
// the snapshot — on Linux a window nothing lands in, on Windows one that a
// still-running flood from an earlier test fills at ConPTY's pace.
test("an exited session attaches in snapshot mode with its final screen, then the exited notice", async () => {
  const { id } = await client.run({ argv: sh(`echo bye; exit 3`) });
  expect(
    await until(
      async () =>
        (await client.ls()).find((x) => x.id === id)?.status === "exited",
      5000,
    ),
  ).toBe(true);
  const own = await connect({ dir, requestTimeoutMs: 20_000 });
  const rep = new Replica(own);
  const att = await rep.attach(id);
  expect(att.status).toBe("exited");
  expect(await waitFor(() => rep.exited !== null, 3000)).toBe(true);
  expect(rep.snapshots.length).toBe(1);
  expect(rep.order[0]).toBe("snapshot");
  // Whatever the PTY delivered after the snapshot applies on top of it, and
  // the replica still shows the final screen.
  const term = rep.decodeLatest();
  expect(term.plainText().split("\n")[0]).toBe("bye");
  expect(rep.exited!.exitCode).toBe(3);
  term.dispose();
  await att.detach();
  own.close();
  await client.kill(id);
});
