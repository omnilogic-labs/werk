// Probes for the `spike/win32-daemon` experiment: the primitives the daemon
// layer would need on Windows, each measured on a real runner before any of
// `src/daemon` is ported. Same style as windows-probes.ts: one
// `PROBE <name>: <verdict>` line per question, and nothing here throws.
//
//   bun run .github/ci/win32-spike-probes.ts [probe...]
//
// Every probe runs in a subprocess of its own (`role:run <probe>`), so a
// probe that takes the process down — an ffi call gone wrong, say — is
// reported by its exit code and the next one still runs. The child roles
// (`role:<name>`) are the other halves of the multi-process probes. The
// file re-invokes itself, so it must be run from source under `bun run`.

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { dlopen, FFIType, ptr, type Pointer } from "bun:ffi";

const ALL_PROBES = [
  "ffi-basic",
  "socket-file",
  "lockfileex",
  "stdio3",
  "handshake",
  "conpty-orphan",
  "ctrl-c",
  "kill-detached",
  "misc",
  "compiled-paths",
  "flock-port",
  "crt-osfhandle",
];

const argv = process.argv.slice(2);
const role = argv[0]?.startsWith("role:") ? argv[0].slice(5) : null;

/** Written synchronously so a later crash cannot swallow an earlier verdict. */
function say(name: string, verdict: string): void {
  const line = `PROBE ${name}: ${verdict}\n`;
  try {
    fs.writeSync(1, line);
  } catch {
    console.log(line.trimEnd());
  }
}

function firstLine(e: unknown): string {
  const s = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return s.split("\n")[0]!.trim();
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean, ms: number, step = 20) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(step);
  }
  return pred();
}

const self = (r: string, ...rest: string[]) => [
  process.execPath,
  "run",
  import.meta.path,
  `role:${r}`,
  ...rest,
];

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function tickCount(dir: string): number {
  try {
    return fs.readFileSync(path.join(dir, "ticks"), "utf8").split("\n").length;
  } catch {
    return 0;
  }
}

// ------------------------------------------------------------------ ffi
// Loaded lazily so a failure to dlopen is a verdict rather than a crash.
// `WP_PROBE_FFI=0` (set by the runner when ffi-basic died) turns every ffi
// reading into "n/a" so the rest of a probe still reports.
const ffiAllowed = process.env.WP_PROBE_FFI !== "0";
type K32 = {
  LockFileEx: (
    h: bigint,
    flags: number,
    reserved: number,
    lo: number,
    hi: number,
    ov: Pointer,
  ) => number;
  UnlockFileEx: (
    h: bigint,
    reserved: number,
    lo: number,
    hi: number,
    ov: Pointer,
  ) => number;
  GetLastError: () => number;
  GetCurrentProcess: () => bigint;
  OpenProcess: (access: number, inherit: number, pid: number) => bigint;
  GetExitCodeProcess: (h: bigint, out: Pointer) => number;
  CloseHandle: (h: bigint) => number;
  GetFileType: (h: bigint) => number;
  CreateFileW: (
    name: Pointer,
    access: number,
    share: number,
    sa: Pointer | null,
    disposition: number,
    flags: number,
    template: bigint,
  ) => bigint;
};
type CRT = {
  _get_osfhandle: (fd: number) => bigint;
  _open_osfhandle: (h: bigint, flags: number) => number;
};
let k32: K32 | null = null;
let crt: CRT | null = null;
function kernel32(): K32 {
  if (k32) return k32;
  const lib = dlopen("kernel32.dll", {
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
    UnlockFileEx: {
      args: [FFIType.u64, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr],
      returns: FFIType.i32,
    },
    GetLastError: { args: [], returns: FFIType.u32 },
    GetCurrentProcess: { args: [], returns: FFIType.u64 },
    OpenProcess: {
      args: [FFIType.u32, FFIType.i32, FFIType.u32],
      returns: FFIType.u64,
    },
    GetExitCodeProcess: {
      args: [FFIType.u64, FFIType.ptr],
      returns: FFIType.i32,
    },
    CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
    GetFileType: { args: [FFIType.u64], returns: FFIType.u32 },
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
  });
  k32 = lib.symbols as unknown as K32;
  return k32;
}
function ucrt(): CRT {
  if (crt) return crt;
  const lib = dlopen("ucrtbase.dll", {
    _get_osfhandle: { args: [FFIType.i32], returns: FFIType.i64 },
    _open_osfhandle: { args: [FFIType.i64, FFIType.i32], returns: FFIType.i32 },
  });
  crt = lib.symbols as unknown as CRT;
  return crt;
}
const INVALID_HANDLE = (1n << 64n) - 1n;
const isInvalid = (h: bigint) => h === INVALID_HANDLE || h === -1n || h === 0n;
const LOCKFILE_FAIL_IMMEDIATELY = 1;
const LOCKFILE_EXCLUSIVE_LOCK = 2;

/** Try an exclusive non-blocking LockFileEx on `h`; returns [ok, lastError]. */
function lockHandle(h: bigint): [boolean, number] {
  const ov = new Uint8Array(32);
  const r = kernel32().LockFileEx(
    h,
    LOCKFILE_FAIL_IMMEDIATELY | LOCKFILE_EXCLUSIVE_LOCK,
    0,
    1,
    0,
    ptr(ov),
  );
  return [r !== 0, r !== 0 ? 0 : kernel32().GetLastError()];
}

function openHandle(p: string): bigint {
  const name = Buffer.from(p + "\0", "utf16le");
  // FILE_GENERIC_READ | FILE_GENERIC_WRITE: the same rights as
  // GENERIC_READ | GENERIC_WRITE but below 2^31. `0x80000000 | 0x40000000`
  // in JavaScript is the negative int32 -1073741824, and a negative number
  // handed to a `u32` ffi argument arrives as 0 (see ffi-u32 in ffi-basic):
  // every handle in runs 33689491351 and 33690276089 had no data access,
  // which is why LockFileEx said ACCESS_DENIED and a no-share open excluded
  // nothing.
  const FILE_GENERIC_READ = 0x120089;
  const FILE_GENERIC_WRITE = 0x120116;
  const FILE_SHARE_ALL = 1 | 2 | 4;
  const OPEN_ALWAYS = 4;
  const FILE_ATTRIBUTE_NORMAL = 0x80;
  return kernel32().CreateFileW(
    ptr(name),
    FILE_GENERIC_READ | FILE_GENERIC_WRITE,
    FILE_SHARE_ALL,
    null,
    OPEN_ALWAYS,
    FILE_ATTRIBUTE_NORMAL,
    0n,
  );
}

