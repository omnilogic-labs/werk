import { describe, expect, test } from "bun:test";
import type { Row } from "../types.ts";
import { ghosttyWasmBytes } from "./bytes.ts";
import { GhosttyWasmEngine } from "./index.ts";

const engine = await GhosttyWasmEngine.load(await ghosttyWasmBytes());
const enc = new TextEncoder();

const text = (r: Row) =>
  r.cells
    .map((c) => c.text || (c.width === 0 ? "" : " "))
    .join("")
    .replace(/\s+$/, "");
const ys = (rows: Iterable<Row>) => [...rows].map((r) => r.y);

function terminal(cols = 20, rows = 5) {
  const t = engine.create({ cols, rows, scrollback: 100 });
  const w = (s: string) => t.write(enc.encode(s));
  return { t, w };
}

describe("one consumer", () => {
  test("the first frame is the whole screen, then only what changed", () => {
    const { t, w } = terminal();
    const c = t.renderConsumer();
    w("hello");
    const first = c.frame();
    expect(first.dirtyAll).toBe(true);
    expect(ys(first.changed)).toEqual([0, 1, 2, 3, 4]);
    expect(first.cols).toBe(20);
    expect(first.rows).toBe(5);
    expect(text(first.changed[0]!)).toBe("hello");

    const quiet = c.frame();
    expect(quiet.dirtyAll).toBe(false);
    expect(quiet.changed).toEqual([]);
    expect(quiet.cursorChanged).toBe(false);

    w("\x1b[3;1Hthird");
    const next = c.frame();
    expect(next.dirtyAll).toBe(false);
    // the row written, and the row the cursor left
    expect(ys(next.changed)).toEqual([0, 2]);
    expect(text(next.changed[1]!)).toBe("third");
    expect(next.cursorChanged).toBe(true);
    expect(next.cursor).toMatchObject({ x: 5, y: 2, visible: true });
    t.dispose();
  });

  test("dirtyRows() is frame().changed", () => {
    const { t, w } = terminal();
    const c = t.renderConsumer();
    [...c.dirtyRows()];
    w("\x1b[2;1Hx");
    expect(ys(c.dirtyRows())).toEqual([0, 1]);
    expect(ys(c.dirtyRows())).toEqual([]);
    t.dispose();
  });

  test("styledCells() on the side does not steal a consumer's rows", () => {
    const { t, w } = terminal();
    const c = t.renderConsumer();
    c.frame();
    w("\x1b[4;1Hfour");
    expect(t.styledCells()[3]![0]!.text).toBe("f");
    expect(t.plainText().split("\n")[3]).toBe("four");
    expect(ys(c.dirtyRows())).toEqual([0, 3]);
    t.dispose();
  });

  test("a disposed consumer refuses further use; disposing the terminal disposes consumers", () => {
    const { t } = terminal();
    const c = t.renderConsumer();
    c.dispose();
    expect(() => c.frame()).toThrow(/disposed/);
    const d = t.renderConsumer();
    t.dispose();
    expect(() => d.frame()).toThrow(/disposed/);
  });
});

describe("two consumers", () => {
  test("a slow client's unread rows are not cleared by a fast one", () => {
    const { t, w } = terminal();
    const a = t.renderConsumer();
    const b = t.renderConsumer();
    a.frame();
    b.frame();

    w("first line");
    expect(ys(a.dirtyRows())).toEqual([0]);
    // b has not read yet

    w("\r\nsecond line");
    const a2 = a.frame();
    expect(a2.dirtyAll).toBe(false);
    expect(ys(a2.changed)).toEqual([0, 1]); // row 0 lost the cursor, row 1 gained text
    expect(text(a2.changed[1]!)).toBe("second line");

    const b2 = b.frame();
    expect(b2.dirtyAll).toBe(false);
    expect(ys(b2.changed)).toEqual([0, 1]);
    expect(text(b2.changed[0]!)).toBe("first line");
    expect(text(b2.changed[1]!)).toBe("second line");

    expect(ys(a.dirtyRows())).toEqual([]);
    expect(ys(b.dirtyRows())).toEqual([]);
    t.dispose();
  });

  test("a consumer created after others have drained still starts with everything", () => {
    const { t, w } = terminal();
    const a = t.renderConsumer();
    w("hello");
    a.frame();
    const late = t.renderConsumer();
    const f = late.frame();
    expect(f.dirtyAll).toBe(true);
    expect(text(f.changed[0]!)).toBe("hello");
    expect(ys(a.dirtyRows())).toEqual([]);
    t.dispose();
  });

  test("a full redraw for one consumer does not hide later partial rows from another", () => {
    const { t, w } = terminal();
    const a = t.renderConsumer();
    const b = t.renderConsumer();
    a.frame();
    b.frame();
    w("\x1b[2J"); // full for both
    expect(a.frame().dirtyAll).toBe(true);
    w("\x1b[5;1Hlast"); // partial, on top of b's pending full
    const bf = b.frame();
    expect(bf.dirtyAll).toBe(true);
    expect(ys(bf.changed)).toEqual([0, 1, 2, 3, 4]);
    expect(text(bf.changed[4]!)).toBe("last");
    expect(ys(a.dirtyRows())).toEqual([0, 4]);
    t.dispose();
  });
});

