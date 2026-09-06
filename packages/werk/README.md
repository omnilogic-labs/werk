# werk session CLI

Build from the workspace with `bun run build`, then run `packages/werk/dist/werk`.
`werk help` lists the session commands. `werk create -- /bin/sh` creates a session
and prints its record as JSON. Use its ID with `werk attach ID`; Ctrl-] detaches
while the process continues. `werk list` and `werk watch` need no attachment.

`--runtime-dir` and `--state-dir` configure daemon discovery and retained state.
The CLI supplies its own daemon command to the launcher. The compiled binary
contains the terminal WASM and can run outside the checkout.

TTY attachment carries a local snapshot replica and paints cell frames using
ANSI escapes. The underlying terminal's font and supported attributes determine
the resulting display. A non-TTY attachment prints its initial screen and then
live output; use `logs` for retained text. `--read-only` requests no input grant.
