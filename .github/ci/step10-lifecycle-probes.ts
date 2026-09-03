// Probes for §8's lifecycle gap on Windows: what, if anything, can ask a
// detached daemon to stop from outside the protocol, and why an exited
// session's snapshot-mode attach saw an `output` frame before its snapshot.
//
//   bun run .github/ci/step10-lifecycle-probes.ts
//
// One `PROBE <name>: <verdict>` line per question; nothing here throws. The
// child roles (`role:<name>`) are spawned the way `spawnDaemon` spawns the
// daemon — `detached`, `windowsHide`, stdio ignored — so the answers are
// about a process shaped like the daemon. The file re-invokes itself and
// must be run from source under `bun run`.
//
// `bun:ffi` is loaded lazily: on `win32-arm64` Bun 1.3.14 has none, and
// that is a verdict rather than a crash.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { connect } from "../../packages/werk-poc/src/client/index.ts";
import { platform } from "../../packages/werk-poc/src/platform/index.ts";
import { daemonPaths } from "../../packages/werk-poc/src/daemon/paths.ts";

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

const read = (file: string): string | null => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

// ------------------------------------------------------------------ ffi

type K32 = {
  symbols: {
    GenerateConsoleCtrlEvent: (event: number, group: number) => number;
    GetLastError: () => number;
    AllocConsole: () => number;
    FreeConsole: () => number;
    AttachConsole: (pid: number) => number;
    SetConsoleCtrlHandler: (handler: null, add: number) => number;
    GetConsoleWindow: () => bigint;
  };
};

let k32: K32 | null | string = null;
async function kernel32(): Promise<K32 | string> {
  if (k32 !== null) return k32;
  try {
    const { dlopen, FFIType } = await import("bun:ffi");
    k32 = dlopen("kernel32.dll", {
      GenerateConsoleCtrlEvent: {
        args: [FFIType.u32, FFIType.u32],
        returns: FFIType.i32,
      },
      GetLastError: { args: [], returns: FFIType.u32 },
      AllocConsole: { args: [], returns: FFIType.i32 },
      FreeConsole: { args: [], returns: FFIType.i32 },
      AttachConsole: { args: [FFIType.u32], returns: FFIType.i32 },
      SetConsoleCtrlHandler: {
        args: [FFIType.ptr, FFIType.i32],
        returns: FFIType.i32,
      },
      GetConsoleWindow: { args: [], returns: FFIType.u64 },
    }) as unknown as K32;
  } catch (e) {
    k32 = `no bun:ffi: ${firstLine(e)}`;
  }
  return k32;
}

const CTRL_BREAK_EVENT = 1;
const ATTACH_PARENT_PROCESS = 0xffffffff;

// ================================================================== roles

if (role === "daemonish") {
  // A process shaped like the daemon: detached, no console, handlers on
  // every signal name Bun accepts, writing which one fired. With `console`
  // it first allocates a console of its own, so a control event has
  // something to arrive through.
  const dir = argv[1]!;
  const wantConsole = argv[2] === "console";
  if (wantConsole) {
    const k = await kernel32();
    fs.writeFileSync(
      path.join(dir, "console"),
      typeof k === "string"
        ? k
        : `AllocConsole=${k.symbols.AllocConsole()} window=${k.symbols.GetConsoleWindow()}`,
    );
  }
  const names = ["SIGTERM", "SIGINT", "SIGBREAK", "SIGHUP", "SIGQUIT"];
  const fired: string[] = [];
  for (const sig of names) {
    try {
      process.on(sig as NodeJS.Signals, () => {
        fired.push(sig);
        fs.writeFileSync(path.join(dir, "fired"), fired.join(","));
      });
    } catch (e) {
      fs.appendFileSync(
        path.join(dir, "register-errors"),
        `${sig}: ${firstLine(e)}\n`,
      );
    }
  }
  fs.writeFileSync(path.join(dir, "alive"), String(process.pid));
  await sleep(60_000);
  process.exit(0);
}

if (role === "stop-server") {
  // The daemon's side of the stop pipe, through the seam.
  const dir = argv[1]!;
  const lock = argv[2]!;
  const t0 = performance.now();
  try {
    const l = platform.listenForStop(lock, (reason) => {
      fs.writeFileSync(
        path.join(dir, "stopped"),
        `${reason} after ${(performance.now() - t0).toFixed(0)} ms`,
      );
      setTimeout(() => process.exit(0), 20);
    });
    fs.writeFileSync(path.join(dir, "listening"), l?.name ?? "null");
  } catch (e) {
    fs.writeFileSync(path.join(dir, "listening"), `error: ${firstLine(e)}`);
  }
  await sleep(60_000);
  process.exit(0);
}

