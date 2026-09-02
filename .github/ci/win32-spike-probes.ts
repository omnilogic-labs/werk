// Probes for the `spike/win32-daemon` experiment: the primitives the daemon
// layer would need on Windows, each measured on a real runner before any of
// `src/daemon` is ported. Same style as windows-probes.ts: one
// `PROBE <name>: <verdict>` line per question, and nothing here throws.
//
//   bun run .github/ci/win32-spike-probes.ts [probe...]
//
// The file re-invokes itself for the child roles (`role:<name>` as the first
// argument), so it must be run from source under `bun run`.

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { dlopen, FFIType, ptr, type Pointer } from "bun:ffi";

const argv = process.argv.slice(2);
const role = argv[0]?.startsWith("role:") ? argv[0].slice(5) : null;
const probes = role ? [] : argv;
const want = (name: string) => probes.length === 0 || probes.includes(name);

function say(name: string, verdict: string): void {
  console.log(`PROBE ${name}: ${verdict}`);
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
  const GENERIC_READ = 0x80000000;
  const GENERIC_WRITE = 0x40000000;
  const FILE_SHARE_ALL = 1 | 2 | 4;
  const OPEN_ALWAYS = 4;
  const FILE_ATTRIBUTE_NORMAL = 0x80;
  return kernel32().CreateFileW(
    ptr(name),
    GENERIC_READ | GENERIC_WRITE,
    FILE_SHARE_ALL,
    null,
    OPEN_ALWAYS,
    FILE_ATTRIBUTE_NORMAL,
    0n,
  );
}

/** Raw exit code from the kernel, via a handle opened while the process lived. */
function rawExitCode(h: bigint): number | null {
  const out = new Uint32Array(1);
  const r = kernel32().GetExitCodeProcess(h, ptr(out));
  return r !== 0 ? out[0]! : null;
}
function openProcess(pid: number): bigint {
  const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
  return kernel32().OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
}
const hex = (n: number | null) =>
  n === null ? "null" : `0x${n.toString(16).toUpperCase()} (${n})`;

