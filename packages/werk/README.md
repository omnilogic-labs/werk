# werk session CLI

Build from the workspace with `bun run build`, then run `packages/werk/dist/werk`.
`werk help` lists the session commands. `werk create -- /bin/sh` creates a session
and prints its record as JSON. Use its ID with `werk attach ID`; Ctrl-] detaches
while the process continues. `werk list` and `werk watch` need no attachment.

`--runtime-dir` and `--state-dir` configure daemon discovery and retained state,
and `--log-level` (or `WERK_LOG_LEVEL`) sets what the daemon writes to
`$stateDir/daemon.log`. All three work on every command. The CLI supplies its
own daemon command to the launcher. The compiled binary contains the terminal
WASM and can run outside the checkout.

`create --scrollback BYTES` asks for a page-memory budget for the session's
scrollback; omitting it takes the daemon's cap, and asking for more than the cap
fails rather than being clamped. `logs ID` prints the retained screen and
`logs --history` the retained history, which is not a complete durable output
log. `info` prints the resolved paths, the lock mechanism, the recorded daemon
and the daemon's capabilities; `doctor` adds directory, lock and terminfo checks
and the tail of the log. Both are read-only.

TTY attachment carries a local snapshot replica and paints cell frames using
ANSI escapes. The underlying terminal's font and supported attributes determine
the resulting display. A non-TTY attachment prints its initial screen and then
live output; use `logs` for retained text.

At most one attachment sets the session grid, and it need not be this one. A
writable attach takes the size when nobody holds it and then resizes the session
to the local window. `--read-only` requests no input grant and leaves the size
where it is. `--follow` declines the size even with input. `--claim-size` takes
it from whoever holds it, and attaches without it rather than failing when the
daemon's policy refuses the takeover; the two flags contradict each other and
cannot be combined.

While this attachment does not set the grid the two can differ, so the view
clips: rows and columns outside the window are not painted, a wide glyph
straddling the right edge is dropped, a smaller grid is painted top left, the
cursor is hidden while it sits outside the window, and the screen is cleared
whenever either grid changes so that no cell of the larger one lingers. The
bottom local row carries a status line for as long as the grids differ, giving
both sizes, whether the attachment is read-only and what would take the size; it
goes away as soon as they match. Nobody need hold the size at all, and a session
whose holder has left keeps the grid it had until something takes it.

Input is pipelined rather than round-trip bound: the CLI keeps sending until 32
input requests or 64 KiB are unacknowledged, pauses stdin at that bound, and
resumes as the window drains. Ordering is the wire's, so the bytes arrive in the
order typed; a rejected write ends the attachment.

Attaching to a session that has already finished paints its saved screen and
returns. The outcome goes to stderr: the exit status where the daemon recorded
one, and for a `lost` record the fact that it has none. Stdout carries only the
screen, so a piped attachment stays clean.

`create` sends the invoking shell's current environment. It excludes terminal
identity (`TERM`, `COLORTERM`, `TERM_PROGRAM`, `TERM_PROGRAM_VERSION`, `TERMCAP`,
`LINES`, `COLUMNS`, `WINDOWID`), multiplexer markers (`TMUX`, `TMUX_PANE`, `STY`,
`WINDOW`, `ZELLIJ`, `ZELLIJ_SESSION_NAME`, `ZELLIJ_PANE_ID`, `WERK_SESSION`), shell
bookkeeping (`_`, `PWD`, `OLDPWD`, `SHLVL`) and `GPG_TTY`. Other exported values,
including credentials and agent socket paths, come from the current caller.
