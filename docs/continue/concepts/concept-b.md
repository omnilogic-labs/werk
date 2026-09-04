# Concept B: MISSION CONTROL

## 1. Concept name and positioning

**Concept name: FLIGHT DECK**

**Positioning line:** werk is the flight deck for your agent fleet: every terminal, on every machine, on one live board, so you always know which one needs you.

---

## 2. The strategic bet

This concept wagers that the pain has already moved. Running one coding agent is solved by forty tools. Running twelve, across a laptop, a VPS, a container and a cluster, is not, and cross-machine terminal fleet dashboards are essentially unbuilt. We bet on the reader who has passed the threshold: the tech lead with eleven terminal tabs who cannot say which agent is stuck.

They win first because they feel the cost daily. It spreads upward, not sideways: the lead who runs the board wants their team on it, and the team portal is the thing a CTO buys. Fleet awareness is a wedge with a paid ceiling above it.

What it gives up: the solo developer running one agent in one repo, who will find this heavy and over-specified. It also stakes the brand on a hero rung we have not built yet, which raises the cost of being slow.

---

## 3. Brand expression

### Wordmark

`werk` is always lowercase, never capitalised, never spaced out, never a logotype with a tail or a swash.

Precise construction:

- Family: **Space Grotesk**, weight **700**
- `text-transform: none`, always literal lowercase
- `letter-spacing: -0.025em`
- `font-feature-settings: "ss01"` where available, for the single-storey `k`
- Colour: **Signal `#E6EDF5`** on dark, **Ink `#0B1219`** on light
- Followed by a **status dot**: a square of `0.28em`, `border-radius: 1px`, set `0.32em` after the `k`, baseline-aligned to the x-height midpoint

The dot is the whole idea. It is not decoration: in any live surface (the TUI header, the web UI tab, the favicon, the menu bar) the dot carries the colour of the most urgent session in your fleet. Amber means something is waiting for you. On static print and on the marketing page the dot is **Running `#2DD4A0`**. Never animate the dot on a static page; it may pulse only when it is showing real state.

Lockup rules: minimum clear space equal to the cap height of the `w` on all four sides. Never place the wordmark on a photograph without a solid plate behind it. There is no capitalised "Werk" and no all-caps "WERK".

### Symbol / mark

**The Lattice.** A geometric construction on a 24-unit square artboard.

1. Lay a 4 by 4 lattice of cells inside the artboard. Each cell is a 3-unit square with a 1-unit corner radius.
2. Pitch is 5 units. Cell origins sit at x and y in {2, 7, 12, 17}. The lattice therefore spans units 2 to 20, leaving a 4-unit optical margin on the right and bottom and 2 units top and left. Nudge the whole lattice by +1 unit on x and y to centre it optically.
3. Fifteen cells are drawn as 1-unit strokes in **Rule `#1B2430`** with no fill.
4. One cell, at row 2 column 3 (origin 12, 7), is drawn as a solid fill in **Needs you `#FFB224`** and scaled to 1.35 times about its own centre, so it breaks the lattice rhythm.
5. Optional motion, live surfaces only: a 1-unit vertical bar in **Vector `#22D3EE`** at 30 per cent opacity sweeps left to right across the artboard over 2.4 seconds, easing linearly, then rests for 1.6 seconds.

The mark reads at 16 pixels because at that size the grey lattice collapses to texture and only the amber cell survives, which is exactly the message: a fleet, and the one in it that wants you. Monochrome fallback: the fifteen cells at 40 per cent opacity, the one cell at 100 per cent.

### Colour: dark set (primary)

| Name        | Hex       | Role                                                                               |
| ----------- | --------- | ---------------------------------------------------------------------------------- |
| **Deck**    | `#06080B` | Page ground. The room with the lights down.                                        |
| **Hull**    | `#0E131A` | Panel and card surfaces, the board's own background, sticky header.                |
| **Rule**    | `#1B2430` | Hairlines, table rules, panel borders, the unlit cells of the mark.                |
| **Signal**  | `#E6EDF5` | Primary type: headings, row values, anything you read to make a decision.          |
| **Readout** | `#8794A6` | Secondary type: column labels, elapsed times, placement strings, help text.        |
| **Vector**  | `#22D3EE` | The one interactive accent. Links, focus rings, selected row, primary button fill. |
| **Ion**     | `#7C5CFF` | Second accent, used sparingly: the team portal rung, chart series, large display.  |

