# werk

**werk starts a process somewhere and lets you come back to it later.**

Locally, on a machine you can ssh to, or in a container it provisions. It puts
your repository there on a fresh branch, gives you a terminal that survives your
laptop closing, and shows you every one of those — across every machine — in one
list you can open from a terminal or a browser.

## What this repo is right now

**Documentation.** There is no program yet. The repo is a Bun workspace with an
empty `packages/` and Prettier on defaults; everything real is in `docs/`.

| Path              | What's in it                                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| `docs/product/`   | What werk does. Scope and promises, the object model, worked journeys, surfaces, open questions.                 |
| `docs/research/`  | What we found out before deciding anything. Thirteen dossiers, terminal internals through competitive landscape. |
| `docs/proposals/` | Technical specifications for what to build. Currently the proof of concept that tests the stack.                 |
| `packages/`       | Empty. The program goes here.                                                                                    |

Start at `docs/README.md`.

## Project rules

### Documentation reflects the present, not its history

A doc is a self-contained reference to the information we currently want
recorded. It is not a changelog of itself.

When something changes — a decision, a new finding, a correction — **rewrite the
doc so it reads as though it had always said the new thing**, and make sure the
rest of it is coherent after the edit: fix cross-references, renumber, delete
sentences whose premise is gone.

Do not write:

- "previously we said X, now we say Y"
- "this was originally scoped as X"
- "alternatives considered and rejected"
- "~~X~~ → Y" or any other visible trace of the edit

When we change our minds, the alternative we did not take is not useful context.
Delete it. Git has the history if anyone ever wants it.

### Speculate. Do not decide.

**Default to the speculative voice.** "This probably wants to be X", "the options
are X or Y", "X is likely and nobody has worked out where it stops" — not "werk
does X" or "werk is not Y". Writing a maybe as a fact is the single most costly
mistake in this repo, because it gets read back later as settled and nobody
remembers that it wasn't.

Nothing in `docs/` is settled unless someone said it was. Do not invent
decisions, non-goals, scope exclusions, or roadmap commitments that were not
actually stated.

- A genuinely open question goes in `docs/product/04-open-questions.md`, with
  the options laid out and any lean explicitly labelled as a lean.
- A research finding is a finding. It informs a decision; it is not one. What
  another project chose is evidence, not our position.
- If a doc needs a position in order to be coherent and nobody has taken one,
  say so in the doc and ask — do not pick one and write it down as settled.

**Negative statements are the worst offenders.** "werk is not X", "X is out of
scope", "we will never Y" all read as closed doors and are almost never things
anyone actually closed. Do not write one unless it was explicitly decided. If
something genuinely looks unlikely, write down why it looks unlikely and leave
the door open.

### Prose style

British spelling, plain sentences, no filler. Tables where a table is genuinely
clearer than a list. Prettier formats markdown on defaults — run `bun run
format` before committing.