// ================================================================ roles
if (role) {
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
      // Hold the lock on argv[1] until told to exit (or killed).
      const p = argv[1]!;
      const fd = fs.openSync(p, "w");
      const h = ucrt()._get_osfhandle(fd);
      const [ok, err] = lockHandle(h);
      console.log(`holder ${ok ? "locked" : `refused err=${err}`}`);
      if (ok) await sleep(60_000);
      process.exit(ok ? 0 : 1);
    }
    case "lock-try": {
      const p = argv[1]!;
      const fd = fs.openSync(p, "w");
      const h = ucrt()._get_osfhandle(fd);
      const [ok, err] = lockHandle(h);
      console.log(`try ${ok ? "locked" : "refused"} err=${err}`);
      fs.closeSync(fd);
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
        console.log(`child: writeSync(3) ok; ${stat}`);
      } catch (e) {
        console.log(`child: writeSync(3) ${firstLine(e)}; ${stat}`);
      }
      process.exit(0);
    }
    case "fd3-net": {
      try {
        const s = new net.Socket({ fd: 3 } as net.SocketConstructorOpts);
        s.on("error", (e) => console.log(`child: net.Socket ${firstLine(e)}`));
        await new Promise<void>((r) => s.write("ready\n", () => r()));
        s.end();
        console.log("child: net.Socket({fd:3}).write ok");
      } catch (e) {
        console.log(`child: net.Socket({fd:3}) ${firstLine(e)}`);
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

// ================================================================ probes
console.log(
  `platform=${process.platform} arch=${process.arch} bun=${Bun.version} release=${os.release()} tmp=${os.tmpdir()}`,
);
process.on("unhandledRejection", (e) => say("unhandled", firstLine(e)));
process.on("uncaughtException", (e) => say("uncaught", firstLine(e)));
setTimeout(() => {
  say("watchdog", "probes did not finish in 10 minutes; exiting");
  process.exit(0);
}, 600_000).unref();

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
        return `${(e as NodeJS.ErrnoException).code ?? firstLine(e)}`;
      }
    };
    let ex = "?";
    try {
      ex = String(fs.existsSync(q));
    } catch (e) {
      ex = firstLine(e);
    }
    return `lstat[${one(() => fs.lstatSync(q))}] stat[${one(() => fs.statSync(q))}] exists=${ex}`;
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
    say(
      "socket-file-bound",
      `${fsView(p)}; dir lists ${JSON.stringify(fs.readdirSync(dir))}`,
    );
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
    // a stale file: bind again without unlinking
    try {
      const l3 = echoServer(p);
      say(
        "socket-file-rebind-stale",
        `listen over the stale file succeeded; ${await roundTrip(p)}`,
      );
      l3.stop(true);
    } catch (e) {
      say(
        "socket-file-rebind-stale",
        `listen over the stale file refused: ${firstLine(e)}`,
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
    // connecting to a stale file (no listener)
    try {
      fs.unlinkSync(p);
    } catch {}
    try {
      const l5 = echoServer(p);
      l5.stop(true);
      await sleep(50);
      say(
        "socket-file-connect-stale",
        `connect to a stale file: ${await roundTrip(p)}`,
      );
    } catch (e) {
      say("socket-file-connect-stale", `setup failed: ${firstLine(e)}`);
    }
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
  try {
    const fd = fs.openSync(p, "w");
    let h: bigint;
    try {
      h = ucrt()._get_osfhandle(fd);
      say(
        "lock-osfhandle",
        `fd ${fd} -> handle ${h} (${h === INVALID_HANDLE || h === -1n ? "INVALID" : `GetFileType=${kernel32().GetFileType(h)}`})`,
      );
    } catch (e) {
      say("lock-osfhandle", `fail — ${firstLine(e)}`);
      h = INVALID_HANDLE;
    }
    if (h !== INVALID_HANDLE && h !== -1n) {
      const [ok, err] = lockHandle(h);
      say(
        "lock-take",
        ok
          ? "ok — LockFileEx succeeded"
          : `fail — LockFileEx refused, GetLastError=${err}`,
      );
      // a second process contends
      const t = Bun.spawn(self("lock-try", p), {
        stdout: "pipe",
        stderr: "pipe",
      });
      await t.exited;
      say(
        "lock-contend",
        `other process: ${(await new Response(t.stdout).text()).trim()} (expect refused err=33) ${(await new Response(t.stderr).text()).trim().split("\n")[0] ?? ""}`,
      );
      // release, other process should get it
      const ov = new Uint8Array(32);
      const r = kernel32().UnlockFileEx(h, 0, 1, 0, ptr(ov));
      const t2 = Bun.spawn(self("lock-try", p), {
        stdout: "pipe",
        stderr: "pipe",
      });
      await t2.exited;
      say(
        "lock-release",
        `UnlockFileEx=${r}; other process: ${(await new Response(t2.stdout).text()).trim()} (expect locked)`,
      );
      fs.closeSync(fd);
    }
    // a CreateFileW handle, in case the CRT route is the wrong one
    try {
      const h2 = openHandle(p);
      if (h2 === INVALID_HANDLE)
        say(
          "lock-createfilew",
          `CreateFileW failed, GetLastError=${kernel32().GetLastError()}`,
        );
      else {
        const [ok, err] = lockHandle(h2);
        say(
          "lock-createfilew",
          ok ? "ok — handle from CreateFileW locks" : `refused err=${err}`,
        );
        kernel32().CloseHandle(h2);
      }
    } catch (e) {
      say("lock-createfilew", `fail — ${firstLine(e)}`);
    }
    // release on death: a holder process is killed, how soon can we lock?
    const holder = Bun.spawn(self("lock-holder", p), {
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
    const fd2 = fs.openSync(p, "w");
    const h3 = ucrt()._get_osfhandle(fd2);
    const [before, errBefore] = lockHandle(h3);
    holder.kill();
    const t0 = performance.now();
    await holder.exited;
    let got = false;
    let tries = 0;
    while (performance.now() - t0 < 5000) {
      tries++;
      const [ok] = lockHandle(h3);
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
    fs.closeSync(fd2);
  } catch (e) {
    say("lockfileex", `fail — ${firstLine(e)}`);
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
      const t = setTimeout(
        () => resolve(`timeout with ${JSON.stringify(got)}`),
        3000,
      );
      let got = "";
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
  const osfReadSync: ParentRead = async (fd) => {
    // If stdio[3] is a raw HANDLE, wrap it in a CRT fd first.
    try {
      const type = kernel32().GetFileType(BigInt(fd));
      const crtFd = ucrt()._open_osfhandle(BigInt(fd), 0);
      if (crtFd < 0) return `GetFileType=${type}; _open_osfhandle failed`;
      return `GetFileType=${type}; crt fd ${crtFd}: ${await readSync(crtFd)}`;
    } catch (e) {
      return `error ${firstLine(e)}`;
    }
  };
  const parents: [string, ParentRead][] = [
    ["fs.readSync", readSync],
    ["Bun.file(fd).text", bunFile],
    ["net.Socket({fd})", netSocket],
    ["_open_osfhandle+readSync", osfReadSync],
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
      await sleep(cmd[0] === "pwsh" ? 2500 : 500);
      const h = openProcess(proc.pid);
      proc.terminal!.write("\x03");
      const died = await Promise.race([
        proc.exited.then(() => true),
        sleep(4000).then(() => false),
      ]);
      const raw = h === 0n ? null : rawExitCode(h);
      if (!died) proc.kill();
      await proc.exited;
      proc.terminal!.close();
      if (h !== 0n) kernel32().CloseHandle(h);
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
      const raw = h === 0n ? null : rawExitCode(h);
      if (h !== 0n) kernel32().CloseHandle(h);
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
      "kill-0-self",
      `process.kill(process.pid, 0) -> ${pidAlive(process.pid)}; on pid 4000000 -> ${pidAlive(4_000_000)}`,
    );
  } catch (e) {
    say("kill-0-self", `fail — ${firstLine(e)}`);
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
  say(
    "env-dirs",
    `LOCALAPPDATA=${process.env.LOCALAPPDATA ?? "(unset)"} tmpdir=${os.tmpdir()} homedir=${os.homedir()} XDG_RUNTIME_DIR=${process.env.XDG_RUNTIME_DIR ?? "(unset)"}`,
  );
  say(
    "which",
    `sh=${Bun.which("sh")} bash=${Bun.which("bash")} sleep=${Bun.which("sleep")} pwsh=${Bun.which("pwsh")} ps=${Bun.which("ps")} pgrep=${Bun.which("pgrep")}`,
  );
}

say("done", "all probes finished");
process.exit(0);
