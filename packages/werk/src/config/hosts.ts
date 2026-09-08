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
import { ConfigError, type ConfigWhere } from "./errors.js";

interface HostBase {
  /** Where workspaces go on this host. Absent means werk's default for the kind. */
  readonly workspaceRoot?: string;
  /** The name of the provider that made this host, when one did. */
  readonly provider?: string;
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
 * One field of a host block, in the shape `FIELDS` uses for a setting, so there
 * is one way to describe a field in this codebase. There is no `env` here: the
 * environment rule is one variable per scalar key, and a collection of tables
 * has no spelling in it.
 */
export interface HostField {
  readonly describe: string;
  /** A host has no defaults, so a required field that is absent is refused. */
  readonly required: boolean;
  /** Raw as a file gave it; throws when it is not usable. */
  parse(raw: unknown, key: string): string;
}

function text(what: string) {
  return (raw: unknown, key: string): string => {
    if (typeof raw === "string" && raw !== "") return raw;
    throw new ConfigError("HOST_INVALID", `${key} must be ${what}`);
  };
}

const workspaceRoot: HostField = {
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
const provider: HostField = {
  describe: "the provider that made this host, when one did",
  required: false,
  parse: text("a name"),
};

type FieldsFor<K extends HostKind> = Readonly<
  Record<Exclude<keyof Extract<Host, { kind: K }>, "kind">, HostField>
>;

/** Every key each kind of host takes, apart from `kind`, which selects the table. */
export const HOST_FIELDS: { readonly [K in HostKind]: FieldsFor<K> } = {
  local: { workspaceRoot, provider },
  ssh: {
    sshHost: {
      describe: "an ssh destination, spelled as it would be typed after `ssh`",
      required: true,
      parse: text("an ssh destination, such as beast or mike@10.0.0.7"),
    },
    workspaceRoot,
    provider,
  },
};

/**
 * What a host may be called.
 *
 * Bare TOML keys, so `[hosts.beast]` never needs quoting in a file somebody
 * types by hand. No `@` and no `:`, so a name stays usable in the
 * `name[@host][:directory]` workspace-reference grammar in
 * `@werk/workspace`'s `reference.ts`, which reads the first `@` as the start of
 * the host and the first `:` as the start of the path.
 */
const HOST_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const HOST_NAME_LIMIT = 64;
export const isHostName = (name: string): boolean =>
  name.length <= HOST_NAME_LIMIT && HOST_NAME.test(name);

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
  if (!isHostName(name))
    throw new ConfigError(
      "HOST_NAME_INVALID",
      `${JSON.stringify(name)} is not a host name: letters, digits, dots, ` +
        `dashes and underscores, starting with a letter or a digit, up to ` +
        `${HOST_NAME_LIMIT} characters`,
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
  const fields: Readonly<Record<string, HostField>> =
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
