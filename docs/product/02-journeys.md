# 02 — Journeys

Worked user journeys, written as transcripts. Every command shown is
illustrative — the point is the _shape_ of the interaction and the decisions each
one forces into the open, not the exact spelling of the flags.

Each journey ends with **"what this forces us to decide"**, which feeds
[04-open-questions.md](04-open-questions.md).

---

## 1. The headline: fire and forget

The one from the pitch. You're in a repo, you want an agent working on something,
you don't want it on your machine.

```console
~/dev/api  main ✔
$ werk create

  ⠋ starting container (node:22 · localhost)          0.8s
  ⠋ installing werk on werk-affectionate-badgers      0.3s
  ⠋ seeding api (1.2 GiB, 41k objects)                3.4s
  ⠋ branch werk/affectionate-badgers-writing off main

  ✔ workspace 'affectionate-badgers-writing'
    container:local · /work/api · werk/affectionate-badgers-writing

root@affectionate-badgers:/work/api$ claude
╭──────────────────────────────────────╮
│ ✻ Welcome to Claude Code             │
╰──────────────────────────────────────╯
> port the billing module to the new schema
```

You watch for thirty seconds, decide it's on the right track, and hit the detach
key. You're back on your laptop, in `~/dev/api`, on `main`, working tree
untouched. The container keeps running.

**What this forces us to decide.** Whether `werk create` drops you into a shell
or straight into a command (`werk create --run claude`, or a project default);
what the container image is when you didn't say (a sane default vs. reading
`devcontainer.json` vs. refusing to guess); what the working directory is called
inside the container; and how loud the progress output is.

---

## 2. Coming back

Two hours later, from a different terminal, possibly a different room.

```console
$ werk

  REPO   WORKSPACE                      WHERE          STATUS
  api    affectionate-badgers-writing   docker:local   ◆ needs you   claude · 4m ago
                                                       "Should I keep the legacy adapter?"
  api    sleepy-otters-counting         ssh:bigbox     ● running     claude · 12s ago
  werk   brave-herons-planning          local          ○ idle        zsh · 2h ago
  —      scratch                        ssh:bigbox     ● running     tail -f · 3d

$ werk attach affectionate-badgers
# ↑ prefix match, because nobody types the whole name
```

You answer the question, detach again.

**What this forces us to decide.** The default sort (needs-you first, then recent
activity, is the obvious answer); how much preview text a row gets and where it
comes from; prefix/fuzzy matching rules and what happens on ambiguity; and
whether `werk` bare is `werk ls` or launches the interactive TUI. _(Suggestion:
bare `werk` prints the list and exits — reflexive, pipeable, fast. `werk ui`
opens the interactive one.)_

---

## 3. Landing the work

The agent is done. You want the commits.

```console
$ werk diff affectionate-badgers
  werk/affectionate-badgers-writing → main   6 commits, 23 files, +812 −340

  a3f21c9  port billing schema to v2
  ...

$ werk pull affectionate-badgers
  ✔ fetched werk/affectionate-badgers-writing into ~/dev/api

$ git log --oneline werk/affectionate-badgers-writing -1
a3f21c9 port billing schema to v2
```

The branch now exists in your local repo like any other branch. You review it,
merge it, or open a PR — with your own tools. werk does not have opinions about
what happens after the branch lands.

```console
$ werk rm affectionate-badgers
  ✔ stopped container, removed workspace
    branch werk/affectionate-badgers-writing kept in ~/dev/api
```

**What this forces us to decide.** Whether pulling is explicit or continuous;
whether `werk rm` keeps the branch (it should); what happens when work has _not_
been pulled (it must refuse, or require `--force`, and say exactly what would be
lost); whether werk ever pushes to your actual git remote, or only ever to your
local repo. _(Suggestion: never touch `origin`. werk moves commits between the
workspace and your local clone. Anything beyond that is your workflow.)_

---

## 4. Placing on a machine you already have

Same flow, different `--on`. No provisioning, no container, just a directory and
a daemon on a box.

```console
$ werk create --on bigbox
  ⠋ connecting bigbox                                  0.2s
  ⠋ installing werk 0.4.1 on bigbox (linux-x64)        1.1s   ← first time only
  ⠋ seeding api                                        2.1s
  ✔ workspace 'sleepy-otters-counting'
    ssh:bigbox · ~/.werk/workspaces/sleepy-otters-counting/api
```

`bigbox` is whatever your `~/.ssh/config` says it is — including a `ProxyJump`
through a bastion, a nonstandard port, a specific key. werk should not reinvent
ssh configuration; it should use yours.

**What this forces us to decide.** How much werk trusts `~/.ssh/config` versus
carrying its own host list; where werk installs itself on a borrowed machine and
whether it ever removes itself; what happens when the remote werk is a different
version from the local one; whether the daemon there starts on demand or persists.

---

## 5. Checking in from the browser

```console
$ werk serve
  ▸ http://127.0.0.1:7717   token: 4f2a…  (also copied to clipboard)
```

One page, every workspace across every machine, live terminals, click a row to
open it full-size. Same information architecture as the CLI list, because it's
the same fleet.

This is also the answer to "check on it from my phone", via Tailscale or an ssh
tunnel — deliberately _not_ by werk exposing itself to the internet. See
[`../research/05-control-surfaces.md`](../research/05-control-surfaces.md) §E;
the honest framing is that a web terminal is remote code execution by design and
the auth boundary is the entire security model.

**What this forces us to decide.** Whether the web server is part of the daemon
or a separate process (separate is better — it can crash freely and restart
without touching sessions); whether it aggregates remote machines itself or asks
the local daemon to; how many live terminals one page can carry before you need
static previews; and how far to go on the mobile layout.

---

## 6. No repository at all

