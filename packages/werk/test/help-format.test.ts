/**
 * That a help page is laid out the same way wherever you land in the tree.
 *
 * These are properties of the page, not its prose: which sections appear and in
 * what order, how a name you substitute is spelled, where the `--` of a flag
 * sits, what the last line is, and which colours are allowed. Every one of them
 * holds for every command including the hidden ones, so a command added later
 * cannot quietly render differently from the rest.
 *
 * Nothing here pins wording, and there is no golden page. A test that has to be
 * regenerated whenever a sentence changes stops being read and starts being
 * reset; `help.test.ts` makes the same argument about the same surface.
 */
import { expect, test } from "bun:test";
import type { Command } from "@commander-js/extra-typings";
import { buildProgram } from "../src/app.js";
import { JSON_FOOTER } from "../src/runtime/help.js";
import {
  fallbackSlot,
  roles,
  type FlavourName,
  type Roles,
  type Swatch,
} from "@werk/palette";
import type { RuntimeBasis } from "../src/commands/shared.js";

/** Every node of the tree, hidden commands included, as a person types it. */
function walk(
  command: Command,
  path = "werk",
): { path: string; command: Command }[] {
  return [
    { path, command },
    ...command.commands.flatMap((child) =>
      walk(child as Command, `${path} ${(child as Command).name()}`),
    ),
  ];
}

/**
 * A page as it reaches a terminal, footer and all.
 *
 * The width is pinned so nothing here moves with the window the suite runs in,
 * and every node is configured rather than only the root: `configureOutput`
 * builds a fresh configuration object, and the children took their copy of the
 * old reference when the tree was built.
 */
function pages(
  argv: string[] = ["--no-color"],
  env = {},
  theme?: Roles,
): Map<string, string> {
  const basis: RuntimeBasis | undefined =
    theme === undefined ? undefined : { entry: "", level: 3, theme };
  const program = buildProgram(argv, basis, env);
  const rendered = new Map<string, string>();
  for (const { path, command } of walk(program)) {
    let text = "";
    for (const node of walk(command).map((n) => n.command))
      node.configureOutput({
        getOutHelpWidth: () => 80,
        getErrHelpWidth: () => 80,
        writeOut: (str) => void (text += str),
      });
    command.outputHelp();
    rendered.set(path, text);
  }
  return rendered;
}

/** The sections a page may carry, in the only order they may appear in. */
const SECTIONS = [
  "Usage:",
  "Examples:",
  "Arguments:",
  "Commands:",
  "Options:",
  "Global Options:",
] as const;

/** The headings this page actually shows, in the order it shows them. */
function headings(page: string): string[] {
  return page
    .split("\n")
    .map((line) =>
      SECTIONS.find(
        (section) => line === section || line.startsWith(`${section} `),
      ),
    )
    .filter((section): section is (typeof SECTIONS)[number] =>
      Boolean(section),
    );
}

/** The lines of one section, up to the blank line that closes it. */
function block(page: string, heading: string): string[] {
  const lines = page.split("\n");
  const start = lines.indexOf(heading);
  if (start === -1) return [];
  const rest = lines.slice(start + 1);
  const end = rest.indexOf("");
  return end === -1 ? rest : rest.slice(0, end);
}

// Read off the module that writes it, so rewording the sentence does not have
// to be mirrored here.
const FOOTER = JSON_FOOTER;

test("every page shows its sections in the same order", () => {
  for (const [path, page] of pages()) {
    const shown = headings(page);
    expect(shown[0], `${path} does not lead with the usage line`).toBe(
      "Usage:",
    );
    const order = shown.map((heading) => SECTIONS.indexOf(heading));
    expect(order, `${path} sections out of order: ${shown.join(", ")}`).toEqual(
      [...order].sort((a, b) => a - b),
    );
    // A heading and its first item are not separated, and a section is closed
    // by exactly one blank line.
    for (const heading of shown.slice(1))
      expect(
        block(page, heading).length,
        `${path} ${heading} is empty`,
      ).toBeGreaterThan(0);
  }
});

test("a name you substitute is spelled the same way everywhere", () => {
  for (const [path, page] of pages())
    for (const lowercase of ["[options]", "[command]", "[session]", "<key>"])
      expect(page, `${path} still renders ${lowercase}`).not.toContain(
        lowercase,
      );
});

