/**
 * What werk thinks it has been told, and who told it.
 *
 * A value on its own is not much use when six layers can supply it, so every
 * subcommand here carries the layer as well as the value. `list` is the one
 * that matters: it is how someone finds out which layer won a key, such as an
 * exported `WERK_LOG_LEVEL` overriding the repository's `.werk/config.toml`.
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
    summary: "Show every setting werk is using, and where it came from",
    description:
      "What werk thinks it has been told, and who told it. Six layers can " +
      "supply a value, so every subcommand here names the layer a value came " +
      "from.",
    examples: [
      { run: "werk config list", note: "every setting and its layer" },
      { run: "werk config get runtimeDir" },
      { run: "werk config sources", note: "which layers are in play" },
    ],
  });

  const list = defineCommand({
    name: "list",
    summary: "Print every setting, its value, and where it came from",
    description:
      "Every setting werk has, the value in force, and which of the six " +
      "layers supplied it. Use it to see which layer won: an exported WERK_ " +
      "variable beats a config file in the repository, and a command-line " +
      "flag beats both.",
    examples: [
      { run: "werk config list" },
      {
        run: "werk config list --json | jq '.[] | select(.layer != \"defaults\")'",
      },
    ],
  });
  config.addCommand(list);
  list.action(
    withContext(async (ctx) => {
      const { config: values, from } = await load(list);
      const records = CONFIG_KEYS.map((key) => ({
        key,
        value: values[key],
        layer: from[key],
      }));
      return tableResult(
        records,
        ["KEY", "VALUE", "FROM"],
        records.map((r) => [
          r.key,
          String(r.value),
          r.layer === "defaults"
            ? ctx.style.muted(LAYER_LABEL[r.layer])
            : LAYER_LABEL[r.layer],
        ]),
        1,
      );
    }),
  );

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
      "key.",
    examples: [
      { run: "werk config sources" },
      { run: "werk config sources --json" },
    ],
  });
  config.addCommand(sources);
  sources.action(
    withContext(async (ctx) => {
      const merged = await load(sources);
      const found = configPaths({});
      const records = merged.layers.map((layer) => {
        const keys = CONFIG_KEYS.filter(
          (key) => merged.from[key] === layer.name,
        );
        const held = Object.keys(layer.values).length > 0;
        // Why a layer is empty is the useful half: a file that is not there
        // reads very differently from one that is there and lost every key.
        const empty =
          layer.name === "remote"
            ? "unconfigured"
            : layer.name === "project" && found.project === undefined
              ? "no repository"
              : layer.name === "user" || layer.name === "project"
                ? "absent"
                : "unset";
        const where =
          layer.name === "user"
            ? found.user
            : layer.name === "project"
              ? (found.project ?? "")
              : layer.name === "env"
                ? envVariablesInUse().join(" ")
                : (layer.origin ?? "");
        return {
          source: layer.name,
          state: !held ? empty : keys.length > 0 ? "in use" : "overridden",
          where,
          keys,
        };
      });
      return tableResult(
        records,
        ["SOURCE", "STATE", "WHERE"],
        records.map((r) => [
          LAYER_LABEL[r.source],
          r.keys.length > 0 ? r.state : ctx.style.muted(r.state),
          r.where,
        ]),
        2,
      );
    }),
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
