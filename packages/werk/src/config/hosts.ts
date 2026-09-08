/**
 * A machine werk could put work on, as configuration.
 *
 * A host is a machine. It is written down as a `[hosts.<name>]` table beside
 * the settings, because a machine somebody wants to reach is a thing they know
 * about their setup rather than a thing werk discovers, and the config file is
 * already the place that kind of knowledge lives. Nothing here talks to a
 * machine, makes one, or picks one: this is the vocabulary and the read path.
 *
 * ```toml
 * defaultHost = "beast"
 *
 * [hosts.beast]
 * kind = "ssh"
 * sshHost = "beast"
 * env = { EDITOR = "werk edit --wait" }
 * setup = "my-boxes"
 *
 * [hosts.agent-sandboxes]
 * kind = "ssh"
 * sshHost = "mike@10.0.0.7"
 * workspaceRoot = "/srv/werk/workspaces"
 * ```
 *
 * **An unknown key inside a host block is refused, and that asymmetry is the
 * point.** Everywhere else werk ignores a key it does not know, because a
 * setting has a default underneath it and a typo costs a preference. A host has
 * no default underneath it: `sshHosts = "beast"` with the s in the wrong place
 * would leave a block that looks configured and means nothing, and the cost of
 * that is a machine.
 *
 * **A bad block must never stop werk starting.** `parseHosts` collects
 * `HostProblem`s rather than throwing, so `werk list` runs with a broken
 * `[hosts.beast]` in the file and only a command that actually wants `beast`
 * fails. `werk config list` shows the row as `unreadable` and `werk config
 * sources` says what is wrong with it and which file it is in.
 *
 * A top-level table werk has no meaning for — a `[providers.incus]` somebody
 * writes before werk reads providers — passes through untouched, because
 * `coerceLayer` reads only the keys it knows and this reads only `hosts`. That
 * is what would let a new table arrive without a flag day, so it is worth
 * keeping true.
 */
import path from "node:path";
import { DAEMON_OWNED } from "../environment.js";
import { ConfigError, type ConfigWhere } from "./errors.js";

interface HostBase {
  /** Where workspaces go on this host. Absent means werk's default for the kind. */
  readonly workspaceRoot?: string;
  /** The name of the provider that made this host, when one did. */
  readonly provider?: string;
  /**
   * The `[setup.<name>]` block that says how this machine is set up. Only the
   * name: whether a block is called that is a question about the whole
   * collection, and the block may come from a layer this one cannot see.
   */
  readonly setup?: string;
  /** Variables every session on this host is started with. */
  readonly env?: Readonly<Record<string, string>>;
}

/** The machine werk is running on. */
export interface LocalHost extends HostBase {
  readonly kind: "local";
}

/**
 * A machine reached with `ssh`.
 *
 * `sshHost` is an ssh destination spelled exactly as it would be typed after
 * `ssh`: an ssh_config `Host` alias, or `[user@]hostname`. werk stores that and
 * nothing else about the connection on purpose. ssh_config already resolves the
 * address, the user, the port, the identity file, `ProxyJump` and
 * `ProxyCommand`, `Match` rules, connection multiplexing, keepalives and the
 * `known_hosts` policy, and a person who reaches a machine at all already has
 * those written down. Re-expressing any of it here would be a second, worse
 * ssh_config that drifts from the real one silently: `ssh beast` would keep
 * working while werk, holding its own stale copy of the port, would not.
 */
export interface SshHost extends HostBase {
  readonly kind: "ssh";
  readonly sshHost: string;
}

export type Host = LocalHost | SshHost;
export type HostKind = Host["kind"];
export const HOST_KINDS = ["local", "ssh"] as const;

/**
 * The article each kind takes. It follows how the word is said rather than how
 * it is spelled — "an ssh host", "a local host" — so it cannot be derived from
 * the first letter, and a kind added later has to say which it wants.
 */
const ARTICLE: Record<HostKind, string> = { local: "a", ssh: "an" };

/**
 * One field of a named block in a config file — a host, or a `[setup.<name>]`
 * beside it — in the shape `FIELDS` uses for a setting, so there is one way to
 * describe a field in this codebase.
 *
 * `T` is what the field is worth once it has been read. Most of them are
 * strings; `env` is a table and `run` is a list, and a field table says which
 * by naming the type rather than by having a second kind of field.
 */
export interface BlockField<T = string> {
  readonly describe: string;
  /** A block has no defaults, so a required field that is absent is refused. */
  readonly required: boolean;
  /** Raw as a file gave it; throws when it is not usable. */
  parse(raw: unknown, key: string): T;
}

function text(what: string) {
  return (raw: unknown, key: string): string => {
    if (typeof raw === "string" && raw !== "") return raw;
    throw new ConfigError("HOST_INVALID", `${key} must be ${what}`);
  };
}

