/**
 * What werk thinks it has been told, and who told it.
 *
 * A value on its own is not much use when six layers can supply it, so every
 * subcommand here carries the layer as well as the value. `list` is the one
 * that matters: it is how someone finds out which layer won a key, such as an
 * exported `WERK_LOG_LEVEL` overriding the repository's `.werk/config.toml`.
 *
 * Hosts are here on the same terms as the settings. A `[hosts.<name>]` block
 * says which machine a name means, so which layer supplied it is worth as much
 * as which layer supplied a log level — more, because a block replaces a block
 * whole and a person who wrote one in two files has one of them doing nothing.
 * `list` shows every host with the layer it came from, and `sources` is where a
 * block that was replaced, or one werk could not read, is explained.
 *
 * The rendering is separated from the reading so a test can drive it with a
 * merge it made up rather than with files on a disk.
 */
import { existsSync } from "node:fs";
import { Argument, type Command } from "@commander-js/extra-typings";
import { withContext } from "./shared.js";
import { defineCommand } from "./define.js";
import { result, tableResult } from "../runtime/output.js";
import type { GlobalFlags } from "../runtime/context.js";
import { envVariablesInUse } from "../config/env.js";
import {
  configPaths,
  loadWerkConfig,
  type LayerName,
  type MergedConfig,
} from "../config/load.js";
import { CONFIG_KEYS, type ConfigKey } from "../config/schema.js";
import { summariseHost } from "../config/hosts.js";
import type { WerkContext } from "../runtime/context.js";
import type { Result } from "../runtime/output.js";

/**
 * Commander records a global option on the command it was declared on and
 * `optsWithGlobals` walks up to it, so the flags layer is read from the
 * subcommand that is running rather than from `process.argv`. A global werk
 * accepts but nobody typed is absent from the object entirely.
 */
interface HasGlobals {
  optsWithGlobals(): unknown;
}
const globalsOf = (command: HasGlobals): GlobalFlags =>
  command.optsWithGlobals() as GlobalFlags;

const load = (command: HasGlobals): Promise<MergedConfig> =>
  loadWerkConfig({ flags: globalsOf(command) });

/** What each layer is called in the output, in precedence order. */
const LAYER_LABEL: Record<LayerName, string> = {
  defaults: "defaults",
  remote: "remote",
  user: "user file",
  project: "project file",
  env: "environment",
  flags: "flags",
};