describe("what marks everything dirty", () => {
  test("resize", () => {
    const { t, w } = terminal();
    const c = t.renderConsumer();
    w("abc");
    c.frame();
    t.resize(30, 6);
    const f = c.frame();
    expect(f.dirtyAll).toBe(true);
    expect(f.cols).toBe(30);
    expect(f.rows).toBe(6);
    expect(f.changed.length).toBe(6);
    expect(f.changed[0]!.cells.length).toBe(30);
    t.dispose();
  });

  test("a full-screen clear", () => {
    const { t, w } = terminal();
    const c = t.renderConsumer();
    w("abc\r\ndef");
    c.frame();
    w("\x1b[2J");
    const f = c.frame();
    expect(f.dirtyAll).toBe(true);
    expect(f.changed.map(text)).toEqual(["", "", "", "", ""]);
    t.dispose();
  });

  test("scrolling on the primary screen reports every row, not a shift", () => {
    const { t, w } = terminal();
    const c = t.renderConsumer();
    w("1\r\n2\r\n3\r\n4\r\n5");
    c.frame();
    w("\r\n6");
    const f = c.frame();
    expect(f.dirtyAll).toBe(true);
    expect(f.changed.map(text)).toEqual(["2", "3", "4", "5", "6"]);
    expect(f.viewport).toEqual({ total: 6, offset: 1, rows: 5, active: true });
    t.dispose();
  });

  test("the alternate screen switch, both ways, and partial rows on it", () => {
    const { t, w } = terminal();
    const c = t.renderConsumer();
    w("primary");
    c.frame();
    w("\x1b[?1049h");
    const alt = c.frame();
    expect(alt.dirtyAll).toBe(true);
    expect(alt.changed.map(text)).toEqual(["", "", "", "", ""]);
    w("\x1b[Halt text");
    const partial = c.frame();
    expect(partial.dirtyAll).toBe(false);
    expect(ys(partial.changed)).toEqual([0]);
    expect(text(partial.changed[0]!)).toBe("alt text");
    w("\x1b[?1049l");
    const back = c.frame();
    expect(back.dirtyAll).toBe(true);
    expect(text(back.changed[0]!)).toBe("primary");
    t.dispose();
  });
});

describe("cursor and viewport", () => {
  test("hide, show and shape changes mark no row dirty, so the frame carries the cursor", () => {
    const { t, w } = terminal();
    const c = t.renderConsumer();
    const first = c.frame();
    expect(first.cursorChanged).toBe(true);
    expect(first.cursor).toEqual({
      x: 0,
      y: 0,
      inViewport: true,
      visible: true,
      blinking: false,
      style: "block",
      wideTail: false,
      passwordInput: false,
    });
    w("\x1b[?25l");
    const hidden = c.frame();
    expect(hidden.changed).toEqual([]);
    expect(hidden.cursorChanged).toBe(true);
    expect(hidden.cursor.visible).toBe(false);
    w("\x1b[?25h\x1b[5 q");
    const bar = c.frame();
    expect(bar.changed).toEqual([]);
    expect(bar.cursor).toMatchObject({ visible: true, style: "bar" });
    w("\x1b[2 q");
    expect(c.frame().cursor).toMatchObject({ style: "block", blinking: false });
    w("\x1b[3 q");
    expect(c.frame().cursor).toMatchObject({
      style: "underline",
      blinking: true,
    });
    expect(c.frame().cursorChanged).toBe(false);
    t.dispose();
  });

  test("a wide character puts the cursor after its tail", () => {
    const { t, w } = terminal();
    const c = t.renderConsumer();
    w("日");
    expect(c.frame().cursor).toMatchObject({ x: 2, y: 0, wideTail: false });
    t.dispose();
  });

  test("the viewport reports scrollback and the active pin", () => {
    const { t, w } = terminal();
    const c = t.renderConsumer();
    for (let i = 0; i < 12; i++) w(`line ${i}\r\n`);
    const f = c.frame();
    expect(f.viewport).toEqual({ total: 13, offset: 8, rows: 5, active: true });
    expect(f.cursor).toMatchObject({ x: 0, y: 4 });
    t.dispose();
  });
});

describe("cost", () => {
  test("an 80×24 update cycle in microseconds", () => {
    const { t, w } = terminal(80, 24);
    const c = t.renderConsumer();
    for (let i = 0; i < 30; i++) w(`row ${i} ${"x".repeat(60)}\r\n`);
    c.frame();
    const N = 1000;
    const time = (label: string, body: () => void) => {
      for (let i = 0; i < 50; i++) body();
      const t0 = performance.now();
      for (let i = 0; i < N; i++) body();
      const us = ((performance.now() - t0) * 1000) / N;
      console.log(`render consumer, 80×24: ${label}: ${us.toFixed(1)} µs`);
      return us;
    };
    const idle = time("frame(), nothing changed", () => c.frame());
    let i = 0;
    const oneRow = time("one row written, frame()", () => {
      w(`\x1b[${(i++ % 24) + 1};1Hchanged ${i}`);
      c.frame();
    });
    const scroll = time(
      "one line scrolled, frame() decodes all 24 rows",
      () => {
        w(`scrolled ${i++} ${"y".repeat(60)}\r\n`);
        c.frame();
      },
    );
    const two = t.renderConsumer();
    two.frame();
    const twoConsumers = time(
      "one row written, two consumers each frame()",
      () => {
        w(`\x1b[${(i++ % 24) + 1};1Hchanged ${i}`);
        c.frame();
        two.frame();
      },
    );
    expect(idle).toBeLessThan(scroll);
    expect(oneRow).toBeLessThan(scroll);
    expect(twoConsumers).toBeLessThan(scroll * 2);
    t.dispose();
  });
});
