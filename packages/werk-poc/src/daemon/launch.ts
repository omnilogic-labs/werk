// Autostart: connect, and if nothing answers, spawn the daemon from this
// very binary and wait for it to be reachable.
//
// The daemon is `Bun.spawn`ed with `detached: true` (setsid) and stdio on
// /dev/null, plus one extra `"pipe"` slot that the child sees as fd 3. The
// daemon writes `ready\n` (or an error line) to it and closes it. That pipe
// is an optimisation and an error channel — it lets the launcher learn a
// lock-held failure immediately and, on the happy path, learn readiness in
// one round trip rather than by polling. It is not the source of truth:
// `proc.stdio[3]` is a non-blocking fd read through `Bun.file(fd).text()`,
// and under load (many open fds, a busy event loop) that read was seen to
// stall past a ten-second deadline in `bun test`, so the launcher never
// waits on it alone — it polls the socket for a successful `hello` as the
// authority and treats the pipe read as best-effort (findings/m2.md).

import fs from "node:fs";
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
  const proc = Bun.spawn(daemonArgv([`--dir=${dir}`, "--ready-fd=3"]), {
    detached: true,
    cwd: "/",
    env: process.env as Record<string, string>,
    stdio: ["ignore", "ignore", "ignore", "pipe"],
  });
  const fd = proc.stdio[3];
  if (typeof fd !== "number")
    throw new Error("Bun.spawn gave no fd for stdio[3]");
  const report = await Promise.race([
    Bun.file(fd).text(),
    Bun.sleep(opts.pipeTimeoutMs ?? PIPE_TIMEOUT_MS).then(() => ""),
  ]).finally(() => {
    try {
      fs.closeSync(fd);
    } catch {}
  });
  proc.unref();
  return { pid: proc.pid, report, ms: performance.now() - t0 };
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
  throw new Error(
    `a daemon holds ${paths.lock} but nothing answers on ${paths.socket}`,
  );
}

export function clientHello() {
  return { protocol: PROTOCOL_VERSION, wp: WP_VERSION, engine: GHOSTTY_COMMIT };
}