export function buildConfig(): Command {
  const config = defineCommand({
    name: "config",
    summary: "Show every setting and host werk has, and where each came from",
    description:
      "What werk thinks it has been told, and who told it: the settings, and " +
      "the hosts a [hosts.<name>] block names. Six layers can supply either, " +
      "so every subcommand here names the layer a value came from.",
    examples: [
      {
        run: "werk config list",
        note: "every setting and host, with its layer",
      },
      { run: "werk config get runtimeDir" },
      { run: "werk config sources", note: "which layers are in play" },
    ],
  });

  const list = defineCommand({
    name: "list",
    summary: "Print every setting and host, and where each came from",
    description:
      "Every setting werk has, the value in force, and which of the six " +
      "layers supplied it. Use it to see which layer won: an exported WERK_ " +
      "variable beats a config file in the repository, and a command-line " +
      "flag beats both. Hosts follow the settings, keyed hosts.<name>. A host " +
      "werk could not read reads unreadable, and config sources says why.",
    examples: [
      { run: "werk config list" },
      {
        run: "werk config list --json | jq '.[] | select(.layer != \"defaults\")'",
      },
    ],
  });
  config.addCommand(list);
  list.action(withContext(async (ctx) => listResult(await load(list), ctx)));

  const get = defineCommand({
    name: "get",
    summary: "Print one setting's value",
    description:
      "Print the value in force for one setting, and nothing else, so it can " +
      "be piped into another command. --json adds the layer it came from.",
    examples: [
      { run: "werk config get runtimeDir" },
      { run: "werk config get scrollbackBytes --json | jq .layer" },
    ],
  });
  // Declared as choices rather than checked in the action: commander rejects an
  // unknown key with the list of real ones and the usage, and the completion
  // walker reads the same declaration, so TAB offers exactly what is accepted.
  get.addArgument(new Argument("<key>", "which setting").choices(CONFIG_KEYS));
  config.addCommand(get);
  get.action(
    withContext(async (_ctx, _opts, raw: string) => {
      const key = raw as ConfigKey;
      const { config: values, from } = await load(get);
      // A person piping this wants the value alone, so the layer stays in the
      // machine shape where it costs nothing to carry.
      return result({ key, value: values[key], layer: from[key] }, () =>
        String(values[key]),
      );
    }),
  );

  const sources = defineCommand({
    name: "sources",
    summary: "Print every layer werk consults, weakest first",
    description:
      "The six layers, weakest first, and what each of them is doing. An " +
      "empty layer says why it is empty: a config file that does not exist is " +
      "a different problem from one that exists and was overridden on every " +
      "key. A host block a stronger layer replaced is listed against the " +
      "layer that lost it, and a block werk could not read is listed with " +
      "what is wrong and which file it is in.",
    examples: [
      { run: "werk config sources" },
      { run: "werk config sources --json" },
    ],
  });
  config.addCommand(sources);
  sources.action(
    withContext(async (ctx) =>
      sourcesResult(
        await load(sources),
        { paths: configPaths({}), envVariables: envVariablesInUse() },
        ctx,
      ),
    ),
  );

  const paths = defineCommand({
    name: "path",
    summary: "Print the config files werk reads",
    description:
      "Where a config file would be read from, whether or not one is there, " +
      "so there is somewhere to create one. The user file always has a path; " +
      "the project file only exists inside a repository.",
    examples: [
      { run: "werk config path" },
      { run: "$EDITOR \"$(werk config path --json | jq -r '.[0].path')\"" },
    ],
  });
  config.addCommand(paths);
  paths.action(
    withContext(async (ctx) => {
      const found = configPaths({});
      const rows = [
        { scope: "user", path: found.user },
        ...(found.project ? [{ scope: "project", path: found.project }] : []),
      ].map((row) => ({ ...row, exists: existsSync(row.path) }));
      return tableResult(
        rows,
        ["SCOPE", "PATH", "STATE"],
        rows.map((row) => [
          row.scope,
          row.path,
          row.exists ? "present" : ctx.style.muted("absent"),
        ]),
        1,
      );
    }),
  );

  return config;
}

/** One row of `config list`: a setting or a host, and the layer it came from. */
export interface ConfigRow {
  key: string;
  /**
   * The setting's value, the whole host block, or null for a host werk could
   * not read.
   */
  value: unknown;
  layer: LayerName;
}

/**
 * Every setting, then every host.
 *
 * The machine shape stays one flat array of `{key, value, layer}`, so
 * `jq '.[] | select(.layer != "defaults")'` still answers the question it
 * always answered. A host row carries the whole block as its value, because a
 * one-line summary is a thing a person wants and a script does not.
 *
 * A host that could not be read still gets a row: leaving it out would say the
 * name is not configured, when what happened is that it is configured wrongly.
 * Its value is null and the reason lives in `config sources`, which is the
 * subcommand for why.
 */
