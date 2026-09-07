#!/usr/bin/env bun
/**
 * The entry point.
 *
 * Two things happen before commander sees anything.
 *
 * The child's argv is split off at the first bare `--`. Commander discards the
 * position of that separator — it flattens everything after it into the same
 * operand list as the command's own positionals — so `werk attach abc -- sh`
 * would be unable to tell `abc` from `sh`. Splitting first is not a workaround
 * for a parser bug so much as a statement about werk: what follows `--` is
 * another program's command line and werk does not parse it at all.
 *
 * The completion path is exempt from that split, because a shell completing
 * `werk attach --<TAB>` sends a literal `--` as the word being completed.
 *
 * Then the global flags are lifted to the front, because commander binds an
 * option to the command it was declared on and werk accepts `--runtime-dir`
 * after the command name as well as before it.
 */
import { fileURLToPath } from "node:url";
import { buildProgram } from "./app.js";
import { hoistGlobalFlags, splitChildArgv } from "./runtime/argv.js";
import { setRuntimeBasis, setChildArgv } from "./commands/shared.js";
import { errorPayload, exitCodeFor, CancelledError } from "./runtime/exit.js";
import { colourLevelFromArgv } from "./runtime/colour.js";
import { Chalk } from "chalk";

async function main(argv: string[]): Promise<void> {
  const { own, child } = splitChildArgv(argv);
  setChildArgv(child);
  const { globals, rest } = hoistGlobalFlags(own);
  const ordered = [...globals, ...rest];
  setRuntimeBasis(
    fileURLToPath(import.meta.url),
    colourLevelFromArgv(ordered, {
      isTTY: process.stdout.isTTY === true,
      env: process.env,
    }),
  );
  await buildProgram(ordered).parseAsync(ordered, { from: "user" });
}

// Guarded so tests and tooling can import this module without running the CLI.
const argv = process.argv.slice(2);
if (import.meta.main)
  main(argv).catch((error: unknown) => {
    const level = colourLevelFromArgv(argv, {
      isTTY: process.stderr.isTTY === true,
      env: process.env,
    });
    const c = new Chalk({ level });
    // Errors go to stderr in both modes, so a pipe reading stdout sees only the
    // command's own output and never has to distinguish the two.
    if (argv.includes("--json"))
      process.stderr.write(JSON.stringify(errorPayload(error)) + "\n");
    else if (!(error instanceof CancelledError))
      process.stderr.write(
        c.red("werk: ") +
          (error instanceof Error ? error.message : String(error)) +
          "\n",
      );
    process.exitCode = exitCodeFor(error);
  });