// ================================================================== probes

if (role === null) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wp-step10-"));
  const spawnDetached = (
    args: string[],
  ): { pid: number; exitCode: () => number | null } => {
    const p = Bun.spawn(args, {
      detached: true,
      windowsHide: true,
      cwd: os.homedir(),
      env: process.env as Record<string, string>,
      stdio: ["ignore", "ignore", "ignore"],
    });
    p.unref();
    return { pid: p.pid, exitCode: () => p.exitCode };
  };
  const dirFor = (name: string) => {
    const d = path.join(tmp, name);
    fs.mkdirSync(d, { recursive: true });
    return d;
  };
  const cleanup = (pid: number) => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  };

  const startDaemonish = async (name: string, wantConsole = false) => {
    const dir = dirFor(name);
    const child = spawnDetached(
      self("daemonish", dir, wantConsole ? "console" : "plain"),
    );
    const up = await waitFor(
      () => fs.existsSync(path.join(dir, "alive")),
      10_000,
    );
    return { dir, child, up };
  };

  // ---- 1. What Bun's process.kill does to a daemon-shaped child, per name.
  for (const sig of ["SIGTERM", "SIGINT", "SIGBREAK", "SIGHUP", "SIGQUIT"]) {
    const { dir, child, up } = await startDaemonish(`kill-${sig}`);
    if (!up) {
      say(`kill-${sig}`, `child never came up (exit ${child.exitCode()})`);
      cleanup(child.pid);
      continue;
    }
    let threw = "";
    const t0 = performance.now();
    try {
      process.kill(child.pid, sig as NodeJS.Signals);
    } catch (e) {
      threw = firstLine(e);
    }
    const gone = await waitFor(() => !pidAlive(child.pid), 2000);
    await sleep(100);
    const fired = read(path.join(dir, "fired"));
    say(
      `kill-${sig}`,
      `${threw ? `process.kill threw ${threw}` : "process.kill returned"}; ` +
        `child ${gone ? `gone in ${(performance.now() - t0).toFixed(0)} ms` : "still alive after 2 s"}; ` +
        `handler fired: ${fired ?? "none"}; registration errors: ${read(path.join(dir, "register-errors"))?.trim().replace(/\n/g, "; ") ?? "none"}`,
    );
    cleanup(child.pid);
  }

  // ---- 2. A console control event at the detached child, which has no console.
  {
    const k = await kernel32();
    const { dir, child, up } = await startDaemonish("ctrl-break-detached");
    if (typeof k === "string") say("ctrl-break-detached", k);
    else if (!up) say("ctrl-break-detached", "child never came up");
    else {
      const attach = k.symbols.AttachConsole(child.pid);
      const attachErr = k.symbols.GetLastError();
      const r = k.symbols.GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, child.pid);
      const err = k.symbols.GetLastError();
      const gone = await waitFor(() => !pidAlive(child.pid), 2000);
      say(
        "ctrl-break-detached",
        `AttachConsole(pid)=${attach}${attach ? "" : ` (error ${attachErr})`}; ` +
          `GenerateConsoleCtrlEvent(CTRL_BREAK, pid)=${r}${r ? "" : ` (error ${err})`}; ` +
          `child ${gone ? `died (exit ${child.exitCode()})` : "still alive after 2 s"}; handler fired: ${read(path.join(dir, "fired")) ?? "none"}`,
      );
      if (attach) k.symbols.FreeConsole();
    }
    cleanup(child.pid);
  }

  // ---- 3. The same, at a child that allocated a console of its own: does
  // the event arrive, and does Bun's handler see it?
  {
    const k = await kernel32();
    const { dir, child, up } = await startDaemonish("ctrl-break-console", true);
    if (typeof k === "string") say("ctrl-break-own-console", k);
    else if (!up) say("ctrl-break-own-console", "child never came up");
    else {
      const consoleNote = read(path.join(dir, "console")) ?? "?";
      k.symbols.FreeConsole();
      const attach = k.symbols.AttachConsole(child.pid);
      const attachErr = k.symbols.GetLastError();
      // Do not die of our own event should it reach this process.
      k.symbols.SetConsoleCtrlHandler(null, 1);
      const r = k.symbols.GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, child.pid);
      const err = k.symbols.GetLastError();
      const gone = await waitFor(() => !pidAlive(child.pid), 2000);
      await sleep(100);
      k.symbols.FreeConsole();
      k.symbols.AttachConsole(ATTACH_PARENT_PROCESS);
      say(
        "ctrl-break-own-console",
        `child ${consoleNote}; AttachConsole(pid)=${attach}${attach ? "" : ` (error ${attachErr})`}; ` +
          `GenerateConsoleCtrlEvent(CTRL_BREAK, pid)=${r}${r ? "" : ` (error ${err})`}; ` +
          `child ${gone ? `died (exit ${child.exitCode()})` : "still alive after 2 s"}; handler fired: ${read(path.join(dir, "fired")) ?? "none"}`,
      );
    }
    cleanup(child.pid);
  }

  // ---- 4. The stop pipe, through the seam, at a detached child.
  const startStopServer = async (name: string) => {
    const dir = dirFor(name);
    const lock = path.join(dir, "wp.lock");
    const child = spawnDetached(self("stop-server", dir, lock));
    const up = await waitFor(
      () => fs.existsSync(path.join(dir, "listening")),
      10_000,
    );
    return { dir, lock, child, up, name: read(path.join(dir, "listening")) };
  };
  {
    const s = await startStopServer("stop-pipe");
    if (!s.up) say("stop-pipe-roundtrip", "child never came up");
    else if (s.name?.startsWith("error") || s.name === "null")
      say("stop-pipe-roundtrip", `listener: ${s.name}`);
    else {
      const t0 = performance.now();
      let reason = "";
      let err = "";
      try {
        reason = await platform.requestStop(s.child.pid, s.lock);
      } catch (e) {
        err = firstLine(e);
      }
      const gone = await waitFor(() => !pidAlive(s.child.pid), 5000);
      say(
        "stop-pipe-roundtrip",
        err
          ? `requestStop rejected: ${err}`
          : `requestStop resolved "${reason}" in ${(performance.now() - t0).toFixed(0)} ms; child ${gone ? `gone in ${(performance.now() - t0).toFixed(0)} ms` : "still alive after 5 s"}; server wrote: ${read(path.join(s.dir, "stopped")) ?? "nothing"}`,
      );
    }
    cleanup(s.child.pid);
  }

  // ---- 5. A bare connect, and a wrong word, do nothing.
  {
    const s = await startStopServer("stop-pipe-bare");
    if (!s.up || !s.name?.startsWith("\\\\"))
      say("stop-pipe-bare-connect", `listener: ${s.name}`);
    else {
      const name = s.name;
      const open = (word: string | null) =>
        new Promise<string>((resolve) => {
          Bun.connect({
            unix: name,
            socket: {
              open(sock) {
                if (word !== null) sock.write(word);
                else sock.end();
              },
              data() {},
              close() {
                resolve("closed");
              },
              error(_s, e) {
                resolve(`error ${firstLine(e)}`);
              },
              connectError(_s, e) {
                resolve(`connectError ${firstLine(e)}`);
              },
            },
          }).catch((e) => resolve(`threw ${firstLine(e)}`));
        });
      const bare = await open(null);
      await sleep(300);
      const aliveAfterBare = pidAlive(s.child.pid);
      const wrong = await open("hello\n");
      await sleep(300);
      const aliveAfterWrong = pidAlive(s.child.pid);
      say(
        "stop-pipe-bare-connect",
        `bare connect: ${bare}, server ${aliveAfterBare ? "still up" : "GONE"}; "hello": ${wrong}, server ${aliveAfterWrong ? "still up" : "GONE"}`,
      );
    }
    cleanup(s.child.pid);
  }

  // ---- 6. The word from a shell that is not Bun: PowerShell's pipe client.
  {
    const s = await startStopServer("stop-pipe-pwsh");
    if (process.platform !== "win32")
      say("stop-pipe-from-powershell", "not windows");
    else if (!s.up || !s.name?.startsWith("\\\\"))
      say("stop-pipe-from-powershell", `listener: ${s.name}`);
    else {
      const short = s.name.replace(/^\\\\\.\\pipe\\/, "");
      const t0 = performance.now();
      const r = Bun.spawnSync(
        [
          "powershell",
          "-NoProfile",
          "-Command",
          `$p=[System.IO.Pipes.NamedPipeClientStream]::new('.','${short}',[System.IO.Pipes.PipeDirection]::InOut); $p.Connect(3000); $w=[System.IO.StreamWriter]::new($p); $w.Write("stop\`n"); $w.Flush(); Start-Sleep -Milliseconds 200; $p.Dispose(); 'sent'`,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const out = `${r.stdout}${r.stderr}`.replace(/\r/g, "").trim();
      const gone = await waitFor(() => !pidAlive(s.child.pid), 5000);
      say(
        "stop-pipe-from-powershell",
        `powershell exit ${r.exitCode} said "${out.split("\n").pop()}"; server ${gone ? `gone in ${(performance.now() - t0).toFixed(0)} ms` : "still alive after 5 s"}; server wrote: ${read(path.join(s.dir, "stopped")) ?? "nothing"}`,
      );
    }
    cleanup(s.child.pid);
  }

  // ---- 7. The real daemon: TerminateProcess against the stop pipe, and
  // what each leaves in the state directory.
  const daemonIn = async (name: string) => {
    const dir = dirFor(name);
    const state = path.join(dir, "state");
    process.env.WP_STATE_DIR = state;
    process.env.WP_SNAPSHOT_INTERVAL_MS = "60000";
    const c = await connect({ dir, requestTimeoutMs: 20_000 });
    return { dir, state, c, pid: c.daemon.pid };
  };
  const snaps = (state: string) => {
    try {
      return fs.readdirSync(state).filter((f) => f.endsWith(".snap"));
    } catch {
      return [];
    }
  };
  for (const how of ["terminate", "requestStop"] as const) {
    let d: Awaited<ReturnType<typeof daemonIn>> | null = null;
    try {
      d = await daemonIn(`daemon-${how}`);
      const { id } = await d.c.run({
        argv: ["sh", "-c", "echo stop-case; exec sh"],
      });
      await waitFor(() => false, 400);
      const t0 = performance.now();
      let reason = "";
      if (how === "terminate") platform.terminate(d.pid);
      else reason = await platform.requestStop(d.pid, daemonPaths(d.dir).lock);
      const gone = await waitFor(() => !pidAlive(d!.pid), 5000);
      d.c.close();
      const log = read(path.join(d.dir, "wp.log")) ?? "";
      const shutting = log
        .split("\n")
        .filter((l) => /shutting down|shutdown snapshots|stop requests/.test(l))
        .map((l) => l.replace(/^\S+ /, ""))
        .join(" | ");
      say(
        `daemon-${how}`,
        `daemon ${gone ? `gone in ${(performance.now() - t0).toFixed(0)} ms` : "still alive after 5 s"}; ` +
          `snapshots on disk: ${JSON.stringify(snaps(d.state))} (session ${id}); ` +
          `${reason ? `reason "${reason}"; ` : ""}log: ${shutting || "(no shutdown lines)"}`,
      );
    } catch (e) {
      say(`daemon-${how}`, `failed: ${firstLine(e)}`);
    } finally {
      if (d) cleanup(d.pid);
    }
  }

  // ---- 8. The attach order for an exited session, over a connection that
  // is still attached to a flooding session against one of its own.
  {
    let d: Awaited<ReturnType<typeof daemonIn>> | null = null;
    try {
      d = await daemonIn("attach-order");
      const flood = await d.c.run({
        argv: ["sh", "-c", "sleep 0.2; yes | head -c 3000000; sleep 30"],
      });
      const orderOver = async (
        c: Awaited<ReturnType<typeof connect>>,
        id: string,
      ) => {
        const order: string[] = [];
        let exited = false;
        const att = await c.attach(id, {
          cols: 80,
          rows: 24,
          mode: "snapshot",
          onSnapshot: () => order.push("snapshot"),
          onOutput: () => order.push("output"),
          onExited: () => {
            exited = true;
          },
        });
        await waitFor(() => exited, 3000);
        await att.detach();
        return { status: att.status, order };
      };
      // The shared connection first attaches to the flood, as the lag test
      // leaves it when it fails partway.
      const watcher = await d.c.attach(flood.id, {
        cols: 80,
        rows: 24,
        mode: "snapshot",
        onSnapshot() {},
        onOutput() {},
      });
      void watcher;
      const done = await d.c.run({ argv: ["sh", "-c", "echo bye; exit 3"] });
      await waitFor(() => false, 1500);
      const shared = await orderOver(d.c, done.id);
      const own = await connect({ dir: d.dir, requestTimeoutMs: 20_000 });
      const alone = await orderOver(own, done.id);
      own.close();
      const summarise = (o: string[]) => {
        const first = o.findIndex((x) => x === "snapshot");
        return `${o.slice(0, 4).join(",")}${o.length > 4 ? ",…" : ""} (${o.length} frames, snapshot at index ${first})`;
      };
      say(
        "exited-attach-order-shared-connection",
        `status ${shared.status}; ${summarise(shared.order)}`,
      );
      say(
        "exited-attach-order-own-connection",
        `status ${alone.status}; ${summarise(alone.order)}`,
      );
      await d.c.shutdown().catch(() => {});
      d.c.close();
      await waitFor(() => !pidAlive(d!.pid), 5000);
    } catch (e) {
      say("exited-attach-order", `failed: ${firstLine(e)}`);
    } finally {
      if (d) cleanup(d.pid);
    }
  }

  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
  process.exit(0);
}
