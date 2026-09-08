/**
 * Writing a config file back without disturbing anything a person put in it.
 *
 * The file is invited to be hand-edited, so the comments, the blank lines, the
 * key order, the indentation and the line endings in it are somebody's work.
 * Parsing the whole file and stringifying it again would throw all of that away
 * — confbox's `stringifyTOML`, which c12 carries, says as much in its own
 * documentation — so this splices instead. Everything outside the region being
 * replaced comes back byte for byte, because it is never touched at all.
 *
 * A splicer is easier to get wrong than a round trip, and this one is
 * deliberately incomplete: it writes whole `[hosts.<name>]` tables and single
 * top-level scalar lines, and never edits inside a table it did not write. What
 * makes that safe is the last step. `applyEdit` parses the source, applies the
 * edit to the parsed value, splices the text, parses the text back and requires
 * the two to be equal. A splice that lands anywhere unexpected — because the
 * file uses a spelling this does not understand, or because a hand-edited
 * sub-table overlaps a block being removed — comes back as a
 * `CONFIG_WRITE_FAILED` before anything reaches the disk, and the person is
 * told to edit the file themselves. So the failure mode of a gap in here is a
 * refusal rather than a damaged file.
 *
 * Pure: a string goes in and a string comes out. `write.ts` owns the
 * filesystem, and it is the one that knows which file to name in an error.
 */
import { ConfigError } from "./errors.js";
import { HOST_FIELDS, type Host } from "./hosts.js";
import type { ConfigKey, ConfigValue } from "./schema.js";

export interface ConfigEdit {
  /** Scalar settings to set in the preamble. `null` removes the line. */
  readonly set?: Readonly<Partial<Record<ConfigKey, ConfigValue | null>>>;
  /** Host blocks to write whole. `null` removes the block. */
  readonly hosts?: Readonly<Record<string, Host | null>>;
}

/**
 * The source with the edit applied, or a `ConfigError` and no change at all.
 *
 * `CONFIG_UNREADABLE` means the source is not TOML, which is a file to fix
 * rather than a write to retry. `CONFIG_WRITE_FAILED` means the splice would
 * not have said what the edit asked for; see the module note above.
 */
export function applyEdit(source: string, edit: ConfigEdit): string {
  const parsed = parse(
    source,
    (message) => new ConfigError("CONFIG_UNREADABLE", message),
  );
  const intended = structuredClone(parsed);
  const settings = Object.entries(edit.set ?? {}) as [
    ConfigKey,
    ConfigValue | null,
  ][];
  const hosts = Object.entries(edit.hosts ?? {});
  for (const [key, value] of settings) {
    if (value === null) delete intended[key];
    else intended[key] = value;
  }
  if (hosts.length > 0) {
    const table = { ...((intended.hosts ?? {}) as Record<string, unknown>) };
    for (const [name, host] of hosts) {
      if (host === null) delete table[name];
      else table[name] = { ...host };
    }
    intended.hosts = table;
  }

  const ending = majorityEnding(source);
  let lines = splitKeepingEndings(source);
  // One edit at a time, rescanning between them. Every line index a scan
  // produces is invalidated by the splice before it, and a file werk writes is
  // a few dozen lines, so rescanning costs nothing and removes the whole class
  // of bug where two edits disagree about where they are.
  for (const [name, host] of hosts)
    lines = spliceHost(lines, ending, name, host);
  for (const [key, value] of settings)
    lines = spliceSetting(lines, ending, key, value);
  const written = lines.join("");
  const result =
    written === "" || written.endsWith("\n") ? written : written + ending;

  const round = parse(result, refuse);
  // A file whose last host block was removed parses with no `hosts` key at all,
  // while the intended value still carries the empty table the deletion left
  // behind. Nothing downstream can tell those apart: `parseHosts` reads an
  // absent table and an empty one as the same no hosts. Everything else is
  // compared exactly.
  if (isEmptyTable(intended.hosts) && round.hosts === undefined)
    delete intended.hosts;
  if (!Bun.deepEquals(round, intended)) throw refuse(mismatch(round, intended));
  return result;
}

