import { test, expect } from "bun:test";
import { flavors } from "@catppuccin/palette";
import {
  ACCENTS,
  type AccentName,
  cssVariables,
  DEFAULT_ACCENT,
  defaultRoles,
  fallbackSlot,
  flavours,
  roles,
  type AnsiSlot,
  type ColourName,
  type FlavourName,
  type Roles,
  type Swatch,
} from "../src/index.js";

/**
 * The values in `src/index.ts` are transcribed from `@catppuccin/palette`, which
 * is a devDependency of this package alone. These tests are what stops the copy
 * drifting: every expectation is read off that package rather than written down
 * a second time, so a version bump that moves a colour fails here.
 */

const names: FlavourName[] = ["latte", "frappe", "macchiato", "mocha"];

test("every colour is the one Catppuccin publishes", () => {
  for (const name of names) {
    const ours = flavours[name];
    const theirs = flavors[name];
    expect(ours.dark, `${name} dark`).toBe(theirs.dark);
    const upstream = Object.entries(theirs.colors);
    // All twenty-six, so a colour cannot be quietly dropped from the copy.
    expect(Object.keys(ours.colours).length, `${name} colour count`).toBe(
      upstream.length,
    );
    for (const [colour, value] of upstream)
      expect(ours.colours[colour as ColourName]?.hex, `${name} ${colour}`).toBe(
        value.hex,
      );
  }
});

test("the sixteen sit in the slots Catppuccin's terminal mapping gives them", () => {
  for (const name of names) {
    const ours = flavours[name];
    for (const entry of Object.values(flavors[name].ansiColors)) {
      for (const variant of [entry.normal, entry.bright]) {
        // `code` is upstream's own slot number, so the order is theirs too.
        expect(ours.ansi[variant.code], `${name} slot ${variant.code}`).toBe(
          variant.hex,
        );
      }
    }
    expect(ours.ansi.length, `${name} table size`).toBe(16);
  }
});

test("a swatch's slot is one its own flavour actually holds", () => {
  for (const name of names) {
    const ours = flavours[name];
    for (const swatch of Object.values(ours.colours)) {
      if (swatch.ansi === undefined) {
        expect(ours.ansi.includes(swatch.hex), `${name} ${swatch.name}`).toBe(
          false,
        );
        continue;
      }
      expect(ours.ansi[swatch.ansi], `${name} ${swatch.name}`).toBe(swatch.hex);
    }
  }
});

test("the two flavours disagree about the grey slots, and each is followed", () => {
  // Latte puts subtext1 in the black slot where Mocha puts surface1. A slot
  // table copied from one flavour and reused for the other would fail here.
  expect(flavours.mocha.colours.surface1.ansi).toBe(0);
  expect(flavours.latte.colours.subtext1.ansi).toBe(0);
  expect(flavours.mocha.colours.subtext1.ansi).toBe(15);
  expect(flavours.latte.colours.surface1.ansi).toBe(15);
});

test("rgb is the hex, for the renderer that carries packed integers", () => {
  for (const name of names)
    for (const swatch of Object.values(flavours[name].colours))
      expect(swatch.rgb, `${name} ${swatch.name}`).toBe(
        Number.parseInt(swatch.hex.slice(1), 16),
      );
});

test("every accent has a slot to fall back to, and no grey does", () => {
  // A role werk colours is always an accent, so `fallbackSlot` has to be total
  // over the fourteen. The twelve greys get nothing, because nothing werk
  // colours comes from the ramp.
  for (const accent of ACCENTS)
    expect(fallbackSlot(accent), accent).not.toBeUndefined();
  const greys = (Object.keys(flavours.mocha.colours) as ColourName[]).filter(
    (name) => !(ACCENTS as readonly string[]).includes(name),
  );
  expect(greys.length).toBe(12);
  for (const grey of greys) expect(fallbackSlot(grey), grey).toBeUndefined();
});

