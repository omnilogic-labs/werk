// Autostart: connect, and if nothing answers, spawn the daemon from this
// very binary and wait for it to be reachable.
//
// The daemon is `Bun.spawn`ed with `detached: true` (setsid) and stdio on
// /dev/null, plus one extra `"pipe"` slot that the child sees as fd 3. The
// daemon writes `ready\n` (or an error line) to it and closes it. That pipe
// is an optimisation and an error channel — it lets the launcher learn a
// lock-held failure immediately and, on the happy path, learn readiness in
// one round trip rather than by polling. It is not the source of truth:
// `proc.stdio[3]` is a non-blocking fd, read here with `fs.readSync` and a
// short wait on EAGAIN, and M2 saw the equivalent `Bun.file(fd).text()`
// stall past a ten-second deadline under load in `bun test`, so the
// launcher never waits on it alone — it polls the socket for a successful
// `hello` as the authority and treats the pipe read as best-effort
// (findings/m2.md). The fd is never closed by hand; see `readPipe`.
//
// On Windows (spike/win32-daemon) the pipe cannot be read at all: the child
// does see fd 3, but `proc.stdio[3]` on the parent side is a raw HANDLE
// number that `fs.readSync`, `Bun.file` and `net.Socket({fd})` all refuse
// (win32-spike run 33688866439). So there the launcher passes no fourth
// slot and names a file instead — `--ready-file=<dir>\wp.ready.<pid>` —
// which the daemon writes its report to (write to a temp name, rename) and
// `readPipe`'s counterpart polls. Same contract: best-effort, "" on timeout,
// the socket poll is still the authority. The spawn itself is `detached` +
// `windowsHide` with a real directory as cwd, since `/` is not one.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PROTOCOL_VERSION, WP_VERSION } from "../protocol/index.ts";
import { GHOSTTY_COMMIT } from "../engine/ghostty-wasm/bytes.ts";
import { READY_TOKEN } from "./main.ts";
import {
  daemonPaths,
  defaultRuntimeDir,
  ensureRuntimeDir,
  type DaemonPaths,
} from "./paths.ts";

/** True when running from a `bun build --compile` binary. */
export const compiled =
  import.meta.path.startsWith("/$bunfs/") ||
  import.meta.path.startsWith("B:/~BUN/");

/** How to run `wp __daemon` from here, interpreted or compiled. */
export function daemonArgv(extra: string[]): string[] {
  if (compiled) return [process.execPath, "__daemon", ...extra];
  const cli = path.join(import.meta.dir, "..", "cli", "main.ts");
  return [process.execPath, "run", cli, "__daemon", ...extra];
}

/** How long to wait for the readiness pipe before falling back to socket polling. */
const PIPE_TIMEOUT_MS = 3000;

export interface LaunchOptions {
  dir?: string;
  /** Total time to wait for readiness. */
  timeoutMs?: number;
}

export interface LaunchResult {
  pid: number;
  /** What the daemon wrote on its readiness pipe: the ready token, an error line, or "" if the read did not complete. */
  report: string;
  ms: number;
  /** win32 only: the daemon's exit code so far, for the launcher's deadline message. */
  exitCode?: () => number | null;
}

/**
 * Spawns a daemon and reads its readiness pipe. Returns the pipe's report,
 * or "" when the read did not complete within `PIPE_TIMEOUT_MS` (the caller
 * then confirms liveness over the socket). Does not check whether one is
 * already running.
 */
export async function spawnDaemon(
  opts: { dir?: string; pipeTimeoutMs?: number } = {},
): Promise<LaunchResult> {
  const dir = opts.dir ?? defaultRuntimeDir();
  ensureRuntimeDir(dir);
  const t0 = performance.now();
  if (process.platform === "win32") {
    const readyFile = path.join(dir, `wp.ready.${process.pid}`);
    try {
      fs.unlinkSync(readyFile);
    } catch {}
    const proc = Bun.spawn(
      daemonArgv([`--dir=${dir}`, `--ready-file=${readyFile}`]),
      {
        detached: true,
        windowsHide: true,
        cwd: os.homedir(),
        env: process.env as Record<string, string>,
        stdio: ["ignore", "ignore", "ignore"],
      },
    );
    const report = await readReadyFile(
      readyFile,
      proc,
      opts.pipeTimeoutMs ?? PIPE_TIMEOUT_MS,
    );
    proc.unref();
    return {
      pid: proc.pid,
      report,
      ms: performance.now() - t0,
      exitCode: () => proc.exitCode,
    };
  }
  const proc = Bun.spawn(daemonArgv([`--dir=${dir}`, "--ready-fd=3"]), {
    detached: true,
    cwd: "/",
    env: process.env as Record<string, string>,
    stdio: ["ignore", "ignore", "ignore", "pipe"],
  });
  const fd = proc.stdio[3];
  if (typeof fd !== "number")
    throw new Error("Bun.spawn gave no fd for stdio[3]");
  const report = await readPipe(fd, opts.pipeTimeoutMs ?? PIPE_TIMEOUT_MS);
  proc.unref();
  return { pid: proc.pid, report, ms: performance.now() - t0 };
}

/**
 * The win32 counterpart of `readPipe`: polls for the daemon's ready file
 * until it appears, the daemon exits without writing one, or `timeoutMs`
 * passes. The file is removed once read.
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

export interface EnsureOptions extends LaunchOptions {
  /** A function that tries one connection; resolves to true when it succeeded. */
  probe(paths: DaemonPaths): Promise<boolean>;
}

/**
 * Connects, or starts a daemon and connects. The lock decides between two
 * launchers racing: the loser's daemon reports the lock failure on its pipe
 * and exits, and the loser polls the socket, which now answers against the
 * winner's daemon. A `hello` over the socket — not the pipe — is what proves
 * the daemon is up.
 */
export async function ensureDaemon(
  opts: EnsureOptions,
): Promise<{ started: LaunchResult | null }> {
  const dir = opts.dir ?? defaultRuntimeDir();
  const paths = daemonPaths(dir);
  if (await opts.probe(paths)) return { started: null };

  const started = await spawnDaemon({ dir });
  // A definite failure the pipe reported: no point polling.
  if (
    /^error:/.test(started.report) &&
    !/already holds the lock/.test(started.report)
  ) {
    throw new Error(`daemon failed to start: ${started.report.trim()}`);
  }
  const ours = started.report === READY_TOKEN || started.report === "";

  const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
  let wait = 10;
  while (Date.now() < deadline) {
    if (await opts.probe(paths)) return { started: ours ? started : null };
    await Bun.sleep(wait);
    wait = Math.min(wait * 2, 200);
  }
  let why = "";
  if (process.platform === "win32") {
    // No pipe to have carried the failure: say what the process and its log
    // can say instead.
    const code = started.exitCode?.();
    let tail = "";
    try {
      tail = fs
        .readFileSync(paths.log, "utf8")
        .trimEnd()
        .split("\n")
        .slice(-5)
        .join("\n  ");
    } catch {}
    why = ` (daemon pid ${started.pid} ${code === null || code === undefined ? "still running" : `exited ${code}`}; ${tail ? `log tail:\n  ${tail}` : "no log written"})`;
  }
  throw new Error(
    `a daemon holds ${paths.lock} but nothing answers on ${paths.socket}${why}`,
  );
}

export function clientHello() {
  return { protocol: PROTOCOL_VERSION, wp: WP_VERSION, engine: GHOSTTY_COMMIT };
}
