// Adapter onto `@wterm/dom`'s DOM renderer (wterm 0.4.1, Apache-2.0).
//
// wterm paints real DOM rows rather than a canvas, which is why it is worth
// measuring: native selection, copy, find and accessibility come from the
// browser rather than from a controller the page has to write. What it
// costs at werk's output rates is exactly what is unmeasured.
//
// The package's `WTerm` orchestrator is not used. It owns WASM loading,
// input, resize observation and its own render loop, all of which the page
// already owns. What is used is the bare `Renderer` class plus a
// `TerminalCore` standing in for wterm's emulator — the interface's own doc
// comment invites that, "so that `@wterm/dom` can render any core
// interchangeably".
//
// The core here holds no emulator: `ShadowCore` is a shadow of the last
// frame. `paint(frame)` converts the rows `frame.changed` names into
// wterm's `CellData` and marks them dirty, and `Renderer.render` pulls them
// back through `getCell`/`isDirtyRow`, so a one-row frame rebuilds one row
// of DOM and nothing else. Everything an emulator-driving core would
// answer — writes, resizes, responses — is a stub, listed on each method.
//
// wterm's own scrollback machinery (`getScrollbackCount`,
// `getScrollbackCell`, the `RenderViewport` argument to `render`) is
// deliberately unused: libghostty owns the viewport, `host.scrollLines`
// moves it, and the next frame arrives already composed for whatever the
// viewport shows. Running both would scroll twice.

import type { Cell, Color, Frame, Row } from "../../engine/types.ts";
import type {
  CellData,
  CursorState as WtermCursor,
  TerminalCore,
  UnhandledSequence,
} from "@wterm/core";
import { Renderer as WtermDom } from "@wterm/dom";
import {
  DEFAULT_BG,
  DEFAULT_FG,
  newPaintStats,
  palette,
  recordPaint,
  type CellSize,
  type PaintStats,
  type Renderer,
  type RendererHost,
  type RendererSelection,
} from "./renderer.ts";

// ============================================================================
// wterm's cell encoding
// ============================================================================

// `CellData.flags` is a bitfield in SGR order. `dist/renderer.js` consumes
// bold 0x01, dim 0x02, italic 0x04, underline 0x08, reverse 0x20, invisible
// 0x40 and strikethrough 0x80, and `dist/debug.js` names all eight bits,
// including the 0x10 the renderer ignores:
//
//   0x01 bold  0x02 dim  0x04 italic  0x08 underline
//   0x10 blink  0x20 reverse  0x40 invisible  0x80 strikethrough
//
// A `Cell` carries five of them; dim, blink and invisible have no source
// here, so those bits are never set.
const FLAG_BOLD = 0x01;
const FLAG_ITALIC = 0x04;
const FLAG_UNDERLINE = 0x08;
const FLAG_REVERSE = 0x20;
const FLAG_STRIKETHROUGH = 0x80;

// `fg` and `bg` are palette indices, and 256 means "the default colour":
// `colorToCSS` returns null for it and the row inherits `--term-fg` /
// `--term-bg` from the container. wterm's own core reads them as a `u16`
// per cell (`wasm-bridge.js`: char u32, fg u16, bg u16, flags u8, width u8),
// so 256 fits and no larger value is meaningful. `fgRgb`/`bgRgb` override
// the index with a packed 0xRRGGBB when a core has true colour; wterm's own
// core never sets them, and this one sets them for a `rgb` cell only.
const DEFAULT_COLOR = 256;

/**
 * A werk `Cell` as wterm's `CellData`.
 *
 * `char` is a codepoint and `chars` the whole grapheme cluster, which
 * `_buildRowContent` prefers when it is set: `cell.chars ?? (cp >= 32 ?
 * String.fromCodePoint(cp) : " ")`. A codepoint below 32 renders as a
 * space, so an empty cell could be zero, but it is written as a space
 * because that is what it is. `width` carries werk's meaning unchanged —
 * wterm reads 0 as the continuation of the wide cell to its left.
 */
