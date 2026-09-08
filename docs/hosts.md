# Hosts

A **host** is a machine werk can put work on.

```sh
werk create --host beast -- claude   # a workspace and a session on beast
werk attach --host beast             # go back to it
```

This document is the reference for how that works today, what has actually been
observed, and the long list of things it does not do.

Nothing here is settled. Every shape below is what is currently being tried
rather than what anybody decided, and the ssh half of it has been run against
exactly one pair of machines. [What has been
observed](#what-has-been-observed) is the account of the evidence.

## A host is a machine; a provider would be something that makes machines

A host is a machine that already exists, and somebody wrote it down because
they can reach it. That is the whole of it. werk does not create hosts, destroy
them, or know anything about how they came to exist.

A **provider** would be the thing that makes hosts on demand: incus,
Kubernetes, Docker, a cloud machine API. Nothing makes hosts today, and
_provider_ is a lean rather than a name anyone settled. [Question 1](open-questions.md#1-what-do-we-call-a-machine-and-what-do-we-call-the-thing-that-makes-machines)
carries that question and
[question 2](open-questions.md#2-how-does-a-person-configure-their-hosts-and-providers) carries
how one would be configured.

A host block takes a `provider` key, which is a string werk carries around and
nothing reads. It exists so that a person describing their own setup has
somewhere to write it, and so that the shape is there if a `[providers.<name>]`
table ever arrives. It is not a mechanism.

Where hosts and providers sit relative to workspaces and processes is the
containment graph in
[workspaces-and-git.md](workspaces-and-git.md#the-containment-graph). It is not
restated here.

## What exists today

`werk create` places a session on the machine `--host` names, or on the machine
`defaultHost` names when the flag is absent. Two kinds of host exist.

| Kind    | What it is                     | What a workspace on it is                                            |
| ------- | ------------------------------ | -------------------------------------------------------------------- |
| `local` | The machine werk is running on | A git worktree under `<stateDir>/workspaces`                         |
| `ssh`   | A machine reached with `ssh`   | A bare mirror pushed to, and a linked worktree checked out beside it |

`--host` is a global flag, so `create`, `list`, `attach`, `logs`, `kill`,
`remove` and `setup` all take it, and each of them acts on that one machine.
`werk config` has `list`, `get`, `set`, `unset`, `setup`, `check`, `sources` and
`path`.

werk cross-compiles the binary it sends to an ssh host, and it builds only for
Linux: `bun-linux-x64`, `bun-linux-arm64`, and the musl variant of each. A Mac
is refused, and so is anything else that is not covered by a named override. See
[installing itself](#installing-itself).

## Configuring a host

A host is a `[hosts.<name>]` table in `~/.werk/config.toml`, beside the
settings. A machine somebody wants to reach is something they know about their
own setup rather than something werk can discover, and the config file is
already where that kind of knowledge lives.

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

| Key             | Required       | What it is                                                           |
| --------------- | -------------- | -------------------------------------------------------------------- |
| `kind`          | yes            | `local` or `ssh`. It selects which other keys the block takes.       |
| `sshHost`       | yes, for `ssh` | An ssh destination, spelled exactly as it would be typed after `ssh` |
| `workspaceRoot` | no             | Where workspaces go on this machine                                  |
| `provider`      | no             | The name of whatever made this host. Recorded, never interpreted.    |
| `env`           | no             | Variables every session on this machine is started with              |
| `setup`         | no             | The `[setup.<name>]` block that sets this machine up                 |

A name is bare TOML: letters, digits, dots, dashes and underscores, starting
with a letter or a digit, up to 64 characters. No `@` and no `:`, because a
host name appears in the `name@host:/path` workspace reference and both of
those characters are already separators there. A `[setup.<name>]` block is
named by the same rule, so a name that works in one table works in the other.

`setup` is checked for spelling where the block is parsed and no further.
Whether anything defines a block by that name is a question about the whole
collection rather than about one value, and the block may be written in a file
the host block has never seen, so it is asked at the moment something is about
to run one. A name nothing answers is refused there, naming the host, the block
and the file the host came from.

`local` is supplied by the defaults layer, so it is an ordinary row with an
ordinary provenance and nothing has to special-case the machine werk is running
on. A file that writes its own `[hosts.local]` replaces it the way a file
replaces any other default. `defaultHost` is `local` unless something says
otherwise.

The layers a host can come from, and their precedence, are the same six layers
every setting uses: see [cli.md](cli.md#the-layers). Only the two file layers
and the built-in defaults carry hosts, because the environment rule is one
variable per scalar key and a table has no spelling in it.

### werk stores an ssh destination and nothing else about the connection

`sshHost` is an ssh_config `Host` alias, or `[user@]hostname`. The address, the
port, the user, the identity file, `ProxyJump`, `ProxyCommand`, `Match` rules,
connection multiplexing, keepalives and the `known_hosts` policy all stay in
ssh_config, where a person who can already reach the machine has written them.

Re-expressing any of that in `~/.werk/config.toml` would be a second, worse
ssh_config that goes stale silently: `ssh beast` would keep working while werk,
holding its own copy of a port that changed, would not. Whether that is the
right call is
[question 30](open-questions.md#30-does-werk-own-how-it-reaches-a-host-or-does-ssh),
and it is genuinely open. The cost of the current shape is that werk depends on
a file it does not own and has nothing to read on a machine where the alias is
absent.

### Variables for every session on a host

`env` is a table of variables every session werk starts on that machine gets.

```toml
[hosts.beast]
kind = "ssh"
sshHost = "beast"
env = { EDITOR = "werk edit --wait", CARGO_HOME = "/opt/cargo" }
```

It is an overlay rather than a whole environment. Whatever a session would have
been started with is still the base — the denylist on this machine, the
allowlist on another — and the block changes only the names it writes. It wins
over both, because both are guesses about names nobody named, and a block is
not a guess: somebody wrote it against that machine.

Six names are refused rather than accepted and ignored: `TERM`, `COLORTERM`,
`TERM_PROGRAM`, `TERM_PROGRAM_VERSION`, `WERK_SESSION` and `WERK_DAEMON`. The
daemon writes those for every session after everything a client sends, so a
value here would be thrown away on the far side without a word, and quietly
discarding what somebody wrote in a block is what the unknown-key rule exists to
prevent.

The daemon's limits on an environment are checked here too — at most 1024
variables, a name of at most 256 bytes, a value of at most 128 KiB, and at most
1 MiB in total — so a map it would refuse is refused by the file that carries
it, naming the file, rather than arriving later as a session that will not
start.

Write it as an inline table, on one line, as above. A `[hosts.<name>.env]`
sub-table reads fine, because TOML puts it in the same place, but werk will not
write over a block that has one: it replaces a block's text up to the next table
header, which would leave the sub-table stranded after the rewrite. `werk config
setup` refuses that rather than damaging the file, and says to edit it by hand.

### A block that cannot be read does not stop werk starting

An unknown key inside a host block is refused, which is the opposite of what
werk does everywhere else. A setting has a default underneath it, so ignoring a
typo costs a preference. A host has nothing underneath it, so `sshHosts =
"beast"` with the `s` in the wrong place would leave a block that looks
configured and means nothing, and the cost of that is a machine.

Refusing the block is not refusing to start. Parsing collects problems rather
than throwing, so `werk list` runs with a broken `[hosts.beast]` in the file and
only a command that actually wants `beast` fails.

```
$ werk config list
…
hosts.local      local               defaults
hosts.nowhere    ssh 198.51.100.7    user file
```

`werk config list` prints a `hosts.<name>` row per host with the layer it came
from. `werk config sources` names every layer, the file behind it, a block one
layer supplied that a stronger layer replaced outright, and a block that could
not be read at all.

`werk config set` and `werk config unset` write single top-level settings.
Neither writes host blocks; `werk config setup` does that.

## Setting a machine up, and setting a workspace up

A `[setup.<name>]` block says what to put on a machine and what to run there. A
host block points at one with `setup = "<name>"`, and the top-level
`workspaceSetup` points at one for a workspace that has just been made.

```toml
# ~/.werk/config.toml
[setup.my-boxes]
copy = "~/dotfiles/werk-host"     # a path on the machine werk runs on
to = ".local/share/werk/setup"    # relative to $HOME over there
run = [
  "claude plugin marketplace add claude-plugins-official",
  "~/.local/share/werk/setup/install.sh",
]
rerunOnChange = true
```

```toml
# <repository>/.werk/config.toml, so it travels with the repository
workspaceSetup = "bootstrap"

[setup.bootstrap]
run = ["bun install"]
```

| Key             | Required | What it is                                                                  |
| --------------- | -------- | --------------------------------------------------------------------------- |
| `copy`          | no       | The directory to send, on the machine werk is running on. `~/` is expanded. |
| `to`            | no       | Where it lands: under `$HOME` there, or under the workspace                 |
| `run`           | yes      | The commands to run there, in the order they are written                    |
| `rerunOnChange` | no       | Whether it is worth running again once what it copies has changed           |

`copy` and `to` go together: one without the other is refused naming both,
because half of that pair is either a path with nowhere to go or a place with
nothing to put in it. `copy` names a directory and its _contents_ land under
`to`, so `to` never gains a level named after the directory it came from. `to`
is refused if it starts with `/` or has a `..` in it, so what a block sends
stays under the directory it names. An unknown key
inside a block is refused, for the same reason it is inside a host block: a
block that looks configured and does nothing costs a machine somebody thinks is
set up. A block werk cannot read is a problem rather than a reason to stop, so
`werk config list` shows the `setup.<name>` row as `unreadable` and `werk config
sources` says what is wrong and which file it is in.

### The two phases

A host block's `setup` runs **on the machine**, before anything is put on it.
`workspaceSetup` runs **in the workspace**, after the worktree is checked out
and before the session starts, with the commands' working directory set to the
worktree and `to` relative to it rather than to `$HOME`.

`werk create` runs both. The host's setup starts as soon as the machine is
resolved and runs beside the `git push`, because getting the machine ready and
sending the history have nothing to say to each other; it is awaited before the
workspace's, which may want whatever it installed. `werk setup` runs the host's
alone, without making a workspace, starting a daemon or sending a binary.

The commands go over in **one invocation, under a login shell**, and stop at the
first one that fails. The login shell is the same call `werk daemon endpoint
--ensure` makes: on the machines werk is aimed at `claude` lives in
`~/.local/bin` and is on the login PATH and no other, and a setup script that
cannot find what it is configuring is worse than useless. Whatever `copy` names
is sent first, as a `tar` pipe carrying the directory's contents.

The environment the commands get is the one a session on that host would get:
the allowlist for another machine or the denylist for this one, with the host
block's own [`env`](#variables-for-every-session-on-a-host) over the top.

**A local host runs the same block**, with `sh -lc` in place of the ssh. There is
no second code path: a machine is reached through one seam, and the local answer
to that seam spawns a process here.

Everything the commands print goes to **stderr**, as it arrives. That keeps
`--json` one value on stdout with no special-casing, and it means a slow `bun
install` looks like a slow `bun install` rather than a hang.

### The stamp says what a machine already has

The machine keeps `~/.local/share/werk/setup/<block>/stamp`, holding a
fingerprint of the block that wrote it: sha256 over the commands in order, the
resolved `to`, and the bytes of everything `copy` names, shown as twelve hex
characters. It is written **last**, after every command has succeeded, so a run
that stopped part-way leaves no stamp and the next one runs again.

**The machine is the authority**, and that is the whole point of putting it
there. A second laptop that has never touched the machine reaches the same
answer as the first, without either of them knowing the other exists.

Beside it, `<stateDir>/hosts/<name>.setup.json` records what this client last
saw, so the ordinary case costs no round trip at all. It is a separate file from
`<stateDir>/hosts/<name>.json`, which holds [the warm path](#the-warm-path)'s
answers: that one is discarded whenever the client's build changes, and
upgrading werk must not re-run somebody's setup.

**Both files are caches.** Losing the hint costs a round trip; losing the stamp
costs the block being run again. Neither is a record of what werk knows about a
host, and neither is meant to grow into one —
[question 25](open-questions.md#25-what-does-werk-store-about-a-host-once-it-has-been-to-one)
is open and this does not answer it.

| Stamp                    | `rerunOnChange`   | What happens                                                                 |
| ------------------------ | ----------------- | ---------------------------------------------------------------------------- |
| absent                   | either            | Run. werk has not set this machine up before.                                |
| equal to the fingerprint | either            | Nothing, and no round trip where the hint already said so.                   |
| different                | `true`            | Run.                                                                         |
| different                | absent or `false` | Ask: "The setup for beast has changed since werk last ran it. Run it again?" |

With no terminal to ask in, that last row is **skipped with a note on stderr
naming `--yes`**, rather than refused. A refusal would fail an unattended `werk
create` over an edit to a config file, and werk already prefers a statement
where a prompt would break `--json`: the count of uncommitted files `create`
reports is the same call. Under `--json` the skip is a field in the record
rather than a line. `werk setup --force` runs the block whatever the stamp says.

### A repository's own setup is asked about once

`workspaceSetup` usually lives in the repository's `.werk/config.toml`, so it
travels with the branch. That makes it code from a branch, run automatically:
checking out a colleague's branch would otherwise run their commands as you,
before anybody had read them.

So werk asks, once per repository:

```
werk wants to run its own setup before the session starts:

    bun install

Run it? [y/N]
```

The answer is recorded in `<stateDir>/trust/<repo-id>.json`, against the
fingerprint that was trusted, so a change to the block asks again. `--yes`
answers it. With no terminal and no `--yes` the setup is **skipped with a note**
rather than run, which is the safe direction for this one.

It is keyed by the repository's
[`werk.repo-id`](#werkrepo-id-is-the-first-thing-werk-writes-into-a-users-repository)
and stored in werk's own state directory rather than in git's configuration.
That line is the only thing werk writes into a person's git config and it is
worth keeping true, and a decision about whether to run a branch's code is not
one to hand to whoever can push to the branch.

### What a failure is

| Where           | Code                     | What happens                                            |
| --------------- | ------------------------ | ------------------------------------------------------- |
| Host setup      | `HOST_SETUP_FAILED`      | `create` fails.                                         |
| Workspace setup | `WORKSPACE_SETUP_FAILED` | `create` fails, and the workspace is deliberately left. |

Both name the machine, the command that failed and what the far side printed,
and both exit 1. Which command failed comes from a trap the script sets for
itself: one invocation has one exit status, and a person told only that "the
setup failed" has to go and run each line by hand to find out which.

The workspace is left because the push happened and the branch is real work.
Destroying it to tidy up after a failed `bun install` would lose more than it
saved, and the message says so. Anything the push had already made when a _host_
setup fails is left for the same reason, since the two run beside each other.

### What is refused before anything is sent

A `copy` that is not there, a `copy` that is not a directory, and a symbolic
link inside one whose target points outside it are each refused by name. A link
out of the tree is named rather than dropped in silence, because a setup that
quietly sent half of what somebody meant would leave a machine looking
configured.

A `copy` of more than 2,000 entries or 32 MB is refused too, so a path pointed
at the wrong directory costs a message rather than a long transfer.

### What is not settled

Nothing prunes a stamp for a block that no longer exists, and nothing removes
what a setup put on a machine — that sits under
[question 27](open-questions.md#27-is-a-host-owned-or-borrowed-and-what-does-that-mean-for-cleanup).
Two host blocks naming one machine and one block set it up once, which is right
when they are the same machine and is
[question 28](open-questions.md#28-when-are-two-routes-to-the-same-machine-the-same-host)
when nothing can tell. Whether a workspace should get a stamp of its own so that
re-entering one does not re-run its setup is not worked out; a workspace is made
once today, so the question has not come up.

## The wizard

`werk config setup` walks through adding a host and ends by writing a
`[hosts.<name>]` block. A host is the one part of werk's configuration a person
cannot reasonably guess their way to, so this asks rather than assuming.

It reads `~/.ssh/config` and `/etc/ssh/ssh_config` and offers the machines
already written there. That reading is deliberately shallow: it collects the
literal `Host` patterns somebody typed, follows `Include` up to eight levels,
skips `Match` blocks whole, and skips any pattern containing `*`, `?` or a
leading `!`. A wildcard is not a machine anyone can connect to. The count of
what was skipped is reported, so a config that is all wildcards says "7 patterns
skipped as wildcards" rather than showing an empty list for no visible reason.

What an alias actually resolves to is settled by `ssh -G <destination>`, which
does the whole job correctly, connects to nothing, and costs about two
milliseconds. What `ssh -G` cannot do is enumerate, which is why the line
scanner exists at all.

The wizard shows the exact TOML it would add and only then writes it. It is
built to ask the machine about itself first and show what it found, and that
probe is not wired up for an ssh host yet, so today it asks nothing and says so
in as many words. The same gap affects `werk config check`; see
[what this does not do yet](#what-this-does-not-do-yet).

Whatever a probe finds is thrown away rather than stored. A host block holds
what the machine is called and where werk may put things, and everything else is
asked at the moment it is needed. `claude` being on a login shell's PATH today is
a fact about today. What werk should store about a machine it has been to is
[question 25](open-questions.md#25-what-does-werk-store-about-a-host-once-it-has-been-to-one).

The same command runs from flags alone, with no terminal:

```sh
werk config setup --host beast --ssh beast --default --yes
```

That is the form a dotfiles script uses, and it is the only form accepted when
there is no terminal to ask in. Where neither a flag nor a terminal can answer a
question, the command refuses and writes nothing.

### The writer keeps every byte it did not change

The config file is invited to be hand-edited, so the comments, the blank lines,
the key order, the indentation and the line endings in it are somebody's work.
Parsing the whole file and writing it back would throw all of that away, so the
writer splices instead. It edits whole `[hosts.<name>]` tables and single
top-level scalar lines, and never edits inside a table it did not write.

What makes a splicer safe is the last step. The writer parses the source,
applies the edit to the parsed value, splices the text, parses the text back,
and requires the two to be equal. A splice that lands anywhere unexpected comes
back as `CONFIG_WRITE_FAILED` before anything reaches the disk, and the person
is told to edit the file themselves. The failure mode of a gap in the splicer is
a refusal rather than a damaged file.

## Reaching a machine

Four steps, in this order, the first time werk touches a machine.

1. **Probe.** One round trip under a login shell asks the machine everything
   werk needs at once.
2. **Install.** If the werk over there is not the one this client would send,
   send it. See [installing itself](#installing-itself).
3. **Start a daemon.** `werk daemon endpoint --ensure --json`, run over there
   under a login shell. The far side says where it put its socket and starts a
   daemon in the same breath if none was running.
4. **Forward.** `ssh -N -L <local socket>:<remote socket>`, and then the
   ordinary session client speaks the ordinary protocol through it.

There is no second protocol. The socket on this machine is the daemon's socket
on that machine, so `@werk/session`'s client, wire and checkpoint decoding are
the same code locally and remotely. A socket forwarded over ssh is one of the
transports the client already accepts, alongside a Unix socket and a WebSocket;
[session-library.md](session-library.md) has that interface.

### The probe asks everything once

Ten fields, in a fixed order, between two markers. One round trip rather than
one question per fact, because at 50 ms of latency ten questions is half a
second of nothing happening, and the per-question shape gets worse every time
somebody adds a fact.

The fields are `uname -s`, `uname -m`, the C library, `$HOME`, `id -u`, where
`git` is, whether `rsync` is there, the login `PATH`, a Claude Code
configuration if there is one, and the version of any `werk` already on the
login PATH.

Three details in the script are worth knowing before changing it.

- **Lines, not JSON.** `sh` has no JSON escaper, and quoting a `$HOME` that
  contains a quote, a backslash or a newline is a bug nobody finds until the one
  person whose home directory has an apostrophe in it tries werk. One value per
  line has no escaping problem, and a field that grew a newline fails the field
  count rather than silently meaning something else.
- **Markers at both ends.** A login shell runs the person's profile, and
  profiles print things. Everything before the opening marker is discarded, so a
  banner costs nothing. The closing marker is separate: the last two fields can
  legitimately be empty, and without an end to measure against there is no way
  to tell an empty last field from a missing one.
- **musl is detected by looking for a file.** `ldd --version` means running the
  dynamic loader and parsing prose that differs between glibc, musl and every
  distribution's patched build, and musl's `ldd` writes its answer to stderr and
  exits 1. A machine that has an `ld-musl-*.so.1` loader under `/lib` or
  `/usr/lib` is a musl machine.

None of what the probe finds goes into a config file. A `werkPath` or a `shell`
written into one is a fact that was true once, and it goes stale silently while
`ssh beast` keeps working. What werk does keep between commands is where the
binary and the socket ended up, in its own state directory: see [the warm
path](#the-warm-path).

### The ssh options are in one place

Every ssh command line werk builds is built in one file, and nothing outside it
writes `-o`. An option set in two places drifts, and these options are the
difference between a command that fails in ten seconds and one that hangs
forever.

| Option                                            | What it buys                                                                    |
| ------------------------------------------------- | ------------------------------------------------------------------------------- |
| `BatchMode=yes`                                   | Never prompt. A password prompt on a stdin nothing is watching is a hang.       |
| `ConnectTimeout=10`                               | A bound on the part of the connection ssh would otherwise wait on indefinitely. |
| `ForwardAgent=no`                                 | werk does not need the caller's agent over there, so it does not ask for it.    |
| `ServerAliveInterval=15`, `ServerAliveCountMax=3` | A forward that has lost its network dies in about 45 seconds.                   |
| `ControlMaster=no`, `ControlPath=none`            | See below.                                                                      |

`ControlMaster=no -o ControlPath=none` go on unconditionally. A `~/.ssh/config`
that sets `ControlMaster=auto` is a common thing to have, and it would route
werk's connections through a shared master. A blackholed master hangs rather
than errors: ssh waits on a socket whose other end is gone, past
`ConnectTimeout`, which does not apply because no connection is being made. A
command-line `-o` beats the file, so passing both turns that into a failure werk
can bound.

`StrictHostKeyChecking` is not passed at all, deliberately. werk is talking to a
machine the person already has and has already accepted, and silently accepting
a new or changed key on their behalf is a larger claim than werk should be
making. Their setting stands. Under `BatchMode` an unknown key then fails, and
the message tells them to run `ssh <host>` once and accept it.

### The forwarded socket, and the failure it hides

The local end of the forward is `<runtimeDir>/h/<key>.sock`, where the key is
the first eight hex digits of `sha256(sshHost + "\0" + remoteSocket)`. The hash
is for length, not secrecy. A Unix socket path is capped at 103 usable bytes on
the platforms werk cares about, an ssh destination can be
`deploy@build-07.eu-west-1.internal.example.com`, and naming the file after
either would put the cap within reach of an ordinary setup. The length is
asserted before the bind, because a failure at `bind` says `EINVAL` and names
nothing.

The `h` directory is created 0700, because the local transport refuses to dial
through a parent that is anything else. The forwarded socket itself needs
nothing done to it: ssh creates it 0600 owned by the caller even under `umask
000`, so it passes the ownership and mode checks as it stands.

**`ExitOnForwardFailure=yes` catches a local bind that failed. It does not catch
the far end being absent.** ssh contacts the far end only when a client arrives,
so with nothing listening over there the forward comes up, `connect()` succeeds,
and the stream ends immediately. That is the commonest remote fault and the one
that lies most convincingly: left alone it reaches a person as "connection
closed", which sends them to look at the wrong machine.

So a forward is not considered up until a client has said hello through it, and
a connection that opens and closes without one is reported as
`HOST_DAEMON_MISSING`, naming the socket on the far side.

The invocation that made a forward kills it when it finishes. A leaked `ssh -N`
is a much worse failure than a slow `werk list`, and a forward that outlives its
maker needs supervising, which is the daemon's job, and the daemon is on the
wrong machine for it.

### No pty is carried beside the forward

An earlier reading held that a plain `ssh -N` leaves Nagle on and costs two
round trips per keystroke, and that a `-tt … sleep` session had to be carried
alongside the forward to get `TCP_NODELAY` set. It does not reproduce. On
OpenSSH 10.2p1 the `setsockopt` traces for the two are identical, and keystroke
latency at 51 ms round-trip time measured **52.4 ms for `-N` against 52.3 ms for
`-tt`**: indistinguishable.

That figure is one run against one pair of machines. `scripts/remote-smoke.ts`
is where it stays measured rather than assumed.

### A daemon started over ssh survives the ssh

The daemon is spawned with Bun's `detached: true`, which calls `setsid()`, so it
is in its own session before the ssh that started it exits. Nothing has to say
`nohup` or `setsid` on the command line. `scripts/remote-smoke.ts` checks this
by comparing the daemon's session id against its pid.

The `--ensure` command is run under a **login shell**. On the machines werk is
aimed at, `claude` lives in `~/.local/bin` and is on the login PATH and no
other, and a daemon started from a non-login shell would hand every session it
spawns a PATH that cannot find it.

### A session on another machine gets a narrow environment

`LANG`, the `LC_*` variables, `TZ`, `NO_COLOR` and `FORCE_COLOR`, and nothing
else. That is an allowlist, where a session on this machine gets a denylist, and
the inversion is deliberate. A denylist is a list of what somebody thought of,
and a name nobody thought of costs a credential when the destination is another
computer, where it lands in that machine's process table, its checkpoints and
its logs and cannot be taken back.

`PATH`, `HOME`, `SHELL`, `TMPDIR` and `SSH_AUTH_SOCK` stay behind for a second
reason: they would be wrong rather than merely surplus, because they name things
on the machine werk was typed on. The remote daemon's own environment supplies
its versions of them.

The allowlist bounds what leaves this machine on its own. A host block's
[`env`](#variables-for-every-session-on-a-host) is an explicit list rather than
a default, so it is sent as well and it wins: the names in it are ones somebody
wrote down against that machine, where everything the allowlist decides is werk
guessing about names it has never seen.

### Opening a file from a session on another machine

Somebody in a session on `beast` types `$EDITOR notes.md` and wants the editor
on the laptop in front of them to open it. `werk edit notes.md` is what is
being tried for that, and [cli.md](cli.md#opening-a-file-where-you-are-sitting)
is the reference for the command. What it forwards is a path: the session's
daemon relays `/srv/work/notes.md` to whoever is attached, and that client runs
`code --remote ssh-remote+beast /srv/work/notes.md` locally, so the editor
reaches the file over ssh itself and no file content crosses werk's wire. The
same message drives `zed ssh://beast/...` or a `jetbrains://` link; the client
decides.

**No `$EDITOR` string can do this, which is why it is a message rather than a
command.** The setup this is aimed at is Windows VS Code, driven from WSL, with
the session on a third machine, and two things stop a string spanning it:

- VS Code's remote `code` shim talks HTTP over a Unix socket named by
  `VSCODE_IPC_HOOK_CLI`. That socket is per-window, a new one is made every
  time a window reloads, and stale ones are never cleaned up. A werk session
  outlives the client that started it, so it can never hold a live handle to
  one.
- VS Code cannot chain remote authorities, so Windows client → WSL → a third
  machine has no VS Code path at all.

Forwarding the path sidesteps both: the session holds nothing, and the editor
makes one hop of its own to a machine it can reach. It also means werk needs
nothing on the session's side beyond a way to say "this file", which is what
makes `werk edit` a small command.

None of this is settled. It rests on the client having an ssh destination for
the machine that the editor can use as well, which is true when werk reached
the machine by an ssh_config alias and is not true of a host reached some other
way. It says nothing about a machine werk provisioned rather than one somebody
wrote down.

**Nothing has forwarded a path to a real editor on a real second machine.**
What has been run is the suite, on one machine: a session, a daemon, an
attached client and `cp` standing in for the editor. Every sentence above about
what VS Code does with what it is handed is reasoning rather than evidence.

Two pieces of the setup are not wired up. `EDITOR` has to be set inside the
session for a program there to reach `werk edit` at all, which is a job for the
session's environment rather than for this command — a per-host `env` map is
the likely place for it — and the two would compose without either knowing
about the other. And the binary werk installs on a host lives at
`~/.local/share/werk/bin/<target>-<stamp>/werk` and is on nobody's `PATH`, so
`werk edit` inside a session on that machine finds nothing to run unless a
person has put werk there themselves. Whether werk should put something on the
session's `PATH`, and what else would belong there if it did, is not worked out.

### The warm path

The cold path is four round trips and about a second of them at any real
latency. So where the binary and the socket ended up, and which client put them
there, is cached in `<stateDir>/hosts/<name>.json`, and a second command tries
the forward straight away: one round trip, and the hello through it proves the
whole chain still holds. Anything that does not hold falls
back to the cold path rather than failing, because a cache that has to be right
is a cache that breaks people's machines.

An interpreted werk never takes the warm path. Its identity is `0.0.0-source`
for every working tree, so a cache entry cannot say whether the binary over
there was built from the code in front of you, and whoever is running werk from
source is exactly the person who has just changed it.

### The Windows gap

Windows works in neither direction.

**A Windows host** is refused twice over. werk builds only Linux targets, so a
machine reporting anything else is refused with `HOST_UNSUPPORTED` before a
binary is sent. Even with a binary there, a daemon on Windows reports loopback
TCP with a credential rather than a Unix socket, and the forward refuses
anything that is not a Unix socket.

**A Windows client** cannot open the local end. Win32-OpenSSH does not support
Unix-domain socket forwarding, so `-L <local socket>:<remote socket>` has no
meaning there and a Windows client would need a loopback TCP landing on this
side. Nobody has run that against werk, because there is no Windows client path
to run.

The shape of the fix is written down and none of it is built: forward
`-L <local port>:127.0.0.1:<remote port>`, hand back a `tcp` endpoint carrying
the far side's credential, and pick a free local port on this side, because ssh
will not report the one it chose for `-L 0:`. The endpoint type already has both
shapes, so it is a change to the forwarding file rather than to the client.

[platforms.md](platforms.md) has the tiering this sits under.

## Installing itself

werk puts its own compiled binary on a machine, at
`~/.local/share/werk/bin/<target>-<stamp>/werk`, with a `stamp` file beside it.
The binary is about 92 MB.

The version is in the path rather than in a single `bin/werk`, so two clients of
different versions reaching the same machine coexist instead of overwriting each
other between one command and the next. Nothing prunes old ones. That probably
wants doing and nobody has worked out when.

### The match is exact, and that is what is being tried

The stamp has to equal this client's identity character for character. Not
semver, not "close enough". There is no protocol version for the two sides to
claim compatibility against, so the only question werk can honestly ask is
whether the binary over there is the one this client would send.

One identity answers it. `werk --version`, the string the CLI hands the daemon,
and therefore what the daemon reports, are all the same string: the package
version, the git short SHA, and `-dirty` when the tree had uncommitted changes.

```
$ werk --version
0.0.0-92faaf9
$ werk daemon endpoint --ensure --json
{"endpoint":{"kind":"unix","path":"/tmp/wj-rt/daemon.sock"},…,"version":"0.0.0-92faaf9","build":"0.0.0-92faaf9"}
```

Treat the comparison as a hint rather than a guarantee. Nothing is signed, and
nothing stops two trees with the same SHA differing in what was never committed.
How strict this should be is
[question 26](open-questions.md#26-what-has-to-match-between-a-client-and-the-daemon-it-ships-to-a-host),
and exact equality is the strictest of the three options there rather than the
agreed one. It costs a 92 MB transfer to every host on every client upgrade.

### Shipping on mismatch, which is neither always nor once

Shipping every time wastes 92 MB on every command. Shipping only when the
directory is missing leaves a half-transferred binary looking installed forever.
So the decision is read off the stamp, which can be different, missing, or
beside a binary that is not executable, and **the stamp is written last**, after
the binary is in place and executable. An interrupted transfer leaves no stamp,
and the next run ships again.

A compiled werk sends itself, which is the case that matters for a released
binary: it has no bun and no source, so it has nothing else to send. A werk run
interpreted builds one on demand, because refusing that outright would make the
remote path undevelopable. An interpreted client's identity is `0.0.0-source`
for every working tree, which would make the stamp match after the source had
changed, so a build-on-demand stamps the hash of the binary it actually
produced. A tree that has not changed hashes the same and sends nothing.

### What werk builds, and what it refuses

werk builds four targets: `bun-linux-x64`, `bun-linux-arm64`, and the musl
variant of each.

A musl build still links `libstdc++.so.6` and `libgcc_s.so.1`. A minimal Alpine
image has neither, and the binary then fails at load with a message about a
missing shared object. `apk add libstdc++` supplies both. werk carries that
caveat rather than refusing every musl machine, because plenty of them do have
those libraries and refusing them all would be wrong more often than it was
right.

**A Mac is refused with the reason attached.** bun will happily produce a
`bun-darwin-arm64` binary from Linux, and the result is unusable: a
cross-compiled Mach-O is unsigned, macOS kills an unsigned binary on arm64 with
SIGKILL as it starts, and there is no flag on the far side that turns that off.
Signing needs a certificate and Apple's tooling. So werk refuses rather than
shipping something that dies with no message at all. Whether werk should reach a
Mac some other way, through Homebrew, a downloaded release, or `bun install` on
the far side, is not worked out.

Platform detection is the recurring failure in every tool that installs itself
on a remote machine, which is why VS Code ships `remote.SSH.remotePlatform`.
werk takes an override from the start rather than after the first bug report,
and both `linux-x64` and `bun-linux-x64` are accepted spellings. There is
nowhere in a host block to write one today: a host block refuses a key it does
not know, and no `target` key has been added, so the override only arrives
through the programmatic interface. A `target = "bun-linux-x64"` key in
`[hosts.<name>]` is probably what it wants to be.

## Getting the code there

A workspace on an ssh host is two directories under the host's workspace root.

```
<workspaceRoot>/repos/<slot>.git/          bare: the push target and the shared object store
<workspaceRoot>/<slot>/<name>/             a linked worktree: where the session runs
```

`<workspaceRoot>` is the block's `workspaceRoot`, or, when the block does not
say, whatever `${XDG_STATE_HOME:-$HOME/.local/state}/werk/workspaces` resolves
to on that machine. It is asked of the machine rather than guessed at from this
one, because the answer depends on that machine's `$HOME` and its
`$XDG_STATE_HOME`, and a guess would be wrong on exactly the machines that are
set up unusually.

`<slot>` is the repository's directory name plus eight hex digits of a digest, so
a person browsing the root can tell what they are looking at and two checkouts of
the same project do not collide. What is digested is the repository's
[`werk.repo-id`](#werkrepo-id-is-the-first-thing-werk-writes-into-a-users-repository).

### The mirror is bare, so werk owns nothing on the far machine

Pushing a branch into a repository that has a working tree runs into
`receive.denyCurrentBranch`, whose ways out are `updateInstead` or a
`push-to-checkout` hook. Either is a piece of configuration or a script that
werk would then own on every machine it ever touches, forever. A bare repository
has no checked-out branch, so the rule never applies and there is nothing to
install.

The worktrees hang off it, one per workspace, sharing its object store.
`git worktree add --lock` marks each one as not to be pruned, because without
the lock a `git worktree prune`, run by a person tidying up or by git itself
noticing an unreachable path, can race a workspace somebody is working in.

### A push, not a bundle

A bundle looks like the obvious cold start: one file, no daemon, no protocol.
It is the wrong tool because **a bundle has no incremental negotiation**. It
always contains the full content of the refs it was asked for, so the second
workspace made from a repository would ship the entire history again, and the
tenth would ship it a tenth time. A push against a persistent mirror negotiates:
git works out what the far end already has and sends the difference.

The mirror is kept for exactly that reason. This is written down because
somebody reading that bundles are the recommended way to seed a repository over
a thin link will otherwise change it back.

The push is `HEAD:refs/heads/<name>` to a one-off URL, with no `-u` and no
`git remote add`, so werk leaves nothing in the user's `.git/config`. Never
`--force`: the branch was checked for, and anything that appeared since is
somebody else's work.

### Uncommitted work does not travel

Only committed history is pushed, so anything a person has not committed stays
on their machine. werk counts the files and says so once, through the progress
report, as a statement rather than a prompt. A prompt would break `--json`, and a
refusal would answer a question nobody has answered.

`git stash export` and `git stash import`, which arrived in git 2.51, look like
the obvious next step: they turn a stash into an object a push can carry and back
again, so the dirty tree could travel as a stash rather than not at all. That is
a lean and not a plan. Nobody has worked out whether a workspace should start
dirty, or what happens when the far end is older.

### `werk.repo-id` is the first thing werk writes into a user's repository

A local worktree digests the checkout's absolute path, which is a fact about one
computer. It cannot decide where anything lands on another machine, and moving
the checkout would strand every workspace already made from it. So a repository
gets a name of its own:

```sh
git config --local werk.repo-id <uuid>      # written once, read every time after
git config --unset werk.repo-id             # reverses it completely
```

One line, in `werk.`, which is git's sanctioned extension point for exactly
this. `--local` puts it in the common `.git/config`, so every worktree of the
repository agrees about which repository it is. It is the only thing werk writes
into a person's git configuration, and that is worth keeping true. Making a
worktree on this machine also writes git's own bookkeeping under
`.git/worktrees/`, which `git worktree remove` takes away again.

### Creation reports its stages, and rolls back what it made

Making a workspace over there is probe, prepare, push and check out, which is
not instant. `create` says which stage it is in: a spinner on a terminal, one line
per stage on stderr under `--no-input`, and nothing at all under `--json`,
because the machine register is one value on stdout. Ctrl-C during creation
aborts it and werk exits 130.

When something fails after the branch or the worktree exists, werk undoes what
it made, in reverse, best-effort and bounded at 15 seconds. **The mirror is
deliberately left.** Every workspace of that repository shares it, and removing
it because one creation failed would break the siblings. If clearing up does not
finish, that is reported as a note on the failure rather than as the failure.

### Failures name the machine the remedy is on

Six of the reasons a workspace cannot be made are about a computer the person
reading the message is not sitting at, and they are their own codes rather than
shades of one general failure, because the remedy is somewhere else:
`HOST_UNREACHABLE`, `HOST_AUTH_DENIED`, `HOST_UNSUPPORTED`,
`HOST_BOOTSTRAP_FAILED`, `REMOTE_GIT_MISSING` and `TRANSFER_FAILED`.

They are decided by giving the remote script a distinct numeric exit per
refusal, not by reading git's stderr, because that wording moves between git
versions and locales and the exit status of a refusal is not dependable either.

ssh's own failures are read differently, and the inconsistency is deliberate.
ssh spends 255 on every one of them, so there is nothing else to read, and the
strings have been in OpenSSH's sources unchanged for longer than most of the
tools that parse them. Anything unrecognised is reported as unreachable with
ssh's own text attached, so a string that does move gives a worse message rather
than a wrong one.

[cli.md](cli.md#exit-codes) has how these reach a script as exit statuses.

## What this does not do yet

Every item here is a real gap, not a simplification.

**There is no fleet view.** Each command talks to one daemon: this machine's
without `--host`, that machine's with it. `werk list` never shows both, and
nothing aggregates across machines today.

**Nothing records that a workspace exists.** A workspace with no session running
in it is invisible from every machine, including the one it is on. The only
thing that knows a workspace is there is the daemon holding a session in it.
Where that record should live is
[question 19](open-questions.md#19-where-does-the-record-of-a-workspace-live).

**An unreachable machine is invisible rather than marked unreachable.** There is
no row saying "beast did not answer". A command aimed at a machine that is
asleep fails after the timeout, and a machine nobody aimed a command at is not
mentioned at all. What this should look like is
[question 29](open-questions.md#29-what-does-a-workspace-on-an-unreachable-host-look-like).

**macOS hosts are refused.** See [what werk builds, and what it
refuses](#what-werk-builds-and-what-it-refuses).

**Windows is not reachable in either direction.** See [the Windows
gap](#the-windows-gap).

**Neither `werk config check` nor `werk config setup` can ask an ssh host
anything.**

```
$ werk config check
HOST     HOW               STATE        FOUND
local    local             answers      Linux x86_64; /home/mike/.local/state/w…
nowhere  ssh 198.51.100.7  not checked
```

The probe over ssh exists and `werk create --host` uses it. What the two `config`
commands have not been given is the transport, so they answer "unknown" to
everything for an ssh host rather than guessing, and `config setup` says as much
before it writes the block. It is wiring rather than a missing mechanism.

`not checked` and `no` are deliberately kept apart, so nothing here claims a
machine is unreachable when nobody asked it.

**Two entries can name one machine and nothing notices.** So can a host entry
and the machine werk is running on, the moment somebody adds their own desktop
by its ssh alias. That puts one set of workspaces under two roots of a graph
that is supposed to be a tree. See
[question 28](open-questions.md#28-when-are-two-routes-to-the-same-machine-the-same-host).

**Nothing prunes a setup's stamp, or takes back what a setup put there.** A
block renamed in a config file leaves its old stamp on every machine it ever ran
on, and whatever it installed stays installed. See [setting a machine up, and
setting a workspace up](#setting-a-machine-up-and-setting-a-workspace-up).

**Nothing removes werk from a machine.** werk leaves a binary, a daemon and a
directory of workspaces on every host it touches, and there is no command that
takes them off again. See
[question 27](open-questions.md#27-is-a-host-owned-or-borrowed-and-what-does-that-mean-for-cleanup).

**Old binaries are never pruned.** Every client version that reaches a machine
leaves 92 MB there permanently.

**The werk on a host is not on a session's `PATH`.** So `werk edit`, which is
meant to be run from inside a session, cannot be run from inside one on a
machine werk installed itself onto. See [opening a file from a session on
another machine](#opening-a-file-from-a-session-on-another-machine).

## What has been observed

**No CI lane has ever seen werk reach a second machine.** The lanes are
`native`, `musl`, `browser` and `soak`, and none of them has one. Everything
below that involves ssh was run by one person, on a LAN, between two Linux
boxes.

| What                                                                                                                                  | Where                                                                          | What it proves                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| The failure table, every git argv, the shape of the remote scripts                                                                    | `packages/workspace/test/ssh.test.ts`                                          | Against a scripted runner. No machine involved.                                                                |
| The scripts actually running: `git init --bare`, the numbered refusals, `worktree add --lock`, the rollback, a mirror pushed to twice | `packages/werk/test/loopback.test.ts`                                          | `sh -c` in a temporary `$HOME`, a filesystem push URL, a relay onto a local daemon socket. No network, no ssh. |
| A setup actually running: the script, the tar pipe, the stamp written and read back, a command that fails                             | `packages/werk/test/setup-run.test.ts`                                         | A real shell in a temporary `$HOME`. No network, no ssh.                                                       |
| Every command werk builds for a setup, and each row of the decision table                                                             | `packages/werk/test/host/setup.test.ts`                                        | Against a scripted runner. No machine involved.                                                                |
| ssh itself: the connection, its failures, the forward, the install, the daemon start, keystroke latency, a setup on a real `$HOME`    | `scripts/remote-smoke.ts`                                                      | A real second machine. Run by hand.                                                                            |
| Opening a file: the wire, the refusals, the argv splitting, and an attached client running an editor                                  | `packages/session-daemon/test/open.test.ts`, `packages/werk/test/edit.test.ts` | One machine, with `cp` standing in for the editor. No second machine and no editor.                            |

`scripts/remote-smoke.ts` is not part of `bun test`: it needs a box reachable
with key authentication and it starts processes there.

```sh
bun run build && bun scripts/remote-smoke.ts --host agent-sandboxes
```

Everything it creates on the far end lives under one directory named after the
run, and it removes that along with the daemons and the local forwards unless
`--keep` is passed.

The configuration half of this document, the failure table and the shape of the
remote scripts are covered by the ordinary suite and run on every lane. Every
claim about ssh itself, and every number, holds for one pair of machines on the
day it was measured and is untested everywhere else.

## The questions this raises

Each of these is open in [open-questions.md](open-questions.md), and none of
them is answered here.

- [Question 1: what do we call a machine, and what do we call the thing that makes machines?](open-questions.md#1-what-do-we-call-a-machine-and-what-do-we-call-the-thing-that-makes-machines)
- [Question 2: how does a person configure their hosts and providers?](open-questions.md#2-how-does-a-person-configure-their-hosts-and-providers)
- [Question 3: are a person's hosts shared between their own machines?](open-questions.md#3-are-a-persons-hosts-shared-between-their-own-machines)
- [Question 19: where does the record of a workspace live?](open-questions.md#19-where-does-the-record-of-a-workspace-live)
- [Question 24: what is the host component of a workspace reference?](open-questions.md#24-what-is-the-host-component-of-a-workspace-reference)
- [Question 25: what does werk store about a host once it has been to one?](open-questions.md#25-what-does-werk-store-about-a-host-once-it-has-been-to-one)
- [Question 26: what has to match between a client and the daemon it ships to a host?](open-questions.md#26-what-has-to-match-between-a-client-and-the-daemon-it-ships-to-a-host)
- [Question 27: is a host owned or borrowed, and what does that mean for cleanup?](open-questions.md#27-is-a-host-owned-or-borrowed-and-what-does-that-mean-for-cleanup)
- [Question 28: when are two routes to the same machine the same host?](open-questions.md#28-when-are-two-routes-to-the-same-machine-the-same-host)
- [Question 29: what does a workspace on an unreachable host look like?](open-questions.md#29-what-does-a-workspace-on-an-unreachable-host-look-like)
- [Question 30: does werk own how it reaches a host, or does ssh?](open-questions.md#30-does-werk-own-how-it-reaches-a-host-or-does-ssh)
