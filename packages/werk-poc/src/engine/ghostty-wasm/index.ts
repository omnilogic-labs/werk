// The `ghostty-wasm` adapter: the seam in ../types.ts over upstream's
// freestanding libghostty-vt build, reached through loader.ts.
//
// Covers create / write / resize / plainText / styledCells / emitVt /
// effects / encodeState / decodeState / dispose. Both input encoders and the
// render consumer return Unsupported until they are built; the C surface for
// each is already exported by the module.
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
//   emitVt      the same formatter with emit = VT and the screen extras
//               (cursor, style, hyperlink, protection, kitty keyboard,
//               charsets); the viewport selection again unless `scrollback`
//               asks for the whole active screen.
//   effects     libghostty's callbacks, registered with ghostty_terminal_set.
//               A callback is a C function pointer, i.e. an index into the
//               module's function table, and GhosttyModule.hostFunction puts
//               a JS function there. One set of six host functions serves
//               every terminal on a module; they dispatch on the terminal
//               handle they are handed.
//   encodeState ghostty_snapshot_encode_alloc. Continuation tracking is
//               switched on at create() so a snapshot taken mid-sequence
//               still encodes.
//   decodeState the incremental decoder over a copy of the bytes in wasm
//               memory: ready() yields the renderable prefix as a terminal
//               the caller owns, next() prepends one history page at a time.
//
// Reading plainText and styledCells through different APIs is deliberate:
// the tests compare them.

import type {
  Capabilities,
  Cell,
  Color,
  DecodedState,
  Effect,
  EmitVtOptions,
  KeyEvent,
  MouseEvent,
  Page,
  RenderConsumer,
  TerminalModes,
  VtEngine,
  VtTerminal,
} from "../types.ts";
import { Unsupported } from "../types.ts";
import {
  GhosttyModule,
  type GhosttySource,
  type WasmSignature,
} from "./loader.ts";

export { GhosttyModule, GhosttyError } from "./loader.ts";
export { Layout } from "./layout.ts";

const NOT_YET = "not yet implemented";

/** ghostty_terminal_resize wants a cell size in pixels; the daemon has no font, so a plausible constant. */
const CELL_WIDTH_PX = 8;
const CELL_HEIGHT_PX = 16;

/**
 * How much unfinished VT input a terminal retains so that a snapshot taken
 * mid-sequence can still be encoded. Past this, the continuation becomes
 * unavailable until the parser next reaches ground, and encodeState throws
 * INVALID_VALUE in the meantime.
 */
const CONTINUATION_MAX_BYTES = 64 * 1024;

const CAPS: Capabilities = {
  write: true,
  resize: true,
  plainText: true,
  styledCells: true,
  emitVt: true,
  encodeState: true,
  decodeState: true,
  renderConsumer: false,
  effects: true,
  encodeKey: false,
  encodeMouse: false,
};

export interface CreateOptions {
  cols: number;
  rows: number;
  scrollback: number;
  /** Override the continuation tracking limit; 0 disables tracking. */
  continuationMaxBytes?: number;
}

export class GhosttyWasmEngine implements VtEngine {
  readonly id = "ghostty-wasm";
  readonly caps = CAPS;

  constructor(readonly module: GhosttyModule) {}

  /** Compile and instantiate from bytes or a module; the Bun entry point pairs this with bytes.ts. */
  static async load(source: GhosttySource): Promise<GhosttyWasmEngine> {
    return new GhosttyWasmEngine(await GhosttyModule.load(source));
  }

  create(opts: CreateOptions): GhosttyWasmTerminal {
    return new GhosttyWasmTerminal(this.module, opts);
  }

  decodeState(bytes: Uint8Array): GhosttyWasmDecodedState | Unsupported {
    return new GhosttyWasmDecodedState(this.module, bytes);
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
  /** A u32 for terminal_get / terminal_set values, and a GhosttyString for borrowed strings. */
  u32: number;
  str: number;
}

/** A terminal handle to wrap rather than create; the decoder hands these out. */
interface AdoptHandle {
  adopt: number;
  /** Runs first in dispose(), before the handle is freed. */
  onDispose?: () => void;
}

export class GhosttyWasmTerminal implements VtTerminal {
  private handle: number;
  private cols: number;
  private rows: number;
  private scratch: Scratch | null = null;
  private disposed = false;
  private listeners: ((e: Effect) => void)[] = [];
  /** The first exception a listener threw during the current write(); rethrown once the write returns. */
  private listenerError: unknown = undefined;
  private readonly onDispose: (() => void) | undefined;

