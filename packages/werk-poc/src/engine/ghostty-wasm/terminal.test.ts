import { describe, expect, test } from "bun:test";
import { isUnsupported, type Cell } from "../types.ts";
import { ghosttyWasmBytes } from "./bytes.ts";
import { GhosttyWasmEngine } from "./index.ts";

const engine = await GhosttyWasmEngine.load(await ghosttyWasmBytes());
const enc = new TextEncoder();

function cellsText(cells: Cell[][]): string {
  return cells
    .map((row) =>
      row
        .map((c) => c.text || (c.width === 0 ? "" : " "))
        .join("")
        .replace(/\s+$/, ""),
    )
    .join("\n");
}

describe("create / write / plainText", () => {
  test("hello world", () => {
    const t = engine.create({ cols: 20, rows: 4, scrollback: 100 });
    t.write(enc.encode("hello\r\nworld"));
    expect(t.plainText()).toBe("hello\nworld\n\n");
    expect(cellsText(t.styledCells())).toBe(t.plainText());
    t.dispose();
  });

  test("leading blank rows are kept, trailing whitespace is trimmed", () => {
    const t = engine.create({ cols: 20, rows: 4, scrollback: 100 });
    t.write(enc.encode("\r\n\r\nx   "));
    expect(t.plainText()).toBe("\n\nx\n");
    t.dispose();
  });

  test("styledCells has rows × cols cells", () => {
    const t = engine.create({ cols: 13, rows: 7, scrollback: 100 });
    const cells = t.styledCells();
    expect(cells.length).toBe(7);
    for (const row of cells) expect(row.length).toBe(13);
    t.dispose();
  });

  test("scrollback is a line limit, set through ghostty_terminal_set", () => {
    for (const scrollback of [200, 2000]) {
      const t = engine.create({ cols: 80, rows: 24, scrollback });
      expect(t.scrollbackMaxLines()).toBe(scrollback);
      for (let i = 0; i < 5000; i++) t.write(enc.encode(`line ${i}\r\n`));
      const total = t.getNumber("TOTAL_ROWS");
      console.log(
        `scrollback=${scrollback} after 5000 lines: TOTAL_ROWS=${total} SCROLLBACK_ROWS=${t.getNumber("SCROLLBACK_ROWS")}`,
      );
      // pruning is page-granular, so the retained count sits within a page of the limit
      expect(total).toBeGreaterThan(scrollback - 600);
      expect(total).toBeLessThan(scrollback + 600);
      expect(t.plainText().split("\n").at(-2)).toBe("line 4999");
      t.dispose();
    }
  });

  test("a disposed terminal refuses further use", () => {
    const t = engine.create({ cols: 5, rows: 2, scrollback: 10 });
    t.dispose();
    t.dispose(); // idempotent
    expect(() => t.write(enc.encode("x"))).toThrow(/disposed/);
  });
});

describe("styles", () => {
  test("SGR bold, italic, underline, inverse, strikethrough and colours", () => {
    const t = engine.create({ cols: 40, rows: 2, scrollback: 10 });
    t.write(
      enc.encode(
        "\x1b[1mB\x1b[0m\x1b[3mI\x1b[0m\x1b[4mU\x1b[0m\x1b[7mR\x1b[0m\x1b[9mS\x1b[0m",
      ),
    );
    t.write(
      enc.encode(
        "\x1b[31mr\x1b[0m\x1b[38;5;200mp\x1b[0m\x1b[38;2;10;20;30mt\x1b[0m\x1b[44mb\x1b[0m",
      ),
    );
    const row = t.styledCells()[0]!;
    expect(row[0]).toMatchObject({ text: "B", bold: true, italic: false });
    expect(row[1]).toMatchObject({ text: "I", italic: true, bold: false });
    expect(row[2]).toMatchObject({ text: "U", underline: true });
    expect(row[3]).toMatchObject({ text: "R", inverse: true });
    expect(row[4]).toMatchObject({ text: "S", strikethrough: true });
    expect(row[5]).toMatchObject({
      text: "r",
      fg: { kind: "palette", index: 1 },
    });
    expect(row[6]).toMatchObject({
      text: "p",
      fg: { kind: "palette", index: 200 },
    });
    expect(row[7]).toMatchObject({
      text: "t",
      fg: { kind: "rgb", r: 10, g: 20, b: 30 },
    });
    expect(row[8]).toMatchObject({
      text: "b",
      bg: { kind: "palette", index: 4 },
      fg: { kind: "default" },
    });
    expect(row[9]).toMatchObject({
      text: "",
      bold: false,
      fg: { kind: "default" },
      bg: { kind: "default" },
    });
    t.dispose();
  });

  test("a background-only run after erase carries the colour without text", () => {
    const t = engine.create({ cols: 10, rows: 1, scrollback: 10 });
    t.write(enc.encode("\x1b[42m\x1b[K")); // erase to end of line with green bg (BCE)
    const row = t.styledCells()[0]!;
    expect(row[9]).toMatchObject({
      text: "",
      bg: { kind: "palette", index: 2 },
    });
    t.dispose();
  });
});

