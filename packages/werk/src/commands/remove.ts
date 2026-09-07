/**
 * Forgetting a session.
 *
 * The daemon answers with nothing, so the record printed here is werk's own:
 * something has to come back under `--json`, and "which id went" is the only
 * fact there is.
 */
import { Command } from "@commander-js/extra-typings";
import { withContext } from "./shared.js";
import { sessionArgument } from "./session-argument.js";
import { result } from "../runtime/output.js";
import { connectDaemon } from "../runtime/daemon.js";

export function buildRemove(): Command {
  const remove: Command = new Command("remove");
  remove
    .alias("rm")
    .description("Remove a retained session record")
    .addArgument(sessionArgument())
    .addHelpText(
      "after",
      `
Examples:
  $ werk remove 8f2c1b04e9d1

A session whose process is still running has to be killed first.`,
    )
    .action(
      withContext(async (ctx, _opts: unknown, id: string) => {
        const client = await connectDaemon(ctx);
        try {
          await client.remove(id);
          return result(
            { id, removed: true },
            (c) => `${c.colour.dim("removed")} ${id}`,
          );
        } finally {
          await client.close();
        }
      }),
    );
  return remove;
}
