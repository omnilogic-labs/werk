# Lane D — THE SYSTEM OF RECORD FOR AGENT LABOUR

## 1. Concept name and positioning

**Concept name: THE LEDGER.**

**One-line positioning:** werk is the system of record for agent labour: every agent session placed deliberately, run on a branch, attributed to a person and a repository, and recoverable afterwards.

---

## 2. The strategic bet (150 words)

This wagers that the scarce thing in 2026 is not another local worktree manager but an account of what the agents did. Forty tools already run tmux next to a git worktree. None of them can tell a CTO what is running across the company right now.

Who buys: the VP Engineering or platform lead with an agent spend line nobody can itemise and an auditor asking who changed what. Who adopts: the individual engineer, freely, because the terminal that survives a closed laptop is worth having on its own.

How it spreads: bottom-up first, one developer at a time, then a `werk serve` on a team box, then a portal over sessions that already exist. The portal is populated by adoption, never mandated into being.

What it gives up: speed. Buyer-facing positioning is slower to prove, demands a security review before a purchase, and asks the product to be trustworthy before it is popular.

---

## 3. Brand expression

### 3.1 Wordmark

Always lowercase, always the bare word: **werk**. Never capitalised at the start of a sentence, never `Werk`, never `WERK`, never an all-caps lockup.

Build it in CSS:

```css
.wordmark {
  font-family: "Newsreader", Georgia, "Times New Roman", serif;
  font-weight: 500;
  font-size: 1em;
  font-optical-sizing: auto;
  letter-spacing: -0.018em;
  color: var(--ink);
  font-feature-settings:
    "kern" 1,
    "liga" 1;
}
```

Two treatments only:

- **Primary:** ink on paper, no box, no rule, set at the same optical weight as a page heading. It sits in text like a proper noun that has been typeset rather than styled.
- **Ledger lockup:** the wordmark with a 1px rule in `--rule` running the full column width directly beneath it, offset by exactly `0.5em` from the baseline, extending past the word to the container edge. The rule is the entire graphic idea: the entry and the line it is written on.

The `k` terminal is never modified, no ligature stunts, no dot swapped for a cursor block. Clear space is one `w`-width on every side. Minimum size 14px; below that use the mark alone.

### 3.2 Symbol / mark

A geometric construction, buildable from four primitives on a 32×32 grid.

1. **The field.** A square, 32×32, corner radius 2. It is the page.
2. **The margin rule.** A vertical 1.5px line at x=10, running from y=4 to y=28. This divides the square into a narrow left column and a wide right column, the ruled margin of a ledger page.
3. **The entries.** Three horizontal 1.5px lines in the wide column, at y=11, y=16, y=21, each starting at x=14. The first ends at x=25. The second ends at x=25. The third does not stop: it crosses the right edge of the square at x=32 and continues 4px beyond, ending at x=36.
4. **The tick.** In the narrow left column, a single 1.5px horizontal stroke at y=21 from x=4 to x=8, aligned with the running entry.

Read: two entries closed, one still open and running past the boundary of the page, marked in the margin. Everything is 1.5px stroke, everything sits on the grid, nothing is decorative. At 16px the third line's overhang is the only asymmetry, which is what makes the mark identifiable in a favicon.

Monochrome by default: `--ink` on `--paper`, or `--paper` on `--ink`. The single permitted colour variant tints the overhanging portion of the third entry and the margin tick in `--ledger`.

### 3.3 Colour palette

Light-first. Paper, ink, one hairline grey, one working green, two states. No gradients on brand surfaces. Colour carries meaning, so it is spent sparingly.