function toCellData(c: Cell): CellData {
  let flags = 0;
  if (c.bold) flags |= FLAG_BOLD;
  if (c.italic) flags |= FLAG_ITALIC;
  if (c.underline) flags |= FLAG_UNDERLINE;
  if (c.inverse) flags |= FLAG_REVERSE;
  if (c.strikethrough) flags |= FLAG_STRIKETHROUGH;
  const cp = c.text.length === 0 ? 0x20 : c.text.codePointAt(0)!;
  const d: CellData = {
    char: cp,
    fg: colorIndex(c.fg),
    bg: colorIndex(c.bg),
    flags,
    width: c.width,
  };
  // More than one codepoint — a combining mark, a ZWJ sequence, a flag —
  // and the cluster goes through `chars`; one astral codepoint is two UTF-16
  // units and `char` still carries it.
  if (c.text.length > (cp > 0xffff ? 2 : 1)) d.chars = c.text;
  const fg = packRgb(c.fg);
  if (fg !== undefined) d.fgRgb = fg;
  const bg = packRgb(c.bg);
  if (bg !== undefined) d.bgRgb = bg;
  return d;
}

function colorIndex(c: Color): number {
  return c.kind === "palette" ? c.index : DEFAULT_COLOR;
}

function packRgb(c: Color): number | undefined {
  return c.kind === "rgb" ? (c.r << 16) | (c.g << 8) | c.b : undefined;
}

const BLANK: CellData = Object.freeze({
  char: 0x20,
  fg: DEFAULT_COLOR,
  bg: DEFAULT_COLOR,
  flags: 0,
  width: 1,
});

function blank(): CellData {
  return {
    char: 0x20,
    fg: DEFAULT_COLOR,
    bg: DEFAULT_COLOR,
    flags: 0,
    width: 1,
  };
}

// ============================================================================
// The stylesheet
// ============================================================================

const ROOT_CLASS = "wp-wterm";
const STYLE_ID = "wp-wterm-style";

/**
 * The rules `@wterm/dom`'s markup needs, scoped to this renderer's root.
 *
 * The package ships them at `@wterm/dom/src/terminal.css` and they are
 * required — without them the rows do not lay out — but the page's HTML is
 * generated server-side and `tsc` rejects `import … with { type: "text" }`,
 * so the subset the renderer's own output uses is inlined here. It tracks
 * `@wterm/dom/src/terminal.css` at 0.4.1: the class names, the row
 * geometry, the `1ch`/`2ch` block and wide widths and the cursor outline
 * are upstream's; the themes, the padding, the border radius and the
 * scroll-on-overflow rules are not, and the colour variables are bound to
 * werk's own palette so this renderer paints the same colours as the canvas
 * ones. Indices 16–255 still resolve through wterm's own cube, which steps
 * by 51 where werk's `palette()` steps 0/95/135/175/215/255.
 */
