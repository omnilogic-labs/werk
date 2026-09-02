// ghostty-web's selection manager, rebased.
//
// Ported from coder/ghostty-web `lib/selection-manager.ts` at commit
// 1858a5947767 (MIT, Copyright (c) 2025 Coder; the licence text is in
// renderer-ghostty-web.ts). Upstream held the selection as absolute buffer
// rows (`scrollbackLength + viewportRow - viewportY`), extracted its text
// by walking cells out of its patched WASM API, and reached into a
// `Terminal` for `viewportY`, `cols`, `rows` and `scrollLines`, into a
// `CanvasRenderer` for the canvas and metrics, and into a textarea for the
// context menu and the execCommand fallback.
//
// What was kept: the mouse state machine (press, drag threshold, drag,
// release, double-click word, triple-click line, auto-scroll at the edges,
// document-level move and release), the absolute-row model, the
// normalisation to viewport rows, the clipboard strategy. What changed: the
// absolute row is `Frame.viewport.offset + viewportRow` (the same row
// space libghostty's SCREEN points use); the text comes from
// libghostty's selection formatter through the host, which rejoins
// soft-wrapped rows as Ghostty's own copy does; word and line lookups read
// the renderer's shadow rows. What was dropped: the xterm-shaped API
// (`select`, `selectLines`, `selectAll`, `getSelectionPosition`, the change
// emitter) and the context-menu textarea trick.

import type { Cell } from "../../engine/types.ts";
import type {
  GhosttyWebRenderer,
  SelectionCoordinates,
} from "./renderer-ghostty-web.ts";

export interface SelectionHost {
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
  requestPaint(): void;
  /** Whether a press should start a selection now (false while the program tracks the mouse and Shift is not held). */
  selectionEnabled(e: MouseEvent): boolean;
}

export class SelectionController {
  // Selection state - coordinates are in ABSOLUTE buffer space (viewport offset + viewport row)
  // This ensures selection persists correctly when scrolling
  private selectionStart: { col: number; absoluteRow: number } | null = null;
  private selectionEnd: { col: number; absoluteRow: number } | null = null;
  private isSelecting: boolean = false;
  private mouseDownX: number = 0;
  private mouseDownY: number = 0;
  private dragThresholdMet: boolean = false;
  private mouseDownTarget: EventTarget | null = null; // Track where mousedown occurred

  // Store bound event handlers for cleanup
  private boundMouseUpHandler: ((e: MouseEvent) => void) | null = null;
  private boundClickHandler: ((e: MouseEvent) => void) | null = null;
  private boundDocumentMouseMoveHandler: ((e: MouseEvent) => void) | null =
    null;
  private boundDocumentMouseDownHandler: ((e: MouseEvent) => void) | null =
    null;

  // Auto-scroll state for drag selection
  private autoScrollInterval: ReturnType<typeof setInterval> | null = null;
  private autoScrollDirection: number = 0; // -1 = up, 0 = none, 1 = down
  private static readonly AUTO_SCROLL_EDGE_SIZE = 30; // pixels from edge to trigger scroll
  private static readonly AUTO_SCROLL_SPEED = 3; // lines per interval
  private static readonly AUTO_SCROLL_INTERVAL = 50; // ms between scroll steps

  /** The last text copied, for a test harness that cannot read the clipboard. */
  public lastCopied: string | null = null;

  constructor(
    private readonly renderer: GhosttyWebRenderer,
    private readonly host: SelectionHost,
  ) {
    // Attach mouse event listeners
    this.attachEventListeners();
  }

  /**
   * Convert viewport row to absolute buffer row
   * Absolute row is an index into combined buffer: scrollback (0 to len-1) + screen (len to len+rows-1)
   */
  private viewportRowToAbsolute(viewportRow: number): number {
    return this.host.viewportOffset() + viewportRow;
  }