### Colour: status palette

Status is a closed vocabulary. Four states, four colours, and no other colour in the product is allowed to imitate them.

| State         | Hex       | Glyph                | Meaning                                           |
| ------------- | --------- | -------------------- | ------------------------------------------------- |
| **Running**   | `#2DD4A0` | Filled dot           | Working. Output is moving.                        |
| **Needs you** | `#FFB224` | Filled dot with ring | It asked a question, or it is blocked on you.     |
| **Idle**      | `#5C6B7E` | Hollow dot           | Alive, no output for a while. Possibly forgotten. |
| **Failed**    | `#FF4D57` | Filled square        | Exited non-zero, or the process is gone.          |

Finished-and-clean uses **Running `#2DD4A0`** with a hollow ring glyph and the label "done". It is deliberately the same hue: a clean finish is good news, and good news should not need a fifth colour.

**Contrast reasoning.** Signal on Deck is roughly 17:1, far above the 4.5:1 floor, because the board is read at a glance and often at a distance. Readout on Deck is roughly 6.5:1, comfortably legible but visibly subordinate, so scanning a column of times never competes with scanning a column of statuses. Against Hull, Needs you is about 10:1, Running about 9.8:1 and Failed about 5.7:1: all pass for normal text. Idle is about 3.4:1, deliberately below the text floor, which is why idle is the one state that is never carried by colour alone. It always appears as glyph plus the word "idle" set in Readout. Vector is about 11:1 on Deck and is reserved for interaction so that no accent ever gets confused for a state. Ion is about 4.6:1 on Deck and is therefore restricted to graphics and display sizes, never body text. Every status is redundantly encoded by glyph and word, so the board survives greyscale, projection and colour blindness.

### Colour: light set (variant)

| Name           | Hex       | Role                                    |
| -------------- | --------- | --------------------------------------- |
| **Paper**      | `#F7F9FB` | Page ground                             |
| **Card**       | `#FFFFFF` | Panel and board surface                 |
| **Rule Light** | `#DCE3EB` | Hairlines and table rules               |
| **Ink**        | `#0B1219` | Primary type                            |
| **Ink Muted**  | `#55637A` | Secondary type                          |
| **Vector D**   | `#0E7C93` | Interactive accent, about 4.9:1 on Card |
| **Ion D**      | `#5A3FD6` | Second accent                           |

Light status set, all darkened to clear 4.5:1 on Card: Running `#0E8A63`, Needs you `#9A5B00`, Idle `#66748A`, Failed `#C42430`. The glyph vocabulary does not change between modes.

### Typography

All three families are on Google Fonts.

| Family             | Weights       | Role                                                                                                              |
| ------------------ | ------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Space Grotesk**  | 500, 700      | Wordmark, page headings, section headings, large numerals in stat blocks. Set headings at `-0.02em` tracking.     |
| **Inter**          | 400, 500, 600 | Body copy, buttons, FAQ, navigation. Column labels use Inter 600, uppercase, `0.08em` tracking, 11px, in Readout. |
| **JetBrains Mono** | 400, 500, 700 | The board itself. Workspace names, placement strings, repo paths, elapsed times, status words, commands, code.    |

The rule that makes the brand: **anything the system knows is set in mono, anything we are telling you is set in Inter or Space Grotesk.** A reader can tell fact from marketing by the shape of the letters. Elapsed times use `font-variant-numeric: tabular-nums` so the column does not jitter as it ticks.

### Voice: five rules

**1. Open with the reader's own question, not our category.**
We say: "Which one needs you?"
We don't say: "Unified observability for agentic development workflows."

