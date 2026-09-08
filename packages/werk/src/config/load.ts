/**
 * Where each layer comes from, and how the six of them become one config.
 *
 * The merge is pure: layers in, the resolved config out, plus the layer every
 * single value and every host came from. That provenance is the reason
 * `werk config list` is worth having at all, so it is computed in one place
 * that a test can drive without a filesystem, a repository or an environment.
 * Around it sits the thin effectful half — find the toplevel, read the two
 * TOML files, ask the remote source — in the same shape as `view.ts`.
 *
 * A layer holds two different kinds of thing. Settings are scalars that merge
 * key by key, and every one of them has a default underneath it. Hosts are
 * blocks that replace each other whole, and a name nobody wrote down has
 * nothing underneath it at all. Only the file layers and the built-in defaults
 * carry hosts today: the environment rule is one variable per scalar key and
 * the flags are the same, and neither has a spelling for a table.
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
  builtInHosts,
  parseHosts,
  type Host,
  type HostProblem,
} from "./hosts.js";
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
  /** The `[hosts.*]` blocks this layer carried, if it carried any. */
  hosts?: Readonly<Record<string, Host>>;
  /** The blocks it carried that could not be read. */
  problems?: readonly HostProblem[];
}
/** A host block that could not be read, and which layer's file it was in. */
export interface LayerProblem extends HostProblem {
  layer: LayerName;
}
/** A host block one layer supplied and a stronger layer replaced outright. */
export interface ShadowedHost {
  name: string;
  /** The layer whose block was replaced. */
  layer: LayerName;
  /** The layer that replaced it. */
  by: LayerName;
}
export interface MergedConfig {
  config: WerkConfig;
  /** The layer that supplied the value each key ended up with. */
  from: Record<ConfigKey, LayerName>;
  /** Every host in force, by name. */
  hosts: Readonly<Record<string, Host>>;
  /** The layer that supplied each host. */
  hostFrom: Record<string, LayerName>;
  /** Every host block a stronger layer replaced, weakest first. */
  shadowed: readonly ShadowedHost[];
  /** Every host block that could not be read, weakest first. */
  problems: readonly LayerProblem[];
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
  // Hosts merge by name and never by field. A host is a discriminated union, so
  // merging `kind = "ssh"` in a project file over a `kind = "local"` block in
  // the user file would compose a record no file ever contained and point the
  // name at a machine nobody wrote down. A whole block wins or it does not, and
  // every replacement is recorded, because a host that quietly changed which
  // machine it means is the worst thing this can do.
  //
  // There is no "every host must be supplied" check to match the one above. A
  // collection with no entries is a person who has not written any hosts down;
  // a setting with no value is a hole in werk's own defaults.
  const hosts: Record<string, Host> = {};
  const hostFrom: Record<string, LayerName> = {};
  const shadowed: ShadowedHost[] = [];
  const problems: LayerProblem[] = [];
  for (const layer of ordered) {
    for (const [name, host] of Object.entries(layer.hosts ?? {})) {
      const held = hostFrom[name];
      if (held !== undefined)
        shadowed.push({ name, layer: held, by: layer.name });
      hosts[name] = host;
      hostFrom[name] = layer.name;
    }
    for (const problem of layer.problems ?? [])
      problems.push({ ...problem, layer: layer.name });
  }
  return {
    config: config as WerkConfig,
    from,
    hosts,
    hostFrom,
    shadowed,
    problems,
    layers: ordered,
  };
}

/**
 * The flags werk accepts anywhere on the command line, as a layer. Commander
 * leaves a global option out of `optsWithGlobals()` entirely unless it was
 * typed, so an absent key here means the caller did not ask.
 *
 * `--color` and `--no-color` are missing on purpose: they take no value and say
 * nothing a layer can hold, so the gate reads them from the raw argv instead.
 * `--flavour` and `--accent` do carry values and are settings like any other, so
 * they belong here. `main.ts` reads them off the raw argv before the parse and
 * hands them in through this same function, which is what puts a flag above the
 * environment on a page printed during the parse.
 */
export function flagsLayer(flags: GlobalFlags): Partial<WerkConfig> {
  return coerceLayer({
    logLevel: flags.logLevel,
    runtimeDir: flags.runtimeDir,
    stateDir: flags.stateDir,
    flavour: flags.flavour,
    accent: flags.accent,
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
  hosts: Readonly<Record<string, Host>>;
  problems: readonly HostProblem[];
  /** The file that was actually read, absent when there was none. */
  file?: string;
}
const emptyFileLayer = (): FileLayer => ({
  values: {},
  hosts: {},
  problems: [],
});
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
  if (!(await hasConfigFile(dir))) return emptyFileLayer();
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
  const { hosts, problems } = parseHosts(loaded.config, loaded._configFile);
  return {
    values: coerceLayer(loaded.config),
    hosts,
    problems,
    file: loaded._configFile,
  };
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
      ? emptyFileLayer()
      : await readConfigDir(paths.projectDir, source);
  const remote = await source.load();
  return mergeLayers([
    {
      name: "defaults",
      origin: "built in",
      values: builtInDefaults(env, options.home),
      // `local` arrives as an ordinary row with an ordinary provenance, so no
      // command anywhere has to special-case the machine werk is running on.
      hosts: builtInHosts(),
    },
    {
      name: "remote",
      origin: source.configured ? source.name : undefined,
      values: remote ?? {},
    },
    {
      name: "user",
      origin: user.file,
      values: user.values,
      hosts: user.hosts,
      problems: user.problems,
    },
    {
      name: "project",
      origin: project.file,
      values: project.values,
      hosts: project.hosts,
      problems: project.problems,
    },
    { name: "env", origin: "environment", values: envLayer(env) },
    {
      name: "flags",
      origin: "command line",
      values: options.flags ? flagsLayer(options.flags) : {},
    },
  ]);
}
