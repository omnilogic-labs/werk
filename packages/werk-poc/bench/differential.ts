// The differential corpus runner (`wp bench diff`): the same bytes into
// `ghostty-wasm`, `ghostty-ffi` and `xterm-oracle`, then plainText,
// styledCells and the effects compared pairwise. Disagreements are printed
// with a small diff for a human and never scored; a wasm-versus-ffi
// difference points at one of the two loaders (or at the four months
// between their pinned Ghostty commits), a difference with the oracle is a
// finding to attribute by reading the spec.
//
// Reattach cases run each restore strategy per engine and compare the
// copy against a terminal that was never detached, after the resize the
// case ends with. Fuzz generates random bytes and random valid sequences
// from a seeded PRNG and compares plainText only, reporting how often the
// cells agreed too.

import path from "node:path";
import { engineIds, getEngine } from "../src/engine/all.ts";
import type {
  Cell,
  Effect,
  VtEngine,
  VtTerminal,
} from "../src/engine/types.ts";
import { isUnsupported } from "../src/engine/types.ts";
import { readCast, type Cast, type CastEvent } from "./cast.ts";
import { CORPUS, type CorpusCase } from "./corpus/index.ts";

const CORPUS_DIR = path.join(import.meta.dir, "corpus");
const enc = new TextEncoder();
const dec = new TextDecoder();

export interface DiffOptions {
  /** Substrings; a case runs when its name contains any of them. Empty runs everything. */
  cases?: string[];
  fuzz?: number;
  seed?: number;
  /** Print every difference in full rather than the first few. */
  verbose?: boolean;
  out?: (line: string) => void;
}

export interface Comparison {
  text: boolean;
  cells: boolean;
  effects: boolean;
  /** Human-readable detail for what differed. */
  detail: string[];
}

export interface CaseResult {
  name: string;
  pairs: Record<string, Comparison>;
  reattach?: Record<string, Record<string, ReattachResult>>;
  error?: string;
}

export interface ReattachResult {
  /** `padding`: the copy reads the same and differs only in never-written cells the re-emission wrote as spaces. */
  status: "exact" | "padding" | "differs" | "unsupported";
  detail: string[];
}

export interface FuzzResult {
  mode: "bytes" | "sequences";
  iterations: number;
  textAgree: Record<string, number>;
  cellsAgree: Record<string, number>;
  /** Per engine: iterations where the input fed in random pieces read the same as fed whole. */
  splitInvariant: Record<string, number>;
  examples: string[];
}

export interface Report {
  engines: string[];
  loadErrors: Record<string, string>;
  cases: CaseResult[];
  fuzz: FuzzResult[];
  /** The summary tables, as printed. */
  tables: string;
}

// ---------------------------------------------------------------- replay

interface Live {
  engine: VtEngine;
  term: VtTerminal;
  effects: Effect[];
}

async function settle(t: VtTerminal): Promise<void> {
  const flush = (t as { flush?: () => Promise<void> }).flush;
  if (typeof flush === "function") await flush.call(t);
}

function create(engine: VtEngine, cols: number, rows: number): Live {
  const term = engine.create({ cols, rows, scrollback: 500 });
  const effects: Effect[] = [];
  const sub = term.onEffect((e) => effects.push(e));
  if (isUnsupported(sub)) effects.push({ kind: "other", name: "no-effects" });
  return { engine, term, effects };
}

async function apply(live: Live, events: CastEvent[]): Promise<void> {
  for (const e of events) {
    if (e.kind === "output") live.term.write(e.bytes);
    else live.term.resize(e.cols, e.rows);
  }
  await settle(live.term);
}

async function replay(
  engine: VtEngine,
  cast: Cast,
  events = cast.events,
): Promise<Live> {
  const live = create(engine, cast.header.width, cast.header.height);
  await apply(live, events);
  return live;
}

// --------------------------------------------------------------- compare

function cellKey(c: Cell): string {
  const col = (k: Cell["fg"]) =>
    k.kind === "default"
      ? "-"
      : k.kind === "palette"
        ? `p${k.index}`
        : `#${k.r},${k.g},${k.b}`;
  const attrs =
    (c.bold ? "B" : "") +
    (c.italic ? "I" : "") +
    (c.underline ? "U" : "") +
    (c.inverse ? "V" : "") +
    (c.strikethrough ? "S" : "");
  return `${JSON.stringify(c.text)} w${c.width} fg${col(c.fg)} bg${col(c.bg)} ${attrs || "."}`;
}

