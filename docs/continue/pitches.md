# Continue: the werk pitch sites

A handoff. Four branding concepts for werk exist as published pitch pages. They
are good on copy and on decorative imagery, and thin on pictures of the product
itself. This doc says what is there, where the material lives, and what the next
session should do.

> **This is working material, not product doctrine.** Everything in
> `concepts/` and on the four pages is pitch copy: aspirational, written to
> persuade, and deliberately confident in a way `docs/product/` is not allowed
> to be. Nothing here has been decided. Do not migrate a sentence of it into
> `docs/product/` without someone actually taking the decision it implies.

---

## 1. What the pitch is arguing

The spine every concept was built on, taken from the brief rather than from
`docs/`:

werk makes it trivially easy to run and monitor work inside a source repository.
The two universal interfaces to a repository, for humans and for agents alike,
are the terminal and git, so werk is really about making those two things easy to
reach. You tell it where work should run (the Mac mini on the desk, a VPS, a
container it provisions, the company Kubernetes cluster), you dispatch from your
own terminal, you monitor everything on one list, and the commits come back.

Coding agents are the workload that matters, and they happen to be command-line
programs, so werk dispatches and monitors them with no per-agent integration.

**The reach ladder is the strategic spine of all four pitches.** Every page
climbs it, and the top rung is the crescendo:

| Rung            | What it is                                                                             | Built?  |
| --------------- | -------------------------------------------------------------------------------------- | ------- |
| 1. Terminal     | Reattach to any running session from your own shell                                    | Today   |
| 2. `werk serve` | Run it locally, open a browser, see and type into every session everywhere             | Today   |
| 3. Hosted       | The same view from anywhere: phone, another workstation, another continent             | Roadmap |
| 4. Shared       | Hand a colleague a live link to one of your terminals                                  | Roadmap |
| 5. Team portal  | Every agent session in the company on one live wall, with drilldown to a live terminal | Roadmap |

Each page marks which rungs exist today and which are roadmap. Keep doing that.

---

## 2. What exists now

Two rounds of four pages each. **Round two is in `round2/`** — a thinner brief,
four genuinely different pages, and its own README. Round one is described
below; both sets are live and neither has been chosen.

### Round one — the four published pages

| Concept             | Lane                              | Top tagline                          | URL                                                                  |
| ------------------- | --------------------------------- | ------------------------------------ | -------------------------------------------------------------------- |
| **A · Substrate**   | The infrastructure primitive      | "Placement is a parameter."          | https://claude.ai/code/artifact/9a104ee7-c86b-49d5-bee5-b66b3220725e |
| **B · Flight Deck** | Mission control                   | "Know which one needs you."          | https://claude.ai/code/artifact/2da0b8bb-92dd-4508-945a-83d2cb50d933 |
| **C · Werkstatt**   | The workshop                      | "You run a shop now."                | https://claude.ai/code/artifact/128daf70-da48-4da4-aab3-fb99e25ba06e |
| **D · The Ledger**  | System of record for agent labour | "A record of what the machines did." | https://claude.ai/code/artifact/31af306e-2d4f-4b03-b1f4-6cd558375600 |

To update one of these in a new session, pass its URL as `url` to the Artifact
tool. Publishing without it creates a separate artifact instead. You must also
`read` the artifact in that session before publishing to it.

Each page carries: hero, terminal transcript, problem, how-it-works, the reach
ladder, three product screens, an agents section, a trust section, a CTA, four
FAQs, and a brand appendix (strategic bet, mark construction, palette swatches
with hexes, type specimen, ranked taglines, voice rules with we-say/we-don't-say
pairs).

### The product screens on each page

Every page draws three, each tagged built or roadmap in the page's own tag
component, and each built out of that concept's palette, type and component
vocabulary rather than a shared kit.

