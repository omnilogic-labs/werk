// The daemon on the Windows runner: started, spoken to, and stopped.
//
//   bun run .github/ci/windows-daemon.ts check   the `daemon` suite
//   bun run .github/ci/windows-daemon.ts stop    housekeeping between suites
//
// `check` starts a daemon the way `wp` does (`spawnDaemon`, with the ready
// file the win32 launcher polls), completes a `hello` and an `ls` over the
// socket, sends `shutdown`, and waits for the process to be gone. That is
// the whole lifecycle in a few seconds, with a verdict at the end, where
// running `wp __daemon` in the foreground could only ever wait out the step
// timeout. It uses a private runtime directory so it neither joins nor
// disturbs the daemon `wp-cli` autostarts.
//
// `stop` finds every daemon left by earlier suites and ends it, first with
// the `shutdown` message to whatever answers on the default socket, then by
// pid for anything whose command line still says `__daemon`. A daemon that
// is `wp.exe` pins the binary, and `m2` cannot rebuild `dist/wp.exe` over a
// pinned one (EPERM), so this runs before the suites that build. It prints
// what it found and what it killed, and exits 0 either way: it is
// housekeeping, and the suite after it is the one that reports.
//
// Both print a `DETAIL:` line for windows.sh.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { connect } from "../../packages/werk-poc/src/client/index.ts";
import { spawnDaemon } from "../../packages/werk-poc/src/daemon/launch.ts";
import {
  daemonPaths,
  defaultRuntimeDir,
} from "../../packages/werk-poc/src/daemon/paths.ts";

const mode = process.argv[2];

function run(argv: string[]): { ok: boolean; out: string } {
  const r = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
  const out = `${r.stdout?.toString() ?? ""}${r.stderr?.toString() ?? ""}`;
  return { ok: r.exitCode === 0, out: out.replace(/\r/g, "").trim() };
}

/** Every process whose command line names `__daemon`: the daemons, interpreted or compiled. */
function daemonProcesses(): { pid: number; name: string; cmd: string }[] {
  if (process.platform !== "win32") return [];
  const ps = run([
    "powershell",
    "-NoProfile",
    "-Command",
    "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '__daemon' } | ForEach-Object { \"$($_.ProcessId)`t$($_.Name)`t$($_.CommandLine)\" }",
  ]);
  if (!ps.ok) {
    console.log(`process listing failed: ${ps.out.split("\n")[0]}`);
    return [];
  }
  const found: { pid: number; name: string; cmd: string }[] = [];
  for (const line of ps.out.split("\n")) {
    const [pid, name, ...rest] = line.split("\t");
    const n = Number(pid);
    if (Number.isFinite(n) && n > 0)
      found.push({ pid: n, name: name ?? "?", cmd: rest.join("\t") });
  }
  return found;
}

function alive(pid: number): boolean {
  if (process.platform !== "win32") {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
  const r = run(["tasklist", "/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"]);
  return r.out.includes(`"${pid}"`);
}

async function waitGone(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await Bun.sleep(100);
  }
  return !alive(pid);
}

function killPid(pid: number): string {
  if (process.platform === "win32") {
    const r = run(["taskkill", "/F", "/PID", String(pid)]);
    return r.out.split("\n")[0] ?? "";
  }
  try {
    process.kill(pid, "SIGKILL");
    return "SIGKILL sent";
  } catch (e) {
    return String((e as Error).message ?? e);
  }
}

