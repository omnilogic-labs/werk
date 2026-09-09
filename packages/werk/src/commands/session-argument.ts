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
import { reachHost, type HostPlace } from "../host/place.js";
import { canPrompt, selectSession } from "../runtime/interactive.js";
import { UsageError } from "../runtime/exit.js";
import { aliasesOf, resolveSession } from "../session-alias.js";
import type { WerkContext } from "../runtime/context.js";

export const sessionArgument = (): Argument =>
  completes(
    new Argument("[session]", "session id, name or workspace"),
    sessionCandidates,
  );

/**
 * Run `work` against a client, on the session named or the session picked, on
 * whichever machine the command acts on.
 *
 * The daemon is not reached at all when the answer is already known to be a
 * usage error, and both the client and the machine are let go of whichever way
 * `work` ends.
 *
 * It is one daemon and not a fleet: with no `--host` this is the machine werk
 * is running on, with `--host beast` it is that one, and a session on a third
 * machine is not in the list either way. Nothing records where sessions are, so
 * there is nothing to aggregate over.
 */
export async function withSession<T>(
  ctx: WerkContext,
  given: string | undefined,
  message: string,
  /** `picked` says the session came from the list rather than the command line. */
  work: (
    client: SessionClient,
    id: string,
    picked: boolean,
    place: HostPlace,
  ) => Promise<T>,
): Promise<T> {
  if (given === undefined && !canPrompt(ctx))
    throw new UsageError("name a session; there is no terminal to pick one in");
  const place = await reachHost(ctx);
  const daemon = await connectDaemon(ctx, place.session);
  const { client } = daemon;
  try {
    const id =
      given === undefined
        ? await selectSession(ctx, await client.list({}), message)
        : resolveSession(
            aliasesOf(await client.list({}), place.root, place.reference),
            given,
          );
    return await work(client, id, given === undefined, place);
  } finally {
    await daemon.close();
    await place.close().catch(() => {});
  }
}