describe("width", () => {
  test("CJK and emoji occupy two cells with a zero-width tail", () => {
    const t = engine.create({ cols: 12, rows: 1, scrollback: 10 });
    t.write(enc.encode("a日b😀c"));
    const row = t.styledCells()[0]!;
    expect(row.slice(0, 7).map((c) => [c.text, c.width])).toEqual([
      ["a", 1],
      ["日", 2],
      ["", 0],
      ["b", 1],
      ["😀", 2],
      ["", 0],
      ["c", 1],
    ]);
    expect(t.plainText()).toBe("a日b😀c");
    t.dispose();
  });

  test("a ZWJ sequence is one grapheme in one wide cell once mode 2027 is on", () => {
    const family = "👨‍👩‍👧";
    // libghostty ships with grapheme clustering (DEC 2027) off: three wide cells.
    let t = engine.create({ cols: 12, rows: 1, scrollback: 10 });
    t.write(enc.encode(`${family}x`));
    let row = t.styledCells()[0]!;
    expect(row[0]!.text).toBe("👨\u200d");
    expect(row[2]!.text).toBe("👩\u200d");
    expect(row[4]!.text).toBe("👧");
    expect(row[6]!.text).toBe("x");
    expect(t.plainText()).toBe(`${family}x`);
    t.dispose();
    // With it on, one cell of five codepoints.
    t = engine.create({ cols: 12, rows: 1, scrollback: 10 });
    t.write(enc.encode(`\x1b[?2027h${family}x`));
    row = t.styledCells()[0]!;
    expect(row[0]!.text).toBe(family);
    expect(row[0]!.width).toBe(2);
    expect(row[1]!.width).toBe(0);
    expect(row[2]!.text).toBe("x");
    expect(t.plainText()).toBe(`${family}x`);
    t.dispose();
  });

  test("combining marks attach to the base cell", () => {
    const t = engine.create({ cols: 12, rows: 1, scrollback: 10 });
    t.write(enc.encode("éx"));
    const row = t.styledCells()[0]!;
    expect(row[0]!.text).toBe("é");
    expect(row[1]!.text).toBe("x");
    t.dispose();
  });
});

