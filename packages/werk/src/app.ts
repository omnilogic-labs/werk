/**
 * The command tree.
 *
 * Commands live one per file under `commands/` and are registered here. Each is
 * built by `defineCommand` from a spec, so what a command is for and what it
 * needs is declared rather than remembered; see `commands/define.ts`.
 *
 * How a help page reads is `runtime/help.ts`; what it says is here. The colour
 * gate has to answer before parsing begins, because commander prints help
 * during the parse, so it reads the environment and the raw argv rather than
 * parsed flags. `--json` is read the same way and for the same reason — a
 * failure during the parse has to know which register to answer in before any
 * flag has been parsed.
 */
import { Command } from "@commander-js/extra-typings";
import { colourLevelFromArgv } from "./runtime/colour.js";
import { createStyles } from "./runtime/style.js";
import { COMMANDS, HIDDEN_COMMANDS } from "./commands/index.js";
import { describeRoot } from "./commands/define.js";
import { GLOBAL_FLAGS } from "./runtime/argv.js";
import { errorPayload, UsageError, usageMessage } from "./runtime/exit.js";
import { helpConfiguration, helpFooter } from "./runtime/help.js";
// Lives with the chrome that draws it, because the render path cannot import
// this module without closing a cycle back through the command table.
import { DETACH_HINT } from "./view.js";

/**
 * `addCommand` does not copy the parent's settings the way `.command()` does, so
 * without this the help styling, the colour gate and `showGlobalOptions` stop at
 * the first subcommand and `werk daemon serve --help` renders unstyled.
 */
function inherit(command: Command, parent: Command): Command {
  command.copyInheritedSettings(parent);
  for (const child of command.commands) inherit(child as Command, command);
  return command;
}

/**
 * Only the tokens before a bare `--` count: after it, `--json` belongs to the
 * child process. The same rule the colour gate uses.
 */
function jsonRequested(argv: readonly string[]): boolean {
  const end = argv.indexOf("--");
  return (end === -1 ? argv : argv.slice(0, end)).includes("--json");
}

export function buildProgram(
  argv: readonly string[],
  env = process.env,
): Command {
  const level = colourLevelFromArgv(argv, {
    isTTY: process.stdout.isTTY === true,
    env,
  });
  const style = createStyles(level);
  const json = jsonRequested(argv);
  const program = new Command("werk")
    .description("Start a process somewhere and come back to it later.")
    .version("0.0.0", "-V, --version", "print the version and exit")
    .configureHelp(helpConfiguration(style))
    // Commander strips any colour it did not decide on (`command.js`
    // `_getOutputContext`), so handing it the gate is what makes `--color`,
    // `--no-color` and `NO_COLOR` govern help as well as command output. Without
    // this the help module's styles are computed and then thrown away.
    .configureOutput({
      getOutHasColors: () => level > 0,
      getErrHasColors: () => level > 0,
      // A usage failure answers in whichever register was asked for, like every
      // other output werk produces. `--json` gets one object; without it, the
      // rules broken in red and the help below them.
      outputError: json
        ? (str, write) =>
            write(
              JSON.stringify(errorPayload(new UsageError(usageMessage(str)))) +
                "\n",
            )
        : (str, write) => write(style.error(str)),
    })
    // Someone who typed it wrong is shown what right looks like: the failing
    // command's own usage, its options, the global flags and its examples. The
    // machine register says the same thing in one object instead.
    .showHelpAfterError(!json)
    // Commander would exit 1 for a mistyped flag, which is the code werk uses
    // for a failure the daemon reported. Throwing instead lets `main.ts` give
    // usage mistakes their own status; see `exitCodeFor`.
    .exitOverride();
  // Declared from the same table `main.ts` hoists with, so help and parsing
  // always agree about what counts as global.
  for (const { flags, description } of GLOBAL_FLAGS)
    program.option(flags, description);
  for (const build of COMMANDS) program.addCommand(inherit(build(), program));
  for (const build of HIDDEN_COMMANDS)
    program.addCommand(inherit(build(), program), { hidden: true });
  describeRoot(program, {
    examples: [
      {
        run: "werk create --name demo -- claude",
        note: "start a session running claude",
      },
      { run: "werk list", note: "see what is running" },
      { run: "werk attach demo", note: `go back to it (${DETACH_HINT})` },
    ],
  });
  // Registered once, on the root, and inherited by every page below it:
  // commander fires an `afterAll` listener for each ancestor of the command
  // whose help is being printed.
  program.addHelpText("afterAll", ({ command }) =>
    helpFooter(command as Command),
  );
  return program;
}
