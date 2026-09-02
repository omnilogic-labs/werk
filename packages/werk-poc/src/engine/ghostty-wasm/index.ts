// The `ghostty-wasm` adapter: the seam in ../types.ts over upstream's
// freestanding libghostty-vt build, reached through loader.ts.
//
// This half (M1a) covers create / write / resize / plainText / styledCells /
// dispose. The formatter's VT emission, effects, the snapshot codec, both
// input encoders and the render consumer return Unsupported until the other
// half lands; the C surface for each is already exported by the module.
//
// Routes chosen, and why (findings/m1.md has the detail):
//
//   plainText   the formatter (GHOSTTY_FORMATTER_FORMAT_PLAIN) restricted to
//               the viewport by a GhosttySelection built from two
//               ghostty_terminal_grid_ref lookups. Without the selection the
//               formatter emits the whole active screen, scrollback included.
//   styledCells the render state: one ghostty_render_state_update, then per
//               row a single CELLS_RAW query gives every packed GhosttyCell,
//               decoded with the packed descriptor from ghostty_type_json.
//               Only cells that need more (a multi-codepoint grapheme, or a
//               non-zero style id) go through the per-cell handle.
//
// Reading both through different APIs is deliberate: the tests compare them.

import type {
  Capabilities,
  Cell,
  Color,
  DecodedState,
  Effect,
  KeyEvent,
  MouseEvent,
  RenderConsumer,
  TerminalModes,
  VtEngine,
  VtTerminal,
} from "../types.ts";
import { Unsupported } from "../types.ts";
import { GhosttyModule, type GhosttySource } from "./loader.ts";

export { GhosttyModule, GhosttyError } from "./loader.ts";
export { Layout } from "./layout.ts";

const NOT_YET = "not yet implemented in M1a";

/** ghostty_terminal_resize wants a cell size in pixels; the daemon has no font, so a plausible constant. */
const CELL_WIDTH_PX = 8;
const CELL_HEIGHT_PX = 16;

const CAPS: Capabilities = {
  write: true,
  resize: true,
  plainText: true,
  styledCells: true,
  emitVt: false,
  encodeState: false,
  decodeState: false,
  renderConsumer: false,
  effects: false,
  encodeKey: false,
  encodeMouse: false,
};

export class GhosttyWasmEngine implements VtEngine {
  readonly id = "ghostty-wasm";
  readonly caps = CAPS;

  constructor(readonly module: GhosttyModule) {}

  /** Compile and instantiate from bytes or a module; the Bun entry point pairs this with bytes.ts. */
  static async load(source: GhosttySource): Promise<GhosttyWasmEngine> {
    return new GhosttyWasmEngine(await GhosttyModule.load(source));
  }

  create(opts: {
    cols: number;
    rows: number;
    scrollback: number;
  }): GhosttyWasmTerminal {
    return new GhosttyWasmTerminal(this.module, opts);
  }

  decodeState(_bytes: Uint8Array): DecodedState | Unsupported {
    return new Unsupported(NOT_YET);
  }

  encodeKey(_ev: KeyEvent, _mode: TerminalModes): Uint8Array | Unsupported {
    return new Unsupported(NOT_YET);
  }

  encodeMouse(_ev: MouseEvent, _mode: TerminalModes): Uint8Array | Unsupported {
    return new Unsupported(NOT_YET);
  }
}

/** Scratch allocations a terminal keeps for the life of the instance. */
interface Scratch {
  /** Input staging for write(); grown on demand. */
  inPtr: number;
  inLen: number;
  /** Render state, row iterator and per-row cells handle, plus 4-byte slots holding the latter two. */
  renderState: number;
  rowIter: number;
  rowIterSlot: number;
  rowCells: number;
  rowCellsSlot: number;
  /** Out-structs for the render-state queries. */
  cellsView: number;
  style: number;
  rowRaw: number;
  utf8Buf: number;
  utf8Data: number;
  utf8Cap: number;
  /** For plainText: the viewport selection, a point to resolve, and the format_alloc out-params. */
  selection: number;
  point: number;
  outPtr: number;
  outLen: number;
  /** A u32 for terminal_get / terminal_set values. */
  u32: number;
}

