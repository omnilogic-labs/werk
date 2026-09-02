// A smoke case for the differential runner: two corpus cases and a few
// fuzz iterations through all three engines, quickly. The full corpus is
// `wp bench diff`; findings/m6.md has its tables.

import { expect, test } from "bun:test";
import { CastBuilder, formatCast, parseCast } from "./cast.ts";
import { CORPUS } from "./corpus/index.ts";
import { runDifferential } from "./differential.ts";

test("the cast format round-trips text, resizes and non-UTF-8 bytes", () => {
  const cast = new CastBuilder(20, 4, "t")
    .o("héllo")
    .r(10, 4)
    .o(new Uint8Array([0xe2, 0x82]))
    .o(new Uint8Array([0xac]))
    .build();
  const text = formatCast(cast);
  expect(text.split("\n")[3]).toMatch(/^\[0\.02,"b","4oI="\]$/);
  const back = parseCast(text);
  expect(back.header).toMatchObject({ width: 20, height: 4 });
  expect(back.events.map((e) => e.kind)).toEqual([
    "output",
    "resize",
    "output",
    "output",
  ]);
  expect(back.events[2]).toMatchObject({ bytes: new Uint8Array([0xe2, 0x82]) });
});

test("every corpus entry has its file recorded", async () => {
  const fs = await import("node:fs");
  for (const c of CORPUS)
    expect(fs.existsSync(`${import.meta.dir}/corpus/${c.file}`)).toBe(true);
});

test("the runner replays a recorded and a reattach case and fuzzes a little", async () => {
  const lines: string[] = [];
  const report = await runDifferential({
    cases: ["ls-color", "reattach-alt-vim-like"],
    fuzz: 3,
    seed: 7,
    out: (l) => lines.push(l),
  });
  expect(report.engines).toEqual([
    "ghostty-wasm",
    "ghostty-ffi",
    "xterm-oracle",
  ]);
  expect(report.cases.map((c) => c.name)).toEqual([
    "ls-color",
    "reattach-alt-vim-like",
  ]);
  // ls --color: the three agree on text, cells and effects.
  const ls = report.cases[0]!;
  for (const p of Object.values(ls.pairs))
    expect(p).toMatchObject({ text: true, cells: true, effects: true });
  // The alternate-screen reattach: the wasm snapshot is exact, the ffi has none.
  const alt = report.cases[1]!.reattach!;
  expect(alt["ghostty-wasm"]!["state"]!.status).toBe("exact");
  expect(alt["ghostty-ffi"]!["state"]!.status).toBe("unsupported");
  expect(alt["xterm-oracle"]!["resize-then-reemit"]!.status).toBe("exact");
  expect(report.fuzz.map((f) => f.mode)).toEqual(["bytes", "sequences"]);
  for (const f of report.fuzz)
    for (const e of report.engines) expect(f.splitInvariant[e]).toBe(3);
  expect(report.tables).toContain("| ls-color");
  expect(lines.some((l) => l.includes("== fuzz sequences"))).toBe(true);
}, 30_000);
