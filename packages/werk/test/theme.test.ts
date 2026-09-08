/**
 * Which flavour werk lands on, for every combination of what it was told and
 * what it managed to learn.
 *
 * `resolveTheme` and `probeAllowed` take every input as an argument, so all of
 * this runs with no terminal, no environment and no clock.
 */
import { expect, test } from "bun:test";
import { flavours } from "@werk/palette";
import {
  groundFromRgb,
  probeAllowed,
  resolveTheme,
  type ThemeConfig,
} from "../src/runtime/theme.js";
import { builtInDefaults } from "../src/config/schema.js";

const config = (over: Partial<ThemeConfig> = {}): ThemeConfig => {
  const base = builtInDefaults({}, "/home/nobody");
  return {
    flavour: base.flavour,
    flavourDark: base.flavourDark,
    flavourLight: base.flavourLight,
    accent: base.accent,
    ...over,
  };
};

test("the defaults are auto, mocha for dark, latte for light, mauve", () => {
  const c = config();
  expect(c.flavour).toBe("auto");
  expect(c.flavourDark).toBe("mocha");
  expect(c.flavourLight).toBe("latte");
  expect(c.accent).toBe("mauve");
  // Latte is the only flavour with a light ground, so it is the only sensible
  // thing for a light terminal to resolve to.
  expect(flavours[c.flavourLight].dark).toBe(false);
  expect(flavours[c.flavourDark].dark).toBe(true);
});

test("auto follows the ground the terminal reported", () => {
  expect(resolveTheme({ config: config(), ground: "light" })).toMatchObject({
    flavour: "latte",
    source: "detected",
  });
  expect(resolveTheme({ config: config(), ground: "dark" })).toMatchObject({
    flavour: "mocha",
    source: "detected",
  });
});

test("auto with nothing learnt wears the dark flavour, and says so", () => {
  const choice = resolveTheme({ config: config(), ground: undefined });
  expect(choice.flavour).toBe("mocha");
  // Not "detected": nothing was. A caller explaining itself must not claim a
  // measurement it did not take.
  expect(choice.source).toBe("default");
});

test("what auto resolves to is itself configurable", () => {
  expect(
    resolveTheme({ config: config({ flavourDark: "frappe" }), ground: "dark" })
      .flavour,
  ).toBe("frappe");
  expect(
    resolveTheme({
      config: config({ flavourLight: "macchiato" }),
      ground: "light",
    }).flavour,
  ).toBe("macchiato");
  // And the dark one is what an unlearnt ground falls back to as well.
  expect(
    resolveTheme({
      config: config({ flavourDark: "macchiato" }),
      ground: undefined,
    }).flavour,
  ).toBe("macchiato");
});

test("a flavour that was asked for beats anything the terminal said", () => {
  const choice = resolveTheme({
    config: config({ flavour: "latte" }),
    ground: "dark",
  });
  expect(choice.flavour).toBe("latte");
  expect(choice.source).toBe("config");
});

test("the accent comes through whatever the flavour did", () => {
  for (const flavour of ["auto", "latte"] as const)
    for (const ground of ["light", "dark", undefined] as const)
      expect(
        resolveTheme({ config: config({ flavour, accent: "sky" }), ground })
          .accent,
      ).toBe("sky");
});

test("the probe is refused wherever the answer would be useless", () => {
  const allowed = (over: Partial<Parameters<typeof probeAllowed>[0]>) =>
    probeAllowed({
      level: 3,
      isTTY: true,
      env: { TERM: "xterm-256color" },
      attached: false,
      ...over,
    });
  expect(allowed({})).toBe(true);
  // tmux answers the query itself, so it is not excluded.
  expect(allowed({ env: { TERM: "tmux-256color" } })).toBe(true);

  expect(allowed({ level: 0 }), "no colour to wear").toBe(false);
  expect(allowed({ isTTY: false }), "output is redirected").toBe(false);
  expect(allowed({ attached: true }), "a child holds the terminal").toBe(false);
  expect(allowed({ env: { TERM: "dumb" } }), "dumb").toBe(false);
  expect(allowed({ env: {} }), "no TERM at all").toBe(false);
  // Screen relays the query, so the sentinel comes back before any answer and
  // the probe would read non-support as a reply.
  expect(allowed({ env: { TERM: "screen" } }), "screen").toBe(false);
  expect(
    allowed({ env: { TERM: "screen.xterm-256color" } }),
    "screen variant",
  ).toBe(false);
  expect(
    allowed({ env: { TERM: "xterm-256color", CI: "1" } }),
    "on a runner",
  ).toBe(false);
  // An empty CI is unset, the same convention the colour gate uses.
  expect(allowed({ env: { TERM: "xterm-256color", CI: "" } })).toBe(true);
});

test("a background is light or dark by how light it looks", () => {
  // Every flavour's own ground classifies as the flavour says it is, which is
  // the only case that has to be right for detection to be worth having.
  for (const flavour of Object.values(flavours)) {
    const hex = flavour.colours.base.hex;
    const value = Number.parseInt(hex.slice(1), 16);
    const ground = groundFromRgb(
      (value >> 16) & 255,
      (value >> 8) & 255,
      value & 255,
    );
    expect(ground, `${flavour.name} ${hex}`).toBe(
      flavour.dark ? "dark" : "light",
    );
  }
  expect(groundFromRgb(0, 0, 0)).toBe("dark");
  expect(groundFromRgb(255, 255, 255)).toBe("light");
  // Mid grey is the case a relative-luminance threshold gets wrong: it sits at
  // about 0.216 there and would call this dark.
  expect(groundFromRgb(128, 128, 128)).toBe("light");
});