export class GhosttyWasmTerminal implements VtTerminal {
  private handle: number;
  private cols: number;
  private rows: number;
  private scratch: Scratch | null = null;
  private disposed = false;

  constructor(
    private readonly g: GhosttyModule,
    opts: { cols: number; rows: number; scrollback: number },
  ) {
    this.cols = opts.cols;
    this.rows = opts.rows;
    this.handle = g.withOpaque("ghostty_terminal_new", (slot) =>
      g.call("ghostty_terminal_new", 0, slot, opts.cols, opts.rows),
    );
    // Scrollback. libghostty has two caps, lines and bytes, and prunes whole
    // pages when either is crossed, so the retained count lands within a
    // page (some hundreds of rows) of the limit. The byte cap defaults to
    // 10,000 bytes, which keeps about one page whatever the line cap says;
    // a NULL value removes it so the seam's line count is the one applied.
    const s = this.ensureScratch();
    const O = (m: string) => g.enumValue("GhosttyTerminalOption", m);
    g.write(s.u32, "u32", opts.scrollback);
    g.check(
      "ghostty_terminal_set",
      this.handle,
      O("SCROLLBACK_MAX_LINES"),
      s.u32,
    );
    g.check("ghostty_terminal_set", this.handle, O("SCROLLBACK_MAX_BYTES"), 0);
  }

  /** The value libghostty reports for the configured line limit, or null for unlimited. */
  scrollbackMaxLines(): number | null {
    const s = this.ensureScratch();
    const code = this.g.call(
      "ghostty_terminal_get",
      this.handle,
      this.g.enumValue("GhosttyTerminalData", "SCROLLBACK_MAX_LINES"),
      s.u32,
    );
    if (this.g.resultName(code) === "NO_VALUE") return null;
    this.g.assertOk(code, "ghostty_terminal_get(SCROLLBACK_MAX_LINES)");
    return this.g.read(s.u32, "u32") as number;
  }

  /** ghostty_terminal_get for a size_t / uint16_t style value. */
  getNumber(data: string): number {
    const s = this.ensureScratch();
    this.g.write(s.u32, "u32", 0);
    this.g.check(
      "ghostty_terminal_get",
      this.handle,
      this.g.enumValue("GhosttyTerminalData", data),
      s.u32,
    );
    return this.g.read(s.u32, "u32") as number;
  }

  get size(): { cols: number; rows: number } {
    return { cols: this.cols, rows: this.rows };
  }

  write(bytes: Uint8Array): void {
    this.assertLive();
    if (bytes.byteLength === 0) return;
    const s = this.ensureScratch();
    if (bytes.byteLength > s.inLen) {
      this.g.free(s.inPtr, s.inLen);
      s.inLen = Math.max(bytes.byteLength, s.inLen * 2);
      s.inPtr = this.g.alloc(s.inLen);
    }
    this.g.writeBytes(s.inPtr, bytes);
    this.g.call(
      "ghostty_terminal_vt_write",
      this.handle,
      s.inPtr,
      bytes.byteLength,
    );
  }

  resize(cols: number, rows: number): void {
    this.assertLive();
    this.g.check(
      "ghostty_terminal_resize",
      this.handle,
      cols,
      rows,
      CELL_WIDTH_PX,
      CELL_HEIGHT_PX,
    );
    this.cols = cols;
    this.rows = rows;
  }

  emitVt(_opts?: {
    cursor?: boolean;
    style?: boolean;
  }): Uint8Array | Unsupported {
    return new Unsupported(NOT_YET);
  }

