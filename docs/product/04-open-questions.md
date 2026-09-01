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

The second is much better and much harder. It also smuggles in a question werk
has otherwise avoided: **is there any werk state that isn't on one of your
machines?** A hosted index would be the first crack in "not a hosted service".

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

|                 | Cost                                                                                                                                                                                                                                                                              |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Client only** | Windows users place work in WSL2 or a container. Honest, much less work, and matches where the tooling actually is — Claude Code's own sandbox supports WSL2 and **not** native Windows                                                                                           |
| **Host too**    | ConPTY works, but: `Bun.Terminal` on Windows re-encodes output rather than passing bytes through; `proc.kill(signal)` ignores the signal, so graceful teardown doesn't work as designed; no `AF_UNIX`; and WSL2 itself has **no guarantee for unattended long-running processes** |

Details in [`../research/07-packaging.md`](../research/07-packaging.md) §6 and
[`../research/12-placement-backends.md`](../research/12-placement-backends.md) §4.

**Lean:** client-first, WSL2 as the documented Windows placement, native Windows
hosting explicitly out of scope for v1 and stated as such. But note the WSL2
teardown problem is a real risk to the first promise and needs its own answer.

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

[`../product/02-journeys.md`](../product/02-journeys.md) §8 shows three
`werk create` calls. `uzi` has `--agents claude:3,codex:2` and it is genuinely
neat.

**Lean:** don't build it. See whether people ask. Three shell invocations is not
a hardship, and a fan-out primitive drags in a comparison view, resource
policies, and a scheduler — none of which are in scope.

### 11. Is there a diff/review UI?

Every competitor has one. Conductor, Kiro's three-pane, vibe-kanban all treat
"review is the bottleneck, not generation" as the thesis.

**Lean: no.** `werk pull` puts the branch in your repo and you review it with the
tools you already like. Building a worse `git diff` is how a session manager
becomes an IDE, and
[`../research/13-landscape.md`](../research/13-landscape.md) is full of tools
that died of exactly that. `werk diff` showing _what changed and how much_ — a
summary, not a review surface — is the honest middle.

### 12. Does the phone story compete with Happy Coder, or hand off to it?

Happy Coder has 23.6k stars for "monitor your local Claude session from your
phone and unblock it". That is a solved problem with a clear winner.

**Lean:** don't compete. werk's phone story is the responsive web UI plus a
notification channel, and that's enough. The thing werk has that Happy doesn't is
_many sessions on many machines_ — lead with that, not with a better remote
control.

### 13. Do we ship an MCP server?

The primary payload is `claude`; exposing werk over MCP lets one agent supervise
a fleet of others. Container Use ships as an MCP server _instead of_ an app,
which keeps it usable from any agent.

**Lean:** yes, but later, and derived from the HTTP API rather than built
separately. The strategic version of this question is in
[`../research/13-landscape.md`](../research/13-landscape.md) §7: shipping **both**
a protocol-neutral interface and a complete end-user product is a position nobody
currently occupies.

---

## Trust and safety

### 14. How much does werk trust the workspace?

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

### 15. What is the web UI's honest threat model?

Stated in [`03-surfaces.md`](03-surfaces.md): a web terminal is remote code
execution by design, and the auth boundary is the entire security model. Spanning
multiple machines makes the blast radius **bigger**.

The open part is how far to go: loopback + token is right for v1, but does werk
ever support a genuinely exposed deployment, or does it permanently say "use
Tailscale or an ssh tunnel"?

**Lean:** permanently say Tailscale. Building public-internet exposure is a
different product with different obligations.

---

## Positioning

### 16. What is the monetisation thesis, and does it avoid the pattern that keeps failing?

[`../research/13-landscape.md`](../research/13-landscape.md) §1 documents a
casualty list: Terragon shut down; Crystal discontinued; vibe-kanban's commercial
layer sunsetting to OSS _despite_ 28k stars and 30k users. **Standalone paid
multiplexers keep failing in this exact category.** Survivors bundle into a
bigger product or pivot to infrastructure.

This does not have to be answered now, but it should be answered before it starts
shaping the architecture — because "free OSS core with an infra upsell" and
"paid desktop app" imply quite different products.

### 17. Is the name available?

Two unrelated tools are already both called "cmux". **Check that "werk" isn't
claimed in this niche before committing publicly.** Cheap to check now,
expensive later.
