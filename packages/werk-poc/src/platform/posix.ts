// The POSIX half of the seam: Linux and macOS.
//
// The lock is `flock(2)` on the lock file. Bun has no flock API of its own
// (`fs` exposes nothing, `Bun.file` has no lock), but `bun:ffi` can dlopen
// libc and call it directly, and that works inside a compiled binary too
// because the library is resolved at run time. The kernel releases the lock
// when the holder dies, which is the whole reason to prefer it over a PID
// file.
//
// The socket buffer numbers are XNU's. A unix stream socket gets 8 KiB each
// way there (`net.local.stream.sendspace`) against Linux's 208 KiB, and it is
// the sender's SO_SNDBUF on the accepted socket that bounds how much the
// daemon can write before a short write — so a slow client on macOS trips the
// queue bound after about 8 KB where Linux manages about 218 KB. Accepted
// sockets inherit the listener's buffers and `Bun.listen` exposes the
// listener's fd, so one setsockopt(2) before the first accept is enough.
// Best effort: a failure is logged by the caller, not fatal.
//
// A kill goes to the child's process group rather than to the child, so a
// shell's own children go with it. The child leads that group because the
// inline `terminal` makes it a session leader; where it does not, the signal
// goes to the child alone rather than to a group it did not create.
//
// The daemon is spawned `detached` (setsid) with stdio on /dev/null, plus one
// extra `"pipe"` slot that the child sees as fd 3. The daemon writes its
// readiness report to it and closes it. That pipe is an optimisation and an
// error channel — it lets the launcher learn a lock-held failure immediately
// and, on the happy path, learn readiness in one round trip rather than by
// polling. It is not the source of truth: a `hello` over the socket is
// (findings/m2.md).

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
} from "./index.ts";

const LOCK_EX = 2;
const LOCK_NB = 4;

// XNU's values. Linux spells the same three 1, 7 and 8, so these are wrong
// there — `setSocketBuffers` is only reached on darwin by
// `defaultSocketBufferBytes()`, but `WP_SNDBUF=<n>` reaches it on Linux too,
// where `setsockopt` refuses the option and the daemon logs "socket buffers
// left at default" instead of doing what was asked. A Linux row for these
// three is what that wants.
const SOL_SOCKET = 0xffff;
const SO_SNDBUF = 0x1001;
const SO_RCVBUF = 0x1002;

/** Linux's default `net.core.wmem_default`, the figure the finding compares against. */
const DARWIN_SOCKET_BUFFER_BYTES = 212992;

const DARWIN = process.platform === "darwin";

/** Where libc lives, most likely name first. */
const LIBC_CANDIDATES = DARWIN
  ? ["libSystem.B.dylib", "libc.dylib"]
  : ["libc.so.6", "libc.so"];

function dlopenLibc(what: string, symbols: Parameters<typeof dlopen>[1]) {
  let last: unknown;
  for (const name of LIBC_CANDIDATES) {
    try {
      return dlopen(name, symbols);
    } catch (e) {
      last = e;
    }
  }
  throw new Error(`cannot dlopen libc for ${what}: ${String(last)}`);
}

let flockLib: {
  symbols: { flock: (fd: number, op: number) => number };
} | null = null;

function loadFlock() {
  if (!flockLib)
    flockLib = dlopenLibc("flock", {
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    }) as unknown as typeof flockLib;
  return flockLib!;
}

let sockLib: {
  symbols: {
    setsockopt: (
      fd: number,
      level: number,
      name: number,
      val: number,
      len: number,
    ) => number;
    getsockopt: (
      fd: number,
      level: number,
      name: number,
      val: number,
      len: number,
    ) => number;
  };
} | null = null;

function loadSockopt() {
  if (!sockLib)
    sockLib = dlopenLibc("setsockopt", {
      setsockopt: {
        args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.u32],
        returns: FFIType.i32,
      },
      getsockopt: {
        args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr],
        returns: FFIType.i32,
      },
    }) as unknown as typeof sockLib;
  return sockLib!;
}

function getBuf(fd: number, name: number): number {
  const val = new Int32Array(1);
  const len = new Uint32Array([4]);
  const rc = loadSockopt().symbols.getsockopt(
    fd,
    SOL_SOCKET,
    name,
    ptr(val),
    ptr(len),
  );
  return rc === 0 ? val[0]! : -1;
}

