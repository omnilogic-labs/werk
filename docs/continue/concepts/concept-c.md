# Concept C — WERKSTATT

**The shop where the machines work.** werk turns the scatter of terminals, branches and half-finished agent runs into a place: a bench you dispatch from, a floor you walk, and every job still there in the morning.

---

## 1. Concept name and one-line positioning

**Name:** WERKSTATT (the concept; the product is always lowercase `werk`).

**Positioning:** You stopped being a person who writes code and became a person who runs a shop. werk is the shop: bench, floor, and the promise that nothing you set running gets lost.

---

## 2. The strategic bet

This concept wagers that the developer worth winning is not shopping for a dashboard. They are quietly unsettled by what their day has become: five agents running, four terminals lost, a branch somewhere with good work on it they cannot find. Sterile SaaS language makes that worse. A shop makes it a job again: a bench, a floor, hours.

It wins the practitioner first, one at a time, because it is the only tool in a crowded field that sounds like it was made by hands rather than assembled by a growth team. It spreads by affection: people show colleagues things they find beautiful, and a shared live terminal link is a demo that travels.

It gives up the fast enterprise read. A CTO scanning for compliance vocabulary will not find it here, and the team portal has to earn its way up from the bench rather than down from procurement.

---

## 3. Brand expression

### 3.1 Wordmark

`werk` is always lowercase, always one word, never capitalised at the start of a sentence, never given a capital W in body copy, never possessive-hyphenated into `werk-` compounds.

Set in **Archivo** at weight 700 with the variable width axis pushed wide, so it reads as painted signage rather than a UI label. The lowercase e/r/k give three flat terminals in a row; widening the face turns that into a rhythm.

```css
.wordmark {
  font-family: "Archivo", "Helvetica Neue", Arial, sans-serif;
  font-weight: 700;
  font-variation-settings: "wdth" 118;
  font-size: 3.5rem;
  letter-spacing: -0.018em;
  line-height: 0.86;
  color: var(--graphite);
  text-transform: lowercase;
  font-feature-settings: "ss01" 1;
}
/* the k gets one unit back so the leg does not crowd the edge */
.wordmark::after {
  content: "";
  display: inline-block;
  width: 0.02em;
}
```

Lockup: the mark sits to the left of the wordmark, optically centred on the x-height, separated by exactly one stem width of the `k`. In one-colour print the whole lockup is Graphite. The mark may be Vermilion only when the wordmark is Graphite, never the reverse.

Sub-brands are set as `werk` plus a lowercase word in Archivo 500 at wdth 100 with a hairline rule between: `werk │ serve`.

### 3.2 Symbol / mark

A **bench mark**. Surveyors cut one into stone where the levelling bench rested: a horizontal bar with a three-stroke crow's foot beneath it, pointing up at the bar. It means _this is a fixed point, measured, you can build from here_. It is also, literally, a bench and a mark.

Construction, on a 24 × 24 unit grid, all strokes 2.5 units wide with butt caps:

1. **The bar.** A horizontal stroke from (3, 7) to (21, 7). Full 18 units wide, sitting at 29% height. This is the bench.
2. **The stem.** A vertical stroke from (12, 21) up to (12, 9.5), stopping 2.5 units short of the bar so a visible gap of one stroke width remains. Machines and eyes both need that gap; it survives embossing.
3. **The wings.** Two strokes from the same origin point (12, 21), one to (5.5, 9.5), one to (18.5, 9.5). Both stop level with the stem, on the same horizontal, leaving a clean three-tooth comb under the bar.
4. **The foot.** The three strokes meet at a single mitred point at (12, 21). No rounding, no join radius. It is a chisel mark, not a logo swoosh.

Optical note: the two wings are drawn at 2.3 units rather than 2.5, because diagonals read heavier than orthogonals at small sizes.

It stamps, embosses, debosses, engraves, cuts as vinyl, and reduces to 16 px without the gap closing. It works as a solitary Vermilion print on Bone, blind-embossed with no ink at all, or branded into end grain.

### 3.3 Colour

Warm, paper-first, one strong accent. Two supporting semantics only, because a shop floor with six colours of paint is a shop nobody has swept.

**Light (default)**

| Name      | Hex       | Role                                                                           |
| --------- | --------- | ------------------------------------------------------------------------------ |
| Bone      | `#F4EFE6` | Page ground. Unbleached paper, not white.                                      |
| Chalk     | `#FBF8F2` | Raised surfaces: cards, code blocks, the TUI panel.                            |
| Graphite  | `#1C1A17` | Ink. Body text, headings, the wordmark, hairline rules at full strength.       |
| Pencil    | `#6B6459` | Secondary text, captions, column headers, timestamps.                          |
| Rule      | `#DDD3C3` | Hairlines, table dividers, input borders, the 1 px grid.                       |
| Vermilion | `#C8442A` | The single accent. Links, the mark, the state dot for _needs you_, one button. |
| Patina    | `#4C7A69` | Running and healthy. Aged copper green, never a neon success colour.           |
| Brass     | `#9A7524` | Warnings and unpushed work. Used sparingly, and always with words beside it.   |

