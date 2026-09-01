# 13 — The landscape: who else is building this, and where the gap actually is

A survey of the competitive and prior-art landscape as of 2026-09-01, scoped to
the expanded product in [`../product/00-what-werk-is.md`](../product/00-what-werk-is.md).
[03-prior-art.md](03-prior-art.md) covers the terminal-multiplexer ancestry; this
covers the agent-orchestration wave, the vendor products, and the remote-compute
layer.

## The four-sentence version

Local worktree-per-agent managers are **brutally crowded** — 40+ active tools,
all converging on "git worktree + tmux + a TUI or kanban board". Vendor-hosted
async agents have shipped genuinely sophisticated multi-session dashboards, and
Claude Code's is the one to study. **Cross-machine terminal fleet dashboards are
essentially unbuilt.** Remote-compute providers are commoditizing fast and are
werk's best _backend_ layer, not competitors.

---

## 1. The crowded core: local worktree-per-agent managers

The dominant pattern is now table stakes, not a differentiator: **git worktree
per agent + a persistent tmux-equivalent pane + a TUI or kanban shell**, wrapping
the Claude Code / Codex / Gemini CLIs rather than replacing them.

| Tool                                                    | Where                         | Interface                                 | Git model                                                                 | Stars / status                                                            |
| ------------------------------------------------------- | ----------------------------- | ----------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| [**cmux**](https://cmux.com) (manaflow-ai)              | Local macOS + **SSH remote**  | Native Ghostty-based app + CLI/socket API | No enforced worktree model; subagents become native panes                 | **26.7k★**, pushed 2026-09-01                                             |
| [**vibe-kanban**](https://vibekanban.com) (Bloop)       | Local                         | **Web** kanban                            | Auto worktree + setup scripts per task                                    | **28.0k★**; commercial layer **sunsetting to OSS**                        |
| [Charm's Crush](https://charm.sh)                       | Local, cross-platform         | TUI                                       | Session-based; **multi-client workspace sharing**                         | 27.9k★, very active                                                       |
| [**Happy Coder**](https://happy.engineering)            | Local CLI → mobile/web bridge | **Mobile + web**, voice, E2E encrypted    | Wraps existing CC/Codex sessions                                          | **23.6k★** — the most-starred tool in the survey                          |
| [cc-haha](https://github.com/)                          | Local desktop                 | Desktop app                               | Branch/worktree + diff review                                             | 14.3k★, kitchen-sink scope creep                                          |
| [claude-squad](https://github.com/smtg-ai/claude-squad) | Local                         | TUI                                       | Worktree per agent, tmux, detachable                                      | 8.4k★                                                                     |
| [ccpm](https://github.com/)                             | Local                         | CLI "skill system"                        | **GitHub Issues as the source of truth**                                  | 8.4k★                                                                     |
| [Worktrunk](https://worktrunk.dev)                      | Local                         | CLI (Rust)                                | _Just_ worktree lifecycle, agent-agnostic                                 | 6.8k★ — the "do one thing well" counter-trend                             |
| [Backlog.md](https://github.com/MrLesk/Backlog.md)      | Local, git-native             | CLI + web + MCP                           | Not worktrees — markdown task files; **state is git history**             | 6.6k★, zero server, zero telemetry                                        |
| [**Container Use**](https://container-use.com) (Dagger) | Local, container-backed       | CLI + **MCP server**                      | **Fresh container per agent on its own branch**; review by `git checkout` | 4.0k★                                                                     |
| [Conductor](https://conductor.build)                    | Local macOS                   | Desktop                                   | Worktrees + built-in review/merge UI                                      | Commercial, active                                                        |
| [Sculptor](https://imbue.com/sculptor) (Imbue)          | Local                         | Desktop                                   | **Containers, not worktrees**; "pairing mode" syncs container↔local git   | Company-backed                                                            |
| [Amp](https://ampcode.com) (Sourcegraph)                | Local CLI + cloud "Orbs"      | CLI + web + VS Code                       | One cloud sandbox per conversation thread                                 | Commercial                                                                |
| [VibeTree](https://github.com/sahithvibudhi/vibe-tree)  | Local                         | **Desktop + web + CLI**                   | Worktree + branch + terminal per task                                     | 267★ — closest OSS multi-surface match                                    |
| [diri](https://github.com/)                             | Local **+ remote hosts**      | Native macOS                              | Worktrees across local and remote                                         | 278★                                                                      |
| [uzi](https://github.com/devflowinc/uzi)                | Local                         | CLI (Go)                                  | Worktree per agent, `uzi checkpoint` to merge                             | 582★ — `--agents claude:3,codex:2` fan-out, auto-assigns dev-server ports |
| [wmux](https://github.com/)                             | Local, **Windows-first**      | CLI/TUI                                   | Worktree fan-out, approval gates, "reboot-surviving sessions"             | 365★ — rare Windows-first design                                          |
| Long tail                                               | all local                     | mixed                                     | worktree-per-task, every one                                              | ~28–2.8k★, 25+ more                                                       |

**The commercial casualties are the most instructive data in this table.**

| When         | What                                                                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| ~Feb 2026    | **Crystal** (3.1k★ Electron worktree manager) **discontinued**, rebranded into [Nimbalyst](https://nimbalyst.com), a broader AI-native workspace |
| 2026-01-16   | **Terragon / Terry shut down.** The site reads "Terragon Shutdown". "Bring your own subscription" pricing didn't save it                         |
| ongoing 2026 | **vibe-kanban's commercial layer sunsets back to community OSS** — despite 28k★, 30k+ users and 100k+ PRs created                                |
| 2026-06-11   | **Gitpod → Ona → acquired by OpenAI**                                                                                                            |

Read: **standalone paid multiplexers keep failing in this category.** Survivors
either bundle into a bigger workspace product (Nimbalyst, cc-haha) or pivot to
infrastructure and APIs (Omnara, Tembo). That is worth factoring into any
monetisation thinking before it shapes the architecture.

**The other fork worth naming:** container isolation (Sculptor, Container Use,
Tembo) vs. worktree isolation (everyone else). Containers buy stronger isolation
and reproducibility at the cost of merge-back friction; worktrees are cheap and
fast but share host state. werk's placement model is a bet that this should be a
_user choice_, not a product decision — which no one else in this table offers.

**Almost nothing spans local + SSH + Docker, and almost nothing offers both a TUI
and a web UI.** VibeTree is the closest OSS match at 267★; vibe-kanban is
web-only; claude-squad and uzi are TUI-only; cmux and diri add remote but stay
desktop-native.

> **A naming problem to resolve before going public.** Two unrelated tools are
> both called "cmux". "mux" and "Async" are similarly contested. **Check that
> "werk" isn't already claimed in this niche.**

---

## 2. The incumbents, and the UX to steal from them

Every major lab and IDE vendor has shipped an async agent product. All of them
are either fully vendor-cloud or a local/cloud hybrid **tied to that vendor's own
cloud**. None offers a vendor-neutral session registry across arbitrary hosts.

### Claude Code is the one to study, and the biggest risk

By September 2026 it spans terminal, VS Code, JetBrains, a desktop app,
claude.ai/code, and iOS/Android on the same engine. Three things matter:

**The Agent view** (`claude agents`) is the single most transferable UX pattern
found anywhere in this survey ([docs](https://code.claude.com/docs/en/agent-view)):

- Rows **grouped by state** — Pinned / Ready for review / Needs input / Working /
  Completed.
- A small model writes a **live one-line activity summary** per row.
- PR status chips **coloured by CI and review state**.
- Full keyboard nav: `↑`/`↓` to move, **`Space` to peek-and-reply inline without
  opening the session**, `Enter` to fully attach.
- Grouping and filtering by state, directory, agent name, PR, or URL.
- **Detaching never stops the session.**

**Three distinct verbs for three distinct problems** — and werk's placement model
is essentially a generalisation of this split, minus the vendor:

| Verb                    | What it does                                                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `claude --cloud "task"` | Start on an Anthropic-managed VM (or a self-hosted runner). Survives closing the laptop; reachable from web and mobile |
| `claude --teleport`     | Pull a **cloud** session's branch and history down into a local terminal. **One-way, cloud→local**                     |
| `/remote-control`       | Expose an already-running **local** session to be steered from phone or browser, execution staying put                 |

**Auto-fix PRs** subscribe to GitHub webhooks and automatically investigate and
fix CI failures and review comments.

### The rest

| Product                         | Where it runs                                     | The instructive bit                                                                                                                                                                                                                                                                          |
| ------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Devin** (Cognition)           | Cognition cloud                                   | **The deepest investment in session _organisation_ found anywhere**: nested sub-sessions as a **tree** with hover-peek, drag-drop folders, pin/archive, a distinct **"Waiting"** state, read/unread indicators, and **session subscribers** — follow someone else's session like a GitHub PR |
| **Codex** (OpenAI)              | OpenAI cloud + local CLI                          | `codex agents` terminal dashboard; **`codex queue` messages local _or_ remote sessions**; cross-host search in the ChatGPT desktop app                                                                                                                                                       |
| **Cursor** background agents    | Isolated VMs, pre-built "Builds" (3× faster boot) | Agents **subscribe to PRs and Slack threads and wake on events**; subagents get their own machines; steering messages and `/goal` let you nudge a running agent without interrupting it                                                                                                      |
| **Amazon Kiro**                 | AWS sandboxes + local IDE                         | **Three-pane layout: session list \| conversation \| merged PR with changed files.** A clean reference skeleton for a web UI                                                                                                                                                                 |
| **GitHub Copilot coding agent** | Actions-backed ephemeral sandbox                  | Copilot as commit author, requester as co-author; full reasoning/tool logs per session                                                                                                                                                                                                       |
| **Google Jules**                | Cloud VM per task                                 | Concurrency caps (3/15/60 by tier) imply a queue                                                                                                                                                                                                                                             |
| **Google Antigravity**          | Local + "Remote Control"                          | **"Projects" spanning multiple workspaces** — prior art if werk ever needs a level above one-repo-one-branch                                                                                                                                                                                 |
| **Warp Factories**              | Warp cloud + desktop + CLI                        | The **only product using "fleet" language**. Config-as-code agent pipelines; three-layer stack (cloud / desktop / CLI) worth studying as a template for `werk serve` / TUI / CLI                                                                                                             |

---

## 3. Terminal session tools: the actual gap

| Tool                                                    | Fleet / multi-host?                                                                              |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [VibeTunnel](https://github.com/amantus-ai/vibetunnel)  | **No.** Each Mac has its own dashboard; reach others via a separate tunnel per machine           |
| [sshx](https://sshx.io)                                 | No fleet dashboard — but the infinite canvas shows many terminals side by side with live cursors |
| Zellij web                                              | One session shared, not multi-host. Paid beta                                                    |
| tmate / [upterm](https://github.com/owenthereal/upterm) | No. One link per session. upterm's reverse-SSH-tunnel design works through NAT                   |
| Wave Terminal                                           | An SSH connection _switcher_, not a live fleet dashboard                                         |
| [Blink Shell](https://blink.sh)                         | Many saved hosts, no unified status view. Mosh-backed roaming makes phone check-ins tolerable    |
| zmx / hauntty / openmux / speedmux                      | No — all single-host session-persistence primitives                                              |

**Nobody has built a cross-machine fleet dashboard for terminal sessions.**
Everyone is single-host-native, with either a relay to one remote host at a time
or a locally-served web UI you must expose separately per machine. The only
"fleet" language in the market belongs to Warp Factories, and that is cloud agent
orchestration bolted onto a terminal app, not a live pane into any shell anywhere.

**This is werk's clearest structural opening** — and it is contingent entirely on
actually building the aggregation layer, rather than punting to "open N browser
tabs".

One more signal worth noting: searching GitHub surfaces a **cluster of very
recent, very small (1–88★), independently-authored projects all reinventing
`dtach` on top of libghostty**, several updated within the last fortnight, at
least one ([sch0tten/hauntty](https://github.com/sch0tten/hauntty)) framed
explicitly as _"persistent, observable shell sessions for LLM agents"_. None
attempt multi-host aggregation. That this many people are independently building
the same primitive right now is evidence the need is real and under-served — and
that the primitive itself is not the differentiator.

---

## 4. Remote compute: the layer to sit on, not fight

| Tool                                                                                                                                      | Could it be a werk backend?                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [**DevPod**](https://devpod.sh) (Loft)                                                                                                    | **Yes, strongly.** Client-only, infra-agnostic, devcontainer-standard, CLI-first, 100% OSS. The closest existing model for how werk provisions without owning infrastructure |
| [**Daytona**](https://daytona.io)                                                                                                         | **Yes.** API-first, SSH-accessible, sub-90ms creation, explicitly marketed at persistent agent workloads                                                                     |
| [Fly.io Machines](https://fly.io/docs/machines/overview/)                                                                                 | **Yes.** Full REST API, sub-second restarts, real SSH                                                                                                                        |
| [E2B](https://e2b.dev) / [Modal](https://modal.com/docs/guide/sandbox) / [Cloudflare Sandbox](https://developers.cloudflare.com/sandbox/) | Yes as primitives, but see [12-placement-backends.md](12-placement-backends.md) — 24h caps and exec-only APIs make them a poor fit for day-spanning interactive sessions     |
| [Coder](https://coder.com)                                                                                                                | **Maybe** — repositioning toward "infra for devs _and agents_ side by side", which makes it closer to a peer than a substrate                                                |
| [Ona](https://ona.com) (ex-Gitpod)                                                                                                        | **No — now part of OpenAI.** A category-2 incumbent, not infrastructure                                                                                                      |
| Nix `--target-host`                                                                                                                       | As a _pattern_: build here, activate there. Elegant prior art for the SSH-to-existing-machine path                                                                           |

**The Gitpod → Ona → OpenAI arc is the thing to dwell on.** In 2024 Gitpod was a
remote-dev-environment product in the same bucket as Coder. Its Ona rebrand moved
it to "task in, PR out". OpenAI acquired it in June 2026. **Infrastructure
products drift toward becoming agent-orchestration products, because that is
where the money is** — which is exactly the drift to watch for in any backend werk
depends on. Another argument for a real plugin boundary rather than a hardcoded
integration.

---

## 5. Phone check-in

Validated demand, one clear breakout, and a specific unbuilt gap.

| Tool                                         | Notes                                                                                                                                                                                              |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [**Happy Coder**](https://happy.engineering) | **23.6k★** — full remote control of a _local_ Claude Code session, push on blocking permission prompts, hand control back with one tap. E2E encrypted. The most-starred tool in this entire survey |
| Claude mobile                                | Remote Control + cloud tasks, push on turn completion and permission requests                                                                                                                      |
| [Omnara](https://omnara.com)                 | 2.8k★ — **pivoted away** from "watch your agent on your phone" toward being an agent-orchestration backend with pluggable sandboxes                                                                |
| VibeTunnel mobile                            | The web dashboard, responsively. Native iOS explicitly WIP                                                                                                                                         |
| Cursor mobile                                | The web dashboard on a small screen                                                                                                                                                                |

The winning pattern is **"wrap the CLI, tunnel the session, push a notification
when a permission prompt blocks"**. Nobody has built deep mobile _review_ — diff,
inline comments, re-prompt — as a first-class experience. It's monitor-and-unblock
everywhere.

For werk: Happy has monitor-and-unblock largely won. The interesting question is
whether werk's phone story competes there or **interoperates**.

---

## 6. Process supervisors: free vocabulary

Worth mining, because this world already solved "here are N things running" and
werk should reuse its language rather than reinvent it.

| Tool                                                                | The thing to steal                                                                                                    |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| [**Overmind**](https://github.com/DarthSim/overmind)                | **"Attach = a real terminal for that process, not a read-only log tail."** Exactly werk's contract, already proven    |
| [**mprocs**](https://github.com/pvolok/mprocs)                      | Sidebar process list + detail output pane. Very close to werk's likely TUI shape                                      |
| [**process-compose**](https://github.com/F1bonacc1/process-compose) | **Liveness/readiness health-check semantics** — a richer state model than running/exited. Already ships an MCP server |
| pm2                                                                 | The "one table of uptime/restarts/CPU for everything" convention                                                      |
| supervisord                                                         | "A group of processes as one named unit" — maps onto werk's workspace                                                 |
| `systemd --user`                                                    | Battle-tested restart-policy vocabulary (`Restart=on-failure`, backoff)                                               |
| Zellij layouts                                                      | "Layout" as a named, reusable session-preset template                                                                 |

---

## 7. Synthesis

### What's crowded, what's empty

**Crowded — do not re-fight:**

- Local worktree-per-agent + tmux + TUI/kanban. 25+ active tools. New entrants
  compete purely on polish.
- Vendor-hosted async agent with a PR-out workflow. Every lab has one.
- Raw agent-sandbox-as-a-service. Commoditizing. Treat as backends.
- Mobile monitor-and-unblock for a single local session. Happy has it at 23.6k★.

**Genuinely empty:**

- **A vendor-neutral session registry spanning local + SSH-to-an-existing-machine
  - provisioned containers, in one tool, with both a TUI and a web UI.** No tool
    found does all four legs; the closest (cmux, VibeTree, diri) each miss at
    least two.
- **A cross-machine fleet dashboard for arbitrary terminal sessions.**
- **Git branch as the first-class organising unit across heterogeneous
  backends.** Most managers organise by task or kanban card, with the worktree as
  an implementation detail. Few make "this branch, wherever it's running" the
  primary navigational object.
- Deep mobile review — diff, comment, re-prompt — is unbuilt by anyone.

### The design decisions everyone faces

| Decision           | Range of answers observed                                                                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Isolation unit     | git worktree (majority) · full container (Sculptor, Container Use, Tembo) · none, native panes (cmux)                                                       |
| Organising concept | branch/worktree · kanban card (vibe-kanban, Devin) · thread (Amp) · project (Antigravity)                                                                   |
| Local vs cloud     | fully local · fully vendor-cloud · hybrid with an explicit _migrate_ vs _steer_ distinction (Claude Code)                                                   |
| Attach model       | drop into a real terminal (Overmind, tmux tools) · read-only summary with a peek affordance (Claude Code's `Space`) · full chat-thread replay (Devin, Kiro) |
| Interface breadth  | single-surface (most of §1) · deliberately multi-surface (Claude Code, Cursor, Devin, Warp)                                                                 |
| Merge-back         | plain `git checkout <branch>` (Container Use) · built-in diff/PR review UI (Conductor, Kiro) · auto-PR with CI auto-fix (Claude Code, Copilot)              |
| Notification       | terminal bell/hook · push app · chat-platform mention · none documented                                                                                     |
| Monetisation       | standalone paid (fragile — see the casualties) · free/OSS core with infra upsell · bundled free into a vendor platform                                      |

### Things to steal, named

1. **Claude Code's Agent view interaction model** — state-grouped rows, live
   one-line summaries, and `Space` to peek-and-reply before `Enter` to attach.
   The single most transferable pattern found.
2. **Overmind's "attach = real terminal".** Don't build a bespoke log viewer as
   the primary interaction.
3. **Devin's session organisation** — folders, nested trees, subscribers, and an
   explicit "Waiting" state distinct from "Working".
4. **Container Use's MCP-server packaging.** Shipping the provisioning layer as a
   protocol-neutral interface keeps werk usable from _any_ agent and future-proofs
   against agent-of-the-month churn.
5. **DevPod's client-only, infra-agnostic provider model** — a concrete existing
   pattern for werk's placement plugin interface.
6. **Nix's build-here / activate-there split** for the SSH path.
7. **mprocs' sidebar+detail TUI layout**, and **process-compose's
   liveness/readiness** state model.
8. **Warp's three-layer stack** (cloud orchestration / desktop / CLI) as a
   template for separating `werk serve`, the TUI, and the CLI.
9. **Happy Coder's obsessive narrow focus.** The highest-starred tool in the
   survey resisted scope creep entirely. A caution against werk also becoming an
   IDE.
10. **Kiro's three-pane layout** (list | conversation | diff) as the web skeleton.
11. **Cursor's steering messages and `/goal`** — nudge a running agent without
    interrupting it, rather than forcing detach-edit-reattach.
12. **Backlog.md's zero-server, git-native state model** — worth considering as an
    offline/fallback philosophy even if the fleet view needs a live daemon.

### The honest risks

**Most likely to make werk redundant: Claude Code itself.** Agent view +
`--cloud` + `--teleport` + `--remote-control` already covers a large fraction of
werk's feature list — for one agent brand, for free, with zero setup, inside the
tool people already run. If Anthropic (or OpenAI, whose `codex agents` /
`codex queue` is converging on the same shape) extends this to explicit SSH-host
and container targets, or opens the session protocol, werk's differentiation
narrows sharply.

**Secondary:** **cmux** (26.7k★, already local+SSH with a native terminal,
iterating daily) could add container provisioning and a web surface and land very
close to werk's full scope — of everything surveyed it is the closest thing
already shipping. **Warp Factories** could extend "fleets" down from cloud
pipelines into general session viewing. **DevPod or Daytona** could bolt a session
registry onto existing infra-agnostic provisioning and out-flank from below. And
Ona shows how fast a neutral backend becomes a vertically-integrated competitor.

**What werk has to be to survive this:**

- **Genuinely agent-neutral.** Works identically well for Claude Code, Codex,
  Gemini CLI, Aider, `npm run dev`, or `tail -f`. This is already the stated
  non-goal in [`../product/00-what-werk-is.md`](../product/00-what-werk-is.md)
  and it is load-bearing, not principle.
- **Genuinely backend-neutral**, with a real provider-plugin architecture rather
  than one hardcoded path per placement.
- **The fleet layer has to actually exist and work well.** It is the gap
  identified in §3, and it is the part hardest for a single-vendor incumbent to
  credibly build — they have no incentive to make _other_ vendors' agents or
  _arbitrary_ infrastructure first-class.

---

## Open questions

1. Multi-agent at launch, or Claude-first? This changes whether the closest
   competitor is Claude Code's own tooling or the vendor-neutral tools in §1.
2. "Call out to your existing ssh/docker" (DevPod, Nix) or "provision ephemeral
   cloud sandboxes for you" (Daytona, Fly)? Different partners, different
   competitive set.
3. How much of the fleet web UI ships in v1? §3 says it is the real gap and also
   the most engineering-heavy piece — connection management, auth, reconnection
   across N hosts.
4. Does werk's phone story compete with Happy Coder, or hand off to it?
5. Given the casualty list, what is the monetisation thesis — and does it avoid
   the standalone-paid-multiplexer pattern that has now failed repeatedly in this
   exact category?
6. Ship **both** a protocol-neutral backend interface (Container Use's posture)
   _and_ a complete end-user TUI/web product? That is a defensible position no
   one currently occupies.
7. **Is the name "werk" already taken in this niche?**

## Sources

Every claim is linked inline. The five worth reading in full:
[Claude Code's Agent view docs](https://code.claude.com/docs/en/agent-view) ·
[Container Use](https://github.com/dagger/container-use) ·
[DevPod's "How it works"](https://devpod.sh/docs/how-it-works/overview) ·
[cmux](https://github.com/manaflow-ai/cmux) ·
[Overmind](https://github.com/DarthSim/overmind).
