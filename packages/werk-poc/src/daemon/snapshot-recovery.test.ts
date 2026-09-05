// Checkpoint failures must not end live sessions or forget pending state.
import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { connect, type Client } from "../client/index.ts";
import {
  Capture,
  alive,
  sleep,
  stopDaemon,
  tempDir,
  waitFor,
} from "./_testlib.ts";
import { platform } from "../platform/index.ts";
import { readSnapshot, snapshotPath } from "./snapshot.ts";

const dir = tempDir();
const state = path.join(dir, "state");
const savedState = process.env.WP_STATE_DIR;
const savedInterval = process.env.WP_SNAPSHOT_INTERVAL_MS;
let client: Client;

beforeAll(async () => {
  process.env.WP_STATE_DIR = state;
  process.env.WP_SNAPSHOT_INTERVAL_MS = "200";
  client = await connect({ dir, requestTimeoutMs: 2000 });
});

afterAll(async () => {
  await stopDaemon(dir, client);
  if (savedState === undefined) delete process.env.WP_STATE_DIR;
  else process.env.WP_STATE_DIR = savedState;
  if (savedInterval === undefined) delete process.env.WP_SNAPSHOT_INTERVAL_MS;
  else process.env.WP_SNAPSHOT_INTERVAL_MS = savedInterval;
});

test("a session that never prints still receives an initial checkpoint", async () => {
  const { id } = await client.run({
    argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
  });
  try {
    expect(
      await waitFor(() => fs.existsSync(snapshotPath(state, id)), 3000),
    ).toBe(true);
    expect(readSnapshot(snapshotPath(state, id)).header.status).toBe("running");
  } finally {
    await client.kill(id, "SIGKILL");
  }
});

test("resizing an exited session checkpoints the new screen without more output", async () => {
  const { id } = await client.run({
    argv: [process.execPath, "-e", 'console.log("final screen")'],
    cols: 60,
    rows: 12,
  });
  const file = snapshotPath(state, id);
  expect(
    await waitFor(() => {
      return (
        fs.existsSync(file) && readSnapshot(file).header.status === "exited"
      );
    }, 3000),
  ).toBe(true);
  const cap = new Capture(client);
  await cap.attach(id, { cols: 40, rows: 10 });
  try {
    expect(
      await waitFor(() => readSnapshot(file).header.cols === 40, 3000),
    ).toBe(true);
    expect(readSnapshot(file).header.rows).toBe(10);
    const at = readSnapshot(file).header.snapshotAt;
    await cap.att.resize(40, 10);
    await sleep(500);
    expect(readSnapshot(file).header.snapshotAt).toBe(at);
  } finally {
    await cap.att.detach();
  }
});

test("an unavailable state directory leaves the daemon alive and retries quiet sessions", async () => {
  // A file in place of the directory fails even as root and on Windows.
  const backup = state + "-saved";
  fs.renameSync(state, backup);
  fs.writeFileSync(state, "temporarily unavailable");
  let id: string | undefined;
  try {
    ({ id } = await client.run({
      argv: [
        process.execPath,
        "-e",
        'console.log("ready"); setInterval(() => {}, 1000)',
      ],
    }));
    expect(
      await waitFor(
        async () => (await client.screen(id!)).text.includes("ready"),
        3000,
      ),
    ).toBe(true);
    const ticks = (await client.stats()).snapshots.ticks;
    await sleep(600);
    expect((await client.stats()).snapshots.ticks).toBeGreaterThan(ticks);
    expect((await client.ls()).find((s) => s.id === id)?.status).toBe(
      "running",
    );
  } finally {
    fs.unlinkSync(state);
    fs.renameSync(backup, state);
  }
  try {
    const file = snapshotPath(state, id!);
    expect(await waitFor(() => fs.existsSync(file), 3000)).toBe(true);
    expect(readSnapshot(file).header.status).toBe("running");
  } finally {
    if (id) await client.kill(id, "SIGKILL");
  }
});

test("abrupt daemon death restores the last checkpoint as a read-only corpse", async () => {
  const { id } = await client.run({
    argv: [
      process.execPath,
      "-e",
      'console.log("checkpoint pid=" + process.pid); setInterval(() => {}, 1000)',
    ],
  });
  let childPid: number | undefined;
  try {
    expect(
      await waitFor(
        async () => (await client.screen(id)).text.includes("checkpoint pid="),
        3000,
      ),
    ).toBe(true);
    const before = await client.screen(id);
    childPid = Number(before.text.match(/checkpoint pid=(\d+)/)![1]);
    const file = snapshotPath(state, id);
    // Wait for these exact bytes, not just an initial empty checkpoint or
    // an elapsed timer interval on a slow native runner.
    const expected = Buffer.from((await client.snapshot(id)).bytes);
    expect(
      await waitFor(
        () =>
          fs.existsSync(file) &&
          Buffer.from(readSnapshot(file).bytes).equals(expected),
        3000,
      ),
    ).toBe(true);
    const checkpoint = readSnapshot(file);
    const oldPid = client.daemon.pid;
    platform.terminate(oldPid);
    expect(await waitFor(() => !alive(oldPid), 3000)).toBe(true);
    client.close();
    client = await connect({ dir, requestTimeoutMs: 2000 });
    expect(client.daemon.pid).not.toBe(oldPid);
    const restored = (await client.ls()).find((s) => s.id === id)!;
    expect(restored.status).toBe("corpse");
    expect(restored.snapshotAt).toBe(checkpoint.header.snapshotAt);
    expect(await client.screen(id)).toEqual(before);
    const cap = new Capture(client);
    await cap.attach(id);
    cap.att.input("should not run\r");
    await cap.att.resize(40, 10);
    expect(await client.screen(id)).toEqual(before);
    await cap.att.detach();
  } finally {
    // A corpse is not a recovered process. Clean up any child a platform
    // happened to leave alive when its PTY owner was forcibly terminated.
    if (childPid && alive(childPid)) platform.terminate(childPid);
  }
});
