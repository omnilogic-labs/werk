/**
 * Where each layer comes from, and how the six of them become one config.
 *
 * The merge is pure: layers in, the resolved config out, plus the layer every
 * single value came from. That provenance is the reason `werk config list` is
 * worth having at all, so it is computed in one place that a test can drive
 * without a filesystem, a git repository or an environment. Around it sits the
 * thin effectful half — find the git toplevel, read the two TOML files, ask the
 * remote source — in the same shape as `view.ts`.
 *
 * c12 reads the files and nothing else. It is deliberately not asked to merge:
 * it has five fixed slots where werk has six ordered layers, and its `layers`
 * array reports which files it read rather than which layer won each key.
 *
 * c12 is imported dynamically because importing it costs about 21ms against
 * werk's 8.2ms floor. Tab completion must never pay that, and neither should a
 * caller who only wants the pure merge, so the cost lands when a command
 * actually reads a config file and not when this module is loaded.
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import type { GlobalFlags } from "../runtime/context.js";
import { envLayer } from "./env.js";
import {
  CONFIG_KEYS,
  builtInDefaults,
  coerceLayer,
  type ConfigKey,
  type WerkConfig,
} from "./schema.js";
import {
  REMOTE_PREFIX,
  unconfiguredSource,
  type ConfigSource,
} from "./sources.js";

/** Lowest precedence first. This array is the precedence order. */
export const LAYER_ORDER = [
  "defaults",
  "remote",
  "user",
  "project",
  "env",
  "flags",
] as const;
export type LayerName = (typeof LAYER_ORDER)[number];

export interface ConfigLayer {
  name: LayerName;
  /** Where it was read from: a file path, a description, or nothing. */
  origin?: string;
  values: Partial<WerkConfig>;
}
export interface MergedConfig {
  config: WerkConfig;
  /** The layer that supplied the value each key ended up with. */
  from: Record<ConfigKey, LayerName>;
  /** Every layer that was consulted, lowest precedence first. */
  layers: readonly ConfigLayer[];
}

/**
 * Pure. Layers are sorted into `LAYER_ORDER` before merging rather than trusted
 * to arrive in it, so precedence is a property of this module and not of
 * whoever assembled the list.
 */
export function mergeLayers(layers: readonly ConfigLayer[]): MergedConfig {
  const ordered = [...layers].sort(
    (a, b) => LAYER_ORDER.indexOf(a.name) - LAYER_ORDER.indexOf(b.name),
  );
  const config = {} as Record<ConfigKey, unknown>;
  const from = {} as Record<ConfigKey, LayerName>;
  for (const layer of ordered)
    for (const key of CONFIG_KEYS) {
      const value = layer.values[key];
      if (value === undefined) continue;
      config[key] = value;
      from[key] = layer.name;
    }
  const missing = CONFIG_KEYS.filter((key) => from[key] === undefined);
  if (missing.length > 0)
    throw new Error(`No layer supplied ${missing.join(", ")}`);
  return { config: config as WerkConfig, from, layers: ordered };
}

/**
 * The flags werk accepts anywhere on the command line, as a layer. Commander
 * leaves a global option out of `optsWithGlobals()` entirely unless it was
 * typed, so an absent key here means the caller did not ask.
 *
 * `--color` and `--no-color` are missing on purpose: they are resolved from the
 * raw argv before parsing begins, so a parsed-flags layer never sees them.
 */
export function flagsLayer(flags: GlobalFlags): Partial<WerkConfig> {
  return coerceLayer({
    logLevel: flags.logLevel,
    runtimeDir: flags.runtimeDir,
    stateDir: flags.stateDir,
  });
}

/** `~/.werk`, or wherever `WERK_CONFIG_DIR` points instead. */
export function userConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  return env.WERK_CONFIG_DIR
    ? path.resolve(env.WERK_CONFIG_DIR)
    : path.join(home, ".werk");
}

/**
 * The repository the caller is standing in, or undefined outside one.
 *
 * c12 does not walk up from a subdirectory looking for a config file, so the
 * repository root is resolved here and handed to it as `cwd`. Asking git is the
 * only way to get the same answer git would give: a worktree, a submodule and a
 * `.git` file all resolve correctly, and none of them are a parent-directory
 * walk for `.git`.
 */
