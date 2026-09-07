/**
 * The command tree.
 *
 * Commands live one per file under `commands/` and are registered here. Each is
 * built by `defineCommand` from a spec, so what a command is for and what it
 * needs is declared rather than remembered; see `commands/define.ts`.
 *
 * Help styling is wired to werk's own colour gate rather than to commander's:
 * the gate has to answer before parsing begins, because commander prints help
 * during the parse, so it reads the environment and the raw argv rather than
 * parsed flags. `--json` is read the same way and for the same reason — a
 * failure during the parse has to know which register to answer in before any
 * flag has been parsed.
 */
import { Command } from "@commander-js/extra-typings";
import { colourLevelFromArgv } from "./runtime/colour.js";
import { Chalk } from "chalk";
import { COMMANDS, HIDDEN_COMMANDS } from "./commands/index.js";
import { GLOBAL_FLAGS } from "./runtime/argv.js";
import { errorPayload, UsageError, usageMessage } from "./runtime/exit.js";

export const DETACH_HINT = "Ctrl-] detaches";

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
  const c = new Chalk({ level });
  const json = jsonRequested(argv);
  const program = new Command("werk")
    .description("Start a process somewhere and come back to it later.")
    .version("0.0.0", "-V, --version", "print the version and exit")
    .configureHelp({
      styleTitle: (s) => c.bold(s),
      styleCommandText: (s) => c.cyan(s),
      styleSubcommandTerm: (s) => c.cyan(s),
      styleOptionTerm: (s) => c.green(s),
      styleArgumentTerm: (s) => c.green(s),
      styleDescriptionText: (s) => c.dim(s),
      showGlobalOptions: true,
    })
    // Commander strips any colour it did not decide on (`command.js`
    // `_getOutputContext`), so handing it the gate is what makes `--color`,
    // `--no-color` and `NO_COLOR` govern help as well as command output. Without
    // this the styles above are computed and then thrown away.
    .configureOutput({
      getOutHasColors: () => level > 0,
      getErrHasColors: () => level > 0,
      // A usage failure answers in whichever register was asked for, like every
      // other output werk produces. `--json` gets the one object the contract
      // promises; without it, the rules broken in red and the help below them.
      outputError: json
        ? (str, write) =>
            write(
              JSON.stringify(errorPayload(new UsageError(usageMessage(str)))) +
                "\n",
            )
        : (str, write) => write(c.red(str)),
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
  program.addHelpText(
    "after",
    `
Examples:
  $ werk create --name demo -- claude       start a session running claude
  $ werk list                               what is running
  $ werk attach demo                        go back to it (${DETACH_HINT})

Every command takes --json for machine-readable output.`,
  );
  return program;
}
