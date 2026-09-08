const excluded = new Set([
  "TERM",
  "COLORTERM",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
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
  "WERK_SESSION",
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
 * Nothing calls this yet.
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
