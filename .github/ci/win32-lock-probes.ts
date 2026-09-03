// Probes for §8 step 5's stop condition: on a Windows without `bun:ffi` the
// daemon's lock is an exclusive `\\.\pipe\` name rather than `LockFileEx`,
// and nothing has ever contended it on the one platform that takes that
// path. So: does a second `wp __daemon` get refused while a first one is
// live, and does the name come back when the first one dies?
//
//   bun run .github/ci/win32-lock-probes.ts [--gate]
//
// One `PROBE <name>: <verdict>` line per question; nothing here throws. The
// same file runs on `win32-x64`, where `bun:ffi` exists and the lock is
// `LockFileEx`, so the two runners' verdicts sit side by side and the pipe
// lock is also forced there through `WP_WIN32_LOCK=pipe` — the same forcing
// `win32-spike-probes.ts` uses, now against the daemon rather than against
// `platform.lock` alone.
//
// `--gate` makes a bad answer an exit status, which is what the matrix's
// `lock` suite needs; without it the file always exits 0 and the verdicts
// are the whole output. `WP_LOCK_BIN` names the compiled `wp` to ask as
// well as the source — the matrix points it at the cross-compiled binary
// that lane ships, and without it `dist/wp` is used where one was built.
//
// Paths are kept short on purpose. A Winsock `AF_UNIX` path refused to bind
// at 116 characters under `%TEMP%` and binds at 75 (run 33704932420), so a
// probe that named its directories after the question it was asking would
// measure the socket path rather than the lock.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const GATE = process.argv.slice(2).includes("--gate");
/** Bad answers so far; under `--gate` they are the exit status. */
let bad = 0;

/**
 * One verdict line. `ok` is what a gate reads: false for an answer that says
 * the lock does not hold, null for a line that only reports something.
 */
function say(name: string, verdict: string, ok: boolean | null = null): void {
  if (ok === false) bad++;
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

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Short, because the daemon binds `<dir>/.wp.sock.<pid>.tmp` under it. */
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "wl-"));
const POC = path.join(import.meta.dir, "..", "..", "packages", "werk-poc");
const MAIN = path.join(POC, "src", "cli", "main.ts");

/** `wp` as this probe runs it: the compiled binary where one exists, else source. */
type Wp = { label: string; argv: string[] };

const interpreted: Wp = {
  label: "interpreted",
  argv: [process.execPath, "run", MAIN],
};

/**
 * The compiled `wp` to ask as well as the source: whatever `WP_LOCK_BIN`
 * names, else `dist/wp` where a build left one. Naming one that is not there
 * is a bad answer rather than a skip — a caller that asked for the binary
 * meant the binary.
 */
function compiled(): Wp | null {
  const named = process.env.WP_LOCK_BIN;
  if (named) {
    if (fs.existsSync(named)) return { label: "compiled", argv: [named] };
    say(
      "daemon compiled",
      `WP_LOCK_BIN names ${named}, which is not there`,
      false,
    );
    return null;
  }
  for (const f of [
    path.join(POC, "dist", "wp.exe"),
    path.join(POC, "dist", "wp"),
  ])
    if (fs.existsSync(f)) return { label: "compiled", argv: [f] };
  say("daemon compiled", "skipped — no compiled wp was built or named");
  return null;
}

const { connect } = await import("../../packages/werk-poc/src/client/index.ts");

/** Whether a daemon on `dir`'s socket completes a `hello`, and its pid if so. */
async function helloPid(
  dir: string,
  timeoutMs: number,
): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const c = await connect({ dir, autostart: false, timeoutMs: 1000 }).catch(
      () => null,
    );
    if (c) {
      const pid = c.daemon.pid;
      c.close();
      return pid;
    }
    await sleep(20);
  }
  return null;
}

/**
 * Starts `wp __daemon --dir=<dir>` the way a launcher would — detached, no
 * console, nothing on its stdio — and waits until it answers a `hello`.
 * Returns the process so the caller can end it, and the pid the daemon
 * itself reports, which is the one holding the lock.
 */
