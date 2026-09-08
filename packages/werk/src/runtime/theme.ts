/**
 * Which flavour and accent werk wears, decided from everything it knows.
 *
 * This module is the decision and `background.ts` is the one piece of evidence it
 * cannot work out for itself. That split is the same one `colour.ts` makes, and
 * for the same reason: every input arrives as an argument, so the whole matrix
 * can be asserted without a terminal, and the only thing that needs a real one
 * is a probe small enough to read in a sitting.
 *
 * ## What decides
 *
 * A flavour comes from the command line, the environment, a config file, or the
 * terminal's own ground, in that order. The first three are the config layers
 * doing their usual job, so by the time this module runs they have already been
 * merged into one answer and `source` reports which layer won. The fourth only
 * comes into it when that answer is `auto`.
 *
 * `auto` resolves through `flavourLight` and `flavourDark` rather than to a
 * fixed Latte-and-Mocha pair, so choosing Frappé for a dark terminal is a
 * setting rather than a reason to give up on detection.
 *
 * When the ground cannot be learnt, werk wears the dark flavour. `delta`,
 * `helix`, Neovim, `termenv` and `terminal-colorsaurus` all fall back the same
 * way, so it is at least the usual answer, and a dark theme on a light ground
 * is probably the less common mistake to be making.
 *
 * ## What stops the probe running
 *
 * `probeAllowed` is separate from `resolveTheme` because it answers a different
 * question — not "which flavour" but "may werk write to this terminal and wait
 * for an answer". A probe is a write and a blocking read, so it is refused
 * wherever the answer would be useless or the wait unbounded.
 */
import type { AccentName, FlavourName } from "@werk/palette";
import type { ColourLevel } from "./colour.js";
import type { WerkConfig } from "../config/schema.js";

/** What a terminal's own background says it is. */
export type Ground = "light" | "dark";

/** The layer a flavour came from, for anything that has to explain itself. */
export type ThemeSource = "config" | "detected" | "default";

export interface ThemeChoice {
  readonly flavour: FlavourName;
  readonly accent: AccentName;
  readonly source: ThemeSource;
}

/** Only the keys a theme is made of, so a caller need not carry the rest. */
export type ThemeConfig = Pick<
  WerkConfig,
  "flavour" | "flavourDark" | "flavourLight" | "accent"
>;

export interface ThemeInputs {
  readonly config: ThemeConfig;
  /** What the probe learnt, or nothing: it did not run, or it learnt nothing. */
  readonly ground: Ground | undefined;
}

export function resolveTheme({ config, ground }: ThemeInputs): ThemeChoice {
  const accent = config.accent;
  if (config.flavour !== "auto")
    return { flavour: config.flavour, accent, source: "config" };
  if (ground === "light")
    return { flavour: config.flavourLight, accent, source: "detected" };
  if (ground === "dark")
    return { flavour: config.flavourDark, accent, source: "detected" };
  // Nothing was learnt. Dark is what the tools that ask this question fall back
  // to, and it is what werk looked like before it started asking.
  return { flavour: config.flavourDark, accent, source: "default" };
}

export interface ProbeInputs {
  /** The level the colour gate settled on. */
  readonly level: ColourLevel;
  /** Whether the stream werk writes its own output to is a terminal. */
  readonly isTTY: boolean;
  readonly env: Record<string, string | undefined>;
  /** True once werk has handed the terminal to a child process. */
  readonly attached: boolean;
}

/** True when the variable is present and not one of the falsey spellings. */
function truthy(value: string | undefined): boolean {
  return (
    value !== undefined && value !== "" && value !== "0" && value !== "false"
  );
}

export function probeAllowed({
  level,
  isTTY,
  env,
  attached,
}: ProbeInputs): boolean {
  // Nothing is being coloured, so nothing turns on the answer.
  if (level === 0) return false;
  // Output is redirected. A theme nobody can see is not worth a round trip, and
  // it is also the case where a pager may own the terminal werk would query.
  if (!isTTY) return false;
  // The terminal is already someone else's: a child holds it in raw mode and a
  // reply of werk's would land in the child's input.
  if (attached) return false;
  const term = env.TERM ?? "";
  if (term === "" || term === "dumb") return false;
  // GNU Screen relays the query to its own terminal, so the reply to the DA1
  // sentinel comes back first and the probe would read non-support as an
  // answer. tmux is fine: since 3.2 it answers the query itself.
  if (term === "screen" || term.startsWith("screen.")) return false;
  // A runner reports a terminal often enough that the read would just be a
  // round trip nobody sees.
  if (truthy(env.CI)) return false;
  return true;
}

/**
 * Whether a background is light or dark, by CIE L*.
 *
 * The four libraries that answer this question answer it four different ways:
 * HSL lightness, BT.601 luma, a relative-luminance threshold, and this. L* is
 * the one that models how a person sees lightness, and 50 is its midpoint by
 * construction, which is what makes the threshold a definition rather than a
 * tuned number.
 *
 * ghostty answers it a fifth way, and werk now carries that answer without
 * using it: `ghostty_color_perceived_luminance` calls a background light above
 * 0.5. The two rules disagree on 13.4% of the sRGB cube, sampled every third
 * value on each channel, and the disagreements are saturated mid colours such
 * as rgb(0, 111, 255), which is L* 50.2 and perceived luminance 0.370. On the
 * four Catppuccin bases they agree with room to spare: Mocha is L* 12.0 and
 * 0.125, Latte is 95.1 and 0.945. Which rule werk should use is open. Nobody
 * has picked one over the other on evidence, and the terminals people actually
 * theme are not where the two disagree.
 */
export function groundFromRgb(r: number, g: number, b: number): Ground {
  const linear = (channel: number): number => {
    const v = channel / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  // The Y row of sRGB's matrix to CIE XYZ, with D65 white already 1.
  const y = 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  const lightness =
    y > 216 / 24389 ? 116 * Math.cbrt(y) - 16 : (y * 24389) / 27;
  return lightness > 50 ? "light" : "dark";
}
