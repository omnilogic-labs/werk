import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { envLayer, envVariablesInUse } from "../src/config/env.js";
import {
  LAYER_ORDER,
  configPaths,
  flagsLayer,
  loadWerkConfig,
  mergeLayers,
  readConfigDir,
  userConfigDir,
  type ConfigLayer,
} from "../src/config/load.js";
import { builtInDefaults, coerceLayer } from "../src/config/schema.js";
import {
  unconfiguredSource,
  type ConfigSource,
} from "../src/config/sources.js";
import { ConfigError } from "../src/config/errors.js";

const temporary: string[] = [];
/**
 * A fresh directory, spelled the way the filesystem spells it. On macOS the
 * temporary directory sits under `/var`, which is a symlink to `/private/var`,
 * so a path built from `os.tmpdir()` and the path anything that resolves it
 * reports back are the same place spelled two ways. Resolving here means the
 * tests can compare whole paths rather than leaves.
 */
function tmpdir(): string {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "werk-config-")),
  );
  temporary.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temporary.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});
/** A `.werk/config.toml` under a fresh directory, and the directory holding it. */
function configDir(toml: string): string {
  const dir = path.join(tmpdir(), ".werk");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.toml"), toml);
  return dir;
}
const layer = (
  name: ConfigLayer["name"],
  values: ConfigLayer["values"],
): ConfigLayer => ({ name, values });
// Every key, because `mergeLayers` refuses a merge that leaves one unset. Read
// from `builtInDefaults` rather than restated, so a key added to the schema
// arrives here without this file having to be edited to let the merge succeed.
const full = (logLevel: "info" | "debug" = "info"): ConfigLayer =>
  layer("defaults", {
    ...builtInDefaults({}, "/home/nobody"),
    logLevel,
    runtimeDir: "/run/default",
    stateDir: "/state/default",
  });

test("the precedence order is defaults, remote, user, project, env, flags", () => {
  expect(LAYER_ORDER).toEqual([
    "defaults",
    "remote",
    "user",
    "project",
    "env",
    "flags",
  ]);
});
test("each layer beats every layer below it", () => {
  // One key set by every layer, so the winner names the top of the stack.
  const { config, from } = mergeLayers([
    full(),
    layer("remote", { logLevel: "warn" }),
    layer("user", { logLevel: "error" }),
    layer("project", { logLevel: "debug" }),
    layer("env", { logLevel: "warn" }),
    layer("flags", { logLevel: "error" }),
  ]);
  expect(config.logLevel).toBe("error");
  expect(from.logLevel).toBe("flags");
});
test("a value falls to the highest layer that set it", () => {
  const { config, from } = mergeLayers([
    full(),
    layer("user", { logLevel: "warn", runtimeDir: "/run/user" }),
    layer("project", { runtimeDir: "/run/project" }),
  ]);
  expect(config.logLevel).toBe("warn");
  expect(from.logLevel).toBe("user");
  expect(config.runtimeDir).toBe("/run/project");
  expect(from.runtimeDir).toBe("project");
  expect(from.colour).toBe("defaults");
});
test("layers are merged in precedence order however they arrive", () => {
  const { config, from } = mergeLayers([
    layer("flags", { logLevel: "error" }),
    layer("project", { logLevel: "debug" }),
    full(),
  ]);
  expect(config.logLevel).toBe("error");
  expect(from.logLevel).toBe("flags");
});
test("a key no layer supplied is a programming error, not a silent undefined", () => {
  expect(() => mergeLayers([layer("flags", { logLevel: "debug" })])).toThrow(
    /No layer supplied/,
  );
});
test("the remote layer sits above the defaults and below the files", () => {
  const { config, from } = mergeLayers([
    full(),
    layer("remote", { stateDir: "/state/remote", colour: "never" }),
    layer("user", { stateDir: "/state/user" }),
  ]);
  expect(config.stateDir).toBe("/state/user");
  expect(config.colour).toBe("never");
  expect(from.colour).toBe("remote");
});

test("WERK_LOG_LEVEL and WERK_RUNTIME_DIR keep working", () => {
  expect(
    envLayer({ WERK_LOG_LEVEL: "debug", WERK_RUNTIME_DIR: "/run/env" }),
  ).toEqual({ logLevel: "debug", runtimeDir: "/run/env" });
});
test("every schema key answers to WERK_ plus its screaming snake name", () => {
  expect(
    envLayer({
      WERK_STATE_DIR: "/state/env",
      WERK_SCROLLBACK_BYTES: "4096",
      WERK_COLOUR: "never",
    }),
  ).toEqual({ stateDir: "/state/env", scrollbackBytes: 4096, colour: "never" });
});
test("an empty variable is unset rather than a parse error", () => {
  expect(envLayer({ WERK_LOG_LEVEL: "" })).toEqual({});
  expect(envVariablesInUse({ WERK_LOG_LEVEL: "" })).toEqual([]);
});
test("a variable werk does not own contributes nothing", () => {
  expect(envLayer({ WERK_CONFIG_DIR: "/somewhere", PATH: "/bin" })).toEqual({});
});
test("a value the schema refuses is reported against its key", () => {
  expect(() => envLayer({ WERK_LOG_LEVEL: "chatty" })).toThrow(ConfigError);
  expect(() => envLayer({ WERK_SCROLLBACK_BYTES: "lots" })).toThrow(
    /scrollbackBytes/,
  );
});
test("environment variables in use are listed for `config sources`", () => {
  expect(
    envVariablesInUse({ WERK_LOG_LEVEL: "info", WERK_COLOUR: "auto" }),
  ).toEqual(["WERK_LOG_LEVEL", "WERK_COLOUR"]);
});

