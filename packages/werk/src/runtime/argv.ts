/**
 * Everything done to argv before commander sees it.
 *
 * Both transformations here are statements about werk rather than workarounds.
 * What follows a bare `--` is another program's command line and werk does not
 * parse it at all. And the flags below are werk's own wherever they appear,
 * because that is how they have always behaved.
 *
 * Pure functions in their own module, so the entry point can stay a side effect
 * and these can still be tested.
 *
 * ---
 *
 * The flags every command accepts, wherever they are typed.
 *
 * Commander binds an option to the command it was declared on, so `--runtime-dir`
 * declared at the root is a parse error after a subcommand name. werk has always
 * accepted these anywhere — `docs/session-library.md` says so, `check-artefacts`
 * appends them after the command, and the daemon launcher spawns
 * `werk daemon serve --runtime-dir …` — so they are lifted to the front of the
 * argv before commander sees it.
 *
 * This table is the single source of truth: `app.ts` declares the options from it
 * and `main.ts` hoists using it, so the two cannot disagree about which flags are
 * global or which take a value.
 */
export interface GlobalFlagSpec {
  flags: string;
  description: string;
  /** Consumes the following argv token. */
  takesValue: boolean;
}
export const GLOBAL_FLAGS: readonly GlobalFlagSpec[] = [
  {
    flags: "--json",
    description: "print JSON instead of text",
    takesValue: false,
  },
  {
    flags: "--runtime-dir <PATH>",
    description: "where the daemon socket and endpoint live",
    takesValue: true,
  },
  {
    flags: "--state-dir <PATH>",
    description: "where checkpoints, logs and the daemon record live",
    takesValue: true,
  },
  {
    flags: "--log-level <LEVEL>",
    description: "daemon log level (error, warn, info, debug)",
    takesValue: true,
  },
  {
    flags: "--no-input",
    description: "fail instead of prompting",
    takesValue: false,
  },
  {
    flags: "-y, --yes",
    description: "answer yes to every confirmation",
    takesValue: false,
  },
  {
    flags: "--flavour <NAME>",
    description: "Catppuccin flavour (auto, latte, frappe, macchiato, mocha)",
    takesValue: true,
  },
  {
    flags: "--accent <NAME>",
    description: "which Catppuccin accent marks the active thing",
    takesValue: true,
  },
  { flags: "--color", description: "always use colour", takesValue: false },
  {
    flags: "--no-color",
    description: "never use colour",
    takesValue: false,
  },
];
/** Every long spelling, mapped to whether it swallows the next token. */
const TAKES_VALUE = new Map<string, boolean>(
  GLOBAL_FLAGS.flatMap((spec) =>
    spec.flags
      .split(",")
      .map((part) => part.trim().split(" ")[0]!)
      .filter((name) => name.startsWith("-"))
      .map((name) => [name, spec.takesValue] as const),
  ),
);
export interface Hoisted {
  globals: string[];
  rest: string[];
}
/**
 * Move the global flags to the front, preserving the order of everything else.
 * `--flag=value` is left intact; only the separated form consumes a token.
 */
export function hoistGlobalFlags(argv: readonly string[]): Hoisted {
  const globals: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    const name =
      token.startsWith("--") && token.includes("=")
        ? token.slice(0, token.indexOf("="))
        : token;
    const takesValue = TAKES_VALUE.get(name);
    if (takesValue === undefined) {
      rest.push(token);
      continue;
    }
    globals.push(token);
    if (takesValue && name === token && i + 1 < argv.length)
      globals.push(argv[++i]!);
  }
  return { globals, rest };
}

export interface ArgvSplit {
  own: string[];
  child: string[];
}
/**
 * Split at the first bare `--`. Commander discards that position — it flattens
 * everything after it into the same operand list as the command's own
 * positionals — so `werk attach abc -- sh` could not tell `abc` from `sh`.
 * Splitting first also means a child's flag can never collide with one of werk's.
 */
export function splitChildArgv(argv: readonly string[]): ArgvSplit {
  const at = argv.indexOf("--");
  return at === -1
    ? { own: [...argv], child: [] }
    : { own: argv.slice(0, at), child: argv.slice(at + 1) };
}

/**
 * The global flags as values, read from the raw argv.
 *
 * Commander is the thing that normally parses these, but the flavour and the
 * colour level have to be settled before it runs, because a help page is
 * rendered during the parse and has to already know what it looks like. So the
 * same table that hoists them is read once more, here, to answer that.
 *
 * Only long spellings that take a value are read: nothing before the parse cares
 * about `-y`, and a bare flag reaches the layers through commander as usual.
 * Both `--flag value` and `--flag=value` are accepted, and the last one wins,
 * which is what commander does.
 */
export function globalFlagValues(
  argv: readonly string[],
): Record<string, string> {
  const values: Record<string, string> = {};
  const camel = (name: string): string =>
    name
      .slice(2)
      .replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith("--")) continue;
    const split = token.indexOf("=");
    const name = split === -1 ? token : token.slice(0, split);
    if (TAKES_VALUE.get(name) !== true) continue;
    if (split !== -1) values[camel(name)] = token.slice(split + 1);
    else if (i + 1 < argv.length) values[camel(name)] = argv[++i]!;
  }
  return values;
}
