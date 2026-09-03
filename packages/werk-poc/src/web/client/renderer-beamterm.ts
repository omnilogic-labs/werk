// Adapter onto `@beamterm/renderer`, a WebGL2 terminal renderer compiled
// from Rust to WebAssembly. It is a renderer and not an emulator: it owns a
// font atlas, a cell buffer and a draw call, and everything else — parsing,
// grapheme segmentation, the cursor, the scrollback — belongs to whoever
// feeds it. That suits this seam, because libghostty has already done all
// of it by the time a `Frame` arrives.
//
// The payload is the thing to weigh, and the dynamic atlas sharpens it.
// beamterm costs 1.4 MB of WebAssembly and, of the 88 KB of JavaScript it
// ships, about 76 KB after bundling, on top of
// the 739 KB libghostty artifact the page already fetches. A large part of
// that WebAssembly is the embedded static font atlas — 4084 glyph slots,
// which is 1021 characters in four style variants — and this module asks
// for a dynamic atlas instead, so that whole embedded atlas is carried and
// never sampled. The Unicode work behind it goes similarly unused, because
// the cells arrive already segmented into graphemes with their widths
// attached. Whether a GPU renderer earns that is not something this adapter
// settles. It exists so the same session can be measured through it.
//
// The reason for the dynamic atlas is coverage. The embedded static atlas
// holds ASCII, Latin-1, Latin Extended, box drawing, block elements,
// braille, geometric shapes and dingbats, and holds no CJK ideograph, no
// kana and no hangul at all: its symbol table sits in the module as
// length-prefixed UTF-8 and `日`, `本`, `語`, `中`, `あ`, `ア` and `한` are
// absent from all 1.39 MB of it, along with U+2192 and U+2605. A dynamic
// atlas rasterises glyphs on demand through the browser's canvas instead,
// so coverage becomes whatever the browser's `monospace` face covers, and
// the cell box comes from the 14 px this module asks for rather than from
// whatever size the atlas was baked at. Two things follow that are worth
// watching in a measurement: the first paint to show a glyph pays for
// rasterising it and uploading it, so a paint that scrolls new script into
// view costs more than a paint that does not; and the atlas has a finite
// number of slots, so a session that shows enough distinct glyphs would
// presumably start evicting or failing, and where that limit sits is not
// something the package documents.
//
// What the shipped package was read for, rather than assumed:
//
//   - Colours are 24-bit `0xRRGGBB` (README, "Color Format"), with no alpha
//     channel, and a `Cell` gives them back unchanged:
//     `cell("A", style().fg(0x123456)).fg` is 0x123456.
//   - The style bits sit above a packed glyph index: bold 0x400, italic
//     0x800, underline 0x2000, strikethrough 0x4000, read out of
//     `style().bold().bits` and agreeing with the fragment shader embedded
//     in the module, which tests `(glyph_index >> 13) & 1` for the
//     underline and `>> 14` for the strikethrough. Bit 0x1000 is the static
//     atlas's emoji flag, which the shader takes as a uniform and moves to
//     bit 15 for a dynamic atlas. `style()` is a module-level function with
//     no renderer and no atlas in scope, so the bits it hands out cannot
//     vary with the atlas and the renderer is left to translate them;
//     `STYLE_BITS` asks the builder for each of the sixteen combinations so
//     that the numbers come from the shipped code rather than from a
//     reading of the shader.
//   - `Cell` has plain setters for `symbol`, `fg`, `bg` and `style` that
//     mutate in place, and `Batch.cell` borrows the cell rather than
//     consuming it, so one `Cell` serves the whole session.
//   - `Batch.text` is the width-aware entry point — the CHANGELOG has it
//     handling zero-width characters, and the package extracts a
//     `beamterm-unicode` crate for "shared emoji/width utils" — so a wide
//     grapheme goes through `text` and lets beamterm place whatever the
//     spacer column needs, rather than this module guessing whether a
//     double-width glyph is drawn as two atlas halves or as one expanded
//     quad. It costs a `CellStyle` per wide cell, which is why the narrow
//     cells do not go that way.
//
// wasm-bindgen objects are not collected on any schedule worth trusting, so
// everything this module takes ownership of is freed by hand: the per-paint
// `Batch` in a `finally`, the `Size`/`TerminalSize` read after a resize, the
// `ModifierKeys` a selection is armed with, the `CellQuery` a selection is
// read through, and the `MouseEvent` handed to the mouse handler. The
// `CellStyle` builder consumes its receiver at every link of the chain, so
// only the last of a chain is freed. The one long-lived object is `scratch`,
// mutated per cell, which keeps a paint free of WASM allocation apart from
// the string each `symbol` write copies in.
//
// `TerminalDebugApi` would report the atlas's glyph count and the glyphs a
// session asked for and did not get, which is exactly what a coverage
// question wants. It is compiled into the module and logs "Terminal
// debugging API exposed at window.__beamterm_debug", but nothing in the
// shipped `.d.ts` reaches it and that log does not appear in a run, so it
// looks to be behind a build feature this package does not ship.