test("the slots Catppuccin does assign are the ones it assigns", () => {
  // Six of the fourteen sit in the sixteen upstream, and upstream publishes the
  // SGR code for each. Those six are read back rather than restated; the other
  // eight are werk's and are asserted in the table below.
  for (const name of names) {
    const upstream = new Map<string, number>();
    for (const entry of Object.values(flavors[name].ansiColors))
      upstream.set(entry.normal.hex, entry.normal.code);
    for (const accent of ACCENTS) {
      const code = upstream.get(flavours[name].colours[accent].hex);
      if (code === undefined) continue;
      expect(fallbackSlot(accent), `${name} ${accent}`).toBe(code);
    }
  }
});

test("the slots werk assigns itself are the ones written down here", () => {
  // The eight Catppuccin places nowhere in the sixteen. Nothing upstream can be
  // read to check them, so moving one is a deliberate edit to this table.
  const ours: Partial<Record<AccentName, AnsiSlot>> = {
    mauve: 5,
    rosewater: 5,
    maroon: 1,
    flamingo: 1,
    peach: 3,
    sky: 6,
    sapphire: 6,
    lavender: 4,
  };
  for (const [accent, slot] of Object.entries(ours))
    expect(fallbackSlot(accent as AccentName), accent).toBe(slot);
  // And they really are the ones upstream leaves out.
  for (const accent of Object.keys(ours) as AccentName[])
    expect(flavours.mocha.colours[accent].ansi, accent).toBeUndefined();
});

test("the roles Catppuccin's style guide has an opinion about follow it", () => {
  for (const name of names) {
    const c = flavours[name].colours;
    const r = roles(name);
    expect(r.success.name, `${name} success`).toBe("green");
    expect(r.warning.name, `${name} warning`).toBe("yellow");
    expect(r.error.name, `${name} error`).toBe("red");
    expect(r.link.name, `${name} link`).toBe("blue");
    expect(r.cursor.name, `${name} cursor`).toBe("rosewater");
    expect(r.selection.name, `${name} selection`).toBe("overlay2");
    expect(r.background, `${name} background`).toBe(c.base);
    expect(r.text, `${name} text`).toBe(c.text);
    expect(r.terminal.foreground, `${name} replica foreground`).toBe(c.text);
    expect(r.terminal.background, `${name} replica background`).toBe(c.base);
    expect(r.terminal.ansi, `${name} replica sixteen`).toBe(
      flavours[name].ansi,
    );
  }
});

test("the roles werk reads for itself are the colours it chose", () => {
  // Catppuccin's style guide has no opinion about these, so nothing upstream
  // can be read to check them: the assignments are werk's own. Every consumer
  // test reads its expectation off the palette and would follow a change here
  // without objecting, so this is the one place the choice is written down a
  // second time. Moving a role is a deliberate edit to this table, not a silent
  // change.
  //
  // The key type asks for every role the style-guide test above does not cover,
  // so a role added to `Roles` and left out of this table is a type error. That
  // is a constraint a typechecker reading this file would catch, and `bun run
  // typecheck` is not one: every package's `tsconfig.json` includes `src` only,
  // and `bun test` strips types rather than checking them. Treat it as a note to
  // a reader until something typechecks the tests.
  //
  // `accent`, `borderActive` and `heading` are not here: they are whatever
  // accent was chosen, which the accent test above covers for all fourteen.
  const chosen: Record<
    Exclude<
      keyof Roles,
      | "flavour"
      | "accent"
      | "borderActive"
      | "heading"
      | "background"
      | "text"
      | "link"
      | "cursor"
      | "selection"
      | "success"
      | "warning"
      | "error"
      | "terminal"
    >,
    ColourName
  > = {
    backgroundSecondary: "mantle",
    backgroundDeep: "crust",
    surface: "surface0",
    surfaceHover: "surface1",
    border: "surface2",
    borderInactive: "overlay0",
    textSubtle: "subtext0",
    textMuted: "overlay1",
    literal: "teal",
    placeholder: "teal",
  };
  for (const name of names) {
    const r = roles(name);
    const actual = Object.fromEntries(
      Object.keys(chosen).map((role) => [
        role,
        (r[role as keyof Roles] as Swatch).name,
      ]),
    );
    expect(actual, `${name} roles`).toEqual(chosen);
  }
});

