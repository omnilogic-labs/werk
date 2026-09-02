// The `ghostty-wasm` adapter: the seam in ../types.ts over upstream's
// freestanding libghostty-vt build, reached through loader.ts.
//
// Covers the whole seam: create / write / resize / plainText / styledCells /
// emitVt / effects / encodeState / decodeState / renderConsumer / modes /
// dispose on the terminal, encodeKey / encodeMouse on the engine.
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
//   renderConsumer
//               one render state per terminal, not per consumer: the dirty
//               flags live on the terminal and are consumed by whichever
//               render state updates first, so a second render state would
//               see nothing. Every update of the shared state merges what it
//               reports into each consumer's own dirty set before the state
//               is cleaned; a consumer then reads its rows off the shared
//               state, which is stable until the next update.
//   encodeKey / encodeMouse
//               libghostty's encoders (encoders.ts), one of each per engine,
//               reconfigured from the seam's TerminalModes on every call.
//               modes() reads those off a terminal through
//               ghostty_terminal_get(MODE) and KITTY_KEYBOARD_FLAGS.
//
// Reading plainText and styledCells through different APIs is deliberate:
// the tests compare them.

import type {
  Capabilities,
  Cell,
  Color,
  CursorState,
  DecodedState,
  Effect,
  EmitVtOptions,
  Frame,
  KeyEvent,
  MouseEvent,
  Page,
  RenderConsumer,
  Row,
  TerminalModes,
  Viewport,
  VtEngine,
  VtTerminal,
} from "../types.ts";
import { Unsupported } from "../types.ts";
import { KeyEncoder, MouseEncoder } from "./encoders.ts";
import {
  GhosttyModule,
  type GhosttySource,
  type WasmSignature,
} from "./loader.ts";

import type { PackedDecoder } from "./layout.ts";

export { GhosttyModule, GhosttyError } from "./loader.ts";
export { Layout } from "./layout.ts";
export {
  KeyEncoder,
  MouseEncoder,
  keyMemberName,
  modsBits,
} from "./encoders.ts";

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
  renderConsumer: true,
  effects: true,
  encodeKey: true,
  encodeMouse: true,
};

/** Where to move the viewport; see GhosttyWasmTerminal.scrollViewport. */
export type ScrollViewport =
  | { kind: "top" }
  | { kind: "bottom" }
  | { kind: "delta"; delta: number }
  | { kind: "row"; row: number };

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

  private keyEncoder: KeyEncoder | null = null;
  private mouseEncoder: MouseEncoder | null = null;

  /**
   * A key event as the bytes to write to the PTY, for a terminal in the
   * given modes. An empty array is a valid answer: a bare modifier, a
   * release outside the Kitty protocol, or a composing event.
   */
  encodeKey(ev: KeyEvent, modes: TerminalModes): Uint8Array {
    this.keyEncoder ??= new KeyEncoder(this.module);
    this.keyEncoder.configure(modes);
    return this.keyEncoder.encode(ev);
  }

  /** A mouse event as PTY bytes; empty when the modes do not report it (no tracking, or motion the mode ignores). */
  encodeMouse(ev: MouseEvent, modes: TerminalModes): Uint8Array {
    this.mouseEncoder ??= new MouseEncoder(this.module);
    this.mouseEncoder.configure(modes);
    return this.mouseEncoder.encode(ev);
  }

  /**
   * The same encoders configured by libghostty's own
   * `setopt_from_terminal` rather than through the seam's modes. The tests
   * use these as the reference that `modes()` is validated against; a
   * daemon holding the terminal may prefer them.
   */
  encodeKeySynced(term: GhosttyWasmTerminal, ev: KeyEvent): Uint8Array {
    this.keyEncoder ??= new KeyEncoder(this.module);
    this.keyEncoder.syncFromTerminal(term.rawHandle());
    return this.keyEncoder.encode(ev);
  }

  encodeMouseSynced(term: GhosttyWasmTerminal, ev: MouseEvent): Uint8Array {
    this.mouseEncoder ??= new MouseEncoder(this.module);
    this.mouseEncoder.syncFromTerminal(term.rawHandle());
    return this.mouseEncoder.encode(ev);
  }
}

type BooleanMode = {
  [K in keyof TerminalModes]-?: TerminalModes[K] extends boolean | undefined
    ? K
    : never;
}[keyof TerminalModes];

