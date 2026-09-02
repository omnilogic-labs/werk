// ghostty-web's canvas renderer, rebased onto the seam's `Frame`.
//
// Ported from coder/ghostty-web `lib/renderer.ts` at commit 1858a5947767
// (vendor/README.md has the clone), which is MIT-licensed:
//
//   MIT License. Copyright (c) 2025 Coder.
//   Permission is hereby granted, free of charge, to any person obtaining a
//   copy of this software and associated documentation files (the
//   "Software"), to deal in the Software without restriction, including
//   without limitation the rights to use, copy, modify, merge, publish,
//   distribute, sublicense, and/or sell copies of the Software, and to
//   permit persons to whom the Software is furnished to do so, subject to
//   the following conditions: The above copyright notice and this
//   permission notice shall be included in all copies or substantial
//   portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT
//   WARRANTY OF ANY KIND.
//
// What survives from upstream is marked "(ghostty-web)" on the method; what
// was re-targeted or dropped is noted where it happened, and the tally is
// in findings/m4.md. The emulator seam upstream's renderer draws through is
// `IRenderable` (getLine / getCursor / getDimensions / isRowDirty /
// needsFullRedraw / clearDirty / getGraphemeString) plus an
// `IScrollbackProvider` (getScrollbackLine / getScrollbackLength), with the
// viewport offset kept in JavaScript and scrollback rows composed onto the
// screen by the renderer. Here the seam is a `Frame`: rows arrive already
// composed for whatever the viewport shows (libghostty scrolls the viewport
// itself), colours are the seam's `Color`, a cell's text is already the
// whole grapheme, and the cursor's shape is the terminal's rather than an
// option. A shadow copy of the rows stands in for `getLine`, because
// upstream re-reads the rows around the cursor, the selection and any dirty
// row's neighbours, and a frame carries only what changed.

import type {
  Cell,
  Color,
  CursorState,
  Frame,
  Row,
  Viewport,
} from "../../engine/types.ts";
import type { CellSize, PaintStats, Renderer } from "./renderer.ts";

// ============================================================================
// Type Definitions (ghostty-web; `ITheme` inlined, cursor options dropped)
// ============================================================================

export interface Theme {
  foreground: string;
  background: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  selectionForeground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export interface RendererOptions {
  fontSize?: number; // Default: 15
  fontFamily?: string; // Default: 'monospace'
  theme?: Partial<Theme>;
  devicePixelRatio?: number; // Default: window.devicePixelRatio
  /** Called when a blink tick wants the cursor row repainted. */
  requestPaint?: () => void;
}

export interface FontMetrics {
  width: number; // Character cell width in CSS pixels
  height: number; // Character cell height in CSS pixels
  baseline: number; // Distance from top to text baseline
}

/** Viewport-relative selection bounds, inclusive (ghostty-web's `SelectionCoordinates`). */
export interface SelectionCoordinates {
  startCol: number;
  startRow: number;
  endCol: number;
  endRow: number;
}

// ============================================================================
// Default Theme (ghostty-web)
// ============================================================================

export const DEFAULT_THEME: Theme = {
  foreground: "#d4d4d4",
  background: "#1e1e1e",
  cursor: "#ffffff",
  cursorAccent: "#1e1e1e",
  // Selection colors: solid colors that replace cell bg/fg when selected
  // Using Ghostty's approach: selection bg = default fg, selection fg = default bg
  selectionBackground: "#d4d4d4",
  selectionForeground: "#1e1e1e",
  black: "#000000",
  red: "#cd3131",
  green: "#0dbc79",
  yellow: "#e5e510",
  blue: "#2472c8",
  magenta: "#bc3fbc",
  cyan: "#11a8cd",
  white: "#e5e5e5",
  brightBlack: "#666666",
  brightRed: "#f14c4c",
  brightGreen: "#23d18b",
  brightYellow: "#f5f543",
  brightBlue: "#3b8eea",
  brightMagenta: "#d670d6",
  brightCyan: "#29b8db",
  brightWhite: "#ffffff",
};

// ============================================================================
// GhosttyWebRenderer
// ============================================================================

export class GhosttyWebRenderer implements Renderer {
  readonly stats: PaintStats = {
    paints: 0,
    fullPaints: 0,
    lastMs: 0,
    maxMs: 0,
    lastFullMs: null,
    lastPartialMs: null,
    lastRowsPainted: 0,
  };
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly fontSize: number;
  private readonly fontFamily: string;
  private readonly theme: Theme;
  private readonly devicePixelRatio: number;
  private metrics: FontMetrics;
  private palette: string[];
  private readonly requestPaint: () => void;

