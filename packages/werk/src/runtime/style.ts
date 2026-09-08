/**
 * How werk's own output is styled, and the one place chalk is constructed.
 *
 * `colour.ts` decides *whether* colour is written and how deep it may go. This
 * module decides *what* is written: it takes that level and hands back a set of
 * functions named for what they are for — an error, a heading, something the
 * reader can type — so that no other module in the CLI names a colour.
 *
 * ## Slots, not hexes
 *
 * The roles come from `@werk/palette`, which is Catppuccin. Catppuccin publishes
 * two things: its colours, and which of them sits in each of the sixteen slots a
 * terminal theme defines — green is slot 2, teal is 6, red is 1, yellow is 3.
 * werk's own output is a guest on somebody else's terminal, so it writes the
 * slot. A reader whose terminal already wears Catppuccin is shown the palette
 * exactly; a reader wearing anything else is shown the colours they chose. The
 * surfaces that own their own pixels — the replica's defaults, the browser
 * page — take the hex from the same roles instead.
 *
 * Nothing here emits a 256-colour index or a truecolour escape, so levels 1, 2
 * and 3 write identical bytes and the depth the gate reports changes nothing
 * about a page. Whether that should stay true is
 * `docs/product-specification.md`, open question 23.
 *
 * `muted` and `emphasis` are weight rather than colour — SGR 2 and SGR 1 — so
 * they have no palette role and are not affected by any of this.
 */
import { Chalk, type ChalkInstance } from "chalk";
import { dark, type AnsiSlot, type AnsiSwatch } from "@werk/palette";
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
 * number, so the table is the translation, and `palette.test.ts` is what
 * guarantees the numbers on the other side of it are the ones Catppuccin gave.
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

const slot = (c: ChalkInstance, role: AnsiSwatch): ChalkInstance =>
  c[BY_SLOT[role.ansi]];

/**
 * The roles are read from the dark flavour, and which flavour that is does not
 * matter: Catppuccin puts green, teal, red and yellow in the same four slots in
 * every flavour, so the bytes are the same either way. `style.test.ts` holds
 * that, which is what makes the choice safe to have made.
 */

export function createStyles(level: ColourLevel): Styles {
  const c = new Chalk({ level });
  const heading = slot(c, dark.heading).bold;
  const literal = slot(c, dark.literal).bold;
  const placeholder = slot(c, dark.placeholder);
  return {
    heading: (text) => heading(text),
    literal: (text) => literal(text),
    placeholder: (text) => placeholder(text),
    success: (text) => slot(c, dark.success)(text),
    warning: (text) => slot(c, dark.warning)(text),
    error: (text) => slot(c, dark.error)(text),
    muted: (text) => c.dim(text),
    emphasis: (text) => c.bold(text),
  };
}
