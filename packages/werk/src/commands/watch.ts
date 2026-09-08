/**
 * Following what the daemon is doing, as it happens.
 *
 * A stream has no end to render, so this writes as it goes and returns nothing.
 * It writes JSON lines whether or not `--json` was asked for: the events are the
 * daemon's own vocabulary, the shape is what anything reading a pipe already
 * parses, and a second rendering for a person to read would be a second thing to
 * keep correct.
 */
import { Command } from "@commander-js/extra-typings";
import type { DaemonEvent } from "@werk/session";
import { withContext } from "./shared.js";
import { defineCommand } from "./define.js";
import { connectDaemon } from "../runtime/daemon.js";

export function buildWatch(): Command {
  return defineCommand({
    name: "watch",
    summary: "Print daemon events as JSON lines until interrupted",
    description:
      "Follow what the daemon is doing as it happens. Every event is printed " +
      "as one JSON line, with or without --json. There is no separate " +
      "rendering for a person to read, because a second description of the " +
      "same events would be a second thing to keep correct.",
    examples: [
      { run: "werk watch" },
      { run: "werk watch | jq 'select(.type == \"exited\")'" },
    ],
    notes: "Runs until it is interrupted.",
  }).action(
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
