// M3: snapshots to disk on a timer, on exit, on `shutdown` and on a real
// SIGTERM; corpses restored on the next start with the two-stage decode;
// the mismatch rule; `kill --rm` removing the file; the `snapshot`
// request. Real daemons in temporary runtime and state directories, one
// second between timer ticks.

import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { connect, type Client } from "../client/index.ts";
import { GHOSTTY_COMMIT } from "../engine/ghostty-wasm/bytes.ts";
import { loadGhosttyWasmEngine } from "../engine/ghostty-wasm/bun.ts";
import { isUnsupported } from "../engine/types.ts";
import { WP_VERSION } from "../protocol/index.ts";
import {
  alive,
  Capture,
  sleep,
  stopDaemon,
  tempDir,
  waitFor,
} from "./_testlib.ts";
import {
  listSnapshotFiles,
  readSnapshot,
  snapshotPath,
  writeSnapshot,
  SNAPSHOT_MAGIC,
} from "./snapshot.ts";

const dir = tempDir();
const stateDir = path.join(dir, "state");
const savedEnv = { ...process.env };
let client: Client;
let pid: number;

/** A daemon started in `dir` with snapshots in `stateDir`, one second apart. */
async function startDaemon(): Promise<Client> {
  process.env.WP_STATE_DIR = stateDir;
  process.env.WP_SNAPSHOT_INTERVAL_MS = "1000";
  const c = await connect({ dir, requestTimeoutMs: 20_000 });
  return c;
}

/** Ends the daemon over the socket and waits for the process, keeping both directories. */
async function restartDaemon(): Promise<Client> {
  const old = pid;
  await client.shutdown();
  client.close();
  expect(await waitFor(() => !alive(old), 5000)).toBe(true);
  client = await startDaemon();
  pid = client.daemon.pid;
  expect(pid).not.toBe(old);
  return client;
}

beforeAll(async () => {
  client = await startDaemon();
  pid = client.daemon.pid;
}, 30_000);

afterAll(async () => {
  await stopDaemon(dir, client, pid);
  process.env.WP_STATE_DIR = savedEnv.WP_STATE_DIR;
  process.env.WP_SNAPSHOT_INTERVAL_MS = savedEnv.WP_SNAPSHOT_INTERVAL_MS;
}, 30_000);

const sh = (script: string) => ["sh", "-c", script];
const env = { PS1: "$ ", PATH: process.env.PATH!, TERM: "xterm-256color" };

/** Waits until the session's screen shows `marker` and ends at the prompt. */
async function idleShell(id: string, marker: string): Promise<void> {
  const end = Date.now() + 10_000;
  while (Date.now() < end) {
    const s = await client.screen(id);
    if (s.text.includes(marker) && s.text.trimEnd().endsWith("$")) return;
    await sleep(50);
  }
  throw new Error(`session ${id} never showed ${marker} at an idle prompt`);
}

// Shared across the tests below, in order.
let small: string; // a short session: a few lines then an idle shell
let big: string; // 3,000 lines of scrollback, more than one page
let before: {
  smallScreen: Awaited<ReturnType<Client["screen"]>>;
  smallLogs: string;
  smallRender: string;
  bigScreen: Awaited<ReturnType<Client["screen"]>>;
  bigLogs: string;
};

test("a timer snapshot lands on disk with a header and the GHOSTSNP magic", async () => {
  small = (
    await client.run({
      argv: sh("printf '\\033[1;32mgreen\\033[0m one\\ntwo\\n'; exec sh"),
      env,
      cols: 60,
      rows: 12,
    })
  ).id;
  await idleShell(small, "two");
  const file = snapshotPath(stateDir, small);
  expect(await waitFor(() => fs.existsSync(file), 5000)).toBe(true);
  // The timer runs on, but the shell is idle, so the file stays as it is.
  const snap = readSnapshot(file);
  expect(snap.header.id).toBe(small);
  expect(snap.header.wp).toBe(WP_VERSION);
  expect(snap.header.engine).toBe("ghostty-wasm");
  expect(snap.header.ghostty).toBe(GHOSTTY_COMMIT);
  expect(snap.header.argv[0]).toBe("sh");
  expect(snap.header.cols).toBe(60);
  expect(snap.header.rows).toBe(12);
  expect(snap.header.status).toBe("running");
  expect(snap.header.exitCode).toBeNull();
  expect(snap.header.snapshotAt).toBeGreaterThan(snap.header.createdAt - 1);
  expect(snap.header.bytes).toBe(snap.bytes.byteLength);
  expect(new TextDecoder().decode(snap.bytes.subarray(0, 8))).toBe(
    SNAPSHOT_MAGIC,
  );
  const ls = await client.ls();
  const info = ls.find((s) => s.id === small)!;
  expect(info.snapshotAt).toBe(snap.header.snapshotAt);
  expect(info.corpse).toBeNull();
  const stats = await client.stats();
  expect(stats.snapshots.written.timer).toBeGreaterThanOrEqual(1);
  expect(stats.snapshots.intervalMs).toBe(1000);
  expect(stats.snapshots.stateDir).toBe(stateDir);
  console.log(
    `timer snapshot: ${snap.bytes.byteLength} B of GHOSTSNP for the idle 60x12 shell; slowest encode so far ${JSON.stringify(stats.snapshots.slowest)}`,
  );
}, 30_000);

