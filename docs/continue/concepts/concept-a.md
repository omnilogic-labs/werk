# Concept A — SUBSTRATE

**Lane:** The infrastructure primitive.

---

## 1. Concept name and positioning

**Codename:** SUBSTRATE

**Positioning statement:**

> werk is the layer between a process and a machine. It starts work somewhere, keeps a real terminal alive around it, and gets the commits back.

Short form for the page header: **werk. A process, and a way back to it.**

---

## 2. The strategic bet

SUBSTRATE wagers that the crowded end of this market is the wrong end. Forty tools wrap worktrees and tmux on one laptop and compete on features. werk instead claims a boundary nobody has claimed: the seam between a process and the machine it runs on. Own the seam and the features are downstream.

It wins the senior engineer who already runs three machines and resents every one of them being a different workflow. That person adopts it alone, on a Tuesday, because one binary over ssh is obviously less work than what they do now. It spreads because it already spans machines: the second developer is a config line, not a purchase.

What it gives up: warmth, delight, any hope of a viral demo, and the whole non-technical buyer. It will look austere next to a kanban board of agents, and it will lose deals to screenshots.

---

## 3. Brand expression

### Wordmark

Always `werk`. Lowercase in every position, including the start of a sentence and the start of a headline. No capital W exists.

Set in **IBM Plex Mono, weight 600**, `letter-spacing: 0` and `font-feature-settings: "ss02"` off. The point of the mono setting is dimensional: at zero tracking the wordmark is exactly four character cells wide, so `width: 4ch` holds true at any size. The wordmark fits in a terminal. That is the whole idea and it should be stated in the brand guide in those words.

```css
.wordmark {
  font-family: "IBM Plex Mono", ui-monospace, SFMono-Regular, monospace;
  font-weight: 600;
  font-size: 1rem;
  letter-spacing: 0;
  line-height: 1;
  text-transform: lowercase;
  color: var(--ink);
  font-variant-ligatures: none;
}
```

Lockup: the mark sits left of the wordmark, separated by exactly one character cell (`1ch`), with both aligned on the wordmark's baseline. The mark's height equals the cap height of the `k`, not the ascender. No tagline is ever locked up with the wordmark; taglines are set separately in IBM Plex Sans.

Never: outlined, gradiented, animated, italicised, tracked out, set in a circle, or given a full stop.

### Symbol / mark

A construction on a 24 × 24 grid. The unit is a monospace cell: 8 units wide, 14 units tall.

1. **Cell A**, solid: a rectangle 8 × 14, top-left at (1, 2). Filled Ink. This is a process.
2. **Cell B**, hollow: a rectangle 8 × 14, top-left at (15, 8), stroked at 2 units, no fill. Same process, different machine.
3. **The seam**: a 2-unit horizontal rule from (9, 15) to (15, 15), joining A's lower-right region to B's upper-left corner. It is the only diagonal-free connection between them and it is drawn in Signal.

The two cells are offset by exactly one cell width horizontally and half a cell height vertically. The offset is the mark: the same thing, displaced, still connected. At 16px the seam thickens to 3 units so it survives; below 16px the mark is used solid-Ink monochrome with the seam knocked out in the background colour.

The mark tiles: repeating it at 24-unit intervals produces a lattice with a continuous horizontal seam running through it, which is the favicon-to-billboard scaling path.

### Colour palette

Restrained by design. Four neutrals carry the page; four semantic colours exist only to say what a workspace is doing. No colour is decorative.

**Light mode**

| Name      | Hex       | Role                                                                 |
| --------- | --------- | -------------------------------------------------------------------- |
| Ink       | `#0D1117` | Primary text, wordmark, mark fill, terminal foreground               |
| Graphite  | `#414B57` | Secondary text, captions, table headers, inactive UI                 |
| Hairline  | `#DDE1E6` | 1px rules, table borders, terminal chrome, card edges                |
| Paper     | `#F6F6F4` | Page background. Cards and terminal blocks sit on `#FFFFFF` above it |
| Signal    | `#1B5FD9` | Links, primary button, the seam in the mark, "attached" state        |
| Ready     | `#14805C` | Running cleanly, tests passing, commits pushed                       |
| Attention | `#B0761A` | "Needs you". Bell, OSC 9, a prompt waiting on an answer              |
| Fault     | `#B23A32` | Detached unexpectedly, exited non-zero, unpushed work at risk        |

