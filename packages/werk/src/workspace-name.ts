/**
 * What a workspace is called, when nobody typed the name itself.
 *
 * `create` asks what the work is going to be and gets a sentence back. A
 * sentence is not a branch name, so it is reduced here to the few words that
 * carry the meaning: "fix the login redirect on Safari" becomes
 * `fix-login-redirect-safari`. Nothing clever is attempted — no stemming, no
 * dictionary — because the person is right there and can read what it made.
 *
 * When there is no sentence, because nobody was asked or the answer was empty,
 * the name is made up instead: `magical-otters-flexing`, from the lists in
 * `workspace-words.ts`. Two made-up names are told apart at a glance, which
 * matters on a `werk list` row and in `git branch` output.
 *
 * Neither form carries a digest, so neither is unique on its own. Uniqueness is
 * the job of {@link workspaceNames}, which offers a sequence rather than a
 * name: `create` walks it until the maker accepts one. A name a person typed is
 * a sequence of one, so asking twice for the same one is still the conflict it
 * looks like.
 */
import { randomInt } from "node:crypto";
import { ADJECTIVES, NOUNS, VERBINGS } from "./workspace-words.js";

/**
 * Words that say nothing about the work.
 *
 * Articles, prepositions and auxiliaries, plus the handful of verbs that mean
 * "do some work" — `work`, `make`, `try` — since a workspace is already work
 * and a name that says so twice is shorter without it. Everything else is kept:
 * `fix`, `add`, `port` and the nouns beside them are what makes one name
 * different from the next.
 *
 * Dropping these is skipped entirely when it would leave nothing, so
 * "what about the other one" still names a workspace rather than falling
 * through to a made-up one.
 */
const FILLER = new Set([
  "a",
  "about",
  "after",
  "all",
  "also",
  "am",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "been",
  "being",
  "but",
  "by",
  "can",
  "could",
  "did",
  "do",
  "does",
  "doing",
  "done",
  "for",
  "from",
  "get",
  "getting",
  "go",
  "going",
  "had",
  "has",
  "have",
  "having",
  "he",
  "her",
  "here",
  "hers",
  "him",
  "his",
  "how",
  "i",
  "if",
  "im",
  "in",
  "into",
  "is",
  "it",
  "its",
  "ive",
  "just",
  "make",
  "makes",
  "making",
  "may",
  "me",
  "might",
  "mine",
  "more",
  "most",
  "much",
  "must",
  "my",
  "need",
  "needs",
  "now",
  "of",
  "on",
  "onto",
  "or",
  "ought",
  "our",
  "ours",
  "out",
  "over",
  "own",
  "please",
  "really",
  "s",
  "she",
  "should",
  "so",
  "some",
  "something",
  "stuff",
  "such",
  "t",
  "than",
  "that",
  "the",
  "their",
  "theirs",
  "them",
  "then",
  "there",
  "these",
  "they",
  "thing",
  "things",
  "this",
  "those",
  "through",
  "to",
  "try",
  "trying",
  "under",
  "up",
  "us",
  "very",
  "want",
  "wanted",
  "wants",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "while",
  "who",
  "whom",
  "why",
  "will",
  "with",
  "work",
  "working",
  "would",
  "you",
  "your",
  "yours",
]);

/** How many words of a description reach the name. */
export const NAME_WORDS = 4;
/**
 * How long the name may be. A workspace name is a directory leaf and a branch
 * name, both of which tolerate far more than this; the limit is about a `werk
 * list` row and a shell prompt, not about the filesystem.
 */
export const NAME_CHARS = 40;

/**
 * The words a description is made of, as a name may spell them.
 *
 * The normalisation happens in one order and it matters: decomposing first puts
 * an accent in its own code point so removing the marks leaves `resume` rather
 * than dropping the letter; splitting `camelCase` needs the capital that
 * lowercasing is about to destroy; and everything that is not a letter or a
 * digit is a word boundary, which covers punctuation, emoji and any script this
 * cannot spell.
 */
export function wordsOf(description: string): string[] {
  return description
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== "");
}

/**
 * A name from what somebody typed, or undefined when they typed nothing a name
 * can be made of.
 *
 * The character limit is applied word by word rather than by cutting the joined
 * string, so a name never ends mid-word or on a dash. A single word longer than
 * the limit is the one exception and is simply cut, because there is nothing
 * else to keep.
 */
export function describedName(description: string): string | undefined {
  const words = wordsOf(description);
  const meaning = words.filter((word) => !FILLER.has(word));
  const chosen = (meaning.length > 0 ? meaning : words).slice(0, NAME_WORDS);
  let name = "";
  for (const word of chosen) {
    const grown = name === "" ? word : `${name}-${word}`;
    if (name !== "" && grown.length > NAME_CHARS) break;
    name = grown;
  }
  return name === "" ? undefined : name.slice(0, NAME_CHARS);
}

/** Picks one of a list; `randomInt` is uniform, unlike scaling `Math.random`. */
export type Pick = (bound: number) => number;

/**
 * A name nobody asked for: adjective, noun, verb, in that order.
 *
 * The picker is a parameter so a test can fix which words come out. It is not
 * a seed, because the source is `node:crypto` rather than a generator this
 * could hold.
 */
export function whimsicalName(pick: Pick = randomInt): string {
  const from = <T>(words: readonly T[]): T => words[pick(words.length)]!;
  return [from(ADJECTIVES), from(NOUNS), from(VERBINGS)].join("-");
}

/**
 * Every name `create` may use, best first.
 *
 * A typed name is offered once and never altered: `--workspace fix-login` means
 * that branch or nothing. A described name is offered as typed and then
 * numbered, so a person who describes the same work twice gets `fix-login` and
 * `fix-login-2` rather than a refusal. A made-up name is offered again and
 * again, freshly, because a second `magical-otters-flexing` reads better as an
 * unrelated animal than as a numbered one.
 *
 * The sequence is walked by the caller against a real maker, so it is consumed
 * lazily. Only the typed branch ends: a generated name has no reason to give
 * up, and `create` bounds how many it will try rather than the sequence doing
 * it here.
 */
export function* workspaceNames(
  typed: string | undefined,
  description: string | undefined,
  pick: Pick = randomInt,
): Generator<string> {
  if (typed !== undefined) {
    yield typed;
    return;
  }
  const described =
    description === undefined ? undefined : describedName(description);
  if (described !== undefined) {
    yield described;
    for (let n = 2; ; n += 1) yield `${described}-${n}`;
  }
  for (;;) yield whimsicalName(pick);
}
