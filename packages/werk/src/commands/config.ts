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
import { buildConfigSetup } from "./config-setup.js";
import { result, tableResult } from "../runtime/output.js";
import type { GlobalFlags } from "../runtime/context.js";
import { envVariablesInUse } from "../config/env.js";
import {
  configPaths,
  loadWerkConfig,
  type LayerName,
  type MergedConfig,
} from "../config/load.js";
import {
  CONFIG_KEYS,
  FIELDS,
  type ConfigKey,
  type ConfigValue,
} from "../config/schema.js";
import { summariseHost, type Host } from "../config/hosts.js";
import { UsageError } from "../runtime/exit.js";
import { editProjectConfig, editUserConfig } from "../config/write.js";
import type { ConfigEdit } from "../config/toml-edit.js";
import {
  noProbe,
  probeFor,
  probeHost,
  PROBE_BUDGET_MS,
  type ProbeReport,
} from "../hosts/probe.js";
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

  const set = defineCommand({
    name: "set",
    summary: "Write one setting to a config file",
    description:
      "Write a setting to your own config file, or to the repository's with " +
      "--project. The value goes through the same check the file would apply, " +
      "so a value werk cannot use is refused here rather than at the next " +
      "command that reads it. Everything else in the file is left exactly as " +
      "it was, comments included. If a stronger layer is already supplying " +
      "the key, the value written will not be the one in force, and this says " +
      "so rather than leaving you to work it out.",
    examples: [
      { run: "werk config set logLevel debug" },
      {
        run: "werk config set defaultHost beast --project",
        note: "for this repository only",
      },
    ],
  });
  set.addArgument(new Argument("<key>", "which setting").choices(CONFIG_KEYS));
  set.addArgument(new Argument("<value>", "what to set it to"));
  set.option("--project", "write the repository's file rather than your own");
  config.addCommand(set);
  set.action(
    withContext(
      async (ctx, opts: { project?: boolean }, raw: string, given: string) => {
        const key = raw as ConfigKey;
        // Through the field's own parser, so `werk config set logLevel loud`
        // is refused with the sentence the file would have produced.
        const value: ConfigValue = FIELDS[key].parse(given);
        return await write(ctx, set, key, value, opts.project === true);
      },
    ),
  );

  const unset = defineCommand({
    name: "unset",
    summary: "Take one setting back out of a config file",
    description:
      "Remove a setting's line from your own config file, or from the " +
      "repository's with --project, and say what the value falls back to. " +
      "Removing a line does not mean the key has no value: every setting has " +
      "a default underneath it, and a weaker file or an environment variable " +
      "may be supplying one too.",
    examples: [
      { run: "werk config unset logLevel" },
      { run: "werk config unset defaultHost --project" },
    ],
  });
  unset.addArgument(
    new Argument("<key>", "which setting").choices(CONFIG_KEYS),
  );
  unset.option("--project", "write the repository's file rather than your own");
  config.addCommand(unset);
  unset.action(
    withContext(async (ctx, opts: { project?: boolean }, raw: string) => {
      const key = raw as ConfigKey;
      return await write(ctx, unset, key, null, opts.project === true);
    }),
  );

  config.addCommand(buildConfigSetup());

  const check = defineCommand({
    name: "check",
    summary: "Ask each configured host about itself",
    description:
      "Run the probe against every host that is configured, or against one " +
      "named host, and print what each machine said: whether it answers at " +
      "all, what it is running, whether git and werk are on it, and where " +
      "workspaces would go. Nothing is stored: a host block holds what the " +
      "machine is called and where werk may put things, and everything else " +
      "is asked at the moment it is needed. Nothing is created on the machine " +
      "either, so a workspace root that is not there yet reads as absent " +
      "rather than being made.",
    examples: [
      { run: "werk config check" },
      { run: "werk config check beast" },
      {
        run: "werk config check --json | jq '.[] | select(.reachable != \"yes\")'",
      },
    ],
  });
  check.addArgument(
    new Argument("[host]", "which host; every configured one by default"),
  );
  config.addCommand(check);
  check.action(
    withContext(async (ctx, _opts, name?: string) => {
      const merged = await load(check);
      if (name !== undefined && merged.hosts[name] === undefined)
        throw new UsageError(
          `there is no host called ${name}; \`werk config list\` shows the ones there are`,
        );
      const wanted =
        name === undefined ? Object.keys(merged.hosts).sort() : [name];
      // Each host gets its own budget rather than sharing one: a machine that
      // is asleep should not eat the time the next one needs to answer.
      const checked = await Promise.all(
        wanted.map(async (host) => {
          const block = merged.hosts[host]!;
          const probe = probeFor(block.kind);
          return {
            host,
            block,
            probed: probe !== noProbe,
            report: await probeHost(probe, {
              signal: AbortSignal.timeout(PROBE_BUDGET_MS),
            }),
          };
        }),
      );
      return checkResult(checked, ctx);
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

/** What `set` and `unset` did, and what the key is worth afterwards. */
export interface SettingWrite {
  key: ConfigKey;
  /** What was written, or null when the line was removed. */
  value: ConfigValue | null;
  file: string;
  created: boolean;
  /** The value in force once the write had happened. */
  effective: ConfigValue;
  /** The layer supplying it. Not always the one that was written. */
  layer: LayerName;
}

/**
 * Write one setting, then say what the key is actually worth.
 *
 * The second half is the part that saves somebody twenty minutes. A file is not
 * the strongest layer: an exported `WERK_LOG_LEVEL` beats it, and so does a
 * flag on the command line, and both of those are invisible from the file that
 * was just edited. The provenance is already computed for `config list`, so the
 * write re-resolves and says which layer won.
 */
async function write(
  ctx: WerkContext,
  command: HasGlobals,
  key: ConfigKey,
  value: ConfigValue | null,
  project: boolean,
): Promise<Result<SettingWrite>> {
  const edit: ConfigEdit = { set: { [key]: value } };
  const written = project
    ? await editProjectConfig(edit)
    : await editUserConfig(edit);
  const merged = await load(command);
  const record: SettingWrite = {
    key,
    value,
    file: written.file,
    created: written.created,
    effective: merged.config[key],
    layer: merged.from[key],
  };
  const wroteTo: LayerName = project ? "project" : "user";
  return result(record, () => {
    if (value === null)
      return `${key} is no longer set in ${written.file}; it is ${show(record.effective)}, from ${describeLayer(merged, record.layer, key)}.`;
    if (record.layer === wroteTo)
      return `${key} is ${show(value)} in ${written.file}.`;
    return ctx.style.warning(
      `${key} is set to ${show(value)} in ${written.file}, but ` +
        `${describeLayer(merged, record.layer, key)} is beating it with ` +
        `${show(record.effective)}.`,
    );
  });
}

const show = (value: ConfigValue): string => String(value);

/** Where a layer's value came from, spelled as something a person can go and look at. */
function describeLayer(
  merged: MergedConfig,
  layer: LayerName,
  key: ConfigKey,
): string {
  if (layer === "env")
    return `${FIELDS[key].env}=${process.env[FIELDS[key].env] ?? ""}`;
  if (layer === "flags") return "the flag on this command line";
  const origin = merged.layers.find((one) => one.name === layer)?.origin;
  return origin ?? LAYER_LABEL[layer];
}

/** One host `config check` asked about, and what came back. */
export interface HostCheck {
  host: string;
  block: Host;
  /** False when nothing can reach a host of that kind yet. */
  probed: boolean;
  report: ProbeReport;
}

/**
 * A row per host. "not checked" and "no" are different answers and are kept
 * apart: the first is werk having no way to reach that kind of machine, and the
 * second is the machine not answering.
 */
export function checkResult(
  checked: readonly HostCheck[],
  ctx: WerkContext,
): Result<readonly HostCheck[]> {
  const rows = checked.map((one) => {
    const state = !one.probed
      ? ctx.style.muted("not checked")
      : one.report.reachable === "yes"
        ? "answers"
        : one.report.reachable === "no"
          ? ctx.style.error("no answer")
          : ctx.style.muted("unknown");
    // What it is, what it is missing, and where werk would put work. Everything
    // else the probe learned is in the machine shape, which is where a script
    // reading this wants it anyway.
    const detail = (name: string) =>
      one.report.checks.find((check) => check.name === name)?.detail;
    const missing = one.report.checks
      .filter((check) => check.state === "no" && check.name !== "reachable")
      .map((check) => `no ${check.name}`);
    const found = [
      detail("system"),
      ...missing,
      one.report.workspaceRoot,
    ].filter((part) => part !== undefined && part !== "");
    return [
      one.host,
      summariseHost(one.block),
      state,
      found.length > 0
        ? found.join("; ")
        : ctx.style.muted(one.report.notes[0] ?? ""),
    ];
  });
  return tableResult(checked, ["HOST", "HOW", "STATE", "FOUND"], rows, 3);
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