async function check(): Promise<number> {
  const dir = path.join(
    process.env.RUNNER_TEMP ?? os.tmpdir(),
    `wp-daemon-suite-${process.pid}`,
  );
  const paths = daemonPaths(dir);
  const t0 = performance.now();
  const at = () => `${(performance.now() - t0).toFixed(0)} ms`;
  let pid: number | null = null;
  const budget = Number(process.env.DAEMON_CHECK_BUDGET_MS ?? 15_000);
  const timer = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error(`daemon check exceeded ${budget} ms`)),
      budget,
    ).unref(),
  );

  const body = async (): Promise<number> => {
    console.log(`runtime dir: ${dir}`);
    // The daemon inherits its state directory from the environment; keep
    // its snapshots out of the runner's real one.
    process.env.WP_STATE_DIR = path.join(dir, "state");
    const started = await spawnDaemon({ dir });
    pid = started.pid;
    console.log(
      `spawned pid ${started.pid} in ${started.ms.toFixed(0)} ms; ready file said ${JSON.stringify(started.report)}`,
    );
    if (/^error:/.test(started.report)) {
      console.log(`DETAIL: daemon refused to start: ${started.report.trim()}`);
      return 1;
    }

    // The socket is the authority; the ready file is best-effort.
    let client: Awaited<ReturnType<typeof connect>> | null = null;
    const deadline = Date.now() + 10_000;
    let lastErr = "";
    while (client === null && Date.now() < deadline) {
      try {
        client = await connect({ dir, autostart: false, timeoutMs: 2000 });
      } catch (e) {
        lastErr = String((e as Error).message ?? e);
        await Bun.sleep(100);
      }
    }
    if (client === null) {
      console.log(
        `DETAIL: nothing answered hello on ${paths.socket} within 10 s (${lastErr})`,
      );
      return 1;
    }
    const helloAt = at();
    console.log(
      `hello at ${helloAt}: daemon pid ${client.daemon.pid}, wp ${client.daemon.wp}, protocol ${client.daemon.protocol}`,
    );
    const sessions = await client.ls();
    const lsAt = at();
    console.log(`ls at ${lsAt}: ${sessions.length} session(s)`);
    const stats = await client.stats().catch(() => null);
    if (stats) console.log(`stats: ${JSON.stringify(stats)}`);

    const shutdownStart = performance.now();
    await client.shutdown();
    client.close();
    const gone = await waitGone(client.daemon.pid, 5000);
    const shutdownMs = (performance.now() - shutdownStart).toFixed(0);
    if (!gone) {
      console.log(
        `DETAIL: daemon pid ${client.daemon.pid} answered hello and ls but was still alive 5 s after shutdown`,
      );
      return 1;
    }
    console.log(
      `daemon pid ${client.daemon.pid} exited ${shutdownMs} ms after shutdown`,
    );
    let logTail = "";
    try {
      logTail = fs.readFileSync(paths.log, "utf8").trimEnd();
    } catch {}
    if (logTail) console.log(`--- ${paths.log} ---\n${logTail}`);
    console.log(
      `DETAIL: pid ${client.daemon.pid}: hello at ${helloAt}, ls ${sessions.length} sessions at ${lsAt}, exited ${shutdownMs} ms after shutdown`,
    );
    return 0;
  };

  try {
    return await Promise.race([body(), timer]);
  } catch (e) {
    console.log(`DETAIL: ${String((e as Error).message ?? e).split("\n")[0]}`);
    return 1;
  } finally {
    if (pid !== null && alive(pid)) {
      console.log(`daemon pid ${pid} still alive; killing: ${killPid(pid)}`);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function stop(): Promise<number> {
  const dir = defaultRuntimeDir();
  const paths = daemonPaths(dir);
  const notes: string[] = [];
  console.log(`default runtime dir: ${dir}`);

  const before = daemonProcesses();
  if (before.length === 0)
    console.log("no process has __daemon on its command line");
  for (const p of before)
    console.log(`found  pid ${p.pid}  ${p.name}  ${p.cmd}`);

  // Polite first: the shutdown message snapshots and exits.
  if (fs.existsSync(paths.socket)) {
    try {
      const client = await connect({ dir, autostart: false, timeoutMs: 3000 });
      const pid = client.daemon.pid;
      console.log(
        `socket ${paths.socket} answered: daemon pid ${pid}; sending shutdown`,
      );
      await client.shutdown();
      client.close();
      const gone = await waitGone(pid, 5000);
      console.log(
        `daemon pid ${pid} ${gone ? "exited after shutdown" : "still alive 5 s after shutdown"}`,
      );
      notes.push(`shutdown pid ${pid}${gone ? "" : " (did not exit)"}`);
    } catch (e) {
      console.log(
        `socket ${paths.socket}: ${String((e as Error).message ?? e).split("\n")[0]}`,
      );
    }
  } else {
    console.log(`no socket at ${paths.socket}`);
  }

  // Then by pid, for whatever is left: a daemon in another runtime dir, or
  // one that did not take the message.
  const left = daemonProcesses();
  for (const p of left) {
    const r = killPid(p.pid);
    console.log(`killed pid ${p.pid} ${p.name}: ${r}`);
    notes.push(`taskkill ${p.pid} ${p.name}`);
  }
  const after = left.length === 0 ? [] : daemonProcesses();
  for (const p of after)
    console.log(`still running: pid ${p.pid} ${p.name} ${p.cmd}`);

  const detail =
    notes.length === 0
      ? `nothing to stop (${before.length} daemon processes found)`
      : notes.join("; ") +
        (after.length ? `; ${after.length} still running` : "");
  console.log(`DETAIL: ${detail}`);
  return 0;
}

if (mode === "check") process.exit(await check());
else if (mode === "stop") process.exit(await stop());
else {
  console.error("usage: windows-daemon.ts check|stop");
  process.exit(2);
}
