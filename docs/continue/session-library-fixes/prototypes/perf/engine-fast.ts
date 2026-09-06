// Prototype of a cheaper frame() for @werk/terminal. Scratch only.
// Differences from packages/terminal/src/engine.ts:
//   - one persistent render state, row iterator and cells handle per terminal
//   - the global DIRTY value and per-row DIRTY flags decide which rows are decoded
//   - CELLS_RAW reads a whole row in one call; the packed u64 is decoded in JS
//     using the bit layout from ghostty_type_json
//   - STYLE is read only for cells whose style_id != 0, cached per row by id
//   - colours resolve through COLORS (read once per frame) instead of
//     FG_COLOR/BG_COLOR per cell
//   - graphemes are read only for CODEPOINT_GRAPHEME cells
//   - rows are diffed against a shadow of Cell objects, field by field
//   - after a write, the cursor row and the row above are decoded even when
//     the render state reports nothing dirty (grapheme appends do not mark
//     the row dirty on the pinned build)
import { Abi } from "./abi-cached.ts";
import {
  validateSize,
  UnsupportedSnapshotError,
  type Size,
  type SnapshotEnvelope,
  type TerminalEffect,
  type TerminalHandle,
  type TerminalEngineFactory,
  type Frame,
  type Cell,
  type Selection,
  type InputModes,
} from "/home/mike/Development/omnilogic-labs/werk/packages/terminal/src/types.ts";
export const ENGINE_BUILD = "ghostty-3c1ef5b32fc5ea6b93d28493fabf193f595139cf";
export const SNAPSHOT_FORMAT_VERSION = 1;
export const timing = {
  frames: 0,
  ns: 0,
  decodedRows: 0,
  styleReads: 0,
  fresh: 0,
};
const DEFAULT_FG = 0xd8dee9,
  DEFAULT_BG = 0x161b22;
