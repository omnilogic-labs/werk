# 04 — Open questions

Product decisions that are genuinely still open, with the options and a lean
where there is one. Ordered by how much downstream design each one blocks.

Purely technical open questions live at the end of each research doc; these are
the ones where the answer changes _what werk is_, not how it's built.

---

## The four that block everything else

### 1. Whose fleet is it?

Is the fleet **"workspaces this laptop created"** or **"workspaces you own,
discoverable from any of your machines"**?

|                           | Laptop-scoped                                                       | User-scoped                                              |
| ------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------- |
| Implementation            | A local record of every placement werk has used                     | Discovery on every known host, or shared state somewhere |
| `werk` on a second laptop | Empty                                                               | Shows everything                                         |
| Failure mode              | Lose the laptop, lose the index (though the workspaces still exist) | Needs an answer to "where does the index live"           |

The second is much better and much harder. It also smuggles in the question
[`00-what-werk-is.md`](00-what-werk-is.md) leaves open: **is there any werk state
that isn't on one of your machines?** A hosted index would be the first piece of
it, and sharing, handoff and a phone app all want one too.

**Lean:** laptop-scoped index, but with **discovery as a first-class recovery
path** — `werk hosts add bigbox` scans that machine and re-adopts everything werk
finds there. That gets most of the second option's value without any shared
state, and it also fixes "I reinstalled" and "my index is stale".

### 2. Does werk carry uncommitted work by default?

The user's working tree is nearly always dirty. `werk create` either brings it or
doesn't.

- **Bring it.** What people expect; makes the tool feel magical; matches "your
  repository comes with you". Risks silently committing things — `.env` files,
  half-finished experiments, a debugger left in — into a branch that later gets
  merged.
- **Don't.** Predictable and safe. Makes the first experience worse: your agent
  starts from a state that isn't the one you were looking at, and you won't
  realise until it's confused.
- **Bring it, visibly.** Carry the dirty tree, say exactly what was carried, and
  keep it recoverable and separable from the agent's own commits.

**Lean:** the third. The mechanism matters here and is covered in
[`../research/10-git-workspaces.md`](../research/10-git-workspaces.md) —
`git stash create` producing a real commit object that can be pushed and applied
is the most promising route, because it neither pollutes history nor loses
anything.

Separately and just as important: **`.gitignore`d files that the app needs to
run.** An agent in a container that can't start the dev server because there's no
`.env` has wasted your time entirely. Options: an explicit `werk.toml` copy-list;
a prompt on first use per repo; copy nothing and let the user find out. Leaning
toward an explicit list with a good default and a loud first-run message.

### 3. Does werk ever touch `origin`?

Two coherent positions:

- **Never.** werk moves commits between the workspace and your local clone. What
  happens after that is your workflow — your PR tooling, your review habits, your
  CI. Smaller surface, no credentials needed for the remote, no surprises.
- **Optionally.** `werk pr <name>` opens a pull request. It's obviously useful,
  every competitor does it, and it's where the workflow actually ends.

**Lean: never, in v1** — and then reconsider, because the whole competitive set in
[`../research/13-landscape.md`](../research/13-landscape.md) treats "PR out" as
the finish line, and being the only tool that stops one step short may read as
incomplete rather than principled.

The strong argument for stopping short: pushing to `origin` from a container
running an autonomous agent needs credentials in that container, and
[`../research/12-placement-backends.md`](../research/12-placement-backends.md) §5
is fairly bleak about how to do that safely.

### 4. Is Windows a host, or only a client?

Windows is a first-class **client** — settled. Whether werk can _place_ a
workspace on a Windows machine and run processes there is not.

|                 | Cost                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Client only** | Windows users place work in WSL2 or a container. Honest, much less work, and matches where the tooling actually is — Claude Code's own sandbox supports WSL2 and **not** native Windows                                                                                                                                                                                                                      |
| **Host too**    | ConPTY works, but: `Bun.Terminal` on Windows re-encodes output rather than passing bytes through (a session does not open with the prologue Linux produces); every `proc.kill(signal)` is `TerminateProcess`, so graceful teardown must go through the protocol; ConPTY round-trips in about 15 ms against under 0.1 ms on Linux; and WSL2 itself has **no guarantee for unattended long-running processes** |

Details in [`../research/07-packaging.md`](../research/07-packaging.md) §6 and
[`../research/12-placement-backends.md`](../research/12-placement-backends.md) §4.

**Lean:** client-first, WSL2 as the documented Windows placement, native Windows
hosting explicitly out of scope for v1 and stated as such. But note the WSL2
teardown problem is a real risk to the first promise and needs its own answer.
The measurements in
[`../proposals/01-cross-platform.md`](../proposals/01-cross-platform.md) §3
bound the cost of the host-too row without changing the lean.

