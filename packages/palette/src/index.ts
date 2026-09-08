/**
 * The colours werk uses, and what it uses them for.
 *
 * The palette is [Catppuccin](https://github.com/catppuccin/catppuccin). This
 * module holds the two flavours werk names — Latte and Mocha — and, above them,
 * a set of *roles*: `error`, `heading`, `border`, `terminal.background` and the
 * rest. Everywhere werk puts colour on a screen it asks for a role, so the
 * question "what colour is an error" is answered once, here.
 *
 * ## Slots, and why a role carries one
 *
 * Catppuccin is a set of 24-bit colours, but it also publishes the other half
 * of the story: which of its colours sits in each of the sixteen ANSI slots a
 * terminal theme defines. Green is slot 2, teal is slot 6, red is 1, yellow is
 * 3. A terminal wearing Catppuccin has already been told that, so a program
 * that writes SGR 32 on such a terminal gets Catppuccin's green — the exact
 * hex below — without saying so, and a reader wearing something else gets the
 * green they chose.
 *
 * So a `Swatch` carries `hex` for the surfaces that own their own pixels, and
 * `ansi` for the surfaces that are guests on someone's terminal. Only a colour
 * that Catppuccin's own mapping places in a slot has one, and the slot is
 * derived from that mapping rather than typed by hand, so a role can never
 * claim a slot its colour does not hold. `AnsiSwatch` is the type that demands
 * one: a role typed that way cannot be given lavender, which has no slot.
 *
 * ## Where the values came from
 *
 * Transcribed from `@catppuccin/palette`, which is a devDependency of this
 * package and nothing else's. `test/palette.test.ts` compares every value here
 * against that package, so the copy cannot drift quietly. See `PROVENANCE.md`.
 */

/** The flavours werk names. Catppuccin publishes four; these are the two ends. */
export type FlavourName = "latte" | "mocha";

/** Catppuccin's twenty-six colour names, in the order the palette publishes them. */
export type ColourName =
  | "rosewater"
  | "flamingo"
  | "pink"
  | "mauve"
  | "red"
  | "maroon"
  | "peach"
  | "yellow"
  | "green"
  | "teal"
  | "sky"
  | "sapphire"
  | "blue"
  | "lavender"
  | "text"
  | "subtext1"
  | "subtext0"
  | "overlay2"
  | "overlay1"
  | "overlay0"
  | "surface2"
  | "surface1"
  | "surface0"
  | "base"
  | "mantle"
  | "crust";

/** One of the sixteen colours a terminal theme defines: 0-7 normal, 8-15 bright. */
export type AnsiSlot =
  0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15;

/** The sixteen ANSI colours of a flavour, indexed by slot. */
export type AnsiTable = readonly [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
];

/** One colour, in the three forms werk's three surfaces need it in. */
export interface Swatch {
  readonly name: ColourName;
  /** `#rrggbb`, for a surface that owns its own pixels. */
  readonly hex: string;
  /** `0xrrggbb`, for the renderer, which carries colour as a packed integer. */
  readonly rgb: number;
  /** The slot Catppuccin's terminal mapping gives this colour, where it has one. */
  readonly ansi?: AnsiSlot;
}

/** A colour a terminal theme can remap, and so one werk may write as a slot. */
export interface AnsiSwatch extends Swatch {
  readonly ansi: AnsiSlot;
}

export interface Flavour {
  readonly name: FlavourName;
  /** Whether this flavour expects light text on a dark ground. */
  readonly dark: boolean;
  readonly colours: Readonly<Record<ColourName, Swatch>>;
  readonly ansi: AnsiTable;
}

/**
 * What werk uses each colour for.
 *
 * The assignments follow Catppuccin's own style guide where it has an opinion —
 * Base is the page, Text is body copy, Green is success, Yellow is a warning,
 * Red is an error, Blue is a link, Rosewater is a cursor, Overlay 2 is a
 * selection — and werk's own reading where it does not.
 */
