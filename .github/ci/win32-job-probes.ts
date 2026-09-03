// Probes for §8 step 2: can Bun put a session's ConPTY child in a Job Object,
// and does closing or terminating that job take the whole tree? Measured on a
// real Windows runner before any of `src/daemon` depends on the answer.
//
//   bun run .github/ci/win32-job-probes.ts
//
// One `PROBE <name>: <verdict>` line per question; nothing here throws. The
// child roles (`role:<name>`) are the other halves of the tree probes, so the
// file re-invokes itself and must be run from source under `bun run`.
//
// `bun:ffi` is loaded lazily: on `win32-arm64` Bun 1.3.14 has none at all
// ("TinyCC is disabled"), and that is a verdict rather than a crash.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const argv = process.argv.slice(2);
const role = argv[0]?.startsWith("role:") ? argv[0].slice(5) : null;

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

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ================================================================== roles

if (role === "tree-child") {
  // A session's child, as the daemon spawns one: under a ConPTY, and with a
  // grandchild of its own that nothing but a tree kill would reach. The
  // grandchild is spawned only once `go` appears, so the caller can assign
  // this process to a job first and see whether membership is inherited.
  const dir = argv[1]!;
  await waitFor(() => fs.existsSync(path.join(dir, "go")), 10_000);
  const grand = Bun.spawn(self("tree-grandchild", dir), {
    stdio: ["ignore", "ignore", "ignore"],
  });
  grand.unref();
  fs.writeFileSync(path.join(dir, "pids"), `${process.pid} ${grand.pid}\n`);
  console.log(`PIDS ${process.pid} ${grand.pid}`);
  await sleep(120_000);
  process.exit(0);
}

if (role === "tree-grandchild") {
  const dir = argv[1]!;
  const t = setInterval(() => {
    try {
      fs.appendFileSync(path.join(dir, "ticks"), "tick\n");
    } catch {}
  }, 100);
  setTimeout(() => {
    clearInterval(t);
    process.exit(0);
  }, 120_000);
}

if (role) {
  // Roles that fall through to here have nothing more to do; the two above
  // either exit on their own or are killed by whoever started them.
  await sleep(120_000);
  process.exit(0);
}

// =================================================================== ffi

const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const JobObjectExtendedLimitInformation = 9;
/** JOBOBJECT_EXTENDED_LIMIT_INFORMATION on LLP64: 144 bytes, LimitFlags at 16. */
const EXTENDED_LIMIT_BYTES = 144;
const LIMIT_FLAGS_OFFSET = 16;
const PROCESS_TERMINATE = 0x0001;
const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const INVALID_HANDLE = (1n << 64n) - 1n;
const isInvalid = (h: bigint) => h === INVALID_HANDLE || h === 0n;

type K32 = {
  CreateJobObjectW: (sa: null, name: null) => bigint;
  SetInformationJobObject: (
    job: bigint,
    cls: number,
    info: unknown,
    len: number,
  ) => number;
  AssignProcessToJobObject: (job: bigint, proc: bigint) => number;
  TerminateJobObject: (job: bigint, code: number) => number;
  IsProcessInJob: (proc: bigint, job: bigint, out: unknown) => number;
  OpenProcess: (access: number, inherit: number, pid: number) => bigint;
  GetCurrentProcess: () => bigint;
  GetExitCodeProcess: (h: bigint, out: unknown) => number;
  GetLastError: () => number;
  CloseHandle: (h: bigint) => number;
};

let k32: K32 | null = null;
let ffiError: string | null = null;

async function kernel32(): Promise<K32 | null> {
  if (k32 || ffiError) return k32;
  try {
    const { dlopen, FFIType } = await import("bun:ffi");
    const lib = dlopen("kernel32.dll", {
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
      IsProcessInJob: {
        args: [FFIType.u64, FFIType.u64, FFIType.ptr],
        returns: FFIType.i32,
      },
      OpenProcess: {
        args: [FFIType.u32, FFIType.i32, FFIType.u32],
        returns: FFIType.u64,
      },
      GetCurrentProcess: { args: [], returns: FFIType.u64 },
      GetExitCodeProcess: {
        args: [FFIType.u64, FFIType.ptr],
        returns: FFIType.i32,
      },
      GetLastError: { args: [], returns: FFIType.u32 },
      CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
    });
    k32 = lib.symbols as unknown as K32;
  } catch (e) {
    ffiError = firstLine(e);
  }
  return k32;
}

let ptrOf: (a: NodeJS.TypedArray) => unknown = () => null;
try {
  ptrOf = (await import("bun:ffi")).ptr as unknown as typeof ptrOf;
} catch {}

