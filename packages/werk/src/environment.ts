/**
 * The names the daemon writes for itself, after everything a client sent.
 *
 * `sessionEnvironment` in `@werk/session-daemon` merges these last and
 * unconditionally: a session's terminal identity is what the daemon made it,
 * not what a client asked for. So sending one is pointless, which is why a
 * host block's `env` refuses them rather than letting them be discarded in
 * silence on the far side.
 */
export const DAEMON_OWNED = [
  "TERM",
  "COLORTERM",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "WERK_SESSION",
  "WERK_DAEMON",
] as const;

const excluded = new Set<string>([
  ...DAEMON_OWNED,
  "TERMCAP",
  "LINES",
  "COLUMNS",
  "WINDOWID",
  "TMUX",
  "TMUX_PANE",
  "STY",
  "WINDOW",
  "ZELLIJ",
  "ZELLIJ_SESSION_NAME",
  "ZELLIJ_PANE_ID",
  "_",
  "PWD",
  "OLDPWD",
  "SHLVL",
  "GPG_TTY",
]);

/**
 * What travels to a session on this machine: everything the caller has, less
 * the terminal and shell state that describes the window werk was typed in.
 *
 * A denylist is affordable here because the daemon is on the same machine and
 * under the same user. `PATH`, `SSH_AUTH_SOCK` and a forgotten credential are
 * all true of the process on the other end, so forwarding them is passing the
 * caller's own environment to the caller's own machine.
 */
export function clientEnvironment(
  source: Record<string, string | undefined> = process.env,
  windows = process.platform === "win32",
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(source).filter(
      ([key, value]) =>
        value !== undefined && !excluded.has(windows ? key.toUpperCase() : key),
    ),
  ) as Record<string, string>;
}

/** What travels to a session on another machine: facts about the person, never about this machine. */
export const REMOTE_FORWARDED = [
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "LC_TIME",
  "TZ",
  "NO_COLOR",
  "FORCE_COLOR",
] as const;

/**
 * The environment for a session on a daemon that is not on this machine.
 *
 * This names what goes, where `clientEnvironment` names what stays, and the
 * direction is inverted on purpose. A denylist is a list of what somebody
 * thought of, and what a forgotten name costs depends on where the environment
 * is going. Locally it reaches the same user on the same machine. Here it
 * reaches another computer, where it lands in that machine's process table, its
 * checkpoints and its logs, and cannot be taken back.
 *
 * Machine facts stay behind for a second reason, which is that they would be
 * wrong rather than merely surplus. `PATH`, `HOME`, `SHELL`, `TMPDIR` and
 * `SSH_AUTH_SOCK` all name things on the machine werk was typed on, and the
 * process is somewhere else. The remote daemon's own environment supplies its
 * versions of them, so nothing is missing by leaving them out.
 *
 * What is left is what a remote process could not work out for itself and that
 * belongs to the person rather than to either machine: which language to speak
 * in, what time it is where they are, and whether they want colour.
 *
 * `create` sends this whenever the daemon it reached is on another machine.
 */
export function remoteEnvironment(
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const forwarded: Record<string, string> = {};
  for (const key of REMOTE_FORWARDED) {
    const value = source[key];
    if (value !== undefined) forwarded[key] = value;
  }
  return forwarded;
}

/**
 * What a session on a host is started with: the base for where it is going,
 * and then whatever the host block asked for.
 *
 * The block wins over both halves above, and it wins for the same reason each
 * of them exists. A denylist is a guess about names nobody named, and so is an
 * allowlist; both are werk deciding on somebody's behalf what a name it has
 * never seen is worth. A host block's `env` is not a guess. Somebody wrote it
 * against that machine, so it goes even when the allowlist would have kept it
 * here, and it stands even when this shell has a value of its own for the same
 * name.
 *
 * The names werk owns still win last, in the daemon, which is why a block that
 * sets one is refused where it is written rather than dropped here.
 */
export function environmentFor(
  host: { readonly env?: Readonly<Record<string, string>> },
  here: boolean,
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  return {
    ...(here ? clientEnvironment(source) : remoteEnvironment(source)),
    ...host.env,
  };
}