/** The DEC private modes `modes()` reads, and the seam field each one feeds. */
const DEC_MODE_FIELDS: [number, BooleanMode][] = [
  [1, "cursorKeyApplication"],
  [66, "keypadApplication"],
  [1035, "ignoreKeypadWithNumlock"],
  [1036, "altEscPrefix"],
  [67, "backarrowKeyMode"],
  [2004, "bracketedPaste"],
  [1004, "focusEvents"],
];

/** Strongest first, which is the precedence libghostty's own `setopt_from_terminal` applies. */
const MOUSE_TRACKING_MODES: [number, TerminalModes["mouseTracking"]][] = [
  [1003, "any"],
  [1002, "button"],
  [1000, "normal"],
  [9, "x10"],
];
const MOUSE_FORMAT_MODES: [number, TerminalModes["mouseFormat"]][] = [
  [1016, "sgr-pixels"],
  [1006, "sgr"],
  [1015, "urxvt"],
  [1005, "utf8"],
];

/** Per-consumer dirty bookkeeping; the cells themselves live in the shared render state. */
interface ConsumerState {
  all: boolean;
  rows: Set<number>;
  lastCursor: CursorState | null;
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
  /** For the render consumer: next_dirty's out-y, the sized cursor struct, the scrollbar, and a mode query. */
  u16: number;
  cursor: number;
  scrollbar: number;
  modeConfig: number;
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
  private readonly consumers = new Set<ConsumerState>();

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

  /**
   * A consumer with its own dirty cursor. Its first frame is the whole
   * screen; after that, each frame is what changed since its previous
   * one, however many other consumers read in between.
   */
  renderConsumer(): RenderConsumer {
    this.assertLive();
    const state: ConsumerState = {
      all: true,
      rows: new Set(),
      lastCursor: null,
    };
    this.consumers.add(state);
    const frame = (): Frame => {
      this.assertLive();
      if (!this.consumers.has(state)) throw new Error("consumer is disposed");
      this.refreshRenderState();
      const dirtyAll = state.all;
      const want = state.rows;
      const changed = this.readRows((y) => dirtyAll || want.has(y));
      state.all = false;
      state.rows = new Set();
      const cursor = this.readCursor();
      const cursorChanged =
        state.lastCursor === null || !sameCursor(state.lastCursor, cursor);
      state.lastCursor = cursor;
      return {
        cols: this.cols,
        rows: this.rows,
        dirtyAll,
        changed,
        cursor,
        cursorChanged,
        viewport: this.viewport(),
      };
    };
    return {
      frame,
      dirtyRows: () => frame().changed,
      dispose: () => {
        this.consumers.delete(state);
      },
    };
  }

  /**
   * Update the shared render state from the terminal and hand what it
   * reports to every consumer before cleaning it. This is the only place
   * the render state is updated: the terminal's dirty flags are consumed
   * by the update, so a path that skipped the merge would lose rows for
   * every consumer.
   */
  private refreshRenderState(): void {
    const g = this.g;
    const s = this.ensureScratch();
    g.check("ghostty_render_state_update", s.renderState, this.handle);
    if (this.consumers.size > 0) {
      g.check(
        "ghostty_render_state_get",
        s.renderState,
        g.enumValue("GhosttyRenderStateData", "DIRTY"),
        s.u32,
      );
      const dirty = g.enumName(
        "GhosttyRenderStateDirty",
        g.read(s.u32, "u32") as number,
      );
      if (dirty === "FULL") {
        for (const c of this.consumers) c.all = true;
      } else if (dirty === "PARTIAL") {
        g.check(
          "ghostty_render_state_get",
          s.renderState,
          g.enumValue("GhosttyRenderStateData", "ROW_ITERATOR"),
          s.rowIterSlot,
        );
        while (
          g.call(
            "ghostty_render_state_row_iterator_next_dirty",
            s.rowIter,
            s.u16,
          )
        ) {
          const y = g.read(s.u16, "u16") as number;
          for (const c of this.consumers) if (!c.all) c.rows.add(y);
        }
      }
    }
    g.check("ghostty_render_state_clean", s.renderState);
  }

