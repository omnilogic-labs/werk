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

## Three rings

werk is one product in three layers, each depending on the one inside it.

| Ring          | What it is                                                                    |
| ------------- | ----------------------------------------------------------------------------- |
| **Session**   | A persistent, detachable terminal holding a process tree.                     |
| **Workspace** | A _place_ for work: somewhere to run, a repo checkout, a branch, a lifecycle. |
| **Fleet**     | Every workspace on every machine, in one view, from anywhere.                 |

The session is the beating heart of it — a detachable terminal-session daemon
built on libghostty's snapshot format, and the subject of most of
[`../research/`](../research/). But two properties of the outer rings reshape
everything downstream:

1. **werk runs on machines you are not sitting at.** Which makes _getting werk
   onto those machines_ a product feature, not a packaging detail. Hence the fat
   self-contained binary, and hence the bootstrap-over-ssh problem.
2. **werk touches your git repository.** Which moves it from "a thing that holds
   your terminal" to "a thing that holds your work", and raises the stakes on
   never losing any of it.

## The promises

What werk appears to be for, as best it can currently be stated. Useful as
something to check an idea against — not a gate that rules things out.

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

### 6. Every coding agent, eventually

Coding agents are the motivating workload, and the ambition is to support all of
them — not one vendor well and the rest by accident. Claude Code, Codex, Gemini
CLI, Aider, and whatever ships next month.

They do not all have the same shape, so this arrives in stages:

- **CLI agents first.** They are already terminal processes, which is exactly
  the thing werk holds. A CLI agent works in a werk workspace on day one with no
  per-agent work at all.
- **Then the agents that live in editors.** VS Code, Cursor, Antigravity. The
  intent is a werk plugin for each — the agent runs in a werk workspace, with
  its own placement and its own branch, driven from the editor it lives in —
  rather than telling those users to go and use the CLI.

The floor under all of it is that werk works on **signals any well-behaved
terminal program emits** — bell, OSC 9/777, OSC 9;4, OSC 133 — so
`werk create --run 'npm run dev'` is as good a citizen as `werk create --run
claude` and a brand-new agent needs no werk release to be useful. How much
per-agent knowledge werk adds on top of that floor, and which editor
environments come in what order, are open — see
[04-open-questions.md](04-open-questions.md).

## Directions, none of them settled

Speculation, written down so that the absence of a feature doesn't read as a
closed door, and so there's something concrete to argue with later.

**More than one terminal on screen at once.** Not tmux-style panes — werk gives
you one terminal per session and a list of sessions, and your terminal emulator
arranges the windows. But a TUI that shows workspace status and live terminal
previews at the same time, and lets you tab or page through the active sessions,
is close to what you'd actually want, and is likely to get built. Where that
stops short of being a window manager is not worked out.

**Sharing and handoff.** Passing a workspace to a coworker, or two people
watching one run. Everything currently written assumes one human's fleet —
everything werk can reach, it reaches as _you_ — which is a convenient
simplifying assumption for the security model rather than a position anyone has
taken.

**Being the terminal you live in.** Depending on how you work, werk could end up
being where every terminal is, rather than something you open alongside the
emulator you like.

**Pull requests, and their CI.** werk deciding what to run, retrying failures and
managing dependencies between jobs is a CI system, and that's a different
product. But if a workspace opened a pull request, "is it green?" is part of
knowing what that workspace is doing and belongs near "does it need me?".
Reading CI status — and plausibly triggering runs — is a different thing from
being a CI system, and the line between them hasn't been drawn.

**Where the state lives.** What's written so far assumes your machines, your
containers, your ssh keys, your repository, with no werk cloud and the web UI
running against your own daemons. Sharing, handoff and a phone app all push
against that assumption, so it's an open question rather than a principle — see
[04-open-questions.md](04-open-questions.md).

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

How far back "modern" reaches is unexamined. The stated intent for bundled
tooling is the newest `git` with no back-compatibility for old versions (see
[`../research/08-bundled-tooling.md`](../research/08-bundled-tooling.md)); how
old an OS werk should still run on is a separate question and nobody has asked
it yet.

## Sequencing

Not a roadmap — a statement of what has to be true before the next thing is worth
building.

1. **Sessions that survive, locally.** The innermost ring. If reattach isn't
   perfect this product has no foundation.
2. **The fleet view.** `werk` with no arguments, and `werk serve`. Worth building
   before remote placement, because it is what makes even three local sessions
   better than three terminal tabs.
3. **Remote placement over ssh.** Existing machines first — no provisioning, no
   lifecycle, just "the daemon runs there too and the list spans both".
4. **Git workspaces.** Branch creation, seeding, and getting work back. Local
   worktrees first, since that exercises the whole model without the network.
5. **Container placement.** werk provisions the somewhere.
6. **Everything else.** Editor and IDE plugins, cloud sandboxes, desktop app,
   phone notifications, programmatic/MCP surface.

## Reading order

| Doc                                          | What's in it                                                                           |
| -------------------------------------------- | -------------------------------------------------------------------------------------- |
| **00-what-werk-is.md**                       | This. Scope, the promises, and the directions still open.                              |
| [01-object-model.md](01-object-model.md)     | The nouns: workspace, placement, session, project. What they mean and how they relate. |
| [02-journeys.md](02-journeys.md)             | Worked user journeys, written as transcripts.                                          |
| [03-surfaces.md](03-surfaces.md)             | CLI, TUI, web, notifications, programmatic. What each one is for.                      |
| [04-open-questions.md](04-open-questions.md) | Product decisions that are genuinely still open, with the options.                     |
| [../research/](../research/)                 | The findings that inform all of the above.                                             |
