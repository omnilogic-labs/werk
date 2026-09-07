/**
 * Reading what a session has on screen, or what it has kept.
 *
 * The value here is text rather than a record, so `--json` gives back a JSON
 * string: `werk logs ID --json | jq -r .` is the same bytes the plain form
 * prints, with the escaping that makes it safe to carry inside a larger
 * document.
 *
 * History is what the daemon retained, which is a scrollback budget and not a
 * durable output log.
 */
import { Command } from "@commander-js/extra-typings";
import { withContext } from "./shared.js";
import { sessionArgument, withSession } from "./session-argument.js";
import { result } from "../runtime/output.js";

export function buildLogs(): Command {
  const logs: Command = new Command("logs");
  logs
    .description("Print a session's retained screen, or its history")
    .addArgument(sessionArgument())
    .option("--history", "read the retained history rather than the screen")
    .addHelpText(
      "after",
      `
Examples:
  $ werk logs 8f2c1b04e9d1
  $ werk logs 8f2c1b04e9d1 --history
  $ werk logs                               pick from a list

History is the daemon's scrollback budget, not a complete output log.`,
    )
    .action(
      withContext(async (ctx, opts: { history?: boolean }, given?: string) => {
        return await withSession(
          ctx,
          given,
          "Read which session?",
          async (client, id) => {
            const text = opts.history
              ? await client.readHistory(id)
              : await client.readScreen(id);
            return result(text, () => text);
          },
        );
      }),
    );
  return logs;
}
