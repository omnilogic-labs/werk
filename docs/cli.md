# The command-line client

`packages/werk` builds `werk`, the client for the session daemon. It is one
compiled binary: the same executable serves the daemon, and starts one when a
command needs it. `bun run build` produces `packages/werk/dist/werk`, which
carries the terminal WASM and runs outside the checkout.

This chapter is the reference for the client as it behaves today. Which
commands the product should end up with is not settled. The capabilities in
[product/client.md](product/client.md) are deliberately written as capabilities
rather than commands, and nothing below should be read as a commitment about
hosts, providers or landing, none of which exist. The workspace `create` makes
is a git worktree on this machine, which is the smallest corner of what a
workspace is meant to be; it is no more settled than the rest.

[cli-internals.md](cli-internals.md) has the parts that only matter to somebody
changing the CLI: how a command is declared, why a missing option value reports
alone, and what each dependency is for.

## The command tree

| Command                 | What it does                                                            |
| ----------------------- | ----------------------------------------------------------------------- |
| `create -- COMMAND ...` | Start a session running a command, in a new workspace, and attach to it |
| `list` (`ls`)           | List sessions                                                           |
| `attach [session]`      | Go back to a running session; Ctrl-] detaches                           |
| `logs [session]`        | Print what a session has on screen, or what it has kept                 |
| `kill [session]`        | Ask a session's process to stop                                         |
| `remove` (`rm`)         | Forget a session that has stopped                                       |
| `watch`                 | Print daemon events as JSON lines until interrupted                     |
| `info`                  | Print where werk keeps things and what the daemon says                  |
| `doctor`                | Check the local daemon and print the end of its log                     |
| `config`                | `list`, `get <key>`, `sources`, `path`                                  |
| `completion`            | `bash`, `zsh`, `fish`: print a shell completion script                  |
| `daemon`                | `serve`: run the daemon in this process until it is signalled           |

One more is accepted and not listed. `complete` answers the shell completion
protocol and is a wire format rather than something a person types.

Help drills down: `werk --help` lists the commands, `werk config --help` lists
that command's subcommands, and `werk config get --help` describes one leaf.
Every node repeats the global flags under a **Global Options** heading, because
they are accepted after a command name as well as before it. Every command's
page carries worked examples, between its description and its arguments.

### Global flags

| Flag                   | Effect                                             |
| ---------------------- | -------------------------------------------------- |
| `--json`               | Print JSON instead of text                         |
| `--runtime-dir <PATH>` | Where the daemon socket and endpoint live          |
| `--state-dir <PATH>`   | Where checkpoints, logs and the daemon record live |
| `--log-level <LEVEL>`  | Daemon log level: `error`, `warn`, `info`, `debug` |
| `--no-input`           | Fail instead of prompting                          |
| `-y`, `--yes`          | Answer yes to every confirmation                   |
| `--flavour <NAME>`     | Catppuccin flavour, or `auto` to suit the terminal |
| `--accent <NAME>`      | Which Catppuccin accent marks the active thing     |
| `--color`              | Always use colour                                  |
| `--no-color`           | Never use colour                                   |
| `-V`, `--version`      | Print the version and exit                         |

These are lifted to the front of the argv before parsing, so they mean the same
thing wherever they are typed: `werk --runtime-dir /tmp/r list` and
`werk list --runtime-dir /tmp/r` are the same command line.

`--yes` answers the confirmation `kill` asks before stopping a session that was
chosen from the picker rather than named. A command line that names its session
is never asked, so nothing scripted meets it.

### The `--` boundary

Everything after the first bare `--` is another program's command line. It is
split off before the parser sees it, so a child's flags can never collide with
werk's and are passed through untouched:

```sh
werk create --name demo -- claude --dangerously-skip-permissions
```

`create` reads its command from there and takes no positional of its own.
Completion stops at the same boundary and offers nothing past it.

## Exit codes