/**
 * The process group `pid` leads, or null when it leads none. A session's
 * child is spawned with an inline `terminal`, which on Bun 1.3.14 makes it a
 * session leader with the PTY as its controlling terminal (findings/m2.md),
 * so its pgid is its own pid and the group is everything it started that has
 * not moved itself out of it. Anything else — a child that called `setpgid`,
 * a Bun that stopped calling `setsid` — reads as "leads no group", and the
 * kill goes to the child alone rather than to whatever group it landed in.
 */
function leadsGroup(pid: number): boolean {
  try {
    const pgid = DARWIN
      ? Number(psField(pid, "pgid"))
      : Number(
          fs
            .readFileSync(`/proc/${pid}/stat`, "utf8")
            .split(") ")
            .pop()
            ?.split(" ")[2],
        );
    return Number.isFinite(pgid) && pgid === pid;
  } catch {
    return false;
  }
}

/** The POSIX signal a mode asks for. */
function signalFor(mode: "interrupt" | "terminate" | "force"): string {
  return mode === "interrupt"
    ? "SIGINT"
    : mode === "force"
      ? "SIGKILL"
      : "SIGTERM";
}

/** One `ps` field for one pid, empty when the process is gone. macOS has no /proc. */
function psField(pid: number, keyword: string): string {
  return Bun.spawnSync(["ps", "-o", `${keyword}=`, "-p", String(pid)])
    .stdout.toString()
    .trim();
}

/**
 * Reads the readiness pipe to EOF or until `timeoutMs` passes, with plain
 * `fs.readSync` on the non-blocking fd (EAGAIN → wait a few ms → again).
 * The fd is deliberately never closed here: Bun's `Subprocess` owns it and
 * closes it when the subprocess object is collected, and closing it first
 * lets the number be reused by the next socket, which Bun's later close
 * then kills without the socket's owner hearing about it. That was the
 * mechanism behind M2's "a later Bun.connect client in the same process
 * breaks" (spikes/m3/fd-reuse.ts, findings/m3.md).
 */
async function readPipe(fd: number, timeoutMs: number): Promise<string> {
  const buf = Buffer.alloc(4096);
  const chunks: Buffer[] = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let n: number;
    try {
      n = fs.readSync(fd, buf, 0, buf.length, null);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EAGAIN") {
        await Bun.sleep(5);
        continue;
      }
      throw e;
    }
    if (n === 0) return Buffer.concat(chunks).toString("utf8");
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return "";
}