| Token        | Name         | Light hex | Role                                                                          |
| ------------ | ------------ | --------- | ----------------------------------------------------------------------------- |
| `--paper`    | Paper        | `#FBFAF7` | Page ground. Warm off-white, not pure white, so long documents read calmly.   |
| `--vellum`   | Vellum       | `#F2EFE8` | Tile and table fills, quoted blocks, the stat tiles. The only second surface. |
| `--ink`      | Ink          | `#10151C` | Wordmark, headings, primary body text. Near-black with a blue cast.           |
| `--graphite` | Graphite     | `#5A6270` | Secondary text, captions, table headers, metadata.                            |
| `--rule`     | Rule         | `#E3E0D9` | Hairlines, table rules, input borders, section dividers. Never text.          |
| `--ledger`   | Ledger Green | `#1F6F4A` | Primary action, live and attributed states, the accent in the mark.           |
| `--signal`   | Signal Amber | `#B27300` | "Needs you." Waiting on input, blocked, awaiting review.                      |
| `--halt`     | Halt Red     | `#A32B22` | Failure, unpushed work at risk, destructive confirmation.                     |

Dark-mode variant set. Not an inversion: ink becomes a cool near-black surface and the accents lift in lightness so they hold on it.

| Token        | Dark hex  | Note                           |
| ------------ | --------- | ------------------------------ |
| `--paper`    | `#0E1216` | Ground.                        |
| `--vellum`   | `#161B21` | Tiles and tables.              |
| `--ink`      | `#EDEBE5` | Text.                          |
| `--graphite` | `#99A2AF` | Secondary text.                |
| `--rule`     | `#232A32` | Hairlines.                     |
| `--ledger`   | `#4FB185` | Primary action and live state. |
| `--signal`   | `#E0A32E` | Needs you.                     |
| `--halt`     | `#E0685C` | Failure and risk.              |

Usage rule: on any page, at most one element carries `--ledger`. Amber and red only ever describe the state of real work, never a marketing emphasis.

### 3.4 Typography

Three families, all on Google Fonts.

- **Newsreader** — display and headings. Weights 400 and 500, optical sizing on. Used for the wordmark, hero headline, and every section heading. A serif does the work here that a grotesque cannot: it says the page expects to be read by someone who signs things.
- **Inter** — body, UI, tables, buttons. Weights 400 (body), 500 (UI labels, table headers), 600 (buttons and eyebrows). Enable `font-variant-numeric: tabular-nums` everywhere a figure appears in a column.
- **JetBrains Mono** — the monospace face. Weights 400 and 500. Commands, workspace names, branch names, session identifiers, hostnames, exit codes. It is the voice of the machine and appears only where machine output genuinely belongs.

Scale (light-first, 16px base): hero 56/1.05 Newsreader 500 at `-0.02em`; section heading 32/1.15 Newsreader 500; subheading 21/1.35 Newsreader 400; body 17/1.6 Inter 400; small 14/1.5 Inter 400; eyebrow 12/1.2 Inter 600 at `0.09em` uppercase in `--graphite`; mono 15/1.5 JetBrains Mono 400. Measure caps at 68 characters.

### 3.5 Voice: five rules

**1. State the mechanism, not the outcome.**
We say: "werk creates the branch, seeds the repo, and pushes the commits back before it destroys the container."
We don't say: "werk gives you peace of mind about your agent workflows."

**2. Name the buyer's problem in their own words, without dramatising it.**
We say: "You have an agent spend line and no itemisation."
We don't say: "The AI revolution has created an accountability crisis in engineering organisations everywhere."

**3. Be plain about what is built and what is planned.**
We say: "The team portal is where this is going. Today werk runs from your terminal and from a browser you point at your own machine."
We don't say: "werk gives every CTO complete oversight of their agent fleet."

**4. Respect the engineer in every sentence, including the ones aimed at their boss.**
We say: "An engineer picks werk because reattaching to a session from a different laptop is worth having on its own."
We don't say: "Finally, visibility into what your developers are actually doing all day."

**5. Never inflate the machine.**
We say: "Coding agents are command-line programs, so werk dispatches them the way it dispatches anything else."
We don't say: "werk orchestrates your autonomous AI workforce."

---