| Code | Meaning                                                                     |
| ---- | --------------------------------------------------------------------------- |
| 0    | Success, an asked-for `--help` and `--version` included                     |
| 1    | A failure with no more specific code: `PROTOCOL`, `INTERNAL`, `UNSUPPORTED` |
| 2    | A usage mistake: a bad flag, an unknown command, `INVALID_ARGUMENT`         |
| 3    | `NOT_FOUND` — no such session                                               |
| 4    | `PERMISSION_DENIED`                                                         |
| 5    | `CONFLICT` — a session or workspace name already taken                      |
| 6    | `LIMIT` — a cap was exceeded                                                |
| 7    | `TIMEOUT` or `CLOSED` — the daemon is not answering                         |
| 130  | Cancelled: SIGINT, or a prompt nobody answered                              |

3 through 7 are the error vocabulary of `@werk/session`, mapped rather than
judged, so "the session is gone" and "the daemon never answered" are different
answers to a script. 7 covers both timeout and a closed connection, which a
caller retries differently from a refusal the daemon actually gave.

An attached `create` reports the session's outcome on stderr and exits 0 itself,
so the status is werk's account of werk. See
[Starting a session](#starting-a-session).

Commander reports a `--help` somebody asked for and a parent command given no
subcommand under the same code, separating them by exit status, so the status is
what werk reads. `werk config` on its own prints help and exits 2: nothing ran,
and a script that tested for success would otherwise be told it succeeded.

`@werk/workspace`'s reasons are mapped into the same vocabulary. A workspace
that cannot be made because of what was asked for — an unusable name, a
directory that is not a repository, a repository with no commits — exits 2. One
refused because something is already there — the branch, or a non-empty
directory — exits 5. git being absent, or refusing for an unanticipated reason,
exits 1. Under `--json` the error code on stderr is the workspace reason itself,
so `NOT_A_REPOSITORY` and `BRANCH_EXISTS` reach a script as themselves.

## Starting a session

`create` starts the command and then attaches to it, so starting something and
being in it are one gesture rather than two. Ctrl-] detaches and leaves the
session running, exactly as it does from `attach`, and `werk attach` goes back
to it afterwards.

The summary — the id, the name, the workspace and its branch — is written to
stderr before the attachment takes the screen. It is status rather than the
session's output, so it stays out of a piped stdout, and on a terminal it is
written to the normal screen, still there when the alternate screen is given
back. It carries no `werk attach ID` line, because somebody about to be put
inside the session does not need to be told how to get to it.

Two flags start the session and return instead:

| Flag       | Effect                                                        |
| ---------- | ------------------------------------------------------------- |
| `--detach` | Start it and return; the summary goes to stdout with the hint |
| `--json`   | Answer with the record, which is what a machine asked for     |

`create` takes seven more:

| Flag                   | Effect                                                            |
| ---------------------- | ----------------------------------------------------------------- |
| `--name <NAME>`        | Name the session; werk generates one otherwise                    |
| `--label <KEY=VALUE>`  | Attach a label; repeat the flag for more than one                 |
| `--cols <N>`           | Start the session at this many columns                            |
| `--rows <N>`           | Start the session at this many rows                               |
| `--scrollback <BYTES>` | Bytes of output to keep, instead of the `scrollbackBytes` setting |
| `--cwd <PATH>`         | Which checkout to branch the workspace from                       |
| `--workspace <NAME>`   | Name the workspace and its branch; werk generates one otherwise   |

Without `--cols` and `--rows` the session starts at the terminal's own size,
less the chrome row when `create` is going to attach, and at 80 by 24 when
stdout is not a terminal or the terminal cannot say how big it is.

`--json` implies `--detach` rather than conflicting with it: an attachment
writes the session's own bytes to stdout, and one stream cannot carry those and
the single JSON value `--json` promises. Passing both is the same request said
twice.