**Dark**

| Name            | Hex       | Role                                           |
| --------------- | --------- | ---------------------------------------------- |
| Night           | `#131210` | Page ground. Warm black, the shop after hours. |
| Bench           | `#1D1B17` | Raised surfaces.                               |
| Bone Light      | `#EDE6D8` | Primary text.                                  |
| Pencil Light    | `#9E9587` | Secondary text.                                |
| Rule Dark       | `#312E28` | Hairlines and dividers.                        |
| Vermilion Light | `#E4643F` | The accent, lifted for contrast on Night.      |
| Patina Light    | `#6EA792` | Running and healthy.                           |
| Brass Light     | `#C39A44` | Warnings and unpushed work.                    |

Dark mode is not an inversion. It is the same shop with the overheads off and the bench lamp on: grounds go warm-black, paper texture drops to almost nothing, and Vermilion is the brightest thing on the page.

### 3.4 Typography

All four are on Google Fonts.

| Face                                           | Weights / axes               | Role                                                                                                                                                                                                                       |
| ---------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Archivo**                                    | 500, 600, 700; `wdth` 88–118 | Wordmark, headings, buttons, and small-caps labels. A grotesque drawn from highway and signage lettering, which is exactly the right ancestry. Headings at wdth 105, labels at wdth 88 with 0.09em tracking and uppercase. |
| **Source Serif 4**                             | 400, 600; optical size axis  | Body copy. Warm, sturdy, slightly old-style, and it holds long paragraphs without the page feeling like a marketing site. Set at 19px / 1.62 with the optical size axis tracking the size.                                 |
| **IBM Plex Mono**                              | 400, 500, 600                | Every terminal block, command, path, branch name and workspace name. Chosen over the sharper coding monos because it has a typewriter warmth and a genuinely good lowercase.                                               |
| **Archivo Expanded** (same family, `wdth` 125) | 700                          | Reserved for exactly two things: the hero headline and the closing headline. Nowhere else.                                                                                                                                 |

Rules: no more than three sizes in any one section. Rules are 1 px Rule, never shadows. Nothing is centred except the mark.

### 3.5 Voice

**Rule 1. Name the object, not the outcome.**
We say: "werk makes a workspace: a place to run, a branch, your repo, and a terminal."
We don't say: "werk unlocks frictionless developer velocity across your fleet."

**Rule 2. Say what it costs and what it can't do.**
We say: "Reattaching over a slow link takes a second or two while the screen is restored."
We don't say: "Instant, seamless reconnection anywhere in the world."

**Rule 3. Be funny about the situation, never about the software.**
We say: "You have four robots working for you and no idea what any of them is doing. This is a management problem now."
We don't say: "Wrangle your AI squad with werk's magical agent herding powers."

**Rule 4. Plain verbs, short sentences, no vocabulary from a pitch deck.**
We say: "Type `werk`. You get one list of every workspace on every machine."
We don't say: "werk surfaces unified observability across heterogeneous compute targets."

**Rule 5. Respect the machines by name.**
We say: "It runs on the Mac mini under your desk, a rented Hetzner box, a container it builds, or the cluster your company already pays for."
We don't say: "Deploy to any environment."

---

## 4. Five candidate taglines, ranked

1. **You run a shop now.**
   The whole concept in four words. It names a change the reader has already felt and never said out loud, it is funny without being twee, and it sets up bench, floor and jobs as the natural next vocabulary. Risk: it says nothing about what the software does, so it needs a subhead doing real work underneath.

2. **Somewhere for the work to happen.**
   Literal and true, since a workspace is a place. Reads as calm and slightly old-fashioned, which is the tone. Weaker than the first because it is a description rather than a recognition.

3. **Mind the shop.**
   Good imperative, good British texture, works on a sticker and on a terminal splash. Slightly ambiguous: it can read as "watch out" rather than "look after the place".

4. **The work comes back.**
   The emotional promise stated flat, and the best line in the whole system for the git section. As a top-level tagline it is too quiet on first read and only lands after you know what werk does.

5. **Every job on the floor, on one list.**
   The most functional line, and the easiest to justify to a sceptic. It is also the least distinctive, and any of forty competing tools could put it on their homepage tomorrow.

---

## 5. Pitch-page copy

### Hero

# You run a shop now.

Five agents running, four terminals lost, a branch somewhere with good work on it. werk gives all of it a place, and every job is still there in the morning.

`[ Take the tour ]` `[ Install werk ]`

### Terminal transcript

