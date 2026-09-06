// One bounded run: grid equivalence (base vs prototype), post-fix timings,
// resync cost with a retained shadow, and burst coalescing. Never more than
// two live terminal instances.
import { terminalWasmBytes } from "/home/mike/Development/omnilogic-labs/werk/packages/terminal/src/bun/index.ts";
import * as base from "/home/mike/Development/omnilogic-labs/werk/packages/terminal/src/engine.ts";
import * as fast from "./engine-fast.ts";
import { TerminalReplica } from "./replica-coalesce.ts";
import type {
  Cell,
  Frame,
  TerminalHandle,
  TerminalEngineFactory,
} from "/home/mike/Development/omnilogic-labs/werk/packages/terminal/src/types.ts";
const enc = new TextEncoder();
const started = Bun.nanoseconds();
const mod = await WebAssembly.compile(await terminalWasmBytes());
const fb = await base.createTerminalEngine(mod);
const ff = await fast.createTerminalEngine(mod);
const ms = (ns: number, n = 1) => (ns / n / 1e6).toFixed(3);

// ---------- A. grid equivalence ----------
class Grid {
  rows: Cell[][] = [];
  cols = 0;
  nrows = 0;
  apply(f: Frame) {
    if (f.cols !== this.cols || f.rows !== this.nrows) {
      this.cols = f.cols;
      this.nrows = f.rows;
      this.rows = [];
    }
    for (const r of f.changed) this.rows[r.y] = r.cells;
  }
  key() {
    return JSON.stringify(
      Array.from({ length: this.nrows }, (_, y) => this.rows[y] ?? null),
    );
  }
}
function cellDiff(a: Cell[] | null, b: Cell[] | null) {
  if (!a || !b) return `one side missing (${!!a} ${!!b})`;
  for (let x = 0; x < Math.max(a.length, b.length); x++) {
    const p = JSON.stringify(a[x]),
      q = JSON.stringify(b[x]);
    if (p !== q) return `x=${x} base=${p} fast=${q}`;
  }
  return "";
}
const scripts: [string, string[]][] = [
  ["plain", ["hello world", "\r\nsecond line"]],
  [
    "sgr",
    [
      "\x1b[1mbold\x1b[0m \x1b[3mitalic\x1b[0m \x1b[4munder\x1b[0m \x1b[7minv\x1b[0m \x1b[9mstrike\x1b[0m \x1b[2mfaint\x1b[0m",
      "\x1b[1;4;7mall\x1b[0m",
    ],
  ],
  [
    "palette",
    [
      "\x1b[31mred\x1b[0m \x1b[92mbright\x1b[0m \x1b[38;5;200mp200\x1b[0m \x1b[48;5;27mbg27\x1b[0m \x1b[44mbg4\x1b[0m",
    ],
  ],
  [
    "truecolor",
    [
      "\x1b[38;2;10;20;30mfg\x1b[0m \x1b[48;2;200;100;50mbg\x1b[0m \x1b[38;2;1;2;3;48;2;4;5;6mboth\x1b[0m",
    ],
  ],
  [
    "bg-erase",
    [
      "\x1b[44m\x1b[2J\x1b[Hx",
      "\x1b[48;2;9;8;7m\x1b[K",
      "\x1b[0m\x1b[42m   \x1b[0m",
    ],
  ],
  ["bg-erase-styled", ["\x1b[1;44m\x1b[2J\x1b[Hx", "\x1b[3;48;2;9;8;7m\x1b[K"]],
  ["wide", ["A中B界C", "\r\n日本語テキスト"]],
  ["grapheme", ["éx", " 👨‍👩‍👧 y", " 🇬🇧 z"]],
  ["combining-append", ["a", "́", "̈", "b", "́"]],
  ["combining-after-wrap", ["\x1b[1;12H中", "́"]],
  ["combining-split-writes", ["abc", "\x1b[1;2H", "́"]],
  ["zwj-append", ["\x1b[2;1H👨", "‍", "👩"]],
  ["cursor", ["abc", "\x1b[5;5H", "\x1b[?25l", "\x1b[?25h", "\x1b[1;1Hz"]],
  ["scroll", ["1\r\n2\r\n3\r\n4\r\n5\r\n6\r\n7\r\n8", "\r\n9", "\r\n10"]],
  ["clear", ["abc\r\ndef", "\x1b[2J", "\x1b[Hq"]],
  ["alt", ["primary", "\x1b[?1049h", "\x1b[Halt", "\x1b[?1049l"]],
  [
    "osc4",
    ["\x1b[31mred\x1b[0m", "\x1b]4;1;rgb:12/34/56\x07", "\x1b[31m!\x1b[0m"],
  ],
  ["osc10-11", ["x", "\x1b]10;rgb:11/22/33\x07\x1b]11;rgb:44/55/66\x07", "y"]],
  ["inverse-bg", ["\x1b[7;44;31mx\x1b[0m", "\x1b[7m\x1b[K"]],
  ["hyperlink", ["\x1b]8;;http://example.com\x07link\x1b]8;;\x07"]],
  ["underline-colour", ["\x1b[4;58;2;1;2;3mu\x1b[0m", "\x1b[4:3mcurly\x1b[0m"]],
  ["idle", ["abc", "", "", "\x1b[m", "\x1b]2;title\x07"]],
  [
    "insert-delete",
    ["abcdef", "\x1b[1;2H\x1b[2@", "\x1b[2P", "\x1b[1L", "\x1b[1M"],
  ],
  [
    "scroll-region",
    ["1\r\n2\r\n3\r\n4\r\n5", "\x1b[2;4r\x1b[4;1H\n\n", "\x1b[r"],
  ],
  ["tabs-and-bs", ["a\tb\bc", "\rq"]],
];
let failures = 0,
  steps = 0,
  fastRowsReported = 0,
  baseRowsReported = 0;