test("only flags that were typed reach the flags layer", () => {
  expect(flagsLayer({ json: true, runtimeDir: "/run/flag" })).toEqual({
    runtimeDir: "/run/flag",
  });
  expect(flagsLayer({})).toEqual({});
});
test("a key werk does not know is ignored, not refused", () => {
  expect(coerceLayer({ logLevel: "warn", portal: "https://example" })).toEqual({
    logLevel: "warn",
  });
});
test("the defaults do not claim credit for WERK_RUNTIME_DIR", () => {
  const defaults = builtInDefaults(
    { WERK_RUNTIME_DIR: "/run/env", HOME: "/home/x" },
    "/home/x",
  );
  expect(defaults.runtimeDir).not.toBe("/run/env");
});

test("WERK_CONFIG_DIR moves the user file", () => {
  expect(userConfigDir({ WERK_CONFIG_DIR: "/opt/werk" }, "/home/x")).toBe(
    "/opt/werk",
  );
  expect(userConfigDir({}, "/home/x")).toBe(path.join("/home/x", ".werk"));
});
test("configPaths names the user file whether or not it exists", () => {
  const paths = configPaths({ env: { WERK_CONFIG_DIR: "/opt/werk" } });
  expect(paths.user).toBe(path.join("/opt/werk", "config.toml"));
});

test("a config.toml is read and typed", async () => {
  const dir = configDir(
    'logLevel = "debug"\nscrollbackBytes = 4096\nruntimeDir = "/run/file"\n',
  );
  const { values, file } = await readConfigDir(dir);
  expect(values).toEqual({
    logLevel: "debug",
    scrollbackBytes: 4096,
    runtimeDir: "/run/file",
  });
  expect(file).toBe(path.join(dir, "config.toml"));
});
test("a directory with no config.toml is an empty layer", async () => {
  const { values, file } = await readConfigDir(tmpdir());
  expect(values).toEqual({});
  expect(file).toBeUndefined();
});
test("a file may extend a remote fragment through the source seam", async () => {
  const dir = configDir('extends = ["werk-remote:team"]\nlogLevel = "debug"\n');
  const asked: string[] = [];
  const source: ConfigSource = {
    name: "test",
    configured: true,
    async load() {
      return null;
    },
    async get(id) {
      asked.push(id);
      return { stateDir: "/state/remote" };
    },
  };
  const { values } = await readConfigDir(dir, source);
  expect(asked).toEqual(["team"]);
  expect(values).toEqual({ logLevel: "debug", stateDir: "/state/remote" });
});
test("werk's own source answers nothing, so the remote layer is invisible", async () => {
  expect(await unconfiguredSource.load()).toBeNull();
  expect(await unconfiguredSource.get("anything")).toBeNull();
  expect(unconfiguredSource.configured).toBe(false);
});

test("the file layers, the environment and the flags stack up in that order", async () => {
  const home = tmpdir();
  const userDir = path.join(home, ".werk");
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(
    path.join(userDir, "config.toml"),
    'logLevel = "warn"\nstateDir = "/state/user"\ncolour = "never"\n',
  );
  const repository = tmpdir();
  Bun.spawnSync(["git", "init", "-q"], { cwd: repository });
  fs.mkdirSync(path.join(repository, ".werk", "nested"), { recursive: true });
  fs.writeFileSync(
    path.join(repository, ".werk", "config.toml"),
    'logLevel = "debug"\nruntimeDir = "/run/project"\n',
  );
  const { config, from } = await loadWerkConfig({
    env: { WERK_CONFIG_DIR: userDir, WERK_LOG_LEVEL: "error", HOME: home },
    home,
    // A subdirectory: the project layer is found by asking git for the
    // toplevel, which is the walk c12 does not do.
    cwd: path.join(repository, ".werk", "nested"),
    flags: { runtimeDir: "/run/flag" },
  });
  expect(config.logLevel).toBe("error");
  expect(from.logLevel).toBe("env");
  expect(config.runtimeDir).toBe("/run/flag");
  expect(from.runtimeDir).toBe("flags");
  expect(config.stateDir).toBe("/state/user");
  expect(from.stateDir).toBe("user");
  expect(config.colour).toBe("never");
  expect(from.colour).toBe("user");
  expect(config.scrollbackBytes).toBe(builtInDefaults().scrollbackBytes);
  expect(from.scrollbackBytes).toBe("defaults");
});
test("outside a repository there is no project layer", async () => {
  const home = tmpdir();
  const outside = tmpdir();
  const { from } = await loadWerkConfig({
    env: { WERK_CONFIG_DIR: path.join(home, ".werk"), HOME: home },
    home,
    cwd: outside,
  });
  expect(configPaths({ cwd: outside }).project).toBeUndefined();
  expect(from.logLevel).toBe("defaults");
});
