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

| Command                 | What it does                                                     |
| ----------------------- | ---------------------------------------------------------------- |
| `create -- COMMAND ...` | Start a session running a command, in a new workspace            |
| `list` (`ls`)           | List sessions                                                    |
| `attach [session]`      | Attach to a session; Ctrl-] detaches                             |
| `logs [session]`        | Print a session's retained screen, or its history                |
| `kill [session]`        | Ask a session's process to stop                                  |
| `remove` (`rm`)         | Remove a retained session record                                 |
| `watch`                 | Print daemon events as JSON lines until interrupted              |
| `info`                  | Print the resolved paths and what the daemon reports             |
| `doctor`                | Check the local daemon's health and show the log tail            |
| `config`                | `list`, `get <key>`, `sources`, `path`                           |
| `completion`            | `bash`, `zsh`, `fish` — print a shell completion script          |
| `daemon`                | `serve` — serve the daemon in this process until it is signalled |

One more is accepted and not listed. `complete` answers the shell completion
protocol and is a wire format rather than something a person types.

Help drills down: `werk --help` lists the commands, `werk config --help` lists
that command's subcommands, and `werk config get --help` describes one leaf.
Every node repeats the global flags under a **Global Options** heading, because
they are accepted after a command name as well as before it. Every command ends
its help with worked examples.

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
| `--json`               | Emit machine-readable JSON instead of text         |
| `--runtime-dir <PATH>` | Where the daemon socket and endpoint live          |
| `--state-dir <PATH>`   | Where checkpoints, logs and the daemon record live |
| `--log-level <LEVEL>`  | Daemon log level: `error`, `warn`, `info`, `debug` |
| `--no-input`           | Never prompt; fail instead of asking               |
| `-y`, `--yes`          | Answer yes to confirmations                        |
| `--color`              | Force colour output                                |
| `--no-color`           | Disable colour output                              |
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
a conflict the second time and a generated one is not.

The worktree goes under `$stateDir/workspaces`, in a directory per repository
named after the repository and the digest of its path, so two checkouts of the
same project do not collide. `--state-dir` and a `stateDir` in a config file
move them; there is no setting of their own.

Under `--json` the record carries a `workspace` object — `name`, `directory`
and `branch` — beside the session's own fields.

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

### Choosing a session

`attach`, `logs`, `kill` and `remove` take an optional `[session]`, which is an
id, a name, or an unambiguous prefix of either — so the name completion offered
and the name `create` printed both work as typed. An exact match wins over a
prefix, and a prefix matching more than one session names what it matched rather
than choosing. Given none,
and with a terminal to ask in, werk offers a searchable picker of live sessions,
most recently active first; the prompt paints on stderr so a piped record stays
clean, and it carries a two-minute deadline.

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
| 5    | `CONFLICT`, or a workspace name that is already taken                       |
| 6    | `LIMIT` — a cap was exceeded                                                |
| 7    | `TIMEOUT` or `CLOSED` — the daemon is not answering                         |
| 130  | Cancelled: SIGINT, or a prompt nobody answered                              |

3 through 7 are the error vocabulary of `@werk/session`, mapped rather than
judged, so "the session is gone" and "the daemon never answered" are different
answers to a script. 7 covers both timeout and a closed connection, which a
caller retries differently from a refusal the daemon actually gave.

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

Colour is decided once, from the environment and the raw argv, before parsing
begins — help is printed during the parse, so the decision has to exist by then.
The same gate governs help, command output and error messages.

In order:

1. `NO_COLOR` present and non-empty → off. **`NO_COLOR` beats `FORCE_COLOR`**,
   which is the NO_COLOR convention and the opposite of what Bun and chalk do
   between themselves.
2. `TERM=dumb` → off, even under `FORCE_COLOR`. A terminal saying it cannot
   render escapes is taken at its word.
3. `FORCE_COLOR` set → on unless it is empty, `0` or `false`.
4. Otherwise, on when stdout is a terminal.

`--no-color` and `--color` are read from the raw argv and override the
environment; `--no-color` wins over `--color`. Only tokens before `--` count:
after it, `--no-color` belongs to the child process.

Where colour is on, the depth comes from `COLORTERM` (`truecolor` or `24bit` →
truecolour), then from a `TERM` ending in `-256color`, and otherwise 16 colours.

## Configuration

`werk config` shows what werk thinks it has been told and who told it.

```sh
werk config list      # every setting, its value, and the layer it came from
werk config get logLevel
werk config sources   # every layer, and why an empty one is empty
werk config path      # the files werk reads, whether or not they exist
```

### The layers

Six, lowest precedence first. A later layer overrides an earlier one key by key,
and `config list` reports the winning layer for each key separately — a layered
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

An empty variable is treated as unset, so `WERK_LOG_LEVEL= werk list` gets the
layer below rather than a parse error. A key werk does not know is ignored
rather than refused, so a line the client has no meaning for does not stop it
starting. `WERK_CONFIG_DIR` moves the user layer's directory away from `~/.werk`,
which is what the tests use.

Only settings the CLI acts on appear in that table. A key invented for a feature
that does not exist yet reads back later as a decision somebody took.

Every command acts on the resolved configuration, so a `runtimeDir` set in
`~/.werk/config.toml` is the directory `werk info` reports and the one
`werk attach <TAB>` looks in. The colour gate is the exception: it is settled
from the environment and the argv before the layers are read, because help is
printed during parsing and has to be styled before an action could have loaded
anything.

Tab completion reads the layers too, on a budget of its own: it abandons them
after 50 ms and falls back to the flags, so a slow layer costs a less accurate
completion rather than a shell that has stopped responding.

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
explicit level and does the styling only.

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
