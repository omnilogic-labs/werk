# The command-line client

`packages/werk` builds `werk`, the client for the session daemon. It is one
compiled binary: the same executable serves the daemon, and starts one when a
command needs it. `bun run build` produces `packages/werk/dist/werk`, which
carries the terminal WASM and runs outside the checkout.

This chapter is the reference for the client as it behaves today. What the
command surface should become for the product is not settled. The capabilities
in [product/client.md](product/client.md) are deliberately written as
capabilities rather than commands, and nothing below should be read as a
commitment about providers or landing, neither of which exists. Hosts do exist,
and [hosts.md](hosts.md) is their reference. The workspace `create` makes is a
git worktree, on this machine or on the machine `--host` names, which is the
smallest corner of what a workspace is meant to be; it is no more settled than
the rest.

[cli-internals.md](cli-internals.md) has the parts that only matter to somebody
changing the CLI: how a command is declared, why a missing option value reports
alone, and what each dependency is for.

## The command tree

| Command                                                                      | What it does                                                                  |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `create -- COMMAND ...`                                                      | Start a session running a command, in a new workspace, and attach to it       |
| `list` (`ls`)                                                                | List sessions                                                                 |
| `attach [session]`                                                           | Go back to a running session; Ctrl-] detaches                                 |
| `logs [session]`                                                             | Print what a session has on screen, or what it has kept                       |
| `kill [session]`                                                             | Ask a session's process to stop                                               |
| `remove` (`rm`)                                                              | Forget a session that has stopped                                             |
| `watch`                                                                      | Print daemon events as JSON lines until interrupted                           |
| `setup`                                                                      | Run a machine's setup block without making a workspace                        |
| `info`                                                                       | Print where werk keeps things and what the daemon says                        |
| `doctor`                                                                     | Check the local daemon and print the end of its log                           |
| `config`                                                                     | `list`, `get`, `set`, `unset`, `setup`, `check`, `sources`, `path`            |
| `completion`                                                                 | `bash`, `zsh`, `fish`: print a shell completion script                        |
| `daemon`                                                                     | `serve`: run the daemon in this process; `endpoint`: print what to connect to |
| One more is accepted and not listed. `complete` answers the shell completion |
| protocol and is a wire format rather than something a person types.          |

Help drills down: `werk --help` lists the commands, `werk config --help` lists
that command's subcommands, and `werk config get --help` describes one leaf.
Every node repeats the global flags under a **Global Options** heading, because
they are accepted after a command name as well as before it. Every command's
page carries worked examples, between its description and its arguments.

### Global flags

| Flag                   | Effect                                             |
| ---------------------- | -------------------------------------------------- |
| `--json`               | Print JSON instead of text                         |
| `--host <NAME>`        | Which host to act on, by the name in your config   |
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

`--host` names a `[hosts.<name>]` block, and `defaultHost` answers when nothing
does. `create`, `list`, `attach`, `logs`, `kill` and `remove` all act on that
one machine, and `config setup` writes the block for the name it is given.
A name nothing defines fails with the names that are defined, because that
failure is nearly always a typo.

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
| 7    | Nothing answered: `TIMEOUT`, `CLOSED`, `HOST_DAEMON_MISSING`                |
| 130  | Cancelled: SIGINT, or a prompt nobody answered                              |

3 through 7 are the error vocabulary of `@werk/session`, mapped rather than
judged, so "the session is gone" and "the daemon never answered" are different
answers to a script. 7 covers a timeout, a closed connection, a forward that came
up with nothing listening behind it, and a machine that stopped answering while a
workspace was being made on it. All of those are things a caller retries
differently from a refusal something actually gave.

A machine werk could not reach at all exits 2 rather than 7, which is worth
knowing before scripting either. `werk list --host beast` against a machine that
is asleep reports `HOST_UNREACHABLE` and exits 2; the same machine failing
partway through `werk create --host beast` reports the same code and exits 7.
Nobody decided that. The two paths map the code separately, and only the second
one is covered by a test. It probably wants settling one way.

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
directory — exits 5. A machine that did not answer exits 7 and one that would
not let werk in exits 4, which are the statuses a daemon that did the same
already uses. git being absent at either end, a history that did not get there,
and git refusing for an unanticipated reason all exit 1. Under `--json` the
error code on stderr is the workspace reason itself, so `NOT_A_REPOSITORY`,
`BRANCH_EXISTS` and `HOST_UNREACHABLE` reach a script as themselves.