const workspaceRoot: BlockField = {
  describe: "where workspaces go on this host",
  required: false,
  parse: text("a path"),
};
/**
 * The name of whatever made this host, recorded and not interpreted.
 *
 * This is a shape rather than a mechanism: nothing makes hosts and nothing
 * reads this value. Something that makes hosts on demand — Kubernetes, Docker,
 * incus, a cloud machine API — probably needs a noun of its own, and the lean in
 * question 1 of the product specification is *provider*. If that holds, a
 * `[providers.<name>]` table and the hosts it made would need some way to refer
 * to each other, and a name written down on the host is the smallest thing that
 * would do it. None of that is designed. The value is a string werk carries
 * around; a person writing one today is describing their own setup to
 * themselves.
 */
const provider: BlockField = {
  describe: "the provider that made this host, when one did",
  required: false,
  parse: text("a name"),
};
/**
 * Which `[setup.<name>]` block sets this machine up.
 *
 * Only the spelling is checked. Whether anything defines a block by that name
 * is a question about the whole collection, and a parser is handed one value:
 * the block may be in a file this one has never seen, and the layers settle
 * that where they are merged.
 */
const setup: BlockField = {
  describe: "the [setup.<name>] block that sets this machine up",
  required: false,
  parse: (raw, key) => {
    if (typeof raw === "string" && isBlockName(raw)) return raw;
    throw new ConfigError(
      "HOST_INVALID",
      `${key} must name a [setup.<name>] block: ${BLOCK_NAME_RULE}`,
    );
  },
};
const env: BlockField<Readonly<Record<string, string>>> = {
  describe: "variables every session on this host is started with",
  required: false,
  parse: readEnvironment,
};

type FieldsFor<K extends HostKind> = {
  readonly [
    F in Exclude<keyof Extract<Host, { kind: K }>, "kind">
  ]-?: BlockField<NonNullable<Extract<Host, { kind: K }>[F]>>;
};

/** Every key each kind of host takes, apart from `kind`, which selects the table. */
export const HOST_FIELDS: { readonly [K in HostKind]: FieldsFor<K> } = {
  local: { workspaceRoot, provider, setup, env },
  ssh: {
    sshHost: {
      describe: "an ssh destination, spelled as it would be typed after `ssh`",
      required: true,
      parse: text("an ssh destination, such as beast or mike@10.0.0.7"),
    },
    workspaceRoot,
    provider,
    setup,
    env,
  },
};

/** What a variable may be called, in the spelling every shell agrees on. */
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** `validateEnvironment` in `@werk/session-daemon` holds these numbers. */
const ENV_ENTRIES = 1024;
const ENV_KEY_BYTES = 256;
const ENV_VALUE_BYTES = 128 * 1024;
const ENV_TOTAL_BYTES = 1024 * 1024;

/**
 * The variables a host block asks for on top of whatever else a session gets.
 *
 * The daemon's own bounds are repeated here rather than left to it. A map it
 * would refuse arrives there as a session that will not start, which names
 * neither the file nor the key; refusing it while the file is in hand says
 * where to go and fix it.
 *
 * The six names the daemon writes last are refused rather than dropped.
 * `sessionEnvironment` merges them over whatever a client sent, so a `TERM` in
 * a host block would be discarded without a word, and quietly discarding
 * something somebody wrote in a block is what the unknown-key rule exists to
 * prevent.
 */
function readEnvironment(
  raw: unknown,
  key: string,
): Readonly<Record<string, string>> {
  const wrong = (detail: string) =>
    new ConfigError("HOST_INVALID", `${key} ${detail}`);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw wrong(
      'is a table of variables, such as { EDITOR = "werk edit --wait" }',
    );
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > ENV_ENTRIES)
    throw wrong(`takes at most ${ENV_ENTRIES} variables`);
  const values: Record<string, string> = {};
  let total = 0;
  for (const [name, value] of entries) {
    if (!ENV_KEY.test(name))
      throw wrong(
        `cannot set ${JSON.stringify(name)}: a variable name is letters, ` +
          `digits and underscores, and does not start with a digit`,
      );
    if ((DAEMON_OWNED as readonly string[]).includes(name))
      throw wrong(
        `cannot set ${name}: the daemon writes it for every session after ` +
          `everything a client sends, so this would be thrown away`,
      );
    if (typeof value !== "string") throw wrong(`must give ${name} a string`);
    if (value.includes("\0"))
      throw wrong(`cannot give ${name} a value with a NUL in it`);
    const nameBytes = Buffer.byteLength(name);
    const valueBytes = Buffer.byteLength(value);
    if (nameBytes > ENV_KEY_BYTES)
      throw wrong(`cannot set a name longer than ${ENV_KEY_BYTES} bytes`);
    if (valueBytes > ENV_VALUE_BYTES)
      throw wrong(`gives ${name} more than ${ENV_VALUE_BYTES} bytes`);
    // The `=` and the terminating NUL each name costs in `envp`, counted the
    // way the daemon counts them.
    total += nameBytes + valueBytes + 2;
    if (total > ENV_TOTAL_BYTES)
      throw wrong(`comes to more than ${ENV_TOTAL_BYTES} bytes in total`);
    values[name] = value;
  }
  return values;
}

