// The `xterm-oracle` adapter: headless xterm.js 6 with `reflowCursorLine`
// behind the seam. Not a candidate — a second, independent emulator fed
// the same bytes so the differential corpus can flag where the two
// libghostty adapters and it disagree. It implements what the corpus
// compares (write, resize, plainText, styledCells, emitVt, effects) and
// nothing else; every other method answers "not a candidate; oracle only".
//
// xterm's `write` is asynchronous: the bytes are queued and parsed on a
// later tick, and the callback fires when they have been. The seam's
// `write` is synchronous, so the adapter queues and exposes `flush()`; a
// reader that does not `await term.flush()` first reads a stale buffer.
// The runner in bench/differential.ts awaits it after every step.

import { SerializeAddon } from "@xterm/addon-serialize";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Terminal, type IBufferCell } from "@xterm/headless";
import type {
  Capabilities,
  Cell,
  DecodedState,
  Effect,
  EmitVtOptions,
  KeyEvent,
  MouseEvent,
  RenderConsumer,
  TerminalModes,
  VtEngine,
  VtTerminal,
} from "../types.ts";
import { Unsupported } from "../types.ts";

const ORACLE_ONLY = "not a candidate; oracle only";

const CAPS: Capabilities = {
  write: true,
  resize: true,
  plainText: true,
  styledCells: true,
  emitVt: true,
  encodeState: false,
  decodeState: false,
  renderConsumer: false,
  effects: true,
  encodeKey: false,
  encodeMouse: false,
};

export interface CreateOptions {
  cols: number;
  rows: number;
  scrollback: number;
}

export class XtermOracleEngine implements VtEngine {
  readonly id = "xterm-oracle";
  readonly caps = CAPS;

  create(opts: CreateOptions): XtermOracleTerminal {
    return new XtermOracleTerminal(opts);
  }

  decodeState(_bytes: Uint8Array): DecodedState | Unsupported {
    return new Unsupported(ORACLE_ONLY);
  }

  encodeKey(_ev: KeyEvent, _modes: TerminalModes): Uint8Array | Unsupported {
    return new Unsupported(ORACLE_ONLY);
  }

  encodeMouse(
    _ev: MouseEvent,
    _modes: TerminalModes,
  ): Uint8Array | Unsupported {
    return new Unsupported(ORACLE_ONLY);
  }
}

export class XtermOracleTerminal implements VtTerminal {
  readonly raw: Terminal;
  private readonly serializer: SerializeAddon;
  private listeners: ((e: Effect) => void)[] = [];
  private disposed = false;
  /** The tail of the write queue; `flush()` awaits it. */
  private queue: Promise<void> = Promise.resolve();
  private pending = 0;
  private cols: number;
  private rows: number;

  constructor(init: CreateOptions) {
    this.cols = init.cols;
    this.rows = init.rows;
    this.raw = new Terminal({
      cols: init.cols,
      rows: init.rows,
      scrollback: init.scrollback,
      allowProposedApi: true,
      reflowCursorLine: true,
    });
    this.serializer = new SerializeAddon();
    this.raw.loadAddon(this.serializer);
    // xterm's built-in width table is Unicode 6, under which emoji are
    // narrow; the unicode11 addon is what deployments load, and what
    // libghostty's widths are closest to. Grapheme clustering (DEC 2027)
    // has no xterm equivalent short of the graphemes addon, which is not
    // loaded, so the oracle always behaves as 2027-off.
    this.raw.loadAddon(new Unicode11Addon());
    this.raw.unicode.activeVersion = "11";
    this.hookEffects();
  }

