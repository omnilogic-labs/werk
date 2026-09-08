import { SessionError } from "@werk/session";

const baseKeys = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG"];
const windowsKeys = [
  "SYSTEMROOT",
  "COMSPEC",
  "PATHEXT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
];
type Environment = Record<string, string | undefined>;

function select(source: Environment, allowed: (key: string) => boolean) {
  return Object.fromEntries(
    Object.entries(source).filter(
      ([key, value]) => value !== undefined && allowed(key),
    ),
  ) as Record<string, string>;
}

function minimal(source: Environment, windows: boolean) {
  const keys = new Set([...baseKeys, ...(windows ? windowsKeys : [])]);
  return select(source, (key) => keys.has(windows ? key.toUpperCase() : key));
}

/** Resolve duplicate Windows names so caller and owned values win consistently. */
function merge(windows: boolean, ...sources: Environment[]) {
  const result: Record<string, string> = Object.create(null);
  for (const source of sources)
    for (const [key, value] of Object.entries(source))
      if (value !== undefined)
        result[windows ? key.toUpperCase() : key] = value;
  return result;
}

export function daemonEnvironment(
  source: Environment = process.env,
  windows = process.platform === "win32",
) {
  const extra = new Set(["TMPDIR", "XDG_RUNTIME_DIR", "XDG_STATE_HOME"]);
  return merge(
    windows,
    minimal(source, windows),
    select(source, (key) => {
      const name = windows ? key.toUpperCase() : key;
      return extra.has(name) || name.startsWith("WERK_");
    }),
  );
}

/**
 * What a session runs with: the daemon's own environment, then whatever the
 * client sent on top of it, then the few names werk owns outright.
 *
 * The client's `env` is an overlay rather than a specification. Nothing asks a
 * client to describe a whole environment, and it is not in a position to: on a
 * daemon running on another machine the interesting values — `NVM_DIR`,
 * `CARGO_HOME`, the tool paths a login shell exported — are facts about that
 * machine, and a base narrow enough to be "safe" would throw all of them away.
 * So the base is always what the daemon has, and a client changes only what it
 * names.
 *
 * How wide that base is depends on how the daemon was started, which is where
 * it should be decided: one the CLI spawned has `daemonEnvironment()`'s narrow
 * set, and one an operator started from a login shell has everything that shell
 * had.
 *
 * `WERK_*`, `LINES` and `COLUMNS` are dropped from the base because they
 * describe the daemon's own run rather than the session's, and the last layer
 * is owned outright: a session's terminal identity is what the daemon made it,
 * not what a client asked for.
 */
export function sessionEnvironment(
  env: Record<string, string> | undefined,
  sessionId: string,
  daemonId: string,
  version: string,
  source: Environment = process.env,
  windows = process.platform === "win32",
) {
  const base = select(source, (key) => {
    const name = windows ? key.toUpperCase() : key;
    return !name.startsWith("WERK_") && name !== "LINES" && name !== "COLUMNS";
  });
  return onPath(
    merge(windows, base, env ?? {}, {
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      TERM_PROGRAM: "werk",
      TERM_PROGRAM_VERSION: version,
      WERK_SESSION: sessionId,
      WERK_DAEMON: daemonId,
    }),
    source.WERK_BIN_DIR,
    windows,
  );
}

/**
 * werk's own directory, at the front of a session's `PATH`.
 *
 * A program in a session has to be able to run `werk` for `werk edit` to be
 * reachable at all, and on a machine werk installed itself on the binary is at
 * `~/.local/share/werk/bin/<target>-<stamp>/werk`, which is on nobody's `PATH`.
 * Nor could a person put it on theirs: the stamp in that path changes with
 * every build of the client that sent it.
 *
 * The directory arrives as `WERK_BIN_DIR` in the daemon's own environment,
 * because whether this process is a binary of its own or a `bun` running from
 * source is a thing only the CLI knows. It is dropped from the session's
 * environment with every other `WERK_*`, so what a session sees is the effect
 * and not the cause.
 *
 * The front, not the back, because the point is to be found. A `werk` the
 * person installed themselves is the one thing that would shadow it, and a
 * session started by this daemon should reach the daemon's own build rather
 * than one of a different version.
 */
function onPath(
  env: Record<string, string>,
  dir: string | undefined,
  windows: boolean,
): Record<string, string> {
  if (dir === undefined || dir === "") return env;
  const separator = windows ? ";" : ":";
  const path = env.PATH;
  if (path === undefined || path === "") return { ...env, PATH: dir };
  // Idempotent, so a daemon that restarts a session does not grow its `PATH`.
  if (path.split(separator).includes(dir)) return env;
  return { ...env, PATH: `${dir}${separator}${path}` };
}

export function validateEnvironment(env: Record<string, string> | undefined) {
  const entries = Object.entries(env ?? {});
  let total = 0;
  if (entries.length > 1024)
    throw new SessionError("LIMIT", "Too many environment entries");
  for (const [key, value] of entries) {
    const keyBytes = Buffer.byteLength(key);
    const valueBytes = Buffer.byteLength(value);
    total += keyBytes + valueBytes + 2; // '=' and terminating NUL in envp
    if (
      !key ||
      keyBytes > 256 ||
      /[=\0]/.test(key) ||
      value.includes("\0") ||
      valueBytes > 128 * 1024 ||
      total > 1024 * 1024
    )
      throw new SessionError("LIMIT", "Session environment exceeds limits");
  }
}