## 4. Five candidate taglines, ranked

1. **A record of what the machines did.**
   Wins because it is the entire concept in six words, past tense, and makes no promise about intelligence. "The machines" is dry rather than breathless, which is exactly the register.

2. **Agent work, on the record.**
   Tight, buyer-legible, carries the double meaning of a ledger entry and a public statement. Slightly softer than the first, and "agent work" is a phrase the reader already uses.

3. **Every session placed. Every branch accounted for.**
   Strongest for a security or finance reader because it names the two verifiable mechanisms, but two sentences make it a subhead rather than a mark lockup.

4. **You hired a second workforce. Nobody is keeping the books.**
   The most persuasive opener in a deck and the weakest tagline on a page: it accuses the reader, which works once and grates on the fourth read.

5. **Know what is running.**
   Clean and short, but underclaims. It describes the dashboard rung and leaves out attribution, recovery and the record, which is where this lane's value actually sits.

---

## 5. Pitch-page copy

### Hero

**Headline:** A record of what the machines did.

**Subhead:** Your company is running agent sessions on laptops, containers and cloud boxes right now. werk places each one deliberately, keeps it on a branch, and gets the work back.

**Buttons:** `Start with your own terminal` · `Talk to us about the portal`

---

### The second workforce

**Heading:** You acquired a second workforce without hiring anyone.

Coding agents arrived through individual developers, one licence at a time, and now they run all day. They edit real files in real repositories, on laptops that close mid-task, in containers that get destroyed, on boxes nobody put in an inventory. The work is genuine and much of it is good. What does not exist is any account of it. No one can say how many sessions are running, which repositories they touched, which produced commits that landed, or which quietly died with an hour of unpushed work inside them. Every other class of production work in your company has a ledger. This one has none.

**Stat tiles.** Framed as questions, not claims. Every figure below is illustrative.

- **How many agent sessions ran in your company yesterday?** Most engineering leaders cannot answer within an order of magnitude.
- **What share of agent work never reaches a branch?** Unknown almost everywhere, because nothing is counting the sessions that end without a push.
- **How long to answer "which agent touched this repository last month"?** Today the honest answer is usually days of asking people, if it is answerable at all.

---

### What nobody can see today

**Heading:** Three blind spots, one missing record.

**Cost.** The invoices arrive per vendor and per seat. They do not tell you which repository consumed the budget, which team, or which piece of work. Spend is knowable in total and unattributable in detail, which makes it impossible to govern and impossible to defend.

**Security and audit.** An agent with repository access is a principal acting on your code. When someone asks which sessions had access to a given repository, on which machines, under whose account, and what they pushed, the answer needs to be a query, not an investigation.

**Visibility.** The plain operational question, "what is being built right now?", has no answer. Work in progress lives in terminals nobody else can see, on machines nobody else can reach, and surfaces only when a pull request appears or does not.

---

### How it works

**Heading:** Four stages, one command each.

**1. Tell werk where work should happen.**
A Mac mini on a desk, a remote VPS, a container werk provisions, your Kubernetes cluster. Placement is a parameter, not an architecture. The same command and the same interface, wherever the work actually runs.

**2. Dispatch from your own terminal.**
`werk create` makes a workspace: somewhere to run, a fresh git branch, the repository seeded there, and a terminal session that survives your laptop closing, your network dropping, and your walking away.

**3. Monitor.**
`werk` with no arguments prints one live list of every workspace on every machine. It is built to answer two questions and no others: which of these needs me, and what is that one doing right now?

**4. Get the work back.**
werk creates the branch, gets the code there, and gets the commits back. A container destroyed with unpushed commits inside it is a catastrophic bug in this product, not an acceptable edge case.

---

### It has to be the tool they would pick anyway

**Heading:** The portal only exists because engineers wanted the tool.

A company-wide record of agent work cannot be installed from the top. It gets populated because the people doing the work chose the thing that produces it, and kept choosing it.

