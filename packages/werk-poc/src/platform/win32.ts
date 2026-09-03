// The Windows half of the seam.
//
// There is no flock; the same contract is met by `LockFileEx` on the first
// byte of the lock file, exclusive and fail-immediately, and the kernel
// releases that too when the holder dies. The handle comes from `CreateFileW`
// rather than from `fs.openSync`: Bun's fds belong to a CRT that is not
// ucrtbase.dll, so `_get_osfhandle` on one is fatal rather than wrong
// (win32-spike run 33688866439). The access mask is spelled as
// FILE_GENERIC_READ | FILE_GENERIC_WRITE because `GENERIC_READ |
// GENERIC_WRITE` is a negative int32 in JavaScript and a negative number
// handed to a `u32` ffi argument arrives as 0 — a handle with no data access,
// on which LockFileEx says ERROR_ACCESS_DENIED (runs 33689491351,
// 33690276089). `fd` holds the raw HANDLE and `release` is `CloseHandle`.
//
// There is no XDG and no uid: the runtime directory is `%LOCALAPPDATA%\
// werk-poc` (per user, local to the machine) and the state directory sits
// beside it. The ownership and mode checks are skipped — Bun's `stat` reports
// a fixed mode and uid 0 on NTFS, so they could only ever refuse or chmod for
// nothing.
//
// The launcher cannot read the readiness pipe: the child does see fd 3, but
// `proc.stdio[3]` on the parent side is a raw HANDLE number that
// `fs.readSync`, `Bun.file` and `net.Socket({fd})` all refuse (win32-spike
// run 33688866439). So no fourth slot is passed and a file is named instead —
// `--ready-file=<dir>\wp.ready.<pid>` — which the daemon writes its report to
// (write to a temp name, rename) and the launcher polls. Same contract:
// best-effort, "" on timeout, the socket poll is still the authority. The
// spawn itself is `detached` + `windowsHide` with a real directory as cwd,
// since `/` is not one.
//
// Nothing here registers a signal handler. Bun's signal handlers ride on
// console control events, and a daemon spawned detached has no console, so
// none of them could ever fire; `proc.kill()` from a launcher or a test is
// `TerminateProcess`, which no handler sees either. Shutdown is the
// `shutdown` message over the socket, and only that.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dlopen, FFIType, ptr } from "bun:ffi";
import type {
  DaemonStart,
  FileLock,
  Platform,
  SpawnDaemonOptions,
} from "./index.ts";

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
 * A lock with no ffi in it: a named-pipe server whose name is derived from
 * the lock path. libuv creates the first instance with
 * FILE_FLAG_FIRST_PIPE_INSTANCE, so a second `Bun.listen` on the same name
 * fails while the first process lives, and the kernel drops the name with
 * the process — the same two properties flock gives. Nothing ever connects
 * to it. Pipe names are machine-wide, hence the hash of the (case-folded)
 * path, and `fd` is -1 because there is no handle to hand out.
 */
function lockPipe(file: string): FileLock | null {
  const name = `\\\\.\\pipe\\werk-poc-lock-${Bun.hash(file.toLowerCase())}`;
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

/**
 * Polls for the daemon's ready file until it appears, the daemon exits
 * without writing one, or `timeoutMs` passes. The file is removed once read.
 */
async function readReadyFile(
  file: string,
  proc: { exitCode: number | null },
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let text: string | null = null;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {}
    if (text !== null) {
      try {
        fs.unlinkSync(file);
      } catch {}
      return text;
    }
    // Exited without reporting: nothing more will come.
    if (proc.exitCode !== null) return "";
    await Bun.sleep(5);
  }
  return "";
}

