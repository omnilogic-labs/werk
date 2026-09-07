/**
 * What a command is handed: where to write, whether it may colour, whether the
 * caller wants JSON, and how to reach a daemon.
 *
 * Commands take this rather than reaching for `process` directly, so that a test
 * can run one against string buffers with no terminal and no daemon.
 */
import os from "node:os";
import path from "node:path";
import { Chalk, type ChalkInstance } from "chalk";
import { type ColourLevel } from "./colour.js";
import { defaultSessionRuntimeDir } from "@werk/session-daemon";

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
  readonly colour: ChalkInstance;
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
): WerkContext {
  const env = process.env;
  const stdoutTTY = process.stdout.isTTY === true;
  const stdinTTY = process.stdin.isTTY === true;
  return {
    write: (text) => void process.stdout.write(text),
    writeError: (text) => void process.stderr.write(text),
    stdoutTTY,
    stdinTTY,
    columns: process.stdout.columns ?? 80,
    colour: new Chalk({ level }),
    colourLevel: level,
    json: flags.json === true,
    noInput: flags.noInput === true || !stdinTTY || !stdoutTTY || inCI(env),
    yes: flags.yes === true,
    runtimeDir: path.resolve(flags.runtimeDir ?? defaultSessionRuntimeDir()),
    stateDir: path.resolve(flags.stateDir ?? defaultStateDir(env)),
    logLevel: flags.logLevel ?? env.WERK_LOG_LEVEL,
    entry,
  };
}