export interface Roles {
  /** The ground a page sits on. */
  readonly background: Swatch;
  /** A pane behind the ground: a strip, a sidebar. */
  readonly backgroundSecondary: Swatch;
  /** The furthest back of the three, for a well or a gutter. */
  readonly backgroundDeep: Swatch;
  /** A control's own ground: an input, a button. */
  readonly surface: Swatch;
  /** The same control under the pointer. */
  readonly surfaceHover: Swatch;
  /** A line around something. */
  readonly border: Swatch;
  /** The line around something that is not the subject right now. */
  readonly borderInactive: Swatch;
  /** The line around the thing that is. */
  readonly borderActive: Swatch;

  /** Body copy, and a headline. */
  readonly text: Swatch;
  /** A label or a sub-headline: present, quieter. */
  readonly textSubtle: Swatch;
  /** Text that is genuinely incidental. */
  readonly textMuted: Swatch;
  /** A link or a URL. */
  readonly link: Swatch;
  /** Where typing would go. */
  readonly cursor: Swatch;
  /** Behind selected text. Catppuccin asks for 20-30% opacity over the ground. */
  readonly selection: Swatch;

  /** It worked. */
  readonly success: AnsiSwatch;
  /** It might not have. */
  readonly warning: AnsiSwatch;
  /** It did not. */
  readonly error: AnsiSwatch;

  /** A section heading on a help page. */
  readonly heading: AnsiSwatch;
  /** Something the reader can type back verbatim. */
  readonly literal: AnsiSwatch;
  /** A name the reader substitutes something of their own for. */
  readonly placeholder: AnsiSwatch;

  /**
   * The replica's own defaults: the colours a child program's output is painted
   * in before it asks for anything else, and the sixteen it gets when it does.
   */
  readonly terminal: {
    readonly foreground: Swatch;
    readonly background: Swatch;
    readonly ansi: AnsiTable;
  };
}

const parse = (hex: string): number => Number.parseInt(hex.slice(1), 16);

function flavour(
  name: FlavourName,
  dark: boolean,
  hexes: Record<ColourName, string>,
  ansi: AnsiTable,
): Flavour {
  const colours = {} as Record<ColourName, Swatch>;
  for (const [key, hex] of Object.entries(hexes) as [ColourName, string][]) {
    // The slot is looked up rather than declared, so a colour Catppuccin does
    // not place in the sixteen cannot acquire one by a typo.
    const slot = ansi.indexOf(hex);
    colours[key] = {
      name: key,
      hex,
      rgb: parse(hex),
      ...(slot === -1 ? {} : { ansi: slot as AnsiSlot }),
    };
  }
  return { name, dark, colours, ansi };
}

const latte = flavour(
  "latte",
  false,
  {
    rosewater: "#dc8a78",
    flamingo: "#dd7878",
    pink: "#ea76cb",
    mauve: "#8839ef",
    red: "#d20f39",
    maroon: "#e64553",
    peach: "#fe640b",
    yellow: "#df8e1d",
    green: "#40a02b",
    teal: "#179299",
    sky: "#04a5e5",
    sapphire: "#209fb5",
    blue: "#1e66f5",
    lavender: "#7287fd",
    text: "#4c4f69",
    subtext1: "#5c5f77",
    subtext0: "#6c6f85",
    overlay2: "#7c7f93",
    overlay1: "#8c8fa1",
    overlay0: "#9ca0b0",
    surface2: "#acb0be",
    surface1: "#bcc0cc",
    surface0: "#ccd0da",
    base: "#eff1f5",
    mantle: "#e6e9ef",
    crust: "#dce0e8",
  },
  [
    "#5c5f77",
    "#d20f39",
    "#40a02b",
    "#df8e1d",
    "#1e66f5",
    "#ea76cb",
    "#179299",
    "#acb0be",
    "#6c6f85",
    "#de293e",
    "#49af3d",
    "#eea02d",
    "#456eff",
    "#fe85d8",
    "#2d9fa8",
    "#bcc0cc",
  ],
);