Without a terminal, an attached `create` degrades the way `attach` does: the
screen and then the live output go to stdout as plain bytes. So
`werk create -- npm test | tee log` captures the run. `CI` being set does not
change this; it governs prompting, and attaching does not prompt.

An attached session's own exit status is not werk's. `werk create -- false`
exits 0. The child's status is reported instead as `session ID has ended with
status 1` on stderr, which is the same note `attach` writes. werk keeps its own
status because 3 through 7 and 130 already mean specific things in the table
above, and a child's status landing among them would make "the command failed"
indistinguishable from "no such session". Whether werk should ever adopt the
child's status, behind a flag or offset out of the way, is not settled.

## Making a workspace

`create` makes a git worktree and starts the command in it. The branch is the
workspace name, taken from the `HEAD` of the repository `--cwd` is inside;
`--cwd` says which checkout to branch from and nothing else, because the
command always runs in the workspace. Outside a repository, or in one with no
commits, `create` fails and starts nothing.

`--workspace NAME` names the workspace, and the branch, as typed. Without it
the name is generated: the command's own name, or `--name` when there is one,
and a short digest — `claude-a3f2b1c9`. The digest is what lets `werk create`
be run twice in the same repository: a second `--workspace NAME` under the same
name fails, because the branch already exists, and a generated name does not. It is also what makes
the workspace the shortest unique word on a `werk list` row, which is why
[choosing a session](#choosing-a-session) accepts one.

The worktree goes under `$stateDir/workspaces`, in a directory per repository
named after the repository and the digest of its path, so two checkouts of the
same project do not collide. `--state-dir` and a `stateDir` in a config file
move them; there is no setting of their own.

Under `--json` the record carries a `workspace` object — `name`, `directory`,
`branch` and `reference` — beside the session's own fields.

The workspace is made before a daemon is asked for anything, so a repository
that cannot be branched fails without starting one. Nothing removes the worktree
if the session then fails to start.

A workspace name is also a branch name and a directory name, so it is limited to
letters, digits, dot, dash and underscore, starting with a letter or a digit.
That turns away branch names containing `/`. What werk should eventually record
about a workspace, and what more it should be able to do with one, is worked
through in [workspaces-and-git.md](workspaces-and-git.md); `@werk/workspace` is
explicitly under development and a local worktree is the whole of what it makes
today.

## Referencing a workspace

There is one notation for saying which workspace is meant, written at three
levels of verbosity so that a column, a status row and a record can all use the
same spelling:

| Level | Looks like                    | Where it is used                            |
| ----- | ----------------------------- | ------------------------------------------- |
| name  | `fix-login`                   | the `WORKSPACE` column of `werk list`       |
| path  | `fix-login:/path/to/checkout` | the [chrome](#the-chrome), when it has room |
| full  | `fix-login@host:/path`        | `create`'s summary and its `reference` key  |

The host is absent while werk makes workspaces only on the machine it is running
on, so `full` and `path` are the same string today. What an absent host should
mean is [question 24](open-questions.md#24-what-is-the-host-component-of-a-workspace-reference).

A name carries no `@`, `:` or `/`, so the first `:` after the name and host ends
the prefix and the rest is the path. A Windows path survives, because a drive
letter's colon is never the first one.

`werk list` and the chrome, which is the status row werk paints on the bottom
line of the terminal, are given a directory rather than a workspace, so
they work back to one by asking whether this host's layout is what put a
directory where it is. That reaches as far as this host and no further; nothing
records which workspaces exist, which is
[question 19](open-questions.md#19-where-does-the-record-of-a-workspace-live).
A session started somewhere werk did not make leaves the column blank and keeps
its own name in the chrome.

## The chrome

While `attach` holds a terminal, werk spends the bottom row of the window on one
row of its own, and the session gets the window less that row. A window one row
tall has no chrome, because there would be nothing left to frame.

The row is built from parts joined with `·`, in the fixed order below. A part
is added only if the row including it still fits the window's width, and joining
stops at the first part that does not fit rather than skipping it. So a wide
window shows all of the row and a narrow one shows the beginning of it:

1. the workspace, at the most detailed level the width allows, or the session
   name when no workspace can be worked back to
2. `Ctrl-] detaches`, which always survives whole
3. `read-only`, when the attachment asked for no input
4. where the session says it is executing, when that is not the workspace root:
   relative to the workspace, or in full when it is outside it
5. the session name, when the workspace took the first slot
6. the two grid sizes while they differ, and then whether this attachment is
   following the size, was refused it, or could claim it

Part 4 needs the session to say where it has moved to, which a shell does by
emitting `OSC 7`. A shell that does not leaves it out.

Below 22 columns the row carries no identity at all. `Ctrl-] detaches` is 15
characters and the separator costs 3, so a narrower window leaves fewer than 4
columns for a name, and a name cut down to one letter says less than the key
that gets you out. `identity` in `packages/werk/src/view.ts` is where that is
decided.

## Naming a session

A name is what somebody types to come back to a session, so the daemon keeps
generated names unique. The name is the leaf of the command — `claude`, and
`sh` rather than `/bin/sh` — on its own for the first session running it, and
`claude-2`, `claude-3` after that. Removing a session gives its name back
rather than counting past it, because names are for typing and the id is the
durable identifier.

`--name` is taken as typed, and a second session under a name that is already
held is refused with `CONFLICT` rather than quietly renamed. Whether the count
is the right shape — against a digest like the workspace's, or against a
generated pair of words — is not settled; what is settled is that two sessions
must not answer to one name.

## Labels

`werk create --label KEY=VALUE` attaches a label to a session, and the flag
repeats for more than one. `werk list --label KEY=VALUE` shows only the sessions
carrying that label, and repeating the flag narrows further, because a session
has to match every pair given. `werk list --state <STATE>` filters the same way
on `starting`, `running`, `exited`, `failed` or `lost`.

Labels are for a caller's own grouping; nothing in werk reads them. They are
carried in the session record, so `werk list --json` shows them, and
`--label <TAB>` completes on the keys the daemon currently holds.

## Choosing a session

`attach`, `logs`, `kill` and `remove` take an optional `[session]`, which is an
id, a name, the workspace the session is running in, or an unambiguous prefix
of any of them — so the completion offered, the name `create` printed and the
`WORKSPACE` column of `werk list` all work as typed. The workspace carries a
digest, so it is often the shortest unique thing on a row.

Ids beat names beat workspaces, and an exact match at any of those beats a
prefix, so a name that happens to prefix another id is never silently taken for
it. Anything matching more than one session says what it matched, by id, rather
than choosing — including an exact name, because the daemon's uniqueness is not
something the client can assume of a name it was handed.

Given no session at all, and with a terminal to ask in, werk offers a
searchable picker of live sessions, most recently active first; the prompt
paints on stderr so a piped record stays clean, and it carries a two-minute
deadline.

Prompting is forbidden when `--no-input` was passed, when either standard stream
is not a terminal, or when `CI` is set. In that case a missing session is a
usage error raised before anything connects, so `werk attach </dev/null` fails
in milliseconds rather than starting a daemon on its way to failing. That
guard matters more than it looks: no JavaScript prompt library settles on a
closed stdin, so an unguarded prompt wedges a pipeline instead of failing it.

## Two output modes

Every command computes a value and says how a person would read it. The runtime
then prints it in one of two modes: text for a person, or one JSON value for a
machine. `--json` is therefore true of every command by construction rather than
of the ones that remembered it.

- **Human.** Tables for the list-shaped commands, a sentence or a short block
  for the rest. On a terminal a table has a header row and aligned columns
  measured in display cells; piped, it is bare TSV with no header, no padding
  and no colour, so `cut -f2` works. When a row does not fit the terminal, one
  nominated column absorbs the overflow rather than every column shrinking.
- **`--json`.** Exactly one JSON value, on one line, on stdout, and nothing
  else. Records come from `@werk/session` unchanged wherever there is one, so
  `werk list --json` gives the session records and `werk info --json` gives the
  daemon's own inspection report.

Three commands opt out by writing continuously rather than returning a value:

| Command        | Why                                                          |
| -------------- | ------------------------------------------------------------ |
| `attach`       | The session's own output is the output                       |
| `watch`        | Writes daemon events as JSON lines, with or without `--json` |
| `daemon serve` | Runs until it is signalled                                   |

`create` writes continuously too while it is attached, and it is still not in
that table: under `--json` it does not attach, so it answers with exactly one
value like every other command.

`werk logs` answers with text, so its `--json` form is a JSON string:
`werk logs ID --json | jq -r .` is the same bytes the plain form prints, escaped
so they can travel inside a larger document. `werk completion bash` prints the
bare script, so `eval "$(werk completion bash)"` still works; under `--json` the
script arrives beside the shell name and an install hint.

Errors always go to stderr, in both modes, so anything reading stdout sees
only the command's output. Under `--json` a failure is
`{"error":{"code":"...","message":"..."}}`.

## Usage errors

Typing a command wrong is answered with what right looks like. The rules broken
come first, one `error:` line each, and then the failing command's own help: its
usage line, its description, its options, the global flags and its examples.

Everything wrong with an invocation is reported together rather than one run at
a time. Commander stops at the first fault it finds; werk asks the command what
else it declared: required arguments still absent, mandatory options with no
value, and the rules commander cannot express, such as `create` needing a
command after `--`. So `werk create --name` is told both that `--name` wants a
value and that there is still no command to run.

One case reports less. An option typed without its value is refused on its own,
without the other rules beside it, because that fault is raised before werk
knows what the positionals are.
[cli-internals.md](cli-internals.md#why-a-missing-option-value-reports-alone)
says why.

A usage mistake that only becomes apparent once the command is running — no
terminal to pick a session in, a name matching no session — is rendered the same
way, because it is the same kind of mistake. Exit status is 2 throughout.

Under `--json` the whole of that is replaced by the single object JSON mode
answers with, with code `USAGE` and the rules broken as its message. A machine
reading stderr gets one line to parse rather than a page of help.

A CI lane runs every non-streaming command against a real daemon and requires
exactly one parseable value on stdout. It covers every command in the tree: a
new one fails the lane until it is either exercised or explicitly exempted, so
an exemption is a decision someone wrote down.

## Colour

Colour is decided once, before parsing begins. Help is printed during the parse,
so the decision has to exist by then. The same gate governs help, command output
and error messages.

In order:

1. `NO_COLOR` present and non-empty → off. **`NO_COLOR` beats `FORCE_COLOR`**,
   which is the NO_COLOR convention and the opposite of what Bun and chalk do
   between themselves.
2. `TERM=dumb` → off, even under `FORCE_COLOR`. A terminal saying it cannot
   render escapes is taken at its word.
3. The `colour` setting: `never` → off, `always` → on, `auto` → carry on. It
   sits below the two above so that `WERK_COLOUR=always` cannot talk over a
   reader who set `NO_COLOR` or a terminal that says it is dumb.
4. `FORCE_COLOR` set → on unless it is empty, `0` or `false`.
5. Otherwise, on when stdout is a terminal.

`--no-color` and `--color` are read from the raw argv and override the
environment; `--no-color` wins over `--color`. Only tokens before `--` count:
after it, `--no-color` belongs to the child process.

Where colour is on, the depth comes from `COLORTERM` (`truecolor` or `24bit` →
truecolour), then from a `TERM` ending in `-256color`, and otherwise 16 colours.

### What is written

What colour a thing is belongs to [`@werk/palette`](../packages/palette), which
is the one place any of it is named. The CLI asks that library for a use: a heading, a
literal you can type, a name you substitute, a success, a warning, or an error.
`packages/werk/src/runtime/style.ts` turns the answer into escapes, and it is
where chalk is constructed and the only place it is.

The palette is Catppuccin, a set of 24-bit colours, so what werk writes depends
on the depth. At truecolour it writes the role's own hex, and every reader sees
the flavour that was chosen whatever their terminal is themed as. At 256 colours
the same hex is mapped onto the colour cube, which stays close enough to keep
every role distinct. At sixteen colours werk writes the slot instead:
Catppuccin publishes which of its colours sits in each of the sixteen a terminal
theme defines, green is 2, teal 6, red 1 and yellow 3, and werk assigns a slot to
the eight accents Catppuccin places in none. A reader with sixteen colours gets
their own terminal's red for an error and their own green for a success, so the
hue survives even though the flavour cannot.

`muted` and `emphasis` are weight rather than colour, SGR 2 and SGR 1, so no
flavour reaches them.

### Which flavour, and which accent

Catppuccin's model is a flavour plus an accent, and werk carries all four
flavours: Latte, Frappé, Macchiato and Mocha. The accent is one of Catppuccin's
fourteen chromatic colours and marks the thing being attended to: a heading, or
an active border. It never reaches a colour that carries meaning, so an error is
red and a success is green whatever accent is set.

`flavour` defaults to `auto`, which means werk asks the terminal what colour its
background is and uses `flavourLight` or `flavourDark` accordingly. Naming a
flavour instead skips the question entirely.

The question is `OSC 11`, sent with a device attributes request immediately
behind it. Terminals answer escape sequences in order, so the device attributes
reply always ends the exchange: behind the colour when there is one, and on its
own when this terminal does not answer the question. werk reads to that reply
and then stops.

Reading to the end of the exchange, rather than stopping at the colour, is what
keeps the answer off the next reader's input. Anything werk leaves on the stream
is read by whatever reads stdin next, and under `attach` that is the session,
where it arrives in the child as keystrokes. The same rule runs the other way:
anything werk reads that was not part of the answer was typed by a person, so
werk puts it back for the next reader.

The colour comes back in whatever spelling the terminal prefers, which is four
of them:

- XParseColor's `rgb:`, at one to four hex digits a channel;
- XParseColor's `rgbi:`, in floating point;
- a hex triple in three, six, nine or twelve digits, with or without a leading
  `#`;