  // Cursor blinking state (ghostty-web); the blink itself now comes from the terminal
  private cursorVisible: boolean = true;
  private cursorBlinkInterval?: number;
  private lastCursor: CursorState | null = null;

  // Re-target: the rows as last painted, in place of IRenderable.getLine
  private shadow: Row[] = [];
  private cols = 0;
  private rows = 0;
  private lastViewport: Viewport | null = null;

  // Selection (ghostty-web kept a SelectionManager reference; here the coordinates are pushed in)
  private currentSelectionCoords: SelectionCoordinates | null = null;
  private dirtySelectionRows: Set<number> = new Set();

  // Scrollbar fade (ghostty-web's Terminal kept this; folded in here)
  private scrollbarOpacity = 0;
  private scrollbarHideTimeout?: number;

  constructor(canvas: HTMLCanvasElement, options: RendererOptions = {}) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) {
      throw new Error("Failed to get 2D rendering context");
    }
    this.ctx = ctx;

    // Apply options
    this.fontSize = options.fontSize ?? 15;
    this.fontFamily = options.fontFamily ?? "monospace";
    this.theme = { ...DEFAULT_THEME, ...options.theme };
    this.devicePixelRatio =
      options.devicePixelRatio ?? window.devicePixelRatio ?? 1;
    this.requestPaint = options.requestPaint ?? (() => {});

    // Build color palette (16 ANSI colors)
    this.palette = [
      this.theme.black,
      this.theme.red,
      this.theme.green,
      this.theme.yellow,
      this.theme.blue,
      this.theme.magenta,
      this.theme.cyan,
      this.theme.white,
      this.theme.brightBlack,
      this.theme.brightRed,
      this.theme.brightGreen,
      this.theme.brightYellow,
      this.theme.brightBlue,
      this.theme.brightMagenta,
      this.theme.brightCyan,
      this.theme.brightWhite,
    ];

