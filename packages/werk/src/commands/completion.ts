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
        .action(withContext((ctx) => void ctx.write(script.source))),
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
        const ctx = createContext(
          self.optsWithGlobals() as unknown as GlobalFlags,
          "",
          0,
        );
        const reply = await completionFor(
          self.parent ?? self,
          typed,
          ctx,
        ).catch(() => NOTHING);
        writeReply(reply, ctx.write);
      })
  );
}