import init, {
  BeamtermRenderer,
  Cell as BtCell,
  CellQuery,
  ModifierKeys,
  MouseEventType,
  SelectionMode,
  cell as btCell,
  style as btStyle,
  type Batch,
  type MouseEvent as BtMouseEvent,
} from "@beamterm/renderer/web";
import type {
  Cell,
  Color,
  CursorState,
  Frame,
  Row,
} from "../../engine/types.ts";
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

/** The route the page fetches beamterm's WebAssembly from. */
export const BEAMTERM_WASM_URL = "/beamterm.wasm";

/**
 * One initialisation per page, however many times the factory is called.
 * The module is fetched from the route rather than imported, because the
 * bundler entry point imports the `.wasm` file itself and would fold 1.4 MB
 * into `app.js`. `__wbg_init` takes the `Promise<Response>` straight to
 * `WebAssembly.instantiateStreaming`, so nothing buffers the module first;
 * the object form of the argument is the one that does not warn. The start
 * function the module carries is `main()`, which `__wbg_init` runs, so
 * calling `main()` here would only log the module's banner twice.
 */
let wasmReady: Promise<void> | null = null;
function ready(): Promise<void> {
  wasmReady ??= init({ module_or_path: fetch(BEAMTERM_WASM_URL) }).then(
    buildStyleBits,
  );
  return wasmReady;
}

export async function createBeamtermRenderer(
  host: RendererHost,
): Promise<Renderer> {
  await ready();
  return new BeamtermAdapter(host);
}

// -- colours ----------------------------------------------------------------

/** `#rrggbb` and `rgb(r,g,b)`, the two shapes the shared palette produces. */
function parseCss(s: string): number {
  if (s.startsWith("#")) return parseInt(s.slice(1), 16);
  const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(s);
  if (!m) return 0;
  return (Number(m[1]) << 16) | (Number(m[2]) << 8) | Number(m[3]);
}

const FG = parseCss(DEFAULT_FG);
const BG = parseCss(DEFAULT_BG);

// The shared palette is the source of truth for the 256 ANSI colours, but it
// speaks CSS; each index is parsed the first time it is asked for.
const paletteRgb = new Map<number, number>();
function paletteNum(i: number): number {
  let n = paletteRgb.get(i);
  if (n === undefined) {
    n = parseCss(palette(i));
    paletteRgb.set(i, n);
  }
  return n;
}

function colourOf(c: Color, fallback: number): number {
  switch (c.kind) {
    case "default":
      return fallback;
    case "palette":
      return paletteNum(c.index);
    case "rgb":
      return (c.r << 16) | (c.g << 8) | c.b;
  }
}

// -- style bits -------------------------------------------------------------

const BOLD = 1;
const ITALIC = 2;
const UNDERLINE = 4;
const STRIKE = 8;

/**
 * The sixteen attribute combinations, asked of beamterm's own builder once
 * the module is up. Every link of the builder chain consumes its receiver,
 * so only the last of each chain is freed.
 */
let STYLE_BITS: number[] = [];
function buildStyleBits(): void {
  const bits: number[] = [];
  for (let m = 0; m < 16; m++) {
    let s = btStyle();
    if (m & BOLD) s = s.bold();
    if (m & ITALIC) s = s.italic();
    if (m & UNDERLINE) s = s.underline();
    if (m & STRIKE) s = s.strikethrough();
    bits.push(s.bits);
    s.free();
  }
  STYLE_BITS = bits;
}

function maskOf(c: Cell): number {
  return (
    (c.bold ? BOLD : 0) |
    (c.italic ? ITALIC : 0) |
    (c.underline ? UNDERLINE : 0) |
    (c.strikethrough ? STRIKE : 0)
  );
}