/**
 * What a named block in a config file may be called: a host, and the
 * `[setup.<name>]` blocks beside them. One rule, because a name that is fine
 * in one table and refused in the next is a rule nobody can remember.
 *
 * Bare TOML keys, so `[hosts.beast]` never needs quoting in a file somebody
 * types by hand. No `@` and no `:`, so a name stays usable in the
 * `name[@host][:directory]` workspace-reference grammar in
 * `@werk/workspace`'s `reference.ts`, which reads the first `@` as the start of
 * the host and the first `:` as the start of the path.
 */
const BLOCK_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const BLOCK_NAME_LIMIT = 64;
export const isBlockName = (name: string): boolean =>
  name.length <= BLOCK_NAME_LIMIT && BLOCK_NAME.test(name);
/** The rule as a sentence, so every refusal says the same thing. */
export const BLOCK_NAME_RULE =
  `letters, digits, dots, dashes and underscores, starting with a letter ` +
  `or a digit, up to ${BLOCK_NAME_LIMIT} characters`;

/** A host block that could not be read, and enough to go and look at it. */
export interface HostProblem {
  /** The name in the table header. */
  readonly name: string;
  /** The file it was read from, when it came from one. */
  readonly file?: string;
  /** The whole failure, location included, ready to print. */
  readonly message: string;
}

/**
 * One `[hosts.<name>]` block, typed, or a `ConfigError` naming what is wrong.
 *
 * Field parsers know what is wrong with a value and nothing about which file
 * carried it, so the location is attached here, once, to whatever comes out.
 */
export function parseHost(name: string, raw: unknown, file?: string): Host {
  const where: ConfigWhere =
    file === undefined
      ? { table: `hosts.${name}` }
      : { table: `hosts.${name}`, file };
  try {
    return readHost(name, raw);
  } catch (error) {
    if (error instanceof ConfigError && error.where === undefined)
      throw error.at(where);
    throw error;
  }
}

function readHost(name: string, raw: unknown): Host {
  if (!isBlockName(name))
    throw new ConfigError(
      "HOST_NAME_INVALID",
      `${JSON.stringify(name)} is not a host name: ${BLOCK_NAME_RULE}`,
    );
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new ConfigError("HOST_INVALID", "a host is a table of keys");
  const given = raw as Record<string, unknown>;
  const kind = given.kind;
  if (
    typeof kind !== "string" ||
    !(HOST_KINDS as readonly string[]).includes(kind)
  )
    throw new ConfigError(
      "HOST_INVALID",
      `kind must be one of ${HOST_KINDS.join(", ")}`,
    );
  const fields: Readonly<Record<string, BlockField<unknown>>> =
    HOST_FIELDS[kind as HostKind];
  const takes = ["kind", ...Object.keys(fields)].join(", ");
  const a = ARTICLE[kind as HostKind];
  for (const key of Object.keys(given))
    if (key !== "kind" && fields[key] === undefined)
      throw new ConfigError(
        "HOST_INVALID",
        `unknown key ${key}; ${a} ${kind} host takes ${takes}`,
      );
  const host: Record<string, unknown> = { kind };
  for (const [key, field] of Object.entries(fields)) {
    const value = given[key];
    if (value === undefined || value === null) {
      if (field.required)
        throw new ConfigError(
          "HOST_INVALID",
          `${key} is required for ${a} ${kind} host`,
        );
      continue;
    }
    host[key] = field.parse(value, key);
  }
  // Every key the kind takes has been read and everything else has been
  // refused, but TypeScript cannot see that a record built from
  // `HOST_FIELDS[kind]` is the member of the union `kind` selects, so the
  // narrowing is asserted here, once, in the same shape `take` uses in
  // `schema.ts`.
  return host as unknown as Host;
}

/**
 * Every host in one layer, and every block that could not be read.
 *
 * Takes the whole raw layer the way `coerceLayer` does, so the two of them are
 * the same shape of thing: the settings out of a file, and the hosts out of the
 * same file.
 */
