// The renderer seam, and the deliberately minimal renderer behind it.
//
// `Renderer` is what the page paints through, and four things implement it:
// the minimal canvas grid in this file, the renderer rebased from
// ghostty-web, and adapters onto two published renderers, `@wterm/dom` and
// `@beamterm/renderer`. `?renderer=` picks one at load; they are meant to be
// interchangeable so the same session can be measured through each.
//
// The minimal one paints the rows `frame().changed` names, with
// foreground/background colours, bold/italic/underline/inverse/strikethrough,
// wide cells and the cursor. It exists to prove the round trip and to be
// measured. What it does not do is listed in findings/m4.md.

import type {
  Cell,
  Color,
  CursorState,
  Frame,
  Row,
} from "../../engine/types.ts";

export interface CellSize {
  width: number;
  height: number;
}

export interface PaintStats {
  paints: number;
  /** Paints where `dirtyAll` was set. */
  fullPaints: number;
  lastMs: number;
  maxMs: number;
  /** Time of the last paint that repainted every row, and of the last one-row paint, for the findings. */
  lastFullMs: number | null;
  lastPartialMs: number | null;
  lastRowsPainted: number;
}

/**
 * What a renderer is handed at construction. It is deliberately wider than
 * the minimal renderer needs, because the two published renderers bring
 * their own selection and want the things a selection asks the page for.
 */
export interface RendererHost {
  /** The bounded terminal area (`#wrap`). A renderer may append its own elements to it. */
  readonly mount: HTMLElement;
  /** The canvas the page ships with. Canvas-backed renderers draw into it; DOM ones hide it. */
  readonly canvas: HTMLCanvasElement;
  /** Ask the replica to deliver another frame. */
  requestPaint(): void;
  /** Rows above the viewport's first row, from the latest frame. */
  viewportOffset(): number;
  cols(): number;
  rows(): number;
  /** The text between two points in screen row space, inclusive; null when nothing is selected. */
  textBetween(
    start: { x: number; y: number },
    end: { x: number; y: number },
  ): string | null;
  scrollLines(amount: number): void;
  /** Whether a press should start a selection now (false while the program tracks the mouse and Shift is not held). */
  selectionEnabled(e: MouseEvent): boolean;
}

/**
 * The selection surface the page exposes on `window.__wp`, so the browser
 * automation reads the same shape whichever renderer is mounted. The
 * ghostty-web `SelectionController` satisfies it structurally; the two
 * published renderers each supply their own.
 */
export interface RendererSelection {
  /** The selected text, or "" when nothing is selected. */
  getSelection(): string;
  hasSelection(): boolean;
  clearSelection(): void;
  /** Select a viewport-relative range as a drag would, copy it, and return its text. */
  selectViewport(
    startCol: number,
    startRow: number,
    endCol: number,
    endRow: number,
  ): string;
  /** The page calls this after every paint, so a selection follows a scroll. */
  viewportChanged(): void;
  /** The last text copied, for a harness that cannot read the clipboard. */
  readonly lastCopied: string | null;
}

export interface Renderer {
  readonly cell: CellSize;
  paint(frame: Frame): void;
  resizeTo(cols: number, rows: number): void;
  dispose(): void;
  readonly stats: PaintStats;
  /**
   * The element that takes focus, keys and mouse events. The page falls back
   * to the canvas when a renderer does not name one.
   */
  readonly surface?: HTMLElement;
  /** Non-null when the renderer brings its own selection rather than the page wiring one. */
  readonly selection?: RendererSelection | null;
}

/** How the page constructs one. Async because a renderer may fetch a WASM module first. */
export type RendererFactory = (host: RendererHost) => Promise<Renderer>;

/** A fresh, zeroed `PaintStats`, so every renderer reports the same shape. */
export function newPaintStats(): PaintStats {
  return {
    paints: 0,
    fullPaints: 0,
    lastMs: 0,
    maxMs: 0,
    lastFullMs: null,
    lastPartialMs: null,
    lastRowsPainted: 0,
  };
}