/** Halfway between two packed colours, for the cursor shapes a cell cannot draw. */
function mix(a: number, b: number): number {
  const r = (((a >> 16) & 255) + ((b >> 16) & 255)) >> 1;
  const g = (((a >> 8) & 255) + ((b >> 8) & 255)) >> 1;
  const bl = ((a & 255) + (b & 255)) >> 1;
  return (r << 16) | (g << 8) | bl;
}

// -- the renderer -----------------------------------------------------------

/**
 * The face and size the dynamic atlas rasterises at, matching the
 * `14px monospace` the minimal renderer measures its cell from. beamterm
 * derives its own cell box from the face's metrics, so the two agree in
 * intent rather than to the pixel.
 */
const FONT = ["monospace"];
const FONT_PX = 14;

const EMPTY: Cell = {
  text: " ",
  fg: { kind: "default" },
  bg: { kind: "default" },
  bold: false,
  italic: false,
  underline: false,
  inverse: false,
  strikethrough: false,
  width: 1,
};

class BeamtermAdapter implements Renderer {
  readonly cell: CellSize = { width: 8, height: 16 };
  readonly stats: PaintStats = newPaintStats();
  readonly selection: RendererSelection;
  private readonly bt: BeamtermRenderer;
  private readonly canvas: HTMLCanvasElement;
  /** Mutated per cell and handed to `Batch.cell`, which borrows it. */
  private readonly scratch: BtCell;
  private cols = 0;
  private rows = 0;
  /** beamterm's own idea of the grid, which is what a write is clamped to. */
  private btCols = 0;
  private btRows = 0;
  /** The rows as last written, so the cursor's old cell can be restored. */
  private shadow: Row[] = [];
  private lastCursor: CursorState | null = null;
  /**
   * Set when beamterm derives a different grid from the pixel box a
   * `resizeTo` asked for. Nothing on the page reads it yet; it is here
   * because a disagreement means the page and the renderer hold different
   * ideas of how many columns exist.
   */
  gridMismatch: string | null = null;

  constructor(host: RendererHost) {
    this.canvas = host.canvas;
    // A dynamic atlas at the same 14 px monospace the other renderers use,
    // so the four of them derive comparable grids from one window and so
    // the coverage is the browser's rather than the embedded atlas's. The
    // `false` keeps the CSS size of the canvas in this module's hands, so
    // it is set the same way the other renderers set theirs — exactly
    // cols × rows cells inside `#wrap` — rather than from whatever pixel
    // box beamterm was last told.
    this.bt = BeamtermRenderer.withDynamicAtlas("#term", FONT, FONT_PX, false);
    this.scratch = btCell(" ", btStyle());
    this.calibrate(host.mount);
    this.selection = new BeamtermSelection(this.bt, host);
  }

  /**
   * `Renderer.cell` is read by the page in CSS pixels, and beamterm scales
   * for the device pixel ratio itself, so which unit `cellSize()` reports in
   * decides whether the grid comes out right on a HiDPI display. Rather than
   * assume, the canvas is sized once and beamterm asked how many columns it
   * made of it: if the cell size multiplies up to the CSS box it is in CSS
   * pixels, and if it multiplies up to the device box it is in device
   * pixels. The two are the same measurement at a ratio of 1.
   */
  private calibrate(mount: HTMLElement): void {
    const r = mount.getBoundingClientRect();
    const w = Math.max(200, Math.round(r.width));
    const h = Math.max(100, Math.round(r.height));
    this.bt.resize(w, h);
    const size = this.bt.cellSize();
    const grid = this.bt.terminalSize();
    const cw = size.width;
    const ch = size.height;
    const cols = grid.cols;
    this.btCols = cols;
    this.btRows = grid.rows;
    size.free();
    grid.free();
    const dpr = globalThis.devicePixelRatio || 1;
    const scale =
      cols > 0 && Math.abs(cw * cols - w * dpr) < Math.abs(cw * cols - w)
        ? dpr
        : 1;
    this.cell.width = cw / scale;
    this.cell.height = ch / scale;
  }

  resizeTo(cols: number, rows: number): void {
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    this.shadow = [];
    this.lastCursor = null;
    const w = Math.round(cols * this.cell.width);
    const h = Math.round(rows * this.cell.height);
    // beamterm resizes in pixels and derives the grid itself, so the page's
    // grid is turned back into the box that produces it.
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.bt.resize(w, h);
    const grid = this.bt.terminalSize();
    this.btCols = grid.cols;
    this.btRows = grid.rows;
    grid.free();
    if (this.btCols !== cols || this.btRows !== rows) {
      this.gridMismatch = `asked ${cols}×${rows}, beamterm made ${this.btCols}×${this.btRows} of ${w}×${h} px`;
      console.warn(`beamterm grid: ${this.gridMismatch}`);
    }
    const b = this.bt.batch();
    try {
      b.clear(BG);
    } finally {
      b.free();
    }
  }