| Concept | Rung 2 · `werk serve`                          | Rung 4 · shared link                                        | Rung 5 · the drilldown                                               |
| ------- | ---------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------- |
| A       | `127.0.0.1:7717/sessions`, sidebar, four panes | Your shell beside the colleague's browser                   | `portal.werk.sh/builders`, HTML table, hairline depth rails          |
| B       | Browser frame, 8-session rail, four live panes | `werk share --for 30m` beside "shared by priya.raman · 27m" | `werk.acme.internal/fleet`, 6 people, 19 sessions, filter chips      |
| C       | Four benches, browser chrome                   | "Pull up a stool" — terminal, then Priya's browser          | "The floor" — tree with carets, detail pane                          |
| D       | Fleet list (rung 1, terminal-native)           | Granting terminal beside the shared browser page            | Four people, nine sessions, twelve subagents; CSS-only row selection |

The surface split, taken from `docs/product/03-surfaces.md`: rung 1 and the CLI
are terminal-native, and the fleet list and reattach are drawn as shells. Rung 2
and everything above it are browser surfaces, so the drilldown and the shared
link are web applications with a live terminal embedded as a pane inside the
page. That embedding is what `werk serve` already does.

### The imagery

Twenty-eight images across the four pages, seven each: the three originals plus
four generated in the second round, anchored on one judged image per concept and
grown into siblings with `--ref`. All OCR-verified clean. Several needed
regenerating rather than cropping — a hardware brand plate on a bench, maker's
plates on tools, a ruler with legible graduations.

### The source material, preserved in this folder

| Path                       | What it is                                                                                                                                                                              |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `concepts/concept-a..d.md` | The full brand briefs. Positioning, strategic bet, wordmark, mark construction, palette, type, voice, taglines, complete page copy and image briefs. **This is the valuable artefact.** |
| `assets/*.webp`            | The twenty-eight generated images, optimised. Roughly 3 MB total.                                                                                                                       |
| `tools/pitch-*.tpl.html`   | The four page templates with `{{IMAGE_TOKEN}}` placeholders where images go. Small, no base64. **The source of truth** — edit these, not the published HTML.                            |
| `tools/dataurl.sh`         | Optimises an image to WebP and writes a `.datauri.txt` beside it.                                                                                                                       |
| `tools/inject.py`          | Substitutes `{{A_HERO}}` and friends in a template with the matching `img/<a-hero>.datauri.txt`.                                                                                        |

To rebuild a page: write each asset's data URI into `<scratch>/img/<key>.datauri.txt`,
copy the template beside that `img/` directory, run `inject.py`, publish the
result to the concept's existing URL with `favicon` and `contract` omitted.

### The four lanes, and what each gives up

Worth keeping straight, because the whole point of four concepts is that they
answer open question 18 (the monetisation thesis) four different ways.

- **A Substrate.** Claims the seam between a process and a machine, the way
  Tailscale claimed the seam between a host and a network. Wins the senior
  engineer alone on a Tuesday. Gives up warmth, the viral demo, and every
  non-technical buyer.
- **B Flight Deck.** Bets the pain has already moved from one agent to twelve.
  Wins the tech lead with eleven tabs. Stakes the brand on a rung not yet built.
- **C Werkstatt.** Casts the reader as someone who now runs a shop. Wins by
  affection, one practitioner at a time. Risks reading as hobbyist to a buyer.
- **D The Ledger.** Sells the account of a second workforce nobody is keeping
  books on. Has the clearest path to revenue and the slowest proof.

Those four trade-offs live here, in working material, and deliberately not on
the pages. The pages pitch.

## 3. What is left

**Someone picks a lane, or says why none of them is right.** That is the whole
purpose of building four, and it is the one thing no amount of further work on
the pages can substitute for. The four trade-offs above are the comparison; the
pages are the evidence.

Whatever gets picked, none of it is a decision yet. If a position on this
material survives contact with an actual discussion, the place for it is
`docs/product/04-open-questions.md` §18, where the monetisation thesis is still
open — and it goes there as a decision someone took, with a date and a name, not
as prose lifted across.

### The working method, for whoever runs the next round

Each concept goes to one subagent that owns it end to end: it writes, generates
its own images with `art`, builds its own HTML, and publishes its own artifact.
The coordinator hands out the product facts, the reach ladder, the lane and the
constraints, and gets back a URL and a short summary. Nothing else passes
through the middle. A coordinator that generates the images and builds the pages
itself burns its context for no reason and becomes the bottleneck.

Give each subagent: the product facts, the reach ladder with its built/roadmap
split, the surface split from `docs/product/03-surfaces.md`, its lane, the path
to `art`, the rebuild recipe in `tools/`, and the instruction to publish and
return only a URL plus a few lines.