  encodeState(): Uint8Array | Unsupported {
    return new Unsupported(NOT_YET);
  }

  renderConsumer(): RenderConsumer | Unsupported {
    return new Unsupported(NOT_YET);
  }

  onEffect(_cb: (e: Effect) => void): void | Unsupported {
    return new Unsupported(NOT_YET);
  }

  /**
   * The viewport as text: exactly `rows` lines joined by "\n", each with
   * trailing whitespace removed. Soft-wrapped lines stay split.
   */
  plainText(): string {
    this.assertLive();
    const g = this.g;
    const s = this.ensureScratch();

    // A selection spanning the viewport: (0,0) .. (cols-1, rows-1).
    g.writeStruct(s.point, "GhosttyPoint", { tag: "VIEWPORT" });
    g.writeStruct(s.point, "GhosttyPoint", { value: { x: 0, y: 0 } });
    const start =
      s.selection + g.layout.field("GhosttySelection", "start").offset;
    const end = s.selection + g.layout.field("GhosttySelection", "end").offset;
    g.check("ghostty_terminal_grid_ref", this.handle, s.point, start);
    g.writeStruct(s.point, "GhosttyPoint", {
      value: { x: this.cols - 1, y: this.rows - 1 },
    });
    g.check("ghostty_terminal_grid_ref", this.handle, s.point, end);
    g.writeField(s.selection, "GhosttySelection", "rectangle", false);

    const opts = g.allocType("GhosttyFormatterTerminalOptions");
    g.writeStruct(opts, "GhosttyFormatterTerminalOptions", {
      emit: "PLAIN",
      unwrap: false,
      trim: true,
      // Nested sized structs each want their own size; allocType only sets the outer one.
      extra: {
        size: g.sizeOf("GhosttyFormatterTerminalExtra"),
        screen: { size: g.sizeOf("GhosttyFormatterScreenExtra") },
      },
      selection: s.selection,
    });
    let formatter = 0;
    let text: string;
    try {
      formatter = g.withOpaque("ghostty_formatter_terminal_new", (slot) =>
        g.call("ghostty_formatter_terminal_new", 0, slot, this.handle, opts),
      );
      g.check(
        "ghostty_formatter_format_alloc",
        formatter,
        0,
        s.outPtr,
        s.outLen,
      );
      const ptr = g.read(s.outPtr, "pointer") as number;
      const len = g.read(s.outLen, "u32") as number;
      text = new TextDecoder().decode(g.readBytes(ptr, len));
      g.libFree(ptr, len);
    } finally {
      if (formatter) g.call("ghostty_formatter_free", formatter);
      g.freeType(opts, "GhosttyFormatterTerminalOptions");
    }

    // The formatter drops trailing blank rows and trims each line; normalise to exactly `rows`.
    const lines = text.split("\n").map((l) => l.replace(/\s+$/, ""));
    while (lines.length < this.rows) lines.push("");
    return lines.slice(0, this.rows).join("\n");
  }