  paint(frame: Frame): void {
    const t0 = performance.now();
    if (frame.cols !== this.cols || frame.rows !== this.rows)
      this.resizeTo(frame.cols, frame.rows);
    const b = this.bt.batch();
    try {
      const changed = new Set<number>();
      for (const row of frame.changed) {
        this.shadow[row.y] = row;
        changed.add(row.y);
        this.writeRow(b, row);
      }
      // The cursor is written over its cell, so the cell it left is put back
      // from the shadow unless this frame rewrote that row anyway.
      const old = this.lastCursor;
      if (old && old.visible && old.inViewport && !changed.has(old.y))
        this.restore(b, old.x, old.y);
      this.drawCursor(b, frame.cursor);
      this.lastCursor = frame.cursor;
      this.bt.render();
    } finally {
      b.free();
    }
    recordPaint(this.stats, frame, performance.now() - t0);
  }

  /**
   * One row into the batch. A narrow cell is written through the same
   * `Cell`, mutated in place; a wide one goes through `Batch.text`, which
   * is the entry point that knows about widths, so beamterm places the
   * spacer column itself. `Batch.text` would also take a run of uniformly
   * styled narrow cells in one call, but it wants a `CellStyle` object per
   * run and the builder allocates a fresh WASM object at every link of its
   * chain, so a run has to be long before that beats mutating one `Cell`.
   * Whether it does is untested.
   */
  private writeRow(b: Batch, row: Row): void {
    const n = Math.min(this.cols, this.btCols);
    let x = 0;
    while (x < n) x += this.writeCell(b, row.y, row.cells, x, n);
  }

  /** Write the cell at `x`, and return the columns it took. */
  private writeCell(
    b: Batch,
    y: number,
    cells: Cell[],
    x: number,
    n: number,
  ): number {
    const c = cells[x] ?? EMPTY;
    let fg = colourOf(c.fg, FG);
    let bg = colourOf(c.bg, BG);
    if (c.inverse) [fg, bg] = [bg, fg];
    // A wide grapheme needs both its columns, so one at the last column of
    // the grid is written as a narrow cell rather than off the end. The
    // spacer is blanked before the grapheme goes in, so the column is never
    // left holding what was there before; where beamterm writes the spacer
    // itself, that write reaches the same index afterwards and wins.
    if (c.width === 2 && c.text && x + 1 < n) {
      this.put(b, x + 1, y, " ", bg, bg, 0);
      this.putWide(b, x, y, c.text, fg, bg, maskOf(c));
      return 2;
    }
    // A spacer reached on its own — the lead is off the left edge of the
    // grid, or the row does not have one — is a blank in its own colours,
    // so that nothing stale is left in the column.
    const bits = c.width === 0 ? 0 : STYLE_BITS[maskOf(c)]!;
    this.put(b, x, y, c.text || " ", fg, bg, bits);
    return 1;
  }

  /**
   * Put the cell the cursor sat on back as the shadow has it. A spacer is
   * restored by rewriting the wide cell it belongs to, since only that
   * write puts the spacer column back the way beamterm wants it.
   */
  private restore(b: Batch, x: number, y: number): void {
    const row = this.shadow[y];
    if (!row) return;
    const n = Math.min(this.cols, this.btCols);
    let at = x;
    if (row.cells[at]?.width === 0 && at > 0 && row.cells[at - 1]?.width === 2)
      at--;
    if (at < n) this.writeCell(b, y, row.cells, at, n);
  }