**Dark mode**

| Token         | Light     | Dark      | Role                            |
| ------------- | --------- | --------- | ------------------------------- |
| `--ink`       | `#0D1117` | `#E9EBEE` | Primary text                    |
| `--graphite`  | `#414B57` | `#98A2AE` | Secondary text                  |
| `--hairline`  | `#DDE1E6` | `#252B33` | Rules and borders               |
| `--paper`     | `#F6F6F4` | `#0B0E12` | Page background                 |
| `--surface`   | `#FFFFFF` | `#12161C` | Cards, terminal blocks          |
| `--signal`    | `#1B5FD9` | `#6EA8FF` | Links, primary action, attached |
| `--ready`     | `#14805C` | `#3FBF8F` | Running, clean                  |
| `--attention` | `#B0761A` | `#E0A83C` | Needs you                       |
| `--fault`     | `#B23A32` | `#F0736A` | Failed, at risk                 |

Contrast: every semantic colour is specified against `--surface`, not `--paper`, and all four clear 4.5:1 in both modes at 14px and above. Status is never colour alone; the list always carries a word (`running`, `needs you`, `idle`, `failed`) beside the dot.

### Typography

All three families are on Google Fonts, all three are one superfamily, which is the point: the page and the terminal are the same typographic system.

| Family                      | Weights       | Role                                                                                                                                                                                                                     |
| --------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **IBM Plex Mono**           | 400, 600      | The wordmark. Every terminal transcript. Eyebrows, section numbers, command names, flags, branch names, hostnames, and any value that is literally typed. 400 for transcripts, 600 for the wordmark and inline commands. |
| **IBM Plex Sans**           | 400, 500, 600 | Headlines at 600, body at 400, buttons and table headers at 500. Headlines set at `letter-spacing: -0.015em`, body at 0, line-height 1.55. Nothing above 56px.                                                           |
| **IBM Plex Sans Condensed** | 500           | Dense tabular UI only: the workspace list's column headers and metadata columns, where a real fleet list needs six columns in 720px. Never used in prose.                                                                |

Scale: 13 / 14 / 16 / 20 / 26 / 34 / 44. Body is 16. The terminal block is 14. Nothing on the page is set below 13.

Rule: if a reader could type a string into a shell, it is set in Mono. If they could not, it is set in Sans. There is no third case.

### Voice: five rules

**1. State the mechanism, not the benefit.**
We say: "werk copies itself over the ssh connection it already has. There is nothing to install on the remote."
We don't say: "werk makes remote development effortless."

**2. Name the failure before someone else does.**
We say: "A container destroyed with unpushed commits is a catastrophic bug, not an edge case. We treat it as one."
We don't say: "werk keeps your work safe."

**3. Say what is built and what is not, in the same breath, without hedging the built part.**
We say: "The terminal and `werk serve` work today. Hosted, shared links and the team portal are not built yet."
We don't say: "werk is building the future of distributed development."

**4. Prefer the smaller claim.**
We say: "werk answers two questions: which of these needs me, and what is that one doing."
We don't say: "werk gives you complete visibility across your entire engineering organisation."

**5. Never perform enthusiasm.**
We say: "Placement is a parameter. `--on mac-mini` and `--on k8s/prod-eu` are the same command."
We don't say: "Run anywhere. Seriously, anywhere. It's wild."

Mechanical rules: no exclamation marks anywhere, ever. No "just", "simply", "effortless", "seamless", "revolutionise", "game-changing", "supercharge". British spelling. Second person for instructions, first person plural only when we are taking responsibility for something.

---

## 4. Five candidate taglines, ranked

