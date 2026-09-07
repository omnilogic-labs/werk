/**
 * Aligned columns for a terminal, tab-separated for anything else.
 *
 * Width here means display cells, not code units. `String.prototype.padEnd`
 * counts UTF-16 units, so it puts a CJK column a character out per glyph and an
 * astral emoji two out; `Bun.stringWidth` counts what the terminal will draw and
 * ignores ANSI escapes, so a coloured cell measures the same as a plain one.
 *
 * When the row does not fit, one nominated column gives up its space rather than
 * every column shrinking together — the columns worth reading (a session id, a
 * state) keep their width and the long one (a command line) is what truncates.
 *
 * Piped output is TSV with no padding and no colour, so `cut -f2` works.
 */
export interface TableOptions {
  /** Index of the column that absorbs the overflow. */
  flex?: number;
  /** Terminal width to fit within; unset means do not fit. */
  width?: number;
  /** Aligned and padded when true, tab-separated when false. */
  aligned: boolean;
}
const cells = (s: string) => Bun.stringWidth(s);
/** Cut to `limit` display cells, spending the last one on an ellipsis. */
function clip(text: string, limit: number): string {
  if (cells(text) <= limit) return text;
  if (limit <= 1) return limit === 1 ? "…" : "";
  let out = "";
  for (const char of text) {
    if (cells(out + char) > limit - 1) break;
    out += char;
  }
  return out + "…";
}
const GAP = "  ";
export function renderTable(
  rows: readonly (readonly string[])[],
  options: TableOptions,
): string {
  if (rows.length === 0) return "";
  if (!options.aligned) return rows.map((r) => r.join("\t")).join("\n");
  const columns = Math.max(...rows.map((r) => r.length));
  const widths: number[] = [];
  for (let c = 0; c < columns; c++)
    widths[c] = Math.max(0, ...rows.map((r) => cells(r[c] ?? "")));
  const flex = options.flex ?? columns - 1;
  if (options.width !== undefined && widths[flex] !== undefined) {
    const gaps = GAP.length * (columns - 1);
    const others = widths.reduce(
      (sum, w, i) => (i === flex ? sum : sum + w),
      0,
    );
    // Never take the flex column below a width where truncation still says
    // something; a one-cell column is just an ellipsis.
    widths[flex] = Math.max(8, options.width - gaps - others);
  }
  return rows
    .map((row) =>
      row
        .map((cell, c) => {
          const clipped = clip(cell, widths[c]!);
          return clipped + " ".repeat(Math.max(0, widths[c]! - cells(clipped)));
        })
        .join(GAP)
        .trimEnd(),
    )
    .join("\n");
}