test("an idle session is not rewritten; one that printed is", async () => {
  const file = snapshotPath(stateDir, small);
  const m1 = fs.statSync(file).mtimeMs;
  await sleep(2200);
  expect(fs.statSync(file).mtimeMs).toBe(m1);
  const cap = new Capture(client);
  await cap.attach(small, { cols: 60, rows: 12 });
  cap.att.input("echo three\r");
  await idleShell(small, "three");
  expect(await waitFor(() => fs.statSync(file).mtimeMs > m1, 5000, 50)).toBe(
    true,
  );
  await cap.att.detach();
}, 30_000);

test("a session that exits is snapshotted once more with its final screen and exit code", async () => {
  const { id } = await client.run({ argv: sh("echo bye; exit 3"), env });
  const file = snapshotPath(stateDir, id);
  expect(
    await waitFor(() => {
      try {
        return readSnapshot(file).header.status === "exited";
      } catch {
        return false;
      }
    }, 5000),
  ).toBe(true);
  const snap = readSnapshot(file);
  expect(snap.header.exitCode).toBe(3);
  expect(snap.header.exitedAt).not.toBeNull();
  // and the emulator inside it holds the last line
  const engine = await loadGhosttyWasmEngine();
  const d = engine.decodeState(snap.bytes);
  if (isUnsupported(d)) throw new Error(d.reason);
  const t = d.ready();
  while (d.next());
  expect(t.plainText()).toContain("bye");
  t.dispose();
  const stats = await client.stats();
  expect(stats.snapshots.written.exit).toBeGreaterThanOrEqual(1);
  await client.kill(id); // exited -> removed
  expect(fs.existsSync(file)).toBe(false);
}, 30_000);

test("the snapshot request returns GHOSTSNP bytes that decode to the session's screen", async () => {
  const r = await client.snapshot(small);
  expect(r.ghostty).toBe(GHOSTTY_COMMIT);
  expect(r.cols).toBe(60);
  expect(new TextDecoder().decode(r.bytes.subarray(0, 8))).toBe(SNAPSHOT_MAGIC);
  const engine = await loadGhosttyWasmEngine();
  const d = engine.decodeState(r.bytes);
  if (isUnsupported(d)) throw new Error(d.reason);
  const t = d.ready();
  while (d.next());
  const screen = await client.screen(small);
  expect(t.plainText()).toBe(screen.text);
  expect(t.cursor()).toEqual(screen.cursor);
  t.dispose();
  console.log(
    `snapshot request: ${r.bytes.byteLength} B, encoded in ${r.encodeMs.toFixed(2)} ms`,
  );
}, 30_000);

