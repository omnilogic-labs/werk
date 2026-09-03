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
// `shutdown` message over the socket, or a `stop` written to the stop pipe:
// a `\\.\pipe\` name derived from the lock path that the daemon listens on
// for as long as it runs (`listenForStop`), which anything on the machine
// that can open a pipe can reach without a `wp` or a `hello` — the nearest
// thing a console-less process has to a `kill` typed at a shell. A bare
// connect does nothing; the word is required so a tool enumerating pipes
// cannot stop the daemon by opening it.
//
// A session's child is held in a Job Object with `KILL_ON_JOB_CLOSE`, which
// is what makes a kill take the tree rather than the one process Bun knows
// about. That, the lock, and nothing else needs `bun:ffi` here, and each
// falls back where there is none.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dlopen, FFIType, ptr } from "bun:ffi";

import type {
  DaemonStart,
  FileLock,
  Platform,
  KillOutcome,
  ProcessTree,
  SessionChild,
  SpawnDaemonOptions,
  StopListener,
} from "./index.ts";

const LOCKFILE_FAIL_IMMEDIATELY = 1;
const LOCKFILE_EXCLUSIVE_LOCK = 2;
const FILE_GENERIC_READ = 0x120089;
const FILE_GENERIC_WRITE = 0x120116;
const FILE_SHARE_READ_WRITE_DELETE = 1 | 2 | 4;
const OPEN_ALWAYS = 4;
const FILE_ATTRIBUTE_NORMAL = 0x80;
const INVALID_HANDLE_VALUE = (1n << 64n) - 1n;

const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const JobObjectExtendedLimitInformation = 9;
/** `JOBOBJECT_EXTENDED_LIMIT_INFORMATION` on LLP64: 144 bytes, `LimitFlags` at 16. */
const EXTENDED_LIMIT_BYTES = 144;
const LIMIT_FLAGS_OFFSET = 16;
const PROCESS_TERMINATE = 0x0001;
const PROCESS_SET_QUOTA = 0x0100;
/** What `TerminateJobObject` gives the tree, and what Bun's own kill uses. */
const KILLED_EXIT_CODE = 1;
/** ^C, the only interrupt a ConPTY child can be sent. */
const ETX = new Uint8Array([0x03]);

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
    CreateJobObjectW: (sa: null, name: null) => bigint;
    SetInformationJobObject: (
      job: bigint,
      cls: number,
      info: ReturnType<typeof ptr>,
      len: number,
    ) => number;
    AssignProcessToJobObject: (job: bigint, proc: bigint) => number;
    TerminateJobObject: (job: bigint, code: number) => number;
    OpenProcess: (access: number, inherit: number, pid: number) => bigint;
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
    CreateJobObjectW: {
      args: [FFIType.ptr, FFIType.ptr],
      returns: FFIType.u64,
    },
    SetInformationJobObject: {
      args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.u32],
      returns: FFIType.i32,
    },
    AssignProcessToJobObject: {
      args: [FFIType.u64, FFIType.u64],
      returns: FFIType.i32,
    },
    TerminateJobObject: {
      args: [FFIType.u64, FFIType.u32],
      returns: FFIType.i32,
    },
    OpenProcess: {
      args: [FFIType.u32, FFIType.i32, FFIType.u32],
      returns: FFIType.u64,
    },
  }) as unknown as typeof kernel32;
  return kernel32!;
}

/**
 * A Job Object holding one session's child, with `KILL_ON_JOB_CLOSE` set so
 * that whatever the child starts goes when the job does — including when the
 * daemon dies without getting to run any code. Job membership is inherited,
 * so assigning the child before it spawns anything is enough to hold the
 * whole tree; the daemon does that as soon as `Bun.spawn` returns. Nesting
 * works: a runner (and any service manager) already has the daemon in a job
 * of its own, and the assign still succeeds (run 33704743713).
 *
 * Null when there is no `bun:ffi` — Bun 1.3.14 on `win32-arm64` has none —
 * or when any of the three calls fails. The caller then kills the child
 * alone, and a grandchild that has detached itself from the ConPTY survives.
 */
