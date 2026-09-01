# 03 — Surfaces

What each way of talking to werk is _for_. Not a spec — the flags will change.
The point is that each surface has a distinct job, and none of them is a
degraded copy of another.

| Surface           | Its job                                                          | Status |
| ----------------- | ---------------------------------------------------------------- | ------ |
| **CLI**           | Do a thing and get out of the way. Scriptable, reflexive, fast.  | v1     |
| **The terminal**  | Be inside a session. This is where you actually work.            | v1     |
| **TUI**           | Browse and steer the fleet without leaving the terminal.         | v1     |
| **Web**           | The same, from a browser, from any device on your network.       | v1     |
| **Notifications** | Tell you when something needs you, when you're not looking.      | v1-ish |
| **Programmatic**  | Let other software — including agents — drive werk.              | later  |
| **Editor**        | Run an editor-hosted agent in a werk workspace, from the editor. | later  |
| **Desktop**       | The web UI in a window, with OS integration.                     | later  |

---

## CLI

The primary surface, and the one to get right first. Two design commitments:

**Bare `werk` prints the fleet and exits.** Not a menu, not a TUI, not help
text. It should feel like `ls` or `git status` — something you type reflexively,
several times an hour, that answers a question in under a second. This is the
most-executed command in the product and its latency budget is the tightest
constraint in the whole design.

