import { dark } from "@werk/palette";
import { Renderer as WtermRenderer } from "@wterm/dom";
import type { TerminalCore, CellData } from "@wterm/core";
import type { Frame, RendererFactory, Cell } from "../types.js";
const blank: CellData = { char: 32, fg: 256, bg: 256, flags: 0, width: 1 };
function convert(c: Cell): CellData {
  return {
    char: c.text.codePointAt(0) ?? 32,
    chars: c.text,
    width: c.width,
    fg: 256,
    bg: 256,
    fgRgb: c.fg,
    bgRgb: c.bg,
    flags:
      (c.bold ? 1 : 0) |
      (c.italic ? 4 : 0) |
      (c.underline ? 8 : 0) |
      (c.inverse ? 32 : 0) |
      (c.strikethrough ? 128 : 0),
  };
}
export const createWtermRenderer: RendererFactory = async ({ mount }) => {
  if (!(mount instanceof HTMLElement))
    throw new TypeError("Renderer mount must be an HTMLElement");
  const container = document.createElement("div");
  container.className = "werk-terminal";
  container.style.cssText =
    "font:14px/1.2 monospace;white-space:pre;" +
    `color:${dark.terminal.foreground.hex};background:${dark.terminal.background.hex}`;
  const style = document.createElement("style");
  style.textContent =
    ".werk-terminal .term-row{height:1.2em;white-space:pre}.werk-terminal .term-cell{display:inline-block;width:1ch}.werk-terminal .term-wide{display:inline-block;width:2ch}.werk-terminal .term-cursor{outline:1px solid currentColor}.werk-terminal .term-bold{font-weight:bold}.werk-terminal .term-italic{font-style:italic}.werk-terminal .term-underline{text-decoration:underline}";
  const rows = document.createElement("div");
  container.append(style, rows);
  mount.append(container);
  const renderer = new WtermRenderer(rows);
  let frame: Frame = {
    cols: 0,
    rows: 0,
    changed: [],
    cursor: { x: 0, y: 0, visible: false },
  };
  let shadow: CellData[][] = [];
  let dirty = new Set<number>();
  let disposed = false;
  const core: TerminalCore = {
    init() {},
    resize() {},
    writeString() {},
    writeRaw() {},
    getCell: (r, c) => shadow[r]?.[c] ?? blank,
    isDirtyRow: (r) => dirty.has(r),
    clearDirty: () => dirty.clear(),
    getCols: () => frame.cols,
    getRows: () => frame.rows,
    getCursor: () => ({
      row: frame.cursor.y,
      col: frame.cursor.x,
      visible: frame.cursor.visible,
    }),
    cursorKeysApp: () => false,
    bracketedPaste: () => false,
    usingAltScreen: () => false,
    getTitle: () => null,
    getResponse: () => null,
    getScrollbackCount: () => 0,
    getScrollbackCell: () => blank,
    getScrollbackLineLen: () => 0,
    getUnhandledSequences: () => [],
  };
  return {
    paint(next) {
      if (disposed) throw new Error("Renderer is disposed");
      if (next.cols !== frame.cols || next.rows !== frame.rows) {
        renderer.setup(next.cols, next.rows);
        shadow = [];
      }
      frame = next;
      dirty = new Set(next.changed.map((r) => r.y));
      for (const row of next.changed) shadow[row.y] = row.cells.map(convert);
      renderer.render(core);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      renderer.destroy();
      container.remove();
    },
  };
};
export default createWtermRenderer;
