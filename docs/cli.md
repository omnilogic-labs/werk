# The command-line client

`packages/werk` builds `werk`, the client for the session daemon. It is one
compiled binary: the same executable serves the daemon, and starts one when a
command needs it. `bun run build` produces `packages/werk/dist/werk`, which
carries the terminal WASM and runs outside the checkout.

This chapter is the reference for the client as it behaves today. What the
command surface should become for the product is not settled — the capabilities
in [product/client.md](product/client.md) are deliberately written as
capabilities rather than commands, and nothing below should be read as a
commitment about hosts, providers or landing, none of which exist. The
workspace `create` makes is a git worktree on this machine, which is the
smallest corner of what a workspace is meant to be; it is no more settled than
the rest.

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

Summaries and descriptions are written to different grammars, which is what
makes a help page read evenly. A command's summary is an imperative sentence
starting with a capital and carrying no full stop, because it stands on its own
line in the parent's command list and again in a shell completion menu. An
option's or an argument's description is a lowercase fragment with no full stop,
because it is read as a continuation of the flag beside it.

A command is built from a spec rather than a chain of calls — see
`packages/werk/src/commands/define.ts`. The spec carries the one-line summary
that appears in the parent's list, the fuller description at the top of the
command's own help, the worked examples, and any rule about the invocation that
commander has no notation for. Summary, description and at least one example are
required fields, so a command that omits one does not compile, and the tests
check that every command in the tree was built this way and that the examples it
declares are examples a person is shown. What none of them do is pin the
wording: the prose moves with the product, and a test that has to be regenerated
after every edit to it stops being read.

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

### Starting a session

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

`--json` implies `--detach` rather than conflicting with it: an attachment
writes the session's own bytes to stdout, and one stream cannot carry those and
the single JSON value the machine register promises. Passing both is the same
request said twice.

Without a terminal, an attached `create` degrades the way `attach` does — the
screen and then the live output go to stdout as plain bytes — so
`werk create -- npm test | tee log` captures the run. `CI` being set does not
change this; it governs prompting, and attaching does not prompt.

An attached session's own exit status is not werk's. `werk create -- false`
exits 0 and reports `session ID has ended with status 1` on stderr, the same
note `attach` writes, because 3 through 7 and 130 already mean specific things
in werk's own vocabulary and a child's status landing among them would make
"the command failed" indistinguishable from "no such session". Whether werk
should ever adopt it — behind a flag, or offset out of the way — is not
settled.

### Making a workspace

`create` makes a git worktree and starts the command in it. The branch is the
workspace name, taken from the `HEAD` of the repository `--cwd` is inside;
`--cwd` says which checkout to branch from and nothing else, because the
command always runs in the workspace. Outside a repository, or in one with no
commits, `create` fails and starts nothing.

`--workspace NAME` names the workspace, and the branch, as typed. Without it
the name is generated: the command's own name, or `--name` when there is one,
and a short digest — `claude-a3f2b1c9`. The digest is what lets `werk create`
be run twice in the same repository, so a name that was asked for explicitly is
a conflict the second time and a generated one is not. It is also what makes
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

### Referencing a workspace

There is one notation for saying which workspace is meant, written at three
levels of verbosity so that a column, a status row and a record can all use the
same spelling:

| Level | Looks like                    | Where it is used                           |
| ----- | ----------------------------- | ------------------------------------------ |
| name  | `fix-login`                   | the `WORKSPACE` column of `werk list`      |
| path  | `fix-login:/path/to/checkout` | the chrome, when the row has room for it   |
| full  | `fix-login@host:/path`        | `create`'s summary and its `reference` key |

