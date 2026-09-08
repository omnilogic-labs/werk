import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import { openSync, closeSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadTerminalEngine } from "@werk/terminal/bun";
import { connectSessionClient } from "@werk/session";
import {
  serveSessionDaemon,
  openLocalTransport,
  resolveSessionDaemonPaths,
  ensureSessionDaemon,
  readDaemonRecord,
  recordedDaemonLiveness,
  currentBootId,
  processStartedAt,
} from "../src/index";
import { lockableDirectory } from "../src/platform/lock.js";
import { parseProcessStartLine, psStartedAt } from "../src/platform/posix.js";
import { endpointCredential, shellArgv } from "./commands.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});
async function directory() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "werk-supervise-"));
  directories.push(dir);
  return dir;
}
async function until(check: () => boolean | Promise<boolean>, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(10);
  }
  throw new Error("Condition timed out");
}
const exists = (file: string) =>
  fs.stat(file).then(
    () => true,
    () => false,
  );
async function serve(dir: string, runtime = "run") {
  return serveSessionDaemon({
    runtimeDir: path.join(dir, runtime),
    stateDir: path.join(dir, "state"),
    version: "test",
    engineFactory: await loadTerminalEngine(),
    // Long enough that only an explicit check runs during a test.
    limits: { superviseIntervalMs: 60_000 },
  });
}

test("the lock and the daemon record live in the state directory", async () => {
  const paths = resolveSessionDaemonPaths({
    runtimeDir: "/tmp/werk-1",
    stateDir: "/home/someone/.local/state/werk",
  });
  expect(paths.lock).toBe("/home/someone/.local/state/werk/daemon.lock");
  expect(paths.record).toBe("/home/someone/.local/state/werk/daemon.json");
  expect(paths.fallbackLock).toBe("/tmp/werk-1/daemon.lock");
});

test("a lockable directory is probed without leaving a file behind", async () => {
  const dir = await directory();
  expect(lockableDirectory(dir)).toBe(true);
  expect(await fs.readdir(dir)).toEqual([]);
  expect(lockableDirectory(path.join(dir, "absent"))).toBe(false);
});

test("liveness separates a live daemon from a record left by a reboot", async () => {
  const live = {
    pid: process.pid,
    bootId: currentBootId(),
    startedAt: processStartedAt(process.pid) ?? Date.now(),
    runtimeDir: "/tmp/werk-1",
    stateDir: "/tmp/werk-state",
    endpoint: null,
    version: "0.1.0",
  };
  expect(recordedDaemonLiveness(live)).toEqual({ live: true, reason: "live" });
  expect(recordedDaemonLiveness(null).reason).toBe("no-record");
  expect(recordedDaemonLiveness({ ...live, pid: 0 }).reason).toBe(
    "invalid-record",
  );
  expect(
    recordedDaemonLiveness({ ...live, bootId: "0000-not-this-boot" }).reason,
  ).toBe("stale-boot");
  const gone = Bun.spawnSync([process.execPath, "-e", ""]);
  expect(gone.exitCode).toBe(0);
  expect(recordedDaemonLiveness({ ...live, pid: 0x7fff_0000 }).reason).toBe(
    "exited",
  );
});

test.skipIf(process.platform === "win32")(
  "a pid reused within one boot is not mistaken for the recorded daemon",
  () => {
    // Every platform that has this guard must report a start time for it to read. A
    // platform whose reader answers null fails here rather than skipping in silence.
    expect(Number.isFinite(processStartedAt(process.pid))).toBe(true);
    const record = {
      pid: process.pid,
      bootId: currentBootId(),
      // The record claims a process that started an hour before this one did.
      startedAt: processStartedAt(process.pid)! - 3600_000,
      runtimeDir: "/tmp/werk-1",
      stateDir: "/tmp/werk-state",
      endpoint: null,
      version: "0.1.0",
    };
    expect(recordedDaemonLiveness(record).reason).toBe("pid-reused");
  },
);

test("the line ps prints for a process start is read as an instant in UTC", () => {
  expect(parseProcessStartLine("Tue Sep  8 05:26:49 2026")).toBe(
    Date.UTC(2026, 8, 8, 5, 26, 49),
  );
  // A two-digit day takes one space where a single-digit day takes two.
  expect(parseProcessStartLine("Wed Dec 31 23:59:59 2025\n")).toBe(
    Date.UTC(2025, 11, 31, 23, 59, 59),
  );
  expect(parseProcessStartLine("")).toBe(null);
  expect(parseProcessStartLine("not a date")).toBe(null);
  expect(parseProcessStartLine("Tue Sep  8 05:26:49")).toBe(null);
  expect(parseProcessStartLine("Tue Foo  8 05:26:49 2026")).toBe(null);
});