for (const [name, list] of scripts) {
  const a = await fb.create({ cols: 12, rows: 8 }),
    b = await ff.create({ cols: 12, rows: 8 });
  const ga = new Grid(),
    gb = new Grid();
  const check = (label: string) => {
    const fa = a.frame(),
      fbb = b.frame();
    steps++;
    ga.apply(fa);
    gb.apply(fbb);
    fastRowsReported += fbb.changed.length;
    baseRowsReported += fa.changed.length;
    const cur = JSON.stringify(fa.cursor) === JSON.stringify(fbb.cursor);
    if (ga.key() !== gb.key() || !cur) {
      failures++;
      console.log(
        `MISMATCH ${name} ${label}: cursor ${cur ? "same" : "differs"}`,
      );
      for (let y = 0; y < ga.nrows; y++) {
        const d = cellDiff(ga.rows[y] ?? null, gb.rows[y] ?? null);
        if (d) console.log(`  row ${y}: ${d}`);
      }
      console.log(
        `  base changed=[${fa.changed.map((r) => r.y)}] fast changed=[${fbb.changed.map((r) => r.y)}] fast dirty=${(b as any).lastDirty}`,
      );
    }
  };
  let sa, sb;
  try {
    for (let i = 0; i < list.length; i++) {
      const s = list[i]!;
      if (s) {
        a.write(enc.encode(s));
        b.write(enc.encode(s));
      }
      check(`step ${i} ${JSON.stringify(s)}`);
    }
    for (const size of [
      { cols: 10, rows: 5 },
      { cols: 14, rows: 9 },
    ]) {
      a.resize(size);
      b.resize(size);
      check(`resize ${size.cols}x${size.rows}`);
    }
    a.scrollViewport("top");
    b.scrollViewport("top");
    check("scroll top");
    a.scrollViewport("bottom");
    b.scrollViewport("bottom");
    check("scroll bottom");
    sa = a.snapshot();
    sb = b.snapshot();
  } finally {
    a.dispose();
    b.dispose();
  }
  const ra = await fb.restore(sa!),
    rb = await ff.restore(sb!);
  try {
    const g1 = new Grid(),
      g2 = new Grid();
    g1.apply(ra.frame());
    g2.apply(rb.frame());
    if (g1.key() !== g2.key()) {
      failures++;
      console.log(`MISMATCH ${name} restore`);
    }
    if (g1.key() !== ga.key()) {
      failures++;
      console.log(`MISMATCH ${name} restore differs from live grid`);
    }
    if (ra.frame().changed.length || rb.frame().changed.length) {
      failures++;
      console.log(`MISMATCH ${name} restore idle not empty`);
    }
  } finally {
    ra.dispose();
    rb.dispose();
  }
}
console.log(
  `A. grid equivalence: ${failures ? failures + " mismatches" : "identical screens and cursors"} over ${steps} checkpoints in ${scripts.length} scripts; rows reported base ${baseRowsReported} vs fast ${fastRowsReported}`,
);

