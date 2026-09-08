/**
 * Running and inspecting the daemon.
 *
 * `serve` is what the CLI spawns when a command needs a daemon and none is
 * listening, and it is what an operator points systemd or launchd at. It stays
 * visible in help for that second reason: syncthing keeps `serve` documented for
 * the same purpose, and a hidden command is one an operator cannot discover.
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
import { defineCommand } from "./define.js";
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
  const daemon = defineCommand({
    name: "daemon",
    summary: "Run the session daemon yourself",
    description:
      "The daemon that owns the PTYs. The CLI starts one for you when a " +
      "command needs it, so this is here for an operator who would rather " +
      "supervise it themselves.",
    examples: [{ run: "werk daemon serve", note: "run it in this process" }],
  });
  daemon.addCommand(
    defineCommand({
      name: "serve",
      summary: "Run the daemon in this process until it is signalled",
      description:
        "Runs in the foreground and does not return until it is signalled. " +
        "This is what systemd or launchd is pointed at.",
      examples: [
        { run: "werk daemon serve" },
        { run: "werk daemon serve --log-level debug" },
      ],
      notes: "The CLI starts this for you when a command needs a daemon.",
    }).action(withContext(async (ctx) => void (await serve(ctx)))),
  );
  return daemon;
}
