/**
 * Forgetting a session.
 *
 * The daemon answers with nothing, so the record printed here is werk's own:
 * something has to come back under `--json`, and "which id went" is the only
 * fact there is.
 */
import { Command } from "@commander-js/extra-typings";
import { withContext } from "./shared.js";
import { defineCommand } from "./define.js";
import { sessionArgument, withSession } from "./session-argument.js";
import { result } from "../runtime/output.js";

export function buildRemove(): Command {
  const remove: Command = defineCommand({
    name: "remove",
    aliases: ["rm"],
    summary: "Forget a session that has stopped",
    description:
      "Forget a session. werk deletes its record and its saved screen. The " +
      "process is expected to have stopped already.",
    examples: [
      { run: "werk remove 8f2c1b04e9d1" },
      { run: "werk remove", note: "pick from a list" },
    ],
    notes: "A session whose process is still running has to be killed first.",
  });
  remove.addArgument(sessionArgument()).action(
    withContext(async (ctx, _opts: unknown, given?: string) => {
      return await withSession(
        ctx,
        given,
        "Remove which session?",
        async (client, id) => {
          await client.remove(id);
          return result(
            { id, removed: true },
            (c) => `${c.colour.dim("removed")} ${id}`,
          );
        },
      );
    }),
  );
  return remove;
}
