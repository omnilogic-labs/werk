// The engine seam from the proposal, §5: one interface, adapters chosen per
// session at runtime. Every capability an adapter lacks comes back as an
// `Unsupported` value rather than a throw, so the capability matrix is
// output of the program rather than a hand-maintained table.

/** A capability this engine does not provide. Returned, never thrown. */
export class Unsupported {
  readonly unsupported = true as const;
  constructor(readonly reason: string) {}
}

export function isUnsupported(v: unknown): v is Unsupported {
  return v instanceof Unsupported;
}

/** Keys are the seam's method names; true means the adapter implements it. */
export type Capabilities = Readonly<Record<CapabilityName, boolean>>;

export type CapabilityName =
  | "write"
  | "resize"
  | "plainText"
  | "styledCells"
  | "emitVt"
  | "encodeState"
  | "decodeState"
  | "renderConsumer"
  | "effects"
  | "encodeKey"
  | "encodeMouse";

/**
 * Semantic events the emulator reports while consuming PTY output. `other`
 * carries anything an adapter can observe that the seam has no name for yet.
 */
export type Effect =
  | { kind: "title"; title: string }
  | { kind: "pwd"; pwd: string }
  | { kind: "bell" }
  | { kind: "progress"; state: string; progress: number | null }
  | { kind: "notification"; title: string; body: string }
  | { kind: "write-pty"; bytes: Uint8Array }
  | { kind: "other"; name: string; detail?: unknown };

export type Color =
  | { kind: "default" }
  | { kind: "palette"; index: number }
  | { kind: "rgb"; r: number; g: number; b: number };

export interface Cell {
  /** The grapheme cluster in this cell; "" for an empty cell and for a wide-cell continuation. */
  text: string;
  fg: Color;
  bg: Color;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
  strikethrough: boolean;
  /** 1 for narrow, 2 for wide; 0 for the spacer cell after a wide character. */
  width: 0 | 1 | 2;
}

export interface Row {
  y: number;
  cells: Cell[];
}

/**
 * One step of history restored by `decodeState().next()`: the screen the
 * page belongs to, the rows it prepended (0 when the page was validated
 * but could no longer be applied, say after a resize), and the pages still
 * to come for that screen. `next()` returning null is the only signal that
 * the whole snapshot is done. Shape is provisional until M3 uses it.
 */
export interface Page {
  screen: "primary" | "alternate";
  rows: number;
  remaining: number;
}

/** Modifier keys held during a key or mouse event. Lock states matter to the key encoder's keypad handling. */
export interface Mods {
  shift?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  super?: boolean;
  capsLock?: boolean;
  numLock?: boolean;
}

/**
 * A key event as a browser (or any client) sees it, shaped after libghostty's
 * key event: a physical key, the text the layout produces for it, and the
 * modifiers. The encoder derives control and alt sequences from the key and
 * the modifiers, not from the text.
 */
export interface KeyEvent {
  action: "press" | "release" | "repeat";
  /**
   * The physical key as a W3C `KeyboardEvent.code` value: "KeyA", "Digit1",
   * "ArrowUp", "Enter", "F1", "Numpad0", "BracketLeft". A code the engine
   * does not know encodes as an unidentified key, so a key that only
   * carries text still produces that text.
   */
  key: string;
  mods: Mods;
  /**
   * The text the key produces in the current layout before any Ctrl or Alt
   * transformation: `KeyboardEvent.key` when that is one printable
   * character. Omit for control, function and modifier keys.
   */
  utf8?: string;
  /** The codepoint the key produces with no modifiers held; defaults to the first codepoint of `utf8`. */
  unshiftedCodepoint?: number;
  /** The event is part of an IME composition; such events encode to nothing. */
  composing?: boolean;
}

/** Button numbering for `MouseEvent.button`; it is libghostty's. A wheel tick is a press of a wheel button. */
export const MouseButton = {
  none: 0,
  left: 1,
  right: 2,
  middle: 3,
  wheelUp: 4,
  wheelDown: 5,
  wheelLeft: 6,
  wheelRight: 7,
} as const;

/**
 * A mouse event in the terminal's cell grid. Motion while a button is held
 * carries that button; motion with none held carries `MouseButton.none`.
 */
export interface MouseEvent {
  action: "press" | "release" | "motion";
  /** `MouseButton.*`, or 8–11 for further buttons. */
  button: number;
  /** Cell position, 0-based from the viewport's top-left; fractions are fine. */
  x: number;
  y: number;
  mods: Mods;
  /**
   * The same position in pixels with the cell size, for SGR-pixels mode
   * (DEC 1016), which reports pixels. Without it the pixel format reports
   * the cell position as though cells were one pixel square.
   */
  pixels?: { x: number; y: number; cellWidth: number; cellHeight: number };
}

/**
 * The terminal state an input encoder is configured from. Everything here
 * except `optionAsAlt` can be read off a live terminal
 * (`VtTerminal.modes()`). An undefined field means the terminal's reset
 * default: `ignoreKeypadWithNumlock` and `altEscPrefix` on, the rest off.
 */
