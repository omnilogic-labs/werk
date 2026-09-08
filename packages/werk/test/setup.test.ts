/**
 * `[setup.<name>]` as configuration: what a block may say, what happens when
 * one of them is wrong, and how two layers naming the same block settle it.
 *
 * Pure, and deliberately so. Parsing never looks at a disk, so a `copy` that is
 * not there parses fine here and fails wherever something tries to send it.
 */
import { expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { ConfigError } from "../src/config/errors.js";
import {
  SETUP_FIELDS,
  parseSetup,
  parseSetups,
  summariseSetup,
} from "../src/config/setup.js";
import { mergeLayers, type ConfigLayer } from "../src/config/load.js";
import { builtInDefaults } from "../src/config/schema.js";
import { exitCodeFor } from "../src/runtime/exit.js";

const block = (raw: unknown) => () => parseSetup("boxes", raw);

test("a setup block is a list of commands, and whatever it sends first", () => {
  expect(parseSetup("bootstrap", { run: ["bun install"] })).toEqual({
    run: ["bun install"],
  });
  expect(
    parseSetup("boxes", {
      copy: "/home/nobody/dotfiles/werk-host",
      to: ".local/share/werk/setup",
      run: ["~/.local/share/werk/setup/install.sh"],
      rerunOnChange: true,
    }),
  ).toEqual({
    copy: "/home/nobody/dotfiles/werk-host",
    to: ".local/share/werk/setup",
    run: ["~/.local/share/werk/setup/install.sh"],
    rerunOnChange: true,
  });
  expect(Object.keys(SETUP_FIELDS)).toEqual([
    "copy",
    "to",
    "run",
    "rerunOnChange",
  ]);
  expect(SETUP_FIELDS.run.required).toBe(true);
});
test("a leading ~/ is the shell's, so it is spelled out while the file is read", () => {
  expect(
    parseSetup("boxes", { copy: "~/dotfiles", to: "setup", run: ["x"] }).copy,
  ).toBe(path.join(os.homedir(), "dotfiles"));
  // Only at the front, and only werk's own machine: `~` anywhere else is a
  // character in a path, and a `to` is a path on a machine with its own home.
  expect(
    parseSetup("boxes", { copy: "/a/~/b", to: "setup", run: ["x"] }).copy,
  ).toBe("/a/~/b");
  expect(parseSetup("boxes", { copy: "/a", to: "~stuff", run: ["x"] }).to).toBe(
    "~stuff",
  );
});
test("copy and to are one answer, so half of it is refused naming both", () => {
  expect(block({ copy: "/a", run: ["x"] })).toThrow(/copy and to go together/);
  expect(block({ to: "setup", run: ["x"] })).toThrow(/copy and to go together/);
});
test("what a block sends lands under the directory it names", () => {
  expect(block({ copy: "/a", to: "/srv/setup", run: ["x"] })).toThrow(
    /to must be relative to the directory it lands under/,
  );
  expect(block({ copy: "/a", to: "../elsewhere", run: ["x"] })).toThrow(
    /to must not go up out of that directory/,
  );
  expect(block({ copy: "/a", to: "a/../b", run: ["x"] })).toThrow(
    /to must not go up out of that directory/,
  );
  expect(block({ copy: "/a", to: "a//b", run: ["x"] })).toThrow(
    /to must not have an empty segment/,
  );
  expect(block({ copy: "/a", to: "", run: ["x"] })).toThrow(
    /to must be a path/,
  );
  expect(block({ copy: "", to: "setup", run: ["x"] })).toThrow(
    /copy must be a path on this machine/,
  );
  expect(block({ copy: 3, to: "setup", run: ["x"] })).toThrow(
    /copy must be a path on this machine/,
  );
});
test("a block with nothing to run is refused, and so is a run that is not commands", () => {
  expect(block({})).toThrow(/run is required for a setup block/);
  expect(block({ run: [] })).toThrow(/run must be a list of commands/);
  expect(block({ run: "bun install" })).toThrow(/run must be a list/);
  expect(block({ run: ["bun install", ""] })).toThrow(/each of them a string/);
  expect(block({ run: ["bun install", 3] })).toThrow(/each of them a string/);
});
test("rerunOnChange is a flag, not a word about one", () => {
  expect(parseSetup("boxes", { run: ["x"], rerunOnChange: false })).toEqual({
    run: ["x"],
    rerunOnChange: false,
  });
  expect(block({ run: ["x"], rerunOnChange: "yes" })).toThrow(
    /rerunOnChange must be true or false/,
  );
});
test("a key inside a setup block that werk does not know is refused by name", () => {
  // The same asymmetry a host block has: a block that looks configured and does
  // nothing costs a machine somebody thinks is set up.
  expect(block({ run: ["x"], runs: ["y"] })).toThrow(/unknown key runs/);
  expect(block({ run: ["x"], shell: "zsh" })).toThrow(
    /a setup block takes copy, to, run, rerunOnChange/,
  );
  expect(block("bun install")).toThrow(/a setup block is a table of keys/);
  // And the message says where to go and fix it.
  expect(() =>
    parseSetup("boxes", { run: ["x"], shell: "zsh" }, "/home/x/config.toml"),
  ).toThrow("in setup.boxes (/home/x/config.toml)");
});
test("a table name that is not a block name is refused as the name it is", () => {
  let raised: unknown;
  try {
    parseSetup("my boxes", { run: ["x"] });
  } catch (error) {
    raised = error;
  }
  expect(raised).toBeInstanceOf(ConfigError);
  expect((raised as ConfigError).code).toBe("SETUP_INVALID");
  expect((raised as ConfigError).message).toContain("is not a setup name");
  // Configuration werk cannot act on exits like anything else typed wrong.
  expect(exitCodeFor(raised)).toBe(2);
});

test("a block werk cannot read is a problem, not a reason to stop", () => {
  const { setups, problems } = parseSetups(
    {
      logLevel: "debug",
      setup: {
        bootstrap: { run: ["bun install"] },
        broken: { runs: ["typo"] },
      },
    },
    "/home/x/.werk/config.toml",
  );
  // The good block beside it still loads, which is the whole point: werk starts.
  expect(setups).toEqual({ bootstrap: { run: ["bun install"] } });
  expect(problems).toHaveLength(1);
  expect(problems[0]!.name).toBe("broken");
  expect(problems[0]!.file).toBe("/home/x/.werk/config.toml");
  expect(problems[0]!.message).toContain("unknown key runs");
  expect(problems[0]!.message).toContain("/home/x/.werk/config.toml");
});
test("a file with no setup blocks contributes none and no problems", () => {
  expect(parseSetups({ logLevel: "debug" })).toEqual({
    setups: {},
    problems: [],
  });
  expect(parseSetups(null)).toEqual({ setups: {}, problems: [] });
});
test("setup that is not a table of blocks is one problem, not a throw", () => {
  const { setups, problems } = parseSetups(
    { setup: "bootstrap" },
    "/x/config.toml",
  );
  expect(setups).toEqual({});
  expect(problems[0]!.message).toContain("setup is a table of setup blocks");
});

test("a setup block is replaced whole, never merged field by field", () => {
  // Half of one file's commands under another file's copy is a run nobody
  // wrote, so the stronger layer's block wins outright and the replacement is
  // recorded against the layer that lost it.
  const { setups, setupFrom, shadowed } = mergeLayers([
    {
      name: "defaults",
      values: builtInDefaults({}, "/home/nobody"),
    } satisfies ConfigLayer,
    {
      name: "user",
      values: {},
      setups: { boxes: { copy: "/a", to: "setup", run: ["one"] } },
    },
    { name: "project", values: {}, setups: { boxes: { run: ["two"] } } },
  ]);
  expect(setups.boxes).toEqual({ run: ["two"] });
  expect(setups.boxes).not.toHaveProperty("copy");
  expect(setupFrom.boxes).toBe("project");
  expect(shadowed).toEqual([
    { table: "setup", name: "boxes", layer: "user", by: "project" },
  ]);
});
test("a setup problem rides the merge naming its table and its layer", () => {
  const { problems } = mergeLayers([
    { name: "defaults", values: builtInDefaults({}, "/home/nobody") },
    {
      name: "user",
      values: {},
      problems: [{ name: "beast", message: "no" }],
      setupProblems: [{ name: "boxes", message: "no" }],
    },
  ]);
  expect(problems.map((one) => [one.table, one.name, one.layer])).toEqual([
    ["hosts", "beast", "user"],
    ["setup", "boxes", "user"],
  ]);
});

test("a block summarises as what it sends and how much it runs", () => {
  expect(summariseSetup({ run: ["a"] })).toBe("1 command");
  expect(summariseSetup({ copy: "/a", to: "b", run: ["a", "b"] })).toBe(
    "copy /a; 2 commands",
  );
});