function styleText(): string {
  const vars = Array.from(
    { length: 16 },
    (_, i) => `  --term-color-${i}: ${palette(i)};`,
  ).join("\n");
  return `
.${ROOT_CLASS} {
${vars}
  --term-fg: ${DEFAULT_FG};
  --term-bg: ${DEFAULT_BG};
  --term-cursor: #aeafad;
  --term-font-family: monospace;
  --term-font-size: 14px;
  --term-line-height: 1.2;
  --term-row-height: 17px;
  position: absolute;
  inset: 0;
  background: var(--term-bg);
  color: var(--term-fg);
  font-family: var(--term-font-family);
  font-size: var(--term-font-size);
  line-height: var(--term-line-height);
  outline: none;
  overflow: hidden;
  overflow-anchor: none;
}
.${ROOT_CLASS} .term-grid {
  display: block;
  position: relative;
  white-space: pre;
  contain: layout paint style;
  will-change: contents;
}
.${ROOT_CLASS} .term-row {
  display: block;
  height: var(--term-row-height);
  line-height: var(--term-row-height);
  contain: layout style;
}
.${ROOT_CLASS} .term-scrollback-spacer,
.${ROOT_CLASS} .term-image-flow-spacer {
  display: block;
  height: 0;
  pointer-events: none;
}
.${ROOT_CLASS} .term-row > span,
.${ROOT_CLASS} .term-row > .term-link,
.${ROOT_CLASS} .term-link > span {
  display: inline-block;
  height: var(--term-row-height);
  vertical-align: top;
}
.${ROOT_CLASS} .term-link { color: inherit; cursor: text; }
.${ROOT_CLASS} .term-block { width: 1ch; overflow: hidden; }
.${ROOT_CLASS} .term-wide { width: 2ch; overflow: hidden; }
.${ROOT_CLASS} .term-cursor {
  outline: 1px solid var(--term-cursor);
  outline-offset: -1px;
}
.${ROOT_CLASS}.focused .term-cursor {
  background: var(--term-cursor);
  color: var(--term-bg);
  outline: none;
}
.${ROOT_CLASS} .term-images {
  position: absolute;
  inset: 0;
  pointer-events: none;
  overflow: visible;
  z-index: 1;
}
.${ROOT_CLASS} ::selection { background: rgba(86, 156, 214, 0.3); }
/*
 * The program owns the mouse: no native selection, and no hit target inside
 * the grid, so a press reports through \`offsetX\` in grid space rather than
 * in some span's.
 */
.${ROOT_CLASS}.program-mouse { user-select: none; }
.${ROOT_CLASS}.program-mouse .term-grid * { pointer-events: none; }
`;
}

function injectStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = styleText();
  document.head.appendChild(el);
}

// ============================================================================
// The core wterm renders through
// ============================================================================

/**
 * A `TerminalCore` that emulates nothing: the last frame's rows as wterm's
 * cells, plus the dirty set since the last `render`.
 *
 * Everything wterm's renderer pulls is answered from that. The methods that
 * exist to drive an emulator throw, because reaching them means something
 * is treating this as one; the ones a renderer may reasonably call for
 * state werk keeps elsewhere answer with the empty value.
 */
class ShadowCore implements TerminalCore {
  private cols = 0;
  private rows = 0;
  private cells: CellData[][] = [];
  private dirty: boolean[] = [];
  private cursor: WtermCursor = { row: -1, col: -1, visible: false };

  // -- the adapter's own surface, not part of `TerminalCore` ---------------

  /** Resize the shadow and blank it; the caller re-runs `Renderer.setup`. */
  reset(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.cells = Array.from({ length: rows }, () =>
      Array.from({ length: cols }, blank),
    );
    this.dirty = new Array<boolean>(rows).fill(true);
    this.cursor = { row: -1, col: -1, visible: false };
  }

  /** One row of a frame, converted once and marked dirty for the next render. */
  setRow(row: Row): void {
    const dst = this.cells[row.y];
    if (!dst) return;
    const n = Math.min(dst.length, row.cells.length);
    for (let x = 0; x < n; x++) dst[x] = toCellData(row.cells[x]!);
    for (let x = n; x < dst.length; x++) dst[x] = blank();
    this.dirty[row.y] = true;
  }

  /** A cursor outside the viewport sits at row -1, which matches no row. */
  setCursor(row: number, col: number, visible: boolean): void {
    this.cursor = { row, col, visible };
  }

  row(y: number): readonly CellData[] {
    return this.cells[y] ?? [];
  }

  // -- what the renderer pulls --------------------------------------------

  getCols(): number {
    return this.cols;
  }

  getRows(): number {
    return this.rows;
  }

  getCell(row: number, col: number): CellData {
    return this.cells[row]?.[col] ?? BLANK;
  }

