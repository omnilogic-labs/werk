/**
 * The `[session]` positional, and how a command gets an id out of it.
 *
 * Four commands take a session and all four should complete one from the live
 * daemon, so the argument is built once here rather than declared four times.
 * The provider is hung on the real `Argument` object — see `completion/hooks` —
 * which is what keeps the completion tree from becoming a second tree that
 * drifts away from the parsed one.
 *
 * The positional is optional because a person at a terminal should be shown what
 * is running rather than told they typed too little. Optional to commander is
 * not optional to the command: with no terminal to ask in, a missing session is
 * still a usage error, and it is raised before anything connects so that
 * `werk attach </dev/null` never starts a daemon on its way to failing.
 */
import { Argument } from "@commander-js/extra-typings";
import type { SessionClient } from "@werk/session";
import { completes } from "../completion/hooks.js";
import { sessionCandidates } from "../completion/candidates.js";
import { connectDaemon } from "../runtime/daemon.js";
import { canPrompt, selectSession } from "../runtime/interactive.js";
import { UsageError } from "../runtime/exit.js";
import type { WerkContext } from "../runtime/context.js";

export const sessionArgument = (): Argument =>
  completes(new Argument("[session]", "session ID or name"), sessionCandidates);

/**
 * Run `work` against a client, on the session named or the session picked.
 *
 * The daemon is not reached at all when the answer is already known to be a
 * usage error, and the client is closed whichever way `work` ends.
 */
export async function withSession<T>(
  ctx: WerkContext,
  given: string | undefined,
  message: string,
  /** `picked` says the session came from the list rather than the command line. */
  work: (client: SessionClient, id: string, picked: boolean) => Promise<T>,
): Promise<T> {
  if (given === undefined && !canPrompt(ctx))
    throw new UsageError(
      "a session is required when there is no terminal to ask in",
    );
  const client = await connectDaemon(ctx);
  try {
    const id =
      given ?? (await selectSession(ctx, await client.list({}), message));
    return await work(client, id, given === undefined);
  } finally {
    await client.close();
  }
}
