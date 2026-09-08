/**
 * Saying what is happening while a workspace is being made on another machine.
 *
 * `werk create` against a machine is probe, install, start a daemon, prepare a
 * repository, push a history and check out. On a cold machine over a slow link
 * that is a minute and a half, and a minute and a half of a blank terminal is
 * indistinguishable from a hang. So the maker reports its stages and this turns
 * them into whichever of werk's three registers the caller is in.
 *
 * | Register | What it gets | Where |
 * | --- | --- | --- |
 * | `--json` | nothing at all | — |
 * | `--no-input` | one line per stage begun | stderr |
 * | a terminal | a spinner whose message is the stage | stderr |
 *
 * `--json` gets nothing because the machine register is one value on stdout and
 * nothing else, which `test/json-output.test.ts` enforces. The other two go to
 * stderr for the reason everything werk says about itself does: whatever ends
 * up on stdout is the answer, and progress is not part of it.
 *
 * The spinner comes from `runtime/interactive.ts` rather than from clack
 * directly. No command may import `@clack/prompts`, and a test asserts it,
 * because the deadline and the cancel-sentinel conversion those wrappers do are
 * the two things that must never be skipped.
 */
import type { WorkspaceProgress, WorkspaceStep } from "@werk/workspace";
import type { WerkContext } from "./context.js";
import { spinner } from "./interactive.js";

/**
 * What each stage is called, as a sentence about a machine somebody named.
 *
 * All seven, including the three no maker emits today: the ssh maker assumes a
 * machine that is already reachable and already has git, so it reports nothing
 * for reaching, installing or starting a daemon. A maker that provisions one
 * would, and a renderer that only knew the stages it had seen would then be
 * silent for the slowest part of the slowest case.
 */
export const stepText = (step: WorkspaceStep, host: string): string =>
  ({
    "resolve-source": "reading the repository",
    "reach-host": `reaching ${host}`,
    "install-werk": `installing werk on ${host}`,
    "start-daemon": `starting the daemon on ${host}`,
    "prepare-repository": `preparing the repository on ${host}`,
    transfer: `sending the history to ${host}`,
    "check-out": `checking out the workspace on ${host}`,
  })[step];

/** One stage, said the way the caller's register says things. */
export function progressLine(
  event: WorkspaceProgress,
  host: string,
): string | undefined {
  if (event.state !== "begin") return undefined;
  const text = stepText(event.step, host);
  // The maker's own words when it has any — "uncommitted changes in 3 files
  // stay on this machine" is the one a person most needs to see, and only the
  // maker knows there were any.
  return event.detail === undefined ? text : `${text} (${event.detail})`;
}

export interface ProgressReporter {
  /** Handed to a `WorkspaceMaker` as its `onProgress`. */
  onProgress(event: WorkspaceProgress): void;
  /** Something outside the maker's vocabulary, said the same way. */
  say(message: string): void;
  /**
   * Give the terminal back. Called before anything else takes it, and in the
   * failure path too, so a spinner never outlives the thing it was spinning
   * for.
   */
  stop(): void;
}

/**
 * The reporter for this caller's register.
 *
 * `host` is the machine's name as werk's configuration spells it, because that
 * is the word the person typed after `--host` and the one they would type again.
 */
export function createProgress(
  ctx: WerkContext,
  host: string,
): ProgressReporter {
  if (ctx.json) return { onProgress: () => {}, say: () => {}, stop: () => {} };
  if (ctx.noInput) {
    const line = (message: string) => ctx.writeError(`${message}\n`);
    return {
      onProgress: (event) => {
        const text = progressLine(event, host);
        if (text !== undefined) line(text);
      },
      say: line,
      stop: () => {},
    };
  }
  const spin = spinner();
  let running = false;
  const show = (message: string) => {
    if (running) spin.message(message);
    else {
      spin.start(message);
      running = true;
    }
  };
  return {
    onProgress: (event) => {
      const text = progressLine(event, host);
      if (text !== undefined) show(text);
    },
    say: show,
    stop: () => {
      if (!running) return;
      running = false;
      // No closing message: what happened is about to be printed properly, and
      // a spinner that signs off says it twice.
      spin.stop("");
    },
  };
}