/** A job with KILL_ON_JOB_CLOSE set, or a reason it could not be made. */
async function makeJob(): Promise<{ job: bigint; note: string } | string> {
  const k = await kernel32();
  if (!k) return `no bun:ffi — ${ffiError}`;
  const job = k.CreateJobObjectW(null, null);
  if (isInvalid(job)) return `CreateJobObjectW failed, err ${k.GetLastError()}`;
  const info = new Uint8Array(EXTENDED_LIMIT_BYTES);
  new DataView(info.buffer).setUint32(
    LIMIT_FLAGS_OFFSET,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    true,
  );
  const ok = k.SetInformationJobObject(
    job,
    JobObjectExtendedLimitInformation,
    ptrOf(info),
    EXTENDED_LIMIT_BYTES,
  );
  if (ok === 0) {
    const err = k.GetLastError();
    k.CloseHandle(job);
    return `SetInformationJobObject(KILL_ON_JOB_CLOSE) failed, err ${err}`;
  }
  return { job, note: "created with KILL_ON_JOB_CLOSE" };
}

// ================================================================= probes

console.log(
  `platform=${process.platform} arch=${process.arch} bun=${Bun.version} release=${os.release()}`,
);

// (a) Is bun:ffi here at all, and can a job be made?
{
  const made = await makeJob();
  if (typeof made === "string") say("job-create", `fail — ${made}`);
  else {
    say("job-create", made.note);
    (await kernel32())!.CloseHandle(made.job);
  }
}

// (b) Is this process already inside a job? Nested jobs are what a runner
// (and any service manager) forces on us; Windows 8 and later allow them.
{
  const k = await kernel32();
  if (!k) say("in-job", `n/a — no bun:ffi`);
  else {
    try {
      const out = new Int32Array(1);
      const r = k.IsProcessInJob(k.GetCurrentProcess(), 0n, ptrOf(out));
      say(
        "in-job",
        r === 0
          ? `IsProcessInJob failed, err ${k.GetLastError()}`
          : `this process ${out[0] ? "is already in a job" : "is in no job"}`,
      );
    } catch (e) {
      say("in-job", `fail — ${firstLine(e)}`);
    }
  }
}

/**
 * The whole question, once per way of ending the job: spawn a ConPTY child
 * exactly as `Session` does, assign it to a job before it spawns a grandchild
 * of its own, and see what survives.
 */
