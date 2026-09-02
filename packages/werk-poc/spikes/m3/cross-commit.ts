// The fleet question from the proposal, §3: does a GHOSTSNP snapshot
// encoded by one libghostty `tip` build decode on another?
//
// Loads every vendored `ghostty-vt-small.wasm` as a separate engine
// instance, encodes three cases on each build, decodes each snapshot on
// every build (itself included, as the control), and compares the result
// with the source terminal: viewport text, styled cells, cursor, and the
// whole active screen with scrollback. Also diffs `ghostty_type_json`
// across the builds. Prints markdown tables for findings/m3.md.
//
//   bun run spikes/m3/cross-commit.ts
//
// Builds other than the pinned one land gitignored under vendor/ghostty-vt/
// via `bun run vendor/ghostty-vt/fetch.ts <sha> --no-headers`; a build
// that is not on disk is reported and skipped.

import fs from "node:fs";
import path from "node:path";
import { GHOSTTY_COMMIT } from "../../src/engine/ghostty-wasm/bytes.ts";
import {
  GhosttyWasmEngine,
  type GhosttyWasmTerminal,
} from "../../src/engine/ghostty-wasm/index.ts";
import { isUnsupported } from "../../src/engine/types.ts";

const vendor = path.join(import.meta.dir, "..", "..", "vendor", "ghostty-vt");

/** Oldest first. The dates are the commits' on ghostty-org/ghostty main. */
const BUILDS: { sha: string; note: string }[] = [
  { sha: "c2906398be63f7eed567eee294ec09f291844b95", note: "2026-08-31 17:14" },
  { sha: "2c854a1aa42c96ec484f136fdd38d060bd6a7683", note: "2026-08-31 20:17" },
  { sha: "81681158b1f04b9900c3e58ba6db790384f5b6f5", note: "2026-08-31 21:23" },
  { sha: GHOSTTY_COMMIT, note: "2026-09-01 17:25, the pin" },
];

interface Build {
  sha: string;
  short: string;
  note: string;
  bytes: Uint8Array;
  sha256: string;
  engine: GhosttyWasmEngine;
  typeJson: Record<string, unknown>;
}

const enc = new TextEncoder();

async function loadBuilds(): Promise<Build[]> {
  const out: Build[] = [];
  for (const b of BUILDS) {
    const file = path.join(vendor, b.sha, "ghostty-vt-small.wasm");
    if (!fs.existsSync(file)) {
      console.log(`- ${b.sha.slice(0, 8)}: not on disk (${file}); skipped`);
      continue;
    }
    const bytes = new Uint8Array(fs.readFileSync(file));
    const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    let engine: GhosttyWasmEngine;
    try {
      engine = await GhosttyWasmEngine.load(bytes);
    } catch (e) {
      console.log(`- ${b.sha.slice(0, 8)}: failed to load: ${String(e)}`);
      continue;
    }
    const m = engine.module;
    const typeJson = JSON.parse(m.readCString(m.call("ghostty_type_json")));
    out.push({
      sha: b.sha,
      short: b.sha.slice(0, 8),
      note: b.note,
      bytes,
      sha256,
      engine,
      typeJson,
    });
  }
  return out;
}

// ---- cases ----------------------------------------------------------------

interface Case {
  name: string;
  /** Build the source terminal on `engine`. */
  make(engine: GhosttyWasmEngine): GhosttyWasmTerminal;
  /** Bytes to write to both the source and the restored terminal after the decode, if any. */
  after?: Uint8Array;
}

const CASES: Case[] = [
  {
    name: "styled 80×24, 3,000 lines of scrollback",
    make(engine) {
      const t = engine.create({ cols: 80, rows: 24, scrollback: 2000 });
      for (let i = 0; i < 3000; i++) {
        const sgr =
          i % 7 === 0 ? "\x1b[1;31m" : i % 5 === 0 ? "\x1b[4;38;5;39m" : "";
        t.write(enc.encode(`${sgr}line ${i} ${"x".repeat(i % 50)}\x1b[0m\r\n`));
      }
      t.write(
        enc.encode(
          "\x1b[1mbold\x1b[0m \x1b[3mitalic\x1b[0m \x1b[7minv\x1b[0m \x1b[38;2;10;20;30mrgb\x1b[0m \x1b[44mbg\x1b[0m\r\n" +
            "日本語 😀 mixed\r\n" +
            "\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\ after\r\n" +
            "\x1b[12;9H\x1b[1;34m",
        ),
      );
      return t;
    },
  },
  {
    name: "alternate screen, primary underneath",
    make(engine) {
      const t = engine.create({ cols: 60, rows: 12, scrollback: 200 });
      for (let i = 0; i < 40; i++) t.write(enc.encode(`primary ${i}\r\n`));
      t.write(
        enc.encode(
          "\x1b[?1049h\x1b[H\x1b[2J\x1b[32malt screen\x1b[0m\r\n~\r\n~\r\n\x1b[5;7H",
        ),
      );
      return t;
    },
    // leaving the alternate screen must reveal the primary as it was
    after: enc.encode("\x1b[?1049l"),
  },
  {
    name: "mid-CSI continuation (ESC [ 3 pending)",
    make(engine) {
      const t = engine.create({ cols: 20, rows: 3, scrollback: 10 });
      t.write(enc.encode("ab\x1b[3"));
      return t;
    },
    after: enc.encode("1mX"),
  },
];

interface Compared {
  outcome: "identical" | "differs" | "refused";
  detail: string;
  bytes: number;
  readyMs: number;
  historyMs: number;
  pages: number;
}