  constructor(
    private readonly g: GhosttyModule,
    init: CreateOptions | AdoptHandle,
  ) {
    if ("adopt" in init) {
      this.handle = init.adopt;
      this.onDispose = init.onDispose;
      this.cols = this.getNumber("COLS");
      this.rows = this.getNumber("ROWS");
      return;
    }
    this.cols = init.cols;
    this.rows = init.rows;
    this.handle = g.withOpaque("ghostty_terminal_new", (slot) =>
      g.call("ghostty_terminal_new", 0, slot, init.cols, init.rows),
    );
    // Scrollback. libghostty has two caps, lines and bytes, and prunes whole
    // pages when either is crossed, so the retained count lands within a
    // page (some hundreds of rows) of the limit. The byte cap defaults to
    // 10,000 bytes, which keeps about one page whatever the line cap says;
    // a NULL value removes it so the seam's line count is the one applied.
    const s = this.ensureScratch();
    const O = (m: string) => g.enumValue("GhosttyTerminalOption", m);
    g.write(s.u32, "u32", init.scrollback);
    g.check(
      "ghostty_terminal_set",
      this.handle,
      O("SCROLLBACK_MAX_LINES"),
      s.u32,
    );
    g.check("ghostty_terminal_set", this.handle, O("SCROLLBACK_MAX_BYTES"), 0);
    // Continuation tracking, so encodeState works between two bytes of an
    // escape sequence. Tracking must be on before the unfinished bytes
    // arrive, hence here rather than lazily in encodeState.
    const cont = init.continuationMaxBytes ?? CONTINUATION_MAX_BYTES;
    g.write(s.u32, "u32", cont);
    g.check(
      "ghostty_terminal_set",
      this.handle,
      O("CONTINUATION_MAX_BYTES"),
      cont === 0 ? 0 : s.u32,
    );
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
    // Effects fire synchronously inside the call above. A throwing listener
    // must not unwind through libghostty's frames, so dispatch() parks the
    // exception and it surfaces here.
    if (this.listenerError !== undefined) {
      const e = this.listenerError;
      this.listenerError = undefined;
      throw e;
    }
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

  /**
   * The screen as VT bytes that reproduce it in a fresh terminal of the same
   * size: text with SGR, hyperlinks, DECSCA protection, Kitty keyboard state
   * and charset designations, then a CUP to the cursor and the SGR state
   * active there. The stream assumes a cleared terminal with the cursor at
   * home; it does not clear or home itself.
   *
   * Two things do not survive: soft-wrapped lines come out as hard
   * newlines, so a copy reflows differently on resize; and a cell with a
   * background colour but no text (a BCE erase) comes out blank.
   * encodeState has neither defect.
   *
   * `scrollback: true` emits the whole active screen, scrollback first. The
   * formatter drops the viewport's trailing blank rows, which would leave a
   * copy scrolled short by that many rows, so the adapter pads them back with
   * newlines and places the cursor itself.
   */
  emitVt(opts?: EmitVtOptions): Uint8Array {
    this.assertLive();
    const cursor = opts?.cursor ?? true;
    const screen = {
      cursor,
      style: opts?.style ?? true,
      hyperlink: true,
      protection: true,
      kitty_keyboard: true,
      charsets: true,
    };
    if (!opts?.scrollback) {
      return this.format({
        emit: "VT",
        unwrap: false,
        trim: false,
        selection: this.viewportSelection(),
        screen,
      });
    }
    const body = this.format({
      emit: "VT",
      unwrap: false,
      trim: false,
      selection: 0,
      screen: { ...screen, cursor: false },
    });
    const lines = this.plainText().split("\n");
    let blank = 0;
    while (blank < lines.length && lines[lines.length - 1 - blank] === "")
      blank++;
    const { x, y } = this.cursor();
    const tail = new TextEncoder().encode(
      "\r\n".repeat(blank) + (cursor ? `\x1b[${y + 1};${x + 1}H` : ""),
    );
    const out = new Uint8Array(body.byteLength + tail.byteLength);
    out.set(body, 0);
    out.set(tail, body.byteLength);
    return out;
  }

  /**
   * The complete terminal as a `GHOSTSNP` snapshot: every screen, the
   * scrollback, and any unfinished VT input. Throws INVALID_VALUE if the
   * parser is mid-sequence and the continuation has outgrown its limit.
   */
  encodeState(): Uint8Array {
    this.assertLive();
    const g = this.g;
    const s = this.ensureScratch();
    g.check(
      "ghostty_snapshot_encode_alloc",
      this.handle,
      0,
      s.outPtr,
      s.outLen,
    );
    const ptr = g.read(s.outPtr, "pointer") as number;
    const len = g.read(s.outLen, "u32") as number;
    const out = g.readBytes(ptr, len);
    g.libFree(ptr, len);
    return out;
  }

  renderConsumer(): RenderConsumer | Unsupported {
    return new Unsupported(NOT_YET);
  }

  /**
   * Subscribe to the terminal's effects: title, pwd, bell, progress,
   * notification and write-pty. Every listener sees every effect, in
   * registration order, synchronously inside write(). A listener that
   * throws does not stop the others; the first exception is rethrown by
   * write() once libghostty has returned.
   */
  onEffect(cb: (e: Effect) => void): void {
    this.assertLive();
    if (this.listeners.length === 0) {
      const hooks = effectHooks(this.g);
      hooks.terminals.set(this.handle, this);
      const O = (m: string) => this.g.enumValue("GhosttyTerminalOption", m);
      for (const [option, fn] of Object.entries(hooks.fns))
        this.g.check("ghostty_terminal_set", this.handle, O(option), fn);
    }
    this.listeners.push(cb);
  }

  /** Called from the module-wide host functions with an effect for this terminal. */
  dispatch(e: Effect): void {
    for (const cb of this.listeners) {
      try {
        cb(e);
      } catch (err) {
        if (this.listenerError === undefined) this.listenerError = err;
      }
    }
  }

  /** A borrowed GhosttyString from ghostty_terminal_get, decoded. */
  getString(data: string): string {
    const s = this.ensureScratch();
    this.g.check(
      "ghostty_terminal_get",
      this.handle,
      this.g.enumValue("GhosttyTerminalData", data),
      s.str,
    );
    return this.g.readString(s.str);
  }

  /** The cursor's viewport position, 0-based. */
  cursor(): { x: number; y: number } {
    return { x: this.getNumber("CURSOR_X"), y: this.getNumber("CURSOR_Y") };
  }

  /** The whole active screen, scrollback included, as trimmed plain text. For comparing buffers, not viewports. */
  fullText(): string {
    this.assertLive();
    return new TextDecoder().decode(
      this.format({ emit: "PLAIN", unwrap: false, trim: true, selection: 0 }),
    );
  }

  /** Fill the scratch selection with the viewport, (0,0) .. (cols-1, rows-1), and return its address. */
  private viewportSelection(): number {
    const g = this.g;
    const s = this.ensureScratch();
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
    return s.selection;
  }

  /** One formatter run with the given options; the output bytes, copied out of wasm memory. */
  private format(o: {
    emit: "PLAIN" | "VT";
    unwrap: boolean;
    trim: boolean;
    selection: number;
    screen?: Record<string, boolean>;
  }): Uint8Array {
    const g = this.g;
    const s = this.ensureScratch();
    const opts = g.allocType("GhosttyFormatterTerminalOptions");
    g.writeStruct(opts, "GhosttyFormatterTerminalOptions", {
      emit: o.emit,
      unwrap: o.unwrap,
      trim: o.trim,
      // Nested sized structs each want their own size; allocType only sets the outer one.
      extra: {
        size: g.sizeOf("GhosttyFormatterTerminalExtra"),
        screen: {
          size: g.sizeOf("GhosttyFormatterScreenExtra"),
          ...o.screen,
        },
      },
      selection: o.selection,
    });
    let formatter = 0;
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
      const out = g.readBytes(ptr, len);
      g.libFree(ptr, len);
      return out;
    } finally {
      if (formatter) g.call("ghostty_formatter_free", formatter);
      g.freeType(opts, "GhosttyFormatterTerminalOptions");
    }
  }

