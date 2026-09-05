import { Abi } from "./abi.js";
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
} from "./types.js";
export const ENGINE_BUILD = "ghostty-3c1ef5b32fc5ea6b93d28493fabf193f595139cf";
export const SNAPSHOT_FORMAT_VERSION = 1;
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
      viewport: false,
      selection: false,
      inputModes: false,
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
class Terminal implements TerminalHandle {
  private ended = false;
  private effects: TerminalEffect[] = [];
  private previous: string[] = [];
  private grid: Size;
  get size() {
    return { ...this.grid };
  }
  constructor(
    private a: Abi,
    private h: number,
    size: Size,
  ) {
    this.grid = { ...size };
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
    if (bytes.length)
      this.a.temporary(bytes.length, (p) => {
        this.a.bytes().set(bytes, p);
        this.a.call("ghostty_terminal_vt_write", this.h, p, bytes.length);
      });
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
    this.previous = [];
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
    const cells = this.cells();
    const changed: Frame["changed"] = [];
    for (let y = 0; y < cells.length; y++) {
      const serial = JSON.stringify(cells[y]);
      if (serial !== this.previous[y]) changed.push({ y, cells: cells[y]! });
      this.previous[y] = serial;
    }
    return {
      ...this.size,
      changed,
      cursor: {
        x: this.number("CURSOR_X"),
        y: this.number("CURSOR_Y"),
        visible: !!this.number("CURSOR_VISIBLE"),
      },
    };
  }
  private cells(): Cell[][] {
    const a = this.a;
    const state = a.handle("ghostty_render_state_new");
    const iter = a.handle("ghostty_render_state_row_iterator_new");
    const cells = a.handle("ghostty_render_state_row_cells_new");
    try {
      return a.temporary(256, (p) => {
        a.check("ghostty_render_state_update", state, this.h);
        a.write(p, "pointer", iter);
        a.check(
          "ghostty_render_state_get",
          state,
          a.enum("GhosttyRenderStateData", "ROW_ITERATOR"),
          p,
        );
        const rows: Cell[][] = [];
        while (a.call("ghostty_render_state_row_iterator_next", iter)) {
          a.write(p, "pointer", cells);
          a.check(
            "ghostty_render_state_row_get",
            iter,
            a.enum("GhosttyRenderStateRowData", "CELLS"),
            p,
          );
          const row: Cell[] = [];
          for (let x = 0; x < this.grid.cols; x++) {
            a.check("ghostty_render_state_row_cells_select", cells, x);
            const get = (key: string) =>
              a.check(
                "ghostty_render_state_row_cells_get",
                cells,
                a.enum("GhosttyRenderStateRowCellsData", key),
                p,
              );
            get("RAW");
            const raw = a.read(p, "u64") as bigint;
            const bits = a.types.GhosttyCell as any;
            const wide = Number((raw >> BigInt(bits.bits.wide.lsb)) & 3n);
            a.write(p, "GhosttyStyle", {});
            get("STYLE");
            const st = a.read(p, "GhosttyStyle");
            const colour = (key: string, fallback: number) => {
              const code = a.call(
                "ghostty_render_state_row_cells_get",
                cells,
                a.enum("GhosttyRenderStateRowCellsData", key),
                p,
              );
              return code === 0
                ? (a.bytes()[p]! << 16) |
                    (a.bytes()[p + 1]! << 8) |
                    a.bytes()[p + 2]!
                : fallback;
            };
            const fg = colour("FG_COLOR", 0xd8dee9),
              bg = colour("BG_COLOR", 0x161b22);
            get("GRAPHEMES_LEN");
            const n = a.read(p, "u32");
            const text = n
              ? a.temporary(n * 4, (q) => {
                  a.check(
                    "ghostty_render_state_row_cells_get",
                    cells,
                    a.enum("GhosttyRenderStateRowCellsData", "GRAPHEMES_BUF"),
                    q,
                  );
                  return Array.from({ length: n }, (_, i) =>
                    String.fromCodePoint(a.read(q + i * 4, "u32")),
                  ).join("");
                })
              : " ";
            row.push({
              text,
              width: wide === 1 ? 2 : wide === 2 || wide === 3 ? 0 : 1,
              fg,
              bg,
              bold: st.bold,
              italic: st.italic,
              underline: !!st.underline,
              inverse: st.inverse,
              strikethrough: st.strikethrough,
            });
          }
          rows.push(row);
        }
        return rows;
      });
    } finally {
      a.call("ghostty_render_state_row_cells_free", cells);
      a.call("ghostty_render_state_row_iterator_free", iter);
      a.call("ghostty_render_state_free", state);
    }
  }
  dispose() {
    if (this.ended) return;
    this.ended = true;
    this.a.call("ghostty_terminal_free", this.h);
    this.effects = [];
    this.previous = [];
  }
}
