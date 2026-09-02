// `flock(2)` for the daemon's lock file. Bun has no flock API of its own
// (`fs` exposes nothing, `Bun.file` has no lock), but `bun:ffi` can dlopen
// libc and call it directly, and that works inside a compiled binary too
// because the library is resolved at run time. The lock is released by the
// kernel when the holder dies, which is the whole reason to prefer it over a
// PID file. Linux only for now; macOS would want "libc.dylib" / "libSystem".
//
// Windows (spike/win32-daemon) has no flock. The same contract — one holder,
// refused immediately otherwise, released by the kernel when the holder
// dies — is met by opening the lock file through `CreateFileW` with a share
// mode that admits no other reader or writer: the second opener fails with
// ERROR_SHARING_VIOLATION until the first handle closes or its process ends.
// DELETE stays shared so a test can still remove the directory. The handle
// comes from `CreateFileW` rather than from `fs.openSync` because Bun's fds
// belong to a CRT that is not ucrtbase.dll, so `_get_osfhandle` on one is
// fatal rather than wrong; and `LockFileEx` on such a handle was refused
// with ERROR_ACCESS_DENIED on the runner (win32-spike runs 33688866439 and
// 33689491351; the probe file carries a matrix of the ways it was asked).
// On win32 `fd` holds the raw HANDLE and `release` is `CloseHandle`.

import { dlopen, FFIType, ptr } from "bun:ffi";
import fs from "node:fs";

const LOCK_EX = 2;
const LOCK_NB = 4;

const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;
const FILE_SHARE_DELETE = 4;
const OPEN_ALWAYS = 4;
const FILE_ATTRIBUTE_NORMAL = 0x80;
const INVALID_HANDLE_VALUE = (1n << 64n) - 1n;
const ERROR_SHARING_VIOLATION = 32;

let kernel32: {
  symbols: {
    CreateFileW: (
      name: ReturnType<typeof ptr>,
      access: number,
      share: number,
      sa: null,
      disposition: number,
      flags: number,
      template: bigint,
    ) => bigint;
    GetLastError: () => number;
    CloseHandle: (h: bigint) => number;
  };
} | null = null;

function loadKernel32() {
  if (kernel32) return kernel32;
  kernel32 = dlopen("kernel32.dll", {
    CreateFileW: {
      args: [
        FFIType.ptr,
        FFIType.u32,
        FFIType.u32,
        FFIType.ptr,
        FFIType.u32,
        FFIType.u32,
        FFIType.u64,
      ],
      returns: FFIType.u64,
    },
    GetLastError: { args: [], returns: FFIType.u32 },
    CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
  }) as unknown as typeof kernel32;
  return kernel32!;
}

function tryLockWin32(path: string): FileLock | null {
  const k = loadKernel32().symbols;
  const name = Buffer.from(path + "\0", "utf16le");
  const handle = k.CreateFileW(
    ptr(name),
    GENERIC_READ | GENERIC_WRITE,
    FILE_SHARE_DELETE,
    null,
    OPEN_ALWAYS,
    FILE_ATTRIBUTE_NORMAL,
    0n,
  );
  if (handle === INVALID_HANDLE_VALUE || handle === 0n) {
    const err = k.GetLastError();
    if (err === ERROR_SHARING_VIOLATION) return null;
    throw new Error(`cannot open ${path} exclusively: Windows error ${err}`);
  }
  return {
    fd: Number(handle),
    release() {
      try {
        k.CloseHandle(handle);
      } catch {}
    },
  };
}

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
  if (process.platform === "win32") return tryLockWin32(path);
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
