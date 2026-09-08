/**
 * Whether this process may write colour, and at what depth.
 *
 * The decision is made here rather than by a colour library, because every
 * library's built-in detection is wrong for at least one case werk cares about:
 * picocolors forces colour on when `CI` is set or the platform is Windows, and
 * yoctocolors consults `tty.WriteStream.prototype.hasColors()` — the prototype,
 * with no stream — so it never learns whether *this* stdout is a terminal.
 *
 * `NO_COLOR` beats `FORCE_COLOR` here. Bun and chalk resolve that pair the other
 * way; the NO_COLOR convention says the variable's presence disables colour, and
 * werk's output is redirected into logs often enough that honouring it matters
 * more than agreeing with `console.log`.
 *
 * The configured `colour` preference sits below both of those and above
 * `FORCE_COLOR`. It is a standing choice rather than a statement about the
 * device, so `WERK_COLOUR=always` cannot talk over a reader who has set
 * `NO_COLOR` or a terminal that says it is dumb. Only `--color`, typed on the
 * line being run, lifts either.
 *
 * The gate is pure so the whole matrix can be asserted without a terminal.
 */
export type ColourLevel = 0 | 1 | 2 | 3;
export interface ColourInputs {
  /** Whether the stream being written to is a terminal. */
  isTTY: boolean;
  env: Record<string, string | undefined>;
  /** The merged `colour` setting, where the layers have been read. */
  preference?: "auto" | "always" | "never";
}
/** True when the variable is present and not one of the falsey spellings. */
function truthy(value: string | undefined): boolean {
  return (
    value !== undefined && value !== "" && value !== "0" && value !== "false"
  );
}
/**
 * How deep the colour goes once it is allowed at all. `COLORTERM` is the only
 * portable signal for truecolour; the 256-colour terminals announce themselves
 * in `TERM`.
 */
function depth(env: Record<string, string | undefined>): ColourLevel {
  const colorterm = env.COLORTERM ?? "";
  if (colorterm === "truecolor" || colorterm === "24bit") return 3;
  const term = env.TERM ?? "";
  if (/-256(color)?$/.test(term)) return 2;
  return 1;
}
export function colourLevel({
  isTTY,
  env,
  preference,
}: ColourInputs): ColourLevel {
  // Present at any value, including "0": the convention is presence, not truth.
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return 0;
  // A terminal that says it cannot render escapes is taken at its word, even
  // under FORCE_COLOR — `TERM=dumb` is a statement about the device.
  if (env.TERM === "dumb") return 0;
  if (preference === "never") return 0;
  if (preference === "always") return Math.max(1, depth(env)) as ColourLevel;
  if (env.FORCE_COLOR !== undefined)
    return truthy(env.FORCE_COLOR) ? depth(env) : 0;
  return isTTY ? depth(env) : 0;
}

/**
 * The level including an explicit `--color` / `--no-color` on the command line.
 *
 * Help is rendered by commander during parsing, before any action runs, so the
 * decision has to be available before the flags have been parsed properly. A
 * scan of the raw argv is what every CLI does here. Only the tokens before `--`
 * are considered: after it, `--no-color` belongs to the child process.
 */
export function colourLevelFromArgv(
  argv: readonly string[],
  inputs: ColourInputs,
): ColourLevel {
  const end = argv.indexOf("--");
  const own = end === -1 ? argv : argv.slice(0, end);
  if (own.includes("--no-color")) return 0;
  if (own.includes("--color"))
    return Math.max(1, depth(inputs.env)) as ColourLevel;
  return colourLevel(inputs);
}