test("the roles a consumer gets by default are Mocha with a mauve accent", () => {
  expect(defaultRoles.flavour).toBe("mocha");
  expect(defaultRoles.background.hex).toBe(flavours.mocha.colours.base.hex);
  expect(defaultRoles.accent.name).toBe(DEFAULT_ACCENT);
  expect(defaultRoles.accent.hex).toBe(flavours.mocha.colours.mauve.hex);
  // Latte is the only flavour with a light ground, which is what makes it the
  // one a detected light terminal resolves to.
  expect(flavours.latte.dark).toBe(false);
  for (const name of ["frappe", "macchiato", "mocha"] as const)
    expect(flavours[name].dark, name).toBe(true);
});

test("the accent reaches chrome and never reaches meaning", () => {
  for (const name of names)
    for (const accent of ACCENTS) {
      const r = roles(name, accent);
      const c = flavours[name].colours;
      expect(r.accent, `${name}/${accent} accent`).toBe(c[accent]);
      expect(r.borderActive, `${name}/${accent} borderActive`).toBe(c[accent]);
      expect(r.heading, `${name}/${accent} heading`).toBe(c[accent]);
      // Whatever the accent, these say what they mean.
      expect(r.success, `${name}/${accent} success`).toBe(c.green);
      expect(r.warning, `${name}/${accent} warning`).toBe(c.yellow);
      expect(r.error, `${name}/${accent} error`).toBe(c.red);
      expect(r.link, `${name}/${accent} link`).toBe(c.blue);
      expect(r.cursor, `${name}/${accent} cursor`).toBe(c.rosewater);
    }
});

test("cssVariables names every role a page could want", () => {
  const css = cssVariables(defaultRoles);
  expect(css.startsWith(":root{")).toBe(true);
  expect(css.endsWith("}")).toBe(true);
  const declared = new Set(
    [...css.matchAll(/--werk-([a-z-]+):/g)].map((m) => m[1]!),
  );
  expect(declared.has("flavour")).toBe(true);
  // Every role but `terminal`, which contributes two of its own, and `flavour`,
  // which is a name rather than a colour.
  for (const key of Object.keys(defaultRoles)) {
    if (key === "terminal" || key === "flavour") continue;
    const kebab = key.replace(/[A-Z]/g, (l) => `-${l.toLowerCase()}`);
    expect(declared.has(kebab), `--werk-${kebab} declared`).toBe(true);
  }
  expect(declared.has("terminal-foreground")).toBe(true);
  expect(declared.has("terminal-background")).toBe(true);
  for (const [role, value] of Object.entries(defaultRoles)) {
    if (role === "terminal" || role === "flavour") continue;
    const kebab = role.replace(/[A-Z]/g, (l) => `-${l.toLowerCase()}`);
    expect(css, `--werk-${kebab} value`).toContain(
      `--werk-${kebab}:${(value as Swatch).hex}`,
    );
  }
  expect(css).toContain(
    `--werk-terminal-background:${defaultRoles.terminal.background.hex}`,
  );
  // A selector other than `:root` is what lets a page carry two flavours.
  const latte = cssVariables(roles("latte"), "--werk-", ":root[data-x]");
  expect(latte.startsWith(":root[data-x]{")).toBe(true);
  expect(latte).toContain("--werk-flavour:latte");
  expect(latte).toContain("--werk-accent:#8839ef");
  expect(latte).toContain("--werk-terminal-background:#eff1f5");
});

test("the accents are the fourteen Catppuccin flags as accents", () => {
  for (const name of names) {
    const upstream = flavors[name].colorEntries
      .filter(([, colour]) => colour.accent)
      .map(([colour]) => colour);
    expect(ACCENTS, `${name} accents`).toEqual(upstream as AccentName[]);
  }
});
