/**
 * What a command is handed: where to write, whether it may colour, whether the
 * caller wants JSON, and how to reach a daemon.
 *
 * Commands take this rather than reaching for `process` directly, so that a test
 * can run one against string buffers with no terminal and no daemon.
 */
import os from "node:os";
import path from "node:path";
import { type ColourLevel } from "./colour.js";
import { createStyles, type Styles } from "./style.js";
import { defaultSessionRuntimeDir } from "@werk/session-daemon";
import type { WerkConfig } from "../config/schema.js";

export interface GlobalFlags {
  json?: boolean;
  runtimeDir?: string;
  stateDir?: string;
  logLevel?: string;
  noInput?: boolean;
  yes?: boolean;
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
  readonly entry: string;
}
/** The state directory werk has always used; kept so existing state is found. */
export function defaultStateDir(
  env = process.env,
  home = os.homedir(),
): string {
  return path.join(
    env.XDG_STATE_HOME ?? path.join(home, ".local", "state"),
    "werk",
  );
}
/**
 * A terminal that cannot say how wide it is. `process.stdout.columns` is `0`
 * rather than undefined on a pty whose size was never set — which happens under
 * `script`, inside some containers, and on an ssh session that lost its window
 * size — and `0` would otherwise pass through `??` and collapse every flexible
 * column to its floor.
 */
const DEFAULT_COLUMNS = 80;
export function terminalColumns(reported: number | undefined): number {
  return reported !== undefined && Number.isFinite(reported) && reported > 0
    ? reported
    : DEFAULT_COLUMNS;
}
/** CI runners report a TTY often enough that prompting there still hangs a job. */
function inCI(env: Record<string, string | undefined>): boolean {
  return (
    env.CI !== undefined &&
    env.CI !== "" &&
    env.CI !== "0" &&
    env.CI !== "false"
  );
}
/**
 * `level` is decided once in `main.ts` and passed in rather than recomputed here,
 * so that `--color` and `--no-color` govern command output and help identically.
 * Recomputing would silently drop them: they are resolved from the raw argv,
 * which this has no access to.
 */
export function createContext(
  flags: GlobalFlags,
  entry: string,
  level: ColourLevel,
  config?: WerkConfig,
): WerkContext {
  const env = process.env;
  const stdoutTTY = process.stdout.isTTY === true;
  const stdinTTY = process.stdin.isTTY === true;
  return {
    write: (text) => void process.stdout.write(text),
    writeError: (text) => void process.stderr.write(text),
    stdoutTTY,
    stdinTTY,
    columns: terminalColumns(process.stdout.columns),
    style: createStyles(level),
    colourLevel: level,
    json: flags.json === true,
    noInput: flags.noInput === true || !stdinTTY || !stdoutTTY || inCI(env),
    yes: flags.yes === true,
    // The merged configuration has already applied the flags, so it wins where
    // it is present; the fallbacks are only for the completion path, which does
    // not read configuration at all.
    runtimeDir: path.resolve(
      config?.runtimeDir ?? flags.runtimeDir ?? defaultSessionRuntimeDir(),
    ),
    stateDir: path.resolve(
      config?.stateDir ?? flags.stateDir ?? defaultStateDir(env),
    ),
    logLevel: config?.logLevel ?? flags.logLevel ?? env.WERK_LOG_LEVEL,
    entry,
  };
}