// ---------- B. timings on the prototype (with the grapheme fix) ----------
const fill = (size: { cols: number; rows: number }, i: number) => {
  let s = "\x1b[H";
  for (let y = 0; y < size.rows; y++) {
    const ch = String.fromCharCode(97 + ((y + i) % 26));
    s +=
      `\x1b[${y + 1};1H` +
      (ch + "\x1b[1m" + ch + "\x1b[0m ")
        .repeat(Math.floor((size.cols - 1) / 3))
        .slice(0, size.cols - 1);
  }
  return s;
};
function reset() {
  fast.timing.frames = 0;
  fast.timing.ns = 0;
  fast.timing.decodedRows = 0;
  fast.timing.styleReads = 0;
  fast.timing.fresh = 0;
}
console.log(
  "B. prototype frame() cost after the grapheme fix (ms/frame, frame only):",
);
for (const size of [
  { cols: 80, rows: 24 },
  { cols: 120, rows: 40 },
  { cols: 200, rows: 50 },
]) {
  const t = await ff.create(size);
  const cases: [string, (i: number) => void, number][] = [
    ["one byte", () => t.write(enc.encode("y")), 30],
    [
      "one byte, CUP",
      (i) =>
        t.write(enc.encode(`\x1b[${1 + (i % size.rows)};${1 + (i % 10)}Hz`)),
      30,
    ],
    ["whole screen", (i) => t.write(enc.encode(fill(size, i + 1))), 10],
    ["scroll one line", (i) => t.write(enc.encode(`line ${i}\r\n`)), 20],
    [
      "cursor move only",
      (i) => t.write(enc.encode(`\x1b[${1 + (i % size.rows)};1H`)),
      30,
    ],
    [
      "SGR-only write (fresh-state fallback)",
      (i) => t.write(enc.encode(`\x1b[${31 + (i % 7)}m`)),
      30,
    ],
    [
      "grapheme append (fresh-state fallback)",
      (i) => t.write(enc.encode(i % 2 ? "́" : "̈")),
      30,
    ],
    ["idle", () => {}, 30],
  ];
  const out: string[] = [];
  for (const [name, step, n] of cases) {
    t.write(enc.encode(fill(size, 0) + "\x1b[1;1Ha"));
    t.frame();
    for (let i = 0; i < 3; i++) {
      step(i);
      t.frame();
    }
    reset();
    let rows = 0;
    for (let i = 3; i < n + 3; i++) {
      step(i);
      rows += t.frame().changed.length;
    }
    out.push(
      `${name} ${ms(fast.timing.ns, n)} (rows changed ${(rows / n).toFixed(1)}, decoded ${(fast.timing.decodedRows / n).toFixed(1)}, fresh states ${(fast.timing.fresh / n).toFixed(1)})`,
    );
  }
  console.log(`  ${size.cols}x${size.rows}: ${out.join("; ")}`);
  t.dispose();
}