function compare(
  src: GhosttyWasmTerminal,
  dst: GhosttyWasmTerminal,
  what: string[],
): string[] {
  const diffs: string[] = [];
  if (src.plainText() !== dst.plainText()) diffs.push("viewport text");
  if (JSON.stringify(src.styledCells()) !== JSON.stringify(dst.styledCells()))
    diffs.push("styled cells");
  if (JSON.stringify(src.cursor()) !== JSON.stringify(dst.cursor()))
    diffs.push("cursor");
  if (src.fullText() !== dst.fullText()) diffs.push("scrollback text");
  if (src.decMode(1049) !== dst.decMode(1049)) diffs.push("alt-screen mode");
  if (JSON.stringify(src.size) !== JSON.stringify(dst.size)) diffs.push("size");
  return diffs.map((d) => `${what.join("")}${d}`);
}

function decodeOn(c: Case, source: Build, target: Build): Compared {
  const src = c.make(source.engine);
  let bytes: Uint8Array;
  try {
    const r = src.encodeState();
    if (isUnsupported(r)) throw new Error(r.reason);
    bytes = r;
  } catch (e) {
    src.dispose();
    return {
      outcome: "refused",
      detail: `encode: ${String(e)}`,
      bytes: 0,
      readyMs: 0,
      historyMs: 0,
      pages: 0,
    };
  }
  const t0 = performance.now();
  let dst: GhosttyWasmTerminal;
  let pages = 0;
  let readyMs = 0;
  let historyMs = 0;
  try {
    const d = target.engine.decodeState(bytes);
    if (isUnsupported(d)) throw new Error(d.reason);
    dst = d.ready();
    readyMs = performance.now() - t0;
    const t1 = performance.now();
    for (let p = d.next(); p; p = d.next()) pages++;
    historyMs = performance.now() - t1;
  } catch (e) {
    src.dispose();
    return {
      outcome: "refused",
      detail: String((e as Error).message ?? e),
      bytes: bytes.byteLength,
      readyMs,
      historyMs,
      pages,
    };
  }
  let diffs = compare(src, dst, []);
  if (c.after) {
    src.write(c.after);
    dst.write(c.after);
    diffs = diffs.concat(compare(src, dst, ["after continuation: "]));
  }
  // and the restored terminal must encode again, so a corpse can be carried forward
  let reencode = "";
  try {
    const r = dst.encodeState();
    if (isUnsupported(r)) reencode = "re-encode unsupported";
  } catch (e) {
    reencode = `re-encode failed: ${String(e)}`;
  }
  if (reencode) diffs.push(reencode);
  src.dispose();
  dst.dispose();
  return {
    outcome: diffs.length ? "differs" : "identical",
    detail: diffs.join("; "),
    bytes: bytes.byteLength,
    readyMs,
    historyMs,
    pages,
  };
}

// ---- type JSON diff ---------------------------------------------------------

function diffTypeJson(a: Build, b: Build): string {
  const ta = a.typeJson;
  const tb = b.typeJson;
  const lines: string[] = [];
  for (const k of Object.keys(ta)) {
    if (k === "types") continue;
    if (JSON.stringify(ta[k]) !== JSON.stringify(tb[k]))
      lines.push(`${k}: ${JSON.stringify(ta[k])} → ${JSON.stringify(tb[k])}`);
  }
  const typesA = (ta.types ?? {}) as Record<string, unknown>;
  const typesB = (tb.types ?? {}) as Record<string, unknown>;
  const added = Object.keys(typesB).filter((k) => !(k in typesA));
  const removed = Object.keys(typesA).filter((k) => !(k in typesB));
  const changed = Object.keys(typesA).filter(
    (k) =>
      k in typesB && JSON.stringify(typesA[k]) !== JSON.stringify(typesB[k]),
  );
  if (added.length) lines.push(`types added: ${added.join(", ")}`);
  if (removed.length) lines.push(`types removed: ${removed.join(", ")}`);
  if (changed.length) lines.push(`types changed: ${changed.join(", ")}`);
  return lines.length ? lines.join("; ") : "no difference";
}

// ---- main -------------------------------------------------------------------

const builds = await loadBuilds();
console.log(`\n${builds.length} builds loaded (bun ${Bun.version})\n`);
console.log("| Build | Commit | Artifact | Library version | Exports |");
console.log("| --- | --- | --- | --- | --- |");
for (const b of builds) {
  console.log(
    `| ${b.short} | ${b.note} | ${b.bytes.byteLength} B, sha256 ${b.sha256.slice(0, 8)}… | ${b.engine.module.layout.libraryVersion} | ${b.engine.module.exportCount} |`,
  );
}

console.log("\n### ghostty_type_json across builds\n");
console.log("| From | To | Difference |");
console.log("| --- | --- | --- |");
for (let i = 0; i < builds.length; i++)
  for (let j = i + 1; j < builds.length; j++)
    console.log(
      `| ${builds[i]!.short} | ${builds[j]!.short} | ${diffTypeJson(builds[i]!, builds[j]!)} |`,
    );

for (const c of CASES) {
  console.log(`\n### ${c.name}\n`);
  console.log(
    "| Encoded on | Decoded on | Result | Bytes | ready() | history | Detail |",
  );
  console.log("| --- | --- | --- | --- | --- | --- | --- |");
  for (const s of builds)
    for (const t of builds) {
      const r = decodeOn(c, s, t);
      const same = s.sha256 === t.sha256 ? " (same bytes)" : "";
      console.log(
        `| ${s.short} | ${t.short}${same} | **${r.outcome}** | ${r.bytes} | ${r.readyMs.toFixed(2)} ms | ${r.historyMs.toFixed(2)} ms, ${r.pages} pages | ${r.detail} |`,
      );
    }
}