export async function createTerminalEngine(
  source: Uint8Array | ArrayBuffer | WebAssembly.Module,
): Promise<TerminalEngineFactory> {
  const module =
    source instanceof WebAssembly.Module
      ? source
      : await WebAssembly.compile(source as BufferSource);
  const factory: TerminalEngineFactory = {
    buildId: ENGINE_BUILD,
    snapshotFormatVersion: SNAPSHOT_FORMAT_VERSION,
    capabilities: {
      snapshot: true,
      screen: true,
      history: true,
      cursor: true,
      viewport: true,
      selection: true,
      inputModes: true,
    },
    async create(size) {
      validateSize(size);
      const a = new Abi(await WebAssembly.instantiate(module, {}));
      let h = 0;
      try {
        h = a.handle("ghostty_terminal_new", size.cols, size.rows);
        return new Terminal(a, h, size);
      } catch (e) {
        if (h) a.call("ghostty_terminal_free", h);
        throw e;
      }
    },
    async restore(s) {
      if (
        s.engineBuild !== ENGINE_BUILD ||
        s.formatVersion !== SNAPSHOT_FORMAT_VERSION
      )
        throw new UnsupportedSnapshotError(
          "Snapshot engine build or format is unsupported",
        );
      validateSize(s.size);
      if (s.bytes.length > 64 * 1024 * 1024)
        throw new RangeError("Snapshot exceeds 64 MiB");
      const a = new Abi(await WebAssembly.instantiate(module, {}));
      return a.temporary(s.bytes.length, (p) => {
        a.bytes().set(s.bytes, p);
        const d = a.handle(
          "ghostty_snapshot_decoder_new_buf",
          p,
          s.bytes.length,
        );
        let h = 0;
        try {
          a.temporary(4, (q) => {
            a.write(q, "u32", 1048576);
            a.check(
              "ghostty_snapshot_decoder_set",
              d,
              a.enum("GhosttySnapshotDecoderOption", "MAX_CONTINUATION_BYTES"),
              q,
            );
            a.write(q, "bool", true);
            a.check(
              "ghostty_snapshot_decoder_set",
              d,
              a.enum("GhosttySnapshotDecoderOption", "RETAIN_CONTINUATION"),
              q,
            );
            a.check("ghostty_snapshot_decoder_ready", d, q);
            h = a.read(q, "pointer");
          });
          for (;;) {
            const code = a.call("ghostty_snapshot_decoder_next", d);
            if (code === a.enum("GhosttyResult", "NO_VALUE")) break;
            if (code !== 0) throw new Error(`Invalid snapshot: ${code}`);
          }
          const t = new Terminal(a, h, s.size);
          if (
            t.number("COLS") !== s.size.cols ||
            t.number("ROWS") !== s.size.rows
          )
            throw new Error("Snapshot dimensions disagree with envelope");
          return t;
        } catch (e) {
          if (h) a.call("ghostty_terminal_free", h);
          throw e;
        } finally {
          a.call("ghostty_snapshot_decoder_free", d);
        }
      });
    },
  };
  return factory;
}
type BitField = { lsb: number; width: number };
/** Bit extraction over a u64 split into two little-endian u32 words. */
function bits(lo: number, hi: number, f: BitField): number {
  const mask = f.width >= 32 ? 0xffffffff : (1 << f.width) - 1;
  if (f.lsb + f.width <= 32) return (lo >>> f.lsb) & mask;
  if (f.lsb >= 32) return (hi >>> (f.lsb - 32)) & mask;
  return ((lo >>> f.lsb) | (hi << (32 - f.lsb))) & mask;
}
const ascii: string[] = [];
for (let i = 0; i < 128; i++) ascii.push(String.fromCharCode(i));
interface Layout {
  contentTag: BitField;
  codepoint: BitField;
  bgIndex: BitField;
  bgR: BitField;
  bgG: BitField;
  bgB: BitField;
  styleId: BitField;
  wide: BitField;
  tagCodepoint: number;
  tagGrapheme: number;
  tagBgPalette: number;
  tagBgRgb: number;
  styleSize: number;
  fgTag: number;
  fgValue: number;
  bgTag: number;
  bgValue: number;
  bold: number;
  italic: number;
  inverse: number;
  strikethrough: number;
  underline: number;
  colourPalette: number;
  colourRgb: number;
  colorsSize: number;
  paletteOffset: number;
  viewPtr: number;
  viewLen: number;
  dirtyPartial: number;
  dirtyFull: number;
  kDirty: number;
  kRowIterator: number;
  kColors: number;
  kRowDirty: number;
  kCells: number;
  kCellsRaw: number;
  kStyle: number;
  kGraphemesLen: number;
  kGraphemesBuf: number;
}
function layout(a: Abi): Layout {
  const cell = a.types.GhosttyCell as any;
  const content = cell.bits.content;
  const arms = content.arms;
  const rel = (arm: string, name: string): BitField => ({
    lsb: content.lsb + arms[arm].bits[name].lsb,
    width: arms[arm].bits[name].width,
  });
  const style = a.types.GhosttyStyle!;
  const sc = a.types.GhosttyStyleColor!;
  const colors = a.types.GhosttyRenderStateColors!;
  const view = a.types.GhosttyCellsView!;
  return {
    contentTag: cell.bits.content_tag,
    codepoint: rel("CODEPOINT", "codepoint"),
    bgIndex: rel("BG_COLOR_PALETTE", "index"),
    bgR: rel("BG_COLOR_RGB", "r"),
    bgG: rel("BG_COLOR_RGB", "g"),
    bgB: rel("BG_COLOR_RGB", "b"),
    styleId: cell.bits.style_id,
    wide: cell.bits.wide,
    tagCodepoint: a.enum("GhosttyCellContentTag", "CODEPOINT"),
    tagGrapheme: a.enum("GhosttyCellContentTag", "CODEPOINT_GRAPHEME"),
    tagBgPalette: a.enum("GhosttyCellContentTag", "BG_COLOR_PALETTE"),
    tagBgRgb: a.enum("GhosttyCellContentTag", "BG_COLOR_RGB"),
    styleSize: style.size,
    fgTag: style.fields!.fg_color!.offset + sc.fields!.tag!.offset,
    fgValue: style.fields!.fg_color!.offset + sc.fields!.value!.offset,
    bgTag: style.fields!.bg_color!.offset + sc.fields!.tag!.offset,
    bgValue: style.fields!.bg_color!.offset + sc.fields!.value!.offset,
    bold: style.fields!.bold!.offset,
    italic: style.fields!.italic!.offset,
    inverse: style.fields!.inverse!.offset,
    strikethrough: style.fields!.strikethrough!.offset,
    underline: style.fields!.underline!.offset,
    colourPalette: a.enum("GhosttyStyleColorTag", "PALETTE"),
    colourRgb: a.enum("GhosttyStyleColorTag", "RGB"),
    colorsSize: colors.size,
    paletteOffset: colors.fields!.palette!.offset,
    viewPtr: view.fields!.ptr!.offset,
    viewLen: view.fields!.len!.offset,
    dirtyPartial: a.enum("GhosttyRenderStateDirty", "PARTIAL"),
    dirtyFull: a.enum("GhosttyRenderStateDirty", "FULL"),
    kDirty: a.enum("GhosttyRenderStateData", "DIRTY"),
    kRowIterator: a.enum("GhosttyRenderStateData", "ROW_ITERATOR"),
    kColors: a.enum("GhosttyRenderStateData", "COLORS"),
    kRowDirty: a.enum("GhosttyRenderStateRowData", "DIRTY"),
    kCells: a.enum("GhosttyRenderStateRowData", "CELLS"),
    kCellsRaw: a.enum("GhosttyRenderStateRowData", "CELLS_RAW"),
    kStyle: a.enum("GhosttyRenderStateRowCellsData", "STYLE"),
    kGraphemesLen: a.enum("GhosttyRenderStateRowCellsData", "GRAPHEMES_LEN"),
    kGraphemesBuf: a.enum("GhosttyRenderStateRowCellsData", "GRAPHEMES_BUF"),
  };
}
interface Style {
  fg: number;
  bg: number; // -1 when the style has no bg
  bold: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
  strikethrough: boolean;
}
const plain: Style = {
  fg: DEFAULT_FG,
  bg: -1,
  bold: false,
  italic: false,
  underline: false,
  inverse: false,
  strikethrough: false,
};
function same(a: Cell, b: Cell) {
  return (
    a.text === b.text &&
    a.width === b.width &&
    a.fg === b.fg &&
    a.bg === b.bg &&
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.inverse === b.inverse &&
    a.strikethrough === b.strikethrough
  );
}
function blank(): Cell {
  return {
    text: " ",
    width: 1,
    fg: DEFAULT_FG,
    bg: DEFAULT_BG,
    bold: false,
    italic: false,
    underline: false,
    inverse: false,
    strikethrough: false,
  };
}
class Terminal implements TerminalHandle {
  private ended = false;
  private effects: TerminalEffect[] = [];
  private shadow: Cell[][] = [];
  private grid: Size;
  private L: Layout;
  private state: number;
  private iter: number;
  private cellsHandle: number;
  private scratch: number;
  private scratchSize = 1024;
  private forceFull = true;
  private wrote = false;
  private palette = new Uint32Array(256);
  private words = new Uint32Array(0);
  /** What the render state reported for the last frame; diagnostics only. */
  lastDirty = -1;
  get size() {
    return { ...this.grid };
  }
  constructor(
    private a: Abi,
    private h: number,
    size: Size,
  ) {
    this.grid = { ...size };
    this.L = layout(a);
    a.temporary(4, (p) => {
      a.write(p, "u32", 1048576);
      a.check(
        "ghostty_terminal_set",
        h,
        a.enum("GhosttyTerminalOption", "CONTINUATION_MAX_BYTES"),
        p,
      );
    });
    const effect = (kind: string, payload: unknown) =>
      this.effects.push({ kind, payload });
    for (const [name, arity, fn] of [
      ["BELL", 2, () => effect("bell", null)],
      ["TITLE_CHANGED", 2, () => effect("title", this.string("TITLE"))],
      ["PWD_CHANGED", 2, () => effect("cwd", this.string("PWD"))],
      [
        "WRITE_PTY",
        4,
        (_h: number, _u: number, p: number, n: number) =>
          effect("reply", a.bytes().slice(p, p + n)),
      ],
      [
        "PROGRESS_REPORT",
        3,
        (_h: number, _u: number, p: number) =>
          effect("progress", a.read(p, "GhosttyTerminalProgressReport")),
      ],
      [
        "DESKTOP_NOTIFICATION",
        3,
        (_h: number, _u: number, p: number) => {
          const v = a.read(p, "GhosttyTerminalDesktopNotification");
          effect("notification", {
            title: this.decode(v.title),
            body: this.decode(v.body),
          });
        },
      ],
    ] as [string, number, (...args: number[]) => void][]) {
      a.check(
        "ghostty_terminal_set",
        h,
        a.enum("GhosttyTerminalOption", name),
        a.hook(arity, fn),
      );
    }
    this.state = a.handle("ghostty_render_state_new");
    this.iter = a.handle("ghostty_render_state_row_iterator_new");
    this.cellsHandle = a.handle("ghostty_render_state_row_cells_new");
    this.scratch = a.alloc(this.scratchSize);
  }
  private live() {
    if (this.ended) throw new Error("Terminal is disposed");
  }
  private decode(v: { ptr: number; len: number }) {
    return new TextDecoder().decode(this.a.bytes().slice(v.ptr, v.ptr + v.len));
  }
  number(key: string) {
    return this.a.temporary(8, (p) => {
      this.a.check(
        "ghostty_terminal_get",
        this.h,
        this.a.enum("GhosttyTerminalData", key),
        p,
      );
      return this.a.read(p, "u32");
    });
  }
  private string(key: string) {
    return this.a.object("GhosttyString", (p) => {
      this.a.check(
        "ghostty_terminal_get",
        this.h,
        this.a.enum("GhosttyTerminalData", key),
        p,
      );
      return this.decode(this.a.read(p, "GhosttyString"));
    });
  }
  write(bytes: Uint8Array) {
    this.live();
    this.effects = [];
    if (bytes.length) {
      this.wrote = true;
      this.a.temporary(bytes.length, (p) => {
        this.a.bytes().set(bytes, p);
        this.a.call("ghostty_terminal_vt_write", this.h, p, bytes.length);
      });
    }
    return this.effects.splice(0);
  }
  resize(size: Size) {
    this.live();
    validateSize(size);
    this.a.check(
      "ghostty_terminal_resize",
      this.h,
      size.cols,
      size.rows,
      8,
      16,
    );
    this.grid = { ...size };
    this.forceFull = true;
    this.shadow = [];
  }
  private allocated(name: string, ...args: number[]): Uint8Array {
    return this.a.temporary(8, (p) => {
      this.a.check(name, ...args, 0, p, p + 4);
      const ptr = this.a.read(p, "pointer"),
        len = this.a.read(p + 4, "u32");
      try {
        return this.a.bytes().slice(ptr, ptr + len);
      } finally {
        this.a.call("ghostty_free", 0, ptr, len);
      }
    });
  }
  snapshot(): SnapshotEnvelope {
    this.live();
    return {
      engineBuild: ENGINE_BUILD,
      formatVersion: SNAPSHOT_FORMAT_VERSION,
      size: this.size,
      bytes: this.allocated("ghostty_snapshot_encode_alloc", this.h),
    };
  }
  private format(selection: number) {
    const a = this.a;
    return a.object("GhosttyFormatterTerminalOptions", (p) => {
      a.write(p, "GhosttyFormatterTerminalOptions", {
        emit: "PLAIN",
        trim: true,
        unwrap: false,
        selection,
        extra: { screen: {} },
      });
      const f = a.handle("ghostty_formatter_terminal_new", this.h, p);
      try {
        return new TextDecoder().decode(
          this.allocated("ghostty_formatter_format_alloc", f),
        );
      } finally {
        a.call("ghostty_formatter_free", f);
      }
    });
  }
  inputModes(): InputModes {
    this.live();
    const mode = (number: number) =>
      this.a.object("GhosttyTerminalModeConfig", (p) => {
        this.a.write(p, "GhosttyTerminalModeConfig", { mode: number });
        this.a.check(
          "ghostty_terminal_get",
          this.h,
          this.a.enum("GhosttyTerminalData", "MODE"),
          p,
        );
        return this.a.read(p, "GhosttyTerminalModeConfig").value as boolean;
      });
    return {
      applicationCursor: mode(1),
      applicationKeypad: mode(66),
      bracketedPaste: mode(2004),
      focusEvents: mode(1004),
      mouseTracking: mode(1003)
        ? "any"
        : mode(1002)
          ? "button"
          : mode(1000)
            ? "normal"
            : mode(9)
              ? "x10"
              : "none",
      kittyKeyboardFlags: this.number("KITTY_KEYBOARD_FLAGS"),
    };
  }
  viewport() {
    this.live();
    return this.a.object("GhosttyTerminalScrollbar", (p) => {
      this.a.check(
        "ghostty_terminal_get",
        this.h,
        this.a.enum("GhosttyTerminalData", "SCROLLBAR"),
        p,
      );
      const value = this.a.read(p, "GhosttyTerminalScrollbar");
      return {
        totalRows: Number(value.total),
        offset: Number(value.offset),
        visibleRows: Number(value.len),
      };
    });
  }
  scrollViewport(delta: number | "top" | "bottom") {
    this.live();
    if (
      typeof delta === "number" &&
      (!Number.isInteger(delta) || Math.abs(delta) > 2147483647)
    )
      throw new RangeError("Invalid scroll delta");
    this.a.object("GhosttyTerminalScrollViewport", (p) => {
      this.a.write(
        p,
        "GhosttyTerminalScrollViewport",
        typeof delta === "number"
          ? { tag: "DELTA", value: delta }
          : { tag: delta.toUpperCase() },
      );
      this.a.call("ghostty_terminal_scroll_viewport", this.h, p);
    });
    this.forceFull = true;
  }
  readSelection(selection: Selection) {
    this.live();
    let { start, end } = selection;
    for (const point of [start, end])
      if (
        !Number.isInteger(point.x) ||
        !Number.isInteger(point.y) ||
        point.x < 0 ||
        point.x >= this.grid.cols ||
        point.y < 0 ||
        point.y >= this.grid.rows
      )
        throw new RangeError("Selection outside viewport");
    if (start.y > end.y || (start.y === end.y && start.x > end.x))
      [start, end] = [end, start];
    return this.selected(start, end, "VIEWPORT");
  }
  private selected(
    start: { x: number; y: number },
    end: { x: number; y: number },
    tag: string,
  ) {
    const a = this.a;
    return a.object("GhosttySelection", (s) =>
      a.object("GhosttyPoint", (p) => {
        for (const [key, point] of [
          ["start", start],
          ["end", end],
        ] as const) {
          a.write(p, "GhosttyPoint", { tag, value: point });
          a.check(
            "ghostty_terminal_grid_ref",
            this.h,
            p,
            s + a.types.GhosttySelection!.fields![key]!.offset,
          );
        }
        return this.format(s);
      }),
    );
  }
  readHistory() {
    this.live();
    return this.format(0);
  }
  readScreen() {
    this.live();
    const a = this.a;
    return a.object("GhosttySelection", (s) =>
      a.object("GhosttyPoint", (p) => {
        for (const [k, x, y] of [
          ["start", 0, 0],
          ["end", this.grid.cols - 1, this.grid.rows - 1],
        ] as [string, number, number][]) {
          a.write(p, "GhosttyPoint", { tag: "ACTIVE", value: { x, y } });
          a.check(
            "ghostty_terminal_grid_ref",
            this.h,
            p,
            s + a.types.GhosttySelection!.fields![k]!.offset,
          );
        }
        const rows = this.format(s).split("\n");
        while (rows.length < this.grid.rows) rows.push("");
        return rows.slice(0, this.grid.rows).join("\n");
      }),
    );
  }
  frame(): Frame {
    this.live();
    const t0 = Bun.nanoseconds();
    const a = this.a,
      L = this.L,
      p = this.scratch;
    const cursor = {
      x: this.number("CURSOR_X"),
      y: this.number("CURSOR_Y"),
      visible: !!this.number("CURSOR_VISIBLE"),
    };
    a.check("ghostty_render_state_update", this.state, this.h);
    a.check("ghostty_render_state_get", this.state, L.kDirty, p);
    const dirty = a.view().getUint32(p, true);
    this.lastDirty = dirty;
    const changed: Frame["changed"] = [];
    const full = this.forceFull || dirty === L.dirtyFull;
    const partial = !full && dirty === L.dirtyPartial;
    const rows = this.grid.rows;
    // A grapheme append does not dirty its row on the pinned build, and the
    // persistent state only re-copies dirty rows. After a write, the cursor
    // row and the row above must therefore come from a fresh render state
    // unless the dirty walk already delivered them.
    const need = new Set<number>();
    if (this.wrote && !full) {
      if (cursor.y > 0) need.add(cursor.y - 1);
      need.add(cursor.y);
    }
    if (full || partial) {
      this.readPalette(this.state);
      a.view().setUint32(p, this.iter, true);
      a.check("ghostty_render_state_get", this.state, L.kRowIterator, p);
      for (let y = 0; y < rows; y++) {
        if (!a.call("ghostty_render_state_row_iterator_next", this.iter)) break;
        let want = full;
        if (!want) {
          a.check("ghostty_render_state_row_get", this.iter, L.kRowDirty, p);
          want = !!a.bytes()[p];
        }
        if (!want) continue;
        need.delete(y);
        this.compareRow(y, this.decodeRow(), changed);
      }
      if (full)
        for (let y = 0; y < rows; y++)
          if (!this.shadow[y]) {
            const cells = Array.from({ length: this.grid.cols }, blank);
            this.shadow[y] = cells;
            changed.push({ y, cells });
          }
    }
    if (need.size) {
      timing.fresh++;
      const s = a.handle("ghostty_render_state_new");
      try {
        a.check("ghostty_render_state_update", s, this.h);
        this.readPalette(s);
        a.view().setUint32(p, this.iter, true);
        a.check("ghostty_render_state_get", s, L.kRowIterator, p);
        const last = Math.max(...need);
        for (let y = 0; y <= last; y++) {
          if (!a.call("ghostty_render_state_row_iterator_next", this.iter))
            break;
          if (need.has(y)) this.compareRow(y, this.decodeRow(), changed);
        }
      } finally {
        a.call("ghostty_render_state_free", s);
      }
    }
    changed.sort((m, n) => m.y - n.y);
    a.check("ghostty_render_state_clean", this.state);
    this.forceFull = false;
    this.wrote = false;
    timing.frames++;
    timing.ns += Bun.nanoseconds() - t0;
    return { ...this.size, changed, cursor };
  }
  private readPalette(state: number) {
    const a = this.a,
      L = this.L,
      p = this.scratch;
    a.view().setUint32(p, L.colorsSize, true);
    a.check("ghostty_render_state_get", state, L.kColors, p);
    const b = a.bytes();
    let at = p + L.paletteOffset;
    for (let i = 0; i < 256; i++, at += 3)
      this.palette[i] = (b[at]! << 16) | (b[at + 1]! << 8) | b[at + 2]!;
  }
  private compareRow(y: number, cells: Cell[], changed: Frame["changed"]) {
    timing.decodedRows++;
    const prev = this.shadow[y];
    let differs = !prev || prev.length !== cells.length;
    if (!differs)
      for (let x = 0; x < cells.length; x++)
        if (!same(prev![x]!, cells[x]!)) {
          differs = true;
          break;
        }
    if (differs) {
      changed.push({ y, cells });
      this.shadow[y] = cells;
    }
  }
  private decodeRow(): Cell[] {
    const a = this.a,
      L = this.L,
      p = this.scratch;
    a.check("ghostty_render_state_row_get", this.iter, L.kCellsRaw, p);
    let v = a.view();
    const ptr = v.getUint32(p + L.viewPtr, true),
      len = v.getUint32(p + L.viewLen, true);
    if (this.words.length < len * 2) this.words = new Uint32Array(len * 2);
    const words = this.words;
    // Copy the borrowed row out; later calls may grow memory.
    words.set(new Uint32Array(a.bytes().buffer, ptr, len * 2));
    const cols = this.grid.cols;
    const cells: Cell[] = new Array(cols);
    let selected = false;
    let styles: Map<number, Style> | undefined;
    for (let x = 0; x < len && x < cols; x++) {
      const lo = words[x * 2]!,
        hi = words[x * 2 + 1]!;
      const tag = bits(lo, hi, L.contentTag);
      const styleId = bits(lo, hi, L.styleId);
      const wide = bits(lo, hi, L.wide);
      let text = " ";
      let bg = -1;
      if (tag === L.tagCodepoint) {
        const cp = bits(lo, hi, L.codepoint);
        if (cp) text = cp < 128 ? ascii[cp]! : String.fromCodePoint(cp);
      } else if (tag === L.tagGrapheme) {
        if (!selected) selected = this.selectRow();
        a.check("ghostty_render_state_row_cells_select", this.cellsHandle, x);
        a.check(
          "ghostty_render_state_row_cells_get",
          this.cellsHandle,
          L.kGraphemesLen,
          p,
        );
        const n = a.view().getUint32(p, true);
        const q = this.ensureScratch(n * 4 + 256) + 256;
        a.check(
          "ghostty_render_state_row_cells_get",
          this.cellsHandle,
          L.kGraphemesBuf,
          q,
        );
        v = a.view();
        const parts: number[] = [];
        for (let i = 0; i < n; i++) parts.push(v.getUint32(q + i * 4, true));
        text = String.fromCodePoint(...parts);
      } else if (tag === L.tagBgPalette) {
        bg = this.palette[bits(lo, hi, L.bgIndex)]!;
      } else if (tag === L.tagBgRgb) {
        bg =
          (bits(lo, hi, L.bgR) << 16) |
          (bits(lo, hi, L.bgG) << 8) |
          bits(lo, hi, L.bgB);
      }
      let st = plain;
      if (styleId) {
        st = (styles ??= new Map()).get(styleId)!;
        if (!st) {
          if (!selected) selected = this.selectRow();
          a.check("ghostty_render_state_row_cells_select", this.cellsHandle, x);
          st = this.readStyle();
          styles.set(styleId, st);
          timing.styleReads++;
        }
      }
      if (bg < 0) bg = st.bg < 0 ? DEFAULT_BG : st.bg;
      cells[x] = {
        text,
        width: wide === 1 ? 2 : wide === 2 || wide === 3 ? 0 : 1,
        fg: st.fg,
        bg,
        bold: st.bold,
        italic: st.italic,
        underline: st.underline,
        inverse: st.inverse,
        strikethrough: st.strikethrough,
      };
    }
    for (let x = len; x < cols; x++) cells[x] = blank();
    return cells;
  }
  private selectRow(): true {
    const a = this.a,
      p = this.scratch;
    a.view().setUint32(p, this.cellsHandle, true);
    a.check("ghostty_render_state_row_get", this.iter, this.L.kCells, p);
    return true;
  }
  private ensureScratch(n: number): number {
    if (n <= this.scratchSize) return this.scratch;
    this.a.free(this.scratch, this.scratchSize);
    this.scratchSize = Math.max(n, this.scratchSize * 2);
    this.scratch = this.a.alloc(this.scratchSize);
    return this.scratch;
  }
  private readStyle(): Style {
    const a = this.a,
      L = this.L,
      p = this.scratch + 128;
    let v = a.view();
    v.setUint32(p, L.styleSize, true);
    a.check(
      "ghostty_render_state_row_cells_get",
      this.cellsHandle,
      L.kStyle,
      p,
    );
    v = a.view();
    const b = a.bytes();
    const colour = (tagAt: number, valueAt: number, none: number) => {
      const tag = v.getInt32(tagAt, true);
      if (tag === L.colourPalette) return this.palette[b[valueAt]!]!;
      if (tag === L.colourRgb)
        return (b[valueAt]! << 16) | (b[valueAt + 1]! << 8) | b[valueAt + 2]!;
      return none;
    };
    return {
      fg: colour(p + L.fgTag, p + L.fgValue, DEFAULT_FG),
      bg: colour(p + L.bgTag, p + L.bgValue, -1),
      bold: !!b[p + L.bold],
      italic: !!b[p + L.italic],
      underline: v.getInt32(p + L.underline, true) !== 0,
      inverse: !!b[p + L.inverse],
      strikethrough: !!b[p + L.strikethrough],
    };
  }
  dispose() {
    if (this.ended) return;
    this.ended = true;
    this.a.call("ghostty_render_state_row_cells_free", this.cellsHandle);
    this.a.call("ghostty_render_state_row_iterator_free", this.iter);
    this.a.call("ghostty_render_state_free", this.state);
    this.a.free(this.scratch, this.scratchSize);
    this.a.call("ghostty_terminal_free", this.h);
    this.effects = [];
    this.shadow = [];
  }
}