/** Raw exit code from the kernel, via a handle opened while the process lived. */
function rawExitCode(h: bigint): number | null {
  if (!ffiAllowed || isInvalid(h)) return null;
  try {
    const out = new Uint32Array(1);
    const r = kernel32().GetExitCodeProcess(h, ptr(out));
    return r !== 0 ? out[0]! : null;
  } catch {
    return null;
  }
}
function openProcess(pid: number): bigint {
  if (!ffiAllowed) return 0n;
  try {
    const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    return kernel32().OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
  } catch {
    return 0n;
  }
}
function closeHandle(h: bigint): void {
  if (!ffiAllowed || isInvalid(h)) return;
  try {
    kernel32().CloseHandle(h);
  } catch {}
}
const hex = (n: number | null) =>
  n === null ? "n/a" : `0x${n.toString(16).toUpperCase()} (${n})`;

// Other ways of asking for the lock, for the matrix in the lockfileex probe.
type Alt = {
  SetLastError: (e: number) => void;
  GetLastError: () => number;
  LockFile: (
    h: bigint,
    oLo: number,
    oHi: number,
    lo: number,
    hi: number,
  ) => number;
  UnlockFile: (
    h: bigint,
    oLo: number,
    oHi: number,
    lo: number,
    hi: number,
  ) => number;
};
type AltPtr = {
  LockFileEx: (
    h: number,
    flags: number,
    reserved: number,
    lo: number,
    hi: number,
    ov: Pointer,
  ) => number;
  UnlockFileEx: (
    h: number,
    reserved: number,
    lo: number,
    hi: number,
    ov: Pointer,
  ) => number;
  GetLastError: () => number;
};
let alt: Alt | null = null;
let altPtr: AltPtr | null = null;
let altI32: AltPtr | null = null;
function altKernel32(): Alt {
  if (alt) return alt;
  alt = dlopen("kernel32.dll", {
    SetLastError: { args: [FFIType.u32], returns: FFIType.void },
    GetLastError: { args: [], returns: FFIType.u32 },
    LockFile: {
      args: [FFIType.u64, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.u32],
      returns: FFIType.i32,
    },
    UnlockFile: {
      args: [FFIType.u64, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.u32],
      returns: FFIType.i32,
    },
  }).symbols as unknown as Alt;
  return alt;
}
function handleAs(type: typeof FFIType.ptr | typeof FFIType.i32): AltPtr {
  const cached = type === FFIType.ptr ? altPtr : altI32;
  if (cached) return cached;
  const lib = dlopen("kernel32.dll", {
    LockFileEx: {
      args: [
        type,
        FFIType.u32,
        FFIType.u32,
        FFIType.u32,
        FFIType.u32,
        FFIType.ptr,
      ],
      returns: FFIType.i32,
    },
    UnlockFileEx: {
      args: [type, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr],
      returns: FFIType.i32,
    },
    GetLastError: { args: [], returns: FFIType.u32 },
  }).symbols as unknown as AltPtr;
  if (type === FFIType.ptr) altPtr = lib;
  else altI32 = lib;
  return lib;
}
type LockVariant = {
  name: string;
  lock: (h: bigint) => [boolean, number];
  unlock: (h: bigint) => number;
};
const LOCK_VARIANTS: LockVariant[] = [
  {
    name: "LockFileEx u64 handle, 1 byte",
    lock: (h) => {
      altKernel32().SetLastError(0);
      return lockHandle(h);
    },
    unlock: (h) => {
      const ov = new Uint8Array(32);
      return kernel32().UnlockFileEx(h, 0, 1, 0, ptr(ov));
    },
  },
  {
    name: "LockFile u64 handle (5 args)",
    lock: (h) => {
      const a = altKernel32();
      a.SetLastError(0);
      const r = a.LockFile(h, 0, 0, 1, 0);
      return [r !== 0, r !== 0 ? 0 : a.GetLastError()];
    },
    unlock: (h) => altKernel32().UnlockFile(h, 0, 0, 1, 0),
  },
  {
    name: "LockFileEx ptr handle",
    lock: (h) => {
      const a = handleAs(FFIType.ptr);
      altKernel32().SetLastError(0);
      const ov = new Uint8Array(32);
      const r = a.LockFileEx(Number(h), 3, 0, 1, 0, ptr(ov));
      return [r !== 0, r !== 0 ? 0 : a.GetLastError()];
    },
    unlock: (h) => {
      const ov = new Uint8Array(32);
      return handleAs(FFIType.ptr).UnlockFileEx(Number(h), 0, 1, 0, ptr(ov));
    },
  },
  {
    name: "LockFileEx i32 handle",
    lock: (h) => {
      const a = handleAs(FFIType.i32);
      altKernel32().SetLastError(0);
      const ov = new Uint8Array(32);
      const r = a.LockFileEx(Number(h), 3, 0, 1, 0, ptr(ov));
      return [r !== 0, r !== 0 ? 0 : a.GetLastError()];
    },
    unlock: (h) => {
      const ov = new Uint8Array(32);
      return handleAs(FFIType.i32).UnlockFileEx(Number(h), 0, 1, 0, ptr(ov));
    },
  },
  {
    name: "LockFileEx u64 handle, whole file, Buffer OVERLAPPED",
    lock: (h) => {
      altKernel32().SetLastError(0);
      const ov = Buffer.alloc(32);
      const r = kernel32().LockFileEx(h, 3, 0, 0xffffffff, 0x7fffffff, ptr(ov));
      return [r !== 0, r !== 0 ? 0 : kernel32().GetLastError()];
    },
    unlock: (h) => {
      const ov = Buffer.alloc(32);
      return kernel32().UnlockFileEx(h, 0, 0xffffffff, 0x7fffffff, ptr(ov));
    },
  },
];

/** CreateFileW sharing DELETE only: a second opener gets ERROR_SHARING_VIOLATION (32). */
function exclusiveOpen(p: string): bigint {
  const name = Buffer.from(p + "\0", "utf16le");
  // FILE_GENERIC_READ | FILE_GENERIC_WRITE: the same rights as
  // GENERIC_READ | GENERIC_WRITE but below 2^31. `0x80000000 | 0x40000000`
  // in JavaScript is the negative int32 -1073741824, and a negative number
  // handed to a `u32` ffi argument arrives as 0 (see ffi-u32 in ffi-basic):
  // every handle in runs 33689491351 and 33690276089 had no data access,
  // which is why LockFileEx said ACCESS_DENIED and a no-share open excluded
  // nothing.
  const FILE_GENERIC_READ = 0x120089;
  const FILE_GENERIC_WRITE = 0x120116;
  const FILE_SHARE_DELETE = 4;
  const OPEN_ALWAYS = 4;
  const FILE_ATTRIBUTE_NORMAL = 0x80;
  return kernel32().CreateFileW(
    ptr(name),
    FILE_GENERIC_READ | FILE_GENERIC_WRITE,
    FILE_SHARE_DELETE,
    null,
    OPEN_ALWAYS,
    FILE_ATTRIBUTE_NORMAL,
    0n,
  );
}