So werk has to earn its place on a single developer's machine first, with no meeting and no rollout. One binary, no runtime, nothing to install on the remote; werk copies itself across the ssh connection you already have. Reattach to a session from a different machine. Close the laptop mid-run and pick it up on the train. Run four agents on a box that is not your laptop and stop hearing the fans.

None of that is a concession to make the governance case work. It is the case. A record assembled from tools people actively want is accurate. A record assembled from tools people were told to use is a compliance exercise that quietly routes around itself.

---

### The reach ladder

**Heading:** The same work, seen from further away.

**Terminal.** Reattach to any running session from your own shell, on any machine you have configured. Full terminal state, scrollback included, exactly as you left it. This rung is useful with nobody else involved.

**`werk serve`.** Run the server on your own machine and open a browser. Every terminal process you have running anywhere, in one live view, with the same list the CLI prints and a real terminal in each pane.

**Hosted.** The same view from anywhere: your phone, another workstation, another continent. Run it as a service from us or host it yourself. Reaching terminals across a network is where security stops being a section and becomes the product.

**Shared.** Hand a colleague a live link to one of your terminals. Debugging together, a handover at the end of a shift, a second pair of eyes on an agent that has got itself stuck. Scoped to one session, granted by you.

**Team portal.** Every session your organisation is running, live, in one place, with history behind it. A platform lead can see the shape of the whole thing. A CTO can drill into any single session and watch what it is doing right now.

---

### The ledger

**Heading:** The ledger.

The portal is the point of all of it. Every workspace werk creates is already a structured fact: a person, a repository, a branch, a machine, a start time, a live terminal, an end state. Collect those across an organisation and you have the account of agent labour that does not currently exist anywhere. Not inferred from billing, not reconstructed from pull requests after the fact, and not a separate thing engineers have to remember to file. It is a by-product of the tool doing its actual job, which is why it stays accurate. Live at the top, reviewable underneath.

- **Attribution.** Every session carries the person who started it, the repository it was given, the branch it made and the machine it ran on. No unattributed work exists, because a workspace cannot be created without those four.
- **Drilldown to the live terminal.** From the organisation view to one running session and its real terminal state, scrollback included, in two clicks. Not a status field. The actual session.
- **Outcome, not just activity.** Which sessions produced commits, which landed on a branch, which ended with nothing. The difference between agent work and agent output becomes a number you can look at.
- **Placement and spend by repository and team.** Where work ran, on whose infrastructure, for how long. Enough to attribute cost to the thing it was spent on rather than to a vendor line.

---

### Security and deployment

**Heading:** It touches your source code. Deploy it accordingly.

werk puts repositories on machines and opens terminals on them. There is no honest version of this product that is low-stakes, so the deployment story comes first rather than last.

**Self-hosting is first-class.** The same binary, the same interface, running entirely on infrastructure you control, with the record staying inside your network. This is not a stripped enterprise tier. It is one of the two supported ways to run werk, and the hosted service is the other.

**One binary, nothing to pre-install.** No runtime, no agent to package, no dependency to approve on every target. werk copies itself over the ssh connection you already have and runs there. What arrives on a remote machine is one file you can hash.

**Placement stays yours.** Your Mac mini, your VPS, your Kubernetes cluster, your container images. werk decides nothing about where your code is allowed to live; it makes the placement you already chose reachable and recorded.

**Access is per session and revocable.** A shared terminal link is a grant you made for one session, and it can be taken back. Portal visibility is scoped by the organisation, is visible to the person being seen, and does not extend to anything outside a dispatched workspace.

We hold no compliance certifications today and will not imply any. What we can tell you is exactly what the software does, where it runs, and what it stores, in enough detail for your security team to make their own decision.

---

### Closing CTA

**Heading:** Start where the work is. The record follows.