const refuse = (detail: string) =>
  new ConfigError(
    "CONFIG_WRITE_FAILED",
    `werk could not make this change without disturbing the rest of the ` +
      `file, so nothing was written and it wants editing by hand (${detail})`,
  );

/** What differs, named, so the sentence says which part of the file to look at. */
function mismatch(
  round: Record<string, unknown>,
  intended: Record<string, unknown>,
): string {
  const keys = [
    ...new Set([...Object.keys(round), ...Object.keys(intended)]),
  ].sort();
  const wrong = keys.filter(
    (key) => !Bun.deepEquals(round[key], intended[key]),
  );
  return wrong.length === 0
    ? "the result does not say what was asked for"
    : `${wrong.join(", ")} did not come out as asked`;
}

function parse(
  source: string,
  wrap: (message: string) => ConfigError,
): Record<string, unknown> {
  try {
    const value = Bun.TOML.parse(source);
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new Error("the file is not a table of keys");
    return value as Record<string, unknown>;
  } catch (error) {
    throw wrap(error instanceof Error ? error.message : String(error));
  }
}

const isEmptyTable = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.keys(value).length === 0;

/* ------------------------------------------------------------------ lines */

/**
 * Lines with their own terminators still attached, so joining them is plain
 * concatenation and a file with mixed endings keeps every one of them. Only a
 * line this module writes gets the majority ending.
 */
function splitKeepingEndings(source: string): string[] {
  return source === "" ? [] : source.split(/(?<=\n)/);
}
const contentOf = (line: string): string => line.replace(/\r?\n$/, "");

function majorityEnding(source: string): string {
  const crlf = source.split("\r\n").length - 1;
  const lf = source.split("\n").length - 1 - crlf;
  return crlf > lf ? "\r\n" : "\n";
}