/** Fold one paint's cost into `stats`, the way every renderer reports it. */
export function recordPaint(stats: PaintStats, frame: Frame, ms: number): void {
  stats.paints++;
  stats.lastMs = ms;
  stats.lastRowsPainted = frame.changed.length;
  if (ms > stats.maxMs) stats.maxMs = ms;
  if (frame.dirtyAll) {
    stats.fullPaints++;
    stats.lastFullMs = ms;
  } else if (frame.changed.length === 1) stats.lastPartialMs = ms;
}

/** The palette and colour resolution the renderers share. */
export { palette, css as cssColor, DEFAULT_FG, DEFAULT_BG };

/** xterm's default 16, then the 6×6×6 cube and the grey ramp, computed on demand. */
const ANSI = [
  "#000000",
  "#cd3131",
  "#0dbc79",
  "#e5e510",
  "#2472c8",
  "#bc3fbc",
  "#11a8cd",
  "#e5e5e5",
  "#666666",
  "#f14c4c",
  "#23d18b",
  "#f5f543",
  "#3b8eea",
  "#d670d6",
  "#29b8db",
  "#ffffff",
];
const DEFAULT_FG = "#d4d4d4";
const DEFAULT_BG = "#1e1e1e";

const paletteCache = new Map<number, string>();
function palette(i: number): string {
  if (i < 16) return ANSI[i]!;
  let s = paletteCache.get(i);
  if (s) return s;
  if (i < 232) {
    const n = i - 16;
    const r = Math.floor(n / 36);
    const g = Math.floor((n % 36) / 6);
    const b = n % 6;
    const v = (x: number) => (x === 0 ? 0 : 55 + x * 40);
    s = `rgb(${v(r)},${v(g)},${v(b)})`;
  } else {
    const v = 8 + (i - 232) * 10;
    s = `rgb(${v},${v},${v})`;
  }
  paletteCache.set(i, s);
  return s;
}

function css(c: Color, fallback: string): string {
  switch (c.kind) {
    case "default":
      return fallback;
    case "palette":
      return palette(c.index);
    case "rgb":
      return `rgb(${c.r},${c.g},${c.b})`;
  }
}

