import type { Roles } from "@werk/palette";
export interface Size {
  cols: number;
  rows: number;
}
export interface TerminalOptions {
  /** Page-memory budget: 0 disables history; 4,294,967,295 means unlimited. */
  scrollbackBytes?: number;
  /**
   * The colours this replica paints in: the two a child's output starts with,
   * and the sixteen it gets when it asks for one by index. Defaults to werk's
   * own default flavour.
   */
  theme?: Roles;
}
export interface Scrollback {
  /** null means the snapshot or engine has no explicit byte limit. */
  maxBytes: number | null;
  rows: number;
}
export interface SnapshotEnvelope {
  engineBuild: string;
  formatVersion: number;
  size: Size;
  bytes: Uint8Array;
}
export interface TerminalEffect {
  kind: string;
  payload: unknown;
}
export interface Cell {
  text: string;
  width: number;
  fg: number;
  bg: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
  strikethrough: boolean;
}
export interface Frame extends Size {
  changed: { y: number; cells: Cell[] }[];
  cursor: { x: number; y: number; visible: boolean };
}
export interface Renderer {
  paint(frame: Frame): void;
  dispose(): void;
}
export interface RendererHost {
  mount: unknown;
  /**
   * The colours the surface starts painted in, before a cell says otherwise.
   * A renderer that owns its own pixels needs the ground as well as the cells.
   */
  theme?: Roles;
}
export type RendererFactory = (host: RendererHost) => Promise<Renderer>;
export interface TerminalCapabilities {
  snapshot: boolean;
  screen: boolean;
  history: boolean;
  scrollbackLimit: boolean;
  preview: boolean;
  cursor: boolean;
  viewport: boolean;
  selection: boolean;
  inputModes: boolean;
}
export interface InputModes {
  applicationCursor: boolean;
  applicationKeypad: boolean;
  bracketedPaste: boolean;
  focusEvents: boolean;
  mouseTracking: "none" | "x10" | "normal" | "button" | "any";
  kittyKeyboardFlags: number;
}
export interface Viewport {
  totalRows: number;
  offset: number;
  visibleRows: number;
}
export interface TerminalHandle {
  readonly size: Size;
  write(bytes: Uint8Array): TerminalEffect[];
  resize(size: Size): void;
  snapshot(): SnapshotEnvelope;
  readScreen(): string;
  /** Format the active screen, independent of the scrolled viewport. */
  formatScreen(format: "plain" | "vt" | "html"): string;
  /** Cursor position on the active screen, without building a frame. */
  cursor(): { x: number; y: number; visible: boolean };
  readHistory(): string;
  scrollback(): Scrollback;
  inputModes(): InputModes;
  viewport(): Viewport;
  scrollViewport(delta: number | "top" | "bottom"): void;
  /** Cell coordinates relative to the visible viewport, inclusive. */
  readSelection(selection: Selection): string;
  frame(): Frame;
  dispose(): void;
}
export interface TerminalEngineFactory {
  readonly buildId: string;
  readonly snapshotFormatVersion: number;
  readonly capabilities: TerminalCapabilities;
  create(size: Size, options?: TerminalOptions): Promise<TerminalHandle>;
  restore(
    snapshot: SnapshotEnvelope,
    options?: TerminalOptions,
  ): Promise<TerminalHandle>;
}
export class UnsupportedSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedSnapshotError";
  }
}
export function validateSize(size: Size): void {
  if (
    ![size.cols, size.rows].every(
      (n) => Number.isInteger(n) && n > 0 && n <= 1000,
    ) ||
    size.cols * size.rows > 250000
  )
    throw new RangeError("Terminal grid exceeds supported dimensions");
}
export function encodePaste(text: string, bracketed = false): Uint8Array {
  return new TextEncoder().encode(
    bracketed ? "\x1b[200~" + text + "\x1b[201~" : text,
  );
}
export function encodeKey(key: string, applicationCursor = false): Uint8Array {
  const arrows: Record<string, string> = {
    ArrowUp: "A",
    ArrowDown: "B",
    ArrowRight: "C",
    ArrowLeft: "D",
  };
  return new TextEncoder().encode(
    arrows[key]
      ? "\x1b" + (applicationCursor ? "O" : "[") + arrows[key]
      : ((
          {
            Enter: "\r",
            Backspace: "\x7f",
            Escape: "\x1b",
            Tab: "\t",
          } as Record<string, string>
        )[key] ?? key),
  );
}
export interface Selection {
  start: { x: number; y: number };
  end: { x: number; y: number };
}