  isDirtyRow(row: number): boolean {
    return this.dirty[row] === true;
  }

  clearDirty(): void {
    this.dirty.fill(false);
  }

  getCursor(): WtermCursor {
    return this.cursor;
  }

  /** libghostty owns the viewport, so wterm's scrollback stays empty. */
  getScrollbackCount(): number {
    return 0;
  }

  getScrollbackCell(): CellData {
    return BLANK;
  }

  getScrollbackLineLen(): number {
    return 0;
  }

  getUnhandledSequences(): UnhandledSequence[] {
    return [];
  }

  /** The page holds the title, from the daemon's effects. */
  getTitle(): string | null {
    return null;
  }

  /** Modes live on the replica; the DOM renderer reads none of these. */
  usingAltScreen(): boolean {
    return false;
  }

  cursorKeysApp(): boolean {
    return false;
  }

  bracketedPaste(): boolean {
    return false;
  }

  /** Nothing here answers a query: the daemon's terminal does that. */
  getResponse(): string | null {
    return null;
  }

  // -- driving an emulator, which this is not ------------------------------

  init(): never {
    throw new Error("wterm adapter: the frames come from libghostty");
  }

  resize(): never {
    throw new Error("wterm adapter: the frames come from libghostty");
  }

  writeString(): never {
    throw new Error("wterm adapter: the frames come from libghostty");
  }

  writeRaw(): never {
    throw new Error("wterm adapter: the frames come from libghostty");
  }
}

// ============================================================================
// Selection, which is the browser's
// ============================================================================

/** A DOM boundary: a text node and a character offset, or a parent and a child index. */
interface Point {
  node: Node;
  offset: number;
}

/** One column's DOM extent, as `_buildRowContent` laid it out. */
interface Slot {
  col: number;
  /** 2 for a wide cell, which covers its continuation column too. */
  width: number;
  start: Point;
  end: Point;
}

/** A selection held where a scroll cannot move it: absolute rows, as the ghostty-web controller holds it. */
interface Anchor {
  startCol: number;
  startAbs: number;
  endCol: number;
  endAbs: number;
}

/**
 * The page's selection surface on top of the browser's own.
 *
 * Nothing here draws: the rows are real text, so a drag selects, Ctrl-C
 * copies and the find bar finds without this class being involved.
 * What it does is give the page the three things native selection does not
 * offer by itself — text a harness can read, a programmatic range, and a
 * selection that survives a scroll.
 */
class WtermSelection implements RendererSelection {
  lastCopied: string | null = null;
  /** The viewport offset the painted rows belong to. */
  private offset = 0;
  private anchor: Anchor | null = null;
  /**
   * The range this class last wrote. `selectionchange` arrives in a later
   * task than the write that caused it, so a flag held across the write
   * would already be down; the ends are compared instead.
   */
  private applied: { from: Point; to: Point } | null = null;
  /** The selection went away because a scroll took it off screen, not because anyone dropped it. */
  private removedBySelf = false;
  private readonly onSelectionChange = () => this.readBack();

  constructor(
    private readonly host: RendererHost,
    private readonly grid: HTMLElement,
    private readonly rowEls: () => readonly HTMLElement[],
    private readonly core: ShadowCore,
  ) {
    document.addEventListener("selectionchange", this.onSelectionChange);
  }

  dispose(): void {
    document.removeEventListener("selectionchange", this.onSelectionChange);
  }

  // -- the page's surface --------------------------------------------------

  getSelection(): string {
    const sel = document.getSelection();
    if (!this.inGrid(sel)) return "";
    return trimRows(sel!.toString());
  }

  hasSelection(): boolean {
    return this.inGrid(document.getSelection());
  }

  clearSelection(): void {
    this.anchor = null;
    this.applied = null;
    this.removedBySelf = false;
    const sel = document.getSelection();
    if (!this.inGrid(sel)) return;
    sel!.removeAllRanges();
  }