  /**
   * beamterm has no cursor of its own, so the cursor is the cell underneath
   * written again in the cursor's colours. A block inverts that cell, which
   * is exactly what the minimal renderer draws. The other three shapes are
   * sub-cell and cannot be drawn in a cell grid at all, so each takes the
   * nearest thing available: a bar becomes the left one-eighth block glyph,
   * which hides the character it sits on; a hollow block becomes a block
   * dimmed halfway towards the cursor colour, which reads as the unfocused
   * cursor it is without the outline; an underline is the cell with the
   * underline attribute set, which is a line in the cell's own foreground
   * rather than the cursor's.
   */
  private drawCursor(b: Batch, cur: CursorState): void {
    if (!cur.visible || !cur.inViewport) return;
    const n = Math.min(this.cols, this.btCols);
    if (cur.x >= n || cur.y >= this.btRows) return;
    const row = this.shadow[cur.y];
    const under = row?.cells[cur.x] ?? EMPTY;
    let fg = colourOf(under.fg, FG);
    let bg = colourOf(under.bg, BG);
    if (under.inverse) [fg, bg] = [bg, fg];
    let text = under.text || " ";
    let mask = maskOf(under);
    switch (cur.style) {
      case "bar":
        // The bar hides the character, so the cell is narrow whatever sits
        // under it, and a wide cell's spacer is blanked with it.
        this.put(b, cur.x, cur.y, "▏", FG, bg, 0);
        if (under.width === 2 && cur.x + 1 < n)
          this.put(b, cur.x + 1, cur.y, " ", bg, bg, 0);
        return;
      case "underline":
        mask |= UNDERLINE;
        break;
      case "block-hollow":
        bg = mix(bg, FG);
        break;
      default:
        [fg, bg] = [bg, fg];
    }
    if (under.width === 2 && under.text && cur.x + 1 < n) {
      this.put(b, cur.x + 1, cur.y, " ", bg, bg, 0);
      this.putWide(b, cur.x, cur.y, text, fg, bg, mask);
      return;
    }
    if (under.width === 0) text = " ";
    this.put(b, cur.x, cur.y, text, fg, bg, STYLE_BITS[mask]!);
  }

  /**
   * A wide grapheme, through the width-aware call. The builder consumes its
   * receiver at each link, so only the style handed to `text` is freed.
   */
  private putWide(
    b: Batch,
    x: number,
    y: number,
    text: string,
    fg: number,
    bg: number,
    mask: number,
  ): void {
    let st = btStyle().fg(fg).bg(bg);
    if (mask & BOLD) st = st.bold();
    if (mask & ITALIC) st = st.italic();
    if (mask & UNDERLINE) st = st.underline();
    if (mask & STRIKE) st = st.strikethrough();
    try {
      b.text(x, y, text, st);
    } finally {
      st.free();
    }
  }

  private put(
    b: Batch,
    x: number,
    y: number,
    symbol: string,
    fg: number,
    bg: number,
    bits: number,
  ): void {
    const c = this.scratch;
    c.symbol = symbol;
    c.fg = fg;
    c.bg = bg;
    c.style = bits;
    b.cell(x, y, c);
  }

  /**
   * beamterm's link hit-testing, which nothing on the page calls yet: the
   * seam has no place for it. It is exposed because it is one of the
   * reasons to be interested in this renderer.
   */
  urlAt(col: number, row: number): string | null {
    const m = this.bt.findUrlAt(col, row);
    if (!m) return null;
    try {
      return m.url;
    } finally {
      m.free();
    }
  }

  dispose(): void {
    this.shadow = [];
    this.lastCursor = null;
    this.scratch.free();
    this.bt.free();
  }
}

// -- selection --------------------------------------------------------------

/**
 * beamterm's own selection, which is where most of the interest in this
 * renderer lies: it tracks the drag, highlights it, trims the trailing
 * whitespace and copies it, and it hit-tests URLs.
 *
 * Two things it does not do have to be worked around here.
 *
 * The first is that the modifier a selection requires is fixed when
 * selection is enabled, and werk's rule is not fixed: the program gets the
 * mouse when it has asked for it unless Shift is held, and whether it has
 * asked changes as programs start and stop. `host.selectionEnabled` is the
 * page's version of that rule and it answers per event, so the rule is
 * re-armed whenever the page's answer changes, probed with a synthetic
 * unmodified press. Whether `enableSelectionWithOptions` detaches the
 * listeners of a previous call is not something the shipped package says.
 *
 * The second is that there is no way to read the current selection back as
 * a `CellQuery`, and no way to set one: `hasSelection()` says whether there
 * is one and `getText(query)` reads whatever region it is handed. So the
 * range is tracked here from the mouse handler, anchored in absolute rows
 * so it survives a scroll, and a `selectViewport` records a range that
 * beamterm itself knows nothing about — the text comes out and is copied,
 * but no highlight appears for it.
 */
