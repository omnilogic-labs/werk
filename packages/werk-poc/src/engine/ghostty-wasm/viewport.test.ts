// The additions the browser renderer evaluation needed from the adapter
// (findings/m4.md): moving the viewport through scrollback, the active
// screen, and a selection's text through libghostty's own formatter.

import { describe, expect, test } from "bun:test";
import { ghosttyWasmBytes } from "./bytes.ts";
import { GhosttyWasmEngine } from "./index.ts";

const engine = await GhosttyWasmEngine.load(await ghosttyWasmBytes());
const enc = new TextEncoder();

function filled(lines = 50, cols = 20, rows = 5) {
  const t = engine.create({ cols, rows, scrollback: 1000 });
  for (let i = 1; i <= lines; i++) t.write(enc.encode(`line ${i}\r\n`));
  return t;
}

describe("scrollViewport", () => {
  test("moves the viewport and the next frame is a full repaint of the new rows", () => {
    const t = filled();
    const c = t.renderConsumer();
    c.frame();
    const before = t.viewport();
    expect(before.active).toBe(true);
    expect(before.offset).toBe(before.total - before.rows);

    t.scrollViewport({ kind: "delta", delta: -10 });
    const f = c.frame();
    expect(f.dirtyAll).toBe(true);
    expect(f.changed.length).toBe(5);
    expect(f.viewport.active).toBe(false);
    expect(f.viewport.offset).toBe(before.offset - 10);
    expect(f.cursor.inViewport).toBe(false);
    expect(t.plainText().split("\n")[0]).toBe("line 37");

    t.scrollViewport({ kind: "top" });
    expect(t.viewport().offset).toBe(0);
    expect(t.plainText().split("\n")[0]).toBe("line 1");

    t.scrollViewport({ kind: "row", row: 20 });
    expect(t.viewport().offset).toBe(20);
    expect(t.plainText().split("\n")[0]).toBe("line 21");

    t.scrollViewport({ kind: "bottom" });
    const g = c.frame();
    expect(g.viewport.active).toBe(true);
    expect(g.cursor.inViewport).toBe(true);
    t.dispose();
  });

  test("output while scrolled leaves the viewport where it is", () => {
    const t = filled();
    t.scrollViewport({ kind: "delta", delta: -10 });
    const top = t.plainText().split("\n")[0];
    t.write(enc.encode("more\r\n"));
    expect(t.plainText().split("\n")[0]).toBe(top);
    expect(t.viewport().active).toBe(false);
    t.dispose();
  });
});

describe("activeScreen", () => {
  test("reports the alternate screen while it is on", () => {
    const t = engine.create({ cols: 20, rows: 5, scrollback: 10 });
    expect(t.activeScreen()).toBe("primary");
    t.write(enc.encode("\x1b[?1049h"));
    expect(t.activeScreen()).toBe("alternate");
    t.write(enc.encode("\x1b[?1049l"));
    expect(t.activeScreen()).toBe("primary");
    t.dispose();
  });
});

describe("selectionText", () => {
  test("viewport points give the text between them, trimmed and unwrapped", () => {
    const t = engine.create({ cols: 10, rows: 4, scrollback: 10 });
    t.write(enc.encode("hello world foo\r\nbar   \r\nbaz"));
    // "hello worl" / "d foo" soft-wrapped, then bar, baz
    expect(t.selectionText({ x: 0, y: 0 }, { x: 4, y: 1 }, "viewport")).toBe(
      "hello world foo",
    );
    expect(t.selectionText({ x: 6, y: 0 }, { x: 2, y: 2 }, "viewport")).toBe(
      "world foo\nbar",
    );
    expect(t.selectionText({ x: 0, y: 3 }, { x: 9, y: 3 }, "viewport")).toBe(
      "baz",
    );
    t.write(enc.encode("\x1b[2J"));
    expect(t.selectionText({ x: 0, y: 0 }, { x: 9, y: 3 }, "viewport")).toBe(
      "",
    );
    t.dispose();
  });

  test("screen points reach into scrollback, in the row space viewport().offset reports", () => {
    const t = filled();
    const v = t.viewport();
    expect(t.selectionText({ x: 0, y: 0 }, { x: 19, y: 1 })).toBe(
      "line 1\nline 2",
    );
    // The viewport's first row is screen row v.offset.
    expect(t.selectionText({ x: 0, y: v.offset }, { x: 19, y: v.offset })).toBe(
      t.plainText().split("\n")[0]!,
    );
    t.dispose();
  });
});