Configuration is mapped the same way. A host block that does not parse, a name
nothing defines and a file that is not the TOML it claims to be are all "what
werk was told is wrong", which is exit 2. That covers a `setup` or a
`workspaceSetup` naming a block nothing defines, and a `copy` naming a path that
is not there. A file werk could not write, or would not write because it could
not make the change cleanly, is exit 1: the machine did not do it. No new
statuses; nothing scripting werk should have to learn a number to find out that
a config file has a typo in it.

A setup command that refused is exit 1, under `HOST_SETUP_FAILED` for a
machine's block and `WORKSPACE_SETUP_FAILED` for a repository's. Neither is a
usage mistake and neither is a machine that did not answer: werk reached it, and
something somebody wrote there exited non-zero. A machine that stopped answering
part-way through a setup still reports `HOST_UNREACHABLE` and exits 7.

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

`create` takes eight more:

| Flag                   | Effect                                                            |
| ---------------------- | ----------------------------------------------------------------- |
| `--name <NAME>`        | Name the session; werk generates one otherwise                    |
| `--label <KEY=VALUE>`  | Attach a label; repeat the flag for more than one                 |
| `--cols <N>`           | Start the session at this many columns                            |
| `--rows <N>`           | Start the session at this many rows                               |
| `--scrollback <BYTES>` | Bytes of output to keep, instead of the `scrollbackBytes` setting |
| `--cwd <PATH>`         | Which checkout to branch the workspace from                       |
| `--describe <TEXT>`    | Say what the workspace is for, instead of being asked             |
| `--workspace <NAME>`   | Name the workspace and its branch, exactly as typed               |

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

### What it is called

Unless `--workspace` has already settled it, `create` asks what the workspace is
for and makes the name out of the answer. "Fix the login redirect on Safari"
becomes `fix-login-redirect-safari`: the words that carry the meaning, lowercased
and joined, at most four of them and at most 40 characters. `--describe TEXT` is
that question answered in advance, which is how a script reaches the same
naming.

Answering with nothing, or being somewhere the question cannot be asked, gets a
made-up name instead: `magical-otters-flexing`, an adjective, a plural noun and
a verb. Two of those are told apart at a glance, which is what the name is for
on a `werk list` row and in `git branch` output.

The question is skipped where an answer would change nothing or could not be
read: after `--workspace` or `--describe`, under `--json`, and wherever
prompting is forbidden — `--no-input`, a pipe on either stream, or `CI` set. All
of those take the made-up name.

Neither generated form carries a digest, so neither is unique on its own.
`create` therefore offers the maker a sequence of names and takes the first it
accepts: a described name is numbered — `fix-login-redirect`, then
`fix-login-redirect-2` — and a made-up one is simply made up again, five names
before it gives up. `--workspace NAME` is a sequence of one, so asking for the
same name twice is the conflict it looks like.

