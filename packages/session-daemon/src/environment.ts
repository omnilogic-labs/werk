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

export function sessionEnvironment(
  env: Record<string, string> | undefined,
  sessionId: string,
  daemonId: string,
  version: string,
  source: Environment = process.env,
  windows = process.platform === "win32",
) {
  const base =
    env === undefined
      ? select(source, (key) => {
          const name = windows ? key.toUpperCase() : key;
          return (
            !name.startsWith("WERK_") && name !== "LINES" && name !== "COLUMNS"
          );
        })
      : minimal(source, windows);
  return merge(windows, base, env ?? {}, {
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    TERM_PROGRAM: "werk",
    TERM_PROGRAM_VERSION: version,
    WERK_SESSION: sessionId,
    WERK_DAEMON: daemonId,
  });
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
