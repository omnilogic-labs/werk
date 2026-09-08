/**
 * What a help page looks like.
 *
 * Every decision about the shape of `werk --help` lives here, so the command
 * tree in `app.ts` says what werk does and this module says how that reads. It
 * is a `HelpConfiguration` — a plain object of overrides that commander merges
 * onto a fresh `Help` with `Object.assign(new Help(), configureHelp())` — so the
 * built-in renderer is still doing the work and this only replaces the parts
 * that differ.
 *
 * ## The page
 *
 * ```
 * Usage:          what to type
 * <description>   what the command is for
 * Examples:       what right looks like, and any notes
 * Arguments:
 * Commands:
 * Options:
 * Global Options:
 * <footer>        where to go next
 * ```
 *
 * Examples lead. werk's central verb hands everything after a bare `--` to a
 * child process, and `werk create -- claude` is a thing no options table can
 * teach; the same block is what someone is shown when they type the command
 * wrong, which is the moment it is worth most. Commands come before options
 * because werk's root is a hub of twelve verbs and its global flags are mostly
 * plumbing, and inherited options come last so the nine lines that repeat on
 * every page repeat at the bottom of it.
 *
 * That order is why `formatHelp` is reimplemented rather than configured:
 * commander fixes its own sequence and `addHelpText("before")` lands above the
 * usage line rather than between sections. The reimplementation calls only the
 * documented helpers — `formatItem`, `groupItems`, `boxWrap`, `visible*` — and
 * mirrors commander 15's `formatHelp`, which is the version to compare against
 * if a section ever stops appearing.
 *
 * ## Notation
 *
 * `[OPTIONAL]`, `<REQUIRED>`, `...` for repeatable, upper case for a name the
 * caller substitutes: POSIX's utility argument syntax, which is the one thing
 * every published CLI guideline agrees on. Requiredness is carried by the
 * brackets alone, which is why nothing here prints a `[required]` marker.
 *
 * The upper-casing is a rendering rule, not a rename. `Argument("[session]")`
 * stays lower case where it is declared, because `declaredGaps` in
 * `commands/define.ts` matches commander's own `missing required argument
 * '<name>'` wording so that the line commander already wrote is deduplicated
 * rather than repeated, and the completion walker indexes the same names.
 *
 * ## Colour
 *
 * Three roles, and no fourth: a heading, a literal you can type, and a name you
 * substitute. What colour each of those is belongs to `@werk/palette` and is
 * asked for through `runtime/style.ts`, so this module names uses and never
 * colours. Everything else — descriptions, the `$` and `#` of an example, the
 * footer — is unstyled, because no exemplar CLI colours description text and dim
 * grey is the specific thing that fails on a terminal whose contrast the reader
 * did not choose.
 *
 * Neither whether colour is written nor which flavour it is written in is
 * decided here. `app.ts` hands the gate to commander through `configureOutput`,
 * and commander strips whatever it did not sanction, so `NO_COLOR`,
 * `--no-color` and a redirected stdout all reach this module as the same
 * instruction.
 */
import {
  Help,
  type Argument,
  Command,
  type HelpConfiguration,
  type Option,
} from "@commander-js/extra-typings";
import type { Styles } from "./style.js";
import { specFor } from "../commands/define.js";

/** Commander types its help hooks against a command with unknown option types. */
type AnyCommand = Parameters<Help["subcommandTerm"]>[0];
const asCommand = (cmd: AnyCommand): Command => cmd as unknown as Command;

/** A term and its description, before either is padded into a column. */
interface Entry {
  readonly term: string;
  readonly description: string;
}

/**
 * A bare upper-case word is a name to substitute even without brackets, which is
 * how `create`'s usage spells the child command line: after `--` werk has
 * stopped parsing, and dropping the brackets marks the change of ownership.
 */
const BARE_PLACEHOLDER = /^[A-Z][A-Z0-9_]*(?:\.\.\.)?$/;
const isPlaceholder = (token: string): boolean =>
  token.startsWith("[") ||
  token.startsWith("<") ||
  BARE_PLACEHOLDER.test(token);

const BRACKETED = /^([[<])(.*)([\]>])$/;
/**
 * One token of a usage line or a term in the notation above.
 *
 * `[command]` becomes `<COMMAND>` rather than `[COMMAND]`: a parent given no
 * subcommand is a usage mistake in werk, not a success, so the token is
 * required and says so.
 */
