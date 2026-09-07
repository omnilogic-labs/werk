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
