// The `ghostty-ffi` adapter: the seam over `libghostty-vt`
// (prime-radiant-inc/ts-libghostty), a community binding that dlopens a
// prebuilt libghostty-vt through `bun:ffi`. It exists to answer the
// WASM-versus-native question on identical calls; every gap in the
// binding's surface comes back as `Unsupported` with the reason, so the
// capability matrix stays honest as the package moves.
//
// The module namespace is injected rather than imported here so that a
// dlopen failure (unsupported platform, a compiled binary with nothing to
// extract) surfaces once, at engine load, with the binding's own error.

import type * as Lib from "libghostty-vt";
import type {
  Capabilities,
  Cell,
  CursorState,
  DecodedState,
  Effect,
  EmitVtOptions,
  Frame,
  KeyEvent,
  MouseEvent,
  RenderConsumer,
  Row,
  TerminalModes,
  Viewport,
  VtEngine,
  VtTerminal,
} from "../types.ts";
import { Unsupported } from "../types.ts";

export type LibGhosttyVt = typeof Lib;

export interface CreateOptions {
  cols: number;
  rows: number;
  scrollback: number;
}

const CAPS: Capabilities = {
  write: true,
  resize: true,
  plainText: true,
  styledCells: true,
  emitVt: true,
  encodeState: false,
  decodeState: false,
  renderConsumer: true,
  effects: true,
  encodeKey: true,
  encodeMouse: false,
};

const NO_SNAPSHOT =
  "libghostty-vt 0.6.3 dlopens no ghostty_snapshot_* symbol: its pinned Ghostty " +
  "e88c6c09 (2026-04-23) predates snapshot.h";
const NO_MOUSE =
  "libghostty-vt 0.6.3 wraps no mouse encoder; its README lists one as a post-v0 roadmap item";

/** The DEC private modes the binding names, for `decMode(n)` and `modes()`. */
const MODE_NAMES: Record<number, Lib.ModeName> = {
  1: "decckm",
  6: "origin",
  7: "wraparound",
  12: "cursor_blinking",
  25: "cursor_visible",
  47: "alt_screen_legacy",
  66: "keypad_keys",
  67: "backarrow_key_mode",
  9: "x10_mouse",
  1000: "normal_mouse",
  1002: "button_mouse",
  1003: "any_mouse",
  1004: "focus_event",
  1005: "utf8_mouse",
  1006: "sgr_mouse",
  1015: "urxvt_mouse",
  1016: "sgr_pixels_mouse",
  1035: "numlock_keypad",
  1036: "alt_esc_prefix",
  1047: "alt_screen",
  1049: "alt_screen_save",
  2004: "bracketed_paste",
  2026: "sync_output",
  2027: "grapheme_cluster",
};

/**
 * The binding takes libghostty's byte cap (`max_scrollback`, a `size_t` of
 * page bytes, default 1,000 in the binding and 10,000 upstream) and exposes
 * no line cap. libghostty prunes whole pages, and an 80-column page holds
 * a few hundred rows in roughly half a MiB, so a kibibyte a line lands the
 * retained count within a page or two of the seam's line count, on the
 * generous side. An approximation, recorded as one in findings/m6.md.
 */
function scrollbackBytes(lines: number): number {
  return Math.max(10_000, lines * 1024);
}

export class GhosttyFfiEngine implements VtEngine {
  readonly id = "ghostty-ffi";
  readonly caps = CAPS;
  readonly info: Lib.LibraryInfo;

  private constructor(readonly lib: LibGhosttyVt) {
    this.info = lib.libraryInfo();
  }

  /**
   * Wrap an already-imported module namespace, forcing the dlopen so a
   * missing or incompatible library fails here rather than on the first
   * `create()`. The Bun entry point (bun.ts) does the import and, inside a
   * compiled binary, the extraction that has to precede it.
   */
  static load(lib: LibGhosttyVt): GhosttyFfiEngine {
    const probe = new lib.Terminal({ cols: 1, rows: 1 });
    probe.close();
    return new GhosttyFfiEngine(lib);
  }

  create(opts: CreateOptions): GhosttyFfiTerminal {
    return new GhosttyFfiTerminal(this.lib, opts);
  }