  /** The render state's cursor, after a refresh. */
  private readCursor(): CursorState {
    const g = this.g;
    const s = this.ensureScratch();
    g.check(
      "ghostty_render_state_get",
      s.renderState,
      g.enumValue("GhosttyRenderStateData", "CURSOR"),
      s.cursor,
    );
    const c = g.readStruct(s.cursor, "GhosttyRenderStateCursor") as {
      viewport_has_value: boolean;
      viewport_x: number;
      viewport_y: number;
      wide_tail: boolean;
      visible: boolean;
      blinking: boolean;
      password_input: boolean;
      visual_style: number;
    };
    const style = (
      g.enumName("GhosttyRenderStateCursorVisualStyle", c.visual_style) ??
      "BLOCK"
    )
      .toLowerCase()
      .replace("_", "-") as CursorState["style"];
    return {
      x: c.viewport_has_value ? c.viewport_x : 0,
      y: c.viewport_has_value ? c.viewport_y : 0,
      inViewport: c.viewport_has_value,
      visible: c.visible,
      blinking: c.blinking,
      style,
      wideTail: c.viewport_has_value && c.wide_tail,
      passwordInput: c.password_input,
    };
  }

  /** Where the viewport sits: the terminal's scrollbar plus VIEWPORT_ACTIVE. */
  viewport(): Viewport {
    this.assertLive();
    const g = this.g;
    const s = this.ensureScratch();
    const D = (m: string) => g.enumValue("GhosttyTerminalData", m);
    g.check("ghostty_terminal_get", this.handle, D("SCROLLBAR"), s.scrollbar);
    const sb = g.readStruct(s.scrollbar, "GhosttyTerminalScrollbar") as {
      total: bigint;
      offset: bigint;
      len: bigint;
    };
    g.check("ghostty_terminal_get", this.handle, D("VIEWPORT_ACTIVE"), s.u32);
    return {
      total: Number(sb.total),
      offset: Number(sb.offset),
      rows: Number(sb.len),
      active: g.read(s.u32, "bool") as boolean,
    };
  }

  /** One DEC private mode, through ghostty_terminal_get(MODE). Throws INVALID_VALUE for a mode libghostty does not know. */
  decMode(mode: number): boolean {
    this.assertLive();
    const g = this.g;
    const s = this.ensureScratch();
    g.writeStruct(s.modeConfig, "GhosttyTerminalModeConfig", {
      mode: mode & 0x7fff,
      value: false,
    });
    g.check(
      "ghostty_terminal_get",
      this.handle,
      g.enumValue("GhosttyTerminalData", "MODE"),
      s.modeConfig,
    );
    return g.readField(
      s.modeConfig,
      "GhosttyTerminalModeConfig",
      "value",
    ) as boolean;
  }

  /**
   * The modes the encoders need, read off the live terminal: everything
   * the encoders' `setopt_from_terminal` read, plus bracketed paste and
   * focus events for a client wrapping its own input. DEC modes come
   * through ghostty_terminal_get(MODE), the Kitty flags through their own
   * data item, and modifyOtherKeys through the formatter (see
   * modifyOtherKeys2()). About thirteen calls; a client can cache the
   * result between writes.
   */
  modes(): TerminalModes {
    this.assertLive();
    const m: TerminalModes = {};
    for (const [mode, field] of DEC_MODE_FIELDS) m[field] = this.decMode(mode);
    m.kittyKeyboardFlags = this.getNumber("KITTY_KEYBOARD_FLAGS") & 0xff;
    m.modifyOtherKeys2 = this.modifyOtherKeys2();
    m.mouseTracking = "none";
    for (const [mode, tracking] of MOUSE_TRACKING_MODES) {
      if (this.decMode(mode)) {
        m.mouseTracking = tracking;
        break;
      }
    }
    m.mouseFormat = "x10";
    for (const [mode, format] of MOUSE_FORMAT_MODES) {
      if (this.decMode(mode)) {
        m.mouseFormat = format;
        break;
      }
    }
    return m;
  }

  /**
   * xterm modifyOtherKeys state 2 (`CSI > 4 ; 2 m`). libghostty tracks it
   * for the key encoder but has no getter for it; the formatter's
   * `keyboard` extra re-emits it, so this formats one cell of the viewport
   * with that extra on and looks for the sequence. A few microseconds.
   */
  modifyOtherKeys2(): boolean {
    this.assertLive();
    const out = this.format({
      emit: "VT",
      unwrap: false,
      trim: true,
      selection: this.viewportSelection(0, 0),
      terminal: { keyboard: true },
    });
    return new TextDecoder().decode(out).includes("\x1b[>4;2m");
  }

