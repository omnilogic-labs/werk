import fs from "node:fs/promises";
import { closeSync, openSync, readFileSync } from "node:fs";
import os from "node:os";
import { holdSharedDirectoryLock } from "./platform/lock.js";
import {
  forgetPrivate,
  makePrivate,
  processStartedAt,
} from "./platform/index.js";
import type { Logger } from "./log.js";

/**
 * What `$stateDir/daemon.json` holds. `bootId` is what separates a live daemon from a
 * record left behind by a reboot: a pid alone is meaningless once the machine has
 * restarted and the numbers have been handed out again.
 */
export interface DaemonRecord {
  pid: number;
  bootId: string;
  startedAt: number;
  runtimeDir: string;
  stateDir: string;
  endpoint: unknown;
  version: string;
}

let cachedBootId: string | undefined;

/**
 * Linux publishes a boot identifier; elsewhere the boot instant is derived from the clock
 * and the uptime, which is an estimate rather than an identity, so `sameBoot` compares the
 * derived form with a tolerance.
 */
export function currentBootId(): string {
  if (cachedBootId) return cachedBootId;
  try {
    const id = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    if (id) return (cachedBootId = id);
  } catch {}
  return (cachedBootId = `boot:${Math.round((Date.now() - os.uptime() * 1000) / 1000)}`);
}

function derivedBootSeconds(value: string) {
  if (!value.startsWith("boot:")) return null;
  const seconds = Number(value.slice(5));
  return Number.isFinite(seconds) ? seconds : null;
}

export function sameBoot(recorded: string, current = currentBootId()): boolean {
  if (recorded === current) return true;
  const a = derivedBootSeconds(recorded),
    b = derivedBootSeconds(current);
  return a !== null && b !== null && Math.abs(a - b) <= 60;
}

export { processStartedAt };

export type RecordLiveness = {
  live: boolean;
  reason:
    | "live"
    | "no-record"
    | "invalid-record"
    | "stale-boot"
    | "exited"
    | "foreign-owner"
    | "pid-reused";
};

/**
 * Decides whether a recorded daemon is still the process that wrote the record. A false
 * positive would wedge every later command behind a daemon that is not there, so each
 * cheap disagreement — a different boot, another user's process on that pid, a start time
 * that does not match — is read as "not our daemon".
 */