  /**
   * The viewport as text: exactly `rows` lines joined by "\n", each with
   * trailing whitespace removed. Soft-wrapped lines stay split.
   */
  plainText(): string {
    this.assertLive();
    const text = new TextDecoder().decode(
      this.format({
        emit: "PLAIN",
        unwrap: false,
        trim: true,
        selection: this.viewportSelection(),
      }),
    );
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
    this.onDispose?.();
    const g = this.g;
    if (this.listeners.length) effectHooks(g).terminals.delete(this.handle);
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
      g.freeType(s.str, "GhosttyString");
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
      str: g.allocType("GhosttyString"),
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

// ---- effects: one set of host functions per module ---------------------------

/**
 * The six callbacks a module needs, as function-table indices, plus the
 * terminals that have registered them keyed by handle. A callback's first
 * argument is the terminal handle, which is how one table entry serves
 * every terminal; userdata is unused.
 */
interface EffectHooks {
  fns: Record<string, number>;
  terminals: Map<number, GhosttyWasmTerminal>;
}

const hooksByModule = new WeakMap<GhosttyModule, EffectHooks>();

function effectHooks(g: GhosttyModule): EffectHooks {
  let hooks = hooksByModule.get(g);
  if (hooks) return hooks;
  const terminals = new Map<number, GhosttyWasmTerminal>();
  const to = (handle: number, e: Effect) => terminals.get(handle)?.dispatch(e);
  const plain: WasmSignature = { params: ["i32", "i32"], results: [] };
  const withPtr: WasmSignature = { params: ["i32", "i32", "i32"], results: [] };
  const field = (type: string, name: string) =>
    g.layout.field(type, name).offset;
  hooks = {
    terminals,
    fns: {
      // GhosttyTerminalBellFn(terminal, userdata)
      BELL: g.hostFunction(plain, (h) => to(h, { kind: "bell" })),
      // GhosttyTerminalTitleChangedFn(terminal, userdata); the value is read back through terminal_get
      TITLE_CHANGED: g.hostFunction(plain, (h) => {
        const t = terminals.get(h);
        if (t) t.dispatch({ kind: "title", title: t.getString("TITLE") });
      }),
      // GhosttyTerminalPwdChangedFn(terminal, userdata); raw bytes, a file:// URI for OSC 7
      PWD_CHANGED: g.hostFunction(plain, (h) => {
        const t = terminals.get(h);
        if (t) t.dispatch({ kind: "pwd", pwd: t.getString("PWD") });
      }),
      // GhosttyTerminalWritePtyFn(terminal, userdata, data, len); data is borrowed, so copy
      WRITE_PTY: g.hostFunction(
        { params: ["i32", "i32", "i32", "i32"], results: [] },
        (h, _ud, ptr, len) =>
          to(h, { kind: "write-pty", bytes: g.readBytes(ptr, len) }),
      ),
      // GhosttyTerminalDesktopNotificationFn(terminal, userdata, const GhosttyTerminalDesktopNotification*)
      DESKTOP_NOTIFICATION: g.hostFunction(withPtr, (h, _ud, p) =>
        to(h, {
          kind: "notification",
          title: g.readString(
            p + field("GhosttyTerminalDesktopNotification", "title"),
          ),
          body: g.readString(
            p + field("GhosttyTerminalDesktopNotification", "body"),
          ),
        }),
      ),
      // GhosttyTerminalProgressReportFn(terminal, userdata, const GhosttyTerminalProgressReport*)
      PROGRESS_REPORT: g.hostFunction(withPtr, (h, _ud, p) => {
        const r = g.readStruct(p, "GhosttyTerminalProgressReport") as {
          state: number;
          progress: number;
        };
        to(h, {
          kind: "progress",
          state: (
            g.enumName("GhosttyTerminalProgressState", r.state) ?? "unknown"
          ).toLowerCase(),
          progress: r.progress < 0 ? null : r.progress,
        });
      }),
    },
  };
  hooksByModule.set(g, hooks);
  return hooks;
}

// ---- snapshot decode -----------------------------------------------------------

/**
 * The incremental decoder over a snapshot. The bytes are copied into wasm
 * memory and stay there until FINISH or dispose(), as the decoder borrows
 * them. ready() returns a terminal the caller owns; the decoder borrows it
 * for next() and is freed automatically after FINISH, or when the terminal
 * is disposed first, or by dispose() to abandon the history.
 */
export class GhosttyWasmDecodedState implements DecodedState {
  private decoder: number;
  private src: number;
  private readonly srcLen: number;
  private terminal: GhosttyWasmTerminal | null = null;
  private readonly slot: number;
  private readonly u32: number;
  private readonly u64: number;
  private finished = false;

  constructor(
    private readonly g: GhosttyModule,
    bytes: Uint8Array,
  ) {
    this.srcLen = bytes.byteLength;
    this.src = bytes.byteLength ? g.allocBytes(bytes) : 0;
    this.slot = g.alloc(4);
    this.u32 = g.alloc(4);
    this.u64 = g.alloc(8);
    this.decoder = g.withOpaque("ghostty_snapshot_decoder_new_buf", (slot) =>
      g.call(
        "ghostty_snapshot_decoder_new_buf",
        0,
        slot,
        this.src,
        this.srcLen,
      ),
    );
    // Keep continuation tracking on the restored terminal so it can be
    // snapshotted again after live input, matching what create() does.
    const O = (m: string) => g.enumValue("GhosttySnapshotDecoderOption", m);
    g.write(this.u32, "u32", CONTINUATION_MAX_BYTES);
    g.check(
      "ghostty_snapshot_decoder_set",
      this.decoder,
      O("MAX_CONTINUATION_BYTES"),
      this.u32,
    );
    g.write(this.u32, "bool", true);
    g.check(
      "ghostty_snapshot_decoder_set",
      this.decoder,
      O("RETAIN_CONTINUATION"),
      this.u32,
    );
  }

  /**
   * Decode through READY and return the terminal: the active screens, cursor
   * and unfinished input restored, with the newest page of scrollback.
   * Idempotent; the same terminal comes back on every call.
   */
  ready(): GhosttyWasmTerminal {
    if (this.terminal) return this.terminal;
    if (!this.decoder) throw new Error("decoder is disposed");
    const g = this.g;
    g.write(this.slot, "pointer", 0);
    g.check("ghostty_snapshot_decoder_ready", this.decoder, this.slot);
    const handle = g.read(this.slot, "pointer") as number;
    if (handle === 0) throw new Error("decoder_ready: success but NULL handle");
    this.terminal = new GhosttyWasmTerminal(g, {
      adopt: handle,
      onDispose: () => this.dispose(),
    });
    return this.terminal;
  }

  /**
   * Prepend one page of history to the terminal from ready(). Null once
   * FINISH has been validated, after which the decoder and the source
   * bytes are released; the terminal stays the caller's.
   */
  next(): Page | null {
    if (this.finished || !this.decoder) return null;
    if (!this.terminal) throw new Error("call ready() before next()");
    const g = this.g;
    const code = g.call("ghostty_snapshot_decoder_next", this.decoder);
    if (g.resultName(code) === "NO_VALUE") {
      this.finished = true;
      this.dispose();
      return null;
    }
    g.assertOk(code, "ghostty_snapshot_decoder_next");
    const screen = this.get("PROGRESS_SCREEN", "u32") as number;
    return {
      screen:
        g.enumName("GhosttyTerminalScreen", screen) === "ALTERNATE"
          ? "alternate"
          : "primary",
      rows: this.get("PROGRESS_ROWS", "u32") as number,
      remaining: this.get("PROGRESS_REMAINING", "u32") as number,
    };
  }

  /**
   * The snapshot's advisory row counts for scrollback, available after
   * ready(): rows before the active area once every page is restored.
   * Null for a screen the snapshot does not declare.
   */
  historyRows(): { primary: number | null; alternate: number | null } {
    const n = (d: string) => {
      const v = this.tryGet(d, "u64");
      return v === null ? null : Number(v);
    };
    return {
      primary: n("HISTORY_ROWS_PRIMARY"),
      alternate: n("HISTORY_ROWS_ALTERNATE"),
    };
  }

  /** Bytes of the snapshot consumed so far; after FINISH, where any trailing bytes begin. */
  sourceOffset(): number | null {
    const v = this.tryGet("SOURCE_OFFSET", "u32");
    return v === null ? null : (v as number);
  }

  /** Free the decoder and the copied source bytes; the terminal, if any, is untouched. */
  dispose(): void {
    const g = this.g;
    if (this.decoder) {
      g.call("ghostty_snapshot_decoder_free", this.decoder);
      this.decoder = 0;
      g.free(this.src, this.srcLen);
      this.src = 0;
      g.free(this.slot, 4);
      g.free(this.u32, 4);
      g.free(this.u64, 8);
    }
  }

  private get(data: string, type: "u32" | "u64"): number | bigint {
    const v = this.tryGet(data, type);
    if (v === null) throw new Error(`decoder_get(${data}): NO_VALUE`);
    return v;
  }

  private tryGet(data: string, type: "u32" | "u64"): number | bigint | null {
    if (!this.decoder) return null;
    const g = this.g;
    const out = type === "u64" ? this.u64 : this.u32;
    const code = g.call(
      "ghostty_snapshot_decoder_get",
      this.decoder,
      g.enumValue("GhosttySnapshotDecoderData", data),
      out,
    );
    if (g.resultName(code) === "NO_VALUE") return null;
    g.assertOk(code, `ghostty_snapshot_decoder_get(${data})`);
    return g.read(out, type) as number | bigint;
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