export function listResult(
  merged: MergedConfig,
  ctx: WerkContext,
): Result<ConfigRow[]> {
  const settings: { row: ConfigRow; shown: string }[] = CONFIG_KEYS.map(
    (key) => ({
      row: { key, value: merged.config[key], layer: merged.from[key] },
      shown: String(merged.config[key]),
    }),
  );
  const broken = new Map(
    merged.problems.map((problem) => [problem.name, problem]),
  );
  const names = [
    ...new Set([...Object.keys(merged.hosts), ...broken.keys()]),
  ].sort();
  const hosts: { row: ConfigRow; shown: string }[] = names.map((name) => {
    const host = merged.hosts[name];
    // A name can be both: a block that does not parse in one file and a good
    // one in another. The good block is what werk would act on, so it is the
    // row, and `sources` still reports the one that did not parse.
    if (host !== undefined)
      return {
        row: {
          key: `hosts.${name}`,
          value: host,
          layer: merged.hostFrom[name] as LayerName,
        },
        shown: summariseHost(host),
      };
    const problem = broken.get(name);
    return {
      row: {
        key: `hosts.${name}`,
        value: null,
        layer: problem?.layer ?? "defaults",
      },
      shown: ctx.style.error("unreadable"),
    };
  });
  const rows = [...settings, ...hosts];
  return tableResult(
    rows.map((entry) => entry.row),
    ["KEY", "VALUE", "FROM"],
    rows.map((entry) => [
      entry.row.key,
      entry.shown,
      entry.row.layer === "defaults"
        ? ctx.style.muted(LAYER_LABEL[entry.row.layer])
        : LAYER_LABEL[entry.row.layer],
    ]),
    1,
  );
}

/** What `sources` needs from the filesystem and the environment. */
export interface SourcesView {
  paths: ReturnType<typeof configPaths>;
  /** The `WERK_*` variables actually contributing. */
  envVariables: readonly string[];
}

/**
 * Every layer, weakest first, and what each one is doing.
 *
 * Why a layer is empty is the useful half, and the same goes for a host block:
 * one a stronger layer replaced and one werk could not read both look like
 * nothing happening from anywhere else, so both are said here, against the
 * layer they were written in, with the file to open.
 */
export function sourcesResult(
  merged: MergedConfig,
  view: SourcesView,
  ctx: WerkContext,
) {
  const found = view.paths;
  const records = merged.layers.map((layer) => {
    const keys = CONFIG_KEYS.filter((key) => merged.from[key] === layer.name);
    const hosts = Object.keys(merged.hostFrom).filter(
      (name) => merged.hostFrom[name] === layer.name,
    );
    const shadowed = merged.shadowed.filter((one) => one.layer === layer.name);
    const problems = merged.problems.filter((one) => one.layer === layer.name);
    const held =
      Object.keys(layer.values).length > 0 ||
      Object.keys(layer.hosts ?? {}).length > 0 ||
      problems.length > 0;
    // Why a layer is empty is the useful half: a file that is not there reads
    // very differently from one that is there and lost every key.
    const empty =
      layer.name === "remote"
        ? "unconfigured"
        : layer.name === "project" && found.project === undefined
          ? "no repository"
          : layer.name === "user" || layer.name === "project"
            ? "absent"
            : "unset";
    const won = keys.length > 0 || hosts.length > 0;
    const where =
      layer.name === "user"
        ? found.user
        : layer.name === "project"
          ? (found.project ?? "")
          : layer.name === "env"
            ? view.envVariables.join(" ")
            : (layer.origin ?? "");
    return {
      source: layer.name,
      state: !held ? empty : won ? "in use" : "overridden",
      where,
      keys,
      hosts,
      shadowed: shadowed.map((one) => ({ name: one.name, by: one.by })),
      problems,
    };
  });
  // A layer's row, then a line for each of its host blocks that is not doing
  // what the person who wrote it would expect. The blank first column is what
  // ties those lines to the row above.
  const rows = records.flatMap((record) => [
    [
      LAYER_LABEL[record.source],
      record.keys.length > 0 || record.hosts.length > 0
        ? record.state
        : ctx.style.muted(record.state),
      record.where,
    ],
    ...record.shadowed.map((one) => [
      "",
      ctx.style.muted("shadowed"),
      `hosts.${one.name} replaced by ${LAYER_LABEL[one.by]}`,
    ]),
    ...record.problems.map((one) => [
      "",
      ctx.style.error("unreadable"),
      one.message,
    ]),
  ]);
  return tableResult(records, ["SOURCE", "STATE", "WHERE"], rows, 2);
}