---

## Shape and ergonomics

### 5. What does bare `werk` do?

Print the fleet and exit, or open the TUI?

**Lean: print and exit.** It's the most-executed command in the product; it
should feel like `ls`. Reflexive, pipeable, fast. `werk ui` opens the interactive
one. The counter-argument — that a beautiful TUI on bare invocation is a better
first impression — is real but serves the demo, not the daily user.

### 6. Does `werk create` drop you into a shell, or into a command?

The pitch shows a shell. But the actual thing you always do next is run an agent,
and `werk create --run claude` typed forty times is friction.

Options: a shell by default with `--run`; a per-project default command in
config; `werk claude` as the ergonomic front door with `werk create` as the
explicit one.

**Lean:** all three — `werk claude` for the common case, `werk create` for a
shell, and a project default that makes bare `werk create` do the right thing per
repo.

### 7. Does `werk claude` reattach or create?

If a workspace already exists for this repo and command, does `werk claude`
resume it or make a new one? cwd-keyed reattach is very pleasant for agent work
("`werk claude` in this repo always gets me back") and surprising the moment you
actually wanted two.

**Lean:** create is the default, because werk's whole model is that workspaces are
cheap and plural. `werk attach` is one word. But this needs a real decision, not
a default that leaks out of the implementation.

### 8. Where do local worktrees live?

Inside the repo and gitignored, a sibling directory, or a central `~/.werk/`?

Inside the repo is discoverable but pollutes the tree and confuses tooling that
walks it (including agents). Central is clean but makes the files harder to find
by hand.

**Lean:** central, with `werk ls --paths` and `werk info` making them findable.

### 9. Read-only or writable by default for extra viewers?

Multiple clients can attach. Should the second one be able to type?

**Lean:** first writable, subsequent read-only, with an explicit takeover. "Watch
what the agent is doing" is a core use case and two people typing into one agent
is nobody's intent. The UI must show how many are attached either way.

---

## Scope

### 10. Is there a fan-out primitive?

**Fan-out** here means one command that starts several workspaces on the same
task at once — the same prompt handed to three agents, or to the same agent
three times, so you can pick the best result. `uzi` spells it
`--agents claude:3,codex:2`.

[`../product/02-journeys.md`](../product/02-journeys.md) §8 shows the manual
version: three `werk create` calls. The primitive is a small amount of sugar on
top of that, and probably wanted — but it drags things in behind it. Once you
have run the same task five ways you need a way to compare the five results,
which is a review surface (§11). You also need a policy for how much of the
machine one command is allowed to consume.

Open: whether fan-out is just the sugar, or the sugar plus the comparison view
plus resource limits — and whether it ships before or after the review surface
it implies.

### 11. What does the diff/review surface look like?

Every competitor has one. Conductor, Kiro's three-pane, vibe-kanban all treat
"review is the bottleneck, not generation" as the thesis, and that thesis looks
right — a fleet of agents producing branches faster than you can read them makes
review _the_ constraint, so werk shipping its own review surface is likely.

The question is what it is, not whether:

- **A summary.** `werk diff <name>` says what changed and how much. Enough to
  triage which workspace to look at first, no reading.
- **A real review UI**, in the TUI and the web surface: side-by-side diffs,
  per-file navigation, comments, approve-and-merge.
- **Both, and a handoff.** The summary in the list, the full review in the web
  UI, and `werk pull` still there for the times you'd rather read it in the
  editor you already like.

The risk worth naming: [`../research/13-landscape.md`](../research/13-landscape.md)
is full of session managers that became bad IDEs. Shipping a diff viewer worse
than the one the user already has is the failure mode to design against — not a
reason to skip it.

### 12. What is the phone story?

"Check on it from anywhere" is most of the pitch, and the phone is where
"anywhere" actually happens. Three shapes, not mutually exclusive:

- **The responsive web UI plus notifications.** Free — it's the same `werk serve`
  page. No app store, no second client to maintain, and it works today for
  anything with a browser.
- **A werk app.** Real push notifications without a browser permission dance,
  proper background behaviour, and a UI built for a phone rather than
  reflowed onto one.
- **Someone else's app.** Claude and Codex both have mobile clients that already
  handle their own agent; werk's job could be getting the agent running in the
  right workspace and letting the vendor's app be the phone surface for it.

Prior art: Happy Coder has 23.6k stars for "monitor your local Claude session
from your phone and unblock it", so the demand is demonstrated and the bar for a
werk app is not low. What werk has that none of them do is _many sessions on
many machines_.

