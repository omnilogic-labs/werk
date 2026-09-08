#!/usr/bin/env bun
/**
 * The entry point.
 *
 * Three things happen before commander sees anything.
 *
 * The child's argv is split off at the first bare `--`. Commander discards the
 * position of that separator — it flattens everything after it into the same
 * operand list as the command's own positionals — so `werk attach abc -- sh`
 * would be unable to tell `abc` from `sh`. Splitting first is not a workaround
 * for a parser bug so much as a statement about werk: what follows `--` is
 * another program's command line and werk does not parse it at all.
 *
 * The completion callback rides the same split rather than being exempt from it.
 * The shell scripts invoke `werk complete -- <words…>`, so the first bare `--`
 * is exactly the separator, and the words — including a trailing `--` that is
 * itself the word being completed — arrive intact on the other side of it.
 *
 * Then the global flags are lifted to the front, because commander binds an
 * option to the command it was declared on and werk accepts `--runtime-dir`
 * after the command name as well as before it.
 *
 * ## Why the configuration is read here
 *
 * Commander prints a help page during the parse, so everything about how that
 * page looks has to be settled before the parse starts: whether colour may be
 * written, how deep it goes, and which flavour and accent it is written in. The
 * flavour can be set in `~/.werk/config.toml`, so the layers have to be read
 * first, and they are read once here rather than again in every action.
 *
 * That costs about ten milliseconds, nearly all of it asking git for the
 * repository root. It is a move rather than an addition: any command that acts
 * on configuration was already paying it. What the move does add is that
 * `werk --help` pays it too, which is the price of a help page that wears the
 * flavour its reader configured.
 *
 * Completion is the exception and stays one. A shell is blocked on `werk
 * complete` for every TAB, it writes no colour, and it reads the layers itself
 * under a deadline it can abandon. Loading them here as well would put that cost
 * on every keystroke twice over.
 */
import { fileURLToPath } from "node:url";
import tty from "node:tty";
import { roles } from "@werk/palette";
import { buildProgram } from "./app.js";
import {
  globalFlagValues,
  hoistGlobalFlags,
  splitChildArgv,
} from "./runtime/argv.js";
import {
  setRuntimeBasis,
  setChildArgv,
  type RuntimeBasis,
} from "./commands/shared.js";
import {
  errorPayload,
  exitCodeFor,
  CancelledError,
  isCommanderError,
} from "./runtime/exit.js";
import { colourLevelFromArgv } from "./runtime/colour.js";
import { createStyles } from "./runtime/style.js";
import { loadWerkConfig } from "./config/load.js";
import type { GlobalFlags } from "./runtime/context.js";
import { detectGround } from "./runtime/ground.js";
import { probeAllowed, resolveTheme } from "./runtime/theme.js";

/** The commands that must not pay for the configuration layers before parsing. */
const withoutLayers = (argv: readonly string[]): boolean =>
  argv[0] === "complete";

/**
 * Ask the terminal for its background colour, on the real streams.
 *
 * The reply comes back on stdin, so that is what goes into raw mode. `stdout`
 * carries the query rather than `stderr`, because the probe only runs when
 * stdout is the terminal being themed.
 */
async function askTheTerminal(): Promise<"light" | "dark" | undefined> {
  const input = process.stdin as unknown as tty.ReadStream;
  if (typeof input.setRawMode !== "function") return undefined;
  const wasRaw = input.isRaw === true;
  const wasPaused = input.isPaused();
  try {
    const ground = await detectGround({
      input,
      output: process.stdout,
      setRawMode: (on) => void input.setRawMode(on || wasRaw),
    });
    if (wasPaused) input.pause();
    return ground;
  } catch {
    return undefined;
  }
}

async function resolveBasis(
  argv: readonly string[],
  entry: string,
): Promise<RuntimeBasis> {
  // Completion writes no colour and answers on a budget of its own.
  if (withoutLayers(argv)) return { entry, level: 0, theme: roles() };

  const env = process.env;
  const isTTY = process.stdout.isTTY === true;
  // Commander has not run, so the flags are read from the raw argv by the same
  // table that hoisted them. `--flavour` and `--accent` are ordinary settings
  // and reach the merge as the flags layer, like `--runtime-dir` does.
  const flags = globalFlagValues(argv) as GlobalFlags;
  const { config } = await loadWerkConfig({ flags, env });
  const level = colourLevelFromArgv(argv, {
    isTTY,
    env,
    preference: config.colour,
  });
  const ground =
    config.flavour === "auto" &&
    probeAllowed({ level, isTTY, env, attached: false })
      ? await askTheTerminal()
      : undefined;
  const choice = resolveTheme({ config, ground });
  return {
    entry,
    level,
    theme: roles(choice.flavour, choice.accent),
    config,
  };
}

async function main(argv: string[]): Promise<void> {
  const { own, child } = splitChildArgv(argv);
  setChildArgv(child);
  const { globals, rest } = hoistGlobalFlags(own);
  const ordered = [...globals, ...rest];
  const basis = await resolveBasis(ordered, fileURLToPath(import.meta.url));
  setRuntimeBasis(basis);
  await buildProgram(ordered, basis).parseAsync(ordered, { from: "user" });
}

// Guarded so tests and tooling can import this module without running the CLI.
const argv = process.argv.slice(2);
if (import.meta.main)
  main(argv).catch((error: unknown) => {
    const level = colourLevelFromArgv(argv, {
      isTTY: process.stderr.isTTY === true,
      env: process.env,
    });
    const style = createStyles(level);
    // Errors go to stderr in both modes, so a pipe reading stdout sees only the
    // command's own output and never has to distinguish the two.
    // Commander has already written its own message, or the help text.
    if (isCommanderError(error)) {
      process.exitCode = exitCodeFor(error);
      return;
    }
    if (argv.includes("--json"))
      process.stderr.write(JSON.stringify(errorPayload(error)) + "\n");
    else if (!(error instanceof CancelledError))
      process.stderr.write(
        style.error("werk: ") +
          (error instanceof Error ? error.message : String(error)) +
          "\n",
      );
    process.exitCode = exitCodeFor(error);
  });
