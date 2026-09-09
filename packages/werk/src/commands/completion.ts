/**
 * Tab completion: the script a shell installs, and the command that script asks.
 *
 * `werk completion <shell>` prints a script to install once. That script then
 * calls the hidden `werk complete` on every TAB, which answers in cobra's
 * `__complete` protocol. Splitting it that way is what lets a candidate be
 * looked up rather than written into the script: the shell asks werk what a
 * live session is called, so the answer is right without the script being
 * generated again.
 *
 * `complete` is hidden because it is not for people: it is a wire format.
 *
 * `complete` is the one command that does not go through `withContext`. It
 * reads the configuration layers itself, under a deadline it can abandon, and
 * builds its own context from what arrived, because a shell is blocked on it
 * for every keystroke of a TAB. Every other command waits however long the
 * layers take.
 */
import type { Command } from "@commander-js/extra-typings";
import bash from "../completion/scripts/bash.sh" with { type: "text" };
import zsh from "../completion/scripts/zsh.sh" with { type: "text" };
import fish from "../completion/scripts/fish.sh" with { type: "text" };
import { completionFor } from "../completion/candidates.js";
import { result } from "../runtime/output.js";
import { loadWerkConfig } from "../config/load.js";
import { NOTHING, writeReply } from "../completion/protocol.js";
import { createContext, type GlobalFlags } from "../runtime/context.js";
import { placeFromConfig } from "../host/place.js";
import { roles } from "@werk/palette";
import { childCommand, withContext } from "./shared.js";
import { defineCommand } from "./define.js";

/** Longest completion will wait for the configuration layers before ignoring them. */
const CONFIG_BUDGET_MS = 50;

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
  const command = defineCommand({
    name: "completion",
    summary: "Print a shell completion script",
    description:
      "Print the script a shell installs once. From then on the shell asks " +
      "werk on every TAB, so the candidates come from the running command " +
      "tree and stay right without the script being generated again.",
    examples: Object.values(SCRIPTS).map((script) => ({
      run: script.install,
    })) as [{ run: string }, ...{ run: string }[]],
  });
  for (const [shell, script] of Object.entries(SCRIPTS))
    command.addCommand(
      defineCommand({
        name: shell,
        summary: `Print the ${shell} completion script`,
        description:
          `Print the completion script for ${shell}. Install it once; from ` +
          `then on the shell asks werk for candidates on every TAB.`,
        examples: [
          { run: script.install, note: "install it" },
          { run: `werk completion ${shell}`, note: "print it" },
        ],
      })
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
    defineCommand({
      name: "complete",
      summary: "Answer a shell with the candidates for a partly typed line",
      description:
        "The machine side of completion. The installed shell script calls " +
        "this on every TAB, and it answers in cobra's __complete protocol. " +
        "It is a wire format rather than something a person types.",
      usage: "-- <words...>",
      examples: [{ run: "werk complete -- attach ''" }],
    })
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
        // The whole merge, hosts included. They cost nothing extra — the same
        // read produced them — and they are what `--host <TAB>` offers.
        const config = await Promise.race([
          loadWerkConfig({ flags }).catch(() => undefined),
          new Promise<undefined>((resolve) => {
            timer = setTimeout(() => resolve(undefined), CONFIG_BUDGET_MS);
          }),
        ]).finally(() => clearTimeout(timer));
        const ctx = createContext(
          flags,
          { entry: "", level: 0, theme: roles() },
          config,
        );
        // Which machine the line would act on, and where workspaces go on it,
        // settled from those same layers. `reachHost` answers this by opening
        // the machine, which a TAB may not do, so the configuration answers it
        // instead and an ssh host that never wrote its `workspaceRoot` down
        // leaves the workspace aliases out rather than reading another
        // machine's paths against this one's root.
        const place = placeFromConfig(ctx);
        const reply = await completionFor(self.parent ?? self, typed, {
          ...ctx,
          ...(place?.root === undefined ? {} : { root: place.root }),
          ...(place?.reference === undefined
            ? {}
            : { reference: place.reference }),
        }).catch(() => NOTHING);
        writeReply(reply, ctx.write);
      })
  );
}