  /**
   * Build the range a drag would leave, apply it, copy it and return it.
   * Coordinates are viewport cells and both ends are inclusive, as the
   * ghostty-web controller's are.
   */
  selectViewport(
    startCol: number,
    startRow: number,
    endCol: number,
    endRow: number,
  ): string {
    const rows = this.rowEls().length;
    const cols = this.core.getCols();
    let a = {
      col: clamp(startCol, 0, cols - 1),
      row: clamp(startRow, 0, rows - 1),
    };
    let b = {
      col: clamp(endCol, 0, cols - 1),
      row: clamp(endRow, 0, rows - 1),
    };
    if (b.row < a.row || (b.row === a.row && b.col < a.col)) [a, b] = [b, a];
    this.anchor = {
      startCol: a.col,
      startAbs: this.offset + a.row,
      endCol: b.col,
      endAbs: this.offset + b.row,
    };
    this.apply(a.row, a.col, b.row, b.col);
    const text = this.getSelection();
    if (text) {
      this.lastCopied = text;
      copyToClipboard(text);
    }
    return text;
  }

  /**
   * The page calls this after a paint. The real re-anchoring happens in
   * `afterPaint`, which knows the frame's viewport offset; this repeats it
   * from the host's, so the order the page calls them in does not matter.
   */
  viewportChanged(): void {
    this.reanchor(this.host.viewportOffset());
  }

  // -- what the renderer drives -------------------------------------------

  /**
   * Re-anchor after the DOM has settled.
   *
   * Native selection points at row elements, and `@wterm/dom` reuses those
   * elements across a scroll: the same `div` shows a different row
   * afterwards, so a selection left alone would slide over the text. The
   * selection is therefore held as absolute rows (`viewport.offset + row`,
   * the row space libghostty's own selection uses) and re-applied here.
   *
   * What that costs: rebuilding the range walks the two end rows, so a
   * scroll pays two row walks per paint, and only while something is
   * selected; a selection that scrolls out of the viewport is clamped to
   * its edge and drops entirely once no part of it is on screen, though the
   * anchor is kept so scrolling back restores it. What it does not do is
   * hold a selection over rows that have left the viewport: wterm's own
   * scrollback rows are unused, so there is no DOM for them to anchor to.
   */
  afterPaint(frame: Frame): void {
    const offset = frame.viewport.offset;
    const moved = offset !== this.offset;
    this.offset = offset;
    if (!this.anchor) return;
    // A repaint of a row under the selection replaces its text nodes, so
    // the range is rebuilt then too.
    const top = this.anchor.startAbs - offset;
    const bottom = this.anchor.endAbs - offset;
    const touched = frame.changed.some((r) => r.y >= top && r.y <= bottom);
    if (moved || touched) this.reanchor(offset);
  }

  /** The grid was rebuilt, so every anchor into it is gone. */
  gridReset(): void {
    this.anchor = null;
    this.applied = null;
    this.removedBySelf = false;
  }

  // -- the mapping between cells and DOM points ---------------------------

  private reanchor(offset: number): void {
    const a = this.anchor;
    if (!a) return;
    const rows = this.rowEls().length;
    const top = a.startAbs - offset;
    const bottom = a.endAbs - offset;
    if (bottom < 0 || top >= rows) {
      // Scrolled out of sight: nothing to select, but the anchor stays.
      const sel = document.getSelection();
      if (this.inGrid(sel)) {
        this.applied = null;
        this.removedBySelf = true;
        sel!.removeAllRanges();
      }
      return;
    }
    const startRow = Math.max(0, top);
    const endRow = Math.min(rows - 1, bottom);
    const startCol = top < 0 ? 0 : a.startCol;
    const endCol = bottom >= rows ? this.core.getCols() - 1 : a.endCol;
    this.apply(startRow, startCol, endRow, endCol);
  }

