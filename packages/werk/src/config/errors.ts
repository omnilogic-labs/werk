/**
 * What can be wrong with configuration, said in the config layer's own words.
 *
 * Every other error vocabulary werk has — `SessionError`, `WorkspaceError` —
 * belongs to the layer that raises it, and `runtime/exit.ts` maps each of them
 * to a status. Configuration used to be the exception: `schema.ts` threw the
 * CLI's `UsageError`, which was the one edge pointing from the config layer
 * into the CLI runtime. It points the other way now: `runtime/exit.ts` imports
 * `ConfigError` from here, and nothing under `src/config/` imports a value from
 * `src/runtime/` or `src/commands/`. One type-only import is left — `load.ts`
 * names `GlobalFlags` to type the flags layer — and a type is erased at build
 * time. Whether the shape of the flags belongs to the runtime or to the config
 * layer is not worked out.
 *
 * That is what would make this directory liftable into a package of its own.
 * Nothing needs it lifted today. The trigger would probably be a second process
 * that has to resolve configuration for itself — a daemon reading its own log
 * level, say — because two copies of the layer rules is the thing worth paying a
 * package to avoid. Until something like that turns up this is one directory in
 * one package that happens to have no edges out.
 */

/**
 * `CONFIG_WRITE_FAILED` is the one nothing raises yet: writing a config file is
 * being built beside this, and one spelling of the code now is cheaper than two
 * spellings of it later.
 */
export type ConfigErrorCode =
  /** A `[hosts.<name>]` block werk cannot read. */
  | "HOST_INVALID"
  /** The table name is not one a host can be called. */
  | "HOST_NAME_INVALID"
  /** A host was named that nothing defines. */
  | "UNKNOWN_HOST"
  /**
   * A config file werk cannot read: not the TOML it claims to be, or a setting
   * whose value is not one werk accepts.
   */
  | "CONFIG_UNREADABLE"
  /** A config file werk could not write. */
  | "CONFIG_WRITE_FAILED";

/**
 * Where the trouble is, in terms a person can open: the file, and the table
 * header inside it. Either may be missing — a value out of the environment has
 * no file, and a setting has no table.
 */
export interface ConfigWhere {
  /** Absolute path to the file the trouble was read from. */
  readonly file?: string;
  /** The TOML table, spelled as its header: `hosts.beast`. */
  readonly table?: string;
}

function describeWhere(where: ConfigWhere): string {
  const table = where.table === undefined ? "" : ` in ${where.table}`;
  const file = where.file === undefined ? "" : ` (${where.file})`;
  return table + file;
}

/**
 * Something werk was told that it cannot act on.
 *
 * The location is folded into the message as well as kept, because the only
 * thing most callers print is the message, and a message that does not name a
 * file leaves a person hunting through four of them.
 */
export class ConfigError extends Error {
  readonly name = "ConfigError";
  readonly code: ConfigErrorCode;
  /** The failure without the location; `at` re-tells it with one. */
  readonly summary: string;
  readonly where?: ConfigWhere;
  constructor(code: ConfigErrorCode, summary: string, where?: ConfigWhere) {
    super(where === undefined ? summary : summary + describeWhere(where));
    this.code = code;
    this.summary = summary;
    if (where !== undefined) this.where = where;
  }
  /**
   * The same failure, told with where it was found. A field parser knows what
   * is wrong with a value and nothing about which file carried it, so it raises
   * a bare error and whoever opened the file says where.
   */
  at(where: ConfigWhere): ConfigError {
    return new ConfigError(this.code, this.summary, where);
  }
}
