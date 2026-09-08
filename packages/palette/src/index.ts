/**
 * The colours werk uses, and what it uses them for.
 *
 * The palette is [Catppuccin](https://github.com/catppuccin/catppuccin). This
 * module holds its four flavours — Latte, Frappé, Macchiato and Mocha — and,
 * above them, a set of *roles*: `error`, `heading`, `border`,
 * `terminal.background` and the rest. Everywhere werk puts colour on a screen it
 * asks for a role, so the question "what colour is an error" is answered once,
 * here.
 *
 * ## A flavour and an accent
 *
 * Catppuccin's model is a flavour plus an accent. The flavour decides the
 * ground and the twelve-step ramp of greys above it; the accent is one of the
 * fourteen chromatic colours, and it is what marks the thing being attended to.
 * `roles(flavour, accent)` composes the two. The accent reaches `accent`,
 * `borderActive` and `heading`, and reaches nothing that carries meaning: an
 * error is red and a success is green whatever accent is chosen, which is what
 * every Catppuccin port does and what keeps the output legible when somebody
 * picks red as their accent.
 *
 * ## Slots, for a terminal that has only sixteen colours
 *
 * A `Swatch` carries `hex` for a surface that owns its own pixels and `rgb` for
 * the renderer, which are the two forms most consumers want. `ansi` is the
 * third: the slot Catppuccin's own terminal mapping gives a colour, looked up in
 * its flavour's sixteen rather than typed by hand, so a colour Catppuccin does
 * not place in the sixteen cannot acquire a slot by a typo.
 *
 * Only six of the fourteen accents have one, so `fallbackSlot` covers the rest.
 * That table is werk's, not Catppuccin's: see `PROVENANCE.md`.
 *
 * ## Where the values came from
 *
 * Transcribed from `@catppuccin/palette`, which is a devDependency of this
 * package and nothing else's. `test/palette.test.ts` compares every value here
 * against that package, so the copy cannot drift quietly. See `PROVENANCE.md`.
 */

/** Catppuccin's four flavours, lightest first. */
export type FlavourName = "latte" | "frappe" | "macchiato" | "mocha";

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

/**
 * The fourteen colours Catppuccin marks as accents.
 *
 * They are the analogous half of a flavour: every colour in the rainbow. The
 * other twelve are the monochromatic ramp from `text` down to `crust`, which is
 * what a flavour builds its surfaces out of. Upstream flags the fourteen in
 * `palette.json` and the same fourteen are accents in all four flavours.
 */
export type AccentName = Extract<
  ColourName,
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
>;

/** Every accent, in the order the palette publishes them. */
export const ACCENTS: readonly AccentName[] = [
  "rosewater",
  "flamingo",
  "pink",
  "mauve",
  "red",
  "maroon",
  "peach",
  "yellow",
  "green",
  "teal",
  "sky",
  "sapphire",
  "blue",
  "lavender",
];

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

/**
 * The slot to write a colour as on a terminal that has only sixteen.
 *
 * **This table is werk's, not Catppuccin's.** Catppuccin places six of the
 * fourteen accents in the sixteen — red, green, yellow and blue at 1 to 4, pink
 * at 5 because magenta is Pink rather than Mauve, and teal at 6 because cyan is
 * Teal rather than Sky — and says nothing at all about the other eight. Peach
 * and Rosewater it puts at 16 and 17, which are outside the sixteen a `3x` SGR
 * parameter can name.
 *
 * The eight werk assigns go to the nearest slot by hue, so that a reader on a
 * sixteen-colour terminal still sees the accent as a colour of its own rather
 * than as whichever grey a nearest-colour search lands on. That search is the
 * thing being avoided: chalk downsamples Mocha's green to white and its red,
 * yellow and blue all to bright white, which loses every distinction the roles
 * exist to make.
 *
 * The twelve greys of the monochromatic ramp get nothing. werk writes no role
 * from them at a depth where this table is consulted.
 */
