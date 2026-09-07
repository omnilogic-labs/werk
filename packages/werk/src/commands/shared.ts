/**
 * The glue between commander's action signature and werk's command shape.
 *
 * Commander calls an action with the positionals first, then the parsed options,
 * then the command itself. Commands here would rather receive a context and
 * return a value, so this adapts one to the other in a single place and keeps
 * `process` out of every command file.
 */
import type { Command } from "@commander-js/extra-typings";
import {
  createContext,
  type GlobalFlags,
  type WerkContext,
} from "../runtime/context.js";
import type { ColourLevel } from "../runtime/colour.js";
import { emit, type Result } from "../runtime/output.js";
import { unmetRequirements } from "./define.js";
import { EXIT_USAGE, UsageError } from "../runtime/exit.js";
import { loadWerkConfig } from "../config/load.js";

/**
 * Set once by `main.ts`, before any action runs. The entry path is needed by
 * `daemonCommand`; the colour level is resolved from the raw argv, which an
 * action never sees.
 */
let entryPath = "";
let colour: ColourLevel = 0;
export const setRuntimeBasis = (entry: string, level: ColourLevel) => {
  entryPath = entry;
  colour = level;
};

/** What followed `--`, which `create` runs and no other command looks at. */
let childArgv: readonly string[] = [];
export const setChildArgv = (value: readonly string[]) =>
  void (childArgv = value);
export const childCommand = (): readonly string[] => childArgv;

export interface ActionOptions {
  /**
   * Skip the configuration layers. Only the completion callback does this: it
   * runs on every keystroke of a TAB and reads nothing configurable, so the file
   * reads and the c12 import would be latency spent for nothing.
   */
  readonly withoutConfig?: boolean;
}
type Action<O, A extends unknown[]> = (
  ctx: WerkContext,
  opts: O,
  ...args: A
) => Promise<Result<unknown> | void> | Result<unknown> | void;

export function withContext<O, A extends unknown[]>(
  run: Action<O, A>,
  options: ActionOptions = {},
) {
  return async (...all: unknown[]): Promise<void> => {
    const command = all.at(-1) as Command;
    // Rules commander has no notation for are checked before anything runs, so
    // they cost nothing and fail the same way its own do. Commander's checks
    // have already passed by here; when one of them fails instead, these are
    // gathered onto that error rather than waiting for a second run.
    const unmet = unmetRequirements(command);
    if (unmet.length)
      command.error(unmet.map((need) => `error: ${need}`).join("\n"), {
        code: "commander.usage",
        exitCode: EXIT_USAGE,
      });
    const opts = all.at(-2) as O;
    const positionals = all.slice(0, -2) as A;
    // `optsWithGlobals` merges the root's flags in, so `--json` works whether it
    // was typed before or after the command name.
    const flags = command.optsWithGlobals() as GlobalFlags;
    // What a command acts on comes from all six layers rather than from the
    // flags alone, so a `runtimeDir` set in `~/.werk/config.toml` reaches the
    // daemon the same way `--runtime-dir` does.
    const config = options.withoutConfig
      ? undefined
      : (await loadWerkConfig({ flags })).config;
    const ctx = createContext(flags, entryPath, colour, config);
    try {
      emit(ctx, (await run(ctx, opts, ...positionals)) ?? undefined);
    } catch (error) {
      // A rule that only becomes apparent once the command is running — no
      // terminal to pick a session in, a name that matches nothing — is still a
      // usage mistake, so it goes back through commander rather than escaping
      // to the entry point as a bare line. That is what puts the usage, the
      // options and the examples behind it, and it is where any other rule the
      // invocation broke is gathered up with it.
      if (error instanceof UsageError)
        command.error(`error: ${error.message}`, {
          code: "commander.usage",
          exitCode: EXIT_USAGE,
        });
      throw error;
    }
  };
}
