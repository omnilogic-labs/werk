/**
 * What a command is handed: where to write, whether it may colour, whether the
 * caller wants JSON, and how to reach a daemon.
 *
 * Commands take this rather than reaching for `process` directly, so that a test
 * can run one against string buffers with no terminal and no daemon.
 */
import path from "node:path";
import { type ColourLevel } from "./colour.js";
import { createStyles, type Styles } from "./style.js";
import { defaultSessionRuntimeDir } from "@werk/session-daemon";
import type { Roles } from "@werk/palette";
import type { RuntimeBasis } from "../commands/shared.js";
import type { LayerName } from "../config/load.js";
import {
  defaultStateDir,
  type ConfigKey,
  type LandRoute,
  type WerkConfig,
} from "../config/schema.js";
import {
  builtInHosts,
  DEFAULT_HOST,
  type Host,
  type HostProblem,
} from "../config/hosts.js";

/**
 * The configuration a context is built from: the settings, and the hosts that
 * came with them.
 *
 * Two kinds of thing rather than one, because they merge differently — a
 * setting key by key, a host block by block — and a command needs both. A
 * `MergedConfig` satisfies this, so `loadWerkConfig`'s answer is handed over
 * whole rather than taken apart at every call site.
 */
export interface ResolvedConfig {
  readonly config: WerkConfig;
  readonly hosts: Readonly<Record<string, Host>>;
  readonly problems: readonly HostProblem[];
  /**
   * The layer that supplied each setting. Absent only on the completion path,
   * which abandons the layers when they are slow.
   *
   * It is here for the one question a default cannot answer: whether a value is
   * what werk falls back to or what somebody chose. `agent` is empty in both
   * cases, and `werk land` asks in the first and not in the second.
   */
  readonly from?: Readonly<Record<ConfigKey, LayerName>>;
}

/**
 * The global flags as commander hands them over.
 *
 * `input` is spelled the way commander stores it rather than the way it is
 * typed. A `--no-x` option is the negation of `x`, so `--no-input` sets
 * `input` to `false` and leaves it `true` otherwise; there is no `noInput` key
 * to read. Declaring one here would be a type asserting a shape the parser
 * never produces, and the guard below would never fire.
 */
export interface GlobalFlags {
  json?: boolean;
  /** The machine to act on, named with `--host`. */
  host?: string;
  runtimeDir?: string;
  stateDir?: string;
  logLevel?: string;
  input?: boolean;
  yes?: boolean;
  flavour?: string;
  accent?: string;
}
export interface WerkContext {
  write(text: string): void;
  writeError(text: string): void;
  /** True when stdout is a terminal; drives alignment as well as colour. */
  readonly stdoutTTY: boolean;
  readonly stdinTTY: boolean;
  readonly columns: number;
  /** How to style werk's own output. Roles, never colours; see `style.ts`. */
  readonly style: Styles;
  /** The flavour and accent that styling was built from. */
  readonly theme: Roles;
  readonly colourLevel: ColourLevel;
  /** The caller asked for machine-readable output. */
  readonly json: boolean;
  /** Prompting is forbidden: `--no-input`, no terminal, or CI. */
  readonly noInput: boolean;
  /** Confirmations are pre-answered yes. */
  readonly yes: boolean;
  readonly runtimeDir: string;
  readonly stateDir: string;
  readonly logLevel?: string;
  /**
   * Bytes of output a new session asks the daemon to keep. Absent only where no
   * configuration was resolved, which is the completion path, and nothing there
   * starts a session; the daemon applies its own default if it is ever asked
   * without one.
   */
  readonly scrollbackBytes?: number;
  readonly entry: string;
  /**
   * Every host in force, by name. Together with the three below this is what
   * `hostFor` reads to settle which machine a command acts on.
   */
  readonly hosts: Readonly<Record<string, Host>>;
  /** Every host block that could not be read, and why. */
  readonly hostProblems: readonly HostProblem[];
  /** The host a command acts on when `--host` names none. */
  readonly defaultHost: string;
  /** The host `--host` named, when it named one. */
  readonly requestedHost?: string;
  /**
   * The agent werk asks for a commit message and for a conflict resolution,
   * as a command line. Empty means none.
   */
  readonly agent: string;
  /**
   * True when somebody chose the agent, rather than it being what werk falls
   * back to. `werk land` asks the first time it needs one and nobody has.
   */
  readonly agentChosen: boolean;
  /** Which of the three landing routes is in force. */
  readonly landRoute: LandRoute;
}
/**
 * A terminal that cannot say how big it is. `process.stdout.columns` and
 * `process.stdout.rows` are `0` rather than undefined on a pty whose size was
 * never set. That happens under `script`, inside some containers, and on an ssh
 * session that lost its window size, and `0` passes straight through `??`.
 * Downstream that either collapses every flexible column to its floor or asks
 * the daemon for a grid it refuses, depending on who read it.
 *
 * Every reader of a reported dimension goes through this, so the guard cannot
 * be present in one place and missing from the next.
 */