### Generating imagery with `art`

```bash
ART=/home/mike/Development/is4co/agent-skills/plugins/artistic-vision/skills/artistic-vision/bin/art
```

Generate plenty. The images are the best thing about these pages, and `art` is
good. What made the second round's images better than the first:

- **`--attempts n --judge "<criteria>"`** generates several and keeps the best
  against stated criteria. Write the criteria from the concept's own palette and
  voice, and always include "no legible text anywhere". The first round did not
  use this and every one of its twelve images is a first draft.
- **Anchor, then siblings.** Generate one image, judge it, then pass it to the
  rest with `--ref`. On `generate` there is no primary image, so the references
  carry style and vocabulary while the prompt alone dictates composition — a
  sibling rather than a variant. Say so in the prompt: "the attached image is a
  house-style reference only, match its palette, surface treatment and density,
  not its layout." Use `edit --ref` when a composition must be preserved and only
  the skin changes.
- **`--inspect`** makes the tool describe what it actually produced, which beats
  assuming it did what you asked.

**Generated images carry the scene; HTML carries the strings.** Small type
garbles, and it garbles plausibly, so end every prompt with "No text, letters,
words, numbers or labels anywhere" — that line has now held across twenty-eight
images. Generate the room, the hall, the bench at 2am, two figures at one screen,
a hierarchy as light at three depths. Hand-build anything that needs a real
workspace, branch or host name, because that is where invented type becomes
nonsense.

**Verify by OCR, not by eye:** `"$ART" ocr <out> --plain` must come back empty.
Three images in the second round came back with legible type the prompt had
asked against — a hardware brand plate, maker's plates, a ruler's graduations.
Regenerate; do not crop around it.

Then `tools/dataurl.sh <image> 1400 160` to optimise and inline, keeping each
around 160KB. Save every `.webp` into `assets/` so the spend survives the
session.

### Data URIs survive the publish path

Verified on concept B: the three payloads in the published HTML decoded to
complete WebP files whose declared RIFF length matched their byte count, all
byte-identical in size to the local assets. Alt text appearing on a page is a
read mid-load, not a broken publish.

Cheap to re-check when a page grows — decode every `data:image/webp;base64,`
payload in the HTML that `Artifact` `action: "read"` saves, and confirm each
starts `RIFF`/`WEBP` with the length in bytes 4-8, plus 8, equal to the decoded
length.

The artifact **`assets` capability is not available on this account** — the
capability list is `artifact`, `db`, `downloads`, `mcp`, `room`, `sample`,
`self`. So `upload_asset` is not an option and images are inlined as data URIs,
or drawn in HTML and SVG.

---

## 4. Constraints that held, and should keep holding

- **British spelling. Plain sentences. No filler.** No exclamation marks, no
  "just", "simply", "effortless", "seamless", "supercharge".
- **Mark roadmap as roadmap.** Every page tags each rung of the ladder as built
  or not built. The hosted, shared and portal rungs are the aspirational ones and
  the pages say so.
- **No invented capabilities**, no fake statistics, no claimed compliance
  certifications. Concept D deliberately frames its stat tiles as questions
  rather than inventing figures. Keep that.
- **Pitch it. Do not object to it.** These pages argue for werk to an internal
  audience. Nothing self-critical belongs on them: no pre-emptive defence of
  rungs that are not built, no anticipating criticism of features that do not
  exist yet, no hedging about who the product is not for, and no "strongest
  objection to this concept" block. The built/roadmap tags are not an exception —
  labelling what exists today is accuracy, not self-criticism.
- **Design.** Load `artifact-design` before writing a page. Both themes, real
  type pairing, a considered palette, and no rounded-card-with-accent-bar
  defaults. Each of the four pages has a genuinely different visual system and
  they should stay that way.

---

## 5. Repo notes

`docs/continue/` is scratch for work in flight. It is not part of the
documentation set described in `docs/README.md`, and it should either be folded
into a real doc or deleted once the pitch work lands. If any of this survives as
a position the project actually takes, the place for it is
`docs/product/04-open-questions.md` §18, which is where the monetisation thesis
is still open.