const mocha = flavour(
  "mocha",
  true,
  {
    rosewater: "#f5e0dc",
    flamingo: "#f2cdcd",
    pink: "#f5c2e7",
    mauve: "#cba6f7",
    red: "#f38ba8",
    maroon: "#eba0ac",
    peach: "#fab387",
    yellow: "#f9e2af",
    green: "#a6e3a1",
    teal: "#94e2d5",
    sky: "#89dceb",
    sapphire: "#74c7ec",
    blue: "#89b4fa",
    lavender: "#b4befe",
    text: "#cdd6f4",
    subtext1: "#bac2de",
    subtext0: "#a6adc8",
    overlay2: "#9399b2",
    overlay1: "#7f849c",
    overlay0: "#6c7086",
    surface2: "#585b70",
    surface1: "#45475a",
    surface0: "#313244",
    base: "#1e1e2e",
    mantle: "#181825",
    crust: "#11111b",
  },
  [
    "#45475a",
    "#f38ba8",
    "#a6e3a1",
    "#f9e2af",
    "#89b4fa",
    "#f5c2e7",
    "#94e2d5",
    "#a6adc8",
    "#585b70",
    "#f37799",
    "#89d88b",
    "#ebd391",
    "#74a8fc",
    "#f2aede",
    "#6bd7ca",
    "#bac2de",
  ],
);

export const flavours: Readonly<Record<FlavourName, Flavour>> = {
  latte,
  mocha,
};

/** Narrow a swatch to one werk may write as an ANSI slot, or refuse to. */
function withSlot(swatch: Swatch): AnsiSwatch {
  if (swatch.ansi === undefined)
    throw new Error(`${swatch.name} has no ANSI slot`);
  return swatch as AnsiSwatch;
}

/** What each colour of a flavour is for. */
export function roles(name: FlavourName): Roles {
  const f = flavours[name];
  const c = f.colours;
  return {
    background: c.base,
    backgroundSecondary: c.mantle,
    backgroundDeep: c.crust,
    surface: c.surface0,
    surfaceHover: c.surface1,
    border: c.surface2,
    borderInactive: c.overlay0,
    borderActive: c.lavender,

    text: c.text,
    textSubtle: c.subtext0,
    textMuted: c.overlay1,
    link: c.blue,
    cursor: c.rosewater,
    selection: c.overlay2,

    success: withSlot(c.green),
    warning: withSlot(c.yellow),
    error: withSlot(c.red),

    heading: withSlot(c.green),
    literal: withSlot(c.teal),
    placeholder: withSlot(c.teal),

    terminal: {
      foreground: c.text,
      background: c.base,
      ansi: f.ansi,
    },
  };
}

/** Mocha: werk's colours where the ground is dark. */
export const dark: Roles = roles("mocha");
/** Latte: werk's colours where the ground is light. */
export const light: Roles = roles("latte");

/** `background` → `--werk-background`, `backgroundSecondary` → `--werk-background-secondary`. */
const kebab = (name: string): string =>
  name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

/**
 * The roles as a CSS rule, for a page that would otherwise name colours itself.
 *
 * `terminal` becomes `--werk-terminal-foreground` and `--werk-terminal-background`;
 * its sixteen are not variables, because a page that needs them is decoding SGR
 * and wants the array.
 */
export function cssVariables(r: Roles, prefix = "--werk-"): string {
  const declarations: string[] = [];
  for (const [name, value] of Object.entries(r)) {
    if (name === "terminal") continue;
    declarations.push(`${prefix}${kebab(name)}:${(value as Swatch).hex}`);
  }
  declarations.push(
    `${prefix}terminal-foreground:${r.terminal.foreground.hex}`,
    `${prefix}terminal-background:${r.terminal.background.hex}`,
  );
  return `:root{${declarations.join(";")}}`;
}
