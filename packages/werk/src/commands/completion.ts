/**
 * Tab completion: the script a shell installs, and the command that script asks.
 *
 * `werk completion <shell>` prints a script to install once. That script then
 * calls the hidden `werk complete` on every TAB, which answers in cobra's
 * `__complete` protocol. Splitting it that way is what lets a candidate be
 * looked up rather than baked in — the shell asks werk what a live session is
 * called, so the answer is right without the script being regenerated.
 *
 * `complete` is hidden because it is not for people: it is a wire format.
 */
import { Command } from "@commander-js/extra-typings";
import bash from "../completion/scripts/bash.sh" with { type: "text" };
import zsh from "../completion/scripts/zsh.sh" with { type: "text" };
import fish from "../completion/scripts/fish.sh" with { type: "text" };
import { completionFor } from "../completion/candidates.js";
import { result } from "../runtime/output.js";
import { loadWerkConfig } from "../config/load.js";

/** Longest completion will wait for the configuration layers before ignoring them. */
const CONFIG_BUDGET_MS = 50;
import { NOTHING, writeReply } from "../completion/protocol.js";
import { createContext, type GlobalFlags } from "../runtime/context.js";
import { childCommand, withContext } from "./shared.js";

const SCRIPTS: Record<string, { source: string; install: string }> = {
  bash: {
    source: bash,
    install: "werk completion bash > /etc/bash_completion.d/werk",
  },
  zsh: { source: zsh, install: 'werk completion zsh > "${fpath[1]}/_werk"' },
  fish: {
    source: fish,
    install: "werk completion fish > ~/.config/fish/completions/werk.fish",
  },
};

export function buildCompletion(): Command {
  const command = new Command("completion").description(
    "Print a shell completion script",
  );
  for (const [shell, script] of Object.entries(SCRIPTS))
    command.addCommand(
      new Command(shell)
        .description(`Completion script for ${shell}`)
        // Returns a result rather than writing, so `--json` is answered here
        // like everywhere else. `eval "$(werk completion bash)"` still works
        // because the human rendering is the bare script and nothing else.
        .action(
          withContext(() =>
            result(
              { shell, script: script.source, install: script.install },
              () => script.source,
            ),
          ),
        ),
    );
  command.addHelpText(
    "after",
    "\nExamples:\n" +
      Object.values(SCRIPTS)
        .map((script) => `  $ ${script.install}`)
        .join("\n"),
  );
  return command;
}

/**
 * Answer for the words a shell sends, and answer with something no matter what.
 *
 * Every failure is the empty reply rather than an error: a shell is blocked on
 * this, and a message on stdout would be offered to the user as a candidate.
 */
export function buildComplete(): Command {
  return (
    new Command("complete")
      .description("Emit completion candidates for a partly typed command line")
      .usage("-- <words...>")
      // The words are another command line, so none of it is werk's to reject:
      // whatever the user has typed so far is data to be described, not parsed.
      .allowUnknownOption()
      .allowExcessArguments()
      .action(async (_options, self) => {
        // `main.ts` splits the command line at the first bare `--`, so the words a
        // shell sends after `werk complete --` arrive as the child argv. Both
        // shapes are read, so this holds whichever side of that split moves.
        const typed = self.args.length > 0 ? self.args : [...childCommand()];
        const flags = self.optsWithGlobals() as unknown as GlobalFlags;
        // Completion has to look where the sessions actually are, so it reads
        // the same layers every other command does — but on a budget of its own
        // and falling back to the flags alone. A configured runtime directory
        // that made TAB silently find nothing would be worse than a slow TAB,
        // and a remote layer that hangs must not hang the shell either.
        // The timer is cleared rather than left to fire: a pending timeout keeps
        // Bun's event loop alive to its full deadline, so an uncancelled one
        // would add the whole budget to every TAB even when the layers resolved
        // in a millisecond.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const config = await Promise.race([
          loadWerkConfig({ flags })
            .then((merged) => merged.config)
            .catch(() => undefined),
          new Promise<undefined>((resolve) => {
            timer = setTimeout(() => resolve(undefined), CONFIG_BUDGET_MS);
          }),
        ]).finally(() => clearTimeout(timer));
        const ctx = createContext(flags, "", 0, config);
        const reply = await completionFor(
          self.parent ?? self,
          typed,
          ctx,
        ).catch(() => NOTHING);
        writeReply(reply, ctx.write);
      })
  );
}