export class CanvasRenderer implements Renderer {
  readonly cell: CellSize;
  readonly stats: PaintStats = {
    paints: 0,
    fullPaints: 0,
    lastMs: 0,
    maxMs: 0,
    lastFullMs: null,
    lastPartialMs: null,
    lastRowsPainted: 0,
  };
  private readonly ctx: CanvasRenderingContext2D;
  private cols = 0;
  private rows = 0;
  /** The last painted cells per row, so the cursor's old row can be repainted. */
  private shadow: Row[] = [];
  private lastCursor: CursorState | null = null;
  private readonly dpr: number;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    readonly font = "14px monospace",
  ) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    this.ctx = ctx;
    this.dpr = globalThis.devicePixelRatio || 1;
    ctx.font = font;
    const m = ctx.measureText("W");
    const size = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 14);
    this.cell = {
      width: Math.ceil(m.width),
      height: Math.ceil(size * 1.25),
    };
  }

  resizeTo(cols: number, rows: number): void {
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    const w = cols * this.cell.width;
    const h = rows * this.cell.height;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.ctx.fillStyle = DEFAULT_BG;
    this.ctx.fillRect(0, 0, w, h);
    this.shadow = [];
    this.lastCursor = null;
  }

  paint(frame: Frame): void {
    const t0 = performance.now();
    if (frame.cols !== this.cols || frame.rows !== this.rows)
      this.resizeTo(frame.cols, frame.rows);
    for (const row of frame.changed) {
      this.shadow[row.y] = row;
      this.paintRow(row);
    }
    // The cursor is drawn over its row, so the row it left is repainted
    // from the shadow unless this frame already repainted it.
    const changedYs = new Set(frame.changed.map((r) => r.y));
    const old = this.lastCursor;
    if (old && old.inViewport && old.visible && !changedYs.has(old.y)) {
      const r = this.shadow[old.y];
      if (r) this.paintRow(r);
    }
    this.drawCursor(frame.cursor);
    this.lastCursor = frame.cursor;
    const ms = performance.now() - t0;
    const s = this.stats;
    s.paints++;
    s.lastMs = ms;
    s.lastRowsPainted = frame.changed.length;
    if (ms > s.maxMs) s.maxMs = ms;
    if (frame.dirtyAll) {
      s.fullPaints++;
      s.lastFullMs = ms;
    } else if (frame.changed.length === 1) s.lastPartialMs = ms;
  }

  private paintRow(row: Row): void {
    const ctx = this.ctx;
    const { width: cw, height: ch } = this.cell;
    const y = row.y * ch;
    ctx.fillStyle = DEFAULT_BG;
    ctx.fillRect(0, y, this.cols * cw, ch);
    ctx.textBaseline = "middle";
    for (let x = 0; x < row.cells.length; x++) {
      const c = row.cells[x]!;
      if (c.width === 0) continue; // spacer after a wide cell
      const span = c.width === 2 ? 2 : 1;
      let fg = css(c.fg, DEFAULT_FG);
      let bg = css(c.bg, DEFAULT_BG);
      if (c.inverse) [fg, bg] = [bg, fg];
      if (bg !== DEFAULT_BG) {
        ctx.fillStyle = bg;
        ctx.fillRect(x * cw, y, span * cw, ch);
      }
      if (c.text) {
        ctx.fillStyle = fg;
        ctx.font = fontFor(this.font, c);
        ctx.fillText(c.text, x * cw, y + ch / 2, span * cw);
      }
      if (c.underline) {
        ctx.fillStyle = fg;
        ctx.fillRect(x * cw, y + ch - 2, span * cw, 1);
      }
      if (c.strikethrough) {
        ctx.fillStyle = fg;
        ctx.fillRect(x * cw, y + Math.floor(ch / 2), span * cw, 1);
      }
    }
  }

  private drawCursor(cur: CursorState): void {
    if (!cur.visible || !cur.inViewport) return;
    const ctx = this.ctx;
    const { width: cw, height: ch } = this.cell;
    const x = cur.x * cw;
    const y = cur.y * ch;
    const cell = this.shadow[cur.y]?.cells[cur.x];
    const span = cell?.width === 2 ? 2 : 1;
    switch (cur.style) {
      case "bar":
        ctx.fillStyle = DEFAULT_FG;
        ctx.fillRect(x, y, 2, ch);
        return;
      case "underline":
        ctx.fillStyle = DEFAULT_FG;
        ctx.fillRect(x, y + ch - 2, span * cw, 2);
        return;
      case "block-hollow":
        ctx.strokeStyle = DEFAULT_FG;
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, span * cw - 1, ch - 1);
        return;
      default: {
        // A block: the cell's colours swapped.
        const fg = cell ? css(cell.fg, DEFAULT_FG) : DEFAULT_FG;
        ctx.fillStyle = fg;
        ctx.fillRect(x, y, span * cw, ch);
        if (cell?.text) {
          ctx.fillStyle = cell ? css(cell.bg, DEFAULT_BG) : DEFAULT_BG;
          ctx.font = fontFor(this.font, cell);
          ctx.textBaseline = "middle";
          ctx.fillText(cell.text, x, y + ch / 2, span * cw);
        }
      }
    }
  }

  dispose(): void {
    this.shadow = [];
  }
}

function fontFor(base: string, c: Cell): string {
  const style = c.italic ? "italic " : "";
  const weight = c.bold ? "bold " : "";
  return style + weight + base;
}
