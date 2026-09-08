/**
 * How a command says what it is for, and what it needs.
 *
 * Every command is built through `defineCommand`, which takes a spec rather than
 * a chain of calls. That is what makes the explanation impossible to forget: a
 * summary, a description and at least one worked example are required fields, so
 * a command added later that omits one does not compile, and one that bypasses
 * this module entirely fails the tree test in `test/help.test.ts`.
 *
 * The spec also carries the rules commander cannot express — "create needs a
 * command after `--`" is not a positional, an option or a conflict — as
 * `Requirement`s that can be checked all at once. Commander reports the first
 * thing it finds wrong; a caller would rather be told everything wrong with what
 * they typed. `augmentErrors` is what turns commander's single message into that
 * list, and it hangs the extra rules off the error commander was already about
 * to raise rather than racing it.
 */
import { Command } from "@commander-js/extra-typings";

/** A line of the examples block: what to type, and optionally why. */
export interface Example {
  readonly run: string;
  readonly note?: string;
}

/**
 * A rule about the whole invocation that commander has no notation for.
 *
 * `need` is a sentence, printed as `error: <need>`, and it says what is needed
 * rather than which clause of the grammar was violated. `met` is given the
 * command so it can read parsed options; a requirement about something outside
 * commander — the child argv, say — can ignore it.
 */
export interface Requirement {
  readonly need: string;
  met(command: Command): boolean;
}

export interface CommandSpec {
  readonly name: string;
  readonly aliases?: readonly string[];
  /** One line, shown beside the name in the parent's command list. */
  readonly summary: string;
  /** The fuller paragraph at the top of this command's own help. */
  readonly description: string;
  /** Replaces the generated usage line, e.g. `[options] -- COMMAND [ARGS...]`. */
  readonly usage?: string;
  /**
   * At least one. The tuple type is the point: a command with no worked example
   * is a compile error rather than something a reviewer has to notice.
   */
  readonly examples: readonly [Example, ...Example[]];
  /** Anything worth knowing that is not an example, printed after them. */
  readonly notes?: string;
  readonly requires?: readonly Requirement[];
}

/**
 * Specs by command, so `withContext`, the error path and the help renderer can
 * find the rules for whichever command is running without threading them
 * through commander.
 */
const SPECS = new WeakMap<Command, CommandSpec>();
export const specFor = (command: Command): CommandSpec | undefined =>
  SPECS.get(command);

/**
 * Give the root program the parts of a spec it can have.
 *
 * The root is the program itself rather than a command, so it is built in
 * `app.ts` and not by `defineCommand`. Its examples still belong on the same
 * shelf as everyone else's: one lookup renders every page in the tree, and a
 * second path for the root alone is a second thing to keep in step.
 */
export function describeRoot(
  command: Command,
  spec: Pick<CommandSpec, "examples"> & Partial<Pick<CommandSpec, "notes">>,
): Command {
  SPECS.set(command, {
    name: command.name(),
    summary: command.description(),
    description: command.description(),
    ...spec,
  });
  return command;
}

/** The rules of this command that what was typed does not satisfy. */
export function unmetRequirements(command: Command): string[] {
  const spec = SPECS.get(command);
  if (!spec?.requires) return [];
  return spec.requires.filter((rule) => !rule.met(command)).map((r) => r.need);
}

/**
 * The failures commander itself declared, read back off the command.
 *
 * Commander stops at the first thing it finds wrong, so a caller who left out
 * two required inputs is told about them one run at a time. Everything needed to
 * report both is already on the command — the registered arguments, the
 * mandatory options and the values parsed so far — so this asks rather than
 * making each command remember to.
 *
 * It runs only for failures raised after `_parseCommand` assigns `this.args`.
 * `optionMissingArgument` and an option's own `invalidArgument` are raised
 * inside `parseOptions`, while the operand list is still the empty one the
 * command was constructed with; a missing positional derived at that moment
 * would be invented rather than observed. The wording matches commander's own,
 * so the line it already wrote is deduplicated rather than repeated.
 */
const AFTER_OPERANDS = new Set([
  "commander.missingArgument",
  "commander.missingMandatoryOptionValue",
  "commander.conflictingOption",
  "commander.excessArguments",
  "commander.unknownOption",
]);
function declaredGaps(command: Command, code?: string): string[] {
  if (code === undefined || !AFTER_OPERANDS.has(code)) return [];
  const gaps: string[] = [];
  command.registeredArguments.forEach((argument, i) => {
    if (argument.required && command.args[i] == null)
      gaps.push(`error: missing required argument '${argument.name()}'`);
  });
  for (const option of command.options)
    if (
      option.mandatory &&
      command.getOptionValue(option.attributeName()) === undefined
    )
      gaps.push(`error: required option '${option.flags}' not specified`);
  return gaps;
}

/**
 * Report every rule the invocation breaks, not just the one commander noticed.
 *
 * Commander's own message arrives first because it is the most specific thing
 * known about the failure; the rest follow, each on its own `error:` line, so
 * `werk create --name` is told both that `--name` wants a value and that there
 * is still no command to run.
 *
 * A requirement whose flags were never reached — parsing stopped earlier — reads
 * as satisfied and goes unreported. That direction is the safe one: a rule
 * silently held back costs a second run, and a rule invented from a half-parsed
 * command line costs the caller's trust in the whole message.
 */
export function augmentErrors(command: Command): Command {
  const raise = command.error.bind(command);
  command.error = ((message: string, options?: { code?: string }) => {
    const lines = [message];
    for (const line of [
      ...declaredGaps(command, options?.code),
      ...unmetRequirements(command).map((need) => `error: ${need}`),
    ])
      if (!lines.includes(line)) lines.push(line);
    return raise(lines.join("\n"), options);
  }) as Command["error"];
  return command;
}

/**
 * Build a command from its spec.
 *
 * `exitOverride` is set here rather than left to the root's
 * `copyInheritedSettings`, because a builder driven directly — which is how the
 * unit tests exercise them — has no root above it, and without it a usage
 * failure would call `process.exit` and take the test runner with it.
 */
export function defineCommand(spec: CommandSpec): Command {
  const command: Command = new Command(spec.name);
  command.summary(spec.summary).description(spec.description).exitOverride();
  if (spec.usage) command.usage(spec.usage);
  for (const alias of spec.aliases ?? []) command.alias(alias);
  SPECS.set(command, spec);
  return augmentErrors(command);
}