test("shutdown writes every session; the next daemon lists corpses whose screens match", async () => {
  big = (
    await client.run({
      argv: sh("seq 1 3000; exec sh"),
      env,
      cols: 80,
      rows: 24,
    })
  ).id;
  await idleShell(big, "3000");
  // A live render for the small session, to compare with the corpse's.
  const cap = new Capture(client);
  await cap.attach(small, { cols: 60, rows: 12 });
  await sleep(100);
  await cap.att.detach();
  before = {
    smallScreen: await client.screen(small),
    smallLogs: await client.logs(small),
    smallRender: cap.render,
    bigScreen: await client.screen(big),
    bigLogs: await client.logs(big),
  };
  expect(before.bigLogs.split("\n").length).toBeGreaterThan(1000);

  await restartDaemon();

  const files = listSnapshotFiles(stateDir);
  expect(files.map((f) => path.basename(f, ".snap")).sort()).toEqual(
    [small, big].sort(),
  );
  for (const f of files) expect(readSnapshot(f).header.status).toBe("running");

  const ls = await client.ls();
  expect(ls.map((s) => s.status)).toEqual(["corpse", "corpse"]);
  const s = ls.find((x) => x.id === small)!;
  expect(s.argv).toEqual(
    sh("printf '\\033[1;32mgreen\\033[0m one\\ntwo\\n'; exec sh"),
  );
  expect(s.corpse).toEqual({ reason: "restored" });
  expect(s.snapshotAt).toBe(
    readSnapshot(snapshotPath(stateDir, small)).header.snapshotAt,
  );
  expect(s.cols).toBe(60);
  expect(s.rows).toBe(12);

  // Screens and scrollback identical to what was recorded before shutdown.
  const afterSmall = await client.screen(small);
  expect(afterSmall.text).toBe(before.smallScreen.text);
  expect(afterSmall.cursor).toEqual(before.smallScreen.cursor);
  expect(await client.logs(small)).toBe(before.smallLogs);
  const afterBig = await client.screen(big);
  expect(afterBig.text).toBe(before.bigScreen.text);
  expect(afterBig.cursor).toEqual(before.bigScreen.cursor);
  expect(await client.logs(big)).toBe(before.bigLogs);

  // The corpse's render frame is the same re-emission a live attach got.
  const cap2 = new Capture(client);
  const att = await cap2.attach(small, { cols: 60, rows: 12 });
  expect(att.status).toBe("corpse");
  expect(cap2.renders.length).toBe(1);
  expect(cap2.render).toBe(before.smallRender);
  expect(cap2.render).toContain("green");
  expect(cap2.exited).toBeNull(); // not an exit: the client stays attached
  await att.detach();

  const stats = await client.stats();
  expect(stats.snapshots.restore.files).toBe(2);
  console.log(
    `restore pass: ${stats.snapshots.restore.files} files in ${stats.snapshots.restore.ms.toFixed(1)} ms`,
  );
}, 30_000);

test("the two-stage decode: ready() made the big session attachable before its history was in", async () => {
  const info = (await client.ls()).find((s) => s.id === big)!;
  const r = info.restore!;
  expect(r).not.toBeNull();
  expect(r.pages).toBeGreaterThanOrEqual(1);
  expect(r.readyRows).toBeGreaterThanOrEqual(24);
  expect(r.readyRows).toBeLessThan(r.totalRows);
  expect(r.totalRows).toBeGreaterThan(1000);
  expect(r.readyMs).toBeGreaterThan(0);
  expect(r.historyMs).toBeGreaterThan(0);
  const smallInfo = (await client.ls()).find((s) => s.id === small)!;
  expect(smallInfo.restore!.pages).toBe(0); // one page holds it all
  console.log(
    `two-stage restore of ${r.snapshotBytes} B: ready() ${r.readyMs.toFixed(2)} ms with ${r.readyRows} rows; history ${r.historyMs.toFixed(2)} ms, ${r.pages} pages to ${r.totalRows} rows`,
  );
}, 30_000);

test("a corpse ignores input with one notice, does not resize, and stays as it was", async () => {
  const cap = new Capture(client);
  const notices: string[] = [];
  const att = await client.attach(big, {
    cols: 100,
    rows: 30,
    onRender: (b) => cap.renders.push(new TextDecoder().decode(b)),
    onNotice: (m) => notices.push(m),
  });
  expect(att.status).toBe("corpse");
  att.input("echo nope\r");
  att.input("more\r");
  expect(await waitFor(() => notices.length > 0, 3000)).toBe(true);
  await sleep(200);
  expect(notices.length).toBe(1);
  expect(notices[0]).toMatch(/read-only/);
  const screen = await client.screen(big);
  expect(screen.cols).toBe(80); // the snapshot's size, not the attacher's
  expect(screen.text).toBe(before.bigScreen.text);
  await att.detach();
  // corpses are never re-snapshotted
  const m = fs.statSync(snapshotPath(stateDir, big)).mtimeMs;
  await sleep(2200);
  expect(fs.statSync(snapshotPath(stateDir, big)).mtimeMs).toBe(m);
  expect((await client.stats()).snapshots.written.timer).toBe(0);
}, 30_000);