  decodeState(_bytes: Uint8Array): DecodedState | Unsupported {
    return new Unsupported(NO_SNAPSHOT);
  }

  private keyEncoders = new Map<string, Lib.KeyEncoder>();

  /**
   * The binding's `KeyEncoder` configured from the seam's modes. One
   * encoder is kept per distinct configuration; a client's modes change
   * rarely, so the map stays small.
   */
  encodeKey(ev: KeyEvent, modes: TerminalModes): Uint8Array | Unsupported {
    const options: Lib.KeyEncoderOptions = {
      cursorKeyMode: modes.cursorKeyApplication ? "application" : "normal",
      keypadKeyMode: modes.keypadApplication ? "application" : "normal",
      ignoreKeypadWithNumLock: modes.ignoreKeypadWithNumlock ?? true,
      altEscPrefix: modes.altEscPrefix ?? true,
      modifyOtherKeysState2: modes.modifyOtherKeys2 ?? false,
      kittyFlags: modes.kittyKeyboardFlags ?? 0,
      macosOptionAsAlt: modes.optionAsAlt ?? "false",
      backarrowKeyMode: modes.backarrowKeyMode ?? false,
    };
    const key = JSON.stringify(options);
    let enc = this.keyEncoders.get(key);
    if (!enc) {
      enc = new this.lib.KeyEncoder({ options });
      this.keyEncoders.set(key, enc);
    }
    return enc.encode(toLibKeyEvent(ev));
  }

  /** The same encoder configured by libghostty's own `setopt_from_terminal`, for a daemon holding the terminal. */
  encodeKeySynced(term: GhosttyFfiTerminal, ev: KeyEvent): Uint8Array {
    const enc = new this.lib.KeyEncoder({ terminal: term.raw });
    try {
      return enc.encode(toLibKeyEvent(ev));
    } finally {
      enc[Symbol.dispose]();
    }
  }

  encodeMouse(
    _ev: MouseEvent,
    _modes: TerminalModes,
  ): Uint8Array | Unsupported {
    return new Unsupported(NO_MOUSE);
  }
}

/** The seam's key event as the binding's. The shapes match; the binding rejects C0 bytes in `utf8`, so those are dropped. */
function toLibKeyEvent(ev: KeyEvent): Lib.KeyEvent {
  const utf8 =
    ev.utf8 !== undefined && /^[^\x00-\x1f\x7f]+$/.test(ev.utf8)
      ? ev.utf8
      : undefined;
  return {
    key: ev.key as Lib.Key,
    action: ev.action,
    mods: ev.mods,
    utf8,
    unshiftedCodepoint: ev.unshiftedCodepoint,
    composing: ev.composing,
  };
}

/** Per-consumer dirty bookkeeping; the cells live in the shared render state. */
interface ConsumerState {
  all: boolean;
  rows: Set<number>;
  lastCursor: CursorState | null;
}

export class GhosttyFfiTerminal implements VtTerminal {
  readonly raw: Lib.Terminal;
  private rs: Lib.RenderState;
  private cols: number;
  private rows: number;
  private disposed = false;
  private listeners: ((e: Effect) => void)[] = [];
  /** The first exception a listener threw during the current write(); rethrown once the write returns. */
  private listenerError: unknown = undefined;
  private readonly consumers = new Set<ConsumerState>();

  constructor(
    private readonly lib: LibGhosttyVt,
    init: CreateOptions,
  ) {
    this.cols = init.cols;
    this.rows = init.rows;
    // The three callbacks the binding exposes are constructor options, so
    // they are bound now and dispatch to whoever subscribes later. The
    // binding swallows a throwing callback with console.error; the wrapper
    // parks the exception instead, and write() rethrows it.
    this.raw = new lib.Terminal({
      cols: init.cols,
      rows: init.rows,
      maxScrollback: scrollbackBytes(init.scrollback),
      onBell: () => this.dispatch({ kind: "bell" }),
      onTitleChanged: (title) => this.dispatch({ kind: "title", title }),
      onWritePty: (bytes) => this.dispatch({ kind: "write-pty", bytes }),
    });
    this.rs = new lib.RenderState();
  }

  private assertLive(): void {
    if (this.disposed) throw new Error("terminal is disposed");
  }