test.skipIf(process.platform !== "linux")(
  "the ps reader answers a start time that agrees with /proc",
  () => {
    const reported = psStartedAt(process.pid);
    expect(reported).not.toBe(null);
    // This proves the ps spawn works and returns a plausible instant. It does not
    // prove Linux ps is accurate, because `processStartedAt` reads /proc on Linux
    // and never calls ps. Linux ps derives its answer from `btime + starttime/HZ`,
    // and btime moves by seconds whenever the clock is stepped, so a tight bound
    // would flake on a long-uptime or clock-adjusted host. A minute stays stable
    // and still catches every mistake the parser could make: a mishandled zone
    // lands at least fifteen minutes out, and a wrong month or year far further.
    // The zone handling itself is asserted directly, and without depending on the
    // host, by the test above, which compares `parseProcessStartLine` against
    // `Date.UTC`.
    expect(
      Math.abs(reported! - statSync(`/proc/${process.pid}`).ctimeMs),
    ).toBeLessThan(60_000);
    expect(psStartedAt(0x7fff_0000)).toBe(null);
  },
);

test("one daemon per state directory, whatever the runtime directory", async () => {
  const dir = await directory();
  const first = await serve(dir);
  const paths = resolveSessionDaemonPaths({
    runtimeDir: path.join(dir, "run"),
    stateDir: path.join(dir, "state"),
  });
  try {
    expect(await exists(paths.lock)).toBe(true);
    expect(await exists(paths.fallbackLock)).toBe(false);
    const record = (await readDaemonRecord(paths.record))!;
    expect(record.pid).toBe(process.pid);
    expect(record.bootId).toBe(currentBootId());
    expect(record.runtimeDir).toBe(paths.runtimeDir);
    expect(recordedDaemonLiveness(record).live).toBe(true);
    // A second runtime directory used to buy a second daemon; the state lock refuses it.
    await expect(serve(dir, "other-run")).rejects.toThrow("already running");
  } finally {
    await first.close();
  }
  expect(await exists(paths.record)).toBe(false);
  const second = await serve(dir);
  await second.close();
});

test("the daemon rebuilds a removed socket, endpoint record and lock", async () => {
  const dir = await directory();
  const daemon = await serve(dir);
  const paths = resolveSessionDaemonPaths({
    runtimeDir: path.join(dir, "run"),
    stateDir: path.join(dir, "state"),
  });
  try {
    const before = await daemon.info.id;
    await fs.rm(paths.runtimeDir, { recursive: true, force: true });
    await daemon.supervise();
    expect(await exists(paths.socket)).toBe(true);
    expect(await exists(paths.endpoint)).toBe(true);
    expect(JSON.parse(await fs.readFile(paths.endpoint, "utf8"))).toEqual(
      daemon.endpoint as never,
    );
    const client = await connectSessionClient({
      transport: await openLocalTransport(daemon.endpoint),
      credential: endpointCredential(daemon.endpoint),
    });
    // The same daemon, not a replacement: the sessions it owns are still its own.
    expect((await client.daemonInfo()).id).toBe(before);
    await client.close();
    // A removed lock file would otherwise let a second daemon take a fresh one.
    await fs.rm(paths.lock, { force: true });
    await daemon.supervise();
    expect(await exists(paths.lock)).toBe(true);
    await expect(serve(dir, "rival")).rejects.toThrow("already running");
  } finally {
    await daemon.close();
  }
});

test("a self-heal keeps the sessions and the connections it already has", async () => {
  const dir = await directory();
  const daemon = await serve(dir);
  const paths = resolveSessionDaemonPaths({
    runtimeDir: path.join(dir, "run"),
    stateDir: path.join(dir, "state"),
  });
  const client = await connectSessionClient({
    transport: await openLocalTransport(daemon.endpoint),
    credential: endpointCredential(daemon.endpoint),
  });
  try {
    const session = await client.create({
      argv: shellArgv,
      size: { cols: 80, rows: 24 },
    });
    await fs.rm(paths.runtimeDir, { recursive: true, force: true });
    await daemon.supervise();
    // The daemon that lost its socket is the same daemon, still holding the same PTY.
    expect((await client.list()).map((s) => s.id)).toEqual([session.id]);
    await client.terminate(session.id, "force");
  } finally {
    await client.close();
    await daemon.close();
  }
});