function notate(token: string): string {
  if (token === "[command]") return "<COMMAND>";
  const bracketed = BRACKETED.exec(token);
  if (!bracketed) return token;
  return `${bracketed[1]}${bracketed[2]!.toUpperCase()}${bracketed[3]}`;
}
const notateAll = (text: string): string =>
  text.split(" ").map(notate).join(" ");

/** The ancestors of a command, as they are typed, without its own name. */
function ancestry(cmd: Command): string[] {
  const names: string[] = [];
  for (let parent = cmd.parent; parent; parent = parent.parent)
    names.unshift(parent.name());
  return names;
}

/**
 * The default rendering of an empty container carries nothing.
 *
 * An annotation exists to tell the reader something — which values are allowed,
 * what happens if they say nothing — and `(default: {})` on a repeatable flag
 * tells them only that a list starts empty. The fragment is removed by the exact
 * text commander built it from, so `(choices: …)`, `(env: …)` and every real
 * default survive whichever position they sit in.
 */
function suppressEmptyDefault(text: string, option: Option): string {
  const value: unknown = option.defaultValue;
  const empty =
    typeof value === "object" &&
    value !== null &&
    Object.keys(value).length === 0 &&
    option.defaultValueDescription === undefined;
  if (!empty) return text;
  const fragment = `default: ${JSON.stringify(value)}`;
  return text
    .replace(` (${fragment})`, "")
    .replace(`${fragment}, `, "")
    .replace(`, ${fragment}`, "");
}

/**
 * The lead that puts a long-only flag's `--` in the same column as one that has
 * a short form. Universal in the tools werk is trying to read like, and the one
 * thing commander does not do for itself.
 */
const LONG_ONLY_LEAD = "    ";

/**
 * The last line of every page.
 *
 * `--json` is a fact about the command someone is about to run rather than about
 * werk in general, so it belongs at the foot of that command's own page. It is
 * exported so `help-format.test.ts` can assert that the line is there without
 * pinning the words, which move with the product.
 */
export const JSON_FOOTER =
  "Every command accepts --json; those that return a result print it as JSON.";

/**
 * The footer, which `app.ts` registers once on the root so it reaches every page
 * in the tree.
 */
export function helpFooter(command: Command): string {
  const lines: string[] = [];
  if (command.createHelp().visibleCommands(command).length > 0)
    lines.push(
      `Run '${[...ancestry(command), command.name()].join(" ")} <COMMAND> --help' for more on a command.`,
    );
  lines.push(JSON_FOOTER);
  return `\n${lines.join("\n")}`;
}