// ================================================================ roles
if (role && role !== "run") {
  const dir = process.env.WP_PROBE_DIR ?? os.tmpdir();
  const tick = () => {
    const t = setInterval(() => {
      try {
        fs.appendFileSync(path.join(dir, "ticks"), "tick\n");
      } catch {}
    }, 200);
    setTimeout(() => process.exit(0), 15_000).unref();
    return t;
  };
  switch (role) {
    case "lock-holder": {
      // Hold the lock on argv[1] through variant argv[2] until killed.
      const p = argv[1]!;
      const v = LOCK_VARIANTS[Number(argv[2] ?? 0)]!;
      const h = openHandle(p);
      const [ok, err] = v.lock(h);
      say("holder", ok ? "locked" : `refused err=${err}`);
      if (ok) await sleep(60_000);
      process.exit(ok ? 0 : 1);
    }
    case "lock-try": {
      const p = argv[1]!;
      const v = LOCK_VARIANTS[Number(argv[2] ?? 0)]!;
      const h = openHandle(p);
      const [ok, err] = v.lock(h);
      say("try", `${ok ? "locked" : "refused"} err=${err}`);
      kernel32().CloseHandle(h);
      process.exit(0);
    }
    case "xopen-holder": {
      const h = exclusiveOpen(argv[1]!);
      const ok = !isInvalid(h);
      say("holder", ok ? "opened" : `refused err=${kernel32().GetLastError()}`);
      if (ok) await sleep(60_000);
      process.exit(ok ? 0 : 1);
    }
    case "flock-try": {
      // Try the real lock (src/platform/win32.ts) on argv[1] and report.
      const { platform } =
        await import("../../packages/werk-poc/src/platform/index.ts");
      try {
        const l = platform.lock(argv[1]!);
        say("try", l ? `locked fd=${l.fd}` : "refused");
        if (argv[2] === "hold" && l) await sleep(60_000);
        l?.release();
      } catch (e) {
        say("try", `threw ${firstLine(e)}`);
      }
      process.exit(0);
    }
    case "xopen-try": {
      const h = exclusiveOpen(argv[1]!);
      const ok = !isInvalid(h);
      say("try", ok ? "opened" : `refused err=${kernel32().GetLastError()}`);
      if (ok) kernel32().CloseHandle(h);
      process.exit(0);
    }
    case "fd3-write": {
      let stat = "";
      try {
        const st = fs.fstatSync(3);
        stat = `fstat ok isFIFO=${st.isFIFO()} isFile=${st.isFile()}`;
      } catch (e) {
        stat = `fstat ${firstLine(e)}`;
      }
      try {
        fs.writeSync(3, "ready\n");
        fs.closeSync(3);
        say("child", `writeSync(3) ok; ${stat}`);
      } catch (e) {
        say("child", `writeSync(3) ${firstLine(e)}; ${stat}`);
      }
      process.exit(0);
    }
    case "fd3-net": {
      try {
        const s = new net.Socket({ fd: 3 } as net.SocketConstructorOpts);
        s.on("error", (e) => say("child", `net.Socket ${firstLine(e)}`));
        await new Promise<void>((r) => s.write("ready\n", () => r()));
        s.end();
        say("child", "net.Socket({fd:3}).write ok");
      } catch (e) {
        say("child", `net.Socket({fd:3}) ${firstLine(e)}`);
      }
      await sleep(100);
      process.exit(0);
    }
    case "hs-child": {
      // Connect to the parent's listener, say ready, then keep ticking.
      tick();
      const sock = process.env.WP_PROBE_SOCK!;
      try {
        await Bun.connect({
          unix: sock,
          socket: {
            open(s) {
              s.write(`ready ${process.pid}\n`);
            },
            data() {},
            error() {},
          },
        });
      } catch (e) {
        fs.writeFileSync(path.join(dir, "hs-error"), firstLine(e));
      }
      await sleep(15_000);
      process.exit(0);
    }
    case "hs-parent": {
      // Listen, spawn the detached child, wait for its ready, exit.
      const sock = path.join(dir, "hs.sock");
      let ready = "";
      Bun.listen<undefined>({
        unix: sock,
        socket: {
          open() {},
          data(_s, chunk) {
            ready += new TextDecoder().decode(chunk);
          },
          error() {},
        },
      });
      const child = Bun.spawn(self("hs-child"), {
        detached: true,
        windowsHide: true,
        stdio: ["ignore", "ignore", "ignore"],
        cwd: os.homedir(),
        env: { ...process.env, WP_PROBE_SOCK: sock, WP_PROBE_DIR: dir },
      });
      child.unref();
      const got = await waitFor(() => ready.includes("\n"), 5000);
      if (argv[1] === "hold") {
        console.log(`READY pid=${child.pid} got=${got} holding`);
        await sleep(30_000);
      }
      console.log(`READY pid=${child.pid} got=${got} ${JSON.stringify(ready)}`);
      process.exit(0);
    }
    case "sig-child": {
      tick();
      fs.writeFileSync(path.join(dir, "alive"), String(process.pid));
      for (const sig of ["SIGTERM", "SIGINT", "SIGHUP", "SIGBREAK"] as const) {
        try {
          process.on(sig, () => {
            fs.appendFileSync(path.join(dir, "signals"), `${sig}\n`);
            setTimeout(() => process.exit(0), 50);
          });
        } catch (e) {
          fs.appendFileSync(
            path.join(dir, "signals"),
            `install ${sig}: ${firstLine(e)}\n`,
          );
        }
      }
      await sleep(30_000);
      process.exit(0);
    }
    default:
      console.log(`unknown role ${role}`);
      process.exit(2);
  }
}

// ============================================================== runner
if (!role) {
  console.log(
    `platform=${process.platform} arch=${process.arch} bun=${Bun.version} release=${os.release()} tmp=${os.tmpdir()}`,
  );
  const selected = argv.length ? argv : ALL_PROBES;
  let ffi = "1";
  for (const name of selected) {
    const t0 = performance.now();
    let out = "";
    let err = "";
    let code: number | null = null;
    let signal: string | null = null;
    try {
      const proc = Bun.spawn(self("run", name), {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, WP_PROBE_FFI: ffi },
      });
      const finished = await Promise.race([
        proc.exited.then(() => true),
        sleep(120_000).then(() => false),
      ]);
      if (!finished) proc.kill("SIGKILL");
      await proc.exited;
      out = await new Response(proc.stdout).text();
      err = await new Response(proc.stderr).text();
      code = proc.exitCode;
      signal = proc.signalCode;
      if (!finished) err = `killed after 120 s\n${err}`;
    } catch (e) {
      err = firstLine(e);
    }
    process.stdout.write(out.endsWith("\n") || out === "" ? out : `${out}\n`);
    const ms = (performance.now() - t0).toFixed(0);
    if (code === 0) say(`${name}`, `finished in ${ms} ms`);
    else {
      say(
        `${name}`,
        `PROCESS DIED exit=${code} signal=${signal} after ${ms} ms; stderr: ${err.trim().split("\n").slice(0, 6).join(" | ") || "(empty)"}`,
      );
      if (name === "ffi-basic") ffi = "0";
    }
  }
  say("done", "all probes finished");
  process.exit(0);
}