export const win32: Platform = {
  id: "win32",

  runtimeDir(): string {
    return path.join(process.env.LOCALAPPDATA ?? os.tmpdir(), "werk-poc");
  },

  stateDir(): string {
    return path.join(
      process.env.LOCALAPPDATA ?? os.homedir(),
      "werk-poc",
      "state",
    );
  },

  /** NTFS has no uid or mode bits to check; %LOCALAPPDATA% is already per user. */
  checkRuntimeDir(): void {},

  /**
   * `LockFileEx` through `bun:ffi` where ffi exists; where it does not —
   * Bun's win32-arm64 build has TinyCC disabled and `dlopen` throws — a named
   * pipe stands in for the lock. `WP_WIN32_LOCK=pipe` forces the fallback so
   * a runner with ffi can still exercise it.
   */
  lock(file: string): FileLock | null {
    let k: NonNullable<typeof kernel32>["symbols"];
    try {
      if (process.env.WP_WIN32_LOCK === "pipe") throw new Error("forced");
      k = loadKernel32().symbols;
    } catch {
      return lockPipe(file);
    }
    const name = Buffer.from(file + "\0", "utf16le");
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
        `cannot open ${file} for LockFileEx: Windows error ${k.GetLastError()}`,
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
  },

  async spawnDaemon(opts: SpawnDaemonOptions): Promise<DaemonStart> {
    const readyFile = path.join(opts.dir, `wp.ready.${process.pid}`);
    try {
      fs.unlinkSync(readyFile);
    } catch {}
    const proc = Bun.spawn(
      opts.argv([`--dir=${opts.dir}`, `--ready-file=${readyFile}`]),
      {
        detached: true,
        windowsHide: true,
        cwd: os.homedir(),
        env: process.env as Record<string, string>,
        stdio: ["ignore", "ignore", "ignore"],
      },
    );
    const report = await readReadyFile(readyFile, proc, opts.readyTimeoutMs);
    proc.unref();
    return { pid: proc.pid, report, exitCode: () => proc.exitCode };
  },

  /**
   * No pipe to have carried the failure: say what the process and its log can
   * say instead.
   */
  readinessDetail(started: DaemonStart, logFile: string): string {
    const code = started.exitCode();
    let tail = "";
    try {
      tail = fs
        .readFileSync(logFile, "utf8")
        .trimEnd()
        .split("\n")
        .slice(-5)
        .join("\n  ");
    } catch {}
    return ` (daemon pid ${started.pid} ${code === null || code === undefined ? "still running" : `exited ${code}`}; ${tail ? `log tail:\n  ${tail}` : "no log written"})`;
  },

  /**
   * A Winsock AF_UNIX socket is a reparse-point file that `stat` and
   * `existsSync` cannot see (EACCES) and that a killed daemon leaves behind,
   * refusing the next bind. The lock says this daemon is the only one, so
   * whatever sits at the final path is stale: unlink it and let the rename
   * put the new one in place. (spike/win32-daemon)
   */
  clearStaleSocket(file: string): void {
    try {
      fs.unlinkSync(file);
    } catch {}
  },

  /** No mode bits on the reparse point; %LOCALAPPDATA% is per user already. */
  restrictSocket(): void {},

  /** Unmeasured; the kernel's own figure stands. */
  defaultSocketBufferBytes(): number | null {
    return null;
  },

  setSocketBuffers(): string {
    throw new Error("setsockopt is not wired up on windows");
  },

  /**
   * Windows has no zombies: once the process object reports an exit code,
   * libuv's kill(pid, 0) already says ESRCH (spike/win32-daemon).
   */
  isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
    } catch {
      return false;
    }
    return true;
  },

  /** No /proc and no `ps` worth asking; libuv's own figure is the working set. */
  rss(pid: number): number | null {
    return pid === process.pid ? process.memoryUsage().rss : null;
  },

  /** No sysctl and no /proc/cpuinfo; libuv's own list is what there is. */
  cpuModel(): string {
    return os.cpus()[0]?.model ?? "?";
  },

  /** Nothing to register; see the note at the top of this file. */
  onShutdownSignal(): void {},
};
