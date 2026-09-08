/**
 * Asking the caller something, when there is somebody there to ask.
 *
 * Every JS prompt library behaves the same way when nothing is going to answer:
 * with `< /dev/null` the promise never settles and the process exits having done
 * nothing at all, and on an idle pipe it waits forever. clack is no exception.
 * So a prompt is not something a command may reach for and then recover from —
 * it is something it is only allowed to reach at all when {@link canPrompt} says
 * so, and even then it carries a deadline. Refusing is cheap; a wedged CI job is
 * not.
 *
 * Whether prompting is allowed is decided once, in `context.ts`, from the flags
 * and the terminals werk was given. Nothing here recomputes it: a second opinion
 * would eventually disagree with the first.
 */
import type { Readable, Writable } from "node:stream";
import {
  autocomplete as clackAutocomplete,
  confirm as askConfirm,
  intro as clackIntro,
  isCancel,
  note as clackNote,
  outro as clackOutro,
  select as clackSelect,
  spinner as clackSpinner,
  text as clackText,
  type Option,
  type SpinnerResult,
} from "@clack/prompts";
import type { SessionInfo } from "@werk/session";
import type { WerkContext } from "./context.js";
import { CancelledError, UsageError } from "./exit.js";

/**
 * How long a prompt may go unanswered. Long enough that a person reading the
 * list is never cut off mid-thought, short enough that a terminal left open
 * overnight does not hold a session, a socket and a daemon connection with it.
 */
export const PROMPT_TIMEOUT_MS = 120_000;

export interface PromptOptions {
  /** Overrides {@link PROMPT_TIMEOUT_MS}; a test uses it to expire at once. */
  timeoutMs?: number;
  /** The streams the prompt reads and paints on; the real ones by default. */
  input?: Readable;
  output?: Writable;
}

/**
 * A prompt is werk talking, not the command's output, so it paints on stderr for
 * the same reason errors do: whatever ends up on stdout is the answer, and a
 * question drawn into it would have to be filtered back out.
 */
const paintOn = (options: PromptOptions): Writable =>
  options.output ?? process.stderr;

/** Whether there is a terminal, and permission, to ask a question through. */
export function canPrompt(ctx: WerkContext): boolean {
  return !ctx.noInput;
}

/**
 * Run one prompt under a deadline and turn clack's vocabulary into werk's.
 *
 * clack reports a cancelled prompt by resolving with a sentinel rather than by
 * throwing, which is exactly the shape that gets mistaken for an answer. It
 * treats an aborted signal the same way, so the deadline arrives here as a
 * cancellation too — either way nobody answered, and nothing downstream should
 * proceed as though somebody had.
 */
async function answered<T>(
  ask: (signal: AbortSignal) => Promise<T | symbol>,
  options: PromptOptions,
): Promise<T> {
  const signal = AbortSignal.timeout(options.timeoutMs ?? PROMPT_TIMEOUT_MS);
  const value = await ask(signal);
  if (isCancel(value))
    throw new CancelledError(
      signal.aborted ? "nothing answered the prompt in time" : "cancelled",
    );
  return value as T;
}

/** The name a session is known by, falling back to the id it was given. */
export const displayName = (session: SessionInfo): string =>
  session.name || session.id.slice(0, 12);

/**
 * The last sign of life. A session the caller was just typing in should be the
 * one the list opens on, which creation time alone would not give: a long-lived
 * session is the oldest thing in the list and often the only one wanted.
 */
export function recency(session: SessionInfo): number {
  return Math.max(
    session.createdAt,
    session.lastOutputAt ?? 0,
    session.lastInputAt ?? 0,
  );
}

/**
 * The rows of the picker, most recent first.
 *
 * Name, state and command all go in the label rather than the hint, because
 * clack shows a hint only for the row the cursor is on — and because the label
 * is what its search filters against, so typing part of a command finds the
 * session running it. The columns are padded to the widest entry so the list
 * reads down as well as across.
 */
export function sessionChoices(
  sessions: readonly SessionInfo[],
): { value: string; label: string; hint: string }[] {
  const ordered = [...sessions].sort((a, b) => recency(b) - recency(a));
  const nameWidth = Math.max(0, ...ordered.map((s) => displayName(s).length));
  const stateWidth = Math.max(0, ...ordered.map((s) => s.state.length));
  return ordered.map((session) => ({
    value: session.id,
    label: [
      displayName(session).padEnd(nameWidth),
      session.state.padEnd(stateWidth),
      session.argv.join(" "),
    ].join("  "),
    hint: session.id.slice(0, 12),
  }));
}

/**
 * Which session, asked as a searchable list. The caller has already decided that
 * asking is allowed and that there is something to offer; both are checked again
 * here because getting either wrong is a hang rather than a wrong answer.
 */
export async function selectSession(
  ctx: WerkContext,
  sessions: readonly SessionInfo[],
  message = "Which session?",
  options: PromptOptions = {},
): Promise<string> {
  if (!canPrompt(ctx))
    throw new UsageError("name a session; there is no terminal to pick one in");
  if (sessions.length === 0)
    throw new UsageError(
      "there are no sessions to choose from; `werk create` starts one",
    );
  return await answered<string>(
    (signal) =>
      clackAutocomplete<string>({
        message,
        options: sessionChoices(sessions),
        placeholder: "type to filter",
        maxItems: 10,
        signal,
        input: options.input,
        output: paintOn(options),
      }),
    options,
  );
}

/**
 * A yes or no. `--yes` answers it without asking, which is the only answer a
 * caller with no terminal has: refusing to guess is what keeps a script from
 * silently taking the default for something it was never shown.
 */
