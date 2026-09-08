/**
 * What may follow the words typed so far.
 *
 * The commander tree is the only description of werk's shape, so this walks that
 * rather than keeping a table of its own: commands, aliases, flags and
 * positionals all come off the live `Command` objects, and a parameter that
 * needs live values says so through `completes()`. A completion cannot then
 * describe a command that does not exist, or miss one that does.
 *
 * Two rules govern everything below. Nothing here throws — a shell is blocked on
 * the answer, and an error message where candidates were expected is worse than
 * no candidates at all. And nothing here starts a daemon or waits long for one:
 * pressing TAB must not launch a background process, so the only route to a
 * client is {@link connectExistingDaemon}, under a hard budget.
 */
import type {
  Argument,
  CommandUnknownOpts,
  Option,
} from "@commander-js/extra-typings";
import path from "node:path";
import type { SessionInfo } from "@werk/session";
import { workspaceAt } from "@werk/workspace";
import { connectExistingDaemon } from "../runtime/daemon.js";
import { summariseHost } from "../config/hosts.js";
import {
  providerFor,
  type Candidate,
  type CandidateProvider,
  type CompletionContext,
} from "./hooks.js";
import { Directive, NOTHING, type CompletionReply } from "./protocol.js";

/**
 * How long the daemon has, connection and query together. A shell that waits on
 * werk feels broken, so the budget is short enough to be imperceptible and
 * running out is not an error: it is an empty list.
 */
export const BUDGET_MS = 150;

/* ------------------------------------------------------------------ daemon */

async function withinBudget<T>(work: Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), BUDGET_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Every session the running daemon knows about, or none. `connectExistingDaemon`
 * returns undefined for every reason a daemon might not answer, including that
 * there is no daemon at all, and it never starts one.
 */
export async function liveSessions(
  ctx: CompletionContext,
): Promise<readonly SessionInfo[]> {
  const lookup = (async () => {
    // No entry path: nothing on this route can spawn, so there is nothing for a
    // child process to be told to run.
    const existing = await connectExistingDaemon(
      { runtimeDir: ctx.runtimeDir, stateDir: ctx.stateDir, entry: "" },
      BUDGET_MS,
    );
    if (!existing) return [];
    const { client } = existing;
    try {
      return await client.list({});
    } catch {
      return [];
    } finally {
      // Attached to the work rather than to the race, so a lookup that lost the
      // race still gives its socket back and the process can exit.
      await client.close().catch(() => {});
    }
  })().catch((): readonly SessionInfo[] => []);
  return withinBudget<readonly SessionInfo[]>(lookup, []);
}

/**
 * Live sessions, by name, by workspace and by id.
 *
 * Everything `resolveSession` accepts is offered, or completion would suggest
 * a word the command then refuses, and refuse a word it never suggested. The
 * name and the workspace are short and are always offered. Ids are long and
 * would double the length of every list, so they only appear once the caller
 * has typed something an id starts with — which is what happens when a
 * `werk list` id is pasted back.
 */
export const sessionCandidates: CandidateProvider = async (partial, ctx) => {
  const sessions = await liveSessions(ctx);
  const root = path.join(ctx.stateDir, "workspaces");
  const candidates: Candidate[] = [];
  for (const session of sessions) {
    const description = `${session.state} · ${session.argv.join(" ")}`;
    if (session.name) candidates.push({ value: session.name, description });
    const workspace = workspaceAt(root, session.cwd)?.name;
    // Offered only when it says something the name did not; a workspace named
    // after its session would otherwise be two identical rows.
    if (workspace && workspace !== session.name)
      candidates.push({ value: workspace, description });
  }
  if (partial !== "")
    for (const session of sessions)
      if (session.id.startsWith(partial))
        candidates.push({ value: session.id, description: session.name });
  return candidates;
};

/**
 * The labels sessions are actually carrying, as `KEY=` while the key is still
 * being typed and as `KEY=VALUE` once it is settled. Offering a bare key would
 * complete to something `--label` rejects.
 */