test("the daemon touches its files so an age-based cleaner sees them as recent", async () => {
  const dir = await directory();
  const daemon = await serveSessionDaemon({
    runtimeDir: path.join(dir, "run"),
    stateDir: path.join(dir, "state"),
    version: "test",
    engineFactory: await loadTerminalEngine(),
    limits: { superviseIntervalMs: 60_000, touchIntervalMs: 1 },
  });
  const paths = resolveSessionDaemonPaths({
    runtimeDir: path.join(dir, "run"),
    stateDir: path.join(dir, "state"),
  });
  try {
    const stale = new Date("2001-01-01T00:00:00Z");
    for (const file of [paths.socket, paths.endpoint, paths.lock])
      await fs.utimes(file, stale, stale);
    await Bun.sleep(5);
    await daemon.supervise();
    for (const file of [paths.socket, paths.endpoint, paths.lock])
      expect((await fs.stat(file)).mtimeMs).toBeGreaterThan(stale.getTime());
  } finally {
    await daemon.close();
  }
});

test.skipIf(process.platform === "win32")(
  "SIGUSR1 rebuilds the endpoint without waiting for the interval",
  async () => {
    const dir = await directory();
    const daemon = await serve(dir);
    const paths = resolveSessionDaemonPaths({
      runtimeDir: path.join(dir, "run"),
      stateDir: path.join(dir, "state"),
    });
    try {
      await fs.rm(paths.runtimeDir, { recursive: true, force: true });
      process.kill(process.pid, "SIGUSR1");
      await until(() => exists(paths.socket));
      await until(() => exists(paths.endpoint));
    } finally {
      await daemon.close();
    }
  },
);

test.skipIf(process.platform === "win32")(
  "a client waits for a live daemon rather than spawning a second one",
  async () => {
    const dir = await directory();
    const daemon = await serve(dir);
    const paths = resolveSessionDaemonPaths({
      runtimeDir: path.join(dir, "run"),
      stateDir: path.join(dir, "state"),
    });
    const marker = path.join(dir, "spawned");
    try {
      await fs.rm(paths.runtimeDir, { recursive: true, force: true });
      const found = await ensureSessionDaemon({
        runtimeDir: paths.runtimeDir,
        stateDir: paths.stateDir,
        startupTimeoutMs: 5000,
        daemonCommand: [
          process.execPath,
          "-e",
          `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x")`,
        ],
      });
      expect(found.endpoint).toEqual(daemon.endpoint as never);
      expect(await exists(marker)).toBe(false);
      const record = (await readDaemonRecord(paths.record))!;
      expect(record.pid).toBe(process.pid);
    } finally {
      await daemon.close();
    }
  },
);

test.skipIf(process.platform === "win32")(
  "a client that finds no live record still starts a daemon",
  async () => {
    const dir = await directory();
    const paths = resolveSessionDaemonPaths({
      runtimeDir: path.join(dir, "run"),
      stateDir: path.join(dir, "state"),
    });
    await fs.mkdir(paths.stateDir, { recursive: true, mode: 0o700 });
    // A record from a previous boot must not hold a client back.
    await fs.writeFile(
      paths.record,
      JSON.stringify({
        pid: process.pid,
        bootId: "0000-a-previous-boot",
        startedAt: Date.now(),
        runtimeDir: paths.runtimeDir,
        stateDir: paths.stateDir,
        endpoint: null,
        version: "0.1.0",
      }),
      { mode: 0o600 },
    );
    const marker = path.join(dir, "spawned");
    await expect(
      ensureSessionDaemon({
        runtimeDir: paths.runtimeDir,
        stateDir: paths.stateDir,
        startupTimeoutMs: 300,
        daemonCommand: [
          process.execPath,
          "-e",
          `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x")`,
        ],
      }),
    ).rejects.toThrow("startup deadline");
    expect(await exists(marker)).toBe(true);
  },
);

test.skipIf(process.platform !== "linux")(
  "the runtime directory is held under a shared lock while the daemon runs",
  async () => {
    const { dlopen, FFIType } = await import("bun:ffi");
    const library = dlopen("libc.so.6", {
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    });
    const dir = await directory();
    const daemon = await serve(dir);
    const runtimeDir = path.join(dir, "run");
    const exclusive = () => {
      const fd = openSync(runtimeDir, "r");
      try {
        return library.symbols.flock(fd, 2 | 4);
      } finally {
        closeSync(fd);
      }
    };
    try {
      // tmpfiles.d(5) says the aging algorithm skips a directory that is already locked.
      expect(exclusive()).toBe(-1);
    } finally {
      await daemon.close();
    }
    expect(exclusive()).toBe(0);
    library.close();
  },
);