// ---------- C. resync: restore then filter through a retained shadow ----------
{
  const size = { cols: 120, rows: 40 };
  const t = await ff.create(size);
  t.write(enc.encode(fill(size, 0) + "\r\n".repeat(5) + fill(size, 3)));
  const shadow = new Grid();
  shadow.apply(t.frame());
  const s0 = Bun.nanoseconds();
  const snap = t.snapshot();
  const snapNs = Bun.nanoseconds() - s0;
  t.dispose();
  const r0 = Bun.nanoseconds();
  const r = await ff.restore(snap);
  const restoreNs = Bun.nanoseconds() - r0;
  const f0 = Bun.nanoseconds();
  const first = r.frame();
  const frameNs = Bun.nanoseconds() - f0;
  const c0 = Bun.nanoseconds();
  let differing = 0;
  for (const row of first.changed) {
    const prev = shadow.rows[row.y];
    if (
      !prev ||
      prev.length !== row.cells.length ||
      row.cells.some((c, x) => JSON.stringify(c) !== JSON.stringify(prev[x]))
    )
      differing++;
  }
  const cmpNs = Bun.nanoseconds() - c0;
  console.log(
    `C. resync at 120x40: snapshot ${snap.bytes.length} B in ${ms(snapNs)} ms; restore ${ms(restoreNs)} ms; first frame (all ${first.changed.length} rows) ${ms(frameNs)} ms; shadow compare ${ms(cmpNs)} ms, rows actually differing ${differing}`,
  );
  r.dispose();
}

// ---------- D. burst coalescing through the replica ----------
async function burst(
  label: string,
  factory: TerminalEngineFactory,
  scheduler: ((p: () => void) => void) | "immediate",
) {
  const size = { cols: 120, rows: 40 };
  const src = await factory.create(size);
  src.write(enc.encode(fill(size, 0)));
  const snap = src.snapshot();
  src.dispose();
  let paints = 0,
    rowsPainted = 0,
    paintNs = 0;
  const renderer = {
    paint(f: Frame) {
      const t0 = Bun.nanoseconds();
      paints++;
      rowsPainted += f.changed.length;
      paintNs += Bun.nanoseconds() - t0;
    },
    dispose() {},
  };
  const replica = new TerminalReplica(factory, renderer, {
    schedulePaint: scheduler === "immediate" ? (p) => p() : scheduler,
  });
  const base = { attachmentId: "a", generation: 1 };
  await replica.apply({
    ...base,
    type: "snapshot",
    position: 0,
    size,
    snapshot: snap.bytes,
  });
  await new Promise((r) => setTimeout(r, 5));
  paints = 0;
  rowsPainted = 0;
  const t0 = Bun.nanoseconds();
  const pending: Promise<void>[] = [];
  for (let i = 1; i <= 50; i++)
    pending.push(
      replica.apply({
        ...base,
        type: "output",
        position: i,
        data: enc.encode(`chunk ${i} ${"x".repeat(100)}\r\n`),
      }),
    );
  await Promise.all(pending);
  const applied = Bun.nanoseconds() - t0;
  await new Promise((r) => setTimeout(r, 20));
  const total = Bun.nanoseconds() - t0;
  console.log(
    `  ${label.padEnd(30)} paints ${String(paints).padStart(2)}, rows handed to renderer ${String(rowsPainted).padStart(4)}, applies settled after ${ms(applied)} ms, painted by ${ms(total)} ms (includes a 20 ms settle wait)`,
  );
  replica.dispose();
}
console.log("D. burst of 50 output events at 120x40 applied in one tick:");
await burst("fast engine, paint per event", ff, "immediate");
await burst("fast engine, coalesced setTimeout", ff, (p) => setTimeout(p, 0));
await burst("base engine, paint per event", fb, "immediate");
await burst("base engine, coalesced setTimeout", fb, (p) => setTimeout(p, 0));
console.log(`total run ${ms(Bun.nanoseconds() - started)} ms`);