async function treeProbe(
  how: "terminate" | "close" | "control",
): Promise<void> {
  const name = `job-${how}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wp-job-"));
  let job: bigint | null = null;
  let proc: Bun.Subprocess | null = null;
  const k = await kernel32();
  try {
    if (how !== "control") {
      const made = await makeJob();
      if (typeof made === "string") {
        say(name, `n/a — ${made}`);
        return;
      }
      job = made.job;
    }
    let text = "";
    proc = Bun.spawn(self("tree-child", dir), {
      terminal: {
        cols: 80,
        rows: 24,
        data: (_t, d) => {
          text += new TextDecoder().decode(d);
        },
      },
    });
    // Assign before the child is told to spawn its own child, so what is
    // measured is inheritance and not a second assign.
    let assign = "not attempted";
    if (job !== null && k) {
      const h = k.OpenProcess(
        PROCESS_TERMINATE |
          PROCESS_SET_QUOTA |
          PROCESS_QUERY_LIMITED_INFORMATION,
        0,
        proc.pid,
      );
      if (isInvalid(h)) assign = `OpenProcess failed, err ${k.GetLastError()}`;
      else {
        const r = k.AssignProcessToJobObject(job, h);
        assign = r !== 0 ? "assigned" : `failed, err ${k.GetLastError()}`;
        k.CloseHandle(h);
      }
    }
    fs.writeFileSync(path.join(dir, "go"), "go");
    const got = await waitFor(
      () => fs.existsSync(path.join(dir, "pids")),
      10_000,
    );
    if (!got) {
      say(name, `fail — child never reported its pids (assign: ${assign})`);
      return;
    }
    const [childPid, grandPid] = fs
      .readFileSync(path.join(dir, "pids"), "utf8")
      .trim()
      .split(/\s+/)
      .map(Number) as [number, number];
    await waitFor(() => fs.existsSync(path.join(dir, "ticks")), 5000);
    const ticksBefore = fs.existsSync(path.join(dir, "ticks"))
      ? fs.readFileSync(path.join(dir, "ticks"), "utf8").length
      : 0;

    const t0 = performance.now();
    let ended = "";
    if (how === "terminate" && job !== null && k) {
      ended =
        k.TerminateJobObject(job, 1) !== 0
          ? "TerminateJobObject"
          : `TerminateJobObject failed, err ${k.GetLastError()}`;
    } else if (how === "close" && job !== null && k) {
      ended =
        k.CloseHandle(job) !== 0
          ? "CloseHandle(job)"
          : `CloseHandle failed, err ${k.GetLastError()}`;
      job = null;
    } else {
      proc.kill();
      ended = "proc.kill()";
    }
    const childGone = await waitFor(() => !pidAlive(childPid), 5000);
    const grandGone = await waitFor(() => !pidAlive(grandPid), 5000);
    const ms = (performance.now() - t0).toFixed(0);
    await Promise.race([proc.exited, sleep(3000)]);
    const ticksAfter = fs.existsSync(path.join(dir, "ticks"))
      ? fs.readFileSync(path.join(dir, "ticks"), "utf8").length
      : 0;
    await sleep(400);
    const ticksLater = fs.existsSync(path.join(dir, "ticks"))
      ? fs.readFileSync(path.join(dir, "ticks"), "utf8").length
      : 0;
    say(
      name,
      `assign: ${assign}; ended by ${ended}; child ${childGone ? "gone" : "ALIVE"}, ` +
        `grandchild ${grandGone ? "gone" : "ALIVE"} after ${ms} ms; ` +
        `grandchild ticks ${ticksBefore}->${ticksAfter}->${ticksLater} (${ticksLater > ticksAfter ? "still ticking" : "stopped"}); ` +
        `bun says exitCode=${proc.exitCode} signalCode=${proc.signalCode}; pty text ${JSON.stringify(text.trim().slice(0, 60))}`,
    );
    if (!grandGone) {
      try {
        process.kill(grandPid, "SIGKILL");
      } catch {}
    }
  } catch (e) {
    say(name, `fail — ${firstLine(e)}`);
  } finally {
    try {
      proc?.kill();
      proc?.terminal?.close();
    } catch {}
    if (job !== null && k) k.CloseHandle(job);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

await treeProbe("control");
await treeProbe("terminate");
await treeProbe("close");

// (f) What Bun reports for a plain `sleep 30` under a ConPTY, killed each of
// the ways the daemon might kill it. §2 of the proposal says Bun reports the
// signal name it was given; §3 says the exit carries no signal name at all.
for (const how of ["SIGTERM", "SIGKILL", "job"] as const) {
  const name = `kill-report ${how}`;
  let job: bigint | null = null;
  const k = await kernel32();
  try {
    const proc = Bun.spawn(["sleep", "30"], {
      terminal: { cols: 80, rows: 24, data: () => {} },
    });
    if (how === "job") {
      const made = await makeJob();
      if (typeof made === "string") {
        say(name, `n/a — ${made}`);
        proc.kill();
        continue;
      }
      job = made.job;
      const h = k!.OpenProcess(
        PROCESS_TERMINATE | PROCESS_SET_QUOTA,
        0,
        proc.pid,
      );
      k!.AssignProcessToJobObject(job, h);
      k!.CloseHandle(h);
    }
    await sleep(400);
    const t0 = performance.now();
    if (how === "job") k!.TerminateJobObject(job!, 1);
    else proc.kill(how);
    const died = await Promise.race([
      proc.exited.then(() => true),
      sleep(5000).then(() => false),
    ]);
    say(
      name,
      `${died ? `exited after ${(performance.now() - t0).toFixed(0)} ms` : "still running after 5 s"}; ` +
        `exitCode=${proc.exitCode} signalCode=${proc.signalCode}`,
    );
    if (!died) proc.kill("SIGKILL");
    proc.terminal?.close();
  } catch (e) {
    say(name, `fail — ${firstLine(e)}`);
  } finally {
    if (job !== null && k) k.CloseHandle(job);
  }
}

// (g) The same kill through the daemon, step by step with a clock on each
// one: `src/daemon/daemon.test.ts` gives the whole thing 5 s and the failure
// there says only that it ran out. Generous timeouts, so what is slow shows
// up as a number rather than as a timeout.
{
  const name = "daemon-kill";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wp-dk-"));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "wp-dk-state-"));
  process.env.WP_STATE_DIR = state;
  const steps: string[] = [];
  const step = async <T>(label: string, f: () => Promise<T>): Promise<T> => {
    const t0 = performance.now();
    try {
      return await f();
    } finally {
      steps.push(`${label} ${(performance.now() - t0).toFixed(0)} ms`);
    }
  };
  try {
    const { connect } =
      await import("../../packages/werk-poc/src/client/index.ts");
    const client = await step("connect", () => connect({ dir }));
    const { id } = await step("run", () =>
      client.run({ argv: ["sleep", "30"] }),
    );
    let exited: { exitCode: number | null; signalCode: string | null } | null =
      null;
    let painted = false;
    await step("attach", () =>
      client.attach(id, {
        cols: 80,
        rows: 24,
        onRender: () => (painted = true),
        onExited: (i) => (exited = i),
      }),
    );
    const killed = await step("kill", () => client.kill(id));
    const heard = await step("exited notice", async () =>
      waitFor(() => exited !== null, 15_000),
    );
    const info = await step("ls", async () =>
      (await client.ls()).find((s) => s.id === id),
    );
    say(
      name,
      `${steps.join(", ")}; painted=${painted}; kill=${JSON.stringify(killed)}; ` +
        `heard exited=${heard} ${JSON.stringify(exited)}; ls status=${info?.status} ` +
        `exitCode=${info?.exitCode} signalCode=${info?.signalCode} kill=${JSON.stringify(info?.kill)}`,
    );
    await client.shutdown().catch(() => {});
  } catch (e) {
    say(name, `fail after ${steps.join(", ")} — ${firstLine(e)}`);
  } finally {
    await sleep(500);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(state, { recursive: true, force: true });
  }
}

say("done", "all probes finished");
process.exit(0);