export function fallbackSlot(name: ColourName): AnsiSlot | undefined {
  switch (name) {
    // Catppuccin's own mapping.
    case "red":
      return 1;
    case "green":
      return 2;
    case "yellow":
      return 3;
    case "blue":
      return 4;
    case "pink":
      return 5;
    case "teal":
      return 6;
    // werk's, by nearest hue.
    case "maroon":
    case "flamingo":
      return 1;
    case "peach":
      return 3;
    case "sky":
    case "sapphire":
      return 6;
    case "lavender":
      return 4;
    case "mauve":
    case "rosewater":
      return 5;
    default:
      return undefined;
  }
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
  /** Which flavour and accent these roles were composed from. */
  readonly flavour: FlavourName;
  /** The chosen accent, so a consumer can ask for it without knowing its name. */
  readonly accent: Swatch;

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
  /** The line around the thing that is. The accent. */
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

  /** It worked. Green, whatever the accent is. */
  readonly success: Swatch;
  /** It might not have. Yellow, whatever the accent is. */
  readonly warning: Swatch;
  /** It did not. Red, whatever the accent is. */
  readonly error: Swatch;

  /** A section heading on a help page. The accent. */
  readonly heading: Swatch;
  /** Something the reader can type back verbatim. */
  readonly literal: Swatch;
  /** A name the reader substitutes something of their own for. */
  readonly placeholder: Swatch;

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

const frappe = flavour(
  "frappe",
  true,
  {
    rosewater: "#f2d5cf",
    flamingo: "#eebebe",
    pink: "#f4b8e4",
    mauve: "#ca9ee6",
    red: "#e78284",
    maroon: "#ea999c",
    peach: "#ef9f76",
    yellow: "#e5c890",
    green: "#a6d189",
    teal: "#81c8be",
    sky: "#99d1db",
    sapphire: "#85c1dc",
    blue: "#8caaee",
    lavender: "#babbf1",
    text: "#c6d0f5",
    subtext1: "#b5bfe2",
    subtext0: "#a5adce",
    overlay2: "#949cbb",
    overlay1: "#838ba7",
    overlay0: "#737994",
    surface2: "#626880",
    surface1: "#51576d",
    surface0: "#414559",
    base: "#303446",
    mantle: "#292c3c",
    crust: "#232634",
  },
  [
    "#51576d",
    "#e78284",
    "#a6d189",
    "#e5c890",
    "#8caaee",
    "#f4b8e4",
    "#81c8be",
    "#a5adce",
    "#626880",
    "#e67172",
    "#8ec772",
    "#d9ba73",
    "#7b9ef0",
    "#f2a4db",
    "#5abfb5",
    "#b5bfe2",
  ],
);

const macchiato = flavour(
  "macchiato",
  true,
  {
    rosewater: "#f4dbd6",
    flamingo: "#f0c6c6",
    pink: "#f5bde6",
    mauve: "#c6a0f6",
    red: "#ed8796",
    maroon: "#ee99a0",
    peach: "#f5a97f",
    yellow: "#eed49f",
    green: "#a6da95",
    teal: "#8bd5ca",
    sky: "#91d7e3",
    sapphire: "#7dc4e4",
    blue: "#8aadf4",
    lavender: "#b7bdf8",
    text: "#cad3f5",
    subtext1: "#b8c0e0",
    subtext0: "#a5adcb",
    overlay2: "#939ab7",
    overlay1: "#8087a2",
    overlay0: "#6e738d",
    surface2: "#5b6078",
    surface1: "#494d64",
    surface0: "#363a4f",
    base: "#24273a",
    mantle: "#1e2030",
    crust: "#181926",
  },
  [
    "#494d64",
    "#ed8796",
    "#a6da95",
    "#eed49f",
    "#8aadf4",
    "#f5bde6",
    "#8bd5ca",
    "#a5adcb",
    "#5b6078",
    "#ec7486",
    "#8ccf7f",
    "#e1c682",
    "#78a1f6",
    "#f2a9dd",
    "#63cbc0",
    "#b8c0e0",
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
  frappe,
  macchiato,
  mocha,
};

/** werk's conventional default accent, and Catppuccin's across every port. */
export const DEFAULT_ACCENT: AccentName = "mauve";
/** The flavour werk wears when nothing has said otherwise. */
export const DEFAULT_FLAVOUR: FlavourName = "mocha";

/**
 * What each colour of a flavour is for, with one accent chosen.
 *
 * The accent reaches `accent`, `borderActive` and `heading`. It reaches nothing
 * that carries meaning: `success`, `warning` and `error` are green, yellow and
 * red whatever is chosen, which is what every Catppuccin port does. An accent
 * that could turn an error green would be a theme that lies.
 */
export function roles(
  name: FlavourName = DEFAULT_FLAVOUR,
  accent: AccentName = DEFAULT_ACCENT,
): Roles {
  const f = flavours[name];
  const c = f.colours;
  return {
    flavour: name,
    accent: c[accent],

    background: c.base,
    backgroundSecondary: c.mantle,
    backgroundDeep: c.crust,
    surface: c.surface0,
    surfaceHover: c.surface1,
    border: c.surface2,
    borderInactive: c.overlay0,
    borderActive: c[accent],

    text: c.text,
    textSubtle: c.subtext0,
    textMuted: c.overlay1,
    link: c.blue,
    cursor: c.rosewater,
    selection: c.overlay2,

    success: c.green,
    warning: c.yellow,
    error: c.red,

    heading: c[accent],
    literal: c.teal,
    placeholder: c.teal,

    terminal: {
      foreground: c.text,
      background: c.base,
      ansi: f.ansi,
    },
  };
}

/**
 * The roles a consumer gets when it has not been told which to wear.
 *
 * A default argument rather than a second exported flavour: a module-level
 * `dark` and `light` beside each other is how a flavour ends up fixed at build
 * time, which is the thing this package exists not to do.
 */
export const defaultRoles: Roles = roles();

/** `background` → `--werk-background`, `backgroundSecondary` → `--werk-background-secondary`. */
const kebab = (name: string): string =>
  name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

/**
 * The roles as a CSS rule, for a page that would otherwise name colours itself.
 *
 * `terminal` becomes `--werk-terminal-foreground` and `--werk-terminal-background`;
 * its sixteen are not variables, because a page that needs them is decoding SGR
 * and wants the array. `flavour` is a name rather than a colour and becomes
 * `--werk-flavour`, so a page can read back which one it is wearing.
 *
 * `selector` is what the declarations are hung on. A page that offers both a
 * light and a dark ground emits the rule twice, once under `:root` and once
 * inside a `prefers-color-scheme` block.
 */
export function cssVariables(
  r: Roles,
  prefix = "--werk-",
  selector = ":root",
): string {
  const declarations: string[] = [`${prefix}flavour:${r.flavour}`];
  for (const [name, value] of Object.entries(r)) {
    if (name === "terminal" || name === "flavour") continue;
    declarations.push(`${prefix}${kebab(name)}:${(value as Swatch).hex}`);
  }
  declarations.push(
    `${prefix}terminal-foreground:${r.terminal.foreground.hex}`,
    `${prefix}terminal-background:${r.terminal.background.hex}`,
  );
  return `${selector}{${declarations.join(";")}}`;
}
