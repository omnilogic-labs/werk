/**
 * What werk thinks it has been told, and who told it.
 *
 * A value on its own is not much use when six layers can supply it, so every
 * subcommand here carries the layer as well as the value. `list` is the one that
 * matters: it is how someone finds out that the repository's `.werk/config.toml`
 * is quietly beating the log level they exported.
 */
import { existsSync } from "node:fs";
import { Command } from "@commander-js/extra-typings";
import { withContext } from "./shared.js";
import { result, tableResult } from "../runtime/output.js";
import { UsageError } from "../runtime/exit.js";
import type { GlobalFlags } from "../runtime/context.js";
import { envVariablesInUse } from "../config/env.js";
import {
  configPaths,
  loadWerkConfig,
  type LayerName,
  type MergedConfig,
} from "../config/load.js";
import { CONFIG_KEYS, isConfigKey } from "../config/schema.js";

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
  const config = new Command("config").description(
    "Show the resolved configuration and where it came from",
  );

  const list = config
    .command("list")
    .description("Every setting, its value, and the layer it came from")
    .addHelpText(
      "after",
      "\nExamples:\n  $ werk config list\n  $ werk config list --json | jq '.[] | select(.layer != \"defaults\")'",
    );
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
            ? ctx.colour.dim(LAYER_LABEL[r.layer])
            : LAYER_LABEL[r.layer],
        ]),
        1,
      );
    }),
  );

  const get = config
    .command("get")
    .description("One setting's value")
    .argument("<key>", `one of ${CONFIG_KEYS.join(", ")}`);
  get.action(
    withContext(async (_ctx, _opts, key: string) => {
      if (!isConfigKey(key))
        throw new UsageError(
          `Unknown setting ${key}; werk has ${CONFIG_KEYS.join(", ")}`,
        );
      const { config: values, from } = await load(get);
      // A person piping this wants the value alone, so the layer stays in the
      // machine shape where it costs nothing to carry.
      return result({ key, value: values[key], layer: from[key] }, () =>
        String(values[key]),
      );
    }),
  );

  const sources = config
    .command("sources")
    .description("Every layer werk consults, lowest precedence first");
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
          r.keys.length > 0 ? r.state : ctx.colour.dim(r.state),
          r.where,
        ]),
        2,
      );
    }),
  );

  const paths = config
    .command("path")
    .description("The config files werk reads, whether or not they exist");
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
          row.exists ? "present" : ctx.colour.dim("absent"),
        ]),
        1,
      );
    }),
  );

  return config;
}