export const labelCandidates: CandidateProvider = async (partial, ctx) => {
  const sessions = await liveSessions(ctx);
  const at = partial.indexOf("=");
  if (at >= 0) {
    const key = partial.slice(0, at);
    const values = new Set<string>();
    for (const session of sessions) {
      const value = session.labels?.[key];
      if (value !== undefined) values.add(value);
    }
    return [...values].sort().map((value) => ({ value: `${key}=${value}` }));
  }
  const keys = new Set<string>();
  for (const session of sessions)
    for (const key of Object.keys(session.labels ?? {})) keys.add(key);
  return [...keys]
    .sort()
    .map((key) => ({ value: `${key}=`, description: "label key" }));
};

/**
 * The machines `--host` accepts, which is every `[hosts.<name>]` in force plus
 * the built-in `local`.
 *
 * The one provider here that reaches nothing. The names came out of the same
 * config read `complete` already does under its own budget, so a TAB on
 * `--host` costs no daemon, no ssh and no second read; a completion that
 * abandoned the layers offers nothing rather than a stale list.
 */
export const hostCandidates: CandidateProvider = (_partial, ctx) =>
  Object.entries(ctx.hosts ?? {}).map(([name, host]) => ({
    value: name,
    description: summariseHost(host),
  }));

/* -------------------------------------------------------------- tree walk */

/** Hidden commands are still parsed, so they are still descended into. */
function subcommandFor(
  command: CommandUnknownOpts,
  token: string,
): CommandUnknownOpts | undefined {
  return command.commands.find(
    (child) => child.name() === token || child.aliases().includes(token),
  );
}

/**
 * The options in scope, nearest first. werk's global flags are declared on the
 * root and accepted after a command name, so an ancestor's options are as
 * completable here as the command's own.
 */
function optionsInScope(command: CommandUnknownOpts): Option[] {
  const options: Option[] = [];
  const seen = new Set<string>();
  for (
    let current: CommandUnknownOpts | null = command;
    current;
    current = current.parent
  )
    for (const option of current.createHelp().visibleOptions(current)) {
      const key = option.long ?? option.short ?? option.flags;
      if (seen.has(key)) continue;
      seen.add(key);
      options.push(option);
    }
  return options;
}

const optionNamed = (options: readonly Option[], token: string) =>
  options.find((option) => option.long === token || option.short === token);

const takesValue = (option: Option) => option.required || option.optional;

/**
 * The argument filling position `index`. A trailing variadic swallows every
 * position from its own onwards, so it keeps answering past the end of the list.
 */
function argumentAt(
  command: CommandUnknownOpts,
  index: number,
): Argument | undefined {
  const args = command.registeredArguments;
  if (index < args.length) return args[index];
  const last = args.at(-1);
  return last?.variadic ? last : undefined;
}

interface Position {
  command: CommandUnknownOpts;
  /** Positionals already given to `command`, flags and their values aside. */
  operands: number;
  /** Set when the word being completed is this option's value. */
  pending?: Option;
}

/** Replay the words already typed to find out what the next one would be. */
function walk(
  program: CommandUnknownOpts,
  preceding: readonly string[],
): Position {
  let command = program;
  let operands = 0;
  let pending: Option | undefined;
  for (const token of preceding) {
    if (pending) {
      pending = undefined;
      continue;
    }
    if (token.startsWith("-") && token !== "-") {
      const attached = token.indexOf("=");
      const name = attached > 0 ? token.slice(0, attached) : token;
      const option = optionNamed(optionsInScope(command), name);
      // `--flag=value` carries its own value; only the separated form takes the
      // token after it.
      if (option && takesValue(option) && attached < 0) pending = option;
      continue;
    }
    // Commander only reads the first operand as a subcommand name, so neither
    // does this: `werk attach serve` names a session, not a daemon command.
    const child = operands === 0 ? subcommandFor(command, token) : undefined;
    if (child) {
      command = child;
      operands = 0;
      continue;
    }
    operands++;
  }
  return { command, operands, pending };
}

/* ------------------------------------------------------------- candidates */

const matching = (candidates: readonly Candidate[], partial: string) =>
  candidates.filter((candidate) => candidate.value.startsWith(partial));

