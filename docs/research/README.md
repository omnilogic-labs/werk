# werk — research dossier

Pre-design research for `werk`: a tool that starts a process **somewhere** —
locally, on a machine you can ssh to, or in a container it provisions — puts your
repository there on a fresh branch, gives you a terminal that survives your
laptop closing, and shows you every one of those in one list.

**Nothing here is a design.** These are findings, prior art, and best practices
collected so that the design decisions we make next are informed ones. The
product scope those decisions serve is in [`../product/`](../product/).

## The primitive

| Doc                                                        | What's in it                                                                                          |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| [01-libghostty-vt.md](01-libghostty-vt.md)                 | What the library actually gives us. The snapshot API is the whole ballgame.                           |
| [02-language-choice.md](02-language-choice.md)             | TypeScript-on-Bun against Rust, Go and Zig, plus the libghostty binding landscape.                    |
| [03-prior-art.md](03-prior-art.md)                         | The terminal-multiplexer ancestry: zmx, hauntty, shpool, dtach, tmux, mosh, VibeTunnel, sshx, Zellij. |
| [04-daemon-best-practices.md](04-daemon-best-practices.md) | Ad-hoc daemons that nothing supervises. The core discipline, × N machines.                            |
| [05-control-surfaces.md](05-control-surfaces.md)           | The design space for CLI / web / SSH / programmatic control.                                          |
| [06-vocabulary.md](06-vocabulary.md)                       | Terms, escape sequences and libraries to be fluent in.                                                |

## Shipping it anywhere

| Doc                                              | What's in it                                                                                                                                       |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| [07-packaging.md](07-packaging.md)               | `bun build --compile`: cross-compilation, embedding binaries, `Bun.Terminal`, signing, self-update. And the honest comparison against Go and Rust. |
| [08-bundled-tooling.md](08-bundled-tooling.md)   | Shipping `git` and `ssh` inside the binary. dugite as the only template, GPLv2 obligations, and what breaks when you ignore the user's setup.      |
| [09-remote-transport.md](09-remote-transport.md) | Getting werk onto a machine it has never seen, and talking to it once it's there.                                                                  |

## Doing the work

| Doc                                                  | What's in it                                                                                                          |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| [10-git-workspaces.md](10-git-workspaces.md)         | Getting the repo there and the work back. Bundles, `stash export`, worktrees, naming, repo identity.                  |
| [11-interfaces.md](11-interfaces.md)                 | TUI, browser terminals, the web server, the desktop shell, notifications.                                             |
| [12-placement-backends.md](12-placement-backends.md) | Docker, dev containers, Claude Code's own sandbox tiers, the alternatives, and cloud sandboxes as pluggable backends. |
| [13-landscape.md](13-landscape.md)                   | Who else is building this. What's crowded, what's empty, what to steal, and what could make werk redundant.           |

---

## The one-paragraph version, per layer

**The primitive is solved and validated.** `libghostty-vt` ships a versioned
binary snapshot format (`GHOSTSNP`) that encodes and incrementally restores
complete terminal state — exactly what a detach/reattach multiplexer needs, and
what tmux never had. Several people are building on precisely this right now
(zmx in Zig, hauntty in Go, a cluster of 1–88★ projects on GitHub, at least one
framed explicitly as _"persistent, observable shell sessions for LLM agents"_),
and Ghostty upstream has said it is building reconnectable terminals on the
snapshot protocol itself. **That this many people are independently building the
same primitive is evidence the need is real and that the primitive is not the
differentiator.**

**Shipping it anywhere is harder than it looks and mostly solved.** Bun
cross-compiles eight targets from one Linux runner, embeds arbitrary assets
including other executables, and — since v1.3.5 — has a **native PTY API**,
which removes the scariest dependency from a TypeScript implementation.
opencode is a production existence proof at 46–63 MB. The costs are a 100–150 MB
binary once git and ssh are inside, and a **signing story that has broken three
separate times in 2026**. The transport question has an unusually clean answer:
**OpenSSH's `-L` accepts Unix socket paths on both ends**, so the remote daemon
binds an ordinary socket and the local client speaks its existing local protocol
over a forward — no remote protocol, no auth layer of our own.

**Doing the work has one genuinely novel opportunity.** `git stash export` /
`import` landed in git 2.51 as a documented interchange format for dirty working
trees; `gitfaq(7)` recommends it by name for exactly the question werk is asking;
**no competitor uses it.** Everything else in the git layer is well-trodden —
bundles stream over ssh, worktrees have known sharp edges, branch naming has
converged on `<tool>/<slug>`.

**The landscape says the gap is the fleet.** Local worktree-per-agent managers
are brutally crowded (40+ tools, and a growing casualty list — Terragon shut
down, Crystal discontinued, vibe-kanban's commercial layer sunsetting despite 28k
stars). Every vendor has a cloud agent product, and Claude Code's Agent view plus
`--cloud`/`--teleport`/`--remote-control` is the closest thing to werk that
exists. But **nobody has built a cross-machine fleet dashboard for terminal
sessions** — every tool in that space is single-host-native. That gap, plus
genuine agent-neutrality and backend-neutrality, is the whole differentiation.

## What to do first

Three spikes, in this order, because any one failing changes the plan:

1. **Does `Bun.Terminal` work inside `bun build --compile`?** Undocumented either
   way. Nothing else matters if it doesn't. [07 §4](07-packaging.md)
2. **Does `ssh -L local.sock:remote.sock` hold up under a live PTY stream?**
   Every citation is a request/response proxy; ours is many small latency-
   sensitive frames. [09 §0](09-remote-transport.md)
3. **Does a libghostty binding survive `--compile`**, and is the Node binding's
   snapshot API rich enough for two-stage reattach — or do we need a `bun:ffi`
   shim regardless? [02](02-language-choice.md), [07 §4](07-packaging.md)
