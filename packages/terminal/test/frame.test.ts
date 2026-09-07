import { test, expect } from "bun:test";
import { loadTerminalEngine } from "../src/bun/index.ts";
import type { Cell } from "../src/types.ts";
import { readCells } from "./frame-oracle.ts";
const bytes = (s: string) => new TextEncoder().encode(s);
const scripts: [string, string[]][] = [
  ["coalesced-graphemes", ["a", "́\x1b[7;1Hx", "\x1b[1;2Ḧ\x1b[6;1Hy"]],
  [
    "long-graphemes",
    ["a" + "́".repeat(250) + "b" + "̈".repeat(250), "\r\nc", "́"],
  ],
  [
    "multi-page-styles",
    [
      Array.from(
        { length: 900 },
        (_, n) => `\x1b[38;2;${n % 256};20;30mline${n}\r\n`,
      ).join(""),
    ],
  ],
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

for (const [name, writes] of scripts)
  test(`packed frames match per-cell ABI: ${name}`, async () => {
    const factory = await loadTerminalEngine();
    const actual = await factory.create({ cols: 12, rows: 8 });
    const reference = await factory.create({ cols: 12, rows: 8 });
    let shadow: Cell[][] = [];
    const check = () => {
      const frame = actual.frame();
      for (const row of frame.changed) shadow[row.y] = row.cells;
      shadow.length = frame.rows;
      expect(shadow).toEqual(readCells(reference));
      expect(frame.cursor).toEqual(reference.frame().cursor);
      expect(actual.readScreen()).toBe(reference.readScreen());
      expect(actual.frame().changed).toHaveLength(0);
    };
    try {
      check();
      for (const write of writes) {
        actual.write(bytes(write));
        reference.write(bytes(write));
        check();
      }
      for (const size of [
        { cols: 10, rows: 5 },
        { cols: 14, rows: 9 },
      ]) {
        actual.resize(size);
        reference.resize(size);
        check();
      }
      for (const direction of ["top", "bottom"] as const) {
        actual.scrollViewport(direction);
        reference.scrollViewport(direction);
        check();
      }
      const restored = await factory.restore(actual.snapshot());
      try {
        expect(restored.frame().changed.map((row) => row.cells)).toEqual(
          shadow,
        );
        expect(restored.frame().changed).toHaveLength(0);
      } finally {
        restored.dispose();
      }
    } finally {
      actual.dispose();
      reference.dispose();
    }
  });

test("frames report only content changes and own their returned rows", async () => {
  const t = await (await loadTerminalEngine()).create({ cols: 12, rows: 8 });
  try {
    expect(t.frame().changed).toHaveLength(8);
    expect(t.frame().changed).toHaveLength(0);
    t.write(bytes("a"));
    const frame = t.frame();
    expect(frame.changed.map((row) => row.y)).toEqual([0]);
    frame.changed[0]!.cells[0]!.text = "mutated";
    t.write(bytes("\x1b[1;1Ha"));
    expect(t.frame().changed).toHaveLength(0);
    t.write(bytes("\x1b[4;5H"));
    expect(t.frame()).toMatchObject({ changed: [], cursor: { x: 4, y: 3 } });
    t.resize(t.size);
    expect(t.frame().changed).toHaveLength(8);
    t.scrollViewport("top");
    expect(t.frame().changed).toHaveLength(8);
  } finally {
    t.dispose();
    t.dispose();
  }
});

test("idle and one-row frames avoid per-cell ABI walks", async () => {
  const t = await (await loadTerminalEngine()).create({ cols: 120, rows: 40 });
  const { a } = t as unknown as { a: import("../src/abi.ts").Abi };
  const original = a.call.bind(a);
  const counts = new Map<string, number>();
  a.call = (name, ...args) => {
    counts.set(name, (counts.get(name) ?? 0) + 1);
    return original(name, ...args);
  };
  try {
    t.frame();
    counts.clear();
    expect(t.frame().changed).toHaveLength(0);
    expect(counts.get("ghostty_render_state_row_get")).toBeUndefined();
    expect(counts.get("ghostty_render_state_row_cells_get")).toBeUndefined();
    t.write(bytes("x"));
    counts.clear();
    expect(t.frame().changed.map((row) => row.y)).toEqual([0]);
    expect(counts.get("ghostty_render_state_row_get")).toBe(1);
    expect(counts.get("ghostty_render_state_row_cells_get")).toBeUndefined();
  } finally {
    t.dispose();
  }
});