  /** The viewport as cells with attributes, `rows` arrays of `cols` cells. */
  styledCells(): Cell[][] {
    this.assertLive();
    const g = this.g;
    const s = this.ensureScratch();
    const RD = (m: string) => g.enumValue("GhosttyRenderStateRowData", m);
    const RC = (m: string) => g.enumValue("GhosttyRenderStateRowCellsData", m);

    g.check("ghostty_render_state_update", s.renderState, this.handle);
    g.check(
      "ghostty_render_state_get",
      s.renderState,
      g.enumValue("GhosttyRenderStateData", "ROW_ITERATOR"),
      s.rowIterSlot,
    );

    const out: Cell[][] = [];
    while (g.call("ghostty_render_state_row_iterator_next", s.rowIter)) {
      g.check(
        "ghostty_render_state_row_get",
        s.rowIter,
        RD("CELLS_RAW"),
        s.cellsView,
      );
      const view = g.readStruct(s.cellsView, "GhosttyCellsView") as {
        ptr: number;
        len: number;
      };
      const raw: bigint[] = [];
      const dv = g.view();
      for (let x = 0; x < view.len; x++)
        raw.push(dv.getBigUint64(view.ptr + x * 8, true));

      let cellsSelected = false;
      const row: Cell[] = [];
      for (let x = 0; x < raw.length; x++) {
        const d = g.layout.decodePacked(
          "GhosttyCell",
          raw[x]!,
        ) as unknown as PackedCell;
        const cell = defaultCell();
        const wide = d.wide;
        cell.width = wide === 1 ? 2 : wide === 2 || wide === 3 ? 0 : 1;
        const cp = d.content?.codepoint ?? 0;
        const isGrapheme = d.content_tag === 1;
        const hasText = (d.content_tag === 0 || isGrapheme) && cp !== 0;
        if (hasText && !isGrapheme) cell.text = String.fromCodePoint(cp);
        if (d.content_tag === 2)
          cell.bg = { kind: "palette", index: d.content?.index ?? 0 };
        if (d.content_tag === 3) {
          cell.bg = {
            kind: "rgb",
            r: d.content?.r ?? 0,
            g: d.content?.g ?? 0,
            b: d.content?.b ?? 0,
          };
        }
        if (isGrapheme || d.style_id !== 0) {
          if (!cellsSelected) {
            g.check(
              "ghostty_render_state_row_get",
              s.rowIter,
              RD("CELLS"),
              s.rowCellsSlot,
            );
            cellsSelected = true;
          }
          g.check("ghostty_render_state_row_cells_select", s.rowCells, x);
          if (isGrapheme) cell.text = this.readGraphemeUtf8(s);
          if (d.style_id !== 0) {
            g.check(
              "ghostty_render_state_row_cells_get",
              s.rowCells,
              RC("STYLE"),
              s.style,
            );
            applyStyle(
              cell,
              g.readStruct(s.style, "GhosttyStyle") as unknown as PackedStyle,
            );
          }
        }
        row.push(cell);
      }
      out.push(row);
    }
    return out;
  }