The fastest way to evaluate this is not a demo of the portal. Install werk on one machine, dispatch a few agents to somewhere that is not your laptop, close the lid, and see whether the tool is one your engineers would keep. That is the precondition for everything above it. When it holds, the ledger is what you get for free, because every session it records was one somebody wanted to run.

**Button:** `Install werk`

---

### FAQ

**My engineers will hate this. Why wouldn't they?**
Some will, and the concern is legitimate rather than something to talk them out of. Our answer is that werk has to be a tool they would choose with no portal attached, or the portal ends up empty and wrong. So the visibility is scoped to work they deliberately dispatched, it is legible to them from inside the tool, there is no keystroke capture or activity scoring, and their own machine's terminals stay theirs. If an engineer reads the visibility page and still feels watched rather than accounted for, we would rather fix the product than argue the point.

**Do we have to change how our developers work?**
No. Coding agents are command-line programs, and werk dispatches command-line programs. It works off signals any well-behaved terminal program already emits, including the bell, OSC 9 and 777 notifications, OSC 9;4 progress, and OSC 133 command boundaries with exit status. There is no per-agent integration, so an agent released next month is useful in werk with no release from us.

**What happens to work in a container that gets destroyed?**
It is on a branch and it gets pushed. werk creates the branch, seeds the repository, and gets the commits back. We treat a workspace that disappears with unpushed commits inside it as a catastrophic bug rather than a known limitation, and it is the thing we test hardest.

**How much of this is built today?**
The terminal and the local server are the working parts: a detachable session daemon built on libghostty's snapshot format, so reattaching gives you real terminal state with scrollback, plus `werk` printing one live list across every machine you have configured and `werk serve` putting that in a browser. Windows, macOS and Linux are all first-class clients. Hosted, shared links and the team portal are where this is going, and we will tell you plainly which rung anything you see is on.

---

## 6. Image briefs

**BRIEF-1-HERO**
A wide, quiet architectural interior photographed straight on, showing a long wall of shallow wooden filing drawers running the full width of the frame and receding slightly to the right, each drawer face plain and unmarked with a small brushed brass pull. Three drawers stand open at different depths in the lower third, casting soft shadows. Light is low, raking in from a tall window off frame left, warm and directional. The palette is warm off-white plaster, deep near-black shadow with a blue cast, aged paper cream, and a single muted forest green fabric lining glimpsed inside one open drawer. Mood: institutional, calm, meticulous, unhurried. No text, letters, numbers, labels or signage anywhere.

**BRIEF-2-MARK**
A single abstract sculptural object centred on a flat, evenly lit warm off-white ground with generous empty space on all sides. The object is a thin square plate of dark matte near-black stone, standing perpendicular to the surface, with a narrow vertical channel cut near its left edge and three shallow horizontal grooves carved across the wider right portion. The lowest groove is a slender polished bar of deep forest green metal that extends past the plate's right edge and hangs in open air. Lighting is soft, frontal and shadowless apart from one faint contact shadow. Mood: precise, geometric, austere, engineered. Absolutely no text, letters, numerals or markings.

**BRIEF-3-LEDGER**
An overhead view of a wide dark walnut desk surface filling the frame, on which many identical thin cream card stock rectangles are laid out in strict aligned rows and columns, edge to edge, like a grid of unmarked index cards. Three cards near the centre are lifted a few millimetres above the others, and one at the lower right sits slightly askew and is tinted deep forest green. Light falls evenly and coolly from above with narrow shadows under the raised cards. Palette: warm cream, dark neutral brown, near-black shadow, one saturated forest green. Mood: orderly, accountable, quietly tense. No text, writing, numbers or symbols on any card.

---

## 7. The strongest objection to this concept (60 words)

You are selling a governance product before anyone has agreed there is a governance problem. Buyers do not yet feel agent sprawl as budget or audit pain, and the sober framing wins no engineer's affection on a crowded shelf. Meanwhile the sceptical developer reads "company-wide view of every terminal" and stops there, whatever the visibility section says afterwards.
