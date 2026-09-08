import type { Abi } from "../src/abi.js";
import type { Cell, TerminalHandle } from "../src/types.js";
import { defaultRoles } from "@werk/palette";
// Independent per-cell ABI reader: intentionally avoids the packed-row decoder.
export function readCells(terminal: TerminalHandle): Cell[][] {
  const { a, h, engineAnsi, themeAnsi } = terminal as unknown as {
    a: Abi;
    h: number;
    engineAnsi: Uint32Array;
    themeAnsi: Uint32Array;
  };
  // What this oracle checks is the packed-row decoder, not which sixteen colours
  // a replica paints in. So it takes the same two tables the engine took and
  // applies the same rule — an entry still at the engine's own default becomes
  // werk's — rather than re-deriving a policy that is not under test here.
  const themed = (colour: number): number => {
    for (let i = 0; i < 16; i++)
      if (colour === engineAnsi[i]) return themeAnsi[i]!;
    return colour;
  };
  const grid = terminal.size;
  const state = a.handle("ghostty_render_state_new");
  const iter = a.handle("ghostty_render_state_row_iterator_new");
  const cells = a.handle("ghostty_render_state_row_cells_new");
  try {
    return a.temporary(256, (p) => {
      a.check("ghostty_render_state_update", state, h);
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
        for (let x = 0; x < grid.cols; x++) {
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
          const fg = themed(
              colour("FG_COLOR", defaultRoles.terminal.foreground.rgb),
            ),
            bg = themed(
              colour("BG_COLOR", defaultRoles.terminal.background.rgb),
            );
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
