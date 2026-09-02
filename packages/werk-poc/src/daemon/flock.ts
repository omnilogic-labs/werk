// `flock(2)` for the daemon's lock file. Bun has no flock API of its own
// (`fs` exposes nothing, `Bun.file` has no lock), but `bun:ffi` can dlopen
// libc and call it directly, and that works inside a compiled binary too
// because the library is resolved at run time. The lock is released by the
// kernel when the holder dies, which is the whole reason to prefer it over a
// PID file. Linux only for now; macOS would want "libc.dylib" / "libSystem".
//
// Windows (spike/win32-daemon) has no flock; the same contract is met by
// `LockFileEx` on the first byte of the file, exclusive and fail-immediately,
// and the kernel releases that too when the holder dies. The handle comes
// from `CreateFileW` rather than from `fs.openSync`: Bun's fds belong to a
// CRT that is not ucrtbase.dll, so `_get_osfhandle` on one is fatal rather
// than wrong (win32-spike run 33688866439). The access mask is spelled as
// FILE_GENERIC_READ | FILE_GENERIC_WRITE because `GENERIC_READ |
// GENERIC_WRITE` is a negative int32 in JavaScript and a negative number
// handed to a `u32` ffi argument arrives as 0 — a handle with no data access,
// on which LockFileEx says ERROR_ACCESS_DENIED (runs 33689491351,
// 33690276089). On win32 `fd` holds the raw HANDLE and `release` is
// `CloseHandle`.

import { dlopen, FFIType, ptr } from "bun:ffi";
import fs from "node:fs";

const LOCK_EX = 2;
const LOCK_NB = 4;

const LOCKFILE_FAIL_IMMEDIATELY = 1;
const LOCKFILE_EXCLUSIVE_LOCK = 2;
const FILE_GENERIC_READ = 0x120089;
const FILE_GENERIC_WRITE = 0x120116;
const FILE_SHARE_READ_WRITE_DELETE = 1 | 2 | 4;
const OPEN_ALWAYS = 4;
const FILE_ATTRIBUTE_NORMAL = 0x80;
const INVALID_HANDLE_VALUE = (1n << 64n) - 1n;

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
    LockFileEx: (
      h: bigint,
      flags: number,
      reserved: number,
      lo: number,
      hi: number,
      overlapped: ReturnType<typeof ptr>,
    ) => number;
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
    LockFileEx: {
      args: [
        FFIType.u64,
        FFIType.u32,
        FFIType.u32,
        FFIType.u32,
        FFIType.u32,
        FFIType.ptr,
      ],
      returns: FFIType.i32,
    },
    GetLastError: { args: [], returns: FFIType.u32 },
    CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
  }) as unknown as typeof kernel32;
  return kernel32!;
}

/**
 * The win32 lock. `LockFileEx` through `bun:ffi` where ffi exists; where it
 * does not — Bun's win32-arm64 build has TinyCC disabled and `dlopen`
 * throws — a named pipe stands in for the lock. `WP_WIN32_LOCK=pipe` forces
 * the fallback so a runner with ffi can still exercise it.
 */
function tryLockWin32(path: string): FileLock | null {
  let k: NonNullable<typeof kernel32>["symbols"];
  try {
    if (process.env.WP_WIN32_LOCK === "pipe") throw new Error("forced");
    k = loadKernel32().symbols;
  } catch {
    return tryLockPipe(path);
  }
  const name = Buffer.from(path + "\0", "utf16le");
  const handle = k.CreateFileW(
    ptr(name),
    FILE_GENERIC_READ | FILE_GENERIC_WRITE,
    FILE_SHARE_READ_WRITE_DELETE,
    null,
    OPEN_ALWAYS,
    FILE_ATTRIBUTE_NORMAL,
    0n,
  );
  if (handle === INVALID_HANDLE_VALUE || handle === 0n)
    throw new Error(
      `cannot open ${path} for LockFileEx: Windows error ${k.GetLastError()}`,
    );
  const overlapped = new Uint8Array(32);
  const r = k.LockFileEx(
    handle,
    LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
    0,
    1,
    0,
    ptr(overlapped),
  );
  if (r === 0) {
    k.CloseHandle(handle);
    return null;
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

/**
 * A lock with no ffi in it: a named-pipe server whose name is derived from
 * the lock path. libuv creates the first instance with
 * FILE_FLAG_FIRST_PIPE_INSTANCE, so a second `Bun.listen` on the same name
 * fails while the first process lives, and the kernel drops the name with
 * the process — the same two properties flock gives. Nothing ever connects
 * to it. Pipe names are machine-wide, hence the hash of the (case-folded)
 * path, and `fd` is -1 because there is no handle to hand out.
 */
function tryLockPipe(path: string): FileLock | null {
  const name = `\\\\.\\pipe\\werk-poc-lock-${Bun.hash(path.toLowerCase())}`;
  let listener: ReturnType<typeof Bun.listen>;
  try {
    listener = Bun.listen({
      unix: name,
      socket: {
        open(socket) {
          socket.end();
        },
        data() {},
        error() {},
      },
    });
  } catch {
    return null;
  }
  return {
    fd: -1,
    release() {
      try {
        listener.stop(true);
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