test("kill --rm on a corpse removes it and its file", async () => {
  const file = snapshotPath(stateDir, big);
  expect(fs.existsSync(file)).toBe(true);
  const r = await client.kill(big);
  expect(r.action).toBe("removed");
  expect(fs.existsSync(file)).toBe(false);
  expect((await client.ls()).map((s) => s.id)).toEqual([small]);
}, 30_000);

test("a snapshot from another libghostty commit is listed as a mismatch, not decoded", async () => {
  const real = readSnapshot(snapshotPath(stateDir, small));
  const foreign = "0123456789abcdef0123456789abcdef01234567";
  writeSnapshot(
    stateDir,
    { ...real.header, id: "f0f0f0", ghostty: foreign, argv: ["vim", "x"] },
    real.bytes,
  );
  await restartDaemon();
  const ls = await client.ls();
  const m = ls.find((s) => s.id === "f0f0f0")!;
  expect(m.status).toBe("corpse");
  expect(m.corpse).toEqual({
    reason: "mismatch",
    snapshotEngine: foreign,
    daemonEngine: GHOSTTY_COMMIT,
  });
  expect(m.restore).toBeNull();
  expect(m.argv).toEqual(["vim", "x"]);
  // attach works and says what happened; logs too
  const cap = new Capture(client);
  const att = await cap.attach("f0f0f0");
  expect(att.status).toBe("corpse");
  expect(cap.render).toContain("not decoded");
  expect(cap.render).toContain(foreign.slice(0, 12));
  await att.detach();
  expect(await client.logs("f0f0f0")).toContain("not decoded");
  // the good one restored alongside it, decoded as before
  expect((await client.screen(small)).text).toBe(before.smallScreen.text);
  // a restart carries the mismatch forward unchanged (the file is not rewritten)
  const m1 = fs.statSync(snapshotPath(stateDir, "f0f0f0")).mtimeMs;
  await restartDaemon();
  expect(fs.statSync(snapshotPath(stateDir, "f0f0f0")).mtimeMs).toBe(m1);
  expect(
    (await client.ls()).find((s) => s.id === "f0f0f0")!.corpse?.reason,
  ).toBe("mismatch");
  expect((await client.kill("f0f0f0")).action).toBe("removed");
  expect(fs.existsSync(snapshotPath(stateDir, "f0f0f0"))).toBe(false);
}, 30_000);

test("a torn file is left in place and skipped", async () => {
  const file = snapshotPath(stateDir, "bad001");
  fs.writeFileSync(file, '{"id":"bad001","bytes":999}\nGHOSTSNPxx');
  await restartDaemon();
  expect((await client.ls()).map((s) => s.id)).toEqual([small]);
  expect(fs.existsSync(file)).toBe(true);
  fs.unlinkSync(file);
}, 30_000);

test("a real SIGTERM to the detached daemon snapshots every session before it exits", async () => {
  const dir2 = tempDir();
  const state2 = path.join(dir2, "state");
  process.env.WP_STATE_DIR = state2;
  process.env.WP_SNAPSHOT_INTERVAL_MS = "60000"; // the timer must not be what writes the file
  const c = await connect({ dir: dir2 });
  const p = c.daemon.pid;
  const { id } = await c.run({ argv: sh("echo sigterm-case; exec sh"), env });
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    if ((await c.screen(id)).text.includes("sigterm-case")) break;
    await sleep(50);
  }
  expect(listSnapshotFiles(state2)).toEqual([]);
  process.kill(p, "SIGTERM");
  expect(await waitFor(() => !alive(p), 5000)).toBe(true);
  c.close();
  const files = listSnapshotFiles(state2);
  expect(files).toEqual([snapshotPath(state2, id)]);
  const snap = readSnapshot(files[0]!);
  expect(snap.header.status).toBe("running");
  expect(new TextDecoder().decode(snap.bytes.subarray(0, 8))).toBe(
    SNAPSHOT_MAGIC,
  );
  const log = fs.readFileSync(path.join(dir2, "wp.log"), "utf8");
  expect(log).toContain("shutting down: SIGTERM");
  expect(log).toMatch(/shutdown snapshots: 1 of 1/);
  // and it comes back
  const c2 = await connect({ dir: dir2 });
  expect((await c2.ls()).map((s) => [s.id, s.status])).toEqual([
    [id, "corpse"],
  ]);
  expect((await c2.screen(id)).text).toContain("sigterm-case");
  await stopDaemon(dir2, c2, c2.daemon.pid);
  process.env.WP_STATE_DIR = stateDir;
  process.env.WP_SNAPSHOT_INTERVAL_MS = "1000";
}, 30_000);