export function recordedDaemonLiveness(
  record: DaemonRecord | null,
): RecordLiveness {
  if (!record) return { live: false, reason: "no-record" };
  if (!Number.isInteger(record.pid) || record.pid <= 0)
    return { live: false, reason: "invalid-record" };
  if (typeof record.bootId !== "string" || !sameBoot(record.bootId))
    return { live: false, reason: "stale-boot" };
  try {
    process.kill(record.pid, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // EPERM means a process holds that pid under another uid, so it is not our daemon.
    return {
      live: false,
      reason: code === "EPERM" ? "foreign-owner" : "exited",
    };
  }
  const started = processStartedAt(record.pid);
  if (
    started !== null &&
    Number.isFinite(record.startedAt) &&
    Math.abs(started - record.startedAt) > 5000
  )
    return { live: false, reason: "pid-reused" };
  return { live: true, reason: "live" };
}

export async function readDaemonRecord(
  file: string,
): Promise<DaemonRecord | null> {
  try {
    const saved = JSON.parse(await fs.readFile(file, "utf8")) as DaemonRecord;
    return saved && typeof saved === "object" ? saved : null;
  } catch {
    return null;
  }
}

/** Written whole through a rename so a reader never sees half a record. */
export async function writeDaemonRecord(file: string, record: DaemonRecord) {
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
  await fs.rename(temporary, file);
}

/**
 * Recreates the lock file itself for a mechanism whose ownership is not tied to the inode,
 * so `werk info` and `doctor` keep describing the same path.
 */
export function recreateLockMarker(file: string) {
  closeSync(openSync(file, "a", 0o600));
}

export async function clearDaemonRecord(file: string) {
  await fs.rm(file, { force: true }).catch(() => {});
}

/** Recreates a private directory, reporting whether it had to be made again. */
export async function ensurePrivateDirectory(directory: string) {
  let created = false;
  try {
    await fs.stat(directory);
  } catch {
    created = true;
  }
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.stat(directory);
  if (process.getuid && stat.uid !== process.getuid())
    throw new Error(`Directory ${directory} belongs to another user`);
  if (created) forgetPrivate(directory);
  await makePrivate(directory);
  return created;
}

export interface SupervisorOptions {
  paths: {
    runtimeDir: string;
    socket: string;
    endpoint: string;
  };
  log: Logger;
  /** False when the endpoint is a loopback port rather than a socket file (Windows). */
  socketBound: boolean;
  /** The inode of the socket the daemon bound, captured by the caller after listening. */
  socketInode: number | null;
  /** Listens a fresh server on `paths.socket` and leaves it serving. */
  relisten: () => Promise<void>;
  /** Rewrites `endpoint.json` (and re-tightens the socket mode where there is one). */
  writeEndpoint: () => Promise<void>;
  /** The lock file actually held, and how to take it again on a fresh inode. */
  lockFile: string;
  relock: () => void;
  intervalMs?: number;
  touchIntervalMs?: number;
}

export interface DaemonSupervisor {
  /** Runs one pass; resolves when the pass finishes. Passes never overlap. */
  check(): Promise<void>;
  stop(): void;
}

async function inode(file: string) {
  try {
    return (await fs.stat(file)).ino;
  } catch {
    return null;
  }
}

/**
 * Defends the daemon's own files. Every interval, and immediately on `SIGUSR1`, it compares
 * the socket inode with the one it bound and recreates whatever has gone: the runtime
 * directory, the socket, the endpoint record, the lock file. Losing the endpoint is a
 * recoverable accident for a process that owns live PTYs, so nothing here ever exits.
 */
export function startDaemonSupervisor(
  options: SupervisorOptions,
): DaemonSupervisor {
  const { paths, log } = options;
  const intervalMs = options.intervalMs ?? 5000;
  const touchIntervalMs = options.touchIntervalMs ?? 3600_000;
  let socketInode = options.socketInode;
  let directoryLock = holdSharedDirectoryLock(paths.runtimeDir);
  let lastTouch = Date.now();
  let stopped = false;
  let running: Promise<void> | undefined;

  async function touch() {
    const now = new Date();
    for (const file of [
      paths.runtimeDir,
      paths.socket,
      paths.endpoint,
      options.lockFile,
    ])
      await fs.utimes(file, now, now).catch(() => {});
  }

  async function pass() {
    const directoryRecreated = await ensurePrivateDirectory(paths.runtimeDir);
    if (directoryRecreated) {
      log.write("info", "runtime-dir.recreated", { path: paths.runtimeDir });
      directoryLock?.();
      directoryLock = holdSharedDirectoryLock(paths.runtimeDir);
    }
    if (options.socketBound) {
      const current = await inode(paths.socket);
      if (current === null || current !== socketInode) {
        log.write("info", "endpoint.lost", {
          path: paths.socket,
          reason: current === null ? "socket-missing" : "inode-changed",
        });
        await options.relisten();
        await options.writeEndpoint();
        socketInode = await inode(paths.socket);
        log.write("info", "endpoint.recreated", {
          path: paths.endpoint,
          socket: paths.socket,
        });
      } else if (!(await fs.stat(paths.endpoint).catch(() => null))) {
        log.write("info", "endpoint.lost", {
          path: paths.endpoint,
          reason: "endpoint-missing",
        });
        await options.writeEndpoint();
        log.write("info", "endpoint.recreated", { path: paths.endpoint });
      }
    } else if (!(await fs.stat(paths.endpoint).catch(() => null))) {
      // A loopback endpoint has no socket file, so the record is the only thing to defend.
      log.write("info", "endpoint.lost", {
        path: paths.endpoint,
        reason: "endpoint-missing",
      });
      await options.writeEndpoint();
      log.write("info", "endpoint.recreated", { path: paths.endpoint });
    }
    if (!(await fs.stat(options.lockFile).catch(() => null))) {
      try {
        options.relock();
      } catch (error) {
        log.write("error", "lock.refused", {
          path: options.lockFile,
          error: String(error),
        });
      }
    }
    if (Date.now() - lastTouch >= touchIntervalMs) {
      lastTouch = Date.now();
      await touch();
    }
  }

  function check() {
    if (stopped) return Promise.resolve();
    return (running = (running ?? Promise.resolve())
      .catch(() => {})
      .then(() => (stopped ? undefined : pass()))
      .catch((error) => {
        log.write("error", "endpoint.lost", {
          path: paths.socket,
          error: String(error),
        });
      }));
  }

  const timer = setInterval(() => void check(), intervalMs);
  timer.unref?.();
  // SIGUSR1 is tmux's "recreate your socket" request. Windows has no such signal.
  const onSignal = () => void check();
  if (process.platform !== "win32") {
    try {
      process.on("SIGUSR1", onSignal);
    } catch {}
  }

  return {
    async check() {
      await check();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      if (process.platform !== "win32") {
        try {
          process.off("SIGUSR1", onSignal);
        } catch {}
      }
      directoryLock?.();
      directoryLock = null;
    },
  };
}
