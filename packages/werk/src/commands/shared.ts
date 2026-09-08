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
import { defaultRoles, type Roles } from "@werk/palette";
import type { WerkConfig } from "../config/schema.js";

/**
 * What `main.ts` settled before commander began parsing, for the actions that
 * cannot see it.
 *
 * The entry path is needed by `daemonCommand`. The colour level and the theme
 * are resolved from the raw argv and the merged configuration, both of which an
 * action never sees, and both of which have to exist before the parse because a
 * help page is printed during it. The configuration comes along because it has
 * already been read by then: loading it a second time per action would be the
 * same work twice.
 */
export interface RuntimeBasis {
  readonly entry: string;
  readonly level: ColourLevel;
  readonly theme: Roles;
  /**
   * Absent only on the completion path. `complete` never reaches `withContext`
   * at all: it reads the layers itself, under a deadline it can abandon, and
   * builds its own context, because a shell is blocked on it for every
   * keystroke of a TAB and a remote layer that hangs must not hang the shell.
   */
  readonly config?: WerkConfig;
}
let basis: RuntimeBasis = {
  entry: "",
  level: 0,
  theme: defaultRoles,
};
export const setRuntimeBasis = (next: RuntimeBasis) => void (basis = next);

/**
 * What followed `--`. `create` runs it, and `complete` reads it as the words a
 * shell is asking about; nothing else looks at it.
 */
let childArgv: readonly string[] = [];
export const setChildArgv = (value: readonly string[]) =>
  void (childArgv = value);
export const childCommand = (): readonly string[] => childArgv;

type Action<O, A extends unknown[]> = (
  ctx: WerkContext,
  opts: O,
  ...args: A
) => Promise<Result<unknown> | void> | Result<unknown> | void;

export function withContext<O, A extends unknown[]>(run: Action<O, A>) {
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
    // daemon the same way `--runtime-dir` does. `main.ts` reads them once
    // before parsing and carries them on the basis, so the load below is the
    // fallback for a program built without one, as a test does.
    const config = basis.config ?? (await loadWerkConfig({ flags })).config;
    const ctx = createContext(flags, basis, config);
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