  get size(): { cols: number; rows: number } {
    return { cols: this.cols, rows: this.rows };
  }

  write(bytes: Uint8Array): void {
    this.assertLive();
    this.raw.vtWrite(bytes);
    // No pwd effect: the binding has no PWD_CHANGED callback, and its
    // `snapshot().pwd` stayed undefined for every OSC 7 form tried
    // (findings/m6.md), so there is nothing to compare after a write.
    if (this.listenerError !== undefined) {
      const e = this.listenerError;
      this.listenerError = undefined;
      throw e;
    }
  }

  resize(cols: number, rows: number): void {
    this.assertLive();
    this.raw.resize(cols, rows);
    this.cols = cols;
    this.rows = rows;
  }

  /**
   * A re-emission of the viewport through the binding's `toAnsiRect`: every
   * row addressed with CUP, every cell painted, SGR on transition. The
   * binding's `Formatter` (libghostty's own VT formatter) has no selection,
   * so it always emits the whole active screen; `scrollback: true` takes
   * that route. The pending SGR at the cursor (`style`) is not readable
   * through this binding, so only the formatter route honours it.
   */
  emitVt(opts: EmitVtOptions = {}): Uint8Array | Unsupported {
    this.assertLive();
    const cursor = opts.cursor ?? true;
    if (opts.scrollback) {
      const f = new this.lib.Formatter({
        format: "vt",
        cursor,
        style: opts.style ?? true,
        hyperlink: true,
        protection: true,
        kittyKeyboard: true,
        charsets: true,
      });
      try {
        return f.format(this.raw);
      } finally {
        f.close();
      }
    }
    this.sync();
    const rect = { row: 1, col: 1, cols: this.cols, rows: this.rows };
    let out = "\x1b[0m" + this.rs.toAnsiRect(rect);
    if (cursor) {
      const c = this.rs.cursorInRect(rect);
      if (c) out += `\x1b[${c.row};${c.col}H`;
    }
    return new TextEncoder().encode(out);
  }

  encodeState(): Uint8Array | Unsupported {
    return new Unsupported(NO_SNAPSHOT);
  }