- an X11 colour name.

werk does not read any of those itself. It hands the reply to ghostty's own
parser, the same one the vendored engine reads a child's `OSC 4` with. Loading
that parser starts in parallel with sending the question, because compiling the
module takes about 7 ms and a terminal answers in single-figure milliseconds.

A terminal that answers neither sequence costs 150 ms, once, and werk then uses
the dark flavour. The same is true of a terminal that answers the colour and not
the sentinel, though no terminal is known to do that. The 150 ms is a judgement
rather than a measurement, and it is the one hole this cannot close: a reply
that arrives after the timeout has fired is left on the stream, and whatever
reads stdin next receives it.

werk does not ask when there is no colour to choose or nowhere to ask: colour is
off, stdout is not a terminal, `TERM` is unset or `dumb`, `CI` is set, or a
session is attached and a child holds the terminal. GNU Screen is excluded
because it relays the query, so the sentinel comes back before any answer could.
tmux is not, because it answers the question itself.

When werk cannot learn the background colour it uses the dark flavour. Which way
round is less annoying to be wrong about is a guess.

### The terminal replica and the browser page

The terminal replica and the browser page paint their own pixels, so they take
the same roles as hex rather than as escapes: nobody else's theme is underneath
them. The replica paints a
child's output in the flavour's own foreground and background, and paints the
child's first sixteen colours from the flavour too. It repaints only the entries
the child has left alone, so a program that sets its own colours with `OSC 4`
keeps them.
The browser page is handed a `palette.css` generated at build time carrying both
a dark flavour and a light one, and picks between them with
`prefers-color-scheme`.