```
$ werk create --on mac-mini invoicing-rewrite

  workspace   sleepy-otters-counting
  placement   mac-mini · 192.168.1.40
  branch      werk/sleepy-otters-counting
  repo        seeded from main @ 4f2ac91
  terminal    ready

  attach with:  werk attach sleepy-otters-counting

$ werk attach sleepy-otters-counting
  (detached with ctrl-\ ctrl-d · session kept running)

$ werk

  WORKSPACE                      PLACEMENT      STATE               AGE
  sleepy-otters-counting         mac-mini       ● running          4m
  affectionate-badgers-writing   mac-mini       ○ waiting on you   12m
  brave-herons-refactoring       hetzner-fsn1   ● running          41m
  patient-magpies-migrating      docker         ● running          2h
  tidy-foxes-packaging           k8s/build-2    · idle             6h   4 commits unpushed

  5 workspaces · 3 machines · 1 waiting on you
  enter to open · o to open in browser · ? for keys
```

### The problem

## The bench got crowded while you were looking away

**You are supervising, not typing.**
Somewhere in the last year the job changed. Most of your day is now spent starting robots, waiting on robots, and reading what robots did. Nobody trained you for this and no tool was built for it.

**The sessions are scattered and fragile.**
One agent on the laptop, one on the Mac mini, one in a container on a box you rented. Every one of them dies the moment the ssh connection blinks or the lid closes. You have learned to keep the laptop open like it is 1998.

**Work goes missing.**
A container gets torn down. A machine reboots. Two hours of good commits were on a branch that only ever existed inside it. You cannot even be sure how often this happens, which is its own kind of answer.

### How it works

## Four stages, and none of them are clever

**1. Say where work should happen**
The Mac mini on the desk. A VPS you rent. A container werk builds for you. The Kubernetes cluster your company already pays for. Placement is a parameter you pass, not an architecture you commit to. Same command everywhere.

**2. Dispatch from your own terminal**
`werk create` makes a workspace: somewhere to run, a fresh git branch, your repository seeded onto it, and a terminal session that keeps running when your laptop closes, your network drops, or you go to bed.

**3. Walk the floor**
Type `werk` with nothing after it. One live list of every workspace on every machine you use. It is built to answer two questions and no others: which of these needs me, and what is that one doing right now.

**4. Get the work back**
werk made the branch, put the code there, and brings the commits home. A workspace destroyed with unpushed work in it is a catastrophic bug, not an edge case. Losing work should take deliberate effort.

### The shop floor

## Walking the floor

A shop is not a list of machines. It is a room you can walk through, where you can tell from the doorway which lathe is cutting, which one has stopped, and which one wants a word.

`werk` with no arguments is that walk. Every workspace, on every machine, in one place: the one on your desk, the one in Falkenstein, the one in a container that will not outlive the afternoon. Running jobs are quiet. Jobs that need a decision say so. Jobs holding commits nobody has pushed say that too, in brass, until you deal with them.

Press enter on any line and you are inside that terminal, with the scrollback intact, exactly as you left it. Not a redraw. The actual screen, restored from a snapshot of real terminal state, so you can read what happened at 03:40 as easily as what is happening now.

Then you step back out, and the job keeps running.

### The reach ladder

## How far the shop reaches

**1. Your terminal**
Where it starts and where most of it stays. Reattach to any running session from the shell you already have open. No browser, no account, no daemon you did not ask for.

**2. `werk serve`**
Run it on your own machine and open a browser. Every terminal process, everywhere, on one page. Type into them. Watch four at once, side by side. Close the tab when you are done and nothing stops.

**3. Hosted, by us or by you**
The same floor from anywhere. The phone in the pub garden, the workstation at home, a hotel desk on another continent. The job carried on without you, and now you can see it without going back to your desk.

**4. Shared**
Hand a colleague a live link to one terminal. They see what you see, in real time, and can type if you let them. Debugging together stops being a screen-share and starts being two people at one bench.

**5. The whole shop**
Every agent session in the company on one floor. A shop where the work is visible is a shop where you can see who is stuck, borrow what already worked, and learn the trade by watching someone better than you do it.

### The work comes back

## Nothing gets left on the floor

Here is the thing werk is really for.

Machines you do not own are temporary. Containers get reaped. Spot instances vanish. A box reboots for a kernel update at four in the morning and takes the afternoon with it. Every one of those is fine, and every one of those has quietly eaten somebody's work.

So werk holds the git end of it from the start. It creates the branch before the first line is written. It seeds your repository onto the machine itself, not a copy of some files, a real clone on a real branch. It knows what is committed, what is not, and what has never left that machine. That last number is on the list, in brass, every time you look.

When you are done, the commits come home. When you are not done, they still come home. And if you ask werk to destroy a workspace holding work nobody has seen, it stops and makes you say it twice.

