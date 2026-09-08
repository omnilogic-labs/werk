/**
 * Setting a machine up, and setting a workspace up, as configuration.
 *
 * A `[setup.<name>]` block says what to put on a machine and what to run
 * there. A host block points at one with `setup = "<name>"`, and the top-level
 * `workspaceSetup` points at one for a workspace that has just been made. The
 * two are the same vocabulary because they are the same shape of job: copy
 * something over, then run some commands where it landed.
 *
 * ```toml
 * [setup.my-boxes]
 * copy = "~/dotfiles/werk-host"
 * to = ".local/share/werk/setup"
 * run = [
 *   "claude plugin marketplace add claude-plugins-official",
 *   "~/.local/share/werk/setup/install.sh",
 * ]
 * rerunOnChange = true
 * ```
 *
 * **Nothing here runs anything.** This is the vocabulary and the read path: a
 * block is parsed, carried through the layers, printed by `werk config list`,
 * and looked up by name in {@link setupFor}. `host/setup.ts` is what runs one.
 *
 * **An unknown key inside a block is refused**, on the same terms as a host
 * block. A setting has a default underneath it, so ignoring a key werk does not
 * know costs a preference. A block has nothing underneath it, so `runs = [...]`
 * with the s in the wrong place would leave a block that looks configured and
 * does nothing at all, on a machine somebody thinks is set up.
 *
 * **A bad block must never stop werk starting.** `parseSetups` collects
 * `SetupProblem`s rather than throwing, exactly as `parseHosts` does, so a
 * broken `[setup.bootstrap]` in a file leaves `werk list` working and shows up
 * in `werk config list` as a row werk could not read.
 *
 * Parsing touches no disk. A `copy` that is not there is a failure for whatever
 * copies it, at the moment it tries, on the machine that has an answer; a
 * parser that stat'd the path would report on the wrong machine at the wrong
 * time and make reading a config file depend on the filesystem under it.
 */
import path from "node:path";
import os from "node:os";
import { ConfigError, type ConfigWhere } from "./errors.js";
import { BLOCK_NAME_RULE, isBlockName, type BlockField } from "./hosts.js";

export interface SetupBlock {
  /**
   * What to send: a directory on the machine werk is running on, whose contents
   * land under `to`. A leading `~/` is expanded here, because a config file is
   * written by hand and `~` in one is the shell's convention rather than a path
   * anything can open.
   */
  readonly copy?: string;
  /**
   * Where it lands, relative to whatever the run is relative to: `$HOME` on the
   * machine for a host's block, and the workspace for a `workspaceSetup`.
   */
  readonly to?: string;
  /** The commands to run there, in the order they are written. */
  readonly run: readonly string[];
  /** Whether the block is worth running again once what it copies has changed. */
  readonly rerunOnChange?: boolean;
}

const invalid = (detail: string) => new ConfigError("SETUP_INVALID", detail);

/** A path on this machine, with the shell's `~/` spelled out. */
function fromHere(raw: unknown, key: string): string {
  if (typeof raw !== "string" || raw === "")
    throw invalid(`${key} must be a path on this machine`);
  return raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(2)) : raw;
}

/**
 * Where something lands, relative to a directory werk does not know yet: the
 * home directory on the machine, or the workspace. An absolute path or a `..` in
 * it would name a place outside that directory, which is a different promise
 * from the one this key makes, so both are refused rather than resolved.
 */
function relative(raw: unknown, key: string): string {
  if (typeof raw !== "string" || raw === "")
    throw invalid(`${key} must be a path`);
  if (raw.startsWith("/"))
    throw invalid(`${key} must be relative to the directory it lands under`);
  const segments = raw.split("/");
  if (segments.includes(".."))
    throw invalid(`${key} must not go up out of that directory with ..`);
  if (segments.some((segment) => segment === ""))
    throw invalid(`${key} must not have an empty segment in it`);
  return raw;
}

function commands(raw: unknown, key: string): readonly string[] {
  if (!Array.isArray(raw) || raw.length === 0)
    throw invalid(`${key} must be a list of commands, and not an empty one`);
  for (const one of raw)
    if (typeof one !== "string" || one === "")
      throw invalid(`${key} must be a list of commands, each of them a string`);
  return raw as readonly string[];
}

function flag(raw: unknown, key: string): boolean {
  if (typeof raw !== "boolean") throw invalid(`${key} must be true or false`);
  return raw;
}

/** Every key a `[setup.<name>]` block takes. */
export const SETUP_FIELDS: {
  readonly [F in keyof Required<SetupBlock>]-?: BlockField<
    NonNullable<SetupBlock[F]>
  >;
} = {
  copy: {
    describe: "the directory to send, on the machine werk is running on",
    required: false,
    parse: fromHere,
  },
  to: {
    describe: "where it lands, relative to $HOME there or to the workspace",
    required: false,
    parse: relative,
  },
  run: {
    describe: "the commands to run there, in order",
    required: true,
    parse: commands,
  },
  rerunOnChange: {
    describe: "whether to run it again once what it copies has changed",
    required: false,
    parse: flag,
  },
};

/** A `[setup.<name>]` block that could not be read, and enough to go and look at it. */
export interface SetupProblem {
  /** The name in the table header. */
  readonly name: string;
  /** The file it was read from, when it came from one. */
  readonly file?: string;
  /** The whole failure, location included, ready to print. */
  readonly message: string;
}