A workspace name is often the shortest unique word on a `werk list` row, which
is why [choosing a session](#choosing-a-session) accepts one.

The worktree goes under `$stateDir/workspaces`, in a directory per repository
named after the repository and the digest of its path, so two checkouts of the
same project do not collide. `--state-dir` and a `stateDir` in a config file
move them; there is no setting of their own.

Under `--json` the record carries a `workspace` object — `name`, `directory`,
`branch` and `reference` — beside the session's own fields, and a `setup` object
holding what each of the two setups came to:

```json
{
  "setup": {
    "host": {
      "state": "current",
      "block": "my-boxes",
      "fingerprint": "9f2c1b04e9d1",
      "asked": false
    },
    "workspace": {
      "state": "ran",
      "block": "bootstrap",
      "fingerprint": "3a71c0de5b22",
      "commands": 1
    }
  }
}
```

`state` is `none` where nothing named a block, `current` where the machine
already has it, `ran` where it ran, and `skipped` where werk left it alone and
`why` says what would have answered the question. Both keys are always there, so
a caller reads a state rather than an absence.

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

## Putting work on another machine

`werk create --host beast -- claude` makes the workspace on `beast` and starts
the session in the daemon over there. `--host` names a `[hosts.<name>]` block,
and `defaultHost` answers when the flag does not.

What happens on the far side is a bare mirror of the repository, pushed to, and
a linked worktree checked out beside it. Only committed history travels;
anything uncommitted stays on the machine `werk` was typed on and werk says how
many files that is. Where the mirror and the worktree go is the block's
`workspaceRoot`, or, when the block does not say, whatever
`${XDG_STATE_HOME:-$HOME/.local/state}/werk/workspaces` resolves to on that
machine — asked of the machine rather than guessed at from this one.

A session on another machine gets a narrow environment: `LANG`, the `LC_*`
variables, `TZ`, `NO_COLOR` and `FORCE_COLOR`, and nothing else. That is an
allowlist rather than the denylist a local session gets, because a name nobody
thought of costs a credential when the destination is another computer, and
because `PATH`, `HOME`, `SHELL`, `TMPDIR` and `SSH_AUTH_SOCK` would be facts
about the wrong machine. The remote daemon's own environment supplies its
versions of those.

Making a workspace over there is probe, prepare, push and check out, which is
not instant. `create` says which stage it is in: a spinner on a terminal, one
line per stage on stderr under `--no-input`, and nothing at all under `--json`,
because the machine register is one value on stdout. Ctrl-C during creation
aborts it, the maker takes back the branch and the worktree it had got as far
as, and werk exits 130.

Each of these commands talks to **one** daemon: this machine's without `--host`,
that machine's with it. There is no view across machines. Nothing records that a
workspace exists, so a workspace with no session running in it is not listed
anywhere, including on the machine it is on. Where that record should live is
[question 19](open-questions.md#19-where-does-the-record-of-a-workspace-live).

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

`werk config` shows what werk thinks it has been told and who told it, and
writes to the two files it reads.

```sh
werk config list      # Print every setting, its value, and where it came from
werk config get logLevel
werk config sources   # Print every layer werk consults, weakest first
werk config path      # Print the config files werk reads

werk config set logLevel debug     # Write one setting to ~/.werk/config.toml
werk config unset logLevel         # Take it back out
werk config setup                  # Add a machine, by answering questions
werk config check                  # Ask each configured host about itself
```

`--project` on `set`, `unset` and `setup` writes `<git toplevel>/.werk/config.toml`
instead of `~/.werk/config.toml`.

### Writing a config file

A config file is meant to be opened and edited by hand, so werk splices rather
than rewriting. It writes whole `[hosts.<name>]` tables and single top-level
scalar lines, and everything outside the part it replaced comes back byte for
byte: the comments, the blank lines, the key order, the indentation, the line
endings. It then parses what it produced and compares it against what the edit
asked for, and refuses with exit 1 rather than writing anything it cannot make
cleanly. The file is written to a temporary file beside itself and renamed over,
so a reader never sees half of one.

After `set` or `unset`, werk re-resolves the key and says which layer is
supplying it. Writing a file does not mean winning: an exported `WERK_LOG_LEVEL`
still beats it, and that is invisible from the file that was just edited.

### Adding a machine

`werk config setup` walks through adding a host: which machine, what to call it,
and where workspaces go on it. It reads the `Host` patterns out of your
ssh_config for the list to pick from, asks the machine you picked about itself,
shows the exact TOML it would add, and only then writes. Re-running it offers to
add another, change one, choose the default, or remove one.

```sh
werk config setup --host beast --ssh beast --workspace-root /srv/werk --default --yes
```

That form answers every question up front, which is how a dotfiles script uses
it. `--host` there is the global flag: it is the name the block will have, which
is the same name every other command uses to act on that machine. Without a
terminal and without `--host` and `--ssh` the command exits 2 and writes
nothing, because a wizard that guesses at which machine you meant is worse than
one that stops.

What it writes is only what the machine is called and where werk may put things.
Everything else werk asks the machine at the moment it needs to know, which is
what `werk config check` prints: whether the machine answers, what it is
running, whether git and werk are on it, and where workspaces would go. None of
that is stored, and nothing on the machine is created to find it out. The probe
`config check` runs is not yet wired to the ssh transport, so it reports an ssh
host as `not checked` rather than as unreachable — `werk list --host <name>` is
what actually reaches one today.

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
| `defaultHost`     | `WERK_DEFAULT_HOST`     | Which host werk puts work on when nobody names one |
| `workspaceSetup`  | `WERK_WORKSPACE_SETUP`  | Which `[setup.<name>]` block a new workspace gets  |
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

Only settings that describe something werk already does appear in that table. A
key invented for a feature that does not exist yet reads back later as a decision
somebody took. `defaultHost` is what a command acts on when `--host` names none,
which is `local` until somebody writes a host block and points it somewhere else.

`workspaceSetup` is the one key with no value underneath it. Every other setting
has a default, and `config list` shows it as `unset` until a file names a
`[setup.<name>]` block. There is no block werk would run in a new workspace by
default, and an empty name is not a name.

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

Whether `~/.werk` is the right home for the user layer is not settled. How a
person configures providers once those exist is
[question 2](open-questions.md#2-how-does-a-person-configure-their-hosts-and-providers);
hosts are in these files already.

### Hosts

A host is a machine. A `[hosts.<name>]` table in either config file says which
machine a name means, and `werk config list` shows them under the settings,
keyed `hosts.<name>`, with the layer each one came from. This section is the
configuration half; [hosts.md](hosts.md) is the rest.

```toml
defaultHost = "beast"

[hosts.beast]
kind = "ssh"
sshHost = "beast"

[hosts.agent-sandboxes]
kind = "ssh"
sshHost = "mike@10.0.0.7"
workspaceRoot = "/srv/werk/workspaces"
env = { EDITOR = "werk edit --wait" }
setup = "my-boxes"
```

| Key             | Kind  | What it is                                                    |
| --------------- | ----- | ------------------------------------------------------------- |
| `kind`          | both  | `local` or `ssh`                                              |
| `sshHost`       | `ssh` | An ssh destination, spelled as it would be typed after `ssh`  |
| `workspaceRoot` | both  | Where workspaces go on that host                              |
| `provider`      | both  | The name of whatever made the host. Recorded, not interpreted |
| `env`           | both  | Variables every session on that host is started with          |
| `setup`         | both  | The `[setup.<name>]` block that sets the host up              |

`env` is an overlay on whatever a session would have been started with, and it
wins over it. Six names are refused rather than ignored — `TERM`, `COLORTERM`,
`TERM_PROGRAM`, `TERM_PROGRAM_VERSION`, `WERK_SESSION` and `WERK_DAEMON` — because
the daemon writes those last for every session and a value here would be
discarded in silence. Write it as an inline table on one line: werk reads a
`[hosts.<name>.env]` sub-table but refuses to write over a block that has one.
[hosts.md](hosts.md#variables-for-every-session-on-a-host) has the rest.

`defaultHost` names one of them, and `--host` overrides it for one command.

`local` is a host werk has without being told, supplied by the defaults layer
like any other built-in value, so nothing special-cases the machine werk is
running on. Workspaces on it go under `<stateDir>/workspaces`, which is where
`werk create` already puts them.

werk stores an ssh destination and nothing else about the connection. ssh_config
already resolves the address, the user, the port, the identity, `ProxyJump`,
`Match` rules, multiplexing and the `known_hosts` policy, and re-expressing any
of that here would be a second, worse ssh_config that drifts from the real one
silently.

Two rules differ from the settings, and both follow from a host having no
default underneath it:

- **An unknown key inside a host block is refused.** Elsewhere werk ignores a
  key it does not know, because a typo costs a preference. Here `sshHosts` with
  the s in the wrong place would leave a block that looks configured and means
  nothing, and the cost of that is a machine.
- **A block replaces a block whole, and never field by field.** Merging a
  project file's `kind = "ssh"` over a user file's `kind = "local"` would compose
  a host neither file contains. `werk config sources` reports every block a
  stronger layer replaced, against the layer that lost it.

A block werk cannot read never stops it starting. `werk config list` shows the
row as `unreadable`, `werk config sources` says what is wrong and which file it
is in, and only a command that actually wants that host fails.

A block holds what somebody decided about the machine: what it is called, where
werk may put things, what every session on it is started with, and which block
sets it up. What werk found out about the machine is not in there. There is no
`werkPath` and no `shell`, and no probe result is stored: a fact about a machine
written into a file is a fact that was true once, and it goes stale silently
while `ssh beast` keeps working. `werk config check` asks the machine instead,
every time.

### Setting a machine or a workspace up

A `[setup.<name>]` table says what to put somewhere and what to run there. A
host block names one with `setup`, and the `workspaceSetup` setting names one
for a workspace that has just been made. `werk config list` shows them under the
hosts, keyed `setup.<name>`, with the layer each came from.

```toml
workspaceSetup = "bootstrap"

[setup.bootstrap]
run = ["bun install"]

[setup.my-boxes]
copy = "~/dotfiles/werk-host"
to = ".local/share/werk/setup"
run = ["~/.local/share/werk/setup/install.sh"]
rerunOnChange = true
```

| Key             | What it is                                                                  |
| --------------- | --------------------------------------------------------------------------- |
| `copy`          | The directory to send, on the machine werk is running on. `~/` is expanded. |
| `to`            | Where it lands: under `$HOME` there, or under the workspace                 |
| `run`           | The commands to run there, in order. Required.                              |
| `rerunOnChange` | Whether it is worth running again once what it copies has changed           |

`copy` and `to` are required together, `to` may not be absolute or contain
`..`, and an unknown key is refused the way it is in a host block. A block also
merges the way a host does: by name, never by field, with `werk config sources`
reporting one a stronger layer replaced.

A host's block runs on the machine, before anything is put on it; a
`workspaceSetup` runs in the workspace, after the worktree is checked out and
before the session starts. `werk create` runs both, and `werk setup` runs the
host's alone. The machine keeps a stamp of what was last run on it, so a second
run does nothing; a repository's own setup is asked about once and the answer is
recorded against the repository.
[hosts.md](hosts.md#setting-a-machine-up-and-setting-a-workspace-up) has the
whole of it: the stamp and the hint, the four outcomes, the trust prompt, and
what a failure is.

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

`werk daemon endpoint` is the pair to it: `info` says where werk keeps things,
and `endpoint` says what is listening, in the form something else could dial. It
prints the endpoint record — `{"kind":"unix","path":…}` or
`{"kind":"tcp","host":"127.0.0.1","port":…,"credential":…}` — the runtime and
state directories, the pid, the version the daemon reports and the build of the
werk that asked. Under `--json` the record is complete enough to connect with,
so a TCP endpoint's credential is in it; the human block leaves the credential
out, because a secret printed to a terminal ends up in a scrollback or a pasted
bug report.

`endpoint` never starts a daemon unless it is given `--ensure`. Without it, no
daemon listening is exit 7 and nothing is spawned.

`info`, `doctor` and completion never start a daemon either; they report what is
on disk plus whatever a daemon that is already listening says about itself.

### One version identity

`werk --version`, the string the CLI hands `serveSessionDaemon`, and therefore
`daemonInfo().version` are all one string. It is the package version, the git
short SHA the binary was built from, and a `-dirty` marker where the tree had
uncommitted changes: `0.0.0-a1b2c3d`, or `0.0.0-a1b2c3d-dirty`. `build.ts`
derives it and defines it into the compiled binary as `WERK_BUILD`, and nothing
generated is committed. An interpreted run reads the define through a `typeof`
guard and reports `0.0.0-source` instead, because a working tree is not an
artefact and inventing a build id for one would be a lie.

What we are currently trying to make this good for is one question: a client
that ships a werk binary to a machine asking whether the binary over there is
the one it would send. Answering that needs one identity rather than two. Treat
the comparison as a hint rather than a guarantee — nothing here is signed, and
two trees with the same SHA can differ in what was never committed.

The runtime directory defaults to `/tmp/werk-UID` on POSIX and
`%LOCALAPPDATA%\werk\run` on Windows. A Unix socket path is capped at 103 bytes,
so a deeply nested `--runtime-dir` fails to bind — short paths under `/tmp` are
what the tests use.

The compiled binary is built with `--no-compile-autoload-dotenv`. Bun otherwise
autoloads a `.env` from the working directory into `process.env`, and `create`
forwards nearly all of `process.env` to the daemon, so `werk create` inside any
repository holding a `.env` would ship that repository's secrets into every
session it started.