  /**
   * Convert absolute buffer row to viewport row (may be outside visible range)
   */
  private absoluteRowToViewport(absoluteRow: number): number {
    return absoluteRow - this.host.viewportOffset();
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Get the selected text as a string. Re-target: libghostty's selection
   * formatter, through the host, in place of walking cells.
   */
  getSelection(): string {
    if (!this.selectionStart || !this.selectionEnd) return "";
    const [a, b] = this.ordered();
    return (
      this.host.textBetween(
        { x: a.col, y: a.absoluteRow },
        { x: b.col, y: b.absoluteRow },
      ) ?? ""
    );
  }

  /**
   * Check if there's an active selection
   */
  hasSelection(): boolean {
    if (!this.selectionStart || !this.selectionEnd) return false;
    if (this.isSelecting && !this.dragThresholdMet) return false;
    return true;
  }

  /**
   * Clear the selection
   */
  clearSelection(): void {
    if (!this.selectionStart && !this.selectionEnd) return;
    this.selectionStart = null;
    this.selectionEnd = null;
    this.isSelecting = false;
    this.pushSelection();
  }

  /**
   * Get current selection coordinates (for rendering)
   */
  getSelectionCoords(): SelectionCoordinates | null {
    return this.normalizeSelection();
  }

  /**
   * Select a viewport-relative range, as a drag would, and return its text.
   * For the browser automation, which cannot drag on a canvas reliably.
   */
  selectViewport(
    startCol: number,
    startRow: number,
    endCol: number,
    endRow: number,
  ): string {
    this.isSelecting = false;
    this.dragThresholdMet = true;
    this.selectionStart = {
      col: startCol,
      absoluteRow: this.viewportRowToAbsolute(startRow),
    };
    this.selectionEnd = {
      col: endCol,
      absoluteRow: this.viewportRowToAbsolute(endRow),
    };
    this.pushSelection();
    this.copySelectionIfAny();
    return this.getSelection();
  }

  /**
   * Called by the page after every paint-worthy change of the viewport, so a
   * selection anchored in absolute rows follows a scroll.
   */
  viewportChanged(): void {
    if (this.selectionStart)
      this.renderer.setSelection(this.normalizeSelection());
  }

  /**
   * Cleanup resources
   */
  dispose(): void {
    // Stop auto-scroll if active
    this.stopAutoScroll();

    if (this.boundMouseUpHandler) {
      document.removeEventListener("mouseup", this.boundMouseUpHandler);
      this.boundMouseUpHandler = null;
    }
    if (this.boundDocumentMouseMoveHandler) {
      document.removeEventListener(
        "mousemove",
        this.boundDocumentMouseMoveHandler,
      );
      this.boundDocumentMouseMoveHandler = null;
    }
    if (this.boundDocumentMouseDownHandler) {
      document.removeEventListener(
        "mousedown",
        this.boundDocumentMouseDownHandler,
      );
      this.boundDocumentMouseDownHandler = null;
    }
    if (this.boundClickHandler) {
      document.removeEventListener("click", this.boundClickHandler);
      this.boundClickHandler = null;
    }
    // Canvas event listeners will be cleaned up when canvas is removed from DOM
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /** Hand the viewport-relative coordinates to the renderer and ask for a paint. */
  private pushSelection(): void {
    this.renderer.setSelection(
      this.hasSelection() ? this.normalizeSelection() : null,
    );
    this.host.requestPaint();
  }

  private ordered(): [
    { col: number; absoluteRow: number },
    { col: number; absoluteRow: number },
  ] {
    let a = this.selectionStart!;
    let b = this.selectionEnd!;
    if (
      a.absoluteRow > b.absoluteRow ||
      (a.absoluteRow === b.absoluteRow && a.col > b.col)
    )
      [a, b] = [b, a];
    return [a, b];
  }

  private copySelectionIfAny(): void {
    if (this.hasSelection()) {
      const text = this.getSelection();
      if (text) {
        this.lastCopied = text;
        this.copyToClipboard(text);
      }
    }
  }

  /**
   * Attach mouse event listeners to canvas
   */
  private attachEventListeners(): void {
    const canvas = this.renderer.getCanvas();

    // Mouse down - start selection or clear existing
    canvas.addEventListener("mousedown", (e: MouseEvent) => {
      if (e.button === 0 && this.host.selectionEnabled(e)) {
        // Left click only
        const cell = this.pixelToCell(e.offsetX, e.offsetY);

        // Always clear previous selection on new click
        if (this.hasSelection()) {
          this.clearSelection();
        }

        // Start new selection (convert to absolute coordinates)
        const absoluteRow = this.viewportRowToAbsolute(cell.row);
        this.selectionStart = { col: cell.col, absoluteRow };
        this.selectionEnd = { col: cell.col, absoluteRow };
        this.isSelecting = true;
        this.mouseDownX = e.offsetX;
        this.mouseDownY = e.offsetY;
        this.dragThresholdMet = false;
      }
    });

    // Mouse move on canvas - update selection
    canvas.addEventListener("mousemove", (e: MouseEvent) => {
      if (this.isSelecting) {
        // Check if drag threshold has been met
        if (!this.dragThresholdMet) {
          const dx = e.offsetX - this.mouseDownX;
          const dy = e.offsetY - this.mouseDownY;
          // Use 50% of cell width as threshold to scale with font size
          const threshold = this.renderer.getMetrics().width * 0.5;
          if (dx * dx + dy * dy < threshold * threshold) {
            return; // Below threshold, ignore
          }
          this.dragThresholdMet = true;
        }

        const cell = this.pixelToCell(e.offsetX, e.offsetY);
        const absoluteRow = this.viewportRowToAbsolute(cell.row);
        this.selectionEnd = { col: cell.col, absoluteRow };
        this.pushSelection();

        // Check if near edges for auto-scroll
        this.updateAutoScroll(e.offsetY, canvas.clientHeight);
      }
    });

    // Mouse leave - check for auto-scroll when leaving canvas during drag
    canvas.addEventListener("mouseleave", (e: MouseEvent) => {
      if (this.isSelecting) {
        // Determine scroll direction based on where mouse left
        const rect = canvas.getBoundingClientRect();
        if (e.clientY < rect.top) {
          this.startAutoScroll(-1); // Scroll up
        } else if (e.clientY > rect.bottom) {
          this.startAutoScroll(1); // Scroll down
        }
      }
    });

    // Mouse enter - stop auto-scroll when mouse returns to canvas
    canvas.addEventListener("mouseenter", () => {
      if (this.isSelecting) {
        this.stopAutoScroll();
      }
    });

    // Document-level mousemove for tracking mouse position during drag outside canvas
    this.boundDocumentMouseMoveHandler = (e: MouseEvent) => {
      if (this.isSelecting) {
        const rect = canvas.getBoundingClientRect();
        // Check drag threshold (same as canvas mousemove)
        if (!this.dragThresholdMet) {
          const dx = e.clientX - (rect.left + this.mouseDownX);
          const dy = e.clientY - (rect.top + this.mouseDownY);
          const threshold = this.renderer.getMetrics().width * 0.5;
          if (dx * dx + dy * dy < threshold * threshold) {
            return;
          }
          this.dragThresholdMet = true;
        }

        // Update selection based on clamped position
        const clampedX = Math.max(rect.left, Math.min(e.clientX, rect.right));
        const clampedY = Math.max(rect.top, Math.min(e.clientY, rect.bottom));

        // Convert to canvas-relative coordinates
        const offsetX = clampedX - rect.left;
        const offsetY = clampedY - rect.top;

        // Only update if mouse is outside the canvas
        if (
          e.clientX < rect.left ||
          e.clientX > rect.right ||
          e.clientY < rect.top ||
          e.clientY > rect.bottom
        ) {
          // Update auto-scroll direction based on mouse position
          if (e.clientY < rect.top) {
            this.startAutoScroll(-1);
          } else if (e.clientY > rect.bottom) {
            this.startAutoScroll(1);
          } else {
            this.stopAutoScroll();
          }

          // Only update selection position if NOT auto-scrolling
          // During auto-scroll, the scroll handler extends the selection
          if (this.autoScrollDirection === 0) {
            const cell = this.pixelToCell(offsetX, offsetY);
            const absoluteRow = this.viewportRowToAbsolute(cell.row);
            this.selectionEnd = { col: cell.col, absoluteRow };
            this.pushSelection();
          }
        }
      }
    };
    document.addEventListener("mousemove", this.boundDocumentMouseMoveHandler);

    // Track mousedown on document to know if a click started inside the canvas
    this.boundDocumentMouseDownHandler = (e: MouseEvent) => {
      this.mouseDownTarget = e.target;
    };
    document.addEventListener("mousedown", this.boundDocumentMouseDownHandler);

    // Listen for mouseup on DOCUMENT, not just canvas
    // This catches mouseup events that happen outside the canvas (common during drag)
    this.boundMouseUpHandler = () => {
      if (this.isSelecting) {
        this.isSelecting = false;
        this.stopAutoScroll();

        // Check if this was a click without drag (threshold never met).
        if (!this.dragThresholdMet) {
          this.clearSelection();
          return;
        }

        this.copySelectionIfAny();
      }
    };
    document.addEventListener("mouseup", this.boundMouseUpHandler);

    // Handle click events for double-click (word) and triple-click (line) selection
    // Use event.detail which browsers set to click count (1, 2, 3, etc.)
    canvas.addEventListener("click", (e: MouseEvent) => {
      if (!this.host.selectionEnabled(e)) return;
      // event.detail: 1 = single, 2 = double, 3 = triple click
      if (e.detail === 2) {
        // Double-click - select word
        const cell = this.pixelToCell(e.offsetX, e.offsetY);
        const word = this.getWordAtCell(cell.col, cell.row);

        if (word) {
          const absoluteRow = this.viewportRowToAbsolute(cell.row);
          this.selectionStart = { col: word.startCol, absoluteRow };
          this.selectionEnd = { col: word.endCol, absoluteRow };
          this.pushSelection();
          this.copySelectionIfAny();
        }
      } else if (e.detail >= 3) {
        // Triple-click (or more) - select line content (like native Ghostty)
        const cell = this.pixelToCell(e.offsetX, e.offsetY);
        const absoluteRow = this.viewportRowToAbsolute(cell.row);

        // Find actual line length (exclude trailing empty cells)
        const line = this.renderer.getLine(cell.row);
        // Find last non-empty cell (-1 means empty line)
        let endCol = -1;
        if (line) {
          for (let i = line.length - 1; i >= 0; i--) {
            const c = line[i];
            if (c && c.text !== "" && c.text !== " ") {
              endCol = i;
              break;
            }
          }
        }

        // Only select if line has content (endCol >= 0)
        if (endCol >= 0) {
          // Select line content only (not trailing whitespace)
          this.selectionStart = { col: 0, absoluteRow };
          this.selectionEnd = { col: endCol, absoluteRow };
          this.pushSelection();
          this.copySelectionIfAny();
        }
      }
    });

    // A click elsewhere in the document clears the selection
    this.boundClickHandler = (e: MouseEvent) => {
      if (this.isSelecting) {
        return;
      }
      const mouseDownWasInCanvas =
        this.mouseDownTarget && canvas.contains(this.mouseDownTarget as Node);
      if (mouseDownWasInCanvas) {
        return;
      }
      const target = e.target as Node;
      if (!canvas.contains(target)) {
        if (this.hasSelection()) {
          this.clearSelection();
        }
      }
    };
    document.addEventListener("click", this.boundClickHandler);
  }

  /**
   * Update auto-scroll based on mouse Y position within canvas
   */
  private updateAutoScroll(offsetY: number, canvasHeight: number): void {
    const edgeSize = SelectionController.AUTO_SCROLL_EDGE_SIZE;
    if (offsetY < edgeSize) {
      this.startAutoScroll(-1);
    } else if (offsetY > canvasHeight - edgeSize) {
      this.startAutoScroll(1);
    } else {
      this.stopAutoScroll();
    }
  }

  /**
   * Start auto-scrolling in the given direction
   */
  private startAutoScroll(direction: number): void {
    if (
      this.autoScrollInterval !== null &&
      this.autoScrollDirection === direction
    ) {
      return;
    }
    this.stopAutoScroll();
    this.autoScrollDirection = direction;
    this.autoScrollInterval = setInterval(() => {
      if (!this.isSelecting) {
        this.stopAutoScroll();
        return;
      }
      const scrollAmount =
        SelectionController.AUTO_SCROLL_SPEED * this.autoScrollDirection;
      this.host.scrollLines(scrollAmount);
      if (this.selectionEnd) {
        if (this.autoScrollDirection < 0) {
          const topAbsoluteRow = this.viewportRowToAbsolute(0);
          if (topAbsoluteRow < this.selectionEnd.absoluteRow) {
            this.selectionEnd = { col: 0, absoluteRow: topAbsoluteRow };
          }
        } else {
          const bottomAbsoluteRow = this.viewportRowToAbsolute(
            this.host.rows() - 1,
          );
          if (bottomAbsoluteRow > this.selectionEnd.absoluteRow) {
            this.selectionEnd = {
              col: this.host.cols() - 1,
              absoluteRow: bottomAbsoluteRow,
            };
          }
        }
      }
      this.pushSelection();
    }, SelectionController.AUTO_SCROLL_INTERVAL);
  }

  /**
   * Stop auto-scrolling
   */
  private stopAutoScroll(): void {
    if (this.autoScrollInterval !== null) {
      clearInterval(this.autoScrollInterval);
      this.autoScrollInterval = null;
    }
    this.autoScrollDirection = 0;
  }

  /**
   * Convert pixel coordinates to terminal cell coordinates
   */
  private pixelToCell(x: number, y: number): { col: number; row: number } {
    const metrics = this.renderer.getMetrics();
    const col = Math.floor(x / metrics.width);
    const row = Math.floor(y / metrics.height);
    return {
      col: Math.max(0, Math.min(col, this.host.cols() - 1)),
      row: Math.max(0, Math.min(row, this.host.rows() - 1)),
    };
  }

  /**
   * Normalize selection coordinates (handle backward selection)
   * Returns coordinates in VIEWPORT space for rendering, clamped to visible area
   */
  private normalizeSelection(): SelectionCoordinates | null {
    if (!this.selectionStart || !this.selectionEnd) return null;
    const [a, b] = this.ordered();
    let startCol = a.col;
    let endCol = b.col;
    let startRow = this.absoluteRowToViewport(a.absoluteRow);
    let endRow = this.absoluteRowToViewport(b.absoluteRow);
    const maxRow = this.host.rows() - 1;
    if (endRow < 0 || startRow > maxRow) {
      return null;
    }
    if (startRow < 0) {
      startRow = 0;
      startCol = 0; // Selection starts from beginning of first visible row
    }
    if (endRow > maxRow) {
      endRow = maxRow;
      endCol = this.host.cols() - 1; // Selection extends to end of last visible row
    }
    return { startCol, startRow, endCol, endRow };
  }

  /**
   * Get word boundaries at a cell position. Re-target: over the renderer's
   * shadow rows, which hold the viewport only.
   */
  private getWordAtCell(
    col: number,
    row: number,
  ): { startCol: number; endCol: number } | null {
    const line = this.renderer.getLine(row);
    if (!line) return null;
    const isWordChar = (cell: Cell | undefined) => {
      if (!cell || cell.text === "") return cell?.width === 0; // a wide cell's spacer belongs to it
      return /[\w\-./~@+]/.test(cell.text) || cell.width === 2;
    };
    if (!isWordChar(line[col])) return null;
    let startCol = col;
    while (startCol > 0 && isWordChar(line[startCol - 1])) {
      startCol--;
    }
    let endCol = col;
    while (endCol < line.length - 1 && isWordChar(line[endCol + 1])) {
      endCol++;
    }
    return { startCol, endCol };
  }

  /**
   * (ghostty-web) Copy text to clipboard
   *
   * Strategy (modern APIs first):
   * 1. Try ClipboardItem API (works in Safari and modern browsers)
   *    - Safari requires the ClipboardItem to be created synchronously within user gesture
   * 2. Try navigator.clipboard.writeText (modern async API, may fail in Safari)
   * 3. Fall back to execCommand (legacy, for older browsers)
   */
  private copyToClipboard(text: string): void {
    if (navigator.clipboard && typeof ClipboardItem !== "undefined") {
      try {
        const blob = new Blob([text], { type: "text/plain" });
        const clipboardItem = new ClipboardItem({
          "text/plain": blob,
        });
        navigator.clipboard.write([clipboardItem]).catch((err) => {
          console.warn("ClipboardItem write failed, trying writeText:", err);
          this.copyWithWriteText(text);
        });
        return;
      } catch {
        // fall through
      }
    }
    this.copyWithWriteText(text);
  }

  private copyWithWriteText(text: string): void {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch((err) => {
        console.warn("Clipboard writeText failed, trying execCommand:", err);
        this.copyWithExecCommand(text);
      });
    } else {
      this.copyWithExecCommand(text);
    }
  }

  /**
   * Copy using legacy execCommand (fallback for older browsers). Upstream
   * kept a permanent hidden textarea for this; one is made on demand.
   */
  private copyWithExecCommand(text: string): void {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const textarea = document.createElement("textarea");
    try {
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.left = "-9999px";
      textarea.style.top = "0";
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      document.execCommand("copy");
    } catch (err) {
      console.warn("execCommand copy failed:", err);
    } finally {
      textarea.remove();
      previouslyFocused?.focus();
    }
  }
}
