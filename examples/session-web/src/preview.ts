/**
 * Turns the VT text of a `preview` frame into markup for a tile. A preview is
 * a picture, not a replica: there is no engine, no snapshot and no WASM here,
 * only SGR parsing and escaping, so a page can hold many tiles cheaply.
 */
import { dark } from "@werk/palette";

type Style = {
  fg?: string;
  bg?: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  inverse: boolean;
};
/** The sixteen a child's SGR 30-37 and 90-97 name, as werk's palette paints them. */
const base = dark.terminal.ansi;
const hex = (n: number) => n.toString(16).padStart(2, "0");
function indexed(index: number): string {
  if (index < 16) return base[index]!;
  if (index < 232) {
    const level = (v: number) => (v ? 55 + v * 40 : 0);
    const n = index - 16;
    return `#${hex(level(Math.floor(n / 36)))}${hex(level(Math.floor(n / 6) % 6))}${hex(level(n % 6))}`;
  }
  const grey = 8 + (index - 232) * 10;
  return `#${hex(grey)}${hex(grey)}${hex(grey)}`;
}
const blank = (): Style => ({
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  inverse: false,
});
/** Consumes one colour parameter run, which may be 5;n or 2;r;g;b. */
function colour(codes: number[], at: number): [string | undefined, number] {
  if (codes[at] === 5) return [indexed(codes[at + 1] ?? 0), at + 2];
  if (codes[at] === 2)
    return [
      `#${hex(codes[at + 1] ?? 0)}${hex(codes[at + 2] ?? 0)}${hex(codes[at + 3] ?? 0)}`,
      at + 4,
    ];
  return [undefined, at + 1];
}
function apply(style: Style, parameters: string): Style {
  const codes = parameters
    .split(";")
    .map((value) => Number(value.split(":")[0] || 0));
  let next = { ...style };
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i]!;
    if (code === 0) next = blank();
    else if (code === 1) next.bold = true;
    else if (code === 3) next.italic = true;
    else if (code === 4) next.underline = true;
    else if (code === 7) next.inverse = true;
    else if (code === 9) next.strike = true;
    else if (code === 22) next.bold = false;
    else if (code === 23) next.italic = false;
    else if (code === 24) next.underline = false;
    else if (code === 27) next.inverse = false;
    else if (code === 29) next.strike = false;
    else if (code >= 30 && code <= 37) next.fg = base[code - 30];
    else if (code === 38) {
      const [value, after] = colour(codes, i + 1);
      next.fg = value;
      i = after - 1;
    } else if (code === 39) next.fg = undefined;
    else if (code >= 40 && code <= 47) next.bg = base[code - 40];
    else if (code === 48) {
      const [value, after] = colour(codes, i + 1);
      next.bg = value;
      i = after - 1;
    } else if (code === 49) next.bg = undefined;
    else if (code >= 90 && code <= 97) next.fg = base[code - 90 + 8];
    else if (code >= 100 && code <= 107) next.bg = base[code - 100 + 8];
  }
  return next;
}
function css(style: Style): string {
  const fg = style.inverse
    ? (style.bg ?? dark.terminal.background.hex)
    : style.fg;
  const bg = style.inverse
    ? (style.fg ?? dark.terminal.foreground.hex)
    : style.bg;
  const rules = [
    fg && `color:${fg}`,
    bg && `background:${bg}`,
    style.bold && "font-weight:700",
    style.italic && "font-style:italic",
    [style.underline && "underline", style.strike && "line-through"]
      .filter(Boolean)
      .join(" ") &&
      `text-decoration:${[style.underline && "underline", style.strike && "line-through"].filter(Boolean).join(" ")}`,
  ].filter(Boolean);
  return rules.join(";");
}
const escaped = (text: string) =>
  text.replace(
    /[&<>]/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[character] as string,
  );
// SGR is the only sequence a formatted screen needs; anything else the engine
// emits is dropped rather than interpreted, so nothing here can execute.
const sequence =
  /\x1b\[([0-9;:]*)m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b\[[0-9;:?]*[ -/]*[@-~]|\x1b[ -/]*[0-~]|[\x00-\x08\x0b-\x1f\x7f]/g;
export function previewMarkup(text: string, rows: number): string {
  let style = blank();
  let out = "";
  let at = 0;
  let lines = 1;
  const emit = (chunk: string) => {
    if (!chunk) return;
    lines += chunk.split("\n").length - 1;
    const rules = css(style);
    out += rules
      ? `<span style="${rules}">${escaped(chunk)}</span>`
      : escaped(chunk);
  };
  for (const match of text.matchAll(sequence)) {
    emit(text.slice(at, match.index));
    at = match.index + match[0].length;
    if (match[1] !== undefined) style = apply(style, match[1] || "0");
  }
  emit(text.slice(at));
  // The formatter trims trailing blanks, so a tile pads back to the grid it
  // was told about and keeps its height while the session is quiet.
  return out + "\n".repeat(Math.max(0, rows - lines));
}
