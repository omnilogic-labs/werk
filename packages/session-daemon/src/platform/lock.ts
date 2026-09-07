import { openSync, closeSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { dlopen, FFIType } from "bun:ffi";
import { acquireWindowsLock } from "./win32.js";

export type LockMechanism = "windows-handle" | "flock" | "abstract-socket";
/** Releases the lock; carries the mechanism that is holding it so callers can log it. */
export type LockRelease = (() => void) & { mechanism: LockMechanism };

const MUSL_ARCH: Record<string, string> = { x64: "x86_64", arm64: "aarch64" };

/**
 * Names to try in order. musl's loader resolves any `libc.*` name to itself, so
 * `libc.so.6` already succeeds there; the rest of the list is insurance against a
 * loader that does not intercept the name.
 */
export function libcCandidates(
  platform = process.platform,
  arch = process.arch,
): string[] {
  if (platform === "darwin") return ["libSystem.B.dylib", "libc.dylib"];
  const musl = MUSL_ARCH[arch];
  return ["libc.so.6", "libc.so", ...(musl ? [`libc.musl-${musl}.so.1`] : [])];
}

function openFlock(candidates: string[]) {
  for (const name of candidates) {
    try {
      return dlopen(name, {
        flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      });
    } catch {}
  }
  return null;
}

function release(fn: () => void, mechanism: LockMechanism): LockRelease {
  return Object.assign(fn, { mechanism });
}

/**
 * Abstract sockets are scoped to the network namespace rather than the filesystem, which is
 * why this is the fallback and not the primary mechanism. The name is derived from the lock
 * path, so it is as predictable as that path, and an abstract name carries no owner and no
 * permission bits: any process in the same namespace can bind it first, and the daemon then
 * reads its own bind failure as "Daemon already running" and does not start. The name is a
 * mutex and never a channel, so nothing travels over it either way. `flock` has neither
 * property, being bounded by the lock file's ownership and mode, and it holds wherever a
 * libc can be opened.
 */
function abstractSocketName(file: string) {
  return `\0werk:${createHash("sha256").update(path.resolve(file)).digest("hex").slice(0, 32)}`;
}

/** Reports the mechanism that would hold the lock, without creating or taking anything. */
export function probeLockMechanism(): LockMechanism | "unavailable" {
  if (process.platform === "win32") return "windows-handle";
  const library = openFlock(libcCandidates());
  if (library) {
    library.close();
    return "flock";
  }
  return process.platform === "linux" ? "abstract-socket" : "unavailable";
}

/**
 * Reports whether a directory can hold a daemon lock, by taking and releasing one on a
 * private probe file. A `flock` that a filesystem cannot grant is indistinguishable from
 * contention through this interface, so callers ask this first and can then read a refusal
 * on the real lock file as a genuine second daemon.
 */
export function lockableDirectory(directory: string): boolean {
  const probe = path.join(directory, `.lock-probe-${process.pid}`);
  try {
    acquireDaemonLock(probe)();
    return true;
  } catch {
    return false;
  } finally {
    try {
      rmSync(probe, { force: true });
    } catch {}
  }
}

/**
 * A shared `flock` on a directory fd, held for the daemon's lifetime. tmpfiles.d(5) says the
 * aging algorithm skips a directory that is already locked, so this is how the runtime
 * directory asks a cleaner to leave it alone. Returns null where no lock can be taken
 * (Windows, or a Linux box with no loadable libc), which is not an error.
 */
export function holdSharedDirectoryLock(
  directory: string,
): (() => void) | null {
  if (process.platform === "win32") return null;
  const library = openFlock(libcCandidates());
  if (!library) return null;
  let fd: number;
  try {
    fd = openSync(directory, "r");
  } catch {
    library.close();
    return null;
  }
  if (library.symbols.flock(fd, 1 | 4) !== 0) {
    closeSync(fd);
    library.close();
    return null;
  }
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    closeSync(fd);
    library.close();
  };
}

/** Kernel ownership survives stale socket paths and ends automatically on process death. */
export function acquireDaemonLock(
  file: string,
  options: { libcCandidates?: string[] } = {},
): LockRelease {
  if (process.platform === "win32")
    return release(acquireWindowsLock(file), "windows-handle");
  const library = openFlock(options.libcCandidates ?? libcCandidates());
  if (!library) {
    if (process.platform !== "linux")
      throw new Error("Cannot load libc to lock the daemon");
    // Keep the lock file so `werk info` and `doctor` still describe the same path. A bind
    // failure here means the name is taken, by another daemon or by anything else in this
    // network namespace that reached it first; see `abstractSocketName`.
    const marker = openSync(file, "a", 0o600);
    let listener;
    try {
      listener = Bun.listen({
        unix: abstractSocketName(file),
        socket: { data() {} },
      });
    } catch {
      closeSync(marker);
      throw new Error("Daemon already running");
    }
    let closed = false;
    return release(() => {
      if (closed) return;
      closed = true;
      listener.stop(true);
      closeSync(marker);
    }, "abstract-socket");
  }
  let fd: number;
  try {
    fd = openSync(file, "a", 0o600);
  } catch (error) {
    library.close();
    throw error;
  }
  if (library.symbols.flock(fd, 6) !== 0) {
    closeSync(fd);
    library.close();
    throw new Error("Daemon already running");
  }
  let closed = false;
  return release(() => {
    if (closed) return;
    closed = true;
    closeSync(fd);
    library.close();
  }, "flock");
}