The third option interacts with §14 — using a vendor's own phone client is
per-agent knowledge of a fairly deep kind.

### 13. Do we ship an MCP server?

The primary payload is `claude`; exposing werk over MCP lets one agent supervise
a fleet of others. Container Use ships as an MCP server _instead of_ an app,
which keeps it usable from any agent.

**Lean:** yes, but later, and derived from the HTTP API rather than built
separately. The strategic version of this question is in
[`../research/13-landscape.md`](../research/13-landscape.md) §7: shipping **both**
a protocol-neutral interface and a complete end-user product is a position nobody
currently occupies.

### 14. How far does per-agent support go?

The sixth promise is that werk eventually supports every coding agent. The floor
is settled by the architecture: structured terminal signals mean any CLI agent
works with no per-agent code. The question is what sits above that floor.

- **The floor only.** werk knows nothing about `claude` beyond what it emits.
  Every agent is equal because none is special. Nothing to maintain, nothing to
  break when a vendor ships a UI change.
- **Per-agent knowledge where it pays.** Recognising which agent is running, what
  it is asking, what it has queued. Better "needs you", better fleet rows — and a
  per-vendor maintenance burden, plus the risk of the good experience being the
  one for whichever agent we happened to build for.

The middle position worth naming: per-agent knowledge is fine when it is
_additive_ — a nicer row when we recognise the agent, a correct row when we
don't — and not fine when the product only works well for agents we know.

### 15. Which editor environments, and in what order?

VS Code, Cursor, Antigravity, JetBrains, Zed. They have different extension
models, different agent architectures and different amounts of "let a plugin
decide where the agent runs".

Two things to find out before picking: which of them will actually let an
extension point their agent at a remote workspace (VS Code's own remote
extension host is the obvious lever, and the Cursor/Antigravity forks may or may
not inherit it), and which of them have users who want work happening somewhere
other than the laptop in the first place.

Not urgent — it sits behind sequencing steps 1–5 — but it is worth knowing the
answer before the API that the plugins would consume is frozen, since
[`03-surfaces.md`](03-surfaces.md) commits to those plugins being clients of
that API rather than a second implementation.

---

## Trust and safety

### 16. How much does werk trust the workspace?

Workspaces run autonomous agents. Anthropic's own guidance is blunt: a malicious
repo can exfiltrate anything reachable in the container, **including `~/.claude`
credentials**.

Concrete decisions this forces:

- **Agent forwarding.** Default off is the only defensible answer
  ([`../research/09-remote-transport.md`](../research/09-remote-transport.md)
  §2.5) — the far side is an autonomous process, not a predictable human.
- **Egress policy.** Anthropic's reference devcontainer ships a default-deny
  iptables firewall. Do werk's containers?
- **The persistence denylist.** `@anthropic-ai/sandbox-runtime` hard-denies
  writes to `.git/hooks`, `.git/config`, `.mcp.json`, `.claude/commands`, and
  shell rc files — specifically so a compromised session can't plant something
  that runs _unsandboxed_ next time. That is a well-considered list and werk
  should probably enforce it for workspaces it owns.

**This is a product decision, not a security footnote.** A tool that makes it
trivially easy to run unattended agents has an obligation to make the safe
configuration the default one, and to say plainly what the boundary is.

### 17. What is the web UI's honest threat model?

Stated in [`03-surfaces.md`](03-surfaces.md): a web terminal is remote code
execution by design, and the auth boundary is the entire security model. Spanning
multiple machines makes the blast radius **bigger**.

The open part is how far to go. Loopback plus a one-time token is the safe
starting point, but it doesn't reach a phone on a different network, and §12
wants it to. The options run from "document a tunnel or a mesh VPN and build
nothing" through "support an exposed listener with auth werk is willing to stand
behind" to "werk hosts the relay" — each one a bigger obligation than the last,
and the last one collides with the state question in
[`00-what-werk-is.md`](00-what-werk-is.md).

---

## Positioning

### 18. What is the monetisation thesis, and does it avoid the pattern that keeps failing?

[`../research/13-landscape.md`](../research/13-landscape.md) §1 documents a
casualty list: Terragon shut down; Crystal discontinued; vibe-kanban's commercial
layer sunsetting to OSS _despite_ 28k stars and 30k users. **Standalone paid
multiplexers keep failing in this exact category.** Survivors bundle into a
bigger product or pivot to infrastructure.

This does not have to be answered now, but it should be answered before it starts
shaping the architecture — because "free OSS core with an infra upsell" and
"paid desktop app" imply quite different products.

### 19. Is the name available?

Two unrelated tools are already both called "cmux". **Check that "werk" isn't
claimed in this niche before committing publicly.** Cheap to check now,
expensive later.