The host is absent while werk makes workspaces only on the machine it is running
on, so `full` and `path` are the same string today. What an absent host should
mean is [question 24](product-specification.md#24-what-is-the-host-component-of-a-workspace-reference).

A name carries no `@`, `:` or `/`, so the first `:` after the name and host ends
the prefix and the rest is the path. A Windows path survives, because a drive
letter's colon is never the first one.

`werk list` and the chrome are given a directory rather than a workspace, so
they work back to one by asking whether this host's layout is what put a
directory where it is. That reaches as far as this host and no further; nothing
records which workspaces exist, which is
[question 19](product-specification.md#19-where-does-the-record-of-a-workspace-live).
A session started somewhere werk did not make leaves the column blank and keeps
its own name in the chrome.

### The chrome

While `attach` holds a terminal, werk spends the bottom row of the window on one
row of its own, and the session gets the window less that row. A window one row
tall has no chrome, because there would be nothing left to frame.

The row is built from parts joined with `·`, in a fixed order, and joining stops
at the first part that does not fit. So the widest terminal shows all of it and
the narrowest shows the beginning of it:

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

Below the width that would leave a legible identity there is no identity at all,
because a name cut down to one letter says less than the key that gets you out.

### Naming a session

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

### Choosing a session

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

## Two registers of output

Every command computes a value and says how a person would read it; the runtime
decides which of the two to print. `--json` is therefore true of every command
by construction rather than of the ones that remembered it.

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

`create` writes continuously too while it is attached, but it is not in that
table: under `--json` it does not attach, so it still answers with exactly one
value and stays in the exhaustive lane below.

`werk logs` answers with text, so its `--json` form is a JSON string:
`werk logs ID --json | jq -r .` is the same bytes the plain form prints, escaped
so they can travel inside a larger document. `werk completion bash` prints the
bare script, so `eval "$(werk completion bash)"` still works; under `--json` the
script arrives beside the shell name and an install hint.

Errors always go to stderr, in both registers, so anything reading stdout sees
only the command's output. Under `--json` a failure is
`{"error":{"code":"...","message":"..."}}`.

## Usage errors

Typing a command wrong is answered with what right looks like. The rules broken
come first, one `error:` line each, and then the failing command's own help: its
usage line, its description, its options, the global flags and its examples.
Someone meeting a command for the first time is shown the shape of a working
invocation at the point they got it wrong, rather than being told which clause
of the grammar they missed.

Everything wrong with an invocation is reported together rather than one run at
a time. Commander stops at the first fault it finds; werk asks the command what
else it declared — required arguments still absent, mandatory options with no
value, and the rules commander cannot express, such as `create` needing a
command after `--`. So `werk create --name` is told both that `--name` wants a
value and that there is still no command to run.

Those extra rules are only gathered for faults raised once the operand list has
been assigned. An option that is missing its own value fails while options are
still being parsed, and a missing positional derived at that moment would be
invented rather than observed, so nothing is derived there. A rule held back
costs a second run; a rule invented from a half-parsed command line costs the
reader's trust in the whole message.

A usage mistake that only becomes apparent once the command is running — no
terminal to pick a session in, a name matching no session — is rendered the same
way, because it is the same kind of mistake. Exit status is 2 throughout.

Under `--json` the whole of that is replaced by the single object the machine
register answers with, with code `USAGE` and the rules broken as its message. A
machine reading stderr gets one line to parse rather than a page of help.

A CI lane runs every non-streaming command against a real daemon and requires
exactly one parseable value on stdout. It is exhaustive over the tree: a new
command fails the lane until it is either exercised or explicitly exempted, so
an exemption is a decision someone wrote down.

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

## Colour

Colour is decided once, before parsing begins — help is printed during the
parse, so the decision has to exist by then. The same gate governs help, command
output and error messages.

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
is the one place any of it is named. The CLI asks that library for a use — a
heading, a literal you can type, a name you substitute, a success, a warning, an
error — and `packages/werk/src/runtime/style.ts` turns the answer into escapes.
It is where chalk is constructed, and the only place it is.

The palette is Catppuccin, which is a set of 24-bit colours, so wearing it means
writing them. At truecolour werk writes the role's own hex and every reader sees
the flavour that was chosen, whatever their terminal is themed as. At 256
colours the same hex is mapped onto the colour cube, which stays close enough to
keep every role distinct.

Sixteen colours is the depth that needs a rule of its own, and the rule is
werk's. Catppuccin does not degrade: its ports require truecolour and several
name the terminals they will not work on, so there is nothing upstream to
follow. Left to a nearest-colour search, a dark flavour's green comes out white
and its yellow, red and blue all come out bright white, and five roles collapse
into one. So at this depth werk writes the slot instead. Catppuccin publishes
which of its colours sits in each of the sixteen a terminal theme defines —
green is 2, teal 6, red 1, yellow 3 — and werk fills in the eight accents it
places nowhere. A reader with sixteen colours gets their own terminal's red for
an error and their own green for a success: the hue survives even though the
flavour cannot.

`muted` and `emphasis` are weight rather than colour, SGR 2 and SGR 1, so no
flavour reaches them.

### Which flavour, and which accent

Catppuccin's model is a flavour plus an accent, and werk carries all four
flavours: Latte, Frappé, Macchiato and Mocha. The accent is one of Catppuccin's
fourteen chromatic colours and marks the thing being attended to — a heading, an
active border. It never reaches a colour that carries meaning, so an error is red
and a success is green whatever accent is set.

`flavour` defaults to `auto`, which means werk asks the terminal what colour its
background is and wears `flavourLight` or `flavourDark` accordingly. Naming a
flavour instead skips the question entirely.

The question is `OSC 11`, sent with a device attributes request immediately
behind it. Terminals answer escape sequences in order, so the device attributes
reply is the end of the exchange either way: behind the colour when there is one,
and on its own when this terminal does not answer the question. werk reads to it
and then stops.

Reading to the sentinel rather than stopping at the colour is what keeps the
answer off the next reader's input. werk asked, so the whole answer is werk's to
take off the stream — a reply left behind is read by whatever reads stdin next,
and under `attach` that is the session, where it arrives in the child as
keystrokes.

A terminal that answers neither sequence costs 150 ms, once, and then werk wears
the dark flavour. So does one that answers the colour and not the sentinel,
which is a set that looks empty. That timeout is a judgement rather than a
measurement, and it is the one hole this cannot close: a reply arriving after it
has fired has nobody left to take it.

werk does not ask when there is nothing to wear or nowhere to ask: colour is off,
stdout is not a terminal, `TERM` is unset or `dumb`, `CI` is set, or a session is
attached and a child holds the terminal. GNU Screen is excluded because it
relays the query, so the sentinel comes back before any answer could. tmux is
not, because it answers the question itself.

When werk cannot learn the ground it wears the dark flavour. That is what the
tools looked at do — `delta`, `helix`, Neovim, `termenv` and
`terminal-colorsaurus` all fall back to dark — rather than a rule anyone
published, and it is a guess about which way round is less annoying to be wrong
about.

### The surfaces that own their own pixels

The replica and the browser page take the same roles as hex rather than as
escapes, because nobody else's theme is underneath them. The replica paints a
child's output in the flavour's own foreground and background, and paints the
child's first sixteen colours from the flavour too — but only the ones the child
has left alone, so a program that sets its own colours with `OSC 4` keeps them.
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
overrides it for that one session. The daemon caps whatever it is asked for at
10,000,000 bytes.

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

### The remote layer, and the `extends` seam

A portal is expected to supply some of a client's configuration once that client
registers with it. Which settings it takes over, what happens to settings the
client already had, how a person sees what has been taken over, and whether
anything stays theirs to change are all unresolved — that is
[open question 12](product-specification.md#12-what-does-registering-a-client-with-a-portal-take-over),
which the specification calls its own least worked out part.

So what exists is a seam rather than a design. Two things about it are written
down: the shape an answer would have, and where it sits in the precedence
order — above werk's built-in defaults and below anything a person typed or
wrote in a file. A config file can name a fragment such a source would supply:

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

The wire format is cobra's `__complete` protocol — one
`value<TAB>description` line per candidate, then a `:<directive>` bitfield line
— which `gh`, `docker` and `kubectl` all speak, so the shell halves are a known
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

## What the CLI depends on

Five runtime packages beyond the workspace's own. The list is short on purpose:
what a terminal client does is mostly its own, and everything here earns its
place by doing something that would otherwise be hand-written badly.

`package.json` gives every one a caret range except `c12`, which is pinned
exactly; the versions below are what those ranges resolve to.

| Package                       | Version    | Licence | Why                                                           |
| ----------------------------- | ---------- | ------- | ------------------------------------------------------------- |
| `commander`                   | 15.0.0     | MIT     | The command tree, parsing and help                            |
| `@commander-js/extra-typings` | 15.0.0     | MIT     | Types the options and positionals a command declares          |
| `@clack/prompts`              | 1.8.0      | MIT     | The searchable session picker and confirmations               |
| `chalk`                       | 6.0.0      | MIT     | Styling, with the colour level supplied rather than detected  |
| `c12`                         | 4.0.0-rc.1 | MIT     | Reads config files in several formats, and resolves `extends` |
| `chokidar`                    | 5.0.0      | MIT     | Never called; see below                                       |

### commander

It carries the whole shape of the CLI — subcommands, aliases, choice lists,
option value parsers, help layout — and the completion walker reads that same
tree rather than keeping a description of its own. Two things about it are
worth knowing.

`exitOverride` is what separates a usage mistake from a failure the daemon
reported. Left alone, commander exits 1 for a mistyped flag, which is the code
werk uses for a refusal; throwing instead lets the entry point give usage
mistakes their own status. `--help` and `--version` arrive the same way and are
mapped back to 0.

`showHelpAfterError` and `addHelpText` are what carry the explanation, so there
is one help renderer rather than a second one to keep in step with it. Werk's
own rules reach the same path by wrapping `Command#error`, which is also where
the further faults are gathered onto the one commander noticed. An option value
werk rejects is raised as commander's `InvalidArgumentError`; anything else
thrown from an option parser is rethrown raw out of `_callParseArg` and escapes
the parse with no usage attached.

`addHelpText` is implemented as `beforeHelp` and `afterHelp` listeners that only
`outputHelp()` fires. `helpInformation()` returns the same page without them, so
anything asserting on help has to render it the way a person receives it or it
silently misses every examples block.

`addCommand` does not copy the parent's settings the way `.command()` does, so
help styling, the colour gate and `showGlobalOptions` are copied down the tree
explicitly. Commander also strips colour it did not decide on, so the gate is
handed to it directly; without that, styles are computed and then thrown away.

### @clack/prompts

The picker is a searchable autocomplete whose rows carry name, state and command
in the label, because clack shows a hint only for the row the cursor is on and
the label is what its search filters against. It reports a cancelled prompt by
resolving with a sentinel rather than by throwing, which is the shape that gets
mistaken for an answer, so every prompt goes through one wrapper that turns the
sentinel — and an expired deadline, which clack reports the same way — into a
cancellation.

### chalk

The colour decision is werk's, not a library's: every colour library's built-in
detection is wrong for at least one case werk cares about. picocolors forces
colour on when `CI` is set or the platform is Windows; yoctocolors consults
`tty.WriteStream.prototype.hasColors()` — the prototype, with no stream — so it
never learns whether this stdout is a terminal. chalk is constructed with an
explicit level, in `runtime/style.ts` and nowhere else, and does the styling
only; which colour each role is comes from `@werk/palette`.

### c12, and what the merge actually is

c12 is werk's config **reader**: it finds `<dir>/config.toml`, parses TOML,
JSON, JSONC, YAML and JavaScript through one interface, and resolves `extends`,
which is where the remote seam hangs.

The merge is werk's own pure function. c12 has five fixed slots where werk has
six ordered layers with per-key provenance, `~/.werk/config.toml` fits none of
those slots, and c12's `layers` array reports which files it read rather than
which layer won each key. Layers in, resolved config plus the layer every value
came from out, no filesystem — which is what makes `werk config list` cheap to
test and correct by construction.

Every route c12 would take on its own is switched off: `rcFile` reads a flat
`.werkrc`, `globalRc` wanders to the home directory on its own terms,
`packageJson` would let a dependency's manifest contribute, and `dotenv` would
merge a `.env` into the environment. werk's file is `<dir>/config.toml` and the
caller decides which directory — c12 does not walk up from a subdirectory, so
the repository root is resolved by asking git and handed to it as `cwd`.

It is imported dynamically, because importing it costs about 21 ms against
werk's 8.2 ms floor. Tab completion must never pay that, and neither should a
caller who only wants the pure merge, so the cost lands when a command actually
reads a config file.

The version is pinned exactly rather than by a range because 4.0.0-rc.1 is a
prerelease. v4 is what moves `jiti`, `giget`, `dotenv` and `chokidar` out of
hard dependencies and into optional peers, which is the difference between
bundling a config reader and bundling a TypeScript loader and a git-fetching
downloader.

### chokidar

`chokidar` is a direct dependency **only** so the build works, and werk never
calls it. c12 v4 declares it an optional peer and does `await import("chokidar")`
inside `watchConfig`; Bun's bundler resolves that dynamic import at build time
whether or not the code path is reachable. Removing the dependency because
nothing imports it breaks the build.
