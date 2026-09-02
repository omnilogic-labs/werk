// The `wp __daemon` role. Lifecycle only: lock before bind, bind-then-rename
// (in server.ts), readiness over the inherited pipe, no PID file, no
// signals for control. `--dir=<path>` overrides the runtime directory;
// `--ready-fd=<n>` names the pipe the launcher is waiting on, and
// `--ready-file=<path>` the file the win32 launcher polls instead (it cannot
// read the pipe; see launch.ts). All are passed by the launcher and absent
// when a human runs it by hand.
// `--state-dir=<path>` and `--snapshot-interval=<ms>` override the snapshot
// directory and timer; the launcher passes neither, so a test sets
// `WP_STATE_DIR` and `WP_SNAPSHOT_INTERVAL_MS` in the environment the
// daemon inherits instead.

import fs from "node:fs";
import { tryLock } from "./flock.ts";
import {
  daemonPaths,
  defaultRuntimeDir,
  defaultStateDir,
  ensureRuntimeDir,
} from "./paths.ts";
import { ensureStateDir } from "./snapshot.ts";
import { DEFAULT_SNAPSHOT_INTERVAL_MS, startServer } from "./server.ts";

export const READY_TOKEN = "ready\n";

export async function daemonMain(args: string[]): Promise<number> {
  let dir = defaultRuntimeDir();
  let stateDir = defaultStateDir();
  let readyFd: number | null = null;
  let readyFile: string | null = null;
  const envInterval = Number(process.env.WP_SNAPSHOT_INTERVAL_MS);
  let snapshotIntervalMs =
    Number.isFinite(envInterval) && envInterval > 0
      ? envInterval
      : DEFAULT_SNAPSHOT_INTERVAL_MS;
  for (const a of args) {
    if (a.startsWith("--dir=")) dir = a.slice("--dir=".length);
    else if (a.startsWith("--state-dir="))
      stateDir = a.slice("--state-dir=".length);
    else if (a.startsWith("--snapshot-interval="))
      snapshotIntervalMs = Number(a.slice("--snapshot-interval=".length));
    else if (a.startsWith("--ready-fd="))
      readyFd = Number(a.slice("--ready-fd=".length));
    else if (a.startsWith("--ready-file="))
      readyFile = a.slice("--ready-file=".length);
    else {
      console.error(`wp __daemon: unknown argument ${a}`);
      return 2;
    }
  }

  const report = (text: string) => {
    if (readyFile !== null) {
      // The win32 launcher's channel (launch.ts): a whole file, renamed into
      // place so the poller never reads half a line.
      try {
        fs.writeFileSync(`${readyFile}.tmp`, text);
        fs.renameSync(`${readyFile}.tmp`, readyFile);
      } catch {}
      readyFile = null;
    }
    if (readyFd === null) return;
    try {
      fs.writeSync(readyFd, text);
      fs.closeSync(readyFd);
    } catch {}
    readyFd = null;
  };

  try {
    ensureRuntimeDir(dir);
    ensureStateDir(stateDir);
  } catch (e) {
    report(`error: ${String((e as Error).message ?? e)}\n`);
    console.error(String(e));
    return 1;
  }
  const paths = daemonPaths(dir, stateDir);

  const lock = tryLock(paths.lock);
  if (!lock) {
    report("error: a daemon already holds the lock\n");
    console.error(`wp __daemon: another daemon holds ${paths.lock}`);
    return 1;
  }

  const logFd = fs.openSync(paths.log, "a");
  const log = (line: string) => {
    try {
      fs.writeSync(logFd, `${new Date().toISOString()} ${line}\n`);
    } catch {}
  };

  let server;
  try {
    server = await startServer(paths, log, { snapshotIntervalMs });
  } catch (e) {
    log(`failed to start: ${(e as Error)?.stack ?? e}`);
    report(`error: ${String((e as Error).message ?? e)}\n`);
    lock.release();
    return 1;
  }

  // Each of these ends in the same graceful shutdown, snapshots included.
  // They are delivered to the detached daemon (setsid, no tty) as to any
  // process; the M3 tests send a real SIGTERM to the pid and check the files.
  //
  // Not on Windows (spike/win32-daemon): Bun's signal handlers there ride on
  // console control events, and a daemon spawned detached has no console, so
  // none of them could ever fire. `proc.kill()` from a launcher or a test is
  // `TerminateProcess`, which no handler sees either. Shutdown on Windows is
  // the `shutdown` message over the socket, and only that.
  if (process.platform !== "win32") {
    for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
      process.on(sig, () => server.shutdown(sig));
    }
  }
  process.on("uncaughtException", (e) => log(`uncaught: ${e?.stack ?? e}`));
  process.on("unhandledRejection", (e) =>
    log(`unhandled rejection: ${(e as Error)?.stack ?? e}`),
  );

  report(READY_TOKEN);
  return new Promise(() => {}); // runs until shutdown() calls process.exit
}
