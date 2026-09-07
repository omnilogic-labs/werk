/**
 * Asking a session's process to stop.
 *
 * The three intents are the daemon's vocabulary, not signal names: what
 * `interrupt`, `terminate` and `force` mean on a platform is the daemon's
 * business, and a daemon advertises which of them it supports.
 */
import { Command, Option } from "@commander-js/extra-typings";
import type { TerminationIntent, TerminationResult } from "@werk/session";
import { withContext } from "./shared.js";
import { outcomeNote } from "./attach.js";
import { sessionArgument, withSession } from "./session-argument.js";
import { confirm } from "../runtime/interactive.js";
import { CancelledError } from "../runtime/exit.js";
import { result } from "../runtime/output.js";
import type { WerkContext } from "../runtime/context.js";

const INTENTS: TerminationIntent[] = ["interrupt", "terminate", "force"];

/**
 * Delivery and outcome are separate facts: a delivered intent may leave the
 * process running, and a session that had already finished reports its outcome
 * without anything being delivered at all.
 */
export function renderTermination(
  id: string,
  value: TerminationResult,
  ctx: WerkContext,
): string {
  const delivery = value.delivered
    ? `${ctx.colour.yellow(value.intent)} sent to ${id}`
    : `${value.intent} was not delivered to ${id}`;
  return value.exit
    ? `${delivery}\n${ctx.colour.dim(outcomeNote(id, value.exit))}`
    : delivery;
}
export function buildKill(): Command {
  const kill: Command = new Command("kill");
  kill
    .description("Ask a session's process to stop")
    .addArgument(sessionArgument())
    .addOption(
      new Option("--intent <INTENT>", "how hard to ask")
        .choices(INTENTS)
        .default("terminate"),
    )
    .addHelpText(
      "after",
      `
Examples:
  $ werk kill 8f2c1b04e9d1
  $ werk kill 8f2c1b04e9d1 --intent interrupt
  $ werk kill 8f2c1b04e9d1 --intent force
  $ werk kill                               pick from a list

The record stays until it is removed; kill stops the process, not the session.`,
    )
    .action(
      withContext(async (ctx, opts: { intent: string }, given?: string) => {
        return await withSession(
          ctx,
          given,
          "Stop which session?",
          async (client, id, picked) => {
            // Only asked when the session was chosen from a list rather than
            // named, so nothing scripted ever meets this: a caller that names a
            // session, or passes --no-input, goes straight through. Picking the
            // wrong row is the mistake worth catching, and `--yes` skips it.
            if (picked && !(await confirm(ctx, `Stop ${id}?`)))
              throw new CancelledError("not stopped");
            const value = await client.terminate(
              id,
              opts.intent as TerminationIntent,
            );
            return result(value, (c) => renderTermination(id, value, c));
          },
        );
      }),
    );
  return kill;
}
