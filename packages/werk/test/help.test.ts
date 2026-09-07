/**
 * Every command's help, held against a committed golden file.
 *
 * Help is the only description of werk that a person is guaranteed to read, so
 * an option that arrives without one, or a command whose summary quietly
 * changes, should fail the build rather than ship. The golden file is the plain
 * help text of every node in the tree, so a diff of it reads as the change to
 * the documentation itself.
 *
 * Regenerate after a deliberate change:
 *
 *   UPDATE_HELP_GOLDEN=1 bun test packages/werk/test/help.test.ts
 */
import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import type { Command } from "@commander-js/extra-typings";
import { buildProgram } from "../src/app.js";

const GOLDEN = new URL("./help.golden.txt", import.meta.url);
const HEADER = `werk help, one section per command in the order the tree declares them.
Regenerate with: UPDATE_HELP_GOLDEN=1 bun test packages/werk/test/help.test.ts`;

interface Node {
  /** How the command is typed, e.g. `werk daemon serve`. */
  readonly path: string;
  readonly command: Command;
}
/**
 * The whole tree, hidden commands included: `commands` holds them too, and a
 * hidden command still has help of its own that someone reads when debugging.
 */
function walk(command: Command, path = "werk"): Node[] {
  return [
    { path, command },
    ...command.commands.flatMap((child) =>
      walk(child as Command, `${path} ${(child as Command).name()}`),
    ),
  ];
}
/**
 * `--no-color` settles the colour gate before anything reads the environment or
 * asks about a terminal, and pinning the help width stops the snapshot moving
 * with the width of whatever window the suite is run in.
 */
function tree(): Node[] {
  const nodes = walk(buildProgram(["--no-color"]));
  for (const { command } of nodes)
    command.configureOutput({
      getOutHelpWidth: () => 80,
      getErrHelpWidth: () => 80,
    });
  return nodes;
}
const document = () =>
  [
    HEADER,
    ...tree().map(
      ({ path, command }) =>
        `${"=".repeat(72)}\n$ ${path} --help\n\n${command.helpInformation().trimEnd()}`,
    ),
  ].join("\n\n") + "\n";

test("every command and option describes itself", () => {
  for (const { path, command } of tree()) {
    expect(command.description(), `${path} has no description`).not.toBe("");
    for (const option of command.options)
      expect(
        option.description,
        `${path} ${option.flags} has no description`,
      ).not.toBe("");
  }
});

test("the tree still holds the commands werk documents", () => {
  const paths = tree().map((node) => node.path);
  // Named rather than counted, so adding a command is a deliberate edit here.
  expect(paths).toEqual([
    "werk",
    "werk create",
    "werk list",
    "werk attach",
    "werk logs",
    "werk kill",
    "werk remove",
    "werk watch",
    "werk info",
    "werk doctor",
    "werk config",
    "werk config list",
    "werk config get",
    "werk config sources",
    "werk config path",
    "werk completion",
    "werk completion bash",
    "werk completion zsh",
    "werk completion fish",
    "werk daemon",
    "werk daemon serve",
    "werk complete",
    "werk session-daemon",
  ]);
});

test("the help of every command matches the golden file", async () => {
  const rendered = document();
  if (process.env.UPDATE_HELP_GOLDEN) await writeFile(GOLDEN, rendered);
  expect(rendered).toBe(await readFile(GOLDEN, "utf8"));
});
