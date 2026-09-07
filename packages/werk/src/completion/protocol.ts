/**
 * The wire format a shell reads back.
 *
 * This is cobra's `__complete` protocol, spoken by `gh`, `docker` and
 * `kubectl`: one `value<TAB>description` line per candidate, then a final
 * `:<directive>` line carrying a bitfield of instructions for the shell. Reusing
 * it rather than inventing a format means the shell halves are a known quantity,
 * and carapace can bridge werk for free.
 *
 * The rendering is a pure function of the reply so it can be asserted directly;
 * `writeReply` is the whole of the effect.
 */
import type { Candidate } from "./hooks.js";

/**
 * Bits the shell reads off the last line. `NoFileComp` is werk's usual answer:
 * without it a shell that got no candidates falls back to listing files, which
 * is never what a session name or a label key wanted.
 */
export const Directive = {
  Error: 1,
  NoSpace: 2,
  NoFileComp: 4,
  FilterFileExt: 8,
  FilterDirs: 16,
  KeepOrder: 32,
} as const;

export interface CompletionReply {
  candidates: readonly Candidate[];
  /** A bitwise OR of {@link Directive}. */
  directive: number;
}

/** The empty answer, used for every failure as well as for genuinely nothing. */
export const NOTHING: CompletionReply = {
  candidates: [],
  directive: Directive.NoFileComp,
};

/**
 * A tab ends the value and a newline ends the candidate, so neither may appear
 * inside either. Descriptions come from command help, which wraps over several
 * lines often enough that this is a real hazard rather than a defensive one.
 */
const oneLine = (text: string): string =>
  text
    .replace(/[\t\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export function renderReply(reply: CompletionReply): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const candidate of reply.candidates) {
    const value = oneLine(candidate.value);
    if (value === "" || seen.has(value)) continue;
    seen.add(value);
    const description = candidate.description
      ? oneLine(candidate.description)
      : "";
    lines.push(description ? `${value}\t${description}` : value);
  }
  lines.push(`:${reply.directive}`);
  return lines.join("\n") + "\n";
}

export function writeReply(
  reply: CompletionReply,
  write: (text: string) => void,
): void {
  write(renderReply(reply));
}