```console
$ werk create --on bigbox --no-repo --name scratch --run 'tail -f /var/log/app.log'
  ✔ workspace 'scratch' · ssh:bigbox · ~
```

It appears in the list under a `—` project. It survives your laptop rebooting.
This has nothing to do with git or agents and it should be completely
unremarkable.

**What this forces us to decide.** Nothing much — which is the point. If this
feels bolted on, the model is wrong.

---

## 7. Staying local

Not everything needs a container.

```console
~/dev/werk  main ✔
$ werk create --on local
  ✔ workspace 'brave-herons-planning'
    local · ~/dev/.werk/brave-herons-planning · werk/brave-herons-planning (worktree)
```

A `git worktree`, so it shares the object store and costs nothing to make. Your
main checkout is untouched and stays on `main`. Two of these can run at once
without fighting.

**What this forces us to decide.** Where local worktrees live (inside the repo
and gitignored, a sibling directory, or a central `~/.werk/`); whether a local
workspace can also be `in-place` in the current directory with no branch at all
(it should — "just give me a persistent terminal here" is the simplest possible
use and the easiest on-ramp).

---

## 8. Fan-out

Three approaches to the same problem, in parallel, isolated from each other.

```console
$ werk create --run 'claude -p "try the adapter approach"'
$ werk create --run 'claude -p "try the codegen approach"'
$ werk create --run 'claude -p "try rewriting it by hand"'

$ werk
  REPO  WORKSPACE                     WHERE          STATUS
  api   affectionate-badgers-writing  docker:local   ● running   claude · 8s
  api   curious-pandas-building       docker:local   ● running   claude · 3s
  api   gentle-foxes-thinking         docker:local   ◆ needs you claude · 1m
```

Later, `werk diff` each and keep the one you like.

**What this forces us to decide.** Whether there's a first-class "compare these
workspaces" view or you just use git; resource limits so three containers don't
eat the machine; and whether `werk create` ×3 is ergonomic enough or there should
be a `-n 3` for it. _(Suggestion: don't build a fan-out primitive yet. See
whether people ask.)_

---

## 9. When it goes wrong

The journeys that actually determine whether people trust the tool.

**A host is asleep.**

```console
$ werk
  REPO  WORKSPACE                     WHERE          STATUS
  api   affectionate-badgers-writing  docker:local   ● running   claude · 8s
  api   sleepy-otters-counting        ssh:bigbox     ⚠ unreachable — bigbox last seen 2h ago

  1 placement unreachable: bigbox (connection refused)
```

The list still renders. The failure is one line, not a stack trace, and it does
not stop the command from succeeding.

**The host rebooted; the process is gone but the screen isn't.**

```console
$ werk attach sleepy-otters
  ⚠ this session's process exited when bigbox restarted (2h ago).
    showing restored scrollback — read only.
    'werk restart sleepy-otters' to run 'claude' again in this workspace.
```

Honest labelling of a read-only corpse. The scrollback is genuinely valuable —
you get to read what it said before it died — but pretending it's live would be a
betrayal.

**You try to destroy unreturned work.**

```console
$ werk rm curious-pandas
  ✘ refusing: 4 commits on werk/curious-pandas-building are not in ~/dev/api
      6f21a0c  extract the adapter interface
      …
    'werk pull curious-pandas' first, or 'werk rm --force' to discard.
```

**What this forces us to decide.** How aggressively werk polls placements to know
they're down (and whether an unreachable host makes `werk` slow — it must not);
whether snapshot-restore-after-reboot is a v1 feature; how werk knows what your
local repo has without a full fetch every time.

---

## 10. A machine werk has never seen

The fifth promise in action, and the journey most likely to be quietly terrible.

```console
$ werk create --on newbox
  ⠋ connecting newbox                                    0.3s
  ⠋ detecting platform … linux/arm64 (glibc)             0.2s
  ⠋ installing werk 0.4.1 → ~/.werk/bin/werk (48 MiB)    4.8s
  ⠋ starting werkd
  ✔ workspace 'quiet-lemurs-drawing'
```

Nothing was installed on `newbox` beforehand. No package manager was involved. No
`git`, no `node`, no `bun` — werk brought its own. The 48 MiB is the cost of that
promise and it is paid exactly once per machine per version.

**What this forces us to decide.** Whether the local binary carries every
platform's payload (huge) or fetches the right one from a release server (needs
network on one side or the other, and needs a story for air-gapped boxes);
whether werk verifies what it uploaded; what happens when `~/.werk` isn't
writable; whether the remote binary is ever garbage-collected. This is the
subject of [`../research/07-packaging.md`](../research/07-packaging.md) and
[`../research/09-remote-transport.md`](../research/09-remote-transport.md).

---

## 11. Upgrading

The daemon outlives the binary, and now it does so on six machines.

```console
$ werk upgrade
  local     0.4.1 → 0.5.0   ✔  3 sessions preserved
  bigbox    0.4.1 → 0.5.0   ✔  1 session preserved
  newbox    0.4.1 → 0.5.0   ✔
  buildbox  0.4.1 → —       ⚠ unreachable, will upgrade on next use
```

"Sessions preserved" across a daemon upgrade is a genuine differentiator that
the terminal-snapshot format makes possible (see
[`../research/01-libghostty-vt.md`](../research/01-libghostty-vt.md) and
[`../research/04-daemon-best-practices.md`](../research/04-daemon-best-practices.md)
§9), and it becomes much more valuable — and much more necessary — once there are
six daemons instead of one.

**What this forces us to decide.** Whether version skew between a local client
and a remote daemon is tolerated or forbidden; whether upgrades are automatic on
connect or explicit; and what "preserved" honestly means (the screen, certainly;
the process, only if the PTY fds survive the exec).
