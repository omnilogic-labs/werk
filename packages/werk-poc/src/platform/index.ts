// The one place that knows which operating system this is.
//
// Everything the daemon does differently on Windows and on a POSIX system is
// a method on `Platform`, implemented once in `posix.ts` and once in
// `win32.ts`. Nothing outside this directory reads `process.platform`: a call
// site that needs a platform difference asks for a method, and a difference
// with no method here is a missing row rather than a branch to write inline.
//
// The two implementations are POSIX and Windows. Differences *within* POSIX —
// BSD against GNU `ps` keywords, `script(1)`'s flags, `/dev/pts/N` against
// `/dev/ttysNNN` — are handled inside `posix.ts` where they belong to a
// method, and in the M0 probes, which exist to measure those primitives
// directly and so cannot go through an abstraction of them.

import { posix } from "./posix.ts";
import { win32 } from "./win32.ts";

/** An exclusive lock held for as long as the process lives, or `release()`. */
export interface FileLock {
  /** The POSIX fd, the Windows HANDLE as a number, or -1 when there is neither. */
  fd: number;
  release(): void;
}

/** What a spawned daemon reported before the launcher stopped waiting for it. */
export interface DaemonStart {
  pid: number;
  /** The ready token, an error line, or "" when the report did not arrive in time. */
  report: string;
  /** The daemon's exit code so far, or null while it is still running. */
  exitCode(): number | null;
}

export interface SpawnDaemonOptions {
  /** The runtime directory, already created. */
  dir: string;
  /** How long to wait for the readiness report before giving up on it. */
  readyTimeoutMs: number;
  /** Builds the daemon's argv from the extra arguments this platform needs. */
  argv(extra: string[]): string[];
}

export interface Platform {
  readonly id: "posix" | "win32";

  /** Where the socket, lock and log live when nothing overrides it. */
  runtimeDir(): string;
  /** Where snapshots live when nothing overrides it; outlives a logout. */
  stateDir(): string;
  /** Refuses a runtime directory this user does not own, where that is knowable. */
  checkRuntimeDir(dir: string): void;

  /** An exclusive, non-blocking lock on `path`; null when another process holds it. */
  lock(path: string): FileLock | null;

  /** Spawns a detached daemon and reads its readiness report, best-effort. */
  spawnDaemon(opts: SpawnDaemonOptions): Promise<DaemonStart>;
  /** What to add to the launcher's deadline message when readiness never arrived. */
  readinessDetail(started: DaemonStart, logFile: string): string;

  /** Removes whatever a dead daemon left at the socket path, where that is needed. */
  clearStaleSocket(path: string): void;
  /** Restricts the just-bound socket to this user, where the filesystem can say so. */
  restrictSocket(path: string): void;

  /** The listener's socket buffer size this platform wants, or null for the kernel's. */
  defaultSocketBufferBytes(): number | null;
  /** Sets SO_SNDBUF and SO_RCVBUF on `fd`; returns what the kernel reports back. */
  setSocketBuffers(fd: number, bytes: number): string;

  /** Whether `pid` is a live process; a zombie waiting to be reaped counts as dead. */
  isAlive(pid: number): boolean;
  /** Resident set size of `pid` in bytes, or null when this platform cannot say. */
  rss(pid: number): number | null;
  /** What this machine calls its CPU, for a report that has to name it. */
  cpuModel(): string;

  /** Registers whatever signals reach a detached daemon on this platform. */
  onShutdownSignal(handler: (reason: string) => void): void;
}

export const platform: Platform = process.platform === "win32" ? win32 : posix;

/**
 * True when running from a `bun build --compile` binary. Bun's bunfs is
 * `/$bunfs/` on a POSIX system and the virtual drive `B:\~BUN\` on Windows,
 * where the path arrives with backslashes — a check for one spelling alone
 * makes `wp.exe` believe it is interpreted and relaunch its daemon the wrong
 * way (spike/win32-daemon).
 */
export const compiled =
  import.meta.path.startsWith("/$bunfs/") ||
  /^B:[\\/]~BUN[\\/]/.test(import.meta.path);

/**
 * How many bytes to ask for on the listening socket, or null to leave the
 * kernel default alone. `WP_SNDBUF=0` switches it off; any other value
 * overrides the platform's own figure.
 */
export function socketBufferBytes(): number | null {
  const raw = process.env.WP_SNDBUF;
  if (raw !== undefined && raw !== "") {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
  }
  return platform.defaultSocketBufferBytes();
}
