# 00 — What werk is

> **Status:** product scope, deliberately written before any design. It describes
> _what werk does_, not how. Where a "how" is unavoidable it is marked as an
> assumption, and every such assumption is still pliable.

## The one-sentence version

**werk starts a process somewhere and lets you come back to it later.**

## The one-paragraph version

You are running a lot of long-lived, interactive, semi-autonomous processes —
mostly coding agents. Each one wants a terminal, wants to run for tens of
minutes to hours, wants its own copy of a repository on its own branch, and
periodically wants your attention. Today you get one of those things from
`tmux`, one from `git worktree`, one from ssh'ing to a box and hoping, and none
of them from each other. werk is the single tool for all of it: it provisions
somewhere for the work to happen, puts your code there on a fresh branch, gives
you a terminal into it that survives your laptop closing, and then shows you
every one of those — local, remote, containerised — in one list you can open
from a terminal or a browser.

## The headline interaction

```console
$ werk create
  Created new workspace 'affectionate-badgers-writing'
  · container on localhost (docker)
  · branch werk/affectionate-badgers-writing off main
  · 1.2 GiB repository seeded in 3.4s
# a terminal takes over here — you are inside the workspace

$ claude
> refactor the billing module
# ... ctrl-\ ...

$ werk
  REPO         WORKSPACE                       WHERE            STATUS
  werk         affectionate-badgers-writing    docker:local     ● running    claude · 4m
  werk         sleepy-otters-counting          ssh:bigbox       ◆ needs you  claude · asked a question
  api          brave-herons-planning           local            ○ idle       zsh · 2h
  —            scratch                         ssh:bigbox       ● running    tail -f · 3d
```

Same list, live, in a browser via `werk serve`. Click any row, get the terminal.

## What changed from the original scope

The first pass at this project (see [`../research/`](../research/)) framed werk as
a **detachable terminal-session daemon** — a better tmux, built on libghostty's
snapshot format. That is still the beating heart of it, and none of that research
is wasted. But it described only the innermost layer. The scope is now three
concentric rings:

| Ring          | What it is                                                                    | Covered by original research?                          |
| ------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------ |
| **Session**   | A persistent, detachable terminal holding a process tree.                     | Yes, thoroughly.                                       |
| **Workspace** | A _place_ for work: somewhere to run, a repo checkout, a branch, a lifecycle. | No. New.                                               |
| **Fleet**     | Every workspace on every machine, in one view, from anywhere.                 | Partially — the web surface was scoped to one machine. |

The two consequences that reshape everything downstream:

1. **werk runs on machines you are not sitting at.** Which makes _getting werk
   onto those machines_ a product feature, not a packaging detail. Hence the fat
   self-contained binary, and hence the bootstrap-over-ssh problem.
2. **werk touches your git repository.** Which moves it from "a thing that holds
   your terminal" to "a thing that holds your work", and raises the stakes on
   never losing any of it.

## The five promises

Everything werk does should be justifiable as serving one of these. If a feature
serves none of them, it is out of scope.

### 1. The process outlives the connection

Close the laptop, lose the wifi, reboot the router, walk to a different building.
The process keeps running and the screen is exactly as you left it — not
"whatever the program happens to redraw", but the real terminal state, scrollback
included. This is the promise the original research is entirely about, and it is
the one that must never regress.

### 2. Where it runs is a choice, not an architecture

The same command, the same UI, the same behaviour, whether the work happens:

- **locally**, in your repo or a worktree of it,
- on an **existing remote machine** you have ssh access to,
- in a **container werk creates for you**, on your machine or on a remote docker
  host,
- (later) in a **cloud sandbox** from a provider.

Placement is a _parameter_. You should be able to change your default placement
in config and have every subsequent `werk create` land somewhere else without
changing a single habit. And you should be able to move down the list — start
local, get serious, move it to a big box — without re-learning the tool.

### 3. Your repository comes with you, and the work comes back

werk creates the branch. werk gets the code there. werk gets the commits back.
You never manually `git remote add` a container.

Crucially: **the work coming back is non-negotiable.** A container that is
destroyed with unpushed commits in it is a catastrophic bug, not an edge case.
The design must make losing work require deliberate effort.

Equally: **git is optional.** Free-floating workspaces with no repository are
first-class. `werk create --no-repo` for a scratch box, or werk in a directory
that simply isn't a repo. The repo/branch organisation is a strong default, not
a requirement.

### 4. One view of everything, from anywhere

A single list, spanning every machine, that answers the only two questions you
actually have:

- **Which of these needs me?**
- **What is that one doing right now?**

Available as a terminal UI and as a web page you open on your own machine.
Neither is a second-class port of the other.