## Configuration

`werk config` shows what werk thinks it has been told and who told it.

```sh
werk config list      # Print every setting, its value, and where it came from
werk config get logLevel
werk config sources   # Print every layer werk consults, weakest first
werk config path      # Print the config files werk reads
```

### The layers

Six, weakest first. A later layer overrides an earlier one key by key, and
`config list` reports the winning layer for each key separately — a layered
configuration nobody can interrogate is worse than a flat one.

| Layer          | Where it comes from                                |
| -------------- | -------------------------------------------------- |
| `defaults`     | Built in                                           |
| `remote`       | A registered portal. Unconfigured today; see below |
| `user file`    | `~/.werk/config.toml`                              |
| `project file` | `<git toplevel>/.werk/config.toml`                 |
| `environment`  | `WERK_*`                                           |
| `flags`        | The command line                                   |

The project directory is the git toplevel as git itself reports it, so a
worktree, a submodule and a `.git` file all resolve correctly, and werk has no
project layer outside a repository.

### The settings

Every key answers to `WERK_` plus its name in screaming snake case. That is a
rule rather than a list, so a new setting gets its variable for free.

| Key               | Variable                | What it is                                         |
| ----------------- | ----------------------- | -------------------------------------------------- |
| `logLevel`        | `WERK_LOG_LEVEL`        | Daemon log level                                   |
| `runtimeDir`      | `WERK_RUNTIME_DIR`      | Where the daemon socket and endpoint live          |
| `stateDir`        | `WERK_STATE_DIR`        | Where checkpoints, logs and the daemon record live |
| `scrollbackBytes` | `WERK_SCROLLBACK_BYTES` | Bytes of output a new session keeps                |
| `colour`          | `WERK_COLOUR`           | `auto`, `always` or `never`                        |
| `flavour`         | `WERK_FLAVOUR`          | `auto` or a Catppuccin flavour                     |
| `flavourDark`     | `WERK_FLAVOUR_DARK`     | What `auto` wears on a dark terminal               |
| `flavourLight`    | `WERK_FLAVOUR_LIGHT`    | What `auto` wears on a light terminal              |
| `accent`          | `WERK_ACCENT`           | Which Catppuccin accent marks the active thing     |

