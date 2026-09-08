# @werk/cli

The `werk` command. It starts a process somewhere, gives it a workspace of its
own, and lets you come back to it later.

This is a private workspace package, published as `@werk/cli` with one binary,
`werk`. [`docs/cli.md`](../../docs/cli.md) is the reference for the whole
command set, the two output modes, exit codes, configuration and shell
completion. This file records what the client does with a session.

## Building and running

```sh
bun run build                # from the workspace root
packages/werk/dist/werk --help
```

The compiled binary contains the terminal WASM and can run outside the checkout.

## Making a session and coming back to it

```sh
werk create -- /bin/sh                     # start it and attach; Ctrl-] detaches
werk create --detach -- npm run dev        # start it and return
werk create --workspace fix-login -- claude # name the workspace and its branch
werk list                                  # what is running
werk attach demo                           # by id, name or workspace
werk logs demo                             # the retained screen
werk kill demo --intent force
werk remove demo
werk info                                  # paths, lock mechanism, daemon
werk doctor                                # plus directory, lock and terminfo checks
```

`werk create` starts a session and attaches to it. `--detach` starts it and
returns instead, printing its id, name and command. `--json` answers with the
whole record without attaching, because the session's own bytes and one JSON
value cannot share stdout.

`werk list` and `werk watch` need no attachment. `attach`, `logs`, `kill` and
`remove` given no session offer a picker when there is a terminal to ask in, and
fail as a usage error when there is not.

`create --scrollback BYTES` asks for a page-memory budget for the session's
scrollback. Omitting it takes the daemon's cap, and asking for more than the cap
fails rather than being clamped.

`logs ID` prints the retained screen and `logs --history` the retained history,
which is not a complete durable output log. `info` prints the resolved paths,
the lock mechanism, the recorded daemon and the daemon's capabilities; `doctor`
adds directory, lock and terminfo checks and the tail of the log. Both are
read-only and neither starts a daemon.

## Workspaces

`werk create` makes a workspace on every invocation: a git worktree of the
repository you are standing in, on a new branch, under
`$stateDir/workspaces`. The session runs in that worktree rather than in your
checkout.

`--workspace NAME` names it, and that name is also the branch name. Without the
flag, werk generates a name from the command being run plus a random suffix, so
`werk create -- claude` twice in one repository gives `claude-a3f2b1c9` and
`claude-7e04d215`. `--cwd PATH` says which checkout to branch from; it does not
say where the command runs.

Because the digest makes a workspace name the shortest unique thing on a `werk
list` row, `werk attach` accepts a workspace name as well as a session id or
name. Ids beat names beat workspaces, and an exact match beats a prefix. See
[`@werk/workspace`](../workspace/README.md).

## Attaching

TTY attachment carries a local snapshot replica and paints cell frames using
ANSI escapes. The underlying terminal's font and supported attributes determine
the resulting display. A non-TTY attachment prints its initial screen and then
live output; use `logs` for retained text.

At most one attachment sets the session grid, and it need not be this one. A
writable attach takes the size when nobody holds it, and then resizes the
session to the local window less the row of chrome described below.

| Flag           | What it does                                                                          |
| -------------- | ------------------------------------------------------------------------------------- |
| `--read-only`  | Requests no input grant and leaves the size where it is                               |
| `--follow`     | Declines the size even with input                                                     |
| `--claim-size` | Takes the size from whoever holds it, and attaches without it when the daemon refuses |

`--follow` and `--claim-size` contradict each other and cannot be combined.

Attaching to a session that has already finished paints its saved screen and
returns. The outcome goes to stderr: the exit status where the daemon recorded
one, and for a `lost` record the fact that it has none. Stdout carries only the
screen, so a piped attachment stays clean.

## The status row and grid clipping

The bottom local row is werk's rather than the session's. It always names the
session, the key that detaches, and whether the attachment is read-only. A
window too narrow for all of that keeps the name and the key.

The session grid is therefore the window less one row, which is also the size a
size-holding attachment asks for. Only a window one row tall gives the row up,
having nothing left to frame.

While this attachment does not set the grid, the two grids can differ, so the
view clips:

- Rows and columns outside the area are not painted.
- A wide glyph straddling the right edge is dropped.
- A smaller grid is painted top left.
- The cursor is hidden while it sits outside the area.
- The screen is cleared whenever either grid changes, so no cell of the larger
  one lingers.

For as long as they differ, the bottom row also gives both sizes and what would
take the size. Nobody need hold the size at all, and a session whose holder has
left keeps the grid it had until something takes it.

## Input pipelining

Input is pipelined rather than round-trip bound. The CLI keeps sending until 32
input requests or 64 KiB are unacknowledged, pauses stdin at that bound, and
resumes as the window drains. The transport preserves order, so the bytes arrive
in the order typed. A rejected write ends the attachment.

## Daemon discovery and logs

`--runtime-dir` and `--state-dir` configure daemon discovery and retained state,
and `--log-level` (or `WERK_LOG_LEVEL`) sets what the daemon writes to
`$stateDir/daemon.log`. All three work on every command, before or after the
command name. The CLI supplies its own `daemon serve` command to the launcher,
and `werk daemon serve` runs a daemon in the foreground.

## Environment

`create` sends the invoking shell's current environment, minus the following.

| Category            | Removed                                                                                                 | Why                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Terminal identity   | `TERM`, `COLORTERM`, `TERM_PROGRAM`, `TERM_PROGRAM_VERSION`, `TERMCAP`, `LINES`, `COLUMNS`, `WINDOWID`  | The daemon owns these; the session's terminal is not yours |
| Multiplexer markers | `TMUX`, `TMUX_PANE`, `STY`, `WINDOW`, `ZELLIJ`, `ZELLIJ_SESSION_NAME`, `ZELLIJ_PANE_ID`, `WERK_SESSION` | The child is not inside the multiplexer you are inside     |
| Shell bookkeeping   | `_`, `PWD`, `OLDPWD`, `SHLVL`                                                                           | They describe your shell, not the session's                |
| Other               | `GPG_TTY`                                                                                               | It names a terminal the session does not have              |

Every other exported value, credentials and agent socket paths included, comes
from the current caller. The compiled binary is built with
`--no-compile-autoload-dotenv`, so a `.env` in the directory `werk` was run from
is not read into that environment.