**1. Placement is a parameter.**
The strongest thing werk can say, because it is a technical claim rather than a promise, and it is the one claim the forty competing tools cannot make. It flatters the reader by assuming they know what a parameter is. Risk: it needs the next sentence to pay off, so it cannot stand alone on a billboard.

**2. A process, and a way back to it.**
Reduces the product to its irreducible unit. Reads like a definition, which is exactly the register of a primitive. Slightly cool, and it undersells the fleet view, but it will still be true in five years.

**3. The layer between a process and a machine.**
Explicitly claims the Tailscale-shaped position. Clearest to an infrastructure-literate reader, and the best line for an investor or a staff engineer. Fails as a headline because it describes a category rather than doing anything.

**4. Run it somewhere. Come back to it.**
The most immediately understood, and the best line for the top of the page. Loses because "somewhere" is doing too much unspoken work and the sentence could describe a job queue, a CI runner or a screen session.

**5. Nothing to install on the far end.**
A real differentiator and a genuine relief for anyone who has bootstrapped a dev environment on a stranger's box. Too narrow to lead with: it is a feature line, not a position, and it says nothing about the fleet.

---

## 5. Pitch-page copy

### Hero

**Headline**
`werk` starts a process somewhere and lets you come back to it.

**Subhead**
A workspace on any machine you can reach: a real terminal that survives your laptop closing, a fresh branch, your repo, and the commits back when it is done.

**Buttons**

- Primary: `Install werk`
- Secondary: `Read how it works`

---

### Terminal demo block

```
$ werk create --on mac-mini -- claude

  workspace    plum-harbor
  placement    mac-mini · ssh · 192.168.1.42
  branch       werk/plum-harbor  from main @ 4f2a9c1
  transfer     werk 1 file 18.4 MB  2.1s   (nothing else installed)
  session      attached · detach with ctrl-\ d

  ~/plum-harbor $ claude
  ▌

$ werk

  WORKSPACE      PLACEMENT              BRANCH              STATE       DETAIL
● plum-harbor    mac-mini · ssh         werk/plum-harbor    needs you   bell 41s ago
● dusty-canyon   this machine           werk/dusty-canyon   running     +412 −37 · 3 commits
● cold-anvil     docker · werk-a19f2c   werk/cold-anvil     running     test suite · 6m04s
● slow-orbit     k8s · prod-eu/werk-7b  werk/slow-orbit     idle        clean · pushed 2h ago

  4 workspaces · 4 placements · 1 needs you
  werk open plum-harbor
```

Rendered treatment: `plum-harbor`'s dot in Attention, `dusty-canyon` and `cold-anvil` in Ready, `slow-orbit` in Graphite, the `werk open plum-harbor` line in Signal. Column headers in IBM Plex Sans Condensed 500, everything else IBM Plex Mono 400. No animation beyond a single blinking block cursor.

---

### The problem

**Heading: Your work is on four machines and none of them can see each other.**

**Block 1 — The session dies with the lid.**
You ssh in, start something long, and close your laptop. The connection drops and the process goes with it. So you learn tmux, and now you have a different tmux on every host, none of which knows the others exist.

**Block 2 — You do not know what is running.**
An agent is working on the Mac mini. Another is in a container. A third is on a VPS you set up in March. Finding out which one is stuck means four connections, four multiplexers and four sets of muscle memory.

**Block 3 — The code gets stranded.**
Work happens on a machine, and then it has to get back. Branches made by hand, commits nobody pushed, a container torn down at 2am with an afternoon inside it. This is the part that actually costs you something.

---

### How it works

**Heading: Four stages, one command each.**

**1. Tell werk where work should happen.**
The Mac mini on your desk. A VPS. A container werk provisions. Your company's Kubernetes cluster. You register a placement once and refer to it by name from then on.

**2. Dispatch from your own terminal.**
`werk create` makes a workspace: somewhere to run, a fresh git branch, your repository seeded there, and a terminal session that keeps running after your shell, your network and your laptop have all gone away.

**3. Monitor.**
`werk` with no arguments prints one live list of every workspace on every machine. It is built to answer two questions and no others: which of these needs me, and what is that one doing right now.

