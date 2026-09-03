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
// case ends with. Fuzz explores random bytes and random valid sequences
// through fast-check arbitraries and compares plainText, reporting how
// often the cells agreed too; a mulberry32 stream seeded from the harness's
// own seed decides where each input is cut into writes, so a cut always
// falls the same way for a given input regardless of how fast-check reached
// it. A disagreement is handed back to fast-check to shrink, which prints a
// minimal input plus a seed and path a person can paste into a fresh
// `fc.assert` call to land on exactly that case again.

import path from "node:path";
import * as fc from "fast-check";
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

/** Where a write of `length` bytes is cut into pieces, from a fresh mulberry32 stream. */
function cutPoints(rnd: () => number, length: number): number[] {
  const cuts = [0];
  for (let k = 0; k < 3; k++) cuts.push(Math.floor(rnd() * length));
  cuts.push(length);
  cuts.sort((a, b) => a - b);
  return cuts;
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

// fast-check arbitraries for the two fuzz modes, shaped to match what the
// harness explored before fast-check ran it: the same length ranges, the
// same alphabet of words (with the same multi-byte UTF-8), the same SGR/CSI/
// OSC fragments in the same proportions. Lengths keep the historical floor
// (200 bytes, 20 steps) rather than reaching down to nothing, so the
// population `--fuzz N` samples from is unchanged; a shrunk counterexample
// therefore bottoms out at that floor too, trading a smaller minimal repro
// for a sampling distribution nobody has to guess has moved.

const bytesArb: fc.Arbitrary<Uint8Array> = fc.uint8Array({
  minLength: 200,
  maxLength: 1999,
});

const wordArb = fc
  .tuple(fc.constantFrom(...WORDS), fc.boolean())
  .map(([w, space]) => w + (space ? " " : ""));

const controlArb = fc.constantFrom("\r\n", "\n", "\r", "\b", "\t");

const sgrParamArb = fc.oneof(
  {
    weight: 30,
    arbitrary: fc
      .constantFrom(0, 1, 3, 4, 7, 9, 22, 23, 24, 27, 29)
      .map(String),
  },
  { weight: 25, arbitrary: fc.integer({ min: 30, max: 37 }).map(String) },
  { weight: 15, arbitrary: fc.integer({ min: 40, max: 47 }).map(String) },
  {
    weight: 15,
    arbitrary: fc
      .tuple(fc.constantFrom(38, 48), fc.integer({ min: 0, max: 255 }))
      .map(([p, n]) => `${p};5;${n}`),
  },
  {
    weight: 15,
    arbitrary: fc
      .tuple(
        fc.constantFrom(38, 48),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
      )
      .map(([p, r, g, b]) => `${p};2;${r};${g};${b}`),
  },
);
const sgrArb = fc
  .array(sgrParamArb, { minLength: 1, maxLength: 3 })
  .map((params) => `\x1b[${params.join(";")}m`);

const csiArb = fc.constantFrom(...CSI_FINALS).chain((f) =>
  f === "H"
    ? fc
        .tuple(fc.integer({ min: 1, max: 12 }), fc.integer({ min: 1, max: 40 }))
        .map(([row, col]) => `\x1b[${row};${col}${f}`)
    : fc
        .oneof(
          { weight: 1, arbitrary: fc.constant("") },
          {
            weight: 3,
            arbitrary: fc.integer({ min: 1, max: 10 }).map(String),
          },
        )
        .map((params) => `\x1b[${params}${f}`),
);

// OSC 133 is left out: libghostty moves to a fresh line on 133;A mid-line
// (kitty's semantics) and xterm ignores it, which the osc133-prompt case records.
const oscArb = fc.constantFrom(0, 2, 7, 8, 9).chain((kind) => {
  const payload =
    kind === 7
      ? fc.integer({ min: 0, max: 9 }).map((n) => `file://localhost/tmp/${n}`)
      : kind === 8
        ? fc
            .oneof(
              { weight: 1, arbitrary: fc.constant("") },
              {
                weight: 1,
                arbitrary: fc
                  .integer({ min: 0, max: 99 })
                  .map((n) => `https://e.com/${n}`),
              },
            )
            .map((u) => `;${u}`)
        : kind === 9
          ? fc.oneof(
              {
                weight: 1,
                arbitrary: fc
                  .tuple(
                    fc.integer({ min: 0, max: 4 }),
                    fc.integer({ min: 0, max: 100 }),
                  )
                  .map(([a, b]) => `4;${a};${b}`),
              },
              {
                weight: 1,
                arbitrary: fc
                  .integer({ min: 0, max: 9 })
                  .map((n) => `note ${n}`),
              },
            )
          : fc.integer({ min: 0, max: 9 }).map((n) => `title ${n}`);
  return fc
    .tuple(payload, fc.boolean())
    .map(([p, bel]) => `\x1b]${kind};${p}${bel ? "\x07" : "\x1b\\"}`);
});

const stepArb = fc.oneof(
  { weight: 40, arbitrary: wordArb },
  { weight: 15, arbitrary: controlArb },
  { weight: 20, arbitrary: sgrArb },
  { weight: 15, arbitrary: csiArb },
  { weight: 10, arbitrary: oscArb },
);

const sequencesArb: fc.Arbitrary<Uint8Array> = fc
  .array(stepArb, { minLength: 20, maxLength: 79 })
  .map((steps) => enc.encode(steps.join("")));

function describeInput(
  mode: "bytes" | "sequences",
  input: Uint8Array,
  truncate: boolean,
): string {
  if (mode === "sequences") return JSON.stringify(dec.decode(input));
  const b64 = Buffer.from(input).toString("base64");
  return JSON.stringify(truncate ? b64.slice(0, 80) + "…" : b64);
}

interface FuzzOutcome {
  cuts: number[];
  splitInvariant: Record<string, boolean>;
  splitDetail: Record<string, string[]>;
  textAgree: Record<string, boolean>;
  cellsAgree: Record<string, boolean>;
  pairDetail: Record<string, string[]>;
}

/**
 * Writes `input` into a fresh terminal per engine, cut into a few pieces at
 * points a mulberry32 stream seeded from the harness's `seed` picks — so the
 * same input always cuts the same way, whether fast-check reached it by
 * plain sampling or by shrinking. Checks split invariance against one write
 * of the whole input, then compares engines pairwise. Detail lines are
 * always trimmed to 3, independent of `--verbose`: a fuzz example can fire
 * on every run, and the corpus's per-case verbosity would make it noisy.
 */
async function runOnce(
  engines: VtEngine[],
  input: Uint8Array,
  seed: number,
): Promise<FuzzOutcome> {
  const cuts = cutPoints(prng(seed), input.length);
  const lives = engines.map((e) => create(e, 40, 10));
  for (const l of lives) {
    for (let k = 0; k + 1 < cuts.length; k++)
      l.term.write(input.subarray(cuts[k]!, cuts[k + 1]!));
    await settle(l.term);
  }
  // Split invariance: the same bytes fed whole must read the same as fed in pieces.
  const splitInvariant: Record<string, boolean> = {};
  const splitDetail: Record<string, string[]> = {};
  for (const l of lives) {
    const whole = create(l.engine, 40, 10);
    whole.term.write(input);
    await settle(whole.term);
    const c = compare(l, whole, 3);
    splitInvariant[l.engine.id] = c.text && c.cells;
    if (!splitInvariant[l.engine.id])
      splitDetail[l.engine.id] = c.detail.filter(
        (d) => !d.startsWith("effects") && !d.startsWith("  #"),
      );
    whole.term.dispose();
  }
  const textAgree: Record<string, boolean> = {};
  const cellsAgree: Record<string, boolean> = {};
  const pairDetail: Record<string, string[]> = {};
  for (let a = 0; a < lives.length; a++)
    for (let b = a + 1; b < lives.length; b++) {
      const p = `${engines[a]!.id} ↔ ${engines[b]!.id}`;
      const c = compare(lives[a]!, lives[b]!, 3);
      textAgree[p] = c.text;
      cellsAgree[p] = c.cells;
      if (!c.text)
        pairDetail[p] = c.detail.filter(
          (d) => !d.startsWith("styledCells") && !d.startsWith("  cell"),
        );
    }
  for (const l of lives) l.term.dispose();
  return {
    cuts,
    splitInvariant,
    splitDetail,
    textAgree,
    cellsAgree,
    pairDetail,
  };
}

async function fuzz(
  engines: VtEngine[],
  mode: "bytes" | "sequences",
  iterations: number,
  seed: number,
  limit: number,
): Promise<FuzzResult> {
  const arb = mode === "bytes" ? bytesArb : sequencesArb;
  // fast-check's own seed for this mode, kept apart from `seed` (which
  // `runOnce` uses for cut points) so the two streams never compete for the
  // same randomness.
  const fcSeed = seed + (mode === "bytes" ? 0 : 1000);
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
  let sawFailure = false;

  // `numRuns: iterations` is the same iteration count `--fuzz N` has always
  // taken; fc.sample draws the exact `iterations` inputs fast-check's own
  // run loop would generate for `fcSeed`, so walking them by hand here reads
  // the same agreement counts a plain fc.assert run would have produced.
  const inputs = fc.sample(arb, { numRuns: iterations, seed: fcSeed });
  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i]!;
    const o = await runOnce(engines, input, seed);
    for (const e of engines) {
      if (o.splitInvariant[e.id]) splitInvariant[e.id]!++;
      else {
        sawFailure = true;
        if (examples.length < limit)
          examples.push(
            `${mode} #${i} (seed ${fcSeed}) ${e.id} is not split-invariant at cuts ${o.cuts.join(",")}:\n` +
              o.splitDetail[e.id]!.join("\n") +
              `\n  input: ${describeInput(mode, input, false)}`,
          );
      }
    }
    for (const p of pairs) {
      if (o.textAgree[p]) textAgree[p]!++;
      else {
        sawFailure = true;
        if (examples.length < limit)
          examples.push(
            `${mode} #${i} (seed ${fcSeed}) ${p} at cuts ${o.cuts.join(",")}:\n` +
              o.pairDetail[p]!.join("\n") +
              `\n  input: ${describeInput(mode, input, true)}`,
          );
      }
      if (o.cellsAgree[p]) cellsAgree[p]!++;
    }
  }

  // A disagreement above is worth a minimal repro. Re-running the same
  // arbitrary and seed through fast-check's own loop meets the same first
  // failure fc.sample did (fc.sample previews exactly what that loop
  // generates), and this time fast-check shrinks it. `endOnFailure` is left
  // at its default: unset, a run already stops generating further cases the
  // moment one fails and proceeds to shrink that one — which is what a
  // minimal repro needs; `endOnFailure: true` instead skips shrinking
  // entirely, so it is only useful for replaying an already-minimal case
  // (the pasteable snippet fast-check prints on failure sets it that way,
  // for exactly that quick replay). `includeErrorInReport` folds the
  // triggering detail into the same message rather than a separate `cause`,
  // so one block is all a person needs to paste back.
  //
  // Bytes-mode fuzz disagrees on essentially every run — the DEL-handling
  // gap findings/m6.md records — so this is not a rare-failure cost; it is
  // the steady cost of fuzzing bytes at all. `skipAllAfterTimeLimit` caps it
  // at two seconds so an input that shrinks slowly cannot make `--fuzz N`
  // scale with how large the corpus of irrelevant bytes happens to be before
  // it converges. The printed `{ seed, path, endOnFailure: true }` replays
  // this exact, possibly still-large, counterexample rather than continuing
  // to shrink it; dropping `endOnFailure` from that snippet resumes shrinking
  // from where the cap interrupted it.
  if (sawFailure) {
    try {
      await fc.assert(
        fc.asyncProperty(arb, async (input) => {
          const o = await runOnce(engines, input, seed);
          for (const e of engines)
            if (!o.splitInvariant[e.id])
              throw new Error(
                `${e.id} is not split-invariant at cuts ${o.cuts.join(",")}:\n` +
                  o.splitDetail[e.id]!.join("\n"),
              );
          for (const p of pairs)
            if (!o.textAgree[p])
              throw new Error(
                `${p} disagree at cuts ${o.cuts.join(",")}:\n` +
                  o.pairDetail[p]!.join("\n"),
              );
        }),
        {
          seed: fcSeed,
          numRuns: iterations,
          includeErrorInReport: true,
          skipAllAfterTimeLimit: 2000,
        },
      );
    } catch (err) {
      examples.push(
        `${mode} shrunk counterexample:\n${(err as Error).message}`,
      );
    }
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