    // Measure font metrics
    this.metrics = this.measureFont();
  }

  /** The seam's cell size: ghostty-web's metrics without the baseline. */
  get cell(): CellSize {
    return { width: this.metrics.width, height: this.metrics.height };
  }

  // ==========================================================================
  // Font Metrics Measurement (ghostty-web)
  // ==========================================================================

  private measureFont(): FontMetrics {
    // Use an offscreen canvas for measurement
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d")!;

    // Set font (use actual pixel size for accurate measurement)
    ctx.font = `${this.fontSize}px ${this.fontFamily}`;

    // Measure width using 'M' (typically widest character)
    const widthMetrics = ctx.measureText("M");
    const width = Math.ceil(widthMetrics.width);

    // Measure height using ascent + descent with padding for glyph overflow
    const ascent = widthMetrics.actualBoundingBoxAscent || this.fontSize * 0.8;
    const descent =
      widthMetrics.actualBoundingBoxDescent || this.fontSize * 0.2;

    // Add 2px padding to height to account for glyphs that overflow (like 'f', 'd', 'g', 'p')
    // and anti-aliasing pixels
    const height = Math.ceil(ascent + descent) + 2;
    const baseline = Math.ceil(ascent) + 1; // Offset baseline by half the padding

    return { width, height, baseline };
  }

  // ==========================================================================
  // Color Conversion (re-target: the seam's Color through the theme, in
  // place of the RGB the private patch resolved inside the WASM)
  // ==========================================================================

  private colorToCSS(c: Color, fallback: string): string {
    switch (c.kind) {
      case "default":
        return fallback;
      case "palette":
        return this.paletteToCSS(c.index);
      case "rgb":
        return `rgb(${c.r}, ${c.g}, ${c.b})`;
    }
  }

  private paletteToCSS(i: number): string {
    if (i < 16) return this.palette[i]!;
    if (i < 232) {
      const n = i - 16;
      const v = (x: number) => (x === 0 ? 0 : 55 + x * 40);
      return `rgb(${v(Math.floor(n / 36))}, ${v(Math.floor((n % 36) / 6))}, ${v(n % 6)})`;
    }
    const v = 8 + (i - 232) * 10;
    return `rgb(${v}, ${v}, ${v})`;
  }

  // ==========================================================================
  // Canvas Sizing (ghostty-web's resize, under the seam's name)
  // ==========================================================================

  /**
   * Resize canvas to fit terminal dimensions
   */
  public resizeTo(cols: number, rows: number): void {
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    this.shadow = [];
    this.lastCursor = null;
    const cssWidth = cols * this.metrics.width;
    const cssHeight = rows * this.metrics.height;

    // Set CSS size (what user sees)
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;

    // Set actual canvas size (scaled for DPI)
    this.canvas.width = cssWidth * this.devicePixelRatio;
    this.canvas.height = cssHeight * this.devicePixelRatio;

    // Scale context to match DPI (setting canvas.width/height resets the context)
    this.ctx.scale(this.devicePixelRatio, this.devicePixelRatio);

    // Set text rendering properties for crisp text
    this.ctx.textBaseline = "alphabetic";
    this.ctx.textAlign = "left";

    // Fill background after resize
    this.ctx.fillStyle = this.theme.background;
    this.ctx.fillRect(0, 0, cssWidth, cssHeight);
  }

  // ==========================================================================
  // Main Rendering (ghostty-web's render(), re-targeted onto a Frame)
  // ==========================================================================

  /**
   * Render the terminal buffer to canvas
   */
  public paint(frame: Frame): void {
    const t0 = performance.now();
    let forceAll = frame.dirtyAll;

    // Resize canvas if dimensions changed
    if (frame.cols !== this.cols || frame.rows !== this.rows) {
      this.resizeTo(frame.cols, frame.rows);
      forceAll = true; // Force full render after resize
    }

    // Re-target: the frame's rows replace IRenderable.getLine/isRowDirty
    const dirtyRows = new Set<number>();
    for (const row of frame.changed) {
      this.shadow[row.y] = row;
      dirtyRows.add(row.y);
    }

    // Force re-render when viewport changes (scrolling). libghostty already
    // marks every row dirty for that; this covers the scrollbar's fade.
    const vp = frame.viewport;
    const scrolled =
      this.lastViewport !== null &&
      (vp.offset !== this.lastViewport.offset ||
        vp.total !== this.lastViewport.total);
    if (scrolled) this.showScrollbar();
    this.lastViewport = vp;

    // Check if cursor position changed or if blinking (need to redraw cursor line)
    const cursor = frame.cursor;
    const cursorRows = new Set<number>();
    const last = this.lastCursor;
    if (cursor.inViewport && (frame.cursorChanged || cursor.blinking))
      cursorRows.add(cursor.y);
    if (last?.inViewport && (last.y !== cursor.y || !cursor.inViewport))
      cursorRows.add(last.y);
    this.syncCursorBlink(cursor);

    // Check if we need to redraw selection-related lines
    const selectionRows = new Set<number>();

    // Mark current selection rows for redraw (includes programmatic selections)
    if (this.currentSelectionCoords) {
      const coords = this.currentSelectionCoords;
      for (let row = coords.startRow; row <= coords.endRow; row++) {
        selectionRows.add(row);
      }
    }

    // Always mark dirty selection rows for redraw (to clear old overlay)
    if (this.dirtySelectionRows.size > 0) {
      for (const row of this.dirtySelectionRows) {
        selectionRows.add(row);
      }
      // Clear the dirty rows tracking after marking for redraw
      this.dirtySelectionRows.clear();
    }

    // Determine which rows need rendering.
    // We also include adjacent rows (above and below) for each dirty row to handle
    // glyph overflow - tall glyphs like Devanagari vowel signs can extend into
    // adjacent rows' visual space.
    const rowsToRender = new Set<number>();
    for (let y = 0; y < frame.rows; y++) {
      const needsRender =
        forceAll ||
        dirtyRows.has(y) ||
        cursorRows.has(y) ||
        selectionRows.has(y);

      if (needsRender) {
        rowsToRender.add(y);
        // Include adjacent rows to handle glyph overflow
        if (y > 0) rowsToRender.add(y - 1);
        if (y < frame.rows - 1) rowsToRender.add(y + 1);
      }
    }

    // Render each line
    for (let y = 0; y < frame.rows; y++) {
      if (!rowsToRender.has(y)) {
        continue;
      }
      const line = this.shadow[y];
      if (line) {
        this.renderLine(line.cells, y, frame.cols);
      }
    }

    // Selection highlighting is integrated into renderCellBackground/renderCellText

    // Render cursor (only if in the viewport, i.e. not scrolled away from it)
    if (cursor.inViewport && cursor.visible && this.cursorVisible) {
      this.renderCursor(cursor);
    }

    // Render scrollbar if scrolled or scrollback exists (with opacity for fade effect)
    if (this.scrollbarOpacity > 0 || !vp.active) {
      this.renderScrollbar(vp, !vp.active ? 1 : this.scrollbarOpacity);
    }

    this.lastCursor = cursor;

    const ms = performance.now() - t0;
    const s = this.stats;
    s.paints++;
    s.lastMs = ms;
    s.lastRowsPainted = rowsToRender.size;
    if (ms > s.maxMs) s.maxMs = ms;
    if (forceAll) {
      s.fullPaints++;
      s.lastFullMs = ms;
    } else if (frame.changed.length === 1) s.lastPartialMs = ms;
  }

  /**
   * (ghostty-web) Render a single line using two-pass approach:
   * 1. First pass: Draw all cell backgrounds
   * 2. Second pass: Draw all cell text and decorations
   *
   * This two-pass approach is necessary for proper rendering of complex scripts
   * like Devanagari where diacritics (like vowel sign ि) can extend LEFT of the
   * base character into the previous cell's visual area. If we draw backgrounds
   * and text in a single pass (cell by cell), the background of cell N would
   * cover any left-extending portions of graphemes from cell N-1.
   */
  private renderLine(line: Cell[], y: number, cols: number): void {
    const lineY = y * this.metrics.height;
    const lineWidth = cols * this.metrics.width;

    // Clear line background then fill with theme color.
    // We clear just the cell area - glyph overflow is handled by also
    // redrawing adjacent rows (see paint() method).
    // clearRect is needed because fillRect composites rather than replaces,
    // so transparent/translucent backgrounds wouldn't clear previous content.
    this.ctx.clearRect(0, lineY, lineWidth, this.metrics.height);
    this.ctx.fillStyle = this.theme.background;
    this.ctx.fillRect(0, lineY, lineWidth, this.metrics.height);

    // PASS 1: Draw all cell backgrounds first
    // This ensures all backgrounds are painted before any text, allowing text
    // to "bleed" across cell boundaries without being covered by adjacent backgrounds
    for (let x = 0; x < line.length; x++) {
      const cell = line[x]!;
      if (cell.width === 0) continue; // Skip spacer cells for wide characters
      this.renderCellBackground(cell, x, y);
    }

    // PASS 2: Draw all cell text and decorations
    // Now text can safely extend beyond cell boundaries (for complex scripts)
    for (let x = 0; x < line.length; x++) {
      const cell = line[x]!;
      if (cell.width === 0) continue; // Skip spacer cells for wide characters
      this.renderCellText(cell, x, y);
    }
  }

  /**
   * (ghostty-web) Render a cell's background only (Pass 1 of two-pass rendering)
   * Selection highlighting is integrated here to avoid z-order issues with
   * complex glyphs (like Devanagari) that extend outside their cell bounds.
   */
  private renderCellBackground(cell: Cell, x: number, y: number): void {
    const cellX = x * this.metrics.width;
    const cellY = y * this.metrics.height;
    const cellWidth = this.metrics.width * cell.width;

    // Check if this cell is selected
    const isSelected = this.isInSelection(x, y);

    if (isSelected) {
      // Draw selection background (solid color, not overlay)
      this.ctx.fillStyle = this.theme.selectionBackground;
      this.ctx.fillRect(cellX, cellY, cellWidth, this.metrics.height);
      return; // Selection background replaces cell background
    }

    // Re-target: colours are the seam's, not resolved RGB; inverse swaps
    // the two, and "default" means the theme background shows through
    const bg = cell.inverse ? cell.fg : cell.bg;
    if (bg.kind === "default" && !cell.inverse) return;
    this.ctx.fillStyle = this.colorToCSS(
      bg,
      cell.inverse ? this.theme.foreground : this.theme.background,
    );
    this.ctx.fillRect(cellX, cellY, cellWidth, this.metrics.height);
  }

  /**
   * (ghostty-web) Render a cell's text and decorations (Pass 2 of two-pass rendering)
   * Selection foreground color is applied here to match the selection background.
   */
  private renderCellText(
    cell: Cell,
    x: number,
    y: number,
    colorOverride?: string,
  ): void {
    const cellX = x * this.metrics.width;
    const cellY = y * this.metrics.height;
    const cellWidth = this.metrics.width * cell.width;

    // Upstream skipped INVISIBLE cells here; the seam's Cell does not carry
    // that flag yet, so nothing is skipped.

    // Check if this cell is selected
    const isSelected = this.isInSelection(x, y);

    // Set text style
    let fontStyle = "";
    if (cell.italic) fontStyle += "italic ";
    if (cell.bold) fontStyle += "bold ";
    this.ctx.font = `${fontStyle}${this.fontSize}px ${this.fontFamily}`;

    // Set text color - use override, selection foreground, or normal color
    if (colorOverride) {
      this.ctx.fillStyle = colorOverride;
    } else if (isSelected) {
      this.ctx.fillStyle = this.theme.selectionForeground;
    } else {
      // Extract colors and handle inverse
      const fg = cell.inverse ? cell.bg : cell.fg;
      this.ctx.fillStyle = this.colorToCSS(
        fg,
        cell.inverse ? this.theme.background : this.theme.foreground,
      );
    }

    // Upstream applied FAINT as globalAlpha 0.5; the seam's Cell does not
    // carry faint yet.

    // Draw text
    const textX = cellX;
    const textY = cellY + this.metrics.baseline;

    // Re-target: the seam's cell text is already the whole grapheme cluster,
    // so upstream's getGraphemeString lookup is not needed
    if (cell.text) this.ctx.fillText(cell.text, textX, textY);

    // Draw underline
    if (cell.underline) {
      const underlineY = cellY + this.metrics.baseline + 2;
      this.ctx.strokeStyle = this.ctx.fillStyle;
      this.ctx.lineWidth = 1;
      this.ctx.beginPath();
      this.ctx.moveTo(cellX, underlineY);
      this.ctx.lineTo(cellX + cellWidth, underlineY);
      this.ctx.stroke();
    }

    // Draw strikethrough
    if (cell.strikethrough) {
      const strikeY = cellY + this.metrics.height / 2;
      this.ctx.strokeStyle = this.ctx.fillStyle;
      this.ctx.lineWidth = 1;
      this.ctx.beginPath();
      this.ctx.moveTo(cellX, strikeY);
      this.ctx.lineTo(cellX + cellWidth, strikeY);
      this.ctx.stroke();
    }

    // Upstream drew hover underlines for OSC 8 hyperlinks and regex-detected
    // URLs here, fed by its LinkDetector; the seam's Cell has no hyperlink
    // id yet and the detector was not ported.
  }

  /**
   * (ghostty-web) Render cursor. Re-target: the style is the terminal's
   * (DECSCUSR through the render state) rather than a renderer option, which
   * adds the hollow block a terminal shows when unfocused.
   */
  private renderCursor(cur: CursorState): void {
    const { x, y } = cur;
    const cursorX = x * this.metrics.width;
    const cursorY = y * this.metrics.height;
    const under = this.shadow[y]?.cells[x];
    const span = under?.width === 2 ? 2 : 1;
    const width = this.metrics.width * span;

    this.ctx.fillStyle = this.theme.cursor;

    switch (cur.style) {
      case "block":
        // Full cell block
        this.ctx.fillRect(cursorX, cursorY, width, this.metrics.height);
        // Re-draw character under cursor with cursorAccent color
        if (under) {
          this.ctx.save();
          this.ctx.beginPath();
          this.ctx.rect(cursorX, cursorY, width, this.metrics.height);
          this.ctx.clip();
          this.renderCellText(under, x, y, this.theme.cursorAccent);
          this.ctx.restore();
        }
        break;

      case "block-hollow":
        this.ctx.strokeStyle = this.theme.cursor;
        this.ctx.lineWidth = 1;
        this.ctx.strokeRect(
          cursorX + 0.5,
          cursorY + 0.5,
          width - 1,
          this.metrics.height - 1,
        );
        break;

      case "underline": {
        // Underline at bottom of cell
        const underlineHeight = Math.max(
          2,
          Math.floor(this.metrics.height * 0.15),
        );
        this.ctx.fillRect(
          cursorX,
          cursorY + this.metrics.height - underlineHeight,
          width,
          underlineHeight,
        );
        break;
      }

      case "bar": {
        // Vertical bar at left of cell
        const barWidth = Math.max(2, Math.floor(this.metrics.width * 0.15));
        this.ctx.fillRect(cursorX, cursorY, barWidth, this.metrics.height);
        break;
      }
    }
  }

  // ==========================================================================
  // Cursor Blinking (ghostty-web; driven by the terminal's blink flag)
  // ==========================================================================

  private syncCursorBlink(cur: CursorState): void {
    const want = cur.blinking && cur.visible && cur.inViewport;
    if (want && this.cursorBlinkInterval === undefined) {
      // xterm.js uses ~530ms blink interval
      this.cursorBlinkInterval = window.setInterval(() => {
        this.cursorVisible = !this.cursorVisible;
        this.requestPaint();
      }, 530);
    } else if (!want && this.cursorBlinkInterval !== undefined) {
      this.stopCursorBlink();
    }
  }

  private stopCursorBlink(): void {
    if (this.cursorBlinkInterval !== undefined) {
      clearInterval(this.cursorBlinkInterval);
      this.cursorBlinkInterval = undefined;
    }
    this.cursorVisible = true;
  }

  // ==========================================================================
  // Scrollbar (ghostty-web's renderScrollbar, re-targeted onto Viewport)
  // ==========================================================================

  private showScrollbar(): void {
    this.scrollbarOpacity = 1;
    if (this.scrollbarHideTimeout !== undefined)
      clearTimeout(this.scrollbarHideTimeout);
    this.scrollbarHideTimeout = window.setTimeout(() => {
      this.scrollbarOpacity = 0;
      this.scrollbarHideTimeout = undefined;
      this.requestPaint();
    }, 1000);
  }

  /**
   * Render scrollbar
   * Shows scroll position; upstream's drag interaction lived in its Terminal and was not ported
   * @param opacity Opacity level (0-1) for fade in/out effect
   */
  private renderScrollbar(vp: Viewport, opacity: number = 1): void {
    const ctx = this.ctx;
    const canvasHeight = this.canvas.height / this.devicePixelRatio;
    const canvasWidth = this.canvas.width / this.devicePixelRatio;

    // Scrollbar dimensions
    const scrollbarWidth = 8;
    const scrollbarX = canvasWidth - scrollbarWidth - 4;
    const scrollbarPadding = 4;
    const scrollbarTrackHeight = canvasHeight - scrollbarPadding * 2;

    // Don't draw scrollbar if fully transparent or no scrollback. (Upstream
    // cleared the strip first, which erased the text under it; the rows
    // repaint themselves, so that is not done here.)
    const scrollbackLength = vp.total - vp.rows;
    if (opacity <= 0 || scrollbackLength <= 0) return;

    // Calculate scrollbar thumb size and position
    const thumbHeight = Math.max(
      20,
      (vp.rows / vp.total) * scrollbarTrackHeight,
    );

    // Re-target: position from the viewport offset, top = 0
    const scrollPosition = vp.offset / scrollbackLength; // 0 (top) to 1 (bottom)
    const thumbY =
      scrollbarPadding + (scrollbarTrackHeight - thumbHeight) * scrollPosition;

    // Draw scrollbar track (subtle background) with opacity
    ctx.fillStyle = `rgba(128, 128, 128, ${0.1 * opacity})`;
    ctx.fillRect(
      scrollbarX,
      scrollbarPadding,
      scrollbarWidth,
      scrollbarTrackHeight,
    );

    // Draw scrollbar thumb with opacity
    const isScrolled = !vp.active;
    const baseOpacity = isScrolled ? 0.5 : 0.3;
    ctx.fillStyle = `rgba(128, 128, 128, ${baseOpacity * opacity})`;
    ctx.fillRect(scrollbarX, thumbY, scrollbarWidth, thumbHeight);
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  public getMetrics(): FontMetrics {
    return { ...this.metrics };
  }

  /**
   * Get canvas element (needed by the selection controller)
   */
  public getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  /** The row as last painted, in place of IRenderable.getLine. */
  public getLine(y: number): Cell[] | null {
    return this.shadow[y]?.cells ?? null;
  }

  /**
   * Set the selection to highlight (viewport-relative, inclusive), or null
   * to clear it. Rows leaving the selection are repainted on the next paint.
   */
  public setSelection(coords: SelectionCoordinates | null): void {
    const old = this.currentSelectionCoords;
    if (old)
      for (let row = old.startRow; row <= old.endRow; row++)
        this.dirtySelectionRows.add(row);
    this.currentSelectionCoords = coords;
  }

  /**
   * (ghostty-web) Check if a cell at (x, y) is within the current selection.
   * Uses cached selection coordinates for performance.
   */
  private isInSelection(x: number, y: number): boolean {
    const sel = this.currentSelectionCoords;
    if (!sel) return false;

    const { startCol, startRow, endCol, endRow } = sel;

    // Single line selection
    if (startRow === endRow) {
      return y === startRow && x >= startCol && x <= endCol;
    }

    // Multi-line selection
    if (y === startRow) {
      // First line: from startCol to end of line
      return x >= startCol;
    } else if (y === endRow) {
      // Last line: from start of line to endCol
      return x <= endCol;
    } else if (y > startRow && y < endRow) {
      // Middle lines: entire line is selected
      return true;
    }

    return false;
  }

  /**
   * Cleanup resources
   */
  public dispose(): void {
    this.stopCursorBlink();
    if (this.scrollbarHideTimeout !== undefined)
      clearTimeout(this.scrollbarHideTimeout);
    this.shadow = [];
  }
}