export function parseHosts(
  raw: Record<string, unknown> | null | undefined,
  file?: string,
): { hosts: Record<string, Host>; problems: HostProblem[] } {
  const hosts: Record<string, Host> = {};
  const problems: HostProblem[] = [];
  const table = raw?.hosts;
  if (table === undefined || table === null) return { hosts, problems };
  const note = (name: string, error: unknown) =>
    problems.push({
      name,
      ...(file === undefined ? {} : { file }),
      message: error instanceof Error ? error.message : String(error),
    });
  if (typeof table !== "object" || Array.isArray(table)) {
    note(
      "hosts",
      new ConfigError(
        "HOST_INVALID",
        "hosts is a table of host blocks, such as [hosts.beast]",
        file === undefined ? { table: "hosts" } : { table: "hosts", file },
      ),
    );
    return { hosts, problems };
  }
  for (const [name, block] of Object.entries(table as Record<string, unknown>))
    try {
      hosts[name] = parseHost(name, block, file);
    } catch (error) {
      note(name, error);
    }
  return { hosts, problems };
}

/** One line for a table: what kind of machine it is, and how it is reached. */
export const summariseHost = (host: Host): string =>
  host.kind === "ssh" ? `ssh ${host.sshHost}` : "local";

/**
 * The hosts werk has without being told anything.
 *
 * `local` is an ordinary row with an ordinary provenance, supplied by the
 * `defaults` layer like every built-in value, so nothing anywhere has to
 * special-case the machine werk is running on. A file that writes its own
 * `[hosts.local]` replaces it the way a file replaces any other default.
 */
export const builtInHosts = (): Record<string, Host> => ({
  local: { kind: "local" },
});

/**
 * The host a command acts on when nobody names one. Named here rather than
 * spelled again in `schema.ts`, so the built-in default and the host it points
 * at cannot drift apart.
 */
export const DEFAULT_HOST = "local";

/**
 * Where workspaces go on a host.
 *
 * A local host with nothing said about it resolves to `<stateDir>/workspaces`,
 * which is where `werk create` already puts them: this describes what happens
 * today rather than introducing a place to put them. `--state-dir` and a
 * `stateDir` in a config file still move them, as they always did.
 *
 * An ssh host with nothing said about it has no answer from here. werk cannot
 * know a path on a machine it has not looked at — there is no home directory to
 * join to until something asks the machine — so this returns undefined and
 * whoever can reach the host settles it there.
 *
 * The name is taken because a caller that has to explain the answer has it to
 * hand, and because a layout with a per-host directory in it would want the
 * name rather than the block.
 */
export function workspaceRootFor(
  name: string,
  host: Host,
  stateDir: string,
): string | undefined {
  if (host.workspaceRoot !== undefined) return host.workspaceRoot;
  return host.kind === "local" ? path.join(stateDir, "workspaces") : undefined;
}

/**
 * What resolving a host needs to know: every block in force, every block that
 * could not be read, and the two ways a name arrives.
 *
 * Structural rather than the CLI's context type, so nothing under `src/config/`
 * imports a value from `src/runtime/`. A `WerkContext` satisfies it.
 */
export interface HostSelection {
  readonly hosts: Readonly<Record<string, Host>>;
  readonly hostProblems: readonly HostProblem[];
  /** The host to act on when nothing names one; the `defaultHost` setting. */
  readonly defaultHost: string;
  /** The host named with `--host`, when one was. */
  readonly requestedHost?: string;
}

/**
 * The host a command acts on: the flag, then `defaultHost`.
 *
 * This is a question about the whole collection rather than about one key,
 * which is why it is not a field parser. A parser sees one value and can say
 * that `beest` is shaped like a host name; only something holding every block
 * can say that no host is called `beest` and that `beast` is. A typo is the
 * commonest cause of this failing, so the message names what is defined rather
 * than only what is not.
 *
 * A block that could not be read is a different failure from a name nothing
 * defines, and separating them is worth the code: the remedy for one is to type
 * a different name, and for the other to go and fix a file. `parseHosts`
 * already worked out what is wrong with the block and which file it is in, so
 * that sentence is carried through rather than restated.
 */
export function hostFor(
  from: HostSelection,
  requested: string | undefined = from.requestedHost,
): { name: string; host: Host } {
  const name = requested ?? from.defaultHost;
  const host = from.hosts[name];
  if (host !== undefined) return { name, host };
  const problem = from.hostProblems.find((entry) => entry.name === name);
  if (problem !== undefined)
    throw new ConfigError(
      "HOST_INVALID",
      `${name} is configured but werk cannot read it: ${problem.message}`,
    );
  const defined = Object.keys(from.hosts).sort();
  throw new ConfigError(
    "UNKNOWN_HOST",
    `no host is called ${name}. ` +
      (defined.length === 0
        ? "Nothing defines one; `werk config setup` writes a host block."
        : `Defined: ${defined.join(", ")}.`),
  );
}
