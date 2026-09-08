import { test, expect } from "bun:test";
import { flavors } from "@catppuccin/palette";
import {
  cssVariables,
  dark,
  flavours,
  light,
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

const names: FlavourName[] = ["latte", "mocha"];

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

test("a role werk writes as a slot has one", () => {
  const slotted: (keyof Roles)[] = [
    "success",
    "warning",
    "error",
    "heading",
    "literal",
    "placeholder",
  ];
  for (const name of names) {
    const r = roles(name);
    for (const key of slotted) {
      const swatch = r[key] as Swatch;
      const slot = swatch.ansi as AnsiSlot;
      expect(slot, `${name} ${key}`).not.toBeUndefined();
      expect(flavours[name].ansi[slot], `${name} ${key}`).toBe(swatch.hex);
    }
  }
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
  const chosen: Record<
    Exclude<
      keyof Roles,
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
    borderActive: "lavender",
    textSubtle: "subtext0",
    textMuted: "overlay1",
    heading: "green",
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

test("dark is Mocha and light is Latte", () => {
  expect(dark.background.hex).toBe(flavours.mocha.colours.base.hex);
  expect(light.background.hex).toBe(flavours.latte.colours.base.hex);
  expect(flavours.mocha.dark).toBe(true);
  expect(flavours.latte.dark).toBe(false);
});

test("cssVariables names every role a page could want", () => {
  const css = cssVariables(dark);
  expect(css.startsWith(":root{")).toBe(true);
  expect(css.endsWith("}")).toBe(true);
  const declared = new Set(
    [...css.matchAll(/--werk-([a-z-]+):/g)].map((m) => m[1]!),
  );
  // Every role but `terminal`, which contributes two of its own.
  for (const key of Object.keys(dark)) {
    if (key === "terminal") continue;
    const kebab = key.replace(/[A-Z]/g, (l) => `-${l.toLowerCase()}`);
    expect(declared.has(kebab), `--werk-${kebab} declared`).toBe(true);
  }
  expect(declared.has("terminal-foreground")).toBe(true);
  expect(declared.has("terminal-background")).toBe(true);
  for (const [role, value] of Object.entries(dark)) {
    if (role === "terminal") continue;
    const kebab = role.replace(/[A-Z]/g, (l) => `-${l.toLowerCase()}`);
    expect(css, `--werk-${kebab} value`).toContain(
      `--werk-${kebab}:${(value as Swatch).hex}`,
    );
  }
  expect(css).toContain(
    `--werk-terminal-background:${dark.terminal.background.hex}`,
  );
});