  /**
   * The effects hooks the proposal's §5 names: OSC handlers through the
   * parser API, the bell through `onBell`, and query replies (DSR, DA)
   * through `onData`, which is where xterm puts what a program would
   * receive. Handlers return false so xterm's own handling of a sequence
   * (the title, say) still runs after ours.
   */
  private hookEffects(): void {
    const p = this.raw.parser;
    const title = (data: string) => {
      this.dispatch({ kind: "title", title: data });
      return false;
    };
    p.registerOscHandler(0, title);
    p.registerOscHandler(2, title);
    p.registerOscHandler(7, (data) => {
      this.dispatch({ kind: "pwd", pwd: data });
      return false;
    });
    p.registerOscHandler(9, (data) => {
      if (data.startsWith("4;")) {
        // OSC 9 ; 4 ; state [; progress] — ConEmu progress, as libghostty reports it.
        const [, st, pr] = data.split(";");
        const states: Record<string, string> = {
          "0": "remove",
          "1": "set",
          "2": "error",
          "3": "indeterminate",
          "4": "pause",
        };
        this.dispatch({
          kind: "progress",
          state: states[st ?? ""] ?? `state-${st}`,
          progress: pr === undefined || pr === "" ? null : Number(pr),
        });
      } else {
        this.dispatch({ kind: "notification", title: "", body: data });
      }
      return false;
    });
    p.registerOscHandler(777, (data) => {
      // OSC 777 ; notify ; title ; body (rxvt-unicode)
      const parts = data.split(";");
      if (parts[0] === "notify")
        this.dispatch({
          kind: "notification",
          title: parts[1] ?? "",
          body: parts.slice(2).join(";"),
        });
      else this.dispatch({ kind: "other", name: "osc777", detail: data });
      return false;
    });
    p.registerOscHandler(133, (data) => {
      this.dispatch({ kind: "other", name: "osc133", detail: data });
      return false;
    });
    this.raw.onBell(() => this.dispatch({ kind: "bell" }));
    this.raw.onData((s) =>
      this.dispatch({ kind: "write-pty", bytes: new TextEncoder().encode(s) }),
    );
  }

  private dispatch(e: Effect): void {
    for (const cb of this.listeners) cb(e);
  }

  private assertLive(): void {
    if (this.disposed) throw new Error("terminal is disposed");
  }

  get size(): { cols: number; rows: number } {
    return { cols: this.cols, rows: this.rows };
  }

  /** Queued; the bytes are copied because xterm keeps a reference until it parses them. */
  write(bytes: Uint8Array): void {
    this.assertLive();
    const copy = bytes.slice();
    this.pending++;
    this.queue = this.queue.then(
      () =>
        new Promise<void>((resolve) => {
          if (this.disposed) {
            this.pending--;
            resolve();
            return;
          }
          this.raw.write(copy, () => {
            this.pending--;
            resolve();
          });
        }),
    );
  }

  /** Queued behind the writes before it, so a write-then-resize replays in order. */
  resize(cols: number, rows: number): void {
    this.assertLive();
    this.cols = cols;
    this.rows = rows;
    this.pending++;
    this.queue = this.queue.then(() => {
      this.pending--;
      if (!this.disposed) this.raw.resize(cols, rows);
    });
  }

  /** Resolves once every queued write and resize has been applied. */
  flush(): Promise<void> {
    return this.queue;
  }

  /** Writes and resizes queued and not yet applied. */
  get queued(): number {
    return this.pending;
  }

  /**
   * The serialize addon: the whole buffer with SGR runs, a cursor move at
   * the end, and the modes in force. `scrollback: false` (the default)
   * limits it to the viewport. It has no switch for the cursor or the
   * pending style, so `cursor` and `style` are ignored.
   */
  emitVt(opts: EmitVtOptions = {}): Uint8Array | Unsupported {
    this.assertLive();
    const s = this.serializer.serialize({
      scrollback: opts.scrollback ? undefined : 0,
    });
    return new TextEncoder().encode(s);
  }

  encodeState(): Uint8Array | Unsupported {
    return new Unsupported(ORACLE_ONLY);
  }

  renderConsumer(): RenderConsumer | Unsupported {
    return new Unsupported(ORACLE_ONLY);
  }

  onEffect(cb: (e: Effect) => void): void {
    this.assertLive();
    this.listeners.push(cb);
  }

