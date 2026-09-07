/**
 * What someone is told when they type a command wrong.
 *
 * The assertions here are about the shape of the answer — that the rule broken
 * is stated, that the usage line and the command's own examples follow it, that
 * several broken rules arrive together, that `--json` gets one object instead —
 * and not about the wording. Where an example or a requirement sentence is
 * checked it is read back off the command's own spec, so this keeps holding as
 * the prose moves.
 */
import { expect, test } from "bun:test";
import type { Command } from "@commander-js/extra-typings";
import { buildProgram } from "../src/app.js";
import { setChildArgv } from "../src/commands/shared.js";
import { specFor } from "../src/commands/define.js";
import { exitCodeFor, EXIT_OK, EXIT_USAGE } from "../src/runtime/exit.js";

/**
 * Parse a command line and collect what a person would have seen on stderr.
 *
 * Every node is configured, not just the root: `configureOutput` replaces the
 * configuration object rather than mutating it, and the children took their copy
 * of the reference when the tree was built, so configuring the root afterwards
 * would leave a subcommand's error going to the real stderr.
 */
function eachCommand(command: Command): Command[] {
  return [
    command,
    ...command.commands.flatMap((child) => eachCommand(child as Command)),
  ];
}
async function usage(argv: string[], child: string[] = []) {
  setChildArgv(child);
  const program = buildProgram(argv);
  let text = "";
  for (const command of eachCommand(program))
    command.configureOutput({
      writeErr: (str) => void (text += str),
      writeOut: () => {},
      getErrHelpWidth: () => 80,
      getOutHelpWidth: () => 80,
    });
  const error = await program.parseAsync(argv, { from: "user" }).then(
    () => undefined as unknown,
    (thrown: unknown) => thrown,
  );
  return { text, error, code: exitCodeFor(error) };
}
const find = (program: Command, name: string): Command =>
  program.commands.find((c) => c.name() === name) as Command;

test("a command given too little says what it needs, and shows what right looks like", async () => {
  const { text, code } = await usage(["create"]);
  expect(text).toContain("error: ");
  expect(text).toContain("command to run");
  // The usage line, so there is something to copy, and the options, so the rest
  // of the command is discoverable from the point of failure.
  expect(text).toContain("Usage: werk create");
  expect(text).toContain("--name <NAME>");
  // And a worked example, taken from the command's own declaration.
  const example = specFor(find(buildProgram([]), "create"))!.examples[0].run;
  expect(text).toContain(example);
  expect(code).toBe(EXIT_USAGE);
});

test("every rule the invocation breaks is reported at once", async () => {
  // `--name` is left without its value and there is still no command to run:
  // commander notices the first, werk's own requirement is gathered onto it.
  const { text, code } = await usage(["create", "--name"]);
  const problems = text
    .split("\n")
    .filter((line) => line.startsWith("error: "));
  expect(problems.length).toBe(2);
  expect(problems[0]).toContain("--name");
  expect(problems[1]).toContain("command to run");
  expect(code).toBe(EXIT_USAGE);
});

test("a rule that only shows up after the parse is answered the same way", async () => {
  const { text, code } = await usage([
    "attach",
    "s1",
    "--follow",
    "--claim-size",
  ]);
  expect(text).toContain("error: ");
  expect(text).toContain("opposite things");
  expect(text).toContain("Usage: werk attach");
  expect(code).toBe(EXIT_USAGE);
});

test("an unknown command is answered with the list of real ones", async () => {
  const { text, code } = await usage(["creat"]);
  expect(text).toContain("unknown command 'creat'");
  expect(text).toContain("Usage: werk");
  expect(text).toContain("Commands:");
  expect(code).toBe(EXIT_USAGE);
});

test("--json answers a usage failure with one object and no help", async () => {
  const { text, code } = await usage(["--json", "create"]);
  const lines = text.trimEnd().split("\n");
  expect(lines.length).toBe(1);
  expect(text).not.toContain("Usage:");
  const payload = JSON.parse(lines[0]!) as {
    error: { code: string; message: string };
  };
  expect(payload.error.code).toBe("USAGE");
  expect(payload.error.message.length).toBeGreaterThan(0);
  expect(code).toBe(EXIT_USAGE);
});

test("a parent command given no subcommand is a usage mistake, not a success", () => {
  // Commander answers both `--help` and "you gave me no subcommand" with the
  // code `commander.help`, and separates them by exit code.
  expect(exitCodeFor({ code: "commander.help", exitCode: 0 })).toBe(EXIT_OK);
  expect(exitCodeFor({ code: "commander.help", exitCode: 1 })).toBe(EXIT_USAGE);
});
