/**
 * The `<session>` positional, with its completion provider attached.
 *
 * Four commands take a session and all four should complete one from the live
 * daemon, so the argument is built once here rather than declared four times.
 * The provider is hung on this `Argument` object itself — see `completion/hooks`
 * — which is what keeps the completion tree from becoming a second tree that
 * drifts away from the parsed one.
 */
import { Argument } from "@commander-js/extra-typings";
import { completes } from "../completion/hooks.js";
import { sessionCandidates } from "../completion/candidates.js";

export const sessionArgument = (): Argument =>
  completes(new Argument("<session>", "session ID"), sessionCandidates);