**2. Count things. Numbers are the texture of this brand.**
We say: "Eight sessions, four machines, two of them want you."
We don't say: "Manage your agents at scale with powerful multi-session controls."

**3. Use the status vocabulary exactly, and never blur it.**
We say: "An agent has been waiting 41 minutes for an answer."
We don't say: "You might have something that needs looking at."

**4. Kinetic, not breathless. This is a control room, not a launch party.**
We say: "The board updates live. Nothing else about your setup changes."
We don't say: "Supercharge your fleet and unleash 10x parallel velocity."

**5. Mark the roadmap as roadmap, every time.**
We say: "Reattach from your own terminal today. The team portal is where this is going."
We don't say: "Every CTO gets a live wall of the whole company."

---

## 4. Five candidate taglines, ranked

1. **Know which one needs you.**
   The strongest. It states the product's actual job in five words, it presumes a fleet without arguing for one, and "needs you" is the emotional pivot from anxiety to command. Weakness: it is quiet, and it does not say the word "machines".

2. **One board. Every machine. Live.**
   Says the differentiator out loud, which matters when the crowded local-only tools all sound the same. Weakness: it describes the artefact rather than the relief, so it works better as a subhead than as the line on a shirt.

3. **You are not running an agent. You are running a fleet.**
   Reframes the reader's own situation and creates the category the product sits in. Weakness: it is a sentence, not a mark, and it slightly scolds.

4. **The room you watch them from.**
   Carries the entire mission control feeling in six words and is the most memorable of the five. Weakness: on its own it does not tell a cold reader what the software does, so it needs the subhead to carry the load.

5. **Twelve agents. Four machines. One screen.**
   Concrete and instantly legible. Weakness: the numbers date fast and a reader running three agents reads it as "not for me", which is the wrong door to close.

---

## 5. Pitch page copy

### Hero

**Headline:** Twelve agents. Four machines. One board.

**Subhead:** werk starts terminal sessions wherever you want them and puts every one of them on a single live board, so you always know which one needs you.

**Buttons:** `Install werk` · `Tour the board`

---

### The live fleet board

Caption above the table: **Running now. Eight sessions, four machines, two want you.**

| Repo               | Workspace          | Placement             | Status        | Running                                    | Elapsed |
| ------------------ | ------------------ | --------------------- | ------------- | ------------------------------------------ | ------- |
| acme/checkout      | `payments-retry`   | `local`               | **needs you** | Claude Code, waiting on a question         | 41m 18s |
| acme/platform      | `pg17-migration`   | `k8s eu-build/pool-2` | **failed**    | `bun run migrate` exited 1                 | 3m 41s  |
| acme/checkout      | `webhook-tests`    | `ssh orbit-01`        | **running**   | `bun test`, 214 of 380                     | 6m 52s  |
| acme/platform      | `rate-limit-redis` | `docker werk-a3f7`    | **running**   | Codex, editing 11 files                    | 22m 09s |
| acme/checkout      | `cart-perf-spike`  | `ssh orbit-01`        | **running**   | Aider, profiling the render path           | 1h 04m  |
| acme/platform      | `flaky-e2e-hunt`   | `k8s eu-build/pool-1` | **running**   | Gemini CLI, repeat run 7 of 20             | 38m 22s |
| acme/design-system | `token-rename`     | `local`               | **idle**      | shell, no output for 18m                   | 2h 37m  |
| acme/infra         | `terraform-drift`  | `docker werk-91c2`    | **done**      | `terraform plan` exited 0, 3 commits ready | 9m 58s  |

Caption below the table: **Press a row number to open it. You are typing into that terminal, on that machine, in under a second.**

---

### The problem

**Heading: Parallelism arrived. The cockpit did not.**

**Tabs are not a fleet view.**
You started three agents this morning and two more after lunch. They are spread across your laptop, a box you ssh into and a container you provisioned on Tuesday. The only index of them is your memory, and your memory is wrong.

**The expensive state is silence.**
An agent that finished is fine. An agent that failed is fine, you will find it. The one that costs you an hour is the one that asked a polite question at 10:14 and has been sitting still ever since, while you assumed it was working.

