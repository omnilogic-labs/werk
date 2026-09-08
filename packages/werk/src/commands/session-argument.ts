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
import type { SessionClient, SessionInfo } from "@werk/session";
import { workspaceAt } from "@werk/workspace";
import { workspaceRoot } from "./create.js";
import { completes } from "../completion/hooks.js";
import { sessionCandidates } from "../completion/candidates.js";
import { connectDaemon } from "../runtime/daemon.js";
import { canPrompt, selectSession } from "../runtime/interactive.js";
import { UsageError } from "../runtime/exit.js";
import type { WerkContext } from "../runtime/context.js";

export const sessionArgument = (): Argument =>
  completes(
    new Argument("[session]", "session id, name or workspace"),
    sessionCandidates,
  );

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
    throw new UsageError("name a session; there is no terminal to pick one in");
  const daemon = await connectDaemon(ctx);
  const { client } = daemon;
  try {
    const id =
      given === undefined
        ? await selectSession(ctx, await client.list({}), message)
        : resolveSession(
            aliasesOf(await client.list({}), workspaceRoot(ctx)),
            given,
          );
    return await work(client, id, given === undefined);
  } finally {
    await daemon.close();
  }
}

/**
 * What a session answers to, in the order the answers are believed.
 *
 * The id is first because it is the only thing guaranteed unique. The name is
 * next because it is what completion offers and what `create` printed back.
 * The workspace is last because it is a property of where the session is
 * running rather than of the session, but it is on screen in `werk list` and
 * carries a digest, so it is often the shortest unique thing to hand.
 */
export interface SessionAlias {
  id: string;
  name: string;
  /** The workspace this session is running in, when it is running in one. */
  workspace?: string;
}

/** The aliases of a session as the daemon describes it. */
export function aliasesOf(
  sessions: readonly SessionInfo[],
  root: string,
): SessionAlias[] {
  return sessions.map((s) => ({
    id: s.id,
    name: s.name,
    workspace: workspaceAt(root, s.cwd)?.name,
  }));
}

/** How a session is named back to somebody who has to choose between several. */
const describe = (s: SessionAlias) =>
  s.name ? `${s.id.slice(0, 12)} (${s.name})` : s.id.slice(0, 12);

function decide(given: string, matched: readonly SessionAlias[]): string {
  if (matched.length === 1) return matched[0]!.id;
  throw new UsageError(
    `${given} matches ${matched.length} sessions: ${matched
      .map(describe)
      .join(", ")}; name one by its id`,
  );
}

/**
 * Turn what someone typed into a session id.
 *
 * Ids beat names beat workspaces, and an exact match at any of those beats a
 * prefix, so a name that happens to prefix another id is never silently taken
 * for it. Anything matching more than one session at whichever level decided
 * it says what it matched rather than choosing: the daemon keeps generated
 * names unique, but nothing stops two sessions being given the same one on the
 * wire, and picking the first would attach the caller to a session they did
 * not ask for without saying so.
 */
export function resolveSession(
  sessions: readonly SessionAlias[],
  given: string,
): string {
  for (const same of [
    (s: SessionAlias) => s.id === given,
    (s: SessionAlias) => s.name === given,
    (s: SessionAlias) => s.workspace === given,
  ]) {
    const exact = sessions.filter(same);
    if (exact.length) return decide(given, exact);
  }
  const prefixed = sessions.filter(
    (s) =>
      s.id.startsWith(given) ||
      s.name.startsWith(given) ||
      s.workspace?.startsWith(given),
  );
  if (prefixed.length) return decide(given, prefixed);
  throw new UsageError(`no session called ${given}`);
}
