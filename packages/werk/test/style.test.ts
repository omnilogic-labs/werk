/**
 * That werk's own output borrows the reader's terminal theme rather than
 * overriding it, and that it says nothing at all when the gate says nothing.
 *
 * The expectations are read off `@werk/palette`, so a role reassigned there is
 * a change these tests demand rather than one they have to be edited for.
 */
import { expect, test } from "bun:test";
import { dark, flavours, light, type AnsiSwatch } from "@werk/palette";
import { createStyles, type Styles } from "../src/runtime/style.js";
import type { ColourLevel } from "../src/runtime/colour.js";

const MEMBERS: (keyof Styles)[] = [
  "heading",
  "literal",
  "placeholder",
  "success",
  "warning",
  "error",
  "muted",
  "emphasis",
];

const LEVELS: ColourLevel[] = [1, 2, 3];

test("at level 0 every role hands the text back untouched", () => {
  const styles = createStyles(0);
  for (const member of MEMBERS)
    expect(styles[member]("werk"), member).toBe("werk");
});

test("no role ever pins a colour the reader cannot remap", () => {
  for (const level of LEVELS) {
    const styles = createStyles(level);
    for (const member of MEMBERS) {
      const out = styles[member]("werk");
      expect(out.includes("38;2"), `${member} at ${level}`).toBe(false);
      expect(out.includes("38;5"), `${member} at ${level}`).toBe(false);
      expect(out.includes("48;"), `${member} at ${level}`).toBe(false);
    }
  }
});

test("a role's bytes do not change with the depth the gate reports", () => {
  const [first, ...rest] = LEVELS.map((level) => createStyles(level));
  for (const member of MEMBERS)
    for (const other of rest)
      expect(other[member]("werk"), member).toBe(first![member]("werk"));
});

test("a coloured role asks for the slot the palette gives it", () => {
  const styles = createStyles(3);
  const cases: [keyof Styles, AnsiSwatch][] = [
    ["heading", dark.heading],
    ["literal", dark.literal],
    ["placeholder", dark.placeholder],
    ["success", dark.success],
    ["warning", dark.warning],
    ["error", dark.error],
  ];
  for (const [member, swatch] of cases) {
    const code = swatch.ansi < 8 ? 30 + swatch.ansi : 90 + swatch.ansi - 8;
    expect(styles[member]("werk"), member).toContain(`[${code}m`);
  }
});

test("weight is weight: muted and emphasis carry no colour", () => {
  const styles = createStyles(3);
  expect(styles.muted("werk")).toBe("\x1b[2mwerk\x1b[22m");
  expect(styles.emphasis("werk")).toBe("\x1b[1mwerk\x1b[22m");
});

test("which flavour the CLI reads its roles from cannot change the bytes", () => {
  // Catppuccin puts green, teal, red and yellow in the same four slots in every
  // flavour, so reading the roles from the dark one is a choice with no reader
  // visible consequence. If upstream ever moved one, this is where it surfaces.
  for (const role of [
    "heading",
    "literal",
    "placeholder",
    "success",
    "warning",
    "error",
  ] as const)
    expect(light[role].ansi, role).toBe(dark[role].ansi);
  expect(flavours.latte.name).toBe("latte");
});
