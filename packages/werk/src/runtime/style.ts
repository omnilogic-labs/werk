/**
 * How werk's own output is styled, and the one place chalk is constructed.
 *
 * `colour.ts` decides *whether* colour is written and how deep it may go, and
 * `theme.ts` decides *which* flavour and accent. This module decides what bytes
 * come out: it takes a level and a set of roles and hands back functions named
 * for what they are for — an error, a heading, something the reader can type —
 * so that no other module in the CLI names a colour.
 *
 * ## The theme, at whatever depth the terminal has
 *
 * Catppuccin is a set of 24-bit colours, so wearing it means writing them. At
 * level 3 that is what happens: a role's hex goes out as `38;2;R;G;B` and every
 * reader sees the flavour they chose, whatever their terminal is themed as. At
 * level 2 chalk maps the same hex onto the 256-colour cube, which lands close
 * enough to keep every role distinct.
 *
 * Level 1 is the one that needs a rule of its own, and it is werk's rule rather
 * than anything Catppuccin says. Catppuccin does not degrade: its ports require
 * truecolour and several name the terminals they will not work on. Left to
 * itself chalk answers a 16-colour terminal with a nearest-colour search, and
 * that search is useless here — Mocha's green comes out as SGR 37 and its
 * yellow, red and blue all as SGR 97, so five roles collapse into white and
 * every distinction they exist to make is gone.
 *
 * So at level 1 werk writes the slot instead. Catppuccin publishes which of its
 * colours sits in each of the sixteen a terminal theme defines, and `Swatch.ansi`
 * carries that where it exists; `fallbackSlot` covers the eight accents upstream
 * places nowhere. A reader on sixteen colours gets their own terminal's red for
 * an error and their own green for a success, which is the right answer at that
 * depth: the hue survives even though the flavour cannot.
 *
 * `muted` and `emphasis` are weight rather than colour — SGR 2 and SGR 1 — so
 * they take no role and no flavour reaches them. A fixed grey written onto a
 * ground werk did not choose is the case Catppuccin's own style guide opens by
 * warning about, and `dim` composes with whatever ground the reader has.
 */
import { Chalk, type ChalkInstance } from "chalk";
import {
  defaultRoles,
  fallbackSlot,
  type AnsiSlot,
  type Roles,
  type Swatch,
} from "@werk/palette";
import { type ColourLevel } from "./colour.js";

/** What werk's output is made of. A caller asks for a use, never for a colour. */
export interface Styles {
  /** A section heading on a help page. */
  heading(text: string): string;
  /** Something the reader can type back verbatim. */
  literal(text: string): string;
  /** A name the reader substitutes something of their own for. */
  placeholder(text: string): string;
  /** It worked. */
  success(text: string): string;
  /** It might not have. */
  warning(text: string): string;
  /** It did not. */
  error(text: string): string;
  /** Text that is genuinely incidental: a label, a note, a path. */
  muted(text: string): string;
  /** The one thing on the line worth reading first. */
  emphasis(text: string): string;
}

/**
 * The sixteen slots as chalk asks for them. Chalk has no way to be handed a
 * number, so the table is the translation, and the palette's own tests are what
 * guarantee the numbers on the other side of it are the ones Catppuccin gave.
 */
const BY_SLOT = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "blackBright",
  "redBright",
  "greenBright",
  "yellowBright",
  "blueBright",
  "magentaBright",
  "cyanBright",
  "whiteBright",
] as const satisfies { [K in AnsiSlot]: keyof ChalkInstance };

/**
 * One role, at one depth. Every role werk colours is an accent, so
 * `fallbackSlot` always answers; the `?? c.white` is unreachable and is there so
 * that a role moved onto a grey degrades rather than throws.
 */
function paint(
  c: ChalkInstance,
  level: ColourLevel,
  role: Swatch,
): ChalkInstance {
  if (level !== 1) return c.hex(role.hex);
  const slot = role.ansi ?? fallbackSlot(role.name);
  return slot === undefined ? c.white : c[BY_SLOT[slot]];
}

export function createStyles(
  level: ColourLevel,
  theme: Roles = defaultRoles,
): Styles {
  const c = new Chalk({ level });
  const heading = paint(c, level, theme.heading).bold;
  const literal = paint(c, level, theme.literal).bold;
  const placeholder = paint(c, level, theme.placeholder);
  const success = paint(c, level, theme.success);
  const warning = paint(c, level, theme.warning);
  const error = paint(c, level, theme.error);
  return {
    heading: (text) => heading(text),
    literal: (text) => literal(text),
    placeholder: (text) => placeholder(text),
    success: (text) => success(text),
    warning: (text) => warning(text),
    error: (text) => error(text),
    muted: (text) => c.dim(text),
    emphasis: (text) => c.bold(text),
  };
}