export function reportedSize(
  reported: number | undefined,
  fallback: number,
): number {
  return reported !== undefined && Number.isFinite(reported) && reported > 0
    ? reported
    : fallback;
}
const DEFAULT_COLUMNS = 80;
export function terminalColumns(reported: number | undefined): number {
  return reportedSize(reported, DEFAULT_COLUMNS);
}
/** CI runners report a TTY often enough that prompting there still hangs a job. */
export function inCI(env: Record<string, string | undefined>): boolean {
  return (
    env.CI !== undefined &&
    env.CI !== "" &&
    env.CI !== "0" &&
    env.CI !== "false"
  );
}
/**
 * Whether prompting is forbidden, given what was parsed and what the streams
 * are.
 *
 * Separate from `createContext` because `--no-input` is the only one of the
 * four causes that a test can isolate: the other three are true of any test
 * process, so a context built there is already forbidden from prompting and
 * would pass whether the flag was read or not. This takes the terminal state as
 * an argument, so a test can drive a real argv through the real parser and
 * assert that the flag alone forbids it on a terminal that would otherwise
 * allow it.
 */
export function promptingForbidden(
  flags: GlobalFlags,
  streams: { stdinTTY: boolean; stdoutTTY: boolean },
  env: Record<string, string | undefined>,
): boolean {
  return (
    flags.input === false ||
    !streams.stdinTTY ||
    !streams.stdoutTTY ||
    inCI(env)
  );
}
/**
 * The colour level and the theme are decided once in `main.ts` and passed in
 * rather than recomputed here, so that a help page and a command's output are
 * styled identically. Recomputing would silently drop `--color`, `--no-color`,
 * `--flavour` and `--accent`: they are resolved from the raw argv and the merged
 * layers, neither of which this has access to.
 */
export function createContext(
  flags: GlobalFlags,
  basis: RuntimeBasis,
  resolved?: ResolvedConfig,
): WerkContext {
  const config = resolved?.config;
  const { entry, level, theme } = basis;
  const env = process.env;
  const stdoutTTY = process.stdout.isTTY === true;
  const stdinTTY = process.stdin.isTTY === true;
  return {
    write: (text) => void process.stdout.write(text),
    writeError: (text) => void process.stderr.write(text),
    stdoutTTY,
    stdinTTY,
    columns: terminalColumns(process.stdout.columns),
    style: createStyles(level, theme),
    theme,
    colourLevel: level,
    json: flags.json === true,
    noInput: promptingForbidden(flags, { stdinTTY, stdoutTTY }, env),
    yes: flags.yes === true,
    // The merged configuration has already applied the flags, so it wins where
    // it is present. The fallbacks are for the completion path, which reads the
    // layers on a budget of its own and abandons them when they are slow, so it
    // is the one caller that can arrive here with nothing merged.
    runtimeDir: path.resolve(
      config?.runtimeDir ?? flags.runtimeDir ?? defaultSessionRuntimeDir(),
    ),
    stateDir: path.resolve(
      config?.stateDir ?? flags.stateDir ?? defaultStateDir(env),
    ),
    logLevel: config?.logLevel ?? flags.logLevel ?? env.WERK_LOG_LEVEL,
    scrollbackBytes: config?.scrollbackBytes,
    entry,
    // The same fallback the two directories above take, and for the same
    // caller: completion abandons the layers when they are slow, and a machine
    // werk has without being told is a truthful answer for one that did.
    hosts: resolved?.hosts ?? builtInHosts(),
    hostProblems: resolved?.problems ?? [],
    defaultHost: config?.defaultHost ?? DEFAULT_HOST,
    agent: config?.agent ?? "",
    // Absent provenance is the completion path, which never lands anything.
    // Reading it as "chosen" there is the direction that asks nothing.
    agentChosen:
      resolved?.from === undefined ? true : resolved.from.agent !== "defaults",
    landRoute: config?.landRoute ?? "parent",
    ...(flags.host === undefined ? {} : { requestedHost: flags.host }),
  };
}