// =============================================================== probes
const probe = argv[1]!;
const want = (name: string) => probe === name;
process.on("unhandledRejection", (e) => say("unhandled", firstLine(e)));
process.on("uncaughtException", (e) => say("uncaught", firstLine(e)));

// ------------------------------------------------------- (0) ffi, stepwise
if (want("ffi-basic")) {
  try {
    const k = kernel32();
    say("ffi-dlopen-kernel32", "ok");
    const me = k.GetCurrentProcess();
    say("ffi-GetCurrentProcess", `pseudo-handle ${me}`);
    const out = new Uint32Array(1);
    const r = k.GetExitCodeProcess(me, ptr(out));
    say(
      "ffi-ptr-arg",
      `GetExitCodeProcess(self) -> ${r}, code ${hex(out[0]!)} (expect 0x103 STILL_ACTIVE)`,
    );
    const err = k.GetLastError();
    say("ffi-GetLastError", `${err}`);
    // What a u32 argument arrives as, for values a JS bitwise-or makes negative.
    const a = altKernel32();
    for (const v of [
      0x7fffffff,
      0x80000000,
      0xc0000000,
      0x80000000 | 0x40000000,
      -1,
    ]) {
      a.SetLastError(v);
      say(
        "ffi-u32",
        `SetLastError(${v}) -> GetLastError() = ${a.GetLastError()} (0x${a.GetLastError().toString(16)})`,
      );
    }
  } catch (e) {
    say("ffi-kernel32", `fail — ${firstLine(e)}`);
  }
}

// ucrtbase.dll's fd table is not Bun's: fds 0-2 map (the UCRT seeds them
// from the std handles) but `_get_osfhandle` on a Bun-opened fd takes the
// whole process down with exit code 9 and no message (run 33688866439), so
// this stays a probe of its own, last in the list, and nothing else uses it.
if (want("crt-osfhandle")) {
  try {
    const c = ucrt();
    say("ffi-dlopen-ucrtbase", "ok");
    for (const fd of [0, 1, 2]) {
      const h = c._get_osfhandle(fd);
      let type = "?";
      try {
        type = String(kernel32().GetFileType(h));
      } catch (e) {
        type = firstLine(e);
      }
      say(`ffi-osfhandle-${fd}`, `handle ${h} GetFileType=${type}`);
    }
    const p = path.join(tempDir("wp-spike-ffi-"), "f");
    const fd = fs.openSync(p, "w");
    say(
      "ffi-osfhandle-file",
      `fs.openSync gave fd ${fd}; calling _get_osfhandle on it`,
    );
    const h = c._get_osfhandle(fd);
    say(
      "ffi-osfhandle-file",
      `fs.openSync fd ${fd} -> handle ${h} ${isInvalid(h) ? "INVALID" : `GetFileType=${kernel32().GetFileType(h)} (1 = disk)`}`,
    );
    fs.closeSync(fd);
  } catch (e) {
    say("ffi-ucrtbase", `fail — ${firstLine(e)}`);
  }
}