  /**
   * The same per-consumer fan-out the WASM adapter builds: the binding's
   * `RenderState` is a single consumer of libghostty's dirty flags (its
   * own doc says a second `update()` in the same cycle sees nothing), so
   * one shared state is updated in `sync()` and what it reports is handed
   * to every consumer before it is cleaned.
   */
  renderConsumer(): RenderConsumer | Unsupported {
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
      this.sync();
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
   * The only place the render state is updated. `Terminal.renderToAnsiRect`
   * and any second `RenderState` would consume the terminal's dirty flags
   * behind this one's back, so the adapter never uses them.
   */
  private sync(): void {
    this.rs.update(this.raw);
    if (this.consumers.size > 0) {
      const dirty = this.rs.dirty();
      if (dirty === "all") {
        for (const c of this.consumers) c.all = true;
      } else if (dirty === "rows") {
        this.rs.forEachDirtyRow((row) => {
          for (const c of this.consumers) if (!c.all) c.rows.add(row.y);
        });
      }
    }
    this.rs.markClean();
  }

  /** The render state's cursor after a sync, filled out with what the terminal snapshot adds. */
  private readCursor(): CursorState {
    const c = this.rs.cursor();
    const snap = this.raw.snapshot();
    return {
      x: c?.x ?? 0,
      y: c?.y ?? 0,
      inViewport: c !== undefined,
      visible: snap.cursor.visible,
      // The binding exposes neither the blink state nor the visual style.
      blinking: false,
      style: "block",
      wideTail: c?.wideTail ?? false,
      passwordInput: false,
    };
  }

  /**
   * The binding has no scrollbar query, so the offset assumes the viewport
   * is pinned to the active area, which it is unless something called
   * `raw.scrollViewport`.
   */
  viewport(): Viewport {
    const total = this.raw.snapshot().scrollbackRows + this.rows;
    return {
      total,
      offset: total - this.rows,
      rows: this.rows,
      active: true,
    };
  }

  private readRows(want: (y: number) => boolean): Row[] {
    const out: Row[] = [];
    for (const row of this.rs.rows()) {
      if (!want(row.y)) continue;
      const cells: Cell[] = [];
      for (const c of row.cells()) cells.push(toCell(c));
      out.push({ y: row.y, cells });
    }
    return out;
  }

  onEffect(cb: (e: Effect) => void): void {
    this.assertLive();
    this.listeners.push(cb);
  }

  private dispatch(e: Effect): void {
    for (const cb of this.listeners) {
      try {
        cb(e);
      } catch (err) {
        if (this.listenerError === undefined) this.listenerError = err;
      }
    }
  }

  /** A DEC private mode the binding names; throws for one it does not. */
  decMode(mode: number): boolean {
    this.assertLive();
    const name = MODE_NAMES[mode];
    if (!name) throw new Error(`libghostty-vt names no DEC mode ${mode}`);
    return this.raw.mode(name);
  }

  /**
   * What the binding can read: the DEC modes. It has no getter for the
   * Kitty keyboard flags or modifyOtherKeys (its own `KeyEncoder` reads
   * them natively through `syncFromTerminal`; see `encodeKeySynced`), so
   * those stay undefined.
   */
  modes(): TerminalModes | Unsupported {
    this.assertLive();
    const m = (n: number) => this.raw.mode(MODE_NAMES[n]!);
    const modes: TerminalModes = {
      cursorKeyApplication: m(1),
      keypadApplication: m(66),
      ignoreKeypadWithNumlock: m(1035),
      altEscPrefix: m(1036),
      backarrowKeyMode: m(67),
      bracketedPaste: m(2004),
      focusEvents: m(1004),
      mouseTracking: m(1003)
        ? "any"
        : m(1002)
          ? "button"
          : m(1000)
            ? "normal"
            : m(9)
              ? "x10"
              : "none",
      mouseFormat: m(1016)
        ? "sgr-pixels"
        : m(1006)
          ? "sgr"
          : m(1015)
            ? "urxvt"
            : m(1005)
              ? "utf8"
              : "x10",
    };
    return modes;
  }

  cursor(): { x: number; y: number } {
    this.assertLive();
    const c = this.raw.snapshot().cursor;
    return { x: c.x, y: c.y };
  }

  activeScreen(): "primary" | "alternate" {
    this.assertLive();
    return this.raw.snapshot().activeScreen;
  }

  /** The viewport as text: `rows` lines, trailing whitespace trimmed, from the render state's cells. */
  plainText(): string {
    this.assertLive();
    this.sync();
    const lines: string[] = [];
    for (const row of this.rs.rows()) {
      let s = "";
      // An empty cell is a space in the middle of a line, as the formatter renders it.
      for (const c of row.cells())
        if (!c.isWideContinuation) s += c.text || " ";
      lines.push(s.replace(/\s+$/, ""));
    }
    while (lines.length < this.rows) lines.push("");
    return lines.slice(0, this.rows).join("\n");
  }

  /** The whole active screen as text, scrollback first, through libghostty's plain formatter; what `wp logs` wants. */
  fullText(): string {
    this.assertLive();
    const f = new this.lib.Formatter({ format: "plain", trim: true });
    try {
      return f.formatString(this.raw);
    } finally {
      f.close();
    }
  }

  styledCells(): Cell[][] {
    this.assertLive();
    this.sync();
    return this.readRows(() => true).map((r) => r.cells);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.consumers.clear();
    this.rs.close();
    this.raw.close();
  }
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

function toColor(c: Lib.RGB | Lib.PaletteIndex | undefined): Cell["fg"] {
  if (c === undefined) return { kind: "default" };
  if ("palette" in c) return { kind: "palette", index: c.palette };
  return { kind: "rgb", r: c[0], g: c[1], b: c[2] };
}

function toCell(c: Lib.RenderCell): Cell {
  const st = c.style;
  return {
    text: c.isWideContinuation ? "" : c.text,
    fg: toColor(st?.fg),
    bg: toColor(st?.bg),
    bold: st?.bold ?? false,
    italic: st?.italic ?? false,
    underline: st !== undefined && st.underline !== "none",
    inverse: st?.inverse ?? false,
    strikethrough: st?.strikethrough ?? false,
    width: c.isWideContinuation ? 0 : c.wide ? 2 : 1,
  };
}
