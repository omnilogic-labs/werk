/**
 * Running and inspecting the daemon.
 *
 * `serve` is what the CLI spawns when a command needs a daemon and none is
 * listening, and it is what an operator points systemd or launchd at. It stays
 * visible in help for that second reason: syncthing keeps `serve` documented for
 * the same purpose, and a hidden command is one an operator cannot discover.
 *
 * `session-daemon` remains as a hidden alias so anything already invoking it —
 * including a daemon spawned by an older binary — keeps working.
 */
import path from "node:path";
import { Command } from "@commander-js/extra-typings";
import {
  createLogger,
  errorFields,
  installDaemonErrorHandlers,
  parseLogLevel,
  serveSessionDaemon,
} from "@werk/session-daemon";
import { loadTerminalEngine } from "@werk/terminal/bun";
import { withContext } from "./shared.js";
import type { WerkContext } from "../runtime/context.js";

async function serve(ctx: WerkContext): Promise<void> {
  const logLevel = parseLogLevel(ctx.logLevel);
  const log = createLogger({
    file: path.join(ctx.stateDir, "daemon.log"),
    level: logLevel,
  });
  let daemon;
  try {
    daemon = await serveSessionDaemon({
      runtimeDir: ctx.runtimeDir,
      stateDir: ctx.stateDir,
      engineFactory: await loadTerminalEngine(),
      log,
      logLevel,
    });
  } catch (error) {
    log.write("error", "daemon.stop", {
      reason: "startup-failed",
      ...errorFields(error),
    });
    log.close();
    throw error;
  }
  // The daemon records its own pid in $stateDir/daemon.json; nothing here duplicates it.
  let closing = false;
  let removeErrorHandlers = () => {};
  const close = async () => {
    if (closing) return;
    closing = true;
    try {
      await daemon.close();
    } finally {
      process.off("SIGINT", close);
      process.off("SIGTERM", close);
      removeErrorHandlers();
      log.close();
    }
  };
  removeErrorHandlers = installDaemonErrorHandlers({
    log,
    checkpoint: daemon.checkpoint,
    close,
  });
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}

export function buildDaemon(): Command {
  const daemon = new Command("daemon").description(
    "Run and inspect the session daemon",
  );
  daemon
    .command("serve")
    .description("Serve the daemon in this process until it is signalled")
    .addHelpText(
      "after",
      "\nThe CLI starts this for you when a command needs a daemon.\nRun it directly to supervise it yourself.",
    )
    .action(withContext(async (ctx) => void (await serve(ctx))));
  return daemon;
}

/** The pre-`daemon serve` spelling, hidden but still accepted. */
export function buildLegacyDaemon(): Command {
  return new Command("session-daemon")
    .description("Serve the daemon in this process")
    .action(withContext(async (ctx) => void (await serve(ctx))));
}
