// Lifecycle: autostart, the lock, the readiness pipe, stale sockets, a
// launcher race, and the version handshake. Each test gets its own runtime
// directory and cleans up its daemon.
//
// Questions about the socket and the directory go through the seam rather
// than `fs`: a Windows socket is a reparse point `stat` refuses and NTFS has
// no mode bits, so "is the socket there" and "is it this user's alone" are
// each a row of `../platform/` with one answer on every platform. A
// rejection is caught and inspected rather than asserted through
// `expect().rejects`, which hangs on Windows for some requests
// (docs/proposals/01-cross-platform.md §11).

import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { connect, DaemonError } from "../client/index.ts";
import { platform } from "../platform/index.ts";
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
  // The launcher is a process of its own: it autostarts, prints the pid and
  // exits, and the daemon has to be there afterwards. That is what
  // "detached" means on every platform; the session check below is the
  // POSIX mechanism behind it.
  const t0 = performance.now();
  const launcher = Bun.spawnSync(
    [process.execPath, "run", path.join(import.meta.dir, "_launcher.ts"), dir],
    { stdout: "pipe", stderr: "pipe" },
  );
  const ms = performance.now() - t0;
  expect({
    exit: launcher.exitCode,
    stderr: launcher.stderr.toString().trim(),
  }).toEqual({ exit: 0, stderr: "" });
  const pid = Number(launcher.stdout.toString().trim());
  console.log(`launcher: autostart to hello and exit: ${ms.toFixed(0)} ms`);
  expect(pid).toBeGreaterThan(0);
  expect(alive(pid)).toBe(true);
  const client = await connect({ dir, autostart: false });
  expect(client.daemon.pid).toBe(pid);
  expect(client.daemon.wp).toBe(WP_VERSION);
  const paths = daemonPaths(dir);
  expect(platform.socketExists(paths.socket)).toBe(true);
  expect(platform.privateToUser(paths.socket)).toMatchObject({ private: true });
  expect(platform.privateToUser(dir)).toMatchObject({ private: true });
  expect(fs.existsSync(paths.lock)).toBe(true);
  // no PID file, and the temp socket name and the ready file are gone
  expect(fs.readdirSync(dir).sort()).toEqual(["wp.lock", "wp.log", "wp.sock"]);
  // On POSIX the detachment has a name: its own session, no controlling
  // terminal. Windows has neither sessions nor controlling terminals; the
  // launcher's exit above is the whole of the question there.
  if (platform.id === "win32") {
    // nothing more to read
  } else if (process.platform === "darwin") {
    // BSD `ps` has no `sid` keyword; the `s` in STAT marks a session leader,
    // and it writes "no controlling terminal" as "??".
    const ps = Bun.spawnSync(["ps", "-o", "state=,tty=", "-p", String(pid)])
      .stdout.toString()
      .trim()
      .split(/\s+/);
    expect(ps[0]).toContain("s");
    expect(ps[1]).toBe("??");
  } else {
    const ps = Bun.spawnSync(["ps", "-o", "sid=,tty=", "-p", String(pid)])
      .stdout.toString()
      .trim()
      .split(/\s+/);
    expect(Number(ps[0])).toBe(pid);
    expect(ps[1]).toBe("?");
  }
  // a second connection reuses it
  const again = await connect({ dir });
  expect(again.daemon.pid).toBe(pid);
  again.close();
  client.close();
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
  platform.terminate(pid1);
  expect(await waitFor(() => !alive(pid1), 3000)).toBe(true);
  first.close();
  const paths = daemonPaths(dir);
  expect(platform.socketExists(paths.socket)).toBe(true); // stale
  const refused = await connect({ dir, autostart: false }).then(
    () => null,
    (e: unknown) => e,
  );
  expect(refused).toBeInstanceOf(Error);
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
  // The child says who it is, since nothing like `pgrep` exists everywhere:
  // a bun that writes its pid to a file and then sits.
  const pidFile = path.join(dir, "child.pid");
  const { id } = await client.run({
    argv: [
      process.execPath,
      "-e",
      `await Bun.write(${JSON.stringify(pidFile)}, String(process.pid)); await Bun.sleep(30_000);`,
    ],
  });
  const info = (await client.ls()).find((s) => s.id === id)!;
  expect(info.status).toBe("running");
  expect(await waitFor(() => fs.existsSync(pidFile), 5000)).toBe(true);
  const childPid = Number(fs.readFileSync(pidFile, "utf8"));
  expect(childPid).toBeGreaterThan(0);
  expect(alive(childPid)).toBe(true);
  await client.shutdown();
  expect(await waitFor(() => !alive(pid), 3000)).toBe(true);
  expect(await waitFor(() => !alive(childPid), 3000)).toBe(true);
  expect(platform.socketExists(daemonPaths(dir).socket)).toBe(false);
}, 20000);

test("an explicit socket path is used as given and never autostarts", async () => {
  const dir = fresh();
  const client = await connect({ dir });
  // A forwarded socket lives wherever ssh put it; the same socket reached
  // through a directory link elsewhere stands in for one. A link to the
  // directory rather than to the socket, because Winsock does not follow a
  // file symlink to its reparse point (run 33737161625) and a junction is
  // resolved before the socket is reached.
  const elsewhere = tempDir();
  fs.symlinkSync(dir, path.join(elsewhere, "forwarded"), "junction");
  const socket = path.join(elsewhere, "forwarded", "wp.sock");
  const viaSocket = await connect({ socket });
  expect(viaSocket.daemon.pid).toBe(client.daemon.pid);
  expect(viaSocket.paths.socket).toBe(socket);
  viaSocket.close();
  // Nothing answers: the client reports that rather than starting a daemon there.
  const missing = path.join(elsewhere, "nothing.sock");
  const refused = await connect({ socket: missing, timeoutMs: 1000 }).then(
    () => null,
    (e: unknown) => e,
  );
  expect(refused).toBeInstanceOf(Error);
  expect(fs.existsSync(path.join(elsewhere, "wp.lock"))).toBe(false);
  client.close();
  fs.rmSync(elsewhere, { recursive: true, force: true });
}, 20000);