### 5. Nothing to install, anywhere

One binary. No runtime, no package manager, no `git` on the remote, no `ssh` on
the remote path, no Node, no Bun. You copy one file to a machine and werk works
there. Ideally you don't even do the copying — werk does, over the ssh
connection it already has.

This is a _product_ promise, not an engineering vanity. The whole value of
"placement is a parameter" evaporates if using a new machine means a twenty
minute setup ritual.

## What werk is not

Stating these plainly, because each one is a real temptation.

**Not a window manager.** No panes, no splits, no tabs, no layouts. zmx, shpool
and abduco all reached the same conclusion and it is correct: managing terminals
on your screen is your terminal emulator's job, and doing it ourselves means
breaking native scrollback and copy/paste. werk gives you _one_ terminal per
session and a _list_ of sessions. Your window manager arranges them.

**Not in the middle of the stream.** tmux's structural mistake is that it sits
between the program and your terminal, so both tmux and your terminal have to
support every terminal feature forever. werk observes the stream to be able to
rehydrate it; it does not gate it.

**Not an agent harness.** werk does not know what `claude` is. It runs
processes. Coding agents are the motivating workload and werk should be
_excellent_ at them — surfacing "this one is waiting on you" is a headline
feature — but that is achieved by reading signals any well-behaved terminal
program emits, not by special-casing a vendor. `werk create --run 'npm run dev'`
must be as good a citizen as `werk create --run claude`.

**Not a CI system, not a scheduler, not a queue.** werk starts things you asked
it to start and shows you what they're doing. It does not decide what to run,
retry failures, or manage dependencies between jobs.

**Not a hosted service.** There is no werk cloud. It is your machines, your
containers, your ssh keys, your repository. The web UI runs on your machine
against your daemons. (Cloud sandbox providers as a _placement backend_ is a
different thing, and is on the table — that's still your account and your bill.)

**Not multi-user, not a collaboration tool.** One human's fleet. Everything werk
can reach, it can reach as _you_. This constrains the security model
enormously and simplifies it accordingly. Shared/observable sessions are a
plausible later product; they are not this one.

**Not a replacement for the terminal emulator you like.** Ghostty, WezTerm,
iTerm2, Windows Terminal — werk runs inside whatever you use.

## Platform scope

Modern **Windows, macOS and Linux**, as a _client_. Not "Linux with a Windows
port later" — Windows is a first-class client from the start, which materially
constrains the technology choices (see
[`../research/07-packaging.md`](../research/07-packaging.md) and
[`../research/09-remote-transport.md`](../research/09-remote-transport.md)).

Whether Windows is a first-class _host_ — can werk place a workspace on a Windows
machine and run processes there — is an open question. The pragmatic answer is
probably "Windows clients place work in WSL2 or a container", and the aggressive
answer is "ConPTY works, do it properly". Flagged in
[`04-open-questions.md`](04-open-questions.md).

"Modern" is doing deliberate work in that sentence. The team's stated posture is
to pin the newest `git` and not carry compatibility for old versions; the same
posture applies to OS versions. We are not supporting CentOS 7.

## Sequencing

Not a roadmap — a statement of what has to be true before the next thing is worth
building.

1. **Sessions that survive, locally.** The original scope. If reattach isn't
   perfect this product has no foundation.
2. **The fleet view.** `werk` with no arguments, and `werk serve`. Worth building
   before remote placement, because it is what makes even three local sessions
   better than three terminal tabs.
3. **Remote placement over ssh.** Existing machines first — no provisioning, no
   lifecycle, just "the daemon runs there too and the list spans both".
4. **Git workspaces.** Branch creation, seeding, and getting work back. Local
   worktrees first, since that exercises the whole model without the network.
5. **Container placement.** werk provisions the somewhere.
6. **Everything else.** Cloud sandboxes, desktop app, phone notifications,
   programmatic/MCP surface.

## Reading order

| Doc                                          | What's in it                                                                           |
| -------------------------------------------- | -------------------------------------------------------------------------------------- |
| **00-what-werk-is.md**                       | This. Scope, promises, non-goals.                                                      |
| [01-object-model.md](01-object-model.md)     | The nouns: workspace, placement, session, project. What they mean and how they relate. |
| [02-journeys.md](02-journeys.md)             | Worked user journeys, written as transcripts.                                          |
| [03-surfaces.md](03-surfaces.md)             | CLI, TUI, web, notifications, programmatic. What each one is for.                      |
| [04-open-questions.md](04-open-questions.md) | Product decisions that are genuinely still open, with the options.                     |
| [../research/](../research/)                 | The findings that inform all of the above.                                             |
