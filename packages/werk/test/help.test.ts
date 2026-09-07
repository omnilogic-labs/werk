/**
 * That every command explains itself, held as properties rather than as text.
 *
 * Help is the only description of werk that a person is guaranteed to read, so a
 * command that arrives without a summary, without a description, without an
 * option description or without a worked example should fail the build rather
 * than ship. What none of these tests do is pin the wording: the prose moves
 * with the product, and a test that has to be regenerated after every edit to it
 * stops being read and starts being reset.
 *
 * The one thing asserted about rendered text is that a command's declared
 * examples reach the page. `addHelpText` is implemented as `beforeHelp` and
 * `afterHelp` listeners that only `outputHelp()` fires — `helpInformation()`
 * returns a string without them — so this is the check that the examples a
 * command declares are examples a person is shown.
 */
import { expect, test } from "bun:test";
import type { Command } from "@commander-js/extra-typings";
import { buildProgram } from "../src/app.js";
import { specFor } from "../src/commands/define.js";

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
 * asks about a terminal, and pinning the help width keeps a rendered assertion
 * from moving with the width of whatever window the suite is run in.
 */
const tree = (): Node[] => walk(buildProgram(["--no-color"]));

/** What a person sees, which is not what `helpInformation()` returns. */
function rendered(command: Command): string {
  let text = "";
  command.configureOutput({
    getOutHelpWidth: () => 80,
    getErrHelpWidth: () => 80,
    writeOut: (str) => void (text += str),
  });
  command.outputHelp();
  return text;
}

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

test("every command declares a summary, a description and an example", () => {
  // The root is the program itself and is configured in `app.ts`; everything
  // below it is a command and goes through `defineCommand`, which is what makes
  // the explanation a required field rather than something to remember.
  for (const { path, command } of tree().slice(1)) {
    const spec = specFor(command);
    expect(spec, `${path} was not built with defineCommand`).toBeDefined();
    expect(spec!.summary, `${path} has no summary`).not.toBe("");
    expect(spec!.description, `${path} has no description`).not.toBe("");
    expect(spec!.examples.length, `${path} has no example`).toBeGreaterThan(0);
  }
});

test("the examples a command declares are examples a person is shown", () => {
  for (const { path, command } of tree().slice(1)) {
    const help = rendered(command);
    for (const example of specFor(command)!.examples)
      expect(help, `${path} help omits: ${example.run}`).toContain(example.run);
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