  /** What xterm exposes through `Terminal.modes`; the rest stays undefined. */
  modes(): TerminalModes | Unsupported {
    this.assertLive();
    const m = this.raw.modes;
    const tracking: Record<string, TerminalModes["mouseTracking"]> = {
      none: "none",
      x10: "x10",
      vt200: "normal",
      drag: "button",
      any: "any",
    };
    return {
      cursorKeyApplication: m.applicationCursorKeysMode,
      keypadApplication: m.applicationKeypadMode,
      bracketedPaste: m.bracketedPasteMode,
      focusEvents: m.sendFocusMode,
      mouseTracking: tracking[m.mouseTrackingMode] ?? "none",
    };
  }

  /** The few DEC modes xterm reports; throws for the rest, which the daemon's `altScreen()` treats as "cannot say". */
  decMode(mode: number): boolean {
    this.assertLive();
    const m = this.raw.modes;
    switch (mode) {
      case 1:
        return m.applicationCursorKeysMode;
      case 6:
        return m.originMode;
      case 7:
        return m.wraparoundMode;
      case 47:
      case 1047:
      case 1049:
        return this.raw.buffer.active.type === "alternate";
      case 1004:
        return m.sendFocusMode;
      case 2004:
        return m.bracketedPasteMode;
      case 2026:
        return m.synchronizedOutputMode;
      default:
        throw new Error(`xterm.js reports no DEC mode ${mode}`);
    }
  }

  activeScreen(): "primary" | "alternate" {
    return this.raw.buffer.active.type === "alternate"
      ? "alternate"
      : "primary";
  }

  cursor(): { x: number; y: number } {
    const b = this.raw.buffer.active;
    return { x: b.cursorX, y: b.cursorY };
  }

  /**
   * The viewport: `rows` lines, wide characters once, trailing whitespace
   * trimmed. xterm's own trim (`translateToString(true)`) drops only cells
   * never written, so a written trailing space survives it; the libghostty
   * adapters' formatter trims whitespace, and the regex makes the three
   * comparable.
   */
  plainText(): string {
    this.assertLive();
    const b = this.raw.buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < this.rows; y++) {
      const line = b.getLine(b.viewportY + y);
      lines.push(
        (line ? line.translateToString(true) : "").replace(/\s+$/, ""),
      );
    }
    return lines.join("\n");
  }

  /** The whole buffer, scrollback first, one line per row. */
  fullText(): string {
    this.assertLive();
    const b = this.raw.buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < b.length; y++)
      lines.push(b.getLine(y)?.translateToString(true) ?? "");
    return lines.join("\n");
  }

  styledCells(): Cell[][] {
    this.assertLive();
    const b = this.raw.buffer.active;
    const out: Cell[][] = [];
    const scratch = b.getNullCell();
    for (let y = 0; y < this.rows; y++) {
      const line = b.getLine(b.viewportY + y);
      const row: Cell[] = [];
      for (let x = 0; x < this.cols; x++) {
        const c = line?.getCell(x, scratch);
        row.push(c ? toCell(c) : emptyCell());
      }
      out.push(row);
    }
    return out;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.raw.dispose();
  }
}

function emptyCell(): Cell {
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

function toCell(c: IBufferCell): Cell {
  const width = c.getWidth() as 0 | 1 | 2;
  const fg = c.isFgDefault()
    ? ({ kind: "default" } as const)
    : c.isFgPalette()
      ? ({ kind: "palette", index: c.getFgColor() } as const)
      : rgb(c.getFgColor());
  const bg = c.isBgDefault()
    ? ({ kind: "default" } as const)
    : c.isBgPalette()
      ? ({ kind: "palette", index: c.getBgColor() } as const)
      : rgb(c.getBgColor());
  return {
    text: width === 0 ? "" : c.getChars(),
    fg,
    bg,
    bold: c.isBold() !== 0,
    italic: c.isItalic() !== 0,
    underline: c.isUnderline() !== 0,
    inverse: c.isInverse() !== 0,
    strikethrough: c.isStrikethrough() !== 0,
    width,
  };
}

function rgb(v: number): Cell["fg"] {
  return {
    kind: "rgb",
    r: (v >> 16) & 0xff,
    g: (v >> 8) & 0xff,
    b: v & 0xff,
  };
}
