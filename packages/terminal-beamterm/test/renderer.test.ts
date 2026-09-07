import { test, expect, mock } from "bun:test";
import type { Cell, Frame } from "@werk/terminal";

interface Write {
  x: number;
  y: number;
  text: string;
  fg: number;
  bg: number;
  bold: boolean;
}
const writes: Write[] = [];
let renders = 0;
let resizes = 0;
let liveStyles = 0;
let liveBatches = 0;

function fakeStyle() {
  liveStyles++;
  const state = { fg: 0, bg: 0, bold: false };
  const style = {
    state,
    fg(value: number) {
      state.fg = value;
      return style;
    },
    bg(value: number) {
      state.bg = value;
      return style;
    },
    bold() {
      state.bold = true;
      return style;
    },
    italic: () => style,
    underline: () => style,
    strikethrough: () => style,
    free() {
      liveStyles--;
    },
  };
  return style;
}
class FakeRenderer {
  static withDynamicAtlas() {
    return new FakeRenderer();
  }
  cellSize() {
    return { width: 8, height: 16, free() {} };
  }
  resize() {
    resizes++;
  }
  batch() {
    liveBatches++;
    return {
      text(
        x: number,
        y: number,
        text: string,
        style: ReturnType<typeof fakeStyle>,
      ) {
        writes.push({ x, y, text, ...style.state });
      },
      free() {
        liveBatches--;
      },
    };
  }
  render() {
    renders++;
  }
  free() {}
}
mock.module("@beamterm/renderer/web", () => ({
  default: async () => {},
  style: fakeStyle,
  BeamtermRenderer: FakeRenderer,
}));
class StubElement {
  children: unknown[] = [];
  id = "";
  append(child: unknown) {
    this.children.push(child);
  }
  remove() {}
}
(globalThis as any).HTMLElement = StubElement;
(globalThis as any).document = { createElement: () => new StubElement() };
const { beamtermRenderer } = await import("../src/index.ts");

const cell = (text: string, extra: Partial<Cell> = {}): Cell => ({
  text,
  width: 1,
  fg: 0xffffff,
  bg: 0x000000,
  bold: false,
  italic: false,
  underline: false,
  inverse: false,
  strikethrough: false,
  ...extra,
});
const row = (y: number, text: string) => ({
  y,
  cells: [...text].map((c) => cell(c)),
});
const frame = (
  changed: Frame["changed"],
  cursor: Frame["cursor"] = { x: 0, y: 0, visible: false },
  size = { cols: 4, rows: 3 },
): Frame => ({ ...size, changed, cursor });

async function mounted() {
  writes.length = 0;
  renders = 0;
  resizes = 0;
  const renderer = await beamtermRenderer()({ mount: new StubElement() });
  return renderer;
}
const at = (y: number) => writes.filter((w) => w.y === y).map((w) => w.text);

test("the first paint of a size emits every row it was given", async () => {
  const renderer = await mounted();
  renderer.paint(frame([row(0, "abcd"), row(2, "efgh")]));
  expect(resizes).toBe(1);
  expect(renders).toBe(1);
  expect(at(0)).toEqual(["a", "b", "c", "d"]);
  expect(at(1)).toEqual([]);
  expect(at(2)).toEqual(["e", "f", "g", "h"]);
  renderer.dispose();
});

test("a later paint emits only the rows the frame changed", async () => {
  const renderer = await mounted();
  renderer.paint(frame([row(0, "abcd"), row(1, "efgh"), row(2, "ijkl")]));
  writes.length = 0;
  renderer.paint(frame([row(1, "EFGH")]));
  expect(writes.map((w) => w.text)).toEqual(["E", "F", "G", "H"]);
  expect(renders).toBe(2);
  renderer.dispose();
});

test("a paint with nothing changed and a still cursor emits nothing", async () => {
  const renderer = await mounted();
  renderer.paint(frame([row(0, "abcd")], { x: 1, y: 0, visible: true }));
  writes.length = 0;
  renderer.paint(frame([], { x: 1, y: 0, visible: true }));
  expect(writes).toEqual([]);
  expect(renders).toBe(2);
  renderer.dispose();
});

test("a cursor move emits the cell it left and the cell it entered", async () => {
  const renderer = await mounted();
  renderer.paint(frame([row(0, "abcd")], { x: 0, y: 0, visible: true }));
  expect(writes.find((w) => w.x === 0 && w.y === 0)).toMatchObject({
    fg: 0x000000,
    bg: 0xffffff,
  });
  writes.length = 0;
  renderer.paint(frame([], { x: 2, y: 0, visible: true }));
  expect(writes).toEqual([
    { x: 0, y: 0, text: "a", fg: 0xffffff, bg: 0x000000, bold: false },
    { x: 2, y: 0, text: "c", fg: 0x000000, bg: 0xffffff, bold: false },
  ]);
  renderer.dispose();
});

test("a cursor inside a changed row is inverted without a second write", async () => {
  const renderer = await mounted();
  renderer.paint(frame([row(0, "abcd")], { x: 1, y: 0, visible: true }));
  writes.length = 0;
  renderer.paint(frame([row(0, "wxyz")], { x: 1, y: 0, visible: true }));
  expect(writes).toHaveLength(4);
  expect(writes[1]).toMatchObject({ text: "x", fg: 0x000000, bg: 0xffffff });
  renderer.dispose();
});

test("hiding the cursor restores the cell underneath it", async () => {
  const renderer = await mounted();
  renderer.paint(frame([row(0, "abcd")], { x: 3, y: 0, visible: true }));
  writes.length = 0;
  renderer.paint(frame([], { x: 3, y: 0, visible: false }));
  expect(writes).toEqual([
    { x: 3, y: 0, text: "d", fg: 0xffffff, bg: 0x000000, bold: false },
  ]);
  renderer.dispose();
});

test("a size change resizes and emits the whole new grid", async () => {
  const renderer = await mounted();
  renderer.paint(frame([row(0, "abcd"), row(1, "efgh"), row(2, "ijkl")]));
  writes.length = 0;
  renderer.paint(
    frame(
      [row(0, "ab"), row(1, "cd")],
      { x: 0, y: 0, visible: false },
      { cols: 2, rows: 2 },
    ),
  );
  expect(resizes).toBe(2);
  expect(writes.map((w) => w.text)).toEqual(["a", "b", "c", "d"]);
  renderer.dispose();
});

test("zero-width spacer cells are never written and styles and batches are freed", async () => {
  const renderer = await mounted();
  renderer.paint(
    frame([
      {
        y: 0,
        cells: [
          cell("漢", { width: 2, bold: true }),
          cell("", { width: 0 }),
          cell("x"),
          cell("y"),
        ],
      },
    ]),
  );
  expect(writes.map((w) => w.text)).toEqual(["漢", "x", "y"]);
  expect(writes[0]!.bold).toBe(true);
  expect(liveStyles).toBe(0);
  expect(liveBatches).toBe(0);
  renderer.dispose();
});