**A first non-flag token ends werk's own parsing.** `werk claude
--dangerously-skip-permissions` runs claude with that flag; werk does not try to
interpret it. This is the `git`/`env`/`nice` convention and what people expect.
`werk run -- <cmd>` stays available as the unambiguous form.

### The verb inventory

Grouped by what they're for, not alphabetically.

**Making things**

|                                |                                                                                   |
| ------------------------------ | --------------------------------------------------------------------------------- |
| `werk create`                  | The headline. Provision, seed, branch, attach. Everything else is a flag on this. |
| `werk create --on <placement>` | `local`, a host from your ssh config, `docker`, `docker@host`.                    |
| `werk create --run <cmd>`      | Start with this instead of a shell.                                               |
| `werk create --no-repo`        | Free-floating. No branch, no seeding.                                             |
| `werk create --here`           | Use this directory in place. No worktree, no branch, don't touch my git.          |
| `werk run <name> -- <cmd>`     | An additional session in an existing workspace.                                   |

**Looking at things**

|                    |                                                                         |
| ------------------ | ----------------------------------------------------------------------- |
| `werk`             | The fleet. Fast, plain, pipeable.                                       |
| `werk ls --json`   | The same, for scripts. Every list surface should have this.             |
| `werk ui`          | The interactive TUI.                                                    |
| `werk serve`       | The web UI.                                                             |
| `werk logs <name>` | Dump a session's scrollback. Pipeable.                                  |
| `werk watch`       | Block until something needs you. The scriptable form of a notification. |

**Being in things**

|                             |                                                                                                     |
| --------------------------- | --------------------------------------------------------------------------------------------------- |
| `werk attach <name>`        | Get into a session. Prefix-matched.                                                                 |
| `werk attach --read-only`   | Watch without the risk of typing into it.                                                           |
| `werk ssh <name>`           | A plain shell on the workspace's machine, outside any session. The escape hatch, and it must exist. |
| `werk exec <name> -- <cmd>` | One command, non-interactive, exit code back.                                                       |

**Git**

|                    |                                                             |
| ------------------ | ----------------------------------------------------------- |
| `werk diff <name>` | What has this workspace done, relative to where it started. |
| `werk pull <name>` | Bring its branch into your local repo.                      |
| `werk push <name>` | Send local changes the other way.                           |

**Ending things**

|                    |                                                               |
| ------------------ | ------------------------------------------------------------- |
| `werk stop <name>` | Stop the processes; keep the workspace and its files.         |
| `werk rm <name>`   | Destroy it. Refuses when work would be lost.                  |
| `werk prune`       | Clean up finished/abandoned workspaces, with a preview first. |

**Housekeeping**

|                |                                                                                                                |
| -------------- | -------------------------------------------------------------------------------------------------------------- |
| `werk info`    | Every path, version and setting werk will use. Prints the local _and_ the remote answer for a given placement. |
| `werk doctor`  | Check it all actually works, and say what to do when it doesn't.                                               |
| `werk upgrade` | Upgrade the client and every reachable daemon.                                                                 |
| `werk hosts`   | Which placements werk knows about and whether they're up.                                                      |

`werk info` and `werk doctor` are not nice-to-haves. With one machine they save
support time; with six machines, two container runtimes and an ssh bastion in the
middle, they are the difference between a debuggable product and an unusable one.
They should be built early, not last.

---

## The terminal

The surface with the fewest features and the highest stakes. When you're
attached, werk should be **invisible**: every keystroke reaches the process, every
byte comes back, colours are right, the mouse works, resize works, `^C` goes to
the program and not to werk.

The only things werk owns while attached:

- **The detach key.** The genuinely hard UX problem, because the payload is
  usually a TUI that wants every control key. `Ctrl-\` has the best track record
  (zmx, abduco). It must be configurable, disableable, and discoverable — and
  there must always be an out-of-band way out (`werk detach <name>` from another
  terminal, and detach-on-terminal-close).
- **A literal-next escape**, so the detach key itself can be sent through.
- **Optionally, a status line.** Which workspace you're in, and how to leave.
  Off by default is defensible; the alternative — injecting a prefix into the
  user's shell prompt, as shpool does — doesn't work for a TUI anyway.

Everything else is the program's.

---

## TUI

`werk ui`. For when you have more than about five workspaces and the flat list
stops being enough.

What it's for, in order:

1. **Triage.** Which of these needs me? Sorted so the answer is at the top.
2. **Preview.** What is that one doing — without committing to attaching. The
   last N lines of a session, live, in a pane. This is the feature that makes a
   TUI worth building over the flat list.
3. **Navigate.** Filter by project, by placement, by status. Fuzzy-jump by name.
4. **Act.** Attach, create, stop, remove — without retyping names.

Keyboard-first, vim-ish bindings, no mouse required but mouse supported. The
reference points for "snazzy" here are `lazygit`, `k9s` and `btop`: dense,
immediate, obviously-navigable, no chrome that isn't carrying information.

The hard part is showing a live terminal preview inside a terminal UI, which is
a real technical question, not a design one — see
[`../research/11-interfaces.md`](../research/11-interfaces.md).

---

## Web

`werk serve`. Runs on your machine, aggregates every placement, serves one page.

Three things it does that the terminal cannot:

- **Many terminals at once, visually.** A grid of live (or recently-snapshotted)
  session previews is a genuinely better fleet view than any list.
- **Reachable from a device that isn't a terminal.** Your phone, your tablet, the
  laptop you didn't set up.
- **Bookmarkable.** A URL per session.

Non-negotiables, taken from Zellij's web client, which is the best-considered
prior art here:

- **Opt-in.** It never starts implicitly.
- **Loopback by default**, with a printed one-time token.
- **If it listens on a non-loopback interface, HTTPS is mandatory** and not
  disableable.
- Honest threat model, stated in the docs: once authenticated, a user has full
  ability to run code as you on every machine in your fleet. A web terminal is
  remote code execution by design; the auth boundary is the entire security
  model. Spanning multiple machines makes the blast radius bigger, not smaller,
  and that deserves saying out loud.

---

## Notifications

The product thesis is "check in on things", which means werk has to be able to
_interrupt_ you, or you'll just leave the list open and poll it like a slot
machine.

The signals are already there (bell, OSC 9/777 desktop notification, OSC 9;4
progress, process exit — see [01-object-model.md](01-object-model.md#attention)).
The question is where they go:

| Channel                                                           | For                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **OS notification** on the machine running `werk serve` / the TUI | The default. You're at your desk.                                                                                                                                                                                                                   |
| **Terminal bell / title** passthrough                             | Free, works with your existing setup.                                                                                                                                                                                                               |
| **`werk watch`** blocking until something happens                 | Scripting, and composing with whatever the user already has.                                                                                                                                                                                        |
| **Webhook**                                                       | The escape hatch that makes every other integration someone else's problem.                                                                                                                                                                         |
| **Phone**                                                         | The actual end state, and the thing that makes werk a "check on it from anywhere" product rather than a desk tool. Almost certainly via someone else's pipe (ntfy, Pushover, a Slack/Discord webhook) rather than werk running push infrastructure. |

Bias strongly toward **one good outbound webhook plus a documented recipe** over
building integrations. werk running push notification infrastructure is a
different company.

---

## Programmatic

Later, but worth designing _toward_, because it is where werk stops being a
terminal tool and starts being infrastructure.

- **`--json` on every read command.** Free, and it makes werk composable with
  `jq` and with whatever the user already has. This one is not "later" — do it
  from the start.
- **An HTTP API**, agentapi-shaped: list workspaces, read a screen, send input,
  subscribe to events. The natural companion to `werk serve`, since the server is
  already doing all of it.
- **An MCP server.** The primary payload is `claude`; exposing werk over MCP lets
  one agent supervise a fleet of others — start a workspace, watch it, read what
  it said, answer it. This is an obvious and valuable second-order product, and
  it should fall out of the HTTP API rather than being built separately.

The design constraint that protects all of this: **build the semantic layer on
structured signals, not on screen-scraping.** agentapi's documented fragility is
that it diffs rendered text to find message boundaries and breaks whenever the
TUI changes. werk should expose the raw session faithfully first and layer
meaning on OSC 133 command boundaries, OSC 9;4 progress, OSC 7 cwd, and
notification/bell events — labelling anything heuristic as heuristic.

---

## Editor

The sixth promise says werk eventually reaches every coding agent, and a growing
share of them do not live in a terminal at all — VS Code's agent mode, Cursor,
Antigravity. Those users should get werk's actual value (a workspace somewhere
else, on its own branch, that outlives the window, alongside every other one in
the fleet) without being told to go and use a CLI instead.

The shape is a plugin per environment: pick a placement, `werk create`, and have
the editor's agent run _there_ rather than on the laptop, with the workspace's
files reachable and the fleet list visible in the editor.

What is genuinely undecided is how deep this goes. Two ends of the range:

- **Thin.** The plugin is a client of the same API `werk serve` exposes — create,
  list, attach, open a terminal — and the editor's agent runs in a werk workspace
  the same way any other process does.
- **Deep.** Per-environment integration with how that agent is actually
  launched and how it reports state, so "needs you" surfaces in the editor's own
  UI.

Same design constraint as everything else here: whatever depth we go to, it is
built on the API and the structured signals, so a new environment is a plugin
and not a fork.

## Desktop

Explicitly later, and explicitly _the web UI in a window_ rather than a separate
product. What a desktop shell adds over a browser tab:

- Real OS notifications without a browser permission dance.
- A tray/menubar presence — the fleet is glanceable without opening anything.
- Deep links (`werk://…`) and "open in my terminal" handoff.
- Launching at login, so the daemon and the server are just always there.

The thing to preserve now, at zero cost: **the web UI must not assume it is
served from the daemon's own origin.** If it talks to a documented API over a
configurable base URL, a desktop shell — and eventually a phone app — is a
packaging exercise rather than a rewrite.