**4. Get the work back.**
werk made the branch, so werk knows where the commits belong. It gets the code there and it gets the commits back. Unpushed work in a workspace about to be destroyed is treated as a bug in werk, not as your problem.

---

### Placement is a parameter

**Heading: Placement is a parameter, not an architecture.**

Most tools in this space are laptop tools that later grew a remote mode, and it shows: the remote path has different commands, a different UI and different failure modes. werk was built the other way round. Where a workspace runs is an argument you pass. `--on this-machine` and `--on k8s/prod-eu` produce the same object, listed in the same list, opened with the same command, torn down the same way.

There is nothing to install on the far end. werk is one self-contained binary with no runtime, no Node, no package manager and no dependencies, so it copies itself over the ssh connection you already have and runs. If you can ssh there, you can put work there.

| Placement     | What you pass       | What werk does                                                                  | What you needed first           |
| ------------- | ------------------- | ------------------------------------------------------------------------------- | ------------------------------- |
| **Local**     | `--on this-machine` | Runs the workspace on the machine in front of you, under the same daemon        | Nothing                         |
| **SSH**       | `--on mac-mini`     | Copies the werk binary over your existing ssh connection and runs it there      | An ssh key that already works   |
| **Container** | `--on docker`       | Provisions a container, seeds the repo, keeps the terminal outside its lifetime | A container runtime             |
| **Cluster**   | `--on k8s/prod-eu`  | Schedules the workspace as a pod and attaches to it like any other placement    | A kubeconfig that already works |

The list is the same list. The terminal is the same terminal. That is the entire claim.

---

### The reach ladder

**Heading: Start in your shell. Climb only as far as you need.**

**1. Terminal.**
`werk open` puts you back in a running session from whatever shell you are sitting in, with real terminal state and full scrollback, on whichever machine it happens to be running on.

**2. `werk serve`.**
Run the server on your own machine and open a browser. Every terminal process, everywhere, on one page. Type into any of them. Watch four at once. Close the tab and nothing stops.

**3. Hosted.**
The same view from a phone on a train or a borrowed desk, hosted by us or run yourself. This is the rung where security stops being a footnote and becomes the product. Not built yet.

**4. Shared.**
Hand a colleague a live link to one of your terminals. They see the session as it is, and type in it if you allow it. No screen share, no recording, no meeting. Not built yet.

**5. Team portal.**
Every agent session in the company on one page. A CTO opens it and drills into any single terminal, live, at the keystroke. Not a dashboard of what happened. The thing itself, still running. Not built yet.

---

### Every agent, no integration

**Heading: Every agent, no integration.**

The workload that matters right now is coding agents, and the useful accident is that all of them are command-line programs. Claude Code, Codex, Gemini CLI, Aider: werk dispatches and monitors them the same way it dispatches and monitors `make`, because to werk they are all just processes attached to a terminal.

There is no per-agent adapter, no plugin directory and no supported-tools table that goes stale. werk reads the signals any well-behaved terminal program already emits: the bell for attention, OSC 9 and OSC 777 for notifications, OSC 9;4 for progress, OSC 133 for prompt and command boundaries. An agent released next Tuesday needs no werk release to show up correctly in your list on Tuesday.

The terminal is one of the two universal interfaces to a repository. git is the other. werk is built on both, on purpose, because they are the only two things every human and every agent already agree on.

---

### Trust and security

**Heading: What we can honestly claim today.**

Right now werk runs where you already have access. Over ssh it uses your existing keys and your existing config, and it adds no new authentication surface, no broker and no account. `werk serve` binds on your own machine. If werk vanished tomorrow, your work would still be on the branches werk pushed, in the repository you already had.

The upper rungs of the ladder change that, and we would rather say so plainly than discover it in a postmortem. Hosted access means a live terminal reachable from the public internet, and a shared link means a live terminal reachable by someone who is not you. Those are the two places where the security model has to be exact: how a link is scoped, how it expires, whether input is allowed as well as output, and what a company can see about its own developers. They are not built yet, and we are not going to ship them by writing "end-to-end encrypted" on a page and hoping.

