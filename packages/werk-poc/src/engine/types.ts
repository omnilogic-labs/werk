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

export interface KeyEvent {
  action: "press" | "release" | "repeat";
  key: string;
  mods: { shift?: boolean; ctrl?: boolean; alt?: boolean; super?: boolean };
  utf8?: string;
  unshiftedCodepoint?: number;
}

export interface MouseEvent {
  action: "press" | "release" | "motion" | "scroll";
  button: number;
  x: number;
  y: number;
  mods: { shift?: boolean; ctrl?: boolean; alt?: boolean; super?: boolean };
}

/** The terminal modes an input encoder needs to know about. Provisional until the encoders exist. */
export interface TerminalModes {
  cursorKeyApplication?: boolean;
  keypadApplication?: boolean;
  kittyKeyboardFlags?: number;
  mouseTracking?: "none" | "x10" | "normal" | "button" | "any";
  mouseFormat?: "x10" | "utf8" | "sgr" | "urxvt" | "sgr-pixels";
  bracketedPaste?: boolean;
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

export interface RenderConsumer {
  dirtyRows(): Iterable<Row>;
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

  plainText(): string; // the lowest common denominator, for differential testing
  styledCells(): Cell[][]; // text plus attributes, for the same purpose
  dispose(): void;
}