Losing work should require deliberate effort. That is the whole design goal, and it is the one we would treat a bug report about as a fire.

### Every agent, no integration

## It does not care which robot you hired

Claude Code, Codex, Gemini CLI, Aider, the one that launches next Tuesday. They are all command-line programs, and werk is a shop for command-line programs. It watches the signals any well-behaved terminal program already emits: what it printed, whether it is asking for input, whether it exited and how.

That means no plugin, no adapter, no per-agent release. A brand-new tool works on day one, and so does the twenty-year-old build script you have never got round to replacing. If it runs in a terminal, it runs on the bench.

### Trust and security

## What we can honestly tell you

werk is one self-contained binary. No runtime, no package manager, nothing to install on the far end. It copies itself across the ssh connection you already had and already trusted, which means the security of a remote workspace is mostly the security of your ssh setup. That is a smaller claim than most tools make, and it is the true one.

Your terminal sessions live on your machines. Nothing leaves them unless you run `werk serve` or opt into hosting, and when you do, you should expect us to publish exactly what is transported and where it rests before you trust it with anything real.

The honest risk is not werk. It is that you are running agents with your credentials, on your code, unattended. Containers narrow the blast radius and placement lets you choose it deliberately. Neither makes the risk go away, and we would rather say so than sell you a padlock icon.

### Closing

## Come back in the morning

Put a job on the bench, set it running, and shut the laptop. The machine does not care that you have gone to bed. In the morning there is a branch with commits on it and a screen you can scroll back through to see exactly how it got there. That is the whole promise, and it is a bigger one than it sounds.

`[ Install werk ]`

### FAQ

**Isn't this just tmux with nicer fonts?**
tmux is one machine. werk is every machine you use, on one list, with git and a browser attached. The session layer is a detachable daemon built on libghostty's snapshot format, so reattaching restores real terminal state, scrollback included, rather than whatever the program decides to redraw. If you only ever work on one box and never lose a branch, tmux is genuinely fine and we would not try to talk you out of it.

**There are forty of these already. Why another?**
Most of those forty are the same tool: git worktrees plus tmux plus a TUI, on your laptop, for your laptop. That shape is solved. What is not built is the cross-machine view, the browser that reaches it, and a link you can hand to somebody else. werk is aimed at the part nobody has done.

**What happens if werk itself falls over?**
Your sessions do not. They are held by a daemon on the machine where the work is, not by the CLI you typed into, and the branches are ordinary git branches you can reach with ordinary git. If werk disappeared tomorrow, everything you made with it is still on those machines and still in your repository. That is deliberate.

**Do I have to run agents to get anything out of it?**
No. Agents are what made the problem urgent, but a workspace does not know what you put in it. A long test suite, an overnight migration, a build that takes forty minutes, a REPL you want to come back to on Thursday. It is a place to leave a running process, and it does not ask what the process is for.

---

## 6. Image briefs

**BRIEF-1-HERO**
A long workbench of oiled beech runs diagonally across the lower two thirds of the frame, photographed slightly from above and to the left, late at night. Three small unattended machines sit along it, spaced apart, each still and mid-task, their unmarked brass dials catching light from a single articulated bench lamp at the upper right. Everything else falls into deep warm shadow the colour of soft charcoal. The palette is unbleached paper cream, aged brass, and one saturated brick-red enamelled lever near the centre. Fine sawdust hangs in the lamplight. The mood is calm, competent and entirely unhurried.

**BRIEF-2-MARK**
A single geometric emblem centred in the frame on a plain sheet of unbleached cream paper that fills the whole background edge to edge. The emblem is a clean horizontal bar with three straight strokes converging beneath it to a single sharp point, like a surveyor's chiselled reference mark, all strokes the same even thickness with a small gap between the strokes and the bar. It is letterpress printed in one brick-red ink, pressed hard enough to leave a visible bite in the paper, ink slightly heavier at the stroke edges. Raking side light shows the paper fibre and the debossed impression. Nothing else is in the frame.

**BRIEF-3-RETURN**
Early morning light through a dusty workshop window falls across a low wooden rack in the middle distance, seen straight on, occupying the central third of the frame. On the rack sit four finished metal components, cleaned and set down in a neat row, still where the machines left them overnight. The window edge and a stilled machine are soft and dark at the frame's left margin. The palette is pale grey-gold daylight, warm cream plaster, dark oiled wood, and the cool steel of the finished parts, with one small brick-red cloth folded at the rack's end. The mood is quiet relief.

---

## 7. The strongest objection

It sells a feeling, not a difference. Every claim under the workshop language is one another tool could match by Friday, and the crowded field already knows how to look handmade. Worse, the warmth may read as small and hobbyist exactly when a buyer is deciding whether to trust it with a fleet. Charm wins the practitioner and then quietly caps how far the practitioner can carry it.