An empty variable is treated as unset, so `WERK_LOG_LEVEL= werk list` gets the
layer below rather than a parse error. A key werk does not know is ignored
rather than refused, so a line the client has no meaning for does not stop it
starting. `WERK_CONFIG_DIR` moves the user layer's directory away from `~/.werk`,
which is what the tests use.

Only settings the CLI acts on appear in that table. A key invented for a feature
that does not exist yet reads back later as a decision somebody took.

Every command acts on the resolved configuration, so a `runtimeDir` set in
`~/.werk/config.toml` is the directory `werk info` reports and the one
`werk attach <TAB>` looks in. `scrollbackBytes` is what `werk create` asks the
daemon to keep for a new session, and `werk create --scrollback <BYTES>`
overrides it for that one session. The daemon's own limit is 10,000,000 bytes,
and it refuses a larger request rather than quietly reducing it: the error is
`LIMIT`, `scrollbackBytes exceeds the daemon cap of 10000000`, and the exit
status is 6.

The layers are read once, before parsing begins, rather than by each command.
Commander prints a help page during the parse, so a `flavour` set in a file has
to be known before then or it would style a command's output and not its help.
That costs `werk --help` about ten milliseconds it did not pay before, nearly all
of it asking git for the repository root; any command that acted on
configuration was already paying it.