describe("resize", () => {
  const lines = Array.from(
    { length: 200 },
    (_, i) => `row ${String(i).padStart(3, "0")} ${"abcdefghij".repeat(6)}`,
  );

  test("shrinking to 40 columns wraps, growing to 120 rejoins", () => {
    const t = engine.create({ cols: 80, rows: 24, scrollback: 1000 });
    t.write(enc.encode(lines.join("\r\n") + "\r\n"));
    const at80 = t.plainText();
    expect(at80.split("\n").length).toBe(24);
    expect(at80.split("\n")[22]).toBe(lines[199]);

    t.resize(40, 24);
    const at40 = t.plainText().split("\n");
    expect(at40.length).toBe(24);
    // each 68-column line becomes a 40-column head and a 28-column tail
    expect(at40[21]).toBe(lines[199]!.slice(0, 40));
    expect(at40[22]).toBe(lines[199]!.slice(40));
    const cells40 = t.styledCells();
    expect(cells40.length).toBe(24);
    expect(cells40[0]!.length).toBe(40);

    t.resize(120, 24);
    const at120 = t.plainText().split("\n");
    expect(at120.length).toBe(24);
    expect(at120[22]).toBe(lines[199]);
    expect(at120[0]).toBe(lines[177]);
    expect(t.styledCells()[0]!.length).toBe(120);
    t.dispose();
  });

  test("resizing to the same size is a no-op", () => {
    const t = engine.create({ cols: 30, rows: 5, scrollback: 10 });
    t.write(enc.encode("one\r\ntwo"));
    const before = t.plainText();
    t.resize(30, 5);
    expect(t.plainText()).toBe(before);
    expect(t.size).toEqual({ cols: 30, rows: 5 });
    t.dispose();
  });

  test("more rows expose scrollback again", () => {
    const t = engine.create({ cols: 20, rows: 3, scrollback: 100 });
    t.write(enc.encode("a\r\nb\r\nc\r\nd\r\ne"));
    expect(t.plainText()).toBe("c\nd\ne");
    t.resize(20, 6);
    expect(t.plainText()).toBe("a\nb\nc\nd\ne\n");
    t.dispose();
  });
});

describe("capabilities", () => {
  test("nothing on the seam returns Unsupported, and caps agree", () => {
    const t = engine.create({ cols: 5, rows: 2, scrollback: 10 });
    expect(isUnsupported(t.renderConsumer())).toBe(false);
    expect(
      isUnsupported(
        engine.encodeKey({ action: "press", key: "KeyA", mods: {} }, {}),
      ),
    ).toBe(false);
    expect(
      isUnsupported(
        engine.encodeMouse(
          { action: "press", button: 1, x: 0, y: 0, mods: {} },
          {},
        ),
      ),
    ).toBe(false);
    expect(isUnsupported(t.modes())).toBe(false);
    expect(isUnsupported(t.emitVt())).toBe(false);
    expect(isUnsupported(t.encodeState())).toBe(false);
    expect(isUnsupported(t.onEffect(() => {}))).toBe(false);
    expect(isUnsupported(engine.decodeState(new Uint8Array()))).toBe(false);
    expect(engine.caps).toEqual({
      write: true,
      resize: true,
      plainText: true,
      styledCells: true,
      emitVt: true,
      encodeState: true,
      decodeState: true,
      renderConsumer: true,
      effects: true,
      encodeKey: true,
      encodeMouse: true,
    });
    t.dispose();
  });
});

describe("throughput", () => {
  test("a few MiB of mixed text and escapes", () => {
    const t = engine.create({ cols: 120, rows: 40, scrollback: 2000 });
    const chunk = enc.encode(
      Array.from(
        { length: 64 },
        (_, i) =>
          `\x1b[${31 + (i % 7)}m${"lorem ipsum dolor sit amet ".repeat(3)}\x1b[0m \x1b[1m${i}\x1b[22m \x1b[38;2;${i};${i * 2};${i * 3}mrgb\x1b[0m 日本語 😀\r\n`,
      ).join(""),
    );
    const total = 4 * 1024 * 1024;
    const reps = Math.ceil(total / chunk.byteLength);
    const bytes = reps * chunk.byteLength;
    const t0 = performance.now();
    for (let i = 0; i < reps; i++) t.write(chunk);
    const dt = (performance.now() - t0) / 1000;
    const mibs = bytes / 1048576 / dt;
    console.log(
      `throughput: ${(bytes / 1048576).toFixed(1)} MiB in ${(dt * 1000).toFixed(0)} ms = ${mibs.toFixed(1)} MiB/s (Bun ${Bun.version})`,
    );
    expect(mibs).toBeGreaterThan(5);
    t.dispose();
  });
});