  private apply(
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
  ): void {
    const sel = document.getSelection();
    if (!sel) return;
    const from = this.pointFor(startRow, startCol, "start");
    const to = this.pointFor(endRow, endCol, "end");
    if (!from || !to) return;
    const range = document.createRange();
    try {
      range.setStart(from.node, from.offset);
      range.setEnd(to.node, to.offset);
    } catch {
      // A row rebuilt underneath a stale point; the next paint re-anchors.
      return;
    }
    sel.removeAllRanges();
    sel.addRange(range);
    this.applied = { from, to };
    this.removedBySelf = false;
  }

  /** Read a drag back into cell coordinates, so it too survives a scroll. */
  private readBack(): void {
    const sel = document.getSelection();
    if (!this.inGrid(sel)) {
      // A press elsewhere drops the anchor; a scroll that took the
      // selection off screen does not.
      if (!this.removedBySelf) this.anchor = null;
      return;
    }
    const w = this.applied;
    if (
      w &&
      sel!.anchorNode === w.from.node &&
      sel!.anchorOffset === w.from.offset &&
      sel!.focusNode === w.to.node &&
      sel!.focusOffset === w.to.offset
    )
      return; // this class's own write, arriving a task later
    this.applied = null;
    const a = this.cellAt(sel!.anchorNode!, sel!.anchorOffset);
    const b = this.cellAt(sel!.focusNode!, sel!.focusOffset);
    if (!a || !b) return;
    const [from, to] =
      b.row < a.row || (b.row === a.row && b.col < a.col) ? [b, a] : [a, b];
    // `cellAt` answers with the column a point sits before, so the far end
    // of a selection is one past the column it covers.
    const endCol = Math.max(from.col, to.col - 1);
    this.anchor = {
      startCol: from.col,
      startAbs: this.offset + from.row,
      endCol,
      endAbs: this.offset + to.row,
    };
  }

  private inGrid(sel: Selection | null): boolean {
    return (
      sel !== null &&
      !sel.isCollapsed &&
      sel.rangeCount > 0 &&
      (this.grid.contains(sel.anchorNode) || this.grid.contains(sel.focusNode))
    );
  }