export interface TerminalModes {
  /** DEC 1 (DECCKM): arrows and Home/End send SS3 rather than CSI. */
  cursorKeyApplication?: boolean;
  /** DEC 66 (DECNKM): the keypad sends application sequences. */
  keypadApplication?: boolean;
  /** DEC 1035: keypad keys follow Num Lock. */
  ignoreKeypadWithNumlock?: boolean;
  /** DEC 1036: Alt prefixes the key with ESC. */
  altEscPrefix?: boolean;
  /** xterm modifyOtherKeys state 2 (`CSI > 4 ; 2 m`). */
  modifyOtherKeys2?: boolean;
  /** The Kitty keyboard protocol flags in force (`CSI > flags u`). */
  kittyKeyboardFlags?: number;
  /** DEC 67 (DECBKM): Backspace sends BS (0x08) instead of DEL (0x7f). */
  backarrowKeyMode?: boolean;
  /** A client preference, not a terminal mode: which Option key acts as Alt on macOS. */
  optionAsAlt?: "false" | "true" | "left" | "right";
  /** The strongest mouse tracking mode set: DEC 9, 1000, 1002, 1003. */
  mouseTracking?: "none" | "x10" | "normal" | "button" | "any";
  /** The mouse report format: DEC 1005, 1006, 1015, 1016, else X10. */
  mouseFormat?: "x10" | "utf8" | "sgr" | "urxvt" | "sgr-pixels";
  /** DEC 2004. The encoders do not use it; a client wrapping a paste does. */
  bracketedPaste?: boolean;
  /** DEC 1004. As above, for focus in/out. */
  focusEvents?: boolean;
}

/**
 * What `emitVt` writes beyond the styled text. `cursor` places the cursor
 * (CUP); `style` restores the SGR state active at the cursor, so the next
 * byte the program writes gets the attributes it expects; both default to
 * on. `scrollback` selects the whole active screen, scrollback then
 * viewport, rather than the viewport alone, which is the default.
 */
export interface EmitVtOptions {
  cursor?: boolean;
  style?: boolean;
  scrollback?: boolean;
}

export interface CursorState {
  /** Viewport position, 0-based. Meaningless when `inViewport` is false. */
  x: number;
  y: number;
  /** False when the viewport is scrolled away from the cursor's row. */
  inViewport: boolean;
  /** DEC 25. */
  visible: boolean;
  blinking: boolean;
  style: "bar" | "block" | "underline" | "block-hollow";
  /** The cursor sits on the spacer tail of a wide character. */
  wideTail: boolean;
  passwordInput: boolean;
}

/** Where the viewport sits in the scrollable area, in rows; the shape of a scrollbar. */
export interface Viewport {
  /** Scrollback plus the active area. */
  total: number;
  /** Rows above the viewport's first row. */
  offset: number;
  /** Viewport height. */
  rows: number;
  /** The viewport is pinned to the active area rather than scrolled into history. */
  active: boolean;
}

/**
 * One update's worth of change for a consumer. `changed` holds every row
 * when `dirtyAll` is set (a scroll, clear, resize or screen switch) and
 * only the rows that changed since this consumer's previous frame
 * otherwise. The cursor is reported every frame because a hide, show or
 * shape change does not mark any row dirty; `cursorChanged` is the diff
 * against the consumer's previous frame.
 */
export interface Frame {
  cols: number;
  rows: number;
  dirtyAll: boolean;
  changed: Row[];
  cursor: CursorState;
  cursorChanged: boolean;
  viewport: Viewport;
}

/**
 * A client's view of the terminal's changes. Each consumer keeps its own
 * dirty cursor, so a slow client reading after a fast one still sees
 * everything that changed since its own last read. A new consumer's first
 * frame is the whole screen.
 */
export interface RenderConsumer {
  /** `frame().changed`: the rows to redraw, each with its viewport y. */
  dirtyRows(): Iterable<Row>;
  frame(): Frame;
  dispose(): void;
}

export interface DecodedState {
  ready(): VtTerminal;
  next(): Page | null;
}

export interface VtEngine {
  readonly id: string; // "ghostty-wasm" | "ghostty-ffi" | "xterm-oracle"
  readonly caps: Capabilities;
  create(opts: { cols: number; rows: number; scrollback: number }): VtTerminal;

  // reattach mechanism 2, decode side — decoding makes a new terminal, so it
  // lives on the engine rather than on an instance
  decodeState(bytes: Uint8Array): DecodedState | Unsupported;

  // browser input -> PTY bytes; needed by any client running this emulator
  encodeKey(ev: KeyEvent, mode: TerminalModes): Uint8Array | Unsupported;
  encodeMouse(ev: MouseEvent, mode: TerminalModes): Uint8Array | Unsupported;
}

export interface VtTerminal {
  write(bytes: Uint8Array): void; // PTY output in
  resize(cols: number, rows: number): void;

  // reattach mechanism 1 — for a CLI client in someone else's terminal
  emitVt(opts?: EmitVtOptions): Uint8Array | Unsupported;

  // reattach mechanism 2, encode side
  encodeState(): Uint8Array | Unsupported;

  // incremental update for the web surface; one consumer per attached client
  renderConsumer(): RenderConsumer | Unsupported;

  // semantic metadata, for the "needs you" signal
  onEffect(cb: (e: Effect) => void): void | Unsupported;

  // the modes the engine's encoders need, read off the live terminal, so a
  // client can do engine.encodeKey(ev, term.modes())
  modes(): TerminalModes | Unsupported;

  plainText(): string; // the lowest common denominator, for differential testing
  styledCells(): Cell[][]; // text plus attributes, for the same purpose
  dispose(): void;
}
