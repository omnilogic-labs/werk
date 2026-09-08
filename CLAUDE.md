# werk

**werk starts a process somewhere and lets you come back to it later.**

Locally, on a machine you can ssh to, or in a container it provisions. It puts
your repository there on a fresh branch, gives you a terminal that survives your
laptop closing, and shows you every one of those — across every machine — in one
list you can open from a terminal or a browser.

## What this repo is right now

The Bun workspace contains private session libraries and two consumers. The
portable `@werk/terminal` and `@werk/session` packages provide terminal replicas
and the transport-injected client. `@werk/session-daemon` owns PTYs, persistence
and local daemon startup. `@werk/terminal-beamterm` proves the renderer seam beside
the bundled DOM renderer. `@werk/workspace` puts creating a workspace behind an
interface and makes local git worktrees behind it; it is under development and
expected to change shape. `@werk/palette` is Catppuccin mapped to werk's uses,
and is the one place any colour is named. `packages/werk` is the session CLI and
`examples/session-web` is the local browser consumer.

See [docs/session-library.md](docs/session-library.md) for build, validation and
consumer commands. Product direction lives in `docs/product-specification.md`.

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

- A genuinely open question goes in the open questions of
  `docs/product-specification.md`, with the options laid out and any lean
  explicitly labelled as a lean.
- A research finding is a finding. It informs a decision; it is not one. What
  another project chose is evidence, not our position.
- If a doc needs a position in order to be coherent and nobody has taken one,
  say so in the doc and ask — do not pick one and write it down as settled.

**Negative statements are the worst offenders.** "werk is not X", "X is out of
scope", "we will never Y" all read as closed doors and are almost never things
anyone actually closed. Do not write one unless it was explicitly decided. If
something genuinely looks unlikely, write down why it looks unlikely and leave
the door open.

### Nothing is shipped, so nothing is protected

werk is not shipped. There is no shipped contract and no finalised decisions
really anywhere, the product is barely being used by one person yet, and
everything is subject to change.

That is true of the code and of the CLI's behaviour, not only of `docs/`.
Nothing is settled merely because it is currently written that way. There is no
need to worry about breaking API changes, output shapes or protocols, and no
work should preserve old behaviour for users who do not exist — no flag to keep
a command behaving as it did, no older spelling kept alongside a newer one, no
key withheld from a record so that nothing parsing it has to change.

The repository does assert shapes in places: the `--json` output test in
`packages/werk/test/json-output.test.ts`, the two output registers and the
exit-code table in [docs/cli.md](docs/cli.md), and the session wire protocol in
`@werk/session`. None of them is a reason to hold back. Naming them here is not
an instruction to go and change them; it removes them as an excuse.

The scale available is large. You can delete half of the code and rewrite it and
it will usually not disrupt anything. A change does not have to be small and it
does not have to be additive: if the right shape is a different shape, write the
different shape and move everything that meets it.

### Platforms are tiered

**Linux is the first-class citizen. macOS comes in a close second. Windows
tolerates the most broken things.**

That is where effort goes when something has to give, and it holds until there
is real investment in cross-platform usability and testing. It is not a claim
that Windows does not matter.

Everything downstream of that position is open. What a failing lane costs on
each platform, and whether any of it should be enforced in CI, are written down
as leans rather than rulings in [docs/platforms.md](docs/platforms.md). The epic
at https://github.com/omnilogic-labs/werk/issues/24 carries the philosophy and
the work tracked under it.

### Prose style

British spelling, plain sentences, no filler. Tables where a table is genuinely
clearer than a list. Prettier formats markdown on defaults — run `bun run
format` before committing.

Everything a person reads is prose held to the same standard: the strings the
CLI prints, the documents in `docs/`, the README files, commit messages and pull
request descriptions. Use the `plain-writing` skill on all of it. Read it before
writing, follow it, and run its revision pass over the draft. Where it and this
section disagree, this section wins.

The skill will not always be available. It is not part of this repository. It
may be linked into `~/.claude/skills`, where it can be invoked by name; it may
be somewhere on disk to be read as files; it may not be on the machine at all.
When it is missing, write to this section instead and say in your report that
the skill was not available. No work waits on it.