function createJob(pid: number): bigint | null {
  let k: NonNullable<typeof kernel32>["symbols"];
  try {
    if (process.env.WP_WIN32_JOB === "off") throw new Error("forced");
    k = loadKernel32().symbols;
  } catch {
    return null;
  }
  const job = k.CreateJobObjectW(null, null);
  if (job === INVALID_HANDLE_VALUE || job === 0n) return null;
  const info = new Uint8Array(EXTENDED_LIMIT_BYTES);
  new DataView(info.buffer).setUint32(
    LIMIT_FLAGS_OFFSET,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    true,
  );
  if (
    k.SetInformationJobObject(
      job,
      JobObjectExtendedLimitInformation,
      ptr(info),
      EXTENDED_LIMIT_BYTES,
    ) === 0
  ) {
    k.CloseHandle(job);
    return null;
  }
  // PROCESS_SET_QUOTA and PROCESS_TERMINATE are what AssignProcessToJobObject
  // asks for; nothing here needs more.
  const h = k.OpenProcess(PROCESS_TERMINATE | PROCESS_SET_QUOTA, 0, pid);
  if (h === INVALID_HANDLE_VALUE || h === 0n) {
    k.CloseHandle(job);
    return null;
  }
  const assigned = k.AssignProcessToJobObject(job, h) !== 0;
  k.CloseHandle(h);
  if (!assigned) {
    k.CloseHandle(job);
    return null;
  }
  return job;
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

/** The stop pipe's name for the daemon holding `lock`; machine-wide, hence the hash. */
function stopPipeName(lock: string): string {
  return `\\\\.\\pipe\\werk-poc-stop-${Bun.hash(lock.toLowerCase())}`;
}

/** What the daemon logs, and what `requestStop` resolves to, for a stop over `name`. */
const stopReason = (name: string) => `stop request on ${name}`;

/** The word a requester writes; anything else closes the connection and does nothing. */
const STOP_WORD = "stop";

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

  /**
   * Windows has no signals. Bun echoes back the name passed to
   * `proc.kill()` — `signalCode=SIGTERM` for a `TerminateProcess` (run
   * 33704743713) — so a signal name here would say what was asked for and
   * nothing about what happened, and the daemon reports none.
   */
  signalsExits: false,

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

  /**
   * The stop pipe: `Bun.listen` on a `\\.\pipe\` name, the same call the
   * pipe lock uses and needing no ffi, so it is the same on both Windows
   * builds. The first chunk that begins with `stop` is the request; the
   * handler runs once, and every later connection is closed unanswered.
   */
  listenForStop(
    lock: string,
    handler: (reason: string) => void,
  ): StopListener | null {
    const name = stopPipeName(lock);
    let asked = false;
    const listener = Bun.listen({
      unix: name,
      socket: {
        open() {},
        data(socket, chunk) {
          const word = new TextDecoder().decode(chunk).trim();
          try {
            socket.end();
          } catch {}
          if (asked || !word.startsWith(STOP_WORD)) return;
          asked = true;
          handler(stopReason(name));
        },
        error() {},
      },
    });
    return {
      name,
      close() {
        try {
          listener.stop(true);
        } catch {}
      },
    };
  },

  /**
   * Opens the daemon's stop pipe and writes the word. Resolves once the
   * daemon has closed the connection, which it does on reading the request;
   * rejects when nothing is listening on the name.
   */
  requestStop(_pid: number, lock: string): Promise<string> {
    const name = stopPipeName(lock);
    return new Promise<string>((resolve, reject) => {
      Bun.connect({
        unix: name,
        socket: {
          open(socket) {
            socket.write(`${STOP_WORD}\n`);
          },
          data() {},
          close() {
            resolve(stopReason(name));
          },
          error(_socket, e) {
            reject(e);
          },
          connectError(_socket, e) {
            reject(e);
          },
        },
      }).catch(reject);
    });
  },

  /**
   * The tree is a Job Object with `KILL_ON_JOB_CLOSE`, which
   * `TerminateJobObject` ends in about 2 ms, grandchildren included (run
   * 33704743713). An interrupt is `0x03` into the ConPTY, since there is no
   * signal to send: `sleep` dies of it and `pwsh -c Start-Sleep` ignores it
   * for at least six seconds (run 33691536664), so what an interrupt means
   * is the child's to decide.
   *
   * Where the job could not be made — no `bun:ffi` on `win32-arm64` — the
   * kill is `TerminateProcess` on the child alone, which is what Bun's own
   * `proc.kill()` does. What that loses is the tree: a grandchild that has
   * left the ConPTY behind keeps running with nothing holding it.
   */
  adoptTree(child: SessionChild): ProcessTree {
    let job = createJob(child.pid);
    const kill = (): KillOutcome => {
      if (job !== null) {
        try {
          if (
            loadKernel32().symbols.TerminateJobObject(job, KILLED_EXIT_CODE) !==
            0
          )
            return { delivery: "job", signal: null };
        } catch {}
      }
      child.kill();
      return { delivery: "terminate", signal: null };
    };
    return {
      holds: job !== null ? "job" : "child",
      interrupt() {
        child.writePty(ETX);
        return { delivery: "pty-interrupt", signal: null };
      },
      kill,
      close() {
        if (job === null) return;
        // The last handle to a KILL_ON_JOB_CLOSE job takes the tree with it,
        // which is what a disposing session wants anyway.
        try {
          loadKernel32().symbols.CloseHandle(job);
        } catch {}
        job = null;
      },
    };
  },

  terminate(pid: number): void {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  },
};
