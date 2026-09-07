import { expect, test } from "bun:test";
import { splitChildArgv } from "../src/runtime/argv.js";
import { hoistGlobalFlags } from "../src/runtime/argv.js";

test("the child's argv is separated from werk's own", () => {
  expect(
    splitChildArgv(["create", "--name", "demo", "--", "claude", "-p"]),
  ).toEqual({
    own: ["create", "--name", "demo"],
    child: ["claude", "-p"],
  });
});
test("a child flag that collides with one of werk's stays the child's", () => {
  const { own, child } = splitChildArgv([
    "create",
    "--name",
    "demo",
    "--",
    "claude",
    "--name",
    "CHILD",
  ]);
  expect(own).toEqual(["create", "--name", "demo"]);
  expect(child).toEqual(["claude", "--name", "CHILD"]);
});
test("a second -- belongs to the child", () => {
  expect(splitChildArgv(["create", "--", "sh", "-c", "--"]).child).toEqual([
    "sh",
    "-c",
    "--",
  ]);
});
test("no separator means no child", () => {
  expect(splitChildArgv(["list", "--json"])).toEqual({
    own: ["list", "--json"],
    child: [],
  });
});
test("global flags are accepted after the command name", () => {
  expect(hoistGlobalFlags(["list", "--runtime-dir", "/x"])).toEqual({
    globals: ["--runtime-dir", "/x"],
    rest: ["list"],
  });
});
test("global flags are accepted after a nested subcommand", () => {
  // This is exactly how the daemon launcher spawns werk.
  expect(
    hoistGlobalFlags([
      "daemon",
      "serve",
      "--runtime-dir",
      "/x",
      "--log-level",
      "debug",
    ]),
  ).toEqual({
    globals: ["--runtime-dir", "/x", "--log-level", "debug"],
    rest: ["daemon", "serve"],
  });
});
test("a command's own flags are left where they are", () => {
  expect(hoistGlobalFlags(["list", "--state", "running", "--json"])).toEqual({
    globals: ["--json"],
    rest: ["list", "--state", "running"],
  });
});
test("--flag=value is hoisted whole", () => {
  expect(hoistGlobalFlags(["list", "--runtime-dir=/x"])).toEqual({
    globals: ["--runtime-dir=/x"],
    rest: ["list"],
  });
});
test("a value that looks like a flag is still the flag's value", () => {
  expect(hoistGlobalFlags(["--log-level", "--json"])).toEqual({
    globals: ["--log-level", "--json"],
    rest: [],
  });
});