/**
 * One `[setup.<name>]` block, typed, or a `ConfigError` naming what is wrong.
 *
 * Field parsers know what is wrong with a value and nothing about which file
 * carried it, so the location is attached here, once, to whatever comes out.
 */
export function parseSetup(
  name: string,
  raw: unknown,
  file?: string,
): SetupBlock {
  const where: ConfigWhere =
    file === undefined
      ? { table: `setup.${name}` }
      : { table: `setup.${name}`, file };
  try {
    return readSetup(name, raw);
  } catch (error) {
    if (error instanceof ConfigError && error.where === undefined)
      throw error.at(where);
    throw error;
  }
}

function readSetup(name: string, raw: unknown): SetupBlock {
  if (!isBlockName(name))
    throw invalid(
      `${JSON.stringify(name)} is not a setup name: ${BLOCK_NAME_RULE}`,
    );
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw invalid("a setup block is a table of keys");
  const given = raw as Record<string, unknown>;
  const fields: Readonly<Record<string, BlockField<unknown>>> = SETUP_FIELDS;
  const takes = Object.keys(fields).join(", ");
  for (const key of Object.keys(given))
    if (fields[key] === undefined)
      throw invalid(`unknown key ${key}; a setup block takes ${takes}`);
  const block: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(fields)) {
    const value = given[key];
    if (value === undefined || value === null) {
      if (field.required) throw invalid(`${key} is required for a setup block`);
      continue;
    }
    block[key] = field.parse(value, key);
  }
  // The pair says one thing: send this, and put it there. Half of it is either
  // a path werk has nowhere to put or a place with nothing to go in it, and
  // guessing the other half would be werk deciding where somebody's files land.
  if ((block.copy === undefined) !== (block.to === undefined))
    throw invalid("copy and to go together; a block with one needs the other");
  // Every key has been read and everything else refused, but TypeScript cannot
  // see that a record built from `SETUP_FIELDS` is a `SetupBlock`, so the
  // narrowing is asserted here, once, as it is in `hosts.ts`.
  return block as unknown as SetupBlock;
}

/**
 * Every setup block in one layer, and every block that could not be read.
 *
 * Takes the whole raw layer, the way `coerceLayer` and `parseHosts` do, so the
 * three of them are the same shape of thing: the settings out of a file, the
 * hosts out of it, and the setup blocks out of it.
 */
export function parseSetups(
  raw: Record<string, unknown> | null | undefined,
  file?: string,
): { setups: Record<string, SetupBlock>; problems: SetupProblem[] } {
  const setups: Record<string, SetupBlock> = {};
  const problems: SetupProblem[] = [];
  const table = raw?.setup;
  if (table === undefined || table === null) return { setups, problems };
  const note = (name: string, error: unknown) =>
    problems.push({
      name,
      ...(file === undefined ? {} : { file }),
      message: error instanceof Error ? error.message : String(error),
    });
  if (typeof table !== "object" || Array.isArray(table)) {
    note(
      "setup",
      new ConfigError(
        "SETUP_INVALID",
        "setup is a table of setup blocks, such as [setup.bootstrap]",
        file === undefined ? { table: "setup" } : { table: "setup", file },
      ),
    );
    return { setups, problems };
  }
  for (const [name, block] of Object.entries(table as Record<string, unknown>))
    try {
      setups[name] = parseSetup(name, block, file);
    } catch (error) {
      note(name, error);
    }
  return { setups, problems };
}

/** Who named a setup block, so a refusal can say where to go and look. */
export interface SetupNamedBy {
  /** How the name was written: `[hosts.beast]`, or `workspaceSetup`. */
  readonly by: string;
  /** Where that came from: a file, or a layer's description of itself. */
  readonly from?: string;
}

/**
 * The block a name refers to, or a refusal naming what wrote the name down.
 *
 * A `setup = "my-boxes"` in a host block is checked for spelling where it is
 * parsed and no further, because a parser is handed one value and the block may
 * be written in a file that value has never seen. So the collection is asked
 * here, at the moment something is about to run one, which is the first point at
 * which the whole of the configuration is in hand.
 *
 * "Nothing werk can read defines one" covers both a name nobody wrote and a
 * block that failed to parse, deliberately: the remedy for either is to go and
 * look, and `werk config sources` is where the difference is spelled out.
 */
export function setupFor(
  name: string,
  setups: Readonly<Record<string, SetupBlock>>,
  named: SetupNamedBy,
): SetupBlock {
  const block = setups[name];
  if (block !== undefined) return block;
  const defined = Object.keys(setups).sort();
  throw invalid(
    `${named.by}${named.from === undefined ? "" : `, from ${named.from},`} ` +
      `names a setup block called ${name}, and nothing werk can read defines ` +
      `one. ` +
      (defined.length === 0
        ? `Nothing defines any; a [setup.${name}] table would.`
        : `Defined: ${defined.join(", ")}.`) +
      " `werk config sources` says which blocks were read and what is wrong " +
      "with any that were not.",
  );
}

/** One line for a table: what it sends, and how much it runs. */
export function summariseSetup(block: SetupBlock): string {
  const runs = `${block.run.length} ${block.run.length === 1 ? "command" : "commands"}`;
  return block.copy === undefined ? runs : `copy ${block.copy}; ${runs}`;
}