export async function confirm(
  ctx: WerkContext,
  message: string,
  options: PromptOptions = {},
): Promise<boolean> {
  if (ctx.yes) return true;
  if (!canPrompt(ctx))
    throw new UsageError(
      `${message} There is no terminal to ask in, so pass --yes.`,
    );
  return await answered<boolean>(
    (signal) =>
      askConfirm({
        message,
        signal,
        input: options.input,
        output: paintOn(options),
      }),
    options,
  );
}

/* ------------------------------------------------------------- the wrappers */

/**
 * One row of a list: the value a caller wants back, and how it reads.
 *
 * clack's own option type is conditional on whether the value is a primitive,
 * which makes it awkward to write a generic wrapper against. Every list werk
 * offers is keyed by a string, so this is the narrower shape and the conversion
 * happens once.
 */
export interface Choice<T extends string> {
  readonly value: T;
  readonly label?: string;
  readonly hint?: string;
}

/**
 * clack's `Option<Value>` is conditional on `Value extends Primitive`, which
 * TypeScript cannot resolve while `Value` is still a type parameter, so the
 * narrowing is asserted here, once, rather than at each call.
 */
const rows = <T extends string>(choices: readonly Choice<T>[]) =>
  choices.map((choice) => ({ ...choice })) as unknown as Option<T>[];

/**
 * Every prompt in werk goes through one of these.
 *
 * The deadline and the cancel-sentinel conversion in {@link answered} are the
 * two things that must never be skipped, and a command that reached for clack
 * itself would skip both. So no file under `src/commands/` imports
 * `@clack/prompts`; a test asserts it, because the failure it prevents is a
 * process that hangs rather than one that misbehaves visibly.
 *
 * The guard is repeated in each of them rather than left to the caller for the
 * same reason: reaching a prompt with nothing to answer it is a hang, and a
 * hang is worse than a refusal.
 */
function guard(ctx: WerkContext, message: string): void {
  if (!canPrompt(ctx))
    throw new UsageError(
      `${message} There is no terminal to ask in, so pass the answer as a flag.`,
    );
}

export interface TextPrompt {
  readonly message: string;
  /** Shown ready to edit when the prompt opens. */
  readonly initialValue?: string;
  readonly placeholder?: string;
  /** What an empty answer means, when an empty answer is allowed. */
  readonly defaultValue?: string;
  /** A sentence when the value will not do, or undefined when it will. */
  readonly validate?: (value: string) => string | undefined;
}

/** A line of typing. */
export async function text(
  ctx: WerkContext,
  ask: TextPrompt,
  options: PromptOptions = {},
): Promise<string> {
  guard(ctx, ask.message);
  return await answered<string>(
    (signal) =>
      clackText({
        message: ask.message,
        ...(ask.initialValue === undefined
          ? {}
          : { initialValue: ask.initialValue }),
        ...(ask.placeholder === undefined
          ? {}
          : { placeholder: ask.placeholder }),
        ...(ask.defaultValue === undefined
          ? {}
          : { defaultValue: ask.defaultValue }),
        // clack hands a validator `undefined` for an empty field; werk's are
        // written against a string, so the two are reconciled once, here.
        ...(ask.validate === undefined
          ? {}
          : { validate: (value?: string) => ask.validate!(value ?? "") }),
        signal,
        input: options.input,
        output: paintOn(options),
      }),
    options,
  );
}

/** One of a short list, with the cursor starting on `initialValue`. */
export async function select<T extends string>(
  ctx: WerkContext,
  ask: {
    message: string;
    options: readonly Choice<T>[];
    initialValue?: T;
  },
  options: PromptOptions = {},
): Promise<T> {
  guard(ctx, ask.message);
  return await answered<T>(
    (signal) =>
      clackSelect<T>({
        message: ask.message,
        options: rows(ask.options),
        ...(ask.initialValue === undefined
          ? {}
          : { initialValue: ask.initialValue }),
        signal,
        input: options.input,
        output: paintOn(options),
      }),
    options,
  );
}

/** One of a long list, filtered by typing. */
export async function autocomplete<T extends string>(
  ctx: WerkContext,
  ask: {
    message: string;
    options: readonly Choice<T>[];
    placeholder?: string;
    maxItems?: number;
    initialValue?: T;
  },
  options: PromptOptions = {},
): Promise<T> {
  guard(ctx, ask.message);
  return await answered<T>(
    (signal) =>
      clackAutocomplete<T>({
        message: ask.message,
        options: rows(ask.options),
        maxItems: ask.maxItems ?? 10,
        ...(ask.placeholder === undefined
          ? {}
          : { placeholder: ask.placeholder }),
        ...(ask.initialValue === undefined
          ? {}
          : { initialValue: ask.initialValue }),
        signal,
        input: options.input,
        output: paintOn(options),
      }),
    options,
  );
}

/**
 * The three that say something rather than ask it. They are here so a command
 * has one import for the whole conversation, and so they paint on stderr like
 * everything else werk says while a command is still deciding what to answer.
 */
export function note(
  message: string,
  title?: string,
  options: PromptOptions = {},
): void {
  clackNote(message, title, { output: paintOn(options) });
}
export function intro(title: string, options: PromptOptions = {}): void {
  clackIntro(title, { output: paintOn(options) });
}
export function outro(message: string, options: PromptOptions = {}): void {
  clackOutro(message, { output: paintOn(options) });
}
/** Something slow, with a sign that it is still going. */
export function spinner(options: PromptOptions = {}): SpinnerResult {
  return clackSpinner({ output: paintOn(options) });
}