/**
 * A candidate ending in `=` is half a word, so the shell must not put a space
 * after it. Only claimed when every candidate is like that, because the
 * directive covers the whole reply.
 */
function reply(candidates: readonly Candidate[]): CompletionReply {
  const partial =
    candidates.length > 0 && candidates.every((c) => c.value.endsWith("="));
  return {
    candidates,
    directive: Directive.NoFileComp | (partial ? Directive.NoSpace : 0),
  };
}

function flagCandidates(command: CommandUnknownOpts): Candidate[] {
  const candidates: Candidate[] = [];
  for (const option of optionsInScope(command)) {
    if (option.long)
      candidates.push({ value: option.long, description: option.description });
    if (option.short)
      candidates.push({ value: option.short, description: option.description });
  }
  return candidates;
}

/**
 * Subcommands by name, plus any alias the caller has already started typing.
 * Listing every alias unprompted would show `list` and `ls` as two things.
 */
function commandCandidates(
  command: CommandUnknownOpts,
  partial: string,
): Candidate[] {
  const candidates: Candidate[] = [];
  for (const child of command.createHelp().visibleCommands(command)) {
    // The one-line summary, not the paragraph: a completion menu has one row
    // per candidate, and `description()` is the whole page-opening explanation.
    const summary = child.summary() || child.description();
    candidates.push({ value: child.name(), description: summary });
    if (partial !== "")
      for (const alias of child.aliases())
        if (alias.startsWith(partial))
          candidates.push({ value: alias, description: summary });
  }
  return candidates;
}

/** A flag whose value is a filesystem path is best completed by the shell. */
const wantsDirectory = (option: Option) =>
  /<[A-Z_]*PATH[A-Z_]*>/.test(option.flags);

async function valuesFor(
  parameter: Option | Argument,
  partial: string,
  ctx: CompletionContext,
): Promise<readonly Candidate[]> {
  if (parameter.argChoices)
    return parameter.argChoices.map((value) => ({ value }));
  const provider = providerFor(parameter);
  return provider ? await provider(partial, ctx) : [];
}

async function optionValueReply(
  option: Option,
  partial: string,
  ctx: CompletionContext,
): Promise<CompletionReply> {
  const candidates = matching(await valuesFor(option, partial, ctx), partial);
  if (candidates.length === 0 && wantsDirectory(option))
    return { candidates: [], directive: Directive.FilterDirs };
  return reply(candidates);
}

/**
 * The candidates for the last word of `words`, which is the one being completed
 * and is empty when the cursor sits after a space.
 */
export async function completionFor(
  program: CommandUnknownOpts,
  words: readonly string[],
  ctx: CompletionContext,
): Promise<CompletionReply> {
  try {
    const partial = words.at(-1) ?? "";
    const preceding = words.slice(0, -1);
    // What follows a bare `--` is the child program's command line. werk does
    // not parse it, so it has nothing to say about it either — and guessing
    // would put werk's own flags into somebody else's argv.
    if (preceding.includes("--")) return NOTHING;

    const { command, operands, pending } = walk(program, preceding);
    if (pending) return await optionValueReply(pending, partial, ctx);

    // `--flag=` is one word to the shell, so the flag is put back on the front
    // of every candidate or the value would replace it.
    const attached = partial.startsWith("--") ? partial.indexOf("=") : -1;
    if (attached > 0) {
      const name = partial.slice(0, attached);
      const option = optionNamed(optionsInScope(command), name);
      if (option && takesValue(option)) {
        const inner = await optionValueReply(
          option,
          partial.slice(attached + 1),
          ctx,
        );
        return {
          ...inner,
          candidates: inner.candidates.map((candidate) => ({
            ...candidate,
            value: `${name}=${candidate.value}`,
          })),
        };
      }
      return NOTHING;
    }

    if (partial.startsWith("-"))
      return reply(matching(flagCandidates(command), partial));

    const candidates: Candidate[] = [];
    if (operands === 0) candidates.push(...commandCandidates(command, partial));
    const argument = argumentAt(command, operands);
    if (argument) candidates.push(...(await valuesFor(argument, partial, ctx)));
    return reply(matching(candidates, partial));
  } catch {
    return NOTHING;
  }
}