function effectKey(e: Effect): string {
  if (e.kind === "write-pty")
    return `write-pty ${JSON.stringify(dec.decode(e.bytes))}`;
  return JSON.stringify(e);
}

/** A reply that names the emulator: DA1, DA2, XTVERSION. Two emulators answer these differently by design. */
function isIdentityReply(e: Effect): boolean {
  if (e.kind !== "write-pty") return false;
  const s = dec.decode(e.bytes);
  return /^\x1b\[[?>]\d+(;\d+)*c$/.test(s) || /^\x1bP>\|.*\x1b\\$/.test(s);
}

/**
 * Effects the seam names, so the oracle's `other` marks and the wasm's
 * silence on them do not count, and without identity replies, which are
 * listed separately.
 */
function comparableEffects(effects: Effect[]): string[] {
  return effects
    .filter((e) => e.kind !== "other" && !isIdentityReply(e))
    .map(effectKey);
}

function identityReplies(effects: Effect[]): string[] {
  return effects.filter(isIdentityReply).map(effectKey);
}

function diffText(a: string, b: string, limit: number): string[] {
  const la = a.split("\n");
  const lb = b.split("\n");
  const out: string[] = [];
  const n = Math.max(la.length, lb.length);
  let shown = 0;
  for (let y = 0; y < n; y++) {
    if (la[y] === lb[y]) continue;
    if (shown++ >= limit) {
      out.push(`  … ${n - y} more rows`);
      break;
    }
    out.push(`  row ${y}: ${JSON.stringify(la[y] ?? "<none>")}`);
    out.push(
      `  ${" ".repeat(String(y).length + 4)}  ${JSON.stringify(lb[y] ?? "<none>")}`,
    );
  }
  return out;
}

/** A cell never written and a written plain space: the same thing to a viewer, different to the buffer. */
function blankPair(a: Cell | undefined, b: Cell | undefined): boolean {
  if (!a || !b) return false;
  const blank = (c: Cell) => (c.text === "" || c.text === " ") && c.width === 1;
  if (!blank(a) || !blank(b)) return false;
  return cellKey({ ...a, text: "" }) === cellKey({ ...b, text: "" });
}

function diffCells(
  a: Cell[][],
  b: Cell[][],
  limit: number,
): { lines: string[]; count: number; padding: number } {
  const out: string[] = [];
  let count = 0;
  let padding = 0;
  const rows = Math.max(a.length, b.length);
  for (let y = 0; y < rows; y++) {
    const ra = a[y] ?? [];
    const rb = b[y] ?? [];
    const cols = Math.max(ra.length, rb.length);
    for (let x = 0; x < cols; x++) {
      const ka = ra[x] ? cellKey(ra[x]!) : "<none>";
      const kb = rb[x] ? cellKey(rb[x]!) : "<none>";
      if (ka === kb) continue;
      if (blankPair(ra[x], rb[x])) {
        padding++;
        continue;
      }
      if (count++ < limit) out.push(`  cell ${x},${y}: ${ka}  |  ${kb}`);
    }
  }
  if (count > limit) out.push(`  … ${count} cells differ in all`);
  if (padding > 0)
    out.push(`  (${padding} cells differ only as "" versus " ")`);
  return { lines: out, count, padding };
}

function compare(a: Live, b: Live, limit: number): Comparison {
  const ta = a.term.plainText();
  const tb = b.term.plainText();
  const ca = a.term.styledCells();
  const cb = b.term.styledCells();
  const ea = comparableEffects(a.effects);
  const eb = comparableEffects(b.effects);
  const detail: string[] = [];
  const text = ta === tb;
  if (!text) detail.push("plainText:", ...diffText(ta, tb, limit));
  const cellDiff = diffCells(ca, cb, limit);
  const cells = cellDiff.count === 0;
  if (cellDiff.lines.length > 0) detail.push("styledCells:", ...cellDiff.lines);
  const ia = identityReplies(a.effects);
  const ib = identityReplies(b.effects);
  if (ia.join() !== ib.join())
    detail.push(
      `identity replies (not counted): ${ia.join(", ") || "none"}  |  ${ib.join(", ") || "none"}`,
    );
  const effects = ea.join("\n") === eb.join("\n");
  if (!effects) {
    detail.push("effects:");
    const n = Math.max(ea.length, eb.length);
    let shown = 0;
    for (let i = 0; i < n; i++) {
      if (ea[i] === eb[i]) continue;
      if (shown++ >= limit) {
        detail.push(`  … ${n - i} more`);
        break;
      }
      detail.push(`  #${i}: ${ea[i] ?? "<none>"}  |  ${eb[i] ?? "<none>"}`);
    }
  }
  return { text, cells, effects, detail };
}

// -------------------------------------------------------------- reattach

async function reattach(
  engine: VtEngine,
  cast: Cast,
  limit: number,
): Promise<Record<string, ReattachResult>> {
  const last = cast.events[cast.events.length - 1];
  if (!last || last.kind !== "resize")
    throw new Error("a reattach case ends with a resize event");
  const pre = cast.events.slice(0, -1);
  const { cols, rows } = last;
  const results: Record<string, ReattachResult> = {};

  const judge = async (copy: Live, src: Live): Promise<ReattachResult> => {
    await settle(copy.term);
    await settle(src.term);
    // Effects are not compared: the copy never saw the queries the source answered.
    const c = compare(copy, src, limit);
    const detail = c.detail.filter(
      (d) => !d.startsWith("effects") && !d.startsWith("  #"),
    );
    const padding = detail.some((d) => d.includes("differ only as"));
    const cc = (
      copy.term as { cursor?: () => { x: number; y: number } }
    ).cursor?.call(copy.term);
    const sc = (
      src.term as { cursor?: () => { x: number; y: number } }
    ).cursor?.call(src.term);
    let cursorOk = true;
    if (cc && sc && (cc.x !== sc.x || cc.y !== sc.y)) {
      cursorOk = false;
      detail.push(`cursor: copy ${cc.x},${cc.y}  |  source ${sc.x},${sc.y}`);
    }
    const screenOf = (l: Live) =>
      (l.term as { activeScreen?: () => string }).activeScreen?.call(l.term);
    if (screenOf(copy) && screenOf(src) && screenOf(copy) !== screenOf(src))
      detail.push(`screen: copy ${screenOf(copy)}  |  source ${screenOf(src)}`);
    const same = c.text && c.cells && cursorOk;
    return {
      status: same ? (padding ? "padding" : "exact") : "differs",
      detail,
    };
  };

  // Re-emission, then both resize.
  {
    const src = await replay(engine, cast, pre);
    const vt = src.term.emitVt({ cursor: true, style: true });
    if (isUnsupported(vt))
      results["reemit"] = { status: "unsupported", detail: [vt.reason] };
    else {
      const copy = create(engine, cast.header.width, cast.header.height);
      copy.term.write(vt);
      await settle(copy.term);
      copy.term.resize(cols, rows);
      src.term.resize(cols, rows);
      results["reemit"] = await judge(copy, src);
      copy.term.dispose();
    }
    src.term.dispose();
  }
  // Resize the source first, re-emit at the new size (the CLI's proposed strategy).
  {
    const src = await replay(engine, cast, pre);
    src.term.resize(cols, rows);
    await settle(src.term);
    const vt = src.term.emitVt({ cursor: true, style: true });
    if (isUnsupported(vt))
      results["resize-then-reemit"] = {
        status: "unsupported",
        detail: [vt.reason],
      };
    else {
      const copy = create(engine, cols, rows);
      copy.term.write(vt);
      results["resize-then-reemit"] = await judge(copy, src);
      copy.term.dispose();
    }
    src.term.dispose();
  }
  // State transfer, then both resize.
  {
    const src = await replay(engine, cast, pre);
    const bytes = src.term.encodeState();
    if (isUnsupported(bytes))
      results["state"] = { status: "unsupported", detail: [bytes.reason] };
    else {
      const d = engine.decodeState(bytes);
      if (isUnsupported(d))
        results["state"] = { status: "unsupported", detail: [d.reason] };
      else {
        const term = d.ready();
        while (d.next() !== null) {
          // drain history
        }
        const copy: Live = { engine, term, effects: [] };
        copy.term.resize(cols, rows);
        src.term.resize(cols, rows);
        results["state"] = await judge(copy, src);
        copy.term.dispose();
      }
    }
    src.term.dispose();
  }
  return results;
}

// ------------------------------------------------------------------ fuzz

/** mulberry32: small, seedable, good enough for a corpus. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomBytes(rnd: () => number, n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.floor(rnd() * 256);
  return out;
}

const WORDS = [
  "lorem",
  "ipsum",
  "日本",
  "über",
  "naïve",
  "🙂",
  "x",
  "tab\t",
  "→",
  "ऩ",
];
const CSI_FINALS = [
  "A",
  "B",
  "C",
  "D",
  "E",
  "F",
  "G",
  "H",
  "J",
  "K",
  "L",
  "M",
  "P",
  "S",
  "T",
  "X",
  "@",
  "d",
  "r",
  "s",
  "u",
];

export function randomSequences(rnd: () => number, steps: number): string {
  const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]!;
  const int = (n: number) => Math.floor(rnd() * n);
  let s = "";
  for (let i = 0; i < steps; i++) {
    const r = rnd();
    if (r < 0.4) s += pick(WORDS) + (rnd() < 0.5 ? " " : "");
    else if (r < 0.55) s += pick(["\r\n", "\n", "\r", "\b", "\t"]);
    else if (r < 0.75) {
      // SGR
      const params: string[] = [];
      const k = 1 + int(3);
      for (let j = 0; j < k; j++) {
        const q = rnd();
        if (q < 0.3)
          params.push(String(pick([0, 1, 3, 4, 7, 9, 22, 23, 24, 27, 29])));
        else if (q < 0.55) params.push(String(30 + int(8)));
        else if (q < 0.7) params.push(String(40 + int(8)));
        else if (q < 0.85) params.push(`${pick([38, 48])};5;${int(256)}`);
        else
          params.push(
            `${pick([38, 48])};2;${int(256)};${int(256)};${int(256)}`,
          );
      }
      s += `\x1b[${params.join(";")}m`;
    } else if (r < 0.9) {
      const f = pick(CSI_FINALS);
      const n = int(4);
      const params =
        f === "H"
          ? `${1 + int(12)};${1 + int(40)}`
          : n === 0
            ? ""
            : String(1 + int(10));
      s += `\x1b[${params}${f}`;
    } else {
      // OSC 133 is left out: libghostty moves to a fresh line on 133;A mid-line
      // (kitty's semantics) and xterm ignores it, which the osc133-prompt case records.
      const kind = pick([0, 2, 7, 8, 9]);
      const payload =
        kind === 8
          ? `;${rnd() < 0.5 ? "https://e.com/" + int(100) : ""}`
          : kind === 9
            ? rnd() < 0.5
              ? `4;${int(5)};${int(101)}`
              : "note " + int(10)
            : kind === 133
              ? pick(["A", "B", "C", "D;0"])
              : kind === 7
                ? "file://localhost/tmp/" + int(10)
                : "title " + int(10);
      s += `\x1b]${kind};${payload}${rnd() < 0.5 ? "\x07" : "\x1b\\"}`;
    }
  }
  return s;
}

async function fuzz(
  engines: VtEngine[],
  mode: "bytes" | "sequences",
  iterations: number,
  seed: number,
  limit: number,
): Promise<FuzzResult> {
  const rnd = prng(seed + (mode === "bytes" ? 0 : 1000));
  const pairs = pairNames(engines);
  const textAgree: Record<string, number> = Object.fromEntries(
    pairs.map((p) => [p, 0]),
  );
  const cellsAgree: Record<string, number> = Object.fromEntries(
    pairs.map((p) => [p, 0]),
  );
  const splitInvariant: Record<string, number> = Object.fromEntries(
    engines.map((e) => [e.id, 0]),
  );
  const examples: string[] = [];
  for (let i = 0; i < iterations; i++) {
    const input =
      mode === "bytes"
        ? randomBytes(rnd, 200 + Math.floor(rnd() * 1800))
        : enc.encode(randomSequences(rnd, 20 + Math.floor(rnd() * 60)));
    // Cut into a few writes at random points.
    const cuts = [0];
    for (let k = 0; k < 3; k++) cuts.push(Math.floor(rnd() * input.length));
    cuts.push(input.length);
    cuts.sort((a, b) => a - b);
    const lives = engines.map((e) => create(e, 40, 10));
    for (const l of lives) {
      for (let k = 0; k + 1 < cuts.length; k++)
        l.term.write(input.subarray(cuts[k]!, cuts[k + 1]!));
      await settle(l.term);
    }
    // Split invariance: the same bytes fed whole must read the same as fed in pieces.
    for (const l of lives) {
      const whole = create(l.engine, 40, 10);
      whole.term.write(input);
      await settle(whole.term);
      const c = compare(l, whole, 3);
      if (c.text && c.cells) splitInvariant[l.engine.id]!++;
      else if (examples.length < limit)
        examples.push(
          `${mode} #${i} (seed ${seed}) ${l.engine.id} is not split-invariant at cuts ${cuts.join(",")}:\n` +
            c.detail
              .filter((d) => !d.startsWith("effects") && !d.startsWith("  #"))
              .join("\n") +
            `\n  input: ${JSON.stringify(mode === "bytes" ? Buffer.from(input).toString("base64") : dec.decode(input))}`,
        );
      whole.term.dispose();
    }
    for (let a = 0; a < lives.length; a++)
      for (let b = a + 1; b < lives.length; b++) {
        const p = `${engines[a]!.id} ↔ ${engines[b]!.id}`;
        const c = compare(lives[a]!, lives[b]!, 3);
        if (c.text) textAgree[p]!++;
        else if (examples.length < limit)
          examples.push(
            `${mode} #${i} (seed ${seed}) ${p} at cuts ${cuts.join(",")}:\n` +
              c.detail
                .filter(
                  (d) =>
                    !d.startsWith("styledCells") && !d.startsWith("  cell"),
                )
                .join("\n") +
              `\n  input: ${JSON.stringify(mode === "bytes" ? Buffer.from(input).toString("base64").slice(0, 80) + "…" : dec.decode(input))}`,
          );
        if (c.cells) cellsAgree[p]!++;
      }
    for (const l of lives) l.term.dispose();
  }
  return { mode, iterations, textAgree, cellsAgree, splitInvariant, examples };
}

function pairNames(engines: VtEngine[]): string[] {
  const out: string[] = [];
  for (let a = 0; a < engines.length; a++)
    for (let b = a + 1; b < engines.length; b++)
      out.push(`${engines[a]!.id} ↔ ${engines[b]!.id}`);
  return out;
}

// ------------------------------------------------------------------- run

function table(head: string[], rows: string[][]): string {
  const widths = head.map((_, i) =>
    Math.max(...[head, ...rows].map((r) => r[i]!.length)),
  );
  const line = (r: string[]) =>
    `| ${r.map((c, i) => c.padEnd(widths[i]!)).join(" | ")} |`;
  return [
    line(head),
    `| ${widths.map((w) => "-".repeat(w)).join(" | ")} |`,
    ...rows.map(line),
  ].join("\n");
}

function verdict(c: Comparison): string {
  if (c.text && c.cells && c.effects) return "agree";
  const bad = [
    !c.text && "text",
    !c.cells && "cells",
    !c.effects && "effects",
  ].filter(Boolean);
  return `differ: ${bad.join(", ")}`;
}

export async function runDifferential(opts: DiffOptions = {}): Promise<Report> {
  const out = opts.out ?? ((l: string) => console.log(l));
  const limit = opts.verbose ? 1000 : 4;
  const engines: VtEngine[] = [];
  const loadErrors: Record<string, string> = {};
  for (const id of engineIds()) {
    try {
      engines.push(await getEngine(id));
    } catch (e) {
      loadErrors[id] = (e as Error).message;
      out(`engine ${id} did not load: ${loadErrors[id]}`);
    }
  }
  const pairs = pairNames(engines);
  const selected = CORPUS.filter(
    (c) =>
      !opts.cases ||
      opts.cases.length === 0 ||
      opts.cases.some((s) => c.name.includes(s)),
  );

  const results: CaseResult[] = [];
  for (const c of selected) {
    const file = path.join(CORPUS_DIR, c.file);
    let cast: Cast;
    try {
      cast = readCast(file);
    } catch (e) {
      results.push({
        name: c.name,
        pairs: {},
        error: `not recorded: ${(e as Error).message}`,
      });
      out(`\n== ${c.name}: ${c.file} missing (${(e as Error).message})`);
      continue;
    }
    out(`\n== ${c.name} (${c.source}): ${c.notes}`);
    const res: CaseResult = { name: c.name, pairs: {} };
    const lives: Live[] = [];
    for (const e of engines) lives.push(await replay(e, cast));
    for (let a = 0; a < lives.length; a++)
      for (let b = a + 1; b < lives.length; b++) {
        const p = `${engines[a]!.id} ↔ ${engines[b]!.id}`;
        const cmp = compare(lives[a]!, lives[b]!, limit);
        res.pairs[p] = cmp;
        out(`  ${p}: ${verdict(cmp)}`);
        for (const d of cmp.detail) out(`    ${d}`);
      }
    for (const l of lives) l.term.dispose();
    if (c.kind === "reattach") {
      res.reattach = {};
      for (const e of engines) {
        try {
          res.reattach[e.id] = await reattach(e, cast, limit);
        } catch (err) {
          res.reattach[e.id] = {
            error: { status: "differs", detail: [String(err)] },
          };
        }
        for (const [strategy, r] of Object.entries(res.reattach[e.id]!)) {
          out(`  reattach ${e.id} ${strategy}: ${r.status}`);
          for (const d of r.detail) out(`    ${d}`);
        }
      }
    }
    results.push(res);
  }

  const fuzzResults: FuzzResult[] = [];
  const n = opts.fuzz ?? 0;
  if (n > 0) {
    for (const mode of ["bytes", "sequences"] as const) {
      const r = await fuzz(engines, mode, n, opts.seed ?? 1, limit);
      fuzzResults.push(r);
      out(`\n== fuzz ${mode}: ${n} iterations, seed ${opts.seed ?? 1}`);
      for (const p of pairs)
        out(
          `  ${p}: text ${r.textAgree[p]}/${n}, cells ${r.cellsAgree[p]}/${n}`,
        );
      for (const e of engines)
        out(`  ${e.id}: split-invariant ${r.splitInvariant[e.id]}/${n}`);
      for (const ex of r.examples) out(`  ${ex.replace(/\n/g, "\n  ")}`);
    }
  }

  // Summary tables.
  const caseRows = results.map((r) => [
    r.name,
    ...pairs.map((p) =>
      r.error ? "—" : r.pairs[p] ? verdict(r.pairs[p]!) : "—",
    ),
  ]);
  let tables = table(["case", ...pairs], caseRows);
  const reattachRows: string[][] = [];
  for (const r of results)
    if (r.reattach)
      for (const [engine, strategies] of Object.entries(r.reattach))
        reattachRows.push([
          r.name,
          engine,
          ...["reemit", "resize-then-reemit", "state"].map(
            (s) => strategies[s]?.status ?? "—",
          ),
        ]);
  if (reattachRows.length > 0)
    tables +=
      "\n\n" +
      table(
        [
          "case",
          "engine",
          "re-emit, resize",
          "resize, re-emit",
          "state, resize",
        ],
        reattachRows,
      );
  if (fuzzResults.length > 0) {
    const rows = fuzzResults.flatMap((f) =>
      pairs.map((p) => [
        f.mode,
        p,
        `${f.textAgree[p]}/${f.iterations}`,
        `${f.cellsAgree[p]}/${f.iterations}`,
      ]),
    );
    tables +=
      "\n\n" +
      table(["fuzz", "pair", "plainText agree", "styledCells agree"], rows);
    const splitRows = fuzzResults.flatMap((f) =>
      engines.map((e) => [
        f.mode,
        e.id,
        `${f.splitInvariant[e.id]}/${f.iterations}`,
      ]),
    );
    tables += "\n\n" + table(["fuzz", "engine", "split-invariant"], splitRows);
  }
  out(`\n${tables}\n`);
  return {
    engines: engines.map((e) => e.id),
    loadErrors,
    cases: results,
    fuzz: fuzzResults,
    tables,
  };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (n: string) => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  await runDifferential({
    cases: argv.filter(
      (a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"),
    ),
    fuzz: flag("fuzz") ? Number(flag("fuzz")) : 0,
    seed: flag("seed") ? Number(flag("seed")) : 1,
    verbose: argv.includes("--verbose"),
  });
}