The design questions are open in public in the repository. If you want to argue with them before they are decided, now is the useful time.

---

### Closing CTA

**Heading: One binary. Try it against a machine you already have.**

Install werk on your laptop and register one placement you can already ssh to. Run `werk create` and put a coding agent on it. Close your laptop, go somewhere, come back, and run `werk`. Either the session is still there and the list tells you what happened while you were gone, or it is not and you have spent four minutes finding that out. That is the whole evaluation, and it is deliberately short.

**Button:** `Install werk`

---

### FAQ

**Isn't this just tmux?**
For one machine, mostly yes, and tmux is excellent. The difference starts at the second machine. tmux has no idea another tmux exists, so a fleet of long-running sessions across a laptop, a VPS and a cluster is a fleet you have to hold in your head. werk keeps one list across all of them, creates the branch, seeds the repo and gets the commits back, and it has a browser view when a terminal is not where you are. If you only ever work on one box and never need the web view, tmux is the right answer and we will not pretend otherwise.

**What actually has to be installed on the remote machine?**
Nothing. werk is a single self-contained binary with no runtime and no package manager, so it copies itself over the ssh connection you already have and runs. The remote needs a shell and git. It does not need Node, Python, Docker, a daemon you install by hand, or an agent process you have to keep updated.

**What happens to my commits if a container is destroyed?**
werk created the branch, so it knows where the commits belong and it pushes them. We treat a workspace that disappears with unpushed work as a catastrophic bug rather than an edge case, which means it is a thing we test for rather than a thing we document a workaround for. If you find a way to lose commits through werk, that is the bug report we want most.

**Why should I trust a terminal that is being reconstructed in a browser?**
Because it is not being reconstructed. The session daemon is built on libghostty's snapshot format, so what you attach to is real terminal state, scrollback and all, rather than a byte log replayed into an emulator that hopes it got the escape sequences right. That distinction stops mattering the moment you attach to a full-screen TUI mid-render, which is exactly what a coding agent is.

---

## 6. Image briefs

**BRIEF-1-HERO**

A single continuous horizontal seam of pale blue light running edge to edge across the lower third of the frame, where two vast planes of matte off-white concrete meet at a precisely machined joint, photographed straight on with a long lens so the surfaces are almost perfectly flat and the perspective is nearly orthographic. The upper plane is the near-white of paper, the lower plane a cooler grey, and the light in the seam is a saturated cobalt. Soft, even, overcast daylight with no visible source and no hard shadow. Calm, exact, load-bearing, like a well-made structural detail nobody was meant to notice. No text, letters, words, numbers or labels anywhere.

**BRIEF-2-MARK**

A perfectly square composition on a flat, uniform near-black ground, showing two identical upright rectangular blocks of the same tall narrow proportion, one solid pale bone-white and positioned upper left, the other rendered only as a thin bone-white outline and positioned lower right, offset from the first by exactly its own width and half its own height. A single thin horizontal line of cobalt blue connects the lower edge of the solid block to the upper corner of the outlined one. Flat, shadowless, absolutely even lighting, like a printed diagram or a machined stencil. Severe, geometric, quiet. No text, letters, words, numbers or labels anywhere.

**BRIEF-3-LADDER**

An aerial night photograph of a wide dark landscape, taken from very high up and looking almost straight down, in which five isolated points of warm amber light sit at increasing distances from the lower left corner towards the upper right, each one slightly larger and brighter than the last, connected by faint threads of cool blue that are only just visible against the near-black terrain. The ground reads as deep ink with cold grey ridges. Long-exposure clarity, no haze, no moon, no visible horizon. Vast, still, and quietly connected rather than lonely. No text, letters, words, numbers or labels anywhere.

---

## 7. The strongest objection to this concept

Primitives earn their status by being adopted, not by claiming it. Tailscale said "just a network" after it worked; saying it first reads as a positioning exercise, and this audience is trained to spot one. Meanwhile the austerity throws away the demo that actually sells this product: four agents working at once, visible on one screen. We may win the argument and lose the download.
