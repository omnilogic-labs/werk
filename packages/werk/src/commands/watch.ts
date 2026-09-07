/**
 * Following what the daemon is doing, as it happens.
 *
 * A stream has no end to render, so this writes as it goes and returns nothing.
 * It writes JSON lines whether or not `--json` was asked for: the events are the
 * daemon's own vocabulary, the shape is what anything reading a pipe already
 * parses, and a second, prettier rendering would be a second thing to keep true.
 */
import { Command } from "@commander-js/extra-typings";
import type { DaemonEvent } from "@werk/session";
import { withContext } from "./shared.js";
import { connectDaemon } from "../runtime/daemon.js";

export function buildWatch(): Command {
  return new Command("watch")
    .description("Print daemon events as JSON lines until interrupted")
    .addHelpText(
      "after",
      `
Examples:
  $ werk watch
  $ werk watch | jq 'select(.type == "exited")'`,
    )
    .action(
      withContext(async (ctx) => {
        const client = await connectDaemon(ctx);
        try {
          const stop = client.watch((event: DaemonEvent) =>
            ctx.write(JSON.stringify(event) + "\n"),
          );
          await stop.ready;
          let finish!: () => void;
          const done = new Promise<void>((resolve) => (finish = resolve));
          process.once("SIGINT", finish);
          process.once("SIGTERM", finish);
          try {
            await Promise.race([done, client.closed]);
          } finally {
            stop();
            process.off("SIGINT", finish);
            process.off("SIGTERM", finish);
          }
        } finally {
          await client.close();
        }
      }),
    );
}