test("a flag's long form sits in one column whether or not it has a short form", () => {
  for (const [path, page] of pages())
    for (const heading of ["Options:", "Global Options:"])
      for (const line of block(page, heading)) {
        // Continuation lines of a wrapped description are not option lines.
        if (!line.trimStart().startsWith("-")) continue;
        expect(line, `${path} ${heading}: ${line}`).toMatch(
          /^(?: {2}-[A-Za-z], --| {6}--)/,
        );
      }
});

test("every page ends by saying where --json works", () => {
  for (const [path, page] of pages()) {
    expect(page.endsWith("\n"), `${path} does not end with one newline`).toBe(
      true,
    );
    expect(page.endsWith("\n\n"), `${path} ends with a blank line`).toBe(false);
    const lines = page.trimEnd().split("\n");
    expect(lines.at(-1), `${path} has no footer`).toBe(FOOTER);
  }
});

test("a page's colours change with the depth the gate reports", () => {
  // The three depths are three different answers on purpose: a truecolour page
  // wears the flavour exactly, a 256-colour page wears the nearest point in the
  // cube, and a sixteen-colour page borrows the reader's own sixteen. A page
  // that read identically at all three would be one that had given up on two of
  // them.
  const [sixteen, indexed, full] = [
    { TERM: "xterm" },
    { TERM: "xterm-256color" },
    { COLORTERM: "truecolor" },
  ].map((env) => pages(["--color"], env));
  for (const [path, page] of full!) {
    expect(page, `${path} is not truecolour`).toContain("[38;2;");
    expect(indexed!.get(path), `${path} at 256`).toContain("[38;5;");
    expect(indexed!.get(path), `${path} at 256`).not.toContain("[38;2;");
    expect(sixteen!.get(path), `${path} at 16`).not.toContain("[38;");
  }
});

/** The SGR parameter that selects a foreground: 30-37 for the eight, 90-97 for the bright. */
const foregroundOf = (swatch: Swatch): string => {
  const slot = swatch.ansi ?? fallbackSlot(swatch.name)!;
  return String(slot < 8 ? 30 + slot : 90 + slot - 8);
};

test("at sixteen colours a page asks only for slots the reader can remap", () => {
  // The expectation is the palette's rather than a second copy of it. At this
  // depth werk cannot show the flavour, so it shows the hue and lets the reader's
  // own theme decide what that hue is.
  const theme = roles();
  const wanted = new Set(
    [theme.heading, theme.literal, theme.placeholder].map(foregroundOf),
  );
  const typographic = new Set(["0", "1", "2", "22", "39"]);
  for (const [path, page] of pages(["--color"], { TERM: "xterm" })) {
    const codes = [...page.matchAll(/\[([0-9;]*)m/g)].map((m) => m[1]!);
    expect(codes.length, `${path} is not coloured at all`).toBeGreaterThan(0);
    for (const code of new Set(codes)) {
      expect(
        /(?:^|;)[34]8;/.test(code),
        `${path} pins a colour with SGR ${code}`,
      ).toBe(false);
      if (typographic.has(code)) continue;
      expect(wanted.has(code), `${path} uses SGR ${code}`).toBe(true);
    }
    for (const role of wanted)
      expect(codes.includes(role), `${path} never uses SGR ${role}`).toBe(true);
  }
});

test("at truecolour a page wears the flavour it was given", () => {
  const hex = (swatch: Swatch): string => {
    const value = Number.parseInt(swatch.hex.slice(1), 16);
    return `[38;2;${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}m`;
  };
  for (const name of [
    "latte",
    "frappe",
    "macchiato",
    "mocha",
  ] as FlavourName[]) {
    const theme = roles(name);
    const rendered = pages(["--color"], { COLORTERM: "truecolor" }, theme);
    for (const [path, page] of rendered) {
      expect(page, `${path} heading in ${name}`).toContain(hex(theme.heading));
      expect(page, `${path} literal in ${name}`).toContain(hex(theme.literal));
    }
  }
});

test("descriptions carry no colour of their own", () => {
  const plain = pages();
  const coloured = pages(["--color"], { COLORTERM: "truecolor" });
  for (const { path, command } of walk(buildProgram(["--no-color"]))) {
    const flat = plain.get(path)!;
    const styled = coloured.get(path)!;
    for (const option of command.options) {
      // A description that wrapped is not one contiguous string to look for.
      if (option.description === "" || !flat.includes(option.description))
        continue;
      const at = styled.indexOf(option.description);
      expect(
        at,
        `${path}: ${option.flags} description missing`,
      ).toBeGreaterThan(0);
      expect(
        styled[at - 1],
        `${path}: ${option.flags} description is styled`,
      ).toBe(" ");
    }
  }
});
