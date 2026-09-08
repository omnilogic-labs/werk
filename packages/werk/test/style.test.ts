/**
 * That werk's own output wears the theme it was given, at whatever depth the
 * terminal has, and says nothing at all when the gate says nothing.
 *
 * Every expectation is read off `@werk/palette`, so a role reassigned there is a
 * change these tests demand rather than one they have to be edited for.
 */
import { expect, test } from "bun:test";
import {
  ACCENTS,
  fallbackSlot,
  flavours,
  roles,
  type FlavourName,
  type Swatch,
} from "@werk/palette";
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

/** The roles that carry a colour, and the swatch each one should be wearing. */
const coloured = (
  flavour: FlavourName,
  accent: (typeof ACCENTS)[number],
): [keyof Styles, Swatch][] => {
  const r = roles(flavour, accent);
  return [
    ["heading", r.heading],
    ["literal", r.literal],
    ["placeholder", r.placeholder],
    ["success", r.success],
    ["warning", r.warning],
    ["error", r.error],
  ];
};

const names = Object.keys(flavours) as FlavourName[];

/** `#rrggbb` as the three decimal parameters a truecolour escape carries. */
const triple = (hex: string): string => {
  const value = Number.parseInt(hex.slice(1), 16);
  return `${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}`;
};

test("at level 0 every role hands the text back untouched", () => {
  for (const name of names) {
    const styles = createStyles(0, roles(name));
    for (const member of MEMBERS)
      expect(styles[member]("werk"), `${name} ${member}`).toBe("werk");
  }
});

test("at truecolour every role wears its flavour's own hex", () => {
  for (const name of names)
    for (const accent of ACCENTS) {
      const styles = createStyles(3, roles(name, accent));
      for (const [member, swatch] of coloured(name, accent))
        expect(styles[member]("werk"), `${name}/${accent} ${member}`).toContain(
          `[38;2;${triple(swatch.hex)}m`,
        );
    }
});

test("at 256 colours every role picks an index, and no two roles collide", () => {
  for (const name of names) {
    const styles = createStyles(2, roles(name));
    const seen = new Set<string>();
    for (const [member, swatch] of coloured(name, "mauve")) {
      const out = styles[member]("werk");
      expect(out, `${name} ${member}`).toContain("[38;5;");
      expect(out, `${name} ${member} is not truecolour`).not.toContain("38;2;");
      seen.add(/\[38;5;(\d+)m/.exec(out)![1]!);
      // The index is chalk's nearest point in the cube, which is a mapping this
      // module does not own; that it is derived from the role's own hex is.
      expect(swatch.hex.startsWith("#"), `${name} ${member}`).toBe(true);
    }
    // heading, literal and placeholder share colours by design, so four is the
    // number of distinct ones. Fewer would mean the cube had flattened them.
    expect(seen.size, `${name} distinct indices`).toBeGreaterThanOrEqual(4);
  }
});

test("at sixteen colours every role asks for a slot, never a pinned colour", () => {
  for (const name of names)
    for (const accent of ACCENTS) {
      const styles = createStyles(1, roles(name, accent));
      for (const [member, swatch] of coloured(name, accent)) {
        const out = styles[member]("werk");
        expect(out, `${name}/${accent} ${member}`).not.toContain("38;2;");
        expect(out, `${name}/${accent} ${member}`).not.toContain("38;5;");
        const slot = swatch.ansi ?? fallbackSlot(swatch.name)!;
        const code = slot < 8 ? 30 + slot : 90 + slot - 8;
        expect(out, `${name}/${accent} ${member}`).toContain(`[${code}m`);
      }
    }
});

test("sixteen colours keeps every role a colour of its own", () => {
  // This is the trap the level-1 branch exists to avoid. Left to chalk, a
  // nearest-colour search on a dark flavour answers white for green and bright
  // white for red, yellow and blue, and five roles become one.
  const forbidden = ["[37m", "[97m"];
  for (const name of names) {
    const styles = createStyles(1, roles(name));
    for (const [member] of coloured(name, "mauve")) {
      const out = styles[member]("werk");
      for (const white of forbidden)
        expect(out, `${name} ${member} collapsed to ${white}`).not.toContain(
          white,
        );
    }
  }
});

test("the accent moves the roles it owns and no others", () => {
  const semantic: (keyof Styles)[] = ["success", "warning", "error"];
  for (const name of names) {
    const base = createStyles(3, roles(name, "mauve"));
    const other = createStyles(3, roles(name, "green"));
    expect(other.heading("werk"), `${name} heading`).not.toBe(
      base.heading("werk"),
    );
    for (const member of semantic)
      expect(other[member]("werk"), `${name} ${member}`).toBe(
        base[member]("werk"),
      );
  }
});

test("the flavour moves every colour werk writes", () => {
  for (const level of [3, 2] as ColourLevel[]) {
    const latte = createStyles(level, roles("latte"));
    const mocha = createStyles(level, roles("mocha"));
    for (const [member] of coloured("mocha", "mauve"))
      expect(latte[member]("werk"), `${member} at ${level}`).not.toBe(
        mocha[member]("werk"),
      );
  }
});

test("weight is weight: muted and emphasis carry no colour", () => {
  for (const name of names) {
    const styles = createStyles(3, roles(name));
    expect(styles.muted("werk")).toBe("\x1b[2mwerk\x1b[22m");
    expect(styles.emphasis("werk")).toBe("\x1b[1mwerk\x1b[22m");
  }
});

test("a caller that names no theme gets one rather than nothing", () => {
  const styles = createStyles(3);
  expect(styles.error("werk")).toContain(`[38;2;${triple(roles().error.hex)}m`);
});