**Nobody knows what the team is running.**
Multiply one engineer's five sessions by a team of twelve. There is no list. There is no way to answer "what is everyone's agent doing right now" other than asking everyone, one at a time, in Slack.

---

### How it works

**Heading: Four moves, and you are running a fleet.**

**1. Say where work happens.**
Your Mac mini on the desk, a VPS, a container werk provisions, your company's Kubernetes cluster. Placement is a parameter, not an architecture. The same command and the same board, wherever the work lands.

**2. Dispatch from your own terminal.**
`werk create` builds a workspace: a place to run, a fresh git branch, your repo seeded there, and a terminal that keeps running when you shut the laptop. One self-contained binary, nothing to install on the remote.

**3. Watch the board.**
`werk` with no arguments prints every workspace on every machine, live. It is built to answer two questions and no others: which of these needs me, and what is that one doing right now.

**4. Get the work back.**
werk made the branch, put the code there and brings the commits home. A container destroyed with unpushed commits is a catastrophic bug in werk, not an edge case in your workflow. Getting the work back is the product.

---

### Which one needs me?

**Heading: werk can tell "thinking" from "asking you a question".**

It does it without a single per-agent integration, because it does not watch the agent. It watches the terminal.

Well-behaved command-line programs already announce themselves. The bell tells werk something wants attention. OSC 9 and OSC 777 carry desktop notifications. OSC 9;4 reports progress. OSC 133 marks where one command ends, the next begins, and what the exit status was. Read those together and the difference between running, finished, failed and waiting on a human stops being a guess.

The consequence is the part worth caring about: an agent released next month, by a company that has never heard of us, shows up correctly on your board on the day you install it. No plugin, no adapter, no werk release. If it behaves like a terminal program, werk already understands it.

---

### The reach ladder

**Heading: Start in your own shell. Finish with the whole company on one wall.**

**1. Terminal.**
Reattach to any running session from the shell you are already in. Real terminal state, scrollback and all, so coming back is pixel-exact rather than a replayed log that lost the last screen.

**2. `werk serve`.**
Run it on your own machine and open a browser. Every terminal process, everywhere, on one page. Watch four at once, type into any of them, close the tab when you are done. Nothing is hosted.

**3. Hosted, by us or by you.**
The same board from anywhere: your phone on a train, a second workstation, another continent. Answer the agent that has been waiting 40 minutes without walking back to your desk. Security matters most at this rung.

**4. Shared.**
Hand a colleague a live link to one terminal. They see what you see, in real time, and they can type. Debugging together stops being a screen share and becomes a place both of you are standing.

**5. The team portal.**
Every session, every engineer, every machine in the company, on one live wall. Not a report written overnight. The actual terminals, this second, open to anyone with the standing to look. This is where werk is going.

---

### The wall

**Heading: The wall.**

Twelve engineers running five agents each is sixty terminals nobody can see. The team portal makes that one screen: every session in the company, grouped by team or repo or machine, colour-coded by state, live. A CTO opens it and reads the shape of the whole floor in three seconds. Then they drill into a single session and watch the actual terminal, scrollback and all, as it runs. Not a dashboard summarising work. The work itself, legible from across the room. This rung is roadmap, and it is the reason the rest of the ladder is built the way it is.

- **Fleet at a glance.** Every session in the org on one board, filtered by team, repo, machine or state, with the ones that need a human floated to the top.
- **Drill to the terminal.** Click any tile and you are looking at the live session, exact terminal state rather than a summary, with the same reattach that the CLI gives you.
- **Spend and sprawl, visible.** Which machines are busy, which containers have been running for eleven hours, which workspaces hold commits that were never pushed.

---

### Trust and security

**Heading: A live window into everyone's terminals is a serious thing.**

We would rather be straight about this than boastful. A tool that can show a manager a running terminal is a tool that can be misused, and building it well means building the limits at the same time as the view.