`--color` and `--no-color` are the exception and are read from the argv alone.
They take no value and say nothing a layer could hold.

Tab completion is the other exception. It never reads the layers before parsing,
because a shell is blocked on it for every TAB. It reads them inside its own
action instead, on a budget: it abandons them after 50 ms and falls back to the
flags, so a slow layer costs a less accurate completion rather than a shell that
has stopped responding.

Whether `~/.werk` is the right home for the user layer is not settled, and
neither is how a person configures hosts and providers once those exist — that
is open question 2 of the product specification, and it will probably want to
live in the same files.

### The remote layer, and the unimplemented `extends` hook

A portal is expected to supply some of a client's configuration once that client
registers with it. Which settings it takes over, what happens to settings the
client already had, how a person sees what has been taken over, and whether
anything stays theirs to change are all unresolved — that is
[open question 12](open-questions.md#12-what-does-registering-a-client-with-a-portal-take-over),
which the specification calls its own least worked out part.

So what exists is an extension point in the config loader with nothing behind
it. Two things about it are written down: the shape an answer would have, and
where it sits in the precedence order, above werk's built-in defaults and below
anything a person typed or wrote in a file. A config file can name a fragment
such a source would supply:

```toml
extends = ["werk-remote:<id>"]
```

Nothing implements it, `werk config sources` reports the layer as
`unconfigured`, and an id that is not `werk-remote:`-prefixed falls through to
c12's own `extends` resolution.

## Shell completion

`werk completion <shell>` prints a script to install once:

```sh
werk completion bash > /etc/bash_completion.d/werk
werk completion zsh > "${fpath[1]}/_werk"
werk completion fish > ~/.config/fish/completions/werk.fish
```

The script then calls the hidden `werk complete` on every TAB, so candidates are
looked up rather than baked in: `werk attach flap<TAB>` asks the running daemon
and answers `flappy-flippers`. `--label <TAB>` asks it for the label keys in use
the same way. Commands, aliases, flags, choice lists and positionals all come off
the live commander tree the parser uses, so there is no second description of
werk's shape to drift.

The wire format is cobra's `__complete` protocol: one
`value<TAB>description` line per candidate, then a `:<directive>` bitfield line.
`gh`, `docker` and `kubectl` all speak it, so the shell halves are a known
quantity and carapace can bridge werk for free.

Three properties hold and are tested:

- It never starts a daemon. Pressing TAB must not launch a background process,
  so the only route to a client is one that connects to a daemon already
  listening and returns nothing when there is none.
- It never takes longer than 150 ms. Connection and query share that budget, and
  running out is an empty list rather than an error.
- It offers nothing after `--`, where the words belong to another program.

Nothing on this path throws: every failure is the empty reply, because an error
message where a shell expects candidates would be offered to the user as one.
The bash script passes the typed words to werk as arguments rather than through
`eval`, so a session name containing `$(...)` or a backtick cannot run.

## One binary, client and daemon

`werk daemon serve` runs the daemon in the current process until it is
signalled. The client starts one for you: when a command needs a daemon and none
answers, it spawns a detached copy of itself with that subcommand and the
runtime and state directories it resolved.

How it re-invokes itself depends on how it was built. Compiled, `process.execPath`
is werk itself and the command is `werk daemon serve`; running from source,
`execPath` is `bun` and the entry module has to be named, because the compiled
binary's entry is a `/$bunfs/` virtual path no child could open.

`serve` stays visible in help rather than being hidden, because an operator
pointing systemd or launchd at werk cannot discover a hidden command.

`info`, `doctor` and completion never start a daemon; they report what is on
disk plus whatever a daemon that is already listening says about itself.

The runtime directory defaults to `/tmp/werk-UID` on POSIX and
`%LOCALAPPDATA%\werk\run` on Windows. A Unix socket path is capped at 103 bytes,
so a deeply nested `--runtime-dir` fails to bind — short paths under `/tmp` are
what the tests use.

The compiled binary is built with `--no-compile-autoload-dotenv`. Bun otherwise
autoloads a `.env` from the working directory into `process.env`, and `create`
forwards nearly all of `process.env` to the daemon, so `werk create` inside any
repository holding a `.env` would ship that repository's secrets into every
session it started.