export const posix: Platform = {
  id: "posix",

  signalsExits: true,

  runtimeDir(): string {
    return path.join(os.tmpdir(), `werk-poc-${process.getuid?.() ?? "0"}`);
  },

  stateDir(): string {
    return path.join(os.homedir(), ".local", "state", "werk-poc");
  },

  /**
   * Refuses a runtime directory owned by someone else, so a pre-created
   * `/tmp/werk-poc-1000` cannot hand our sessions to another local user.
   */
  checkRuntimeDir(dir: string): void {
    const st = fs.statSync(dir);
    const uid = process.getuid?.();
    if (uid !== undefined && st.uid !== uid) {
      throw new Error(
        `${dir} is owned by uid ${st.uid}, not ${uid}; refusing to use it`,
      );
    }
    if ((st.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
  },

  lock(file: string): FileLock | null {
    const fd = fs.openSync(file, "w");
    const r = loadFlock().symbols.flock(fd, LOCK_EX | LOCK_NB);
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
  },

  async spawnDaemon(opts: SpawnDaemonOptions): Promise<DaemonStart> {
    const proc = Bun.spawn(opts.argv([`--dir=${opts.dir}`, "--ready-fd=3"]), {
      detached: true,
      cwd: "/",
      env: process.env as Record<string, string>,
      stdio: ["ignore", "ignore", "ignore", "pipe"],
    });
    const fd = proc.stdio[3];
    if (typeof fd !== "number")
      throw new Error("Bun.spawn gave no fd for stdio[3]");
    const report = await readPipe(fd, opts.readyTimeoutMs);
    proc.unref();
    return { pid: proc.pid, report, exitCode: () => proc.exitCode };
  },

  /** The pipe already carried the reason, so there is nothing to add. */
  readinessDetail(): string {
    return "";
  },

  /**
   * Nothing to do: the bind goes to a temporary name and `rename(2)` replaces
   * whatever a dead daemon left behind, atomically.
   */
  clearStaleSocket(): void {},

  restrictSocket(file: string): void {
    fs.chmodSync(file, 0o600);
  },

  defaultSocketBufferBytes(): number | null {
    return DARWIN && DARWIN_SOCKET_BUFFER_BYTES > 0
      ? DARWIN_SOCKET_BUFFER_BYTES
      : null;
  },

  setSocketBuffers(fd: number, bytes: number): string {
    const lib = loadSockopt();
    const val = new Int32Array([bytes]);
    for (const [label, name] of [
      ["SO_SNDBUF", SO_SNDBUF],
      ["SO_RCVBUF", SO_RCVBUF],
    ] as const) {
      if (lib.symbols.setsockopt(fd, SOL_SOCKET, name, ptr(val), 4) !== 0)
        throw new Error(`setsockopt(${label}, ${bytes}) failed`);
    }
    return `sndbuf=${getBuf(fd, SO_SNDBUF)} rcvbuf=${getBuf(fd, SO_RCVBUF)}`;
  },

  isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
    } catch {
      return false;
    }
    try {
      // A zombie still answers signal 0. macOS has no /proc, so its STAT
      // column from `ps` is the only place the state shows up.
      if (DARWIN) return !psField(pid, "state").startsWith("Z");
      return !/\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
    } catch {
      return false;
    }
  },

  rss(pid: number): number | null {
    if (DARWIN) {
      // `ps -o rss=` is in KiB, the same unit as VmRSS.
      const kb = Number(psField(pid, "rss"));
      return Number.isFinite(kb) && kb > 0 ? kb * 1024 : null;
    }
    try {
      const m = /VmRSS:\s+(\d+) kB/.exec(
        fs.readFileSync(`/proc/${pid}/status`, "utf8"),
      );
      return m ? Number(m[1]) * 1024 : null;
    } catch {
      return null;
    }
  },

  cpuModel(): string {
    if (DARWIN) {
      const brand = Bun.spawnSync(["sysctl", "-n", "machdep.cpu.brand_string"])
        .stdout.toString()
        .trim();
      return brand || (os.cpus()[0]?.model ?? "?");
    }
    try {
      const m = /model name\s*:\s*(.+)/.exec(
        fs.readFileSync("/proc/cpuinfo", "utf8"),
      );
      return m ? m[1]!.trim() : (os.cpus()[0]?.model ?? "?");
    } catch {
      return os.cpus()[0]?.model ?? "?";
    }
  },

  /**
   * Each of these ends in the same graceful shutdown, snapshots included.
   * They are delivered to the detached daemon (setsid, no tty) as to any
   * process; the M3 tests send a real SIGTERM to the pid and check the files.
   */
  onShutdownSignal(handler: (reason: string) => void): void {
    for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
      process.on(sig, () => handler(sig));
    }
  },

  /**
   * The tree is the child's process group, which it leads. `kill(-pgid, sig)`
   * reaches everything in it, so a shell's children go with the shell; a
   * child that has moved itself into someone else's group is signalled
   * alone, because signalling that group would reach processes this session
   * never started.
   */
  adoptTree(child: SessionChild): ProcessTree {
    const send = (
      mode: "interrupt" | "terminate" | "force",
      signal?: string,
    ): KillOutcome => {
      const sig = (signal ?? signalFor(mode)) as NodeJS.Signals;
      if (leadsGroup(child.pid)) {
        try {
          process.kill(-child.pid, sig);
          return { delivery: "group-signal", signal: sig };
        } catch {
          // ESRCH: the group went between the check and the signal.
        }
      }
      child.kill(sig);
      return { delivery: "signal", signal: sig };
    };
    return {
      holds: "group",
      interrupt: (signal) => send("interrupt", signal),
      kill: (mode, signal) => send(mode, signal),
      close: () => {},
    };
  },

  terminate(pid: number): void {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  },
};