  /**
   * Where the columns of a row sit in its DOM.
   *
   * `_buildRowContent` does not emit one span per cell: it coalesces cells
   * that share a style into one span, splits a run around the cursor, wraps
   * a run of linked cells in an `<a>`, gives a wide cell one span covering
   * two columns, and paints a block-element cell (U+2580–U+259F) as an
   * *empty* span with a background. So the mapping is derived by walking
   * the row's leaves in document order and consuming one column's worth of
   * text at a time, with the shadow row saying how much text each column
   * contributed. The branches below mirror upstream's, including its two
   * edge cases: a stray width-0 cell owns a column, and a wide cell in the
   * last column is drawn as a space.
   */
  private slots(y: number): Slot[] {
    const rowEl = this.rowEls()[y];
    if (!rowEl) return [];
    const cells = this.core.row(y);
    const leaves: Node[] = [];
    const walk = document.createTreeWalker(
      rowEl,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    );
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (n.nodeType === Node.TEXT_NODE) leaves.push(n);
      else if ((n as Element).classList.contains("term-block")) leaves.push(n);
    }
    const out: Slot[] = [];
    let li = 0;
    let pos = 0;
    for (let x = 0; x < cells.length; x++) {
      const c = cells[x]!;
      const w = c.width ?? 1;
      if (w === 0 && x > 0 && (cells[x - 1]!.width ?? 1) === 2) continue;
      const cp = c.char;
      let width = 1;
      let text: string | null;
      if (w === 0) text = " ";
      else if (w === 2 && x + 1 >= cells.length) text = " ";
      else if (w === 2) {
        width = 2;
        text = c.chars ?? (cp >= 32 ? String.fromCodePoint(cp) : " ");
      } else if (cp >= 0x2580 && cp <= 0x259f) text = null;
      else text = c.chars ?? (cp >= 32 ? String.fromCodePoint(cp) : " ");

      if (text === null) {
        // An empty span: its extent is a child range of its parent, and its
        // glyph is a background, so it carries no text to copy.
        while (li < leaves.length && leaves[li]!.nodeType === Node.TEXT_NODE) {
          const t = leaves[li] as Text;
          if (pos < t.length) break;
          li++;
          pos = 0;
        }
        const el = leaves[li];
        if (!el || el.nodeType === Node.TEXT_NODE) break;
        li++;
        pos = 0;
        const parent = el.parentNode;
        if (!parent) break;
        const i = Array.prototype.indexOf.call(parent.childNodes, el);
        out.push({
          col: x,
          width,
          start: { node: parent, offset: i },
          end: { node: parent, offset: i + 1 },
        });
        continue;
      }

      while (li < leaves.length) {
        const n = leaves[li]!;
        if (n.nodeType !== Node.TEXT_NODE) break;
        if (pos < (n as Text).length) break;
        li++;
        pos = 0;
      }
      const t = leaves[li];
      if (!t || t.nodeType !== Node.TEXT_NODE) break;
      const start = { node: t, offset: pos };
      pos = Math.min((t as Text).length, pos + text.length);
      out.push({ col: x, width, start, end: { node: t, offset: pos } });
    }
    return out;
  }

  private pointFor(
    y: number,
    col: number,
    edge: "start" | "end",
  ): Point | null {
    const rowEl = this.rowEls()[y];
    if (!rowEl) return null;
    const slots = this.slots(y);
    const last = slots[slots.length - 1];
    if (!last)
      return {
        node: rowEl,
        offset: edge === "start" ? 0 : rowEl.childNodes.length,
      };
    for (const s of slots) {
      if (col < s.col + s.width) return edge === "start" ? s.start : s.end;
    }
    return last.end;
  }

  /**
   * The inverse, for a drag. It is exact for a point inside a column's own
   * text and approximate for anything else — a point on the row element
   * itself lands at one edge or the other.
   */
  private cellAt(
    node: Node,
    offset: number,
  ): { row: number; col: number } | null {
    const el =
      node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element);
    const rowEl = el?.closest(".term-row") as HTMLElement | null;
    if (!rowEl) return null;
    const row = this.rowEls().indexOf(rowEl);
    if (row < 0) return null;
    if (node === rowEl) {
      return { row, col: offset === 0 ? 0 : this.core.getCols() };
    }
    for (const s of this.slots(row)) {
      if (s.start.node === node) {
        if (offset >= s.end.offset) continue;
        return { row, col: s.col };
      }
      if (s.end.node === node && offset <= s.end.offset) {
        return { row, col: s.col + s.width };
      }
    }
    return { row, col: this.core.getCols() };
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * A DOM row is padded to the full width, so a native selection carries the
 * padding with it. Trailing blanks come off each line, which is what
 * libghostty's own formatter gives the other renderers. Soft-wrapped rows
 * stay separate lines here, because the DOM does not record the wrap.
 */
function trimRows(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n");
}

function copyToClipboard(text: string): void {
  navigator.clipboard?.writeText(text).catch(() => {
    // Not permitted, or no focus. `lastCopied` still records what a copy
    // would have carried, which is what the harness reads.
  });
}

// ============================================================================
// The renderer
// ============================================================================

/** The probe is a run rather than one character, so a fractional advance survives the division. */
const PROBE_CHARS = 32;

class WtermRenderer implements Renderer {
  readonly cell: CellSize;
  readonly stats: PaintStats = newPaintStats();
  readonly surface: HTMLElement;
  readonly selection: RendererSelection;

  private readonly root: HTMLDivElement;
  private readonly grid: HTMLDivElement;
  private readonly dom: WtermDom;
  private readonly core = new ShadowCore();
  private readonly sel: WtermSelection;
  private rowEls: HTMLElement[] = [];

