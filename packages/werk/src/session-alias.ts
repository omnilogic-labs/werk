/**
 * What a session answers to, and how a typed word is turned into an id.
 *
 * This sits outside both `commands/` and `completion/` because both need it and
 * neither may import the other: `session-argument` hangs
 * {@link sessionCandidates} on its positional, so a completer that reached back
 * into the command would close a cycle. Sharing the derivation is the point
 * rather than a convenience. Completion offers what {@link resolveSession}
 * accepts because the same function computes both, so the two cannot drift into
 * offering a word the command refuses, or refusing a word it offered.
 */
import type { SessionInfo } from "@werk/session";
import { workspaceAt } from "@werk/workspace";
import { UsageError } from "./runtime/exit.js";

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

/**
 * The aliases of one session, as the daemon on `host` describes it.
 *
 * `root` is where workspaces go on that machine, and `host` decides which path
 * grammar the directories are read with: a path on another machine is not a
 * path on this one. Absent means this machine.
 *
 * An absent `root` is a caller that could not find out where workspaces go, and
 * it costs the workspace alias rather than being guessed at. Guessing would
 * mean resolving the session's directory against this process's own, which can
 * land on a two-part relative path and name a workspace that does not exist.
 */
export function aliasOf(
  session: SessionInfo,
  root: string | undefined,
  host?: string,
): SessionAlias {
  const workspace =
    root === undefined ? undefined : workspaceAt(root, session.cwd, host)?.name;
  return {
    id: session.id,
    name: session.name,
    ...(workspace === undefined ? {} : { workspace }),
  };
}

/** {@link aliasOf} over a list, for a caller that wants the whole set. */
export function aliasesOf(
  sessions: readonly SessionInfo[],
  root: string | undefined,
  host?: string,
): SessionAlias[] {
  return sessions.map((session) => aliasOf(session, root, host));
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
