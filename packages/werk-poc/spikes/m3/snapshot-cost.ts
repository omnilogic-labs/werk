// What a snapshot costs, measured on the engine the daemon runs: bytes and
// encode time per session, how long the timer holds the event loop for a
// fleet of sessions in one tick, and the two halves of the decode. The
// encode is synchronous, so "encode time" is exactly "event loop held".
//
//   bun run spikes/m3/snapshot-cost.ts

import { ghosttyWasmBytes } from "../../src/engine/ghostty-wasm/bytes.ts";
import {
  GhosttyWasmEngine,
  type GhosttyWasmTerminal,
} from "../../src/engine/ghostty-wasm/index.ts";
import { isUnsupported } from "../../src/engine/types.ts";

const engine = await GhosttyWasmEngine.load(await ghosttyWasmBytes());
const enc = new TextEncoder();

function idleShell(): GhosttyWasmTerminal {
  const t = engine.create({ cols: 80, rows: 24, scrollback: 2000 });
  t.write(enc.encode("$ ls\r\nREADME.md  package.json  src\r\n$ "));
  return t;
}

function plainLines(n: number): GhosttyWasmTerminal {
  const t = engine.create({ cols: 80, rows: 24, scrollback: 2000 });
  for (let i = 1; i <= n; i++) t.write(enc.encode(`${i}\r\n`));
  return t;
}

function styledLines(n: number): GhosttyWasmTerminal {
  const t = engine.create({ cols: 80, rows: 24, scrollback: 2000 });
  for (let i = 0; i < n; i++) {
    const sgr =
      i % 7 === 0 ? "\x1b[1;31m" : i % 5 === 0 ? "\x1b[4;38;5;39m" : "";
    t.write(enc.encode(`${sgr}line ${i} ${"x".repeat(i % 50)}\x1b[0m\r\n`));
  }
  return t;
}

/** A full 80-column line of varied text on every row, styled: the densest realistic case. */
function denseStyled(n: number): GhosttyWasmTerminal {
  const t = engine.create({ cols: 80, rows: 24, scrollback: 2000 });
  for (let i = 0; i < n; i++) {
    let line = "";
    for (let c = 0; c < 8; c++)
      line += `\x1b[38;5;${(i + c) % 256}m${String.fromCharCode(97 + ((i + c) % 26)).repeat(9)} `;
    t.write(enc.encode(line + "\x1b[0m\r\n"));
  }
  return t;
}

function measure(name: string, make: () => GhosttyWasmTerminal, reps = 5) {
  const t = make();
  const rows = t.getNumber("TOTAL_ROWS");
  let bytes = 0;
  const times: number[] = [];
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    const r = t.encodeState();
    times.push(performance.now() - t0);
    if (isUnsupported(r)) throw new Error(r.reason);
    bytes = r.byteLength;
  }
  const snap = t.encodeState() as Uint8Array;
  const t1 = performance.now();
  const d = engine.decodeState(snap);
  if (isUnsupported(d)) throw new Error(d.reason);
  const u = d.ready();
  const readyMs = performance.now() - t1;
  const readyRows = u.getNumber("TOTAL_ROWS");
  const t2 = performance.now();
  let pages = 0;
  for (let p = d.next(); p; p = d.next()) pages++;
  const historyMs = performance.now() - t2;
  const ok = u.fullText() === t.fullText() && u.plainText() === t.plainText();
  t.dispose();
  u.dispose();
  const sorted = [...times].sort((a, b) => a - b);
  console.log(
    `| ${name} | ${rows} | ${bytes} | ${sorted[0]!.toFixed(2)} / ${sorted[Math.floor(sorted.length / 2)]!.toFixed(2)} / ${sorted[sorted.length - 1]!.toFixed(2)} ms | ${readyMs.toFixed(2)} ms, ${readyRows} rows | ${historyMs.toFixed(2)} ms, ${pages} pages | ${ok ? "identical" : "DIFFERS"} |`,
  );
}

console.log(`bun ${Bun.version}\n`);
console.log(
  "| Session | Rows | Bytes | Encode min / median / max | ready() | history | Round trip |",
);
console.log("| --- | --- | --- | --- | --- | --- | --- |");
measure("idle shell, 3 lines", idleShell);
measure("3,000 plain lines (2,000 kept)", () => plainLines(3000));
measure("3,000 styled lines (2,000 kept)", () => styledLines(3000));
measure("3,000 dense styled 80-col lines (2,000 kept)", () =>
  denseStyled(3000),
);
measure("10,000 plain lines (2,000 kept)", () => plainLines(10000));

// One timer tick over a fleet: how long the event loop is held if every
// session is dirty at once.
console.log("\n| Fleet in one tick | Total bytes | Event loop held |");
console.log("| --- | --- | --- |");
for (const [label, make, n] of [
  ["10 × idle shell", idleShell, 10],
  ["10 × 3,000 plain lines", () => plainLines(3000), 10],
  ["10 × 3,000 dense styled lines", () => denseStyled(3000), 10],
  ["50 × 3,000 plain lines", () => plainLines(3000), 50],
] as const) {
  const fleet = Array.from({ length: n }, () =>
    (make as () => GhosttyWasmTerminal)(),
  );
  // warm
  for (const t of fleet) t.encodeState();
  const t0 = performance.now();
  let total = 0;
  for (const t of fleet) total += (t.encodeState() as Uint8Array).byteLength;
  const held = performance.now() - t0;
  console.log(`| ${label} | ${total} | ${held.toFixed(2)} ms |`);
  for (const t of fleet) t.dispose();
}