  /** The GhosttyTerminal handle, for code that talks to libghostty directly (the synced encoders). */
  rawHandle(): number {
    this.assertLive();
    return this.handle;
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

  /**
   * Move the viewport through scrollback: to the top, to the bottom (the
   * active area), by a delta in rows (up is negative), or to an absolute
   * row in the space `viewport().offset` reports. The render state marks
   * every row dirty on the next frame, so a consumer repaints the whole
   * viewport. Used by the browser page's wheel handling (web/client).
   */
  scrollViewport(behaviour: ScrollViewport): void {
    this.assertLive();
    const g = this.g;
    const ptr = g.allocType("GhosttyTerminalScrollViewport");
    try {
      switch (behaviour.kind) {
        case "top":
        case "bottom":
          g.writeStruct(ptr, "GhosttyTerminalScrollViewport", {
            tag: behaviour.kind.toUpperCase(),
          });
          break;
        case "delta":
          g.writeStruct(ptr, "GhosttyTerminalScrollViewport", { tag: "DELTA" });
          g.writeStruct(ptr, "GhosttyTerminalScrollViewport", {
            value: Math.trunc(behaviour.delta),
          });
          break;
        case "row":
          g.writeStruct(ptr, "GhosttyTerminalScrollViewport", { tag: "ROW" });
          g.writeStruct(ptr, "GhosttyTerminalScrollViewport", {
            value: Math.max(0, Math.trunc(behaviour.row)),
          });
          break;
      }
      // A by-value struct arrives as a pointer under the wasm32 C ABI.
      g.call("ghostty_terminal_scroll_viewport", this.handle, ptr);
    } finally {
      g.freeType(ptr, "GhosttyTerminalScrollViewport");
    }
  }

  /** Which screen is active: the primary one, or the alternate one full-screen programs switch to. */
  activeScreen(): "primary" | "alternate" {
    const v = this.getNumber("ACTIVE_SCREEN");
    return this.g.enumName("GhosttyTerminalScreen", v) === "ALTERNATE"
      ? "alternate"
      : "primary";
  }

  /**
   * The text between two points, inclusive, as Ghostty itself copies a
   * selection: plain, soft-wrapped rows rejoined, trailing whitespace
   * trimmed. Points are in the screen's row space (`SCREEN`: row 0 is the
   * top of scrollback, which is what `viewport().offset` counts in) or the
   * viewport's. Null when the two points select nothing.
   */
  selectionText(
    start: { x: number; y: number },
    end: { x: number; y: number },
    space: "screen" | "viewport" = "screen",
  ): string | null {
    this.assertLive();
    const g = this.g;
    const s = this.ensureScratch();
    const tag = space === "screen" ? "SCREEN" : "VIEWPORT";
    const sel = this.pointSelection(tag, start, end);
    const opts = g.allocType("GhosttyTerminalSelectionFormatOptions");
    try {
      g.writeStruct(opts, "GhosttyTerminalSelectionFormatOptions", {
        emit: "PLAIN",
        unwrap: true,
        trim: true,
        selection: sel,
      });
      const code = g.call(
        "ghostty_terminal_selection_format_alloc",
        this.handle,
        0,
        opts,
        s.outPtr,
        s.outLen,
      );
      if (g.resultName(code) === "NO_VALUE") return null;
      g.assertOk(code, "ghostty_terminal_selection_format_alloc");
      const ptr = g.read(s.outPtr, "pointer") as number;
      const len = g.read(s.outLen, "u32") as number;
      const out = g.readBytes(ptr, len);
      g.libFree(ptr, len);
      return new TextDecoder().decode(out);
    } finally {
      g.freeType(opts, "GhosttyTerminalSelectionFormatOptions");
    }
  }

  /** Fill the scratch selection from two points in the given space and return its address. */
  private pointSelection(
    tag: "SCREEN" | "VIEWPORT",
    a: { x: number; y: number },
    b: { x: number; y: number },
  ): number {
    const g = this.g;
    const s = this.ensureScratch();
    const start =
      s.selection + g.layout.field("GhosttySelection", "start").offset;
    const end = s.selection + g.layout.field("GhosttySelection", "end").offset;
    g.writeStruct(s.point, "GhosttyPoint", { tag });
    g.writeStruct(s.point, "GhosttyPoint", { value: { x: a.x, y: a.y } });
    g.check("ghostty_terminal_grid_ref", this.handle, s.point, start);
    g.writeStruct(s.point, "GhosttyPoint", { value: { x: b.x, y: b.y } });
    g.check("ghostty_terminal_grid_ref", this.handle, s.point, end);
    g.writeField(s.selection, "GhosttySelection", "rectangle", false);
    return s.selection;
  }

  /** Fill the scratch selection with the viewport, (0,0) .. (cols-1, rows-1), and return its address. */
  private viewportSelection(
    endX = this.cols - 1,
    endY = this.rows - 1,
  ): number {
    const g = this.g;
    const s = this.ensureScratch();
    g.writeStruct(s.point, "GhosttyPoint", { tag: "VIEWPORT" });
    g.writeStruct(s.point, "GhosttyPoint", { value: { x: 0, y: 0 } });
    const start =
      s.selection + g.layout.field("GhosttySelection", "start").offset;
    const end = s.selection + g.layout.field("GhosttySelection", "end").offset;
    g.check("ghostty_terminal_grid_ref", this.handle, s.point, start);
    g.writeStruct(s.point, "GhosttyPoint", {
      value: { x: endX, y: endY },
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
    terminal?: Record<string, boolean>;
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
        ...o.terminal,
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
    this.refreshRenderState();
    return this.readRows(() => true).map((r) => r.cells);
  }

  /**
   * Decode the rows `want` selects from the shared render state, which
   * must have been refreshed first. Every row is visited (the iterator is
   * sequential) but only the wanted ones are decoded.
   */
  private readRows(want: (y: number) => boolean): Row[] {
    const g = this.g;
    const s = this.ensureScratch();
    const RD = (m: string) => g.enumValue("GhosttyRenderStateRowData", m);
    const RC = (m: string) => g.enumValue("GhosttyRenderStateRowCellsData", m);

    g.check(
      "ghostty_render_state_get",
      s.renderState,
      g.enumValue("GhosttyRenderStateData", "ROW_ITERATOR"),
      s.rowIterSlot,
    );

    const out: Row[] = [];
    let y = -1;
    while (g.call("ghostty_render_state_row_iterator_next", s.rowIter)) {
      y++;
      if (!want(y)) continue;
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
      // Copy the row's words out first: the per-cell calls below can grow
      // memory, which would detach a view over the borrowed cells.
      const words = new Uint32Array(view.len * 2);
      words.set(new Uint32Array(g.memory.buffer, view.ptr, view.len * 2));
      const decode = cellDecoder(g);

      let cellsSelected = false;
      const row: Cell[] = [];
      for (let x = 0; x < view.len; x++) {
        const d = decode(
          words[x * 2]!,
          words[x * 2 + 1]!,
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
      out.push({ y, cells: row });
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
    this.consumers.clear();
    const s = this.scratch;
    if (s) {
      g.free(s.u16, 2);
      g.freeType(s.cursor, "GhosttyRenderStateCursor");
      g.freeType(s.scrollbar, "GhosttyTerminalScrollbar");
      g.freeType(s.modeConfig, "GhosttyTerminalModeConfig");
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
      u16: g.alloc(2),
      cursor: g.allocType("GhosttyRenderStateCursor"),
      scrollbar: g.allocType("GhosttyTerminalScrollbar"),
      modeConfig: g.allocType("GhosttyTerminalModeConfig"),
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

/** The GhosttyCell decoder compiled from the type JSON, once per module. */
const cellDecoders = new WeakMap<GhosttyModule, PackedDecoder>();

function cellDecoder(g: GhosttyModule): PackedDecoder {
  let d = cellDecoders.get(g);
  if (!d) {
    d = g.layout.packedDecoder("GhosttyCell");
    cellDecoders.set(g, d);
  }
  return d;
}

/** GhosttyCell as the packed decoder returns it on the pinned build. */
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

function sameCursor(a: CursorState, b: CursorState): boolean {
  return (
    a.x === b.x &&
    a.y === b.y &&
    a.inViewport === b.inViewport &&
    a.visible === b.visible &&
    a.blinking === b.blinking &&
    a.style === b.style &&
    a.wideTail === b.wideTail &&
    a.passwordInput === b.passwordInput
  );
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