const isBlankOrComment = (text: string): boolean => /^\s*(#.*)?$/.test(text);

/* ----------------------------------------------------------------- scanning */

interface TableHeader {
  /** The line the header is on. */
  readonly index: number;
  /** The dotted path, or null for a header this module has no reading of. */
  readonly path: readonly string[] | null;
}
interface Scan {
  readonly headers: readonly TableHeader[];
  /** Whether each line starts a fresh logical line rather than continuing one. */
  readonly starts: readonly boolean[];
}

/**
 * Where every table starts, tracking enough state that a header-shaped line
 * inside a value is not mistaken for one.
 *
 * Three things defeat a line-by-line regex, and all three turn up in real
 * files: a multi-line basic string (`"""`) or literal string (`'''`) can
 * contain any text at all, and an array can span lines, so a `[` opening a line
 * inside one is an element and not a header. A header is a line whose first
 * non-whitespace character is `[` while no string is open and no bracket is.
 */
function scan(lines: readonly string[]): Scan {
  const headers: TableHeader[] = [];
  const starts: boolean[] = [];
  let state: WalkState = { basic: false, literal: false, depth: 0 };
  for (const [index, line] of lines.entries()) {
    const text = contentOf(line);
    const fresh = !state.basic && !state.literal && state.depth === 0;
    starts.push(fresh);
    if (fresh && /^\s*\[/.test(text)) {
      headers.push({ index, path: headerPath(text) });
      // A header holds no value, so nothing on it can leave a string open.
      continue;
    }
    state = walk(text, state);
  }
  return { headers, starts };
}

interface WalkState {
  basic: boolean;
  literal: boolean;
  depth: number;
}

/** The state a line leaves behind: strings still open, brackets still open. */
function walk(text: string, state: WalkState): WalkState {
  let { basic, literal, depth } = state;
  let i = 0;
  while (i < text.length) {
    if (basic || literal) {
      const close = basic ? '"""' : "'''";
      const end = text.indexOf(close, i);
      if (end === -1) return { basic, literal, depth };
      basic = false;
      literal = false;
      i = end + 3;
      continue;
    }
    const char = text[i]!;
    if (char === "#") break;
    if (char === '"' || char === "'") {
      const triple = char.repeat(3);
      if (text.startsWith(triple, i)) {
        const end = text.indexOf(triple, i + 3);
        if (end === -1)
          return { basic: char === '"', literal: char === "'", depth };
        i = end + 3;
        continue;
      }
      i = char === '"' ? endOfBasic(text, i) : endOfLiteral(text, i);
      continue;
    }
    if (char === "[") depth += 1;
    else if (char === "]") depth = Math.max(0, depth - 1);
    i += 1;
  }
  return { basic, literal, depth };
}

/** One past the closing quote, honouring `\"`; the line's end if unterminated. */
function endOfBasic(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i += 1) {
    if (text[i] === "\\") {
      i += 1;
      continue;
    }
    if (text[i] === '"') return i + 1;
  }
  return text.length;
}
/** A literal string has no escapes at all, so the next quote closes it. */
function endOfLiteral(text: string, start: number): number {
  const end = text.indexOf("'", start + 1);
  return end === -1 ? text.length : end + 1;
}

const BARE_PATH = /^[A-Za-z0-9_-]+(?:\s*\.\s*[A-Za-z0-9_-]+)*$/;
/**
 * The dotted path of a table header, or null when it is one this module has no
 * reading of: an array of tables, or a path with a quoted segment in it. Null
 * still marks a boundary, which is all a span needs.
 */
function headerPath(text: string): readonly string[] | null {
  const match = /^\s*\[([^[\]]*)\]\s*(?:#.*)?$/.exec(text);
  if (match === null) return null;
  const inner = match[1]!.trim();
  return BARE_PATH.test(inner) ? inner.split(".").map((p) => p.trim()) : null;
}

/**
 * A table runs from its header to the line before the next one, less any run of
 * blank and comment lines immediately before that next header.
 *
 * Those lines belong to whatever comes after them. A comment somebody wrote
 * above `[hosts.other]` explains `hosts.other`, and leaving it inside the span
 * would carry it into the block being replaced and then delete it. The same
 * trimming happens at the end of the file, so a note left at the bottom
 * survives a rewrite of the last block.
 */
function spanOf(
  scanned: Scan,
  lines: readonly string[],
  at: number,
): { start: number; end: number } {
  const start = scanned.headers[at]!.index;
  let end = scanned.headers[at + 1]?.index ?? lines.length;
  while (end - 1 > start && isBlankOrComment(contentOf(lines[end - 1]!)))
    end -= 1;
  return { start, end };
}

/* ---------------------------------------------------------------- splicing */

function spliceHost(
  lines: readonly string[],
  ending: string,
  name: string,
  host: Host | null,
): string[] {
  const scanned = scan(lines);
  const at = scanned.headers.findIndex(
    (header) =>
      header.path?.length === 2 &&
      header.path[0] === "hosts" &&
      header.path[1] === name,
  );
  if (host === null) {
    if (at === -1) return [...lines];
    const { start, end } = spanOf(scanned, lines, at);
    // The blank line that separated this block from whatever follows goes with
    // it. Without that, removing the first block leaves the file starting with
    // a blank line, and removing the last leaves two at the bottom. The comment
    // run beyond it still belongs to the next header and is left where it is.
    let after = end;
    while (after < lines.length && contentOf(lines[after]!).trim() === "")
      after += 1;
    return [...lines.slice(0, start), ...lines.slice(after)];
  }
  const block = hostBlock(name, host).map((text) => text + ending);
  if (at !== -1) {
    const { start, end } = spanOf(scanned, lines, at);
    return [...lines.slice(0, start), ...block, ...lines.slice(end)];
  }
  const body = terminated([...lines], ending);
  // One blank line between whatever was there and the new block, unless the
  // file already ends with one.
  if (body.length > 0 && contentOf(body[body.length - 1]!).trim() !== "")
    body.push(ending);
  return [...body, ...block];
}

function spliceSetting(
  lines: readonly string[],
  ending: string,
  key: ConfigKey,
  value: ConfigValue | null,
): string[] {
  const scanned = scan(lines);
  // A scalar setting lives above the first table header. A key below one would
  // belong to that table and mean something else entirely.
  const preamble = scanned.headers[0]?.index ?? lines.length;
  let at = -1;
  for (let i = 0; i < preamble; i += 1) {
    if (!scanned.starts[i]) continue;
    if (keyOn(contentOf(lines[i]!)) === key) {
      at = i;
      break;
    }
  }
  if (at !== -1) {
    // The value may run past its own line: an array is written over several
    // often enough to be worth handling.
    let end = at + 1;
    while (end < preamble && !scanned.starts[end]) end += 1;
    const replacement =
      value === null ? [] : [`${key} = ${literal(value)}` + ending];
    return [...lines.slice(0, at), ...replacement, ...lines.slice(end)];
  }
  if (value === null) return [...lines];
  // Absent: it goes at the end of the preamble, above any comment block that
  // was written to introduce the first table.
  let insert = preamble;
  while (insert > 0 && isBlankOrComment(contentOf(lines[insert - 1]!)))
    insert -= 1;
  const body =
    insert === lines.length ? terminated([...lines], ending) : [...lines];
  const following = body[insert];
  const separator =
    following !== undefined && contentOf(following).trim() !== ""
      ? [ending]
      : [];
  body.splice(insert, 0, `${key} = ${literal(value)}` + ending, ...separator);
  return body;
}

/** A file with no trailing newline gets one before anything is added after it. */
function terminated(lines: string[], ending: string): string[] {
  const last = lines[lines.length - 1];
  if (last !== undefined && !last.endsWith("\n"))
    lines[lines.length - 1] = last + ending;
  return lines;
}

const keyOn = (text: string): string | null =>
  /^\s*([A-Za-z0-9_-]+)\s*=/.exec(text)?.[1] ?? null;

/**
 * A whole host block, in the order `HOST_FIELDS` declares, `kind` first because
 * it is the key that decides what the rest of them mean.
 */
function hostBlock(name: string, host: Host): string[] {
  const fields: Readonly<Record<string, unknown>> = HOST_FIELDS[host.kind];
  const values = host as unknown as Record<string, unknown>;
  const lines = [`[hosts.${name}]`, `kind = ${literal(host.kind)}`];
  for (const key of Object.keys(fields)) {
    const value = values[key];
    if (value === undefined) continue;
    lines.push(`${key} = ${literal(value)}`);
  }
  return lines;
}

/**
 * The four kinds of value werk writes, and nothing else. A key is never quoted:
 * `CONFIG_KEYS` are camelCase and a host name has already been through
 * `isHostName`, so both are bare keys by construction.
 */
function literal(value: unknown): string {
  if (typeof value === "string") return quote(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isInteger(value))
    return String(value);
  if (Array.isArray(value) && value.every((one) => typeof one === "string"))
    return `[${value.map((one) => quote(one as string)).join(", ")}]`;
  throw refuse(`werk has no spelling for ${JSON.stringify(value) ?? "that"}`);
}

const ESCAPES: Record<string, string> = {
  '"': '\\"',
  "\\": "\\\\",
  "\b": "\\b",
  "\t": "\\t",
  "\n": "\\n",
  "\f": "\\f",
  "\r": "\\r",
};
function quote(text: string): string {
  let out = '"';
  for (const char of text) {
    const escape = ESCAPES[char];
    if (escape !== undefined) out += escape;
    else if (char < " " || char === "\u007f")
      out += `\\u${char.codePointAt(0)!.toString(16).padStart(4, "0")}`;
    else out += char;
  }
  return out + '"';
}