  private readGraphemeUtf8(s: Scratch): string {
    const g = this.g;
    const RC = g.enumValue("GhosttyRenderStateRowCellsData", "GRAPHEMES_UTF8");
    for (;;) {
      g.writeStruct(s.utf8Buf, "GhosttyBuffer", {
        ptr: s.utf8Data,
        cap: s.utf8Cap,
        len: 0,
      });
      const code = g.call(
        "ghostty_render_state_row_cells_get",
        s.rowCells,
        RC,
        s.utf8Buf,
      );
      const buf = g.readStruct(s.utf8Buf, "GhosttyBuffer") as { len: number };
      if (code === 0)
        return new TextDecoder().decode(g.readBytes(s.utf8Data, buf.len));
      if (g.resultName(code) !== "OUT_OF_SPACE")
        g.assertOk(code, "GRAPHEMES_UTF8");
      g.free(s.utf8Data, s.utf8Cap);
      s.utf8Cap = Math.max(buf.len, s.utf8Cap * 2);
      s.utf8Data = g.alloc(s.utf8Cap);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const g = this.g;
    const s = this.scratch;
    if (s) {
      g.call("ghostty_render_state_row_cells_free", s.rowCells);
      g.call("ghostty_render_state_row_iterator_free", s.rowIter);
      g.call("ghostty_render_state_free", s.renderState);
      g.free(s.rowIterSlot, 4);
      g.free(s.rowCellsSlot, 4);
      g.freeType(s.cellsView, "GhosttyCellsView");
      g.freeType(s.style, "GhosttyStyle");
      g.free(s.rowRaw, 8);
      g.freeType(s.utf8Buf, "GhosttyBuffer");
      g.free(s.utf8Data, s.utf8Cap);
      g.freeType(s.selection, "GhosttySelection");
      g.freeType(s.point, "GhosttyPoint");
      g.free(s.outPtr, 4);
      g.free(s.outLen, 4);
      g.free(s.u32, 4);
      g.free(s.inPtr, s.inLen);
      this.scratch = null;
    }
    g.call("ghostty_terminal_free", this.handle);
    this.handle = 0;
  }

  private assertLive(): void {
    if (this.disposed) throw new Error("terminal is disposed");
  }

  private ensureScratch(): Scratch {
    if (this.scratch) return this.scratch;
    const g = this.g;
    const utf8Cap = 64;
    const s: Scratch = {
      inPtr: 0,
      inLen: 0,
      renderState: g.withOpaque("ghostty_render_state_new", (slot) =>
        g.call("ghostty_render_state_new", 0, slot),
      ),
      rowIter: g.withOpaque("ghostty_render_state_row_iterator_new", (slot) =>
        g.call("ghostty_render_state_row_iterator_new", 0, slot),
      ),
      rowIterSlot: g.alloc(4),
      rowCells: g.withOpaque("ghostty_render_state_row_cells_new", (slot) =>
        g.call("ghostty_render_state_row_cells_new", 0, slot),
      ),
      rowCellsSlot: g.alloc(4),
      cellsView: g.allocType("GhosttyCellsView"),
      style: g.allocType("GhosttyStyle"),
      rowRaw: g.alloc(8),
      utf8Buf: g.allocType("GhosttyBuffer"),
      utf8Data: g.alloc(utf8Cap),
      utf8Cap,
      selection: g.allocType("GhosttySelection"),
      point: g.allocType("GhosttyPoint"),
      outPtr: g.alloc(4),
      outLen: g.alloc(4),
      u32: g.alloc(4),
    };
    s.inLen = 64 * 1024;
    s.inPtr = g.alloc(s.inLen);
    // The iterator and cells handles are populated through out-slots holding the handle.
    g.write(s.rowIterSlot, "pointer", s.rowIter);
    g.write(s.rowCellsSlot, "pointer", s.rowCells);
    this.scratch = s;
    return s;
  }
}

/** GhosttyCell as decodePacked returns it on the pinned build. */
interface PackedCell {
  content_tag: number;
  content: {
    codepoint?: number;
    index?: number;
    r?: number;
    g?: number;
    b?: number;
  } | null;
  style_id: number;
  wide: number;
  protected: boolean;
  hyperlink: boolean;
  semantic_content: number;
}

interface PackedStyle {
  fg_color: { tag: number; value: unknown };
  bg_color: { tag: number; value: unknown };
  bold: boolean;
  italic: boolean;
  faint: boolean;
  inverse: boolean;
  strikethrough: boolean;
  underline: number;
}

function defaultCell(): Cell {
  return {
    text: "",
    fg: { kind: "default" },
    bg: { kind: "default" },
    bold: false,
    italic: false,
    underline: false,
    inverse: false,
    strikethrough: false,
    width: 1,
  };
}

function styleColor(c: { tag: number; value: unknown }): Color {
  if (c.tag === 1) return { kind: "palette", index: c.value as number };
  if (c.tag === 2) {
    const rgb = c.value as { r: number; g: number; b: number };
    return { kind: "rgb", r: rgb.r, g: rgb.g, b: rgb.b };
  }
  return { kind: "default" };
}

function applyStyle(cell: Cell, st: PackedStyle): void {
  cell.fg = styleColor(st.fg_color);
  // A bg-colour-only cell already carries its colour in the content tag; a styled cell's bg wins if set.
  const bg = styleColor(st.bg_color);
  if (bg.kind !== "default") cell.bg = bg;
  cell.bold = st.bold;
  cell.italic = st.italic;
  cell.underline = st.underline !== 0;
  cell.inverse = st.inverse;
  cell.strikethrough = st.strikethrough;
}