export function helpConfiguration(style: Styles): HelpConfiguration {
  const { heading, literal, placeholder } = style;
  /**
   * Style each token of a usage line or an option term for what it is, one
   * escape per run rather than per word: `-y, --yes` is one literal a reader
   * sees, and splitting it into two identically styled halves only makes the
   * bytes harder to read for anyone inspecting them.
   */
  const tokens = (text: string): string => {
    const indent = /^\s*/.exec(text)![0];
    const runs: { placeholder: boolean; words: string[] }[] = [];
    for (const word of text.slice(indent.length).split(" ")) {
      const role = isPlaceholder(word);
      const last = runs.at(-1);
      if (last && last.placeholder === role) last.words.push(word);
      else runs.push({ placeholder: role, words: [word] });
    }
    return (
      indent +
      runs
        .map((run) =>
          (run.placeholder ? placeholder : literal)(run.words.join(" ")),
        )
        .join(" ")
    );
  };

  /** A heading, its items aligned in a column of their own, and a blank line. */
  function section(
    helper: Help,
    title: string,
    entries: readonly Entry[],
  ): string[] {
    if (entries.length === 0) return [];
    const width = Math.max(
      ...entries.map((entry) => helper.displayWidth(entry.term)),
    );
    return [
      helper.styleTitle(title),
      ...entries.map((entry) =>
        helper.formatItem(entry.term, width, entry.description, helper),
      ),
      "",
    ];
  }

  /**
   * The examples a command declares, and its notes.
   *
   * A note goes on a `#` line above the command it explains rather than trailing
   * it, so a long invocation does not push its own explanation past the width of
   * the window. A blank line fences an annotated example off from its
   * neighbours; a run of bare invocations stays tight.
   */
  function examples(cmd: Command, helper: Help, helpWidth: number): string[] {
    const spec = specFor(cmd);
    if (!spec) return [];
    const blocks = spec.examples.map((example) => ({
      annotated: example.note !== undefined,
      lines: [
        ...(example.note ? [`  # ${example.note}`] : []),
        `  $ ${placeholder(example.run)}`,
      ],
    }));
    const lines: string[] = [];
    blocks.forEach((block, i) => {
      if (i > 0 && (block.annotated || blocks[i - 1]!.annotated))
        lines.push("");
      lines.push(...block.lines);
    });
    const out = [helper.styleTitle("Examples:"), ...lines, ""];
    if (spec.notes) out.push(helper.boxWrap(spec.notes, helpWidth), "");
    return out;
  }

  const optionEntry = (helper: Help, option: Option): Entry => ({
    term: helper.styleOptionTerm(helper.optionTerm(option)),
    description: helper.styleOptionDescription(
      helper.optionDescription(option),
    ),
  });

  return {
    showGlobalOptions: true,

    styleTitle: heading,
    styleUsage: tokens,
    styleOptionTerm: tokens,
    styleCommandText: literal,
    styleSubcommandTerm: literal,
    styleArgumentTerm: placeholder,
    // Descriptions carry the meaning; colour would only compete with them.
    styleDescriptionText: (s) => s,

    commandUsage(cmd) {
      const alias = asCommand(cmd).aliases()[0];
      const own = alias ? `${cmd.name()}|${alias}` : cmd.name();
      const path = [...ancestry(asCommand(cmd)), own].join(" ");
      return notateAll(`${path} ${asCommand(cmd).usage()}`);
    },

    /**
     * The name and its alias, and nothing else. Commander's `[options]` suffix
     * and argument list restate what the command's own page says, and cost the
     * list a column and a half of description width to do it.
     */
    subcommandTerm(cmd) {
      const alias = asCommand(cmd).aliases()[0];
      return alias ? `${cmd.name()}|${alias}` : cmd.name();
    },

    argumentTerm(argument: Argument) {
      const name = argument.name() + (argument.variadic ? "..." : "");
      return notate(argument.required ? `<${name}>` : `[${name}]`);
    },

    optionTerm(option) {
      const lead = option.short ? "" : LONG_ONLY_LEAD;
      return lead + notateAll(option.flags);
    },

    optionDescription(option) {
      return suppressEmptyDefault(
        Help.prototype.optionDescription.call(this as Help, option),
        option,
      );
    },

    formatHelp(cmd, helper) {
      const helpWidth = helper.helpWidth ?? 80;
      const command = asCommand(cmd);
      const out: string[] = [
        `${helper.styleTitle("Usage:")} ${helper.styleUsage(helper.commandUsage(cmd))}`,
        "",
      ];

      const description = helper.commandDescription(cmd);
      if (description.length > 0)
        out.push(
          helper.boxWrap(
            helper.styleCommandDescription(description),
            helpWidth,
          ),
          "",
        );

      out.push(...examples(command, helper, helpWidth));

      out.push(
        ...section(
          helper,
          "Arguments:",
          helper.visibleArguments(cmd).map((argument) => ({
            term: helper.styleArgumentTerm(helper.argumentTerm(argument)),
            description: helper.styleArgumentDescription(
              helper.argumentDescription(argument),
            ),
          })),
        ),
      );

      // `groupItems` is generic over the union of commands and options, which
      // leaves neither branch's own methods reachable; the casts name which one
      // this call is grouping.
      const commandGroups = helper.groupItems<Command>(
        [...cmd.commands] as unknown as Command[],
        helper.visibleCommands(cmd) as unknown as Command[],
        (sub) => sub.helpGroup() || "Commands:",
      );
      for (const [title, subcommands] of commandGroups)
        out.push(
          ...section(
            helper,
            title,
            subcommands.map((sub) => ({
              term: helper.styleSubcommandTerm(helper.subcommandTerm(sub)),
              description: helper.styleSubcommandDescription(
                helper.subcommandDescription(sub),
              ),
            })),
          ),
        );

      const optionGroups = helper.groupItems<Option>(
        [...cmd.options] as Option[],
        helper.visibleOptions(cmd),
        (option) => option.helpGroupHeading ?? "Options:",
      );
      for (const [title, options] of optionGroups)
        out.push(
          ...section(
            helper,
            title,
            options.map((option) => optionEntry(helper, option)),
          ),
        );

      if (helper.showGlobalOptions)
        out.push(
          ...section(
            helper,
            "Global Options:",
            helper
              .visibleGlobalOptions(cmd)
              .map((option) => optionEntry(helper, option)),
          ),
        );

      return out.join("\n");
    },
  };
}
