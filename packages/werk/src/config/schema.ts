/**
 * What werk can be configured to do, and what it does when nobody says.
 *
 * Only settings the CLI acts on today appear here. A key invented for a feature
 * that does not exist yet reads back later as a decision somebody took, so this
 * grows when the feature does and not before.
 *
 * The field table is the single source of truth for the rest of the config
 * layer: the keys, the environment variable each one answers to, how a raw
 * value out of a TOML file or the environment becomes a typed one, and what
 * `werk config` prints beside it. Nothing else enumerates the keys.
 */
import os from "node:os";
import {
  ACCENTS,
  DEFAULT_ACCENT,
  flavours,
  type AccentName,
  type FlavourName,
} from "@werk/palette";
import { defaultSessionRuntimeDir, type LogLevel } from "@werk/session-daemon";
import { defaultStateDir } from "../runtime/context.js";
import { UsageError } from "../runtime/exit.js";

/** What to do about colour when the terminal has not already settled it. */
export type ColourPreference = "auto" | "always" | "never";

/**
 * Which Catppuccin flavour to wear, or `auto` to ask the terminal.
 *
 * `auto` resolves through `flavourLight` and `flavourDark` rather than to a
 * fixed pair, so someone who prefers Frappé to Mocha on a dark ground keeps the
 * detection and changes what it lands on.
 */
export type FlavourPreference = FlavourName | "auto";

export interface WerkConfig {
  /** How much the daemon writes to its log. */
  logLevel: LogLevel;
  /** Where the daemon socket and endpoint record live. */
  runtimeDir: string;
  /** Where checkpoints, logs and the daemon record live. */
  stateDir: string;
  /** Bytes of output a new session asks to keep. The daemon caps this. */
  scrollbackBytes: number;
  colour: ColourPreference;
  /** The flavour werk wears, or `auto` to suit the terminal's own ground. */
  flavour: FlavourPreference;
  /** What `auto` resolves to on a dark ground. */
  flavourDark: FlavourName;
  /** What `auto` resolves to on a light ground. */
  flavourLight: FlavourName;
  /** Which of Catppuccin's fourteen accents marks the thing being attended to. */
  accent: AccentName;
}
export type ConfigKey = keyof WerkConfig;
export type ConfigValue = WerkConfig[ConfigKey];

export interface ConfigField<K extends ConfigKey> {
  /** `WERK_` plus the key in screaming snake case, for every key. */
  readonly env: string;
  readonly describe: string;
  /** Raw as a file or the environment gave it; throws when it is not usable. */
  parse(raw: unknown): WerkConfig[K];
}

const LOG_LEVELS = ["error", "warn", "info", "debug"] as const;
const COLOURS = ["auto", "always", "never"] as const;
const FLAVOURS = Object.keys(flavours) as readonly FlavourName[];
const FLAVOUR_PREFERENCES = [
  "auto",
  ...FLAVOURS,
] as readonly FlavourPreference[];

function oneOf<T extends string>(key: string, allowed: readonly T[]) {
  return (raw: unknown): T => {
    if (typeof raw === "string" && (allowed as readonly string[]).includes(raw))
      return raw as T;
    throw new UsageError(`${key} must be one of ${allowed.join(", ")}`);
  };
}
function directory(key: string) {
  return (raw: unknown): string => {
    if (typeof raw === "string" && raw !== "") return raw;
    throw new UsageError(`${key} must be a path`);
  };
}
/** TOML hands over a number; the environment hands over the digits of one. */
function byteCount(key: string) {
  return (raw: unknown): number => {
    const value = typeof raw === "string" ? Number(raw) : raw;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
      throw new UsageError(`${key} must be a whole number of bytes`);
    return value;
  };
}

export const FIELDS: { readonly [K in ConfigKey]: ConfigField<K> } = {
  logLevel: {
    env: "WERK_LOG_LEVEL",
    describe: "daemon log level",
    parse: oneOf<LogLevel>("logLevel", LOG_LEVELS),
  },
  runtimeDir: {
    env: "WERK_RUNTIME_DIR",
    describe: "where the daemon socket and endpoint live",
    parse: directory("runtimeDir"),
  },
  stateDir: {
    env: "WERK_STATE_DIR",
    describe: "where checkpoints, logs and the daemon record live",
    parse: directory("stateDir"),
  },
  scrollbackBytes: {
    env: "WERK_SCROLLBACK_BYTES",
    describe: "bytes of output a new session keeps",
    parse: byteCount("scrollbackBytes"),
  },
  colour: {
    env: "WERK_COLOUR",
    describe: "colour preference (auto, always, never)",
    parse: oneOf<ColourPreference>("colour", COLOURS),
  },
  flavour: {
    env: "WERK_FLAVOUR",
    describe: "Catppuccin flavour, or auto to suit the terminal",
    parse: oneOf<FlavourPreference>("flavour", FLAVOUR_PREFERENCES),
  },
  flavourDark: {
    env: "WERK_FLAVOUR_DARK",
    describe: "what auto wears on a dark terminal",
    parse: oneOf<FlavourName>("flavourDark", FLAVOURS),
  },
  flavourLight: {
    env: "WERK_FLAVOUR_LIGHT",
    describe: "what auto wears on a light terminal",
    parse: oneOf<FlavourName>("flavourLight", FLAVOURS),
  },
  accent: {
    env: "WERK_ACCENT",
    describe: "which Catppuccin accent marks the active thing",
    parse: oneOf<AccentName>("accent", ACCENTS),
  },
};
export const CONFIG_KEYS = Object.keys(FIELDS) as readonly ConfigKey[];

/**
 * The lowest layer. `WERK_RUNTIME_DIR` is dropped on the way in because
 * `defaultSessionRuntimeDir` honours it: leaving it would attribute a value the
 * caller set in the environment to werk's own defaults, and provenance is the
 * whole point of the layer stack.
 */
export function builtInDefaults(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): WerkConfig {
  const { WERK_RUNTIME_DIR: _ignored, ...rest } = env;
  return {
    logLevel: "info",
    runtimeDir: defaultSessionRuntimeDir(rest),
    stateDir: defaultStateDir(env, home),
    // The daemon refuses anything above its own cap, so asking for more than
    // this would only ever be refused.
    scrollbackBytes: 10_000_000,
    colour: "auto",
    // Mocha and mauve are Catppuccin's conventional defaults, and dark is what
    // every tool that probes a terminal falls back to when it learns nothing.
    flavour: "auto",
    flavourDark: "mocha",
    flavourLight: "latte",
    accent: DEFAULT_ACCENT,
  };
}

/**
 * The field table is keyed by the same union as the config, but TypeScript
 * cannot see that `FIELDS[key].parse` returns `WerkConfig[typeof key]` for a key
 * only known at runtime, so the assignment is widened here, once.
 */
function take(into: Partial<WerkConfig>, key: ConfigKey, raw: unknown): void {
  (into as Record<ConfigKey, ConfigValue>)[key] = FIELDS[key].parse(raw);
}
/**
 * A layer as read from a file or the environment, narrowed to the keys werk
 * knows and the types it expects.
 *
 * Keys it does not know are ignored rather than refused, so a line the client
 * has no meaning for does not stop it starting.
 */
export function coerceLayer(
  raw: Record<string, unknown> | null | undefined,
): Partial<WerkConfig> {
  const values: Partial<WerkConfig> = {};
  if (!raw) return values;
  for (const key of CONFIG_KEYS) {
    const value = raw[key];
    if (value === undefined || value === null) continue;
    take(values, key, value);
  }
  return values;
}
