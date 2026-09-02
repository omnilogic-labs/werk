// `flock(2)` for the daemon's lock file. Bun has no flock API of its own
// (`fs` exposes nothing, `Bun.file` has no lock), but `bun:ffi` can dlopen
// libc and call it directly, and that works inside a compiled binary too
// because the library is resolved at run time. The lock is released by the
// kernel when the holder dies, which is the whole reason to prefer it over a
// PID file. Linux only for now; macOS would want "libc.dylib" / "libSystem".

import { dlopen, FFIType } from "bun:ffi";
import fs from "node:fs";

const LOCK_EX = 2;
const LOCK_NB = 4;

let libc: { symbols: { flock: (fd: number, op: number) => number } } | null =
  null;

function loadLibc() {
  if (libc) return libc;
  const candidates =
    process.platform === "darwin"
      ? ["libSystem.B.dylib", "libc.dylib"]
      : ["libc.so.6", "libc.so"];
  let last: unknown;
  for (const name of candidates) {
    try {
      libc = dlopen(name, {
        flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      });
      return libc;
    } catch (e) {
      last = e;
    }
  }
  throw new Error(`cannot dlopen libc for flock: ${String(last)}`);
}

export interface FileLock {
  fd: number;
  release(): void;
}

/**
 * Takes an exclusive, non-blocking lock on `path`. Returns null when another
 * process holds it. The lock lives as long as the returned fd stays open.
 */
export function tryLock(path: string): FileLock | null {
  const fd = fs.openSync(path, "w");
  const r = loadLibc().symbols.flock(fd, LOCK_EX | LOCK_NB);
  if (r !== 0) {
    fs.closeSync(fd);
    return null;
  }
  return {
    fd,
    release() {
      try {
        fs.closeSync(fd);
      } catch {}
    },
  };
}