async function startDaemon(wp: Wp, dir: string, env: Record<string, string>) {
  fs.mkdirSync(dir, { recursive: true });
  const proc = Bun.spawn([...wp.argv, "__daemon", `--dir=${dir}`], {
    detached: true,
    windowsHide: true,
    cwd: os.homedir(),
    env,
    stdio: ["ignore", "ignore", "ignore"],
  });
  const pid = await helloPid(dir, 15_000);
  return { proc, pid };
}

/** A second `wp __daemon` on the same directory, run to completion. */
async function contend(wp: Wp, dir: string, env: Record<string, string>) {
  const proc = Bun.spawn([...wp.argv, "__daemon", `--dir=${dir}`], {
    cwd: os.homedir(),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  // A refused daemon exits at once; one that took the lock never exits, so
  // the deadline is the verdict rather than a slow answer.
  const raced = await Promise.race([
    proc.exited.then((code) => ({ code })),
    sleep(12_000).then(() => null),
  ]);
  const out = (await new Response(proc.stdout).text()).trim();
  const err = (await new Response(proc.stderr).text()).trim();
  if (raced === null) {
    // It is still running: it either took the lock or is stuck. Ask the
    // socket who is answering before ending it.
    const answering = await helloPid(dir, 2000);
    proc.kill();
    return {
      exited: false as const,
      code: null,
      out,
      err,
      answering,
      pid: proc.pid,
    };
  }
  return {
    exited: true as const,
    code: raced.code,
    out,
    err,
    answering: null,
    pid: proc.pid,
  };
}

/** What Windows will actually stop: no signal reaches a detached daemon. */
function hardKill(pid: number): void {
  try {
    if (process.platform === "win32")
      Bun.spawnSync(["taskkill", "/F", "/PID", String(pid)], {
        stdout: "ignore",
        stderr: "ignore",
      });
    else process.kill(pid, "SIGKILL");
  } catch {}
}

// ------------------------------------------------------- which lock is this

// The verdict below is only meaningful next to the path the seam took, and
// on `win32-arm64` that is decided by `bun:ffi` not existing at all.
{
  let ffi: string;
  try {
    const m = await import("bun:ffi");
    try {
      m.dlopen("kernel32.dll", {
        GetLastError: { args: [], returns: m.FFIType.u32 },
      });
      ffi = "dlopen opens kernel32, so the lock is LockFileEx";
    } catch (e) {
      ffi = `the module imports but dlopen could not open kernel32, so the lock is the pipe — ${firstLine(e)}`;
    }
  } catch (e) {
    ffi = `the module is not there at all, so the lock is the pipe — ${firstLine(e)}`;
  }
  say("ffi", ffi);
  say(
    "runner",
    `${process.platform}-${process.arch} bun ${Bun.version} · ${os.release()}`,
  );
}

// `platform.lock` itself, before any daemon: which path it takes here, and
// whether it hands the same lock out twice inside one process.
{
  const dir = path.join(ROOT, "s");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "wp.lock");
  try {
    const { platform } =
      await import("../../packages/werk-poc/src/platform/index.ts");
    const mine = platform.lock(file);
    say(
      "seam-lock take",
      mine
        ? `ok — fd=${mine.fd} (${mine.fd === -1 ? "named pipe, no handle" : "a lock handle"})`
        : "refused, with nothing else holding it (BAD)",
      mine !== null,
    );
    const again = platform.lock(file);
    say(
      "seam-lock same-process",
      again ? "locked it too (BAD)" : "refused",
      again === null,
    );
    again?.release();
    mine?.release();
  } catch (e) {
    say("seam-lock", `fail — ${firstLine(e)}`, false);
  }
}

// -------------------------------------------------- a second `wp __daemon`

/**
 * The step's question, whole: a live daemon on `dir`, a second `wp __daemon`
 * against it, and then the same again once the first one is gone.
 *
 * `tag` names the run — the `wp` used, and the lock forced on x64 — so both
 * runners print the same probe names for the same questions.
 */
async function daemonContention(wp: Wp, tag: string, forcePipe: boolean) {
  const env = { ...process.env } as Record<string, string>;
  if (forcePipe) env.WP_WIN32_LOCK = "pipe";
  else delete env.WP_WIN32_LOCK;
  // Short: `<ROOT>/<n>` and the daemon's own `.wp.sock.<pid>.tmp` under it.
  const dir = path.join(ROOT, `d${Math.random().toString(36).slice(2, 5)}`);
  let first: Awaited<ReturnType<typeof startDaemon>> | null = null;
  try {
    first = await startDaemon(wp, dir, env);
    if (first.pid === null) {
      let log = "";
      try {
        log = fs
          .readFileSync(path.join(dir, "wp.log"), "utf8")
          .trimEnd()
          .split("\n")
          .slice(-3)
          .join(" | ");
      } catch {}
      say(
        `${tag} first`,
        `no daemon answered within 15 s (spawn pid ${first.proc.pid}, exit ${first.proc.exitCode}); log: ${log || "none"}`,
        false,
      );
      return;
    }
    say(`${tag} first`, `ok — daemon pid ${first.pid} answered hello`, true);

    const second = await contend(wp, dir, env);
    const detail = [
      second.exited ? `exited ${second.code}` : "still running after 12 s",
      second.err ? `stderr ${JSON.stringify(second.err.split("\n")[0])}` : "",
      second.out ? `stdout ${JSON.stringify(second.out.split("\n")[0])}` : "",
      second.answering !== null
        ? `socket answered by pid ${second.answering}`
        : "",
    ]
      .filter(Boolean)
      .join("; ");
    // Refused is the only good answer: a non-zero exit, and the first daemon
    // still the one on the socket.
    const stillFirst = await helloPid(dir, 3000);
    const refused =
      second.exited && second.code !== 0 && stillFirst === first.pid;
    say(
      `${tag} second`,
      `${refused ? "refused" : "TOOK THE LOCK (BAD)"} — ${detail}; socket still pid ${stillFirst ?? "none"} (first was ${first.pid})`,
      refused,
    );

    // The other half of a lock: the name has to come back when the holder
    // dies without releasing anything.
    hardKill(first.pid);
    const t0 = performance.now();
    let gone = false;
    while (performance.now() - t0 < 5000 && !gone) {
      gone = !pidAlive(first.pid);
      if (!gone) await sleep(20);
    }
    const third = await startDaemon(wp, dir, env);
    say(
      `${tag} after-death`,
      third.pid === null
        ? `no daemon took the lock within 15 s of the holder's death (BAD; holder gone: ${gone})`
        : `ok — pid ${third.pid} took it ${(performance.now() - t0).toFixed(0)} ms after the kill`,
      third.pid !== null,
    );
    if (third.pid !== null) hardKill(third.pid);
    first = null;
  } catch (e) {
    say(tag, `fail — ${firstLine(e)}`, false);
  } finally {
    if (first?.pid) hardKill(first.pid);
  }
}

const wps: [Wp, string][] = [[interpreted, "daemon interpreted"]];
const c = compiled();
if (c) wps.push([c, "daemon compiled"]);

for (const [wp, tag] of wps) await daemonContention(wp, tag, false);

// On a runner that has `bun:ffi` the lock above was `LockFileEx`, so force
// the fallback and ask the same question of the pipe. On `win32-arm64` there
// is nothing to force: the run above already was the pipe.
if (process.platform === "win32") {
  let hasFfi = true;
  try {
    await import("bun:ffi");
  } catch {
    hasFfi = false;
  }
  if (hasFfi) await daemonContention(interpreted, "daemon forced-pipe", true);
  else say("daemon forced-pipe", "skipped — no bun:ffi, the run above is it");
}

try {
  fs.rmSync(ROOT, { recursive: true, force: true });
} catch {}

say("verdict", bad === 0 ? "every answer holds" : `${bad} bad answers above`);
process.exit(GATE && bad > 0 ? 1 : 0);
