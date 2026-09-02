// The `wp __daemon` role. Lifecycle only: lock before bind, bind-then-rename
// (in server.ts), readiness over the inherited pipe, no PID file, no
// signals for control. `--dir=<path>` overrides the runtime directory;
// `--ready-fd=<n>` names the pipe the launcher is waiting on. Both are
// passed by the launcher and absent when a human runs it by hand.

import fs from "node:fs";
import { tryLock } from "./flock.ts";
import { daemonPaths, defaultRuntimeDir, ensureRuntimeDir } from "./paths.ts";
import { startServer } from "./server.ts";

export const READY_TOKEN = "ready\n";

export async function daemonMain(args: string[]): Promise<number> {
  let dir = defaultRuntimeDir();
  let readyFd: number | null = null;
  for (const a of args) {
    if (a.startsWith("--dir=")) dir = a.slice("--dir=".length);
    else if (a.startsWith("--ready-fd="))
      readyFd = Number(a.slice("--ready-fd=".length));
    else {
      console.error(`wp __daemon: unknown argument ${a}`);
      return 2;
    }
  }

  const report = (text: string) => {
    if (readyFd === null) return;
    try {
      fs.writeSync(readyFd, text);
      fs.closeSync(readyFd);
    } catch {}
    readyFd = null;
  };

  try {
    ensureRuntimeDir(dir);
  } catch (e) {
    report(`error: ${String((e as Error).message ?? e)}\n`);
    console.error(String(e));
    return 1;
  }
  const paths = daemonPaths(dir);

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
    server = await startServer(paths, log);
  } catch (e) {
    log(`failed to start: ${(e as Error)?.stack ?? e}`);
    report(`error: ${String((e as Error).message ?? e)}\n`);
    lock.release();
    return 1;
  }

  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(sig, () => server.shutdown(sig));
  }
  process.on("uncaughtException", (e) => log(`uncaught: ${e?.stack ?? e}`));
  process.on("unhandledRejection", (e) =>
    log(`unhandled rejection: ${(e as Error)?.stack ?? e}`),
  );

  report(READY_TOKEN);
  return new Promise(() => {}); // runs until shutdown() calls process.exit
}
