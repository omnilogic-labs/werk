// Lifecycle: autostart, the lock, the readiness pipe, stale sockets, a
// launcher race, and the version handshake. Each test gets its own runtime
// directory and cleans up its daemon.

import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import { connect, DaemonError } from "../client/index.ts";
import { WP_VERSION } from "../protocol/index.ts";
import { alive, sleep, stopDaemon, tempDir, waitFor } from "./_testlib.ts";
import { clientHello, spawnDaemon } from "./launch.ts";
import { READY_TOKEN } from "./main.ts";
import { daemonPaths } from "./paths.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** A runtime directory whose daemon, if any, is stopped after the test. */
function fresh(): string {
  const dir = tempDir();
  cleanups.push(() => stopDaemon(dir));
  return dir;
}

test("connect autostarts a detached daemon and the launcher can leave", async () => {
  const dir = fresh();
  const t0 = performance.now();
  const client = await connect({ dir });
  const ms = performance.now() - t0;
  const pid = client.daemon.pid;
  console.log(`autostart to hello: ${ms.toFixed(0)} ms`);
  expect(alive(pid)).toBe(true);
  expect(client.daemon.wp).toBe(WP_VERSION);
  const paths = daemonPaths(dir);
  expect(fs.statSync(paths.socket).isSocket()).toBe(true);
  expect(fs.statSync(paths.socket).mode & 0o777).toBe(0o600);
  expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  expect(fs.existsSync(paths.lock)).toBe(true);
  // no PID file, and the temp socket name is gone
  expect(fs.readdirSync(dir).sort()).toEqual(["wp.lock", "wp.log", "wp.sock"]);
  // detached: its own session, no controlling terminal
  const ps = Bun.spawnSync(["ps", "-o", "sid=,tty=", "-p", String(pid)])
    .stdout.toString()
    .trim()
    .split(/\s+/);
  expect(Number(ps[0])).toBe(pid);
  expect(ps[1]).toBe("?");
  // a second connection reuses it
  const again = await connect({ dir });
  expect(again.daemon.pid).toBe(pid);
  again.close();
}, 20000);

test("a second daemon is refused by the lock and reports so on its pipe", async () => {
  const dir = fresh();
  const client = await connect({ dir });
  const pid = client.daemon.pid;
  const second = await spawnDaemon({ dir });
  expect(second.report).toMatch(/already holds the lock/);
  await waitFor(() => !alive(second.pid), 3000);
  expect(alive(second.pid)).toBe(false);
  expect(alive(pid)).toBe(true);
  expect((await client.stats()).pid).toBe(pid);
}, 20000);

test("the readiness pipe carries the ready token", async () => {
  const dir = fresh();
  const r = await spawnDaemon({ dir });
  expect(r.report).toBe(READY_TOKEN);
  console.log(`spawn to ready: ${r.ms.toFixed(0)} ms`);
  const client = await connect({ dir, autostart: false });
  expect(client.daemon.pid).toBe(r.pid);
  cleanups.push(async () => client.close());
}, 20000);

test("a stale socket from a killed daemon is replaced by the next autostart", async () => {
  const dir = fresh();
  const first = await connect({ dir });
  const pid1 = first.daemon.pid;
  process.kill(pid1, "SIGKILL");
  await waitFor(() => !alive(pid1), 3000);
  first.close();
  const paths = daemonPaths(dir);
  expect(fs.existsSync(paths.socket)).toBe(true); // stale
  await expect(connect({ dir, autostart: false })).rejects.toThrow();
  const second = await connect({ dir });
  expect(second.daemon.pid).not.toBe(pid1);
  expect(alive(second.daemon.pid)).toBe(true);
}, 20000);

test("two launchers racing end up on one daemon", async () => {
  const dir = fresh();
  const [a, b, c] = await Promise.all([
    connect({ dir }),
    connect({ dir }),
    connect({ dir }),
  ]);
  expect(b.daemon.pid).toBe(a.daemon.pid);
  expect(c.daemon.pid).toBe(a.daemon.pid);
  b.close();
  c.close();
  await sleep(50);
  expect((await a.stats()).connections.length).toBe(1);
}, 20000);

test("a version mismatch is refused plainly", async () => {
  const dir = fresh();
  const client = await connect({ dir });
  const mine = clientHello();
  for (const hello of [
    { ...mine, protocol: mine.protocol + 1 },
    { ...mine, wp: "9.9.9" },
    { ...mine, engine: "0000000000000000000000000000000000000000" },
  ]) {
    const err = await connect({ dir, autostart: false, hello }).catch((e) => e);
    expect(err).toBeInstanceOf(DaemonError);
    expect((err as DaemonError).code).toBe("version-mismatch");
    expect((err as DaemonError).message).toMatch(/client and daemon differ/);
  }
  // a mismatch must not trigger an autostart either
  const err = await connect({ dir, hello: { ...mine, wp: "9.9.9" } }).catch(
    (e) => e,
  );
  expect((err as DaemonError).code).toBe("version-mismatch");
  expect((await client.stats()).pid).toBe(client.daemon.pid);
}, 20000);

test("shutdown over the socket ends the daemon and its sessions", async () => {
  const dir = fresh();
  const client = await connect({ dir });
  const pid = client.daemon.pid;
  const { id } = await client.run({ argv: ["sleep", "30"] });
  const info = (await client.ls()).find((s) => s.id === id)!;
  expect(info.status).toBe("running");
  const childPid = Number(
    Bun.spawnSync(["pgrep", "-P", String(pid), "-x", "sleep"])
      .stdout.toString()
      .trim()
      .split("\n")[0],
  );
  expect(childPid).toBeGreaterThan(0);
  await client.shutdown();
  expect(await waitFor(() => !alive(pid), 3000)).toBe(true);
  expect(await waitFor(() => !alive(childPid), 3000)).toBe(true);
  expect(fs.existsSync(daemonPaths(dir).socket)).toBe(false);
}, 20000);
