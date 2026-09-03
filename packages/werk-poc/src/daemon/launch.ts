// Autostart: connect, and if nothing answers, spawn the daemon from this
// very binary and wait for it to be reachable.
//
// How the daemon is spawned and how it reports readiness are rows of the
// seam (`../platform/`): a detached child with an extra pipe slot on a POSIX
// system, a detached child and a polled ready file on Windows. Neither is the
// source of truth. The launcher polls the socket for a successful `hello` as
// the authority and treats the readiness report as best-effort — M2 saw the
// equivalent pipe read stall past a ten-second deadline under load in
// `bun test` (findings/m2.md) — so a report of "" is not a failure.

import path from "node:path";
import { PROTOCOL_VERSION, WP_VERSION } from "../protocol/index.ts";
import { GHOSTTY_COMMIT } from "../engine/ghostty-wasm/bytes.ts";
import { compiled, platform } from "../platform/index.ts";
import { READY_TOKEN } from "./main.ts";
import {
  daemonPaths,
  defaultRuntimeDir,
  ensureRuntimeDir,
  type DaemonPaths,
} from "./paths.ts";

/** How to run `wp __daemon` from here, interpreted or compiled. */
export function daemonArgv(extra: string[]): string[] {
  if (compiled) return [process.execPath, "__daemon", ...extra];
  const cli = path.join(import.meta.dir, "..", "cli", "main.ts");
  return [process.execPath, "run", cli, "__daemon", ...extra];
}

/** How long to wait for the readiness report before falling back to socket polling. */
const PIPE_TIMEOUT_MS = 3000;

export interface LaunchOptions {
  dir?: string;
  /** Total time to wait for readiness. */
  timeoutMs?: number;
}

export interface LaunchResult {
  pid: number;
  /** What the daemon reported: the ready token, an error line, or "" if the read did not complete. */
  report: string;
  ms: number;
  /** The daemon's exit code so far, for the launcher's deadline message. */
  exitCode(): number | null;
}

/**
 * Spawns a daemon and reads its readiness report. Returns the report, or ""
 * when the read did not complete within `PIPE_TIMEOUT_MS` (the caller then
 * confirms liveness over the socket). Does not check whether one is already
 * running.
 */
export async function spawnDaemon(
  opts: { dir?: string; pipeTimeoutMs?: number } = {},
): Promise<LaunchResult> {
  const dir = opts.dir ?? defaultRuntimeDir();
  ensureRuntimeDir(dir);
  const t0 = performance.now();
  const started = await platform.spawnDaemon({
    dir,
    readyTimeoutMs: opts.pipeTimeoutMs ?? PIPE_TIMEOUT_MS,
    argv: daemonArgv,
  });
  return { ...started, ms: performance.now() - t0 };
}

export interface EnsureOptions extends LaunchOptions {
  /** A function that tries one connection; resolves to true when it succeeded. */
  probe(paths: DaemonPaths): Promise<boolean>;
}

/**
 * Connects, or starts a daemon and connects. The lock decides between two
 * launchers racing: the loser's daemon reports the lock failure and exits,
 * and the loser polls the socket, which now answers against the winner's
 * daemon. A `hello` over the socket — not the report — is what proves the
 * daemon is up.
 */
export async function ensureDaemon(
  opts: EnsureOptions,
): Promise<{ started: LaunchResult | null }> {
  const dir = opts.dir ?? defaultRuntimeDir();
  const paths = daemonPaths(dir);
  if (await opts.probe(paths)) return { started: null };

  const started = await spawnDaemon({ dir });
  // A definite failure the daemon reported: no point polling.
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
    `a daemon holds ${paths.lock} but nothing answers on ${paths.socket}${platform.readinessDetail(started, paths.log)}`,
  );
}

export function clientHello() {
  return { protocol: PROTOCOL_VERSION, wp: WP_VERSION, engine: GHOSTTY_COMMIT };
}