export function gitToplevel(cwd: string = process.cwd()): string | undefined {
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out === "" ? undefined : out;
  } catch {
    // Not a repository, or no git on PATH. Neither is an error: werk runs fine
    // without a project layer.
    return undefined;
  }
}
/** `<repository>/.werk`, or undefined outside a repository. */
export function projectConfigDir(cwd?: string): string | undefined {
  const top = gitToplevel(cwd);
  return top === undefined ? undefined : path.join(top, ".werk");
}

/** What werk would read in a directory, whether or not anything is there. */
export const configFileIn = (dir: string) => path.join(dir, "config.toml");

interface FileLayer {
  values: Partial<WerkConfig>;
  /** The file that was actually read, absent when there was none. */
  file?: string;
}
/**
 * Read `<dir>/config.toml`, if it exists.
 *
 * Every route c12 would take on its own is switched off: `rcFile` reads a flat
 * `.werkrc`, `globalRc` wanders to the home directory on its own terms, and
 * `packageJson` would let a dependency's manifest contribute. werk's file is
 * `<dir>/config.toml` and the caller decided which directory.
 */
/**
 * The extensions c12 would consider, so that "is there anything to read here"
 * can be answered without paying for c12 itself.
 */
const CONFIG_EXTENSIONS = [
  "toml",
  "json",
  "jsonc",
  "json5",
  "ts",
  "mts",
  "js",
  "mjs",
];

/** Whether a directory holds a config file at all. */
async function hasConfigFile(dir: string): Promise<boolean> {
  const found = await Promise.all(
    CONFIG_EXTENSIONS.map((extension) =>
      fs
        .stat(path.join(dir, `config.${extension}`))
        .then((entry) => entry.isFile())
        .catch(() => false),
    ),
  );
  return found.includes(true);
}

export async function readConfigDir(
  dir: string,
  source: ConfigSource = unconfiguredSource,
): Promise<FileLayer> {
  // Importing c12 costs about 50 ms, which is most of a tab-completion budget,
  // and the overwhelmingly common case is a directory with no config file in it
  // at all. Eight stats answer that for a fraction of the cost.
  if (!(await hasConfigFile(dir))) return { values: {} };
  const { loadConfig } = await import("c12");
  const loaded = await loadConfig<Record<string, unknown>>({
    name: "werk",
    cwd: dir,
    configFile: "config",
    rcFile: false,
    globalRc: false,
    packageJson: false,
    dotenv: false,
    envName: false,
    omit$Keys: true,
    // The seam: a file may say `extends = ["werk-remote:<id>"]`. c12 asks this
    // for the main config too, so anything that is not a remote id falls
    // through to c12's own resolution by returning null.
    resolve: async (id) =>
      id.startsWith(REMOTE_PREFIX)
        ? {
            config:
              ((await source.get(id.slice(REMOTE_PREFIX.length))) as Record<
                string,
                unknown
              > | null) ?? {},
          }
        : null,
  });
  return { values: coerceLayer(loaded.config), file: loaded._configFile };
}

export interface LoadOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** Where the caller is standing; the repository is resolved from it. */
  cwd?: string;
  /** What was typed on the command line, if the caller has it. */
  flags?: GlobalFlags;
  source?: ConfigSource;
}

/** Which files the layers would come from, without reading any of them. */
export function configPaths(options: LoadOptions = {}) {
  const env = options.env ?? process.env;
  const project = projectConfigDir(options.cwd);
  return {
    userDir: userConfigDir(env, options.home),
    user: configFileIn(userConfigDir(env, options.home)),
    projectDir: project,
    project: project === undefined ? undefined : configFileIn(project),
  };
}

export async function loadWerkConfig(
  options: LoadOptions = {},
): Promise<MergedConfig> {
  const env = options.env ?? process.env;
  const source = options.source ?? unconfiguredSource;
  const paths = configPaths(options);
  const user = await readConfigDir(paths.userDir, source);
  const project =
    paths.projectDir === undefined
      ? { values: {} }
      : await readConfigDir(paths.projectDir, source);
  const remote = await source.load();
  return mergeLayers([
    {
      name: "defaults",
      origin: "built in",
      values: builtInDefaults(env, options.home),
    },
    {
      name: "remote",
      origin: source.configured ? source.name : undefined,
      values: remote ?? {},
    },
    { name: "user", origin: user.file, values: user.values },
    { name: "project", origin: project.file, values: project.values },
    { name: "env", origin: "environment", values: envLayer(env) },
    {
      name: "flags",
      origin: "command line",
      values: options.flags ? flagsLayer(options.flags) : {},
    },
  ]);
}
