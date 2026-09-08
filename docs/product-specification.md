# werk product specification

This is the current specification of what werk does.

It covers what a person can do with werk, what sharing and logging are for, and
what a company installs. It does not cover how any of it is built, beyond what
is already there. Almost nothing here is settled, and the words used are the
words we are thinking with rather than words anyone has committed to.

This file holds the vocabulary, the loop werk exists for, and what is already
true. The subjects have a document each in [`product/`](product/):
[the client](product/client.md), [landing](product/landing.md),
[sharing](product/sharing.md), [mappers](product/mappers.md) and
[the portal](product/portal.md). [Workspaces and git](workspaces-and-git.md)
works through the model the client's workspaces would sit on. The 24 questions
nobody has answered are in [open-questions.md](open-questions.md).

Several documents refer to **the earlier work**. That means the product
documents `docs/product/00-what-werk-is.md` through `04-open-questions.md` and
the research dossiers `docs/research/01-libghostty-vt.md` through
`13-landscape.md`, which this specification replaced. They were removed in
commit `42d3475` and any of them can still be read, for example with
`git show 42d3475^:docs/research/06-vocabulary.md`.

## Words used in these documents

| Word                  | What it means here                                                                                | Where it stands today                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **workspace**         | A named, isolated place for work: somewhere to run, a copy of the repository, its own branch.     | `werk create` makes one: a git worktree on this machine.                                                                                   |
| **terminal process**  | One long-lived process with a terminal, inside a workspace. A workspace holds several.            | The code calls this a session.                                                                                                             |
| **host**              | A machine a workspace runs on.                                                                    | Absent from the code.                                                                                                                      |
| **provider**          | Something that produces hosts on demand, such as Kubernetes, Docker, or a cloud VM API.           | Nothing produces hosts. See [question 1](open-questions.md#1-what-do-we-call-a-machine-and-what-do-we-call-the-thing-that-makes-machines). |
| **parent**            | The branch a workspace was created from, and the branch its changes go back to.                   | `create` records the checkout a workspace was branched from.                                                                               |
| **land**              | Get the changes made in a workspace onto its parent branch.                                       | Nothing lands anything yet. The route is meant to be configurable; see [Landing](product/landing.md).                                      |
| **mapper**            | A component that reports what a running process is doing, using more than its terminal output.    | Nothing reports this yet.                                                                                                                  |
| **daemon**            | The long-lived process on a host that owns the terminal processes. Shorthand `werkd`.             | One runs, started by `werk daemon serve`. The binary is `werk`.                                                                            |
| **portal**            | The thing a company installs to configure hosts, workspaces, terminals and agents for its people. | Nothing of it exists.                                                                                                                      |
| **transcript**        | The record of what happened in a terminal process, readable after the process has ended.          | Does not exist yet.                                                                                                                        |
| **containment graph** | Host, the workspaces on it, and the terminal processes in those workspaces.                       | Nothing computes it. See [Workspaces and git](workspaces-and-git.md).                                                                      |
| **derivation graph**  | Workspaces and the workspaces they were derived from, wherever those live.                        | Nothing computes it. See [Workspaces and git](workspaces-and-git.md).                                                                      |
| **workspace record**  | Whatever werk stores about a workspace: where it is, what it came from, what state it is in.      | Nothing is stored. See [question 19](open-questions.md#19-where-does-the-record-of-a-workspace-live).                                      |
| **log**               | The record of who did what to a shared terminal, kept for review.                                 | Does not exist yet.                                                                                                                        |
| **chrome**            | The status row werk paints on the bottom line of the terminal while an attachment holds it.       | `werk attach` paints one. See [cli.md](cli.md#the-chrome).                                                                                 |
| **output mode**       | Which shape a command's answer takes: text for a person, or one JSON value for a machine.         | Both are built; `--json` selects the second. See [cli.md](cli.md#two-output-modes).                                                        |

## What werk is

werk starts a process somewhere and lets you come back to it later.

You run a lot of long-lived, interactive, semi-autonomous processes, mostly
coding agents. Each one wants a terminal, runs for tens of minutes to hours,
wants its own copy of a repository on its own branch, and periodically wants your
attention. werk provisions somewhere for that work to happen, puts your code
there on a branch, gives you a terminal into it that survives your laptop
closing, and shows you every one of those, across every machine, in one list you
can open from a terminal or a browser.

## The core loop

This is what werk does most of the time, and everything else is secondary to it:

1. **Start an agent somewhere that is not your laptop.** A Mac mini in your
   house, a VPS, a Fly.io machine.
2. **Detach.** Close the laptop and walk away. The agent keeps running.
3. **Check on it, or be told it wants you.** Its status, and the status of every
   other one, in a single list.
4. **Reattach**, see what it did, and deal with it.

The rest of the specification is either a part of that loop or something built
on top of it. werk is three pieces:

| Part                              | What it is                                                                                    |
| --------------------------------- | --------------------------------------------------------------------------------------------- |
| **[Client](product/client.md)**   | What one person runs, and where the loop above lives.                                         |
| **[Sharing](product/sharing.md)** | Letting someone else see a terminal, live or after the fact.                                  |
| **[Portal](product/portal.md)**   | What a company runs. How hosts, workspaces, terminals and agents are configured for everyone. |

Two parts of the client are large enough to have a document each.
[Landing](product/landing.md) is how the work done in a workspace gets onto the
branch that workspace came from. [Mappers](product/mappers.md) are how werk
works out what a running process is doing.

## What exists today

The session libraries are built and working. Everything below is real, and it is
the foundation the rest of the specification sits on. Nothing else described in
these documents exists yet.

- A daemon owns the terminal processes. Its word for one is a **session**: an
  argv, a working directory, a size, and a state of `starting`, `running`,
  `exited`, `failed` or `lost`.
- A viewer of a session is an **attachment**, carrying a principal and separate
  read and input permissions. Several attachments can watch one session.
- The CLI (`packages/werk`) has `create`, `list`, `attach`, `logs`, `kill`,
  `remove`, `watch`, `info`, `doctor`, `config`, `completion` and
  `daemon serve`. Detach is `Ctrl-]`. See [cli.md](cli.md).
- `create` makes a **workspace** and starts the command in it: a git worktree on
  this machine, on a branch of its own, branched from the checkout the caller is
  standing in. That is the whole of what a workspace is today — one host, no
  record of what exists, and nothing that ends one. `@werk/workspace` owns it
  and is explicitly under development.
- Reattach restores the real screen, decoded from a checkpoint by the libghostty
  WASM engine. `examples/session-web` does the same in a browser.
- Checkpoints are written per session to the state directory. Records of ended
  sessions survive a daemon restart, up to 512 of them. Live processes do not:
  killing the daemon abruptly leaves a `lost` record with its last screen and no
  process.
- Everything is TypeScript. `bun:ffi` is used for `flock` and for Windows job
  objects, and PTYs come from Bun's own spawn support rather than a native
  addon. Terminal interpretation is libghostty compiled to WASM and shipped as
  an asset, `packages/terminal/assets/terminal.wasm`. Where else WASM would earn
  its place is not worked out; a real performance win, or an ecosystem with no
  good TypeScript equivalent, are probably the cases that would.

Four things this specification needs are absent today:

- git beyond making a worktree and a branch;
- anything remote: the transport is a Unix socket or loopback TCP;
- sharing as a product feature, which the protocol supports and nothing uses;
- a durable log.

What is on disk now is a bounded screen checkpoint, roughly 10 MB of scrollback
by default, which is not a record of everything a process printed.

## The questions nobody has answered

Twenty-four of them, in [open-questions.md](open-questions.md): what a machine
and a machine-maker are called, how a person configures hosts, where landing
runs, what a transcript is made of, what a mapper may read, where the record of
a workspace lives, and the rest. They are genuinely open, and where there is a
lean it is labelled as a lean.