class BeamtermSelection implements RendererSelection {
  lastCopied: string | null = null;
  /** Inclusive, in absolute rows: viewport row plus the offset it was taken at. */
  private range: { x0: number; y0: number; x1: number; y1: number } | null =
    null;
  private anchor: { x: number; y: number } | null = null;
  private head: { x: number; y: number } | null = null;
  private needsShift: boolean | null = null;
  private lastOffset: number;
  /** The unmodified press the page's rule is probed with, made once. */
  private readonly probe = new MouseEvent("mousedown");

  constructor(
    private readonly bt: BeamtermRenderer,
    private readonly host: RendererHost,
  ) {
    this.lastOffset = host.viewportOffset();
    this.arm();
    this.bt.setMouseHandler((e: BtMouseEvent) => this.onMouse(e));
  }

  private arm(): void {
    // The page's rule reads the terminal's mouse mode, and the terminal is
    // not up yet when the renderer is constructed; until it answers,
    // selection is armed without a modifier and the first frame re-arms it.
    let shift = false;
    try {
      shift = !this.host.selectionEnabled(this.probe);
    } catch {
      shift = false;
    }
    if (shift === this.needsShift) return;
    this.needsShift = shift;
    const mods = shift ? ModifierKeys.SHIFT : ModifierKeys.NONE;
    try {
      this.bt.enableSelectionWithOptions(SelectionMode.Linear, true, mods);
    } finally {
      mods.free();
    }
  }

  /** Watch the drag beamterm is running, because it does not report the range. */
  private onMouse(e: BtMouseEvent): void {
    try {
      const at = { x: e.col, y: e.row };
      switch (e.event_type) {
        case MouseEventType.MouseDown:
          this.anchor = at;
          this.head = at;
          this.range = null;
          return;
        case MouseEventType.MouseMove:
          if (this.anchor) this.head = at;
          return;
        case MouseEventType.MouseUp: {
          if (this.anchor) this.head = at;
          const a = this.anchor;
          const b = this.head;
          this.anchor = null;
          if (a && b && this.bt.hasSelection()) {
            const off = this.host.viewportOffset();
            const flip = b.y < a.y || (b.y === a.y && b.x < a.x);
            const s = flip ? b : a;
            const t = flip ? a : b;
            this.range = {
              x0: s.x,
              y0: s.y + off,
              x1: t.x,
              y1: t.y + off,
            };
            this.lastCopied = this.textOf(this.range);
          }
          return;
        }
        default:
          return;
      }
    } finally {
      e.free();
    }
  }

  /** The range's text, with its rows brought back into the viewport. */
  private textOf(r: {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  }): string {
    const off = this.host.viewportOffset();
    const rows = this.host.rows();
    const y0 = r.y0 - off;
    const y1 = r.y1 - off;
    if (y1 < 0 || y0 >= rows) return "";
    const q = new CellQuery(SelectionMode.Linear)
      .start(y0 < 0 ? 0 : r.x0, Math.max(0, y0))
      .end(y1 >= rows ? this.host.cols() - 1 : r.x1, Math.min(rows - 1, y1))
      .trimTrailingWhitespace(true);
    try {
      return this.bt.getText(q);
    } finally {
      q.free();
    }
  }

  getSelection(): string {
    return this.range ? this.textOf(this.range) : "";
  }

  hasSelection(): boolean {
    return this.range !== null || this.bt.hasSelection();
  }

  clearSelection(): void {
    this.range = null;
    this.anchor = null;
    this.head = null;
    this.bt.clearSelection();
  }

  selectViewport(
    startCol: number,
    startRow: number,
    endCol: number,
    endRow: number,
  ): string {
    const off = this.host.viewportOffset();
    this.range = {
      x0: startCol,
      y0: startRow + off,
      x1: endCol,
      y1: endRow + off,
    };
    const text = this.textOf(this.range);
    this.bt.copyToClipboard(text);
    this.lastCopied = text;
    return text;
  }

  /**
   * Called every frame. The tracked range is anchored in absolute rows and
   * follows the scroll on its own, but beamterm holds its highlight in cell
   * coordinates and exposes no way to move it, so a scroll would leave the
   * highlight sitting over rows it no longer belongs to: it is cleared
   * instead. This is also where the modifier rule is re-armed, since the
   * page's answer changes with the terminal's mouse mode.
   */
  viewportChanged(): void {
    const off = this.host.viewportOffset();
    if (off !== this.lastOffset) {
      this.lastOffset = off;
      if (this.bt.hasSelection()) this.bt.clearSelection();
    }
    this.arm();
  }
}