What we hold to be non-negotiable. Placement is yours: run everything locally or self-host the whole thing and nothing leaves your infrastructure. `werk serve` on your own machine involves no account, no cloud and no third party. Access is per session, not per person: being able to see that a session exists is a different permission from being able to read its scrollback, which is different again from being able to type into it. Nothing is silently observed. If someone is watching one of your sessions, that fact belongs on your screen, visibly, while it is happening.

What is still open. Retention, audit logging, how long scrollback lives on a hosted rung, and where the line sits between a team lead's legitimate need to see a stuck agent and an engineer's terminal being their own workspace. These are design questions we are working through rather than solved problems, and we would rather say so now than discover your position on them after you have installed it.

---

### Closing

**Heading: You already have a fleet. Get the board.**

One binary, no runtime, nothing to install on the far end. Point it at your laptop, a box you ssh into, a container or a cluster, and the command and the board are identical in all four places. Start one workspace this afternoon, run `werk` with no arguments tomorrow morning, and see how many things were quietly waiting for you.

**Button:** `Install werk`

---

### FAQ

**Do I need to be running twelve agents for this to be worth it?**
No, but you need more than one. With a single agent in a single repo, a terminal and a tmux session are genuinely enough, and we will not pretend otherwise. werk starts paying at the point where your sessions outnumber the tabs you can hold in your head, or the moment one of them lives on a machine that is not the one in front of you.

**Does werk need to support my agent?**
No. werk reads the signals any well-behaved terminal program already emits: bell, OSC 9 and 777 notifications, OSC 9;4 progress, OSC 133 command boundaries and exit status. Claude Code, Codex, Gemini CLI and Aider are all just command-line programs. An agent that ships next month works on the day you install it, with no release from us.

**What happens to my commits if a container is destroyed?**
werk creates the branch, seeds the repo and brings the commits back, and we treat losing them as a catastrophic bug rather than an edge case. Getting work back is not a feature bolted onto the side of the dashboard. It is half of what the product is for, and the board exists partly so that a workspace holding unpushed commits is something you can see rather than something you remember.

---

## 6. Image briefs

**BRIEF-1-HERO**
A wide, dark operations room photographed from just behind and slightly above a single seated figure, shot from the back so no face is visible. The figure occupies the lower left third; the rest of the frame is a gently curved wall of glowing rectangular panels arranged in a dense grid, each panel a flat block of colour with no content, no markings and nothing resembling writing. Most panels glow a cool teal-green, a few sit dim slate grey, and exactly two burn warm amber, drawing the eye instantly. The room is otherwise near black, lit only by the wall and a faint cyan spill across the desk. Cinematic, calm, enormous, under control.

**BRIEF-2-MARK**
A single logo tile centred in a square frame on a solid near-black background, almost the colour of wet slate. The subject is a precise four by four lattice of small rounded squares floating a few millimetres above the surface, evenly spaced, catching a soft rim light along their top edges. Fifteen of them are thin dark outlines, barely brighter than the ground. One square, in the second row toward the right, is solid warm amber, slightly larger than its neighbours, and casts a faint glow onto the surface beneath it. Flat, frontal, symmetrical, no perspective distortion. Absolutely no text, letters, numbers or markings anywhere.

**BRIEF-3-WALL**
A vast dark control hall seen from the very back of the room, wide and slightly elevated, with three tiers of low desks descending toward an immense curved display wall that fills the upper two thirds of the frame. The wall is a mosaic of hundreds of small glowing rectangles in flat colour only: fields of cool green, patches of slate grey, and a scattering of warm amber tiles that pull the eye across the surface. A dozen small human silhouettes sit in the tiers, backlit and anonymous. Cyan reflections streak the polished floor. Monumental, quiet, purposeful, the mood of a night shift running perfectly. No text or symbols of any kind.

---

## 7. The strongest objection

It sells the rung we have not built. The hero is a company-wide wall and a CTO drilldown, while what exists today is a CLI and a local board. A tech lead who installs it on the strength of the wall arrives at a good single-user tool and feels the gap. It also assumes fleets are already normal; most readers still run two agents, look at the board, and conclude they are not the customer.