// ------------------------------------------------------- (a) socket file
if (want("socket-file")) {
  const dir = tempDir("wp-spike-sock-");
  const p = path.join(dir, "wp.sock");
  const fsView = (q: string) => {
    const one = (f: () => fs.Stats) => {
      try {
        const st = f();
        return `mode=${st.mode.toString(8)} sock=${st.isSocket()} file=${st.isFile()} link=${st.isSymbolicLink()}`;
      } catch (e) {
        const ee = e as NodeJS.ErrnoException;
        return `${ee.code ?? firstLine(e)} errno=${ee.errno}`;
      }
    };
    let ex = "?";
    try {
      ex = String(fs.existsSync(q));
    } catch (e) {
      ex = firstLine(e);
    }
    let dirent = "?";
    try {
      const d = fs
        .readdirSync(path.dirname(q), { withFileTypes: true })
        .find((x) => x.name === path.basename(q));
      dirent = d
        ? `sock=${d.isSocket()} file=${d.isFile()} link=${d.isSymbolicLink()}`
        : "absent";
    } catch (e) {
      dirent = firstLine(e);
    }
    return `lstat[${one(() => fs.lstatSync(q))}] stat[${one(() => fs.statSync(q))}] exists=${ex} dirent[${dirent}]`;
  };
  const echoServer = (addr: string) =>
    Bun.listen<undefined>({
      unix: addr,
      socket: {
        open() {},
        data(s, c) {
          s.write(c);
        },
        error() {},
      },
    });
  const roundTrip = (addr: string) =>
    new Promise<string>((resolve) => {
      const t = setTimeout(() => resolve("timeout"), 3000);
      Bun.connect<undefined>({
        unix: addr,
        socket: {
          open(s) {
            s.write("ping");
          },
          data(s, c) {
            clearTimeout(t);
            resolve(`ok ${JSON.stringify(new TextDecoder().decode(c))}`);
            s.end();
          },
          error(_s, e) {
            clearTimeout(t);
            resolve(`error ${firstLine(e)}`);
          },
          connectError(_s, e) {
            clearTimeout(t);
            resolve(`connectError ${firstLine(e)}`);
          },
        },
      }).catch((e) => {
        clearTimeout(t);
        resolve(`reject ${firstLine(e)}`);
      });
    });
  let l1: ReturnType<typeof echoServer> | null = null;
  try {
    l1 = echoServer(p);
    say("socket-file-bound", fsView(p));
    // rename the bound file and connect through the new name
    const renamed = path.join(dir, "wp.sock.renamed");
    try {
      fs.renameSync(p, renamed);
      say(
        "socket-file-rename",
        `renameSync ok; connect via new name: ${await roundTrip(renamed)}; via old name: ${await roundTrip(p)}`,
      );
      fs.renameSync(renamed, p);
    } catch (e) {
      say("socket-file-rename", `renameSync failed: ${firstLine(e)}`);
    }
    // rename over an existing stale socket file, as server.ts does
    try {
      const stale = path.join(dir, "stale.sock");
      const ls = echoServer(stale);
      // stop without letting Bun unlink: copy the reparse point first
      let copied = "";
      try {
        fs.copyFileSync(stale, path.join(dir, "stale2.sock"));
        copied = "copyFileSync ok";
      } catch (e) {
        copied = `copyFileSync ${firstLine(e)}`;
      }
      ls.stop(true);
      await sleep(50);
      // existsSync says false for a reparse point; ask the directory instead
      const target = fs.readdirSync(dir).includes("stale2.sock")
        ? path.join(dir, "stale2.sock")
        : null;
      if (target) {
        fs.renameSync(p, target);
        say(
          "socket-file-rename-over-stale",
          `${copied}; renameSync over a stale socket file ok; ${await roundTrip(target)}`,
        );
        fs.renameSync(target, p);
      } else {
        say(
          "socket-file-rename-over-stale",
          `${copied}; no stale file to rename over`,
        );
      }
    } catch (e) {
      say("socket-file-rename-over-stale", `failed: ${firstLine(e)}`);
    }
    // a second bind on the same live path
    try {
      const l2 = echoServer(p);
      say(
        "socket-file-rebind-live",
        "second listen on a live path succeeded (unexpected)",
      );
      l2.stop(true);
    } catch (e) {
      say("socket-file-rebind-live", `second listen refused: ${firstLine(e)}`);
    }
    l1.stop(true);
    l1 = null;
    await sleep(50);
    say("socket-file-after-stop", fsView(p));
    // the file a killed daemon leaves: bind in a child, kill it, look
    try {
      const child = Bun.spawn(
        [
          process.execPath,
          "-e",
          `Bun.listen({unix: ${JSON.stringify(p)}, socket:{data(){}}}); console.log("up"); setTimeout(()=>{}, 60000)`,
        ],
        { stdout: "pipe", stderr: "ignore" },
      );
      const reader = child.stdout.getReader();
      await Promise.race([reader.read(), sleep(5000)]);
      const view = fsView(p);
      child.kill("SIGKILL");
      await child.exited;
      await sleep(100);
      say(
        "socket-file-after-kill",
        `while the child listened: ${view}; after SIGKILL: ${fsView(p)}`,
      );
      try {
        const l3 = echoServer(p);
        say(
          "socket-file-rebind-stale",
          `listen over the killed daemon's file succeeded; ${await roundTrip(p)}`,
        );
        l3.stop(true);
      } catch (e) {
        say(
          "socket-file-rebind-stale",
          `listen over the killed daemon's file refused: ${firstLine(e)}`,
        );
        try {
          fs.unlinkSync(p);
          const l4 = echoServer(p);
          say(
            "socket-file-unlink-rebind",
            `unlinkSync ok, listen ok; ${await roundTrip(p)}`,
          );
          l4.stop(true);
        } catch (e2) {
          say("socket-file-unlink-rebind", `failed: ${firstLine(e2)}`);
        }
      }
    } catch (e) {
      say("socket-file-after-kill", `setup failed: ${firstLine(e)}`);
    }
    try {
      fs.unlinkSync(p);
    } catch {}
    say(
      "socket-file-connect-absent",
      `connect with no file: ${await roundTrip(p)}`,
    );
  } catch (e) {
    say("socket-file", `fail — ${firstLine(e)}`);
  } finally {
    try {
      l1?.stop(true);
    } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------- (b) LockFileEx
if (want("lockfileex")) {
  const dir = tempDir("wp-spike-lock-");
  const p = path.join(dir, "wp.lock");
  // All handles come from CreateFileW: Bun's fds belong to a CRT that is not
  // ucrtbase.dll, so `_get_osfhandle` on one is fatal (see crt-osfhandle).
  // Run 33689491351 then saw LockFileEx refuse a good handle with
  // ERROR_ACCESS_DENIED (5), so every way of asking is tried in turn, the
  // first that works carries the contention tests, and an exclusive-share
  // open — the other Windows way to hold a file until death — is measured
  // beside it.
  try {
    const h = openHandle(p);
    if (isInvalid(h)) {
      say(
        "lock-createfilew",
        `CreateFileW failed, GetLastError=${kernel32().GetLastError()}`,
      );
    } else {
      say(
        "lock-createfilew",
        `ok — handle ${h}, GetFileType=${kernel32().GetFileType(h)} (1 = disk); the file ${fs.existsSync(p) ? "exists" : "does not exist"}`,
      );
      let chosen = -1;
      for (let i = 0; i < LOCK_VARIANTS.length; i++) {
        const v = LOCK_VARIANTS[i]!;
        try {
          const [ok, err] = v.lock(h);
          say(
            `lock-variant ${v.name}`,
            ok ? "ok — locked" : `refused err=${err}`,
          );
          if (ok) {
            if (chosen < 0) chosen = i;
            else v.unlock(h);
          }
        } catch (e) {
          say(`lock-variant ${v.name}`, `threw ${firstLine(e)}`);
        }
      }
      if (chosen < 0) {
        say("lock-take", "fail — no LockFile variant took the lock");
        kernel32().CloseHandle(h);
      } else {
        const v = LOCK_VARIANTS[chosen]!;
        say("lock-take", `ok — held through ${v.name}`);
        const hSame = openHandle(p);
        const [okSame, errSame] = v.lock(hSame);
        say(
          "lock-same-process",
          `a second handle in the same process: ${okSame ? "locked too (per handle, not per process)" : `refused err=${errSame}`}`,
        );
        kernel32().CloseHandle(hSame);
        const t = Bun.spawn(self("lock-try", p, String(chosen)), {
          stdout: "pipe",
          stderr: "pipe",
        });
        await t.exited;
        say(
          "lock-contend",
          `other process says ${JSON.stringify((await new Response(t.stdout).text()).trim())} (expect refused err=33) ${(await new Response(t.stderr).text()).trim().split("\n")[0] ?? ""}`,
        );
        const r = v.unlock(h);
        const t2 = Bun.spawn(self("lock-try", p, String(chosen)), {
          stdout: "pipe",
          stderr: "pipe",
        });
        await t2.exited;
        say(
          "lock-release",
          `unlock=${r}; other process says ${JSON.stringify((await new Response(t2.stdout).text()).trim())} (expect locked)`,
        );
        v.lock(h);
        kernel32().CloseHandle(h);
        const t3 = Bun.spawn(self("lock-try", p, String(chosen)), {
          stdout: "pipe",
          stderr: "pipe",
        });
        await t3.exited;
        say(
          "lock-release-on-close",
          `after CloseHandle, other process says ${JSON.stringify((await new Response(t3.stdout).text()).trim())} (expect locked)`,
        );
        // release on death: a holder process is killed, how soon can we lock?
        const holder = Bun.spawn(self("lock-holder", p, String(chosen)), {
          stdout: "pipe",
          stderr: "pipe",
        });
        const reader = holder.stdout.getReader();
        const first = await Promise.race([
          reader.read(),
          sleep(5000).then(() => null),
        ]);
        const said =
          first && first.value
            ? new TextDecoder().decode(first.value).trim()
            : "(nothing)";
        const h3 = openHandle(p);
        const [before, errBefore] = v.lock(h3);
        holder.kill();
        const t0 = performance.now();
        await holder.exited;
        let got = false;
        let tries = 0;
        while (performance.now() - t0 < 5000) {
          tries++;
          const [ok] = v.lock(h3);
          if (ok) {
            got = true;
            break;
          }
          await sleep(5);
        }
        say(
          "lock-release-on-death",
          `holder said ${JSON.stringify(said)}; while held: ${before ? "we got it too (BAD)" : `refused err=${errBefore}`}; after kill: ${got ? `acquired after ${(performance.now() - t0).toFixed(0)} ms, ${tries} tries` : "not acquired within 5 s"}`,
        );
        kernel32().CloseHandle(h3);
      }
    }
  } catch (e) {
    say("lockfileex", `fail — ${firstLine(e)}`);
  }
  // The exclusive-share open: CreateFileW with no sharing at all beyond
  // DELETE, so a second opener fails with ERROR_SHARING_VIOLATION (32) until
  // the handle closes or its process dies. src/platform/win32.ts uses this.
  try {
    const px = path.join(dir, "wp.xlock");
    const hx = exclusiveOpen(px);
    if (isInvalid(hx)) {
      say("xopen-take", `fail — CreateFileW err=${kernel32().GetLastError()}`);
    } else {
      say("xopen-take", `ok — handle ${hx}`);
      const again = exclusiveOpen(px);
      say(
        "xopen-same-process",
        isInvalid(again)
          ? `refused err=${kernel32().GetLastError()} (expect 32)`
          : "opened too (BAD)",
      );
      if (!isInvalid(again)) kernel32().CloseHandle(again);
      const t = Bun.spawn(self("xopen-try", px), {
        stdout: "pipe",
        stderr: "pipe",
      });
      await t.exited;
      say(
        "xopen-contend",
        `other process says ${JSON.stringify((await new Response(t.stdout).text()).trim())} (expect refused err=32)`,
      );
      let readable = "";
      try {
        fs.readFileSync(px);
        readable = "readFileSync ok";
      } catch (e) {
        readable = `readFileSync ${(e as NodeJS.ErrnoException).code}`;
      }
      let stat = "";
      try {
        fs.statSync(px);
        stat = "statSync ok";
      } catch (e) {
        stat = `statSync ${(e as NodeJS.ErrnoException).code}`;
      }
      say(
        "xopen-others",
        `${readable}; ${stat}; existsSync=${fs.existsSync(px)}`,
      );
      kernel32().CloseHandle(hx);
      const t2 = Bun.spawn(self("xopen-try", px), {
        stdout: "pipe",
        stderr: "pipe",
      });
      await t2.exited;
      say(
        "xopen-release-on-close",
        `after CloseHandle, other process says ${JSON.stringify((await new Response(t2.stdout).text()).trim())} (expect opened)`,
      );
      const holder = Bun.spawn(self("xopen-holder", px), {
        stdout: "pipe",
        stderr: "pipe",
      });
      const reader = holder.stdout.getReader();
      const first = await Promise.race([
        reader.read(),
        sleep(5000).then(() => null),
      ]);
      const said =
        first && first.value
          ? new TextDecoder().decode(first.value).trim()
          : "(nothing)";
      const before = exclusiveOpen(px);
      const errBefore = isInvalid(before) ? kernel32().GetLastError() : 0;
      holder.kill();
      const t0 = performance.now();
      await holder.exited;
      let got = false;
      let tries = 0;
      while (performance.now() - t0 < 5000) {
        tries++;
        const hh = exclusiveOpen(px);
        if (!isInvalid(hh)) {
          got = true;
          kernel32().CloseHandle(hh);
          break;
        }
        await sleep(5);
      }
      say(
        "xopen-release-on-death",
        `holder said ${JSON.stringify(said)}; while held: ${isInvalid(before) ? `refused err=${errBefore}` : "we got it too (BAD)"}; after kill: ${got ? `acquired after ${(performance.now() - t0).toFixed(0)} ms, ${tries} tries` : "not acquired within 5 s"}`,
      );
      let removed = "";
      try {
        const hh = exclusiveOpen(px);
        fs.unlinkSync(px);
        removed = `unlinkSync while held ok; listed after: ${fs.readdirSync(dir).includes("wp.xlock")}`;
        kernel32().CloseHandle(hh);
        removed += `; listed after close: ${fs.readdirSync(dir).includes("wp.xlock")}`;
      } catch (e) {
        removed = `unlinkSync while held ${(e as NodeJS.ErrnoException).code}`;
      }
      say("xopen-unlink-while-held", removed);
    }
  } catch (e) {
    say("xopen", `fail — ${firstLine(e)}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------ (c) stdio[3]
if (want("stdio3")) {
  type ParentRead = (fd: number) => Promise<string>;
  const readSync: ParentRead = async (fd) => {
    const buf = Buffer.alloc(4096);
    let got = "";
    const end = Date.now() + 3000;
    while (Date.now() < end) {
      try {
        const n = fs.readSync(fd, buf, 0, buf.length, null);
        if (n === 0) return `EOF after ${JSON.stringify(got)}`;
        got += buf.subarray(0, n).toString();
        if (got.includes("\n")) return `got ${JSON.stringify(got)}`;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EAGAIN") {
          await sleep(5);
          continue;
        }
        return `error ${firstLine(e)}`;
      }
    }
    return `timeout with ${JSON.stringify(got)}`;
  };
  const bunFile: ParentRead = (fd) =>
    Promise.race([
      Bun.file(fd)
        .text()
        .then((t) => `got ${JSON.stringify(t)}`)
        .catch((e) => `error ${firstLine(e)}`),
      sleep(3000).then(() => "timeout"),
    ]);
  const netSocket: ParentRead = (fd) =>
    new Promise<string>((resolve) => {
      let got = "";
      const t = setTimeout(
        () => resolve(`timeout with ${JSON.stringify(got)}`),
        3000,
      );
      try {
        const s = new net.Socket({
          fd,
          readable: true,
        } as net.SocketConstructorOpts);
        s.on("data", (d) => {
          got += d.toString();
          if (got.includes("\n")) {
            clearTimeout(t);
            resolve(`got ${JSON.stringify(got)}`);
          }
        });
        s.on("error", (e) => {
          clearTimeout(t);
          resolve(`error ${firstLine(e)}`);
        });
        s.on("end", () => {
          clearTimeout(t);
          resolve(`EOF after ${JSON.stringify(got)}`);
        });
      } catch (e) {
        clearTimeout(t);
        resolve(`throw ${firstLine(e)}`);
      }
    });
  const fileType: ParentRead = async (fd) => {
    // Is the number a raw HANDLE? FILE_TYPE_PIPE is 3.
    if (!ffiAllowed) return "n/a (ffi off)";
    try {
      return `GetFileType(${fd} as HANDLE)=${kernel32().GetFileType(BigInt(fd))} (3 = pipe, 0 = not a handle)`;
    } catch (e) {
      return `error ${firstLine(e)}`;
    }
  };
  const parents: [string, ParentRead][] = [
    ["fs.readSync", readSync],
    ["Bun.file(fd).text", bunFile],
    ["net.Socket({fd})", netSocket],
    ["GetFileType", fileType],
  ];
  for (const child of ["fd3-write", "fd3-net"]) {
    for (const [pname, read] of parents) {
      const name = `stdio3 ${child} / ${pname}`;
      try {
        const proc = Bun.spawn(self(child), {
          stdio: ["ignore", "pipe", "pipe", "pipe"],
        });
        const fd = proc.stdio[3];
        if (typeof fd !== "number") {
          say(name, `stdio[3] is ${typeof fd}`);
          proc.kill();
          continue;
        }
        const verdict = await read(fd);
        const exited = await Promise.race([
          proc.exited,
          sleep(3000).then(() => "hung"),
        ]);
        if (exited === "hung") proc.kill();
        const out = (await new Response(proc.stdout).text()).trim();
        const err =
          (await new Response(proc.stderr).text()).trim().split("\n")[0] ?? "";
        say(
          name,
          `parent(fd=${fd}): ${verdict} | ${out || "(child said nothing)"} ${err}`,
        );
      } catch (e) {
        say(name, `fail — ${firstLine(e)}`);
      }
    }
  }
}

// ------------------------------------------------- (d) parent-listens handshake
if (want("handshake")) {
  const dir = tempDir("wp-spike-hs-");
  try {
    const parent = Bun.spawn(self("hs-parent"), {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, WP_PROBE_DIR: dir },
    });
    await Promise.race([parent.exited, sleep(10_000)]);
    const out = (await new Response(parent.stdout).text()).trim();
    const err =
      (await new Response(parent.stderr).text()).trim().split("\n")[0] ?? "";
    const pid = Number(/pid=(\d+)/.exec(out)?.[1]);
    say(
      "handshake-parent",
      `${out || "(no output)"} ${err} exit=${parent.exitCode}`,
    );
    if (pid) {
      const t0 = tickCount(dir);
      await sleep(6000);
      const t1 = tickCount(dir);
      const alive = pidAlive(pid);
      let hsErr = "";
      try {
        hsErr = fs.readFileSync(path.join(dir, "hs-error"), "utf8");
      } catch {}
      say(
        "handshake-child-survives",
        `${alive && t1 > t0 ? "ok" : "fail"} — 6 s after the parent exited: kill(pid,0)=${alive}, ticks ${t0} -> ${t1}${hsErr ? `, child connect error: ${hsErr}` : ""}`,
      );
      try {
        process.kill(pid);
      } catch {}
    } else {
      say("handshake-child-survives", "skipped — no child pid");
    }
  } catch (e) {
    say("handshake", `fail — ${firstLine(e)}`);
  } finally {
    await sleep(100);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------ (e) detached daemon from a ConPTY child
if (want("conpty-orphan")) {
  for (const hold of [false, true]) {
    const dir = tempDir("wp-spike-pty-");
    const name = hold
      ? "conpty-orphan-parent-alive"
      : "conpty-orphan-parent-exited";
    try {
      let text = "";
      const parent = Bun.spawn(self("hs-parent", ...(hold ? ["hold"] : [])), {
        env: { ...process.env, WP_PROBE_DIR: dir },
        terminal: {
          cols: 80,
          rows: 24,
          data: (_t, d) => {
            text += new TextDecoder().decode(d);
          },
        },
      });
      const gotReady = await waitFor(() => /READY pid=\d+/.test(text), 10_000);
      const pid = Number(/pid=(\d+)/.exec(text)?.[1]);
      if (!hold) await Promise.race([parent.exited, sleep(5000)]);
      parent.terminal!.close();
      const parentGone = await Promise.race([
        parent.exited.then(() => true),
        sleep(3000).then(() => false),
      ]);
      const parentNote = hold
        ? parentGone
          ? `parent died on ConPTY close (exitCode ${parent.exitCode}, signalCode ${parent.signalCode})`
          : "parent survived its ConPTY closing"
        : `parent exited ${parent.exitCode} before close`;
      if (!parentGone) parent.kill();
      if (!gotReady || !pid) {
        say(
          name,
          `no READY from the parent: ${JSON.stringify(text.slice(-200))}`,
        );
        continue;
      }
      const t0 = tickCount(dir);
      await sleep(6000);
      const t1 = tickCount(dir);
      const alive = pidAlive(pid);
      say(
        name,
        `${alive && t1 > t0 ? "ok" : "fail"} — 6 s after terminal.close(): daemon kill(pid,0)=${alive}, ticks ${t0} -> ${t1}; ${parentNote}`,
      );
      try {
        process.kill(pid);
      } catch {}
    } catch (e) {
      say(name, `fail — ${firstLine(e)}`);
    } finally {
      await sleep(100);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------- (f) ^C under Bun.Terminal
if (want("ctrl-c")) {
  const cases: [string, string[]][] = [
    ["sleep 30", ["sleep", "30"]],
    ["pwsh Start-Sleep", ["pwsh", "-NoProfile", "-c", "Start-Sleep 30"]],
    [
      "bash trap",
      [
        "bash",
        "-c",
        'trap "echo GOT_SIGINT; exit 42" INT; while :; do sleep 0.05; done',
      ],
    ],
  ];
  for (const [label, cmd] of cases) {
    const name = `ctrl-c ${label}`;
    try {
      let text = "";
      const proc = Bun.spawn(cmd, {
        terminal: {
          cols: 80,
          rows: 24,
          data: (_t, d) => {
            text += new TextDecoder().decode(d);
          },
        },
      });
      await sleep(cmd[0] === "pwsh" ? 5000 : 500);
      const h = openProcess(proc.pid);
      proc.terminal!.write("\x03");
      const died = await Promise.race([
        proc.exited.then(() => true),
        sleep(6000).then(() => false),
      ]);
      const raw = rawExitCode(h);
      if (!died) proc.kill();
      await proc.exited;
      proc.terminal!.close();
      closeHandle(h);
      say(
        name,
        `${died ? "exited on ^C" : "did not exit within 4 s (killed)"}; bun exitCode=${proc.exitCode} signalCode=${proc.signalCode}; GetExitCodeProcess=${hex(raw)}${text.includes("GOT_SIGINT") ? "; trap fired" : ""}`,
      );
    } catch (e) {
      say(name, `fail — ${firstLine(e)}`);
    }
  }
}

// ---------------------------------- (g) signals into a detached child
if (want("kill-detached")) {
  for (const sig of [undefined, "SIGINT", "SIGKILL"] as const) {
    const dir = tempDir("wp-spike-sig-");
    const name = `kill-detached ${sig ?? "default"}`;
    try {
      const child = Bun.spawn(self("sig-child"), {
        detached: true,
        windowsHide: true,
        stdio: ["ignore", "ignore", "ignore"],
        env: { ...process.env, WP_PROBE_DIR: dir },
      });
      const up = await waitFor(
        () => fs.existsSync(path.join(dir, "alive")),
        5000,
      );
      const h = openProcess(child.pid);
      if (sig) child.kill(sig);
      else child.kill();
      const died = await Promise.race([
        child.exited.then(() => true),
        sleep(3000).then(() => false),
      ]);
      await sleep(300);
      let signals = "";
      try {
        signals = fs
          .readFileSync(path.join(dir, "signals"), "utf8")
          .trim()
          .replace(/\n/g, ",");
      } catch {}
      const raw = rawExitCode(h);
      closeHandle(h);
      if (!died) child.kill("SIGKILL");
      say(
        name,
        `child up=${up}; ${died ? "exited" : "still running after 3 s"}; exitCode=${child.exitCode} signalCode=${child.signalCode}; GetExitCodeProcess=${hex(raw)}; handlers that fired: ${signals || "none"}`,
      );
    } catch (e) {
      say(name, `fail — ${firstLine(e)}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

// ----------------------------------------------------- (h) odds and ends
if (want("misc")) {
  try {
    say(
      "kill-0",
      `process.kill(process.pid, 0) -> ${pidAlive(process.pid)}; on pid 4000000 -> ${pidAlive(4_000_000)}`,
    );
  } catch (e) {
    say("kill-0", `fail — ${firstLine(e)}`);
  }
  try {
    const dir = tempDir("wp-spike-misc-");
    fs.mkdirSync(path.join(dir, "d"), { recursive: true, mode: 0o700 });
    const st = fs.statSync(path.join(dir, "d"));
    say(
      "mkdir-0700",
      `mode=${st.mode.toString(8)} (& 0o077 = ${(st.mode & 0o077).toString(8)}) uid=${st.uid} getuid=${typeof process.getuid}`,
    );
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    say("mkdir-0700", `fail — ${firstLine(e)}`);
  }
  try {
    const proc = Bun.spawn(
      [
        process.execPath,
        "-e",
        'process.on("SIGTERM", () => {}); console.log("installed")',
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    await proc.exited;
    say(
      "sigterm-listener",
      `bun -e process.on("SIGTERM") -> exit ${proc.exitCode}: ${(await new Response(proc.stdout).text()).trim()} ${(await new Response(proc.stderr).text()).trim().split("\n")[0] ?? ""}`,
    );
  } catch (e) {
    say("sigterm-listener", `fail — ${firstLine(e)}`);
  }
  say(
    "env-dirs",
    `LOCALAPPDATA=${process.env.LOCALAPPDATA ?? "(unset)"} tmpdir=${os.tmpdir()} homedir=${os.homedir()} XDG_RUNTIME_DIR=${process.env.XDG_RUNTIME_DIR ?? "(unset)"}`,
  );
  say(
    "which",
    `sh=${Bun.which("sh")} bash=${Bun.which("bash")} sleep=${Bun.which("sleep")} pwsh=${Bun.which("pwsh")} ps=${Bun.which("ps")} pgrep=${Bun.which("pgrep")}`,
  );
}

// ------------------------------------- (i) what a compiled binary sees
// launch.ts and spikes/m0/_lib.ts decide "compiled" from import.meta.path;
// the poc run's wp.exe re-launched its daemon as `wp run …` (exit 2), which
// is what a wrong answer there would do. Compile a script that prints the
// values and run it with daemon-shaped arguments.
if (want("compiled-paths")) {
  const dir = tempDir("wp-spike-compiled-");
  try {
    const script = path.join(dir, "show.ts");
    fs.writeFileSync(
      script,
      [
        "console.log(JSON.stringify({",
        "  importMetaPath: import.meta.path,",
        "  importMetaDir: import.meta.dir,",
        "  bunMain: Bun.main,",
        "  execPath: process.execPath,",
        "  argv: process.argv,",
        '  startsWithBunfs: import.meta.path.startsWith("/$bunfs/"),',
        '  startsWithBDrive: import.meta.path.startsWith("B:/~BUN/"),',
        "  matchesEither: /^B:[\\\\/]~BUN[\\\\/]/.test(import.meta.path),",
        "}));",
      ].join("\n"),
    );
    const exe = path.join(dir, "show.exe");
    const build = Bun.spawnSync(
      [process.execPath, "build", "--compile", script, "--outfile", exe],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (build.exitCode !== 0) {
      say(
        "compiled-paths",
        `build failed: ${build.stderr.toString().trim().split("\n")[0]}`,
      );
    } else {
      const run = Bun.spawnSync([exe, "__daemon", "--dir=x"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      say(
        "compiled-paths",
        `exit ${run.exitCode}: ${run.stdout.toString().trim() || run.stderr.toString().trim().split("\n")[0]}`,
      );
    }
  } catch (e) {
    say("compiled-paths", `fail — ${firstLine(e)}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// --------------------------------------- (j) the seam's own win32 lock
// `platform.lock` as the daemon calls it: the ffi LockFileEx path, and the named-pipe
// fallback forced through WP_WIN32_LOCK=pipe (what a build without bun:ffi,
// such as win32-arm64, would take). Held here, contended from a child,
// released by the child's death.
if (want("flock-port")) {
  for (const mode of ["ffi", "pipe"]) {
    const dir = tempDir("wp-spike-flock-");
    const p = path.join(dir, "wp.lock");
    const env = { ...process.env, WP_WIN32_LOCK: mode };
    process.env.WP_WIN32_LOCK = mode;
    try {
      const { platform } =
        await import("../../packages/werk-poc/src/platform/index.ts");
      const mine = platform.lock(p);
      say(
        `flock-port ${mode} take`,
        mine ? `ok — fd=${mine.fd}` : "refused (BAD)",
      );
      const again = platform.lock(p);
      say(
        `flock-port ${mode} same-process`,
        again ? "locked too (BAD)" : "refused",
      );
      again?.release();
      const t = Bun.spawn(self("flock-try", p), {
        stdout: "pipe",
        stderr: "pipe",
        env,
      });
      await t.exited;
      say(
        `flock-port ${mode} contend`,
        `child says ${JSON.stringify((await new Response(t.stdout).text()).trim())} ${(await new Response(t.stderr).text()).trim().split("\n")[0] ?? ""} (expect refused)`,
      );
      mine?.release();
      const t2 = Bun.spawn(self("flock-try", p), {
        stdout: "pipe",
        stderr: "pipe",
        env,
      });
      await t2.exited;
      say(
        `flock-port ${mode} release`,
        `after release, child says ${JSON.stringify((await new Response(t2.stdout).text()).trim())} (expect locked)`,
      );
      const holder = Bun.spawn(self("flock-try", p, "hold"), {
        stdout: "pipe",
        stderr: "pipe",
        env,
      });
      const reader = holder.stdout.getReader();
      const first = await Promise.race([
        reader.read(),
        sleep(5000).then(() => null),
      ]);
      const said =
        first && first.value
          ? new TextDecoder().decode(first.value).trim()
          : "(nothing)";
      const during = platform.lock(p);
      holder.kill();
      const t0 = performance.now();
      await holder.exited;
      let got: ReturnType<typeof platform.lock> = null;
      let tries = 0;
      while (performance.now() - t0 < 5000 && !got) {
        tries++;
        got = platform.lock(p);
        if (!got) await sleep(5);
      }
      say(
        `flock-port ${mode} release-on-death`,
        `holder said ${JSON.stringify(said)}; while held: ${during ? "we got it too (BAD)" : "refused"}; after kill: ${got ? `acquired after ${(performance.now() - t0).toFixed(0)} ms, ${tries} tries` : "not acquired within 5 s"}`,
      );
      during?.release();
      got?.release();
    } catch (e) {
      say(`flock-port ${mode}`, `fail — ${firstLine(e)}`);
    } finally {
      delete process.env.WP_WIN32_LOCK;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

process.exit(0);