  constructor(private readonly host: RendererHost) {
    injectStyle();
    // A DOM renderer has no use for the page's canvas, and a canvas over
    // the rows would eat the presses a selection needs.
    host.canvas.style.display = "none";
    this.root = document.createElement("div");
    this.root.className = ROOT_CLASS;
    this.root.tabIndex = 0;
    this.grid = document.createElement("div");
    this.grid.className = "term-grid";
    this.root.appendChild(this.grid);
    host.mount.appendChild(this.root);
    this.surface = this.root;
    this.dom = new WtermDom(this.grid);
    this.cell = this.measureCell();
    this.sel = new WtermSelection(
      host,
      this.grid,
      () => this.rowEls,
      this.core,
    );
    this.selection = this.sel;

    // The cursor is only filled in while the terminal has focus, as
    // upstream's stylesheet has it.
    this.root.addEventListener("focus", () =>
      this.root.classList.add("focused"),
    );
    this.root.addEventListener("blur", () =>
      this.root.classList.remove("focused"),
    );
    // Who owns the mouse decides whether the browser may select at all. The
    // class is refreshed on the events that precede a press, because the
    // answer depends on the event's Shift.
    const owner = (e: MouseEvent) =>
      this.root.classList.toggle("program-mouse", !host.selectionEnabled(e));
    this.root.addEventListener("mousemove", owner, true);
    this.root.addEventListener("mousedown", owner, true);
    this.root.addEventListener("selectstart", (e) => {
      if (this.root.classList.contains("program-mouse")) e.preventDefault();
    });
  }

  /**
   * The cell size from a rendered row, because everything the page computes
   * from it — the grid it asks the daemon for, the cell a press lands on —
   * has to agree with what the browser actually laid out.
   */
  private measureCell(): CellSize {
    const row = document.createElement("div");
    row.className = "term-row";
    row.style.visibility = "hidden";
    row.style.position = "absolute";
    const probe = document.createElement("span");
    probe.textContent = "W".repeat(PROBE_CHARS);
    row.appendChild(probe);
    this.grid.appendChild(row);
    const width = probe.getBoundingClientRect().width / PROBE_CHARS;
    const height = row.getBoundingClientRect().height;
    row.remove();
    // A mount with no layout yet measures zero; the stylesheet's own 14px
    // text on 17px rows is the fallback.
    return { width: width > 0 ? width : 8.4, height: height > 0 ? height : 17 };
  }

  resizeTo(cols: number, rows: number): void {
    if (cols === this.core.getCols() && rows === this.core.getRows()) return;
    this.core.reset(cols, rows);
    this.dom.setup(cols, rows);
    this.rowEls = Array.from(
      this.grid.querySelectorAll<HTMLElement>(":scope > .term-row"),
    );
    this.sel.gridReset();
  }

  paint(frame: Frame): void {
    const t0 = performance.now();
    if (
      frame.cols !== this.core.getCols() ||
      frame.rows !== this.core.getRows()
    )
      this.resizeTo(frame.cols, frame.rows);
    for (const row of frame.changed) this.core.setRow(row);
    const cur = frame.cursor;
    const on = cur.visible && cur.inViewport;
    this.core.setCursor(on ? cur.y : -1, on ? cur.x : -1, on);
    // No `RenderViewport`: wterm's virtualised scrollback stays out of it.
    this.dom.render(this.core);
    // Re-anchoring is part of what a paint costs here, so it is inside the
    // measurement rather than after it.
    this.sel.afterPaint(frame);
    recordPaint(this.stats, frame, performance.now() - t0);
  }

  dispose(): void {
    this.sel.dispose();
    this.dom.destroy();
    this.root.remove();
    this.host.canvas.style.display = "";
    this.rowEls = [];
  }
}

export async function createWtermRenderer(
  host: RendererHost,
): Promise<Renderer> {
  return new WtermRenderer(host);
}
