# werk

**werk starts a process somewhere and lets you come back to it later.**

Locally, on a machine you can ssh to, or in a container it provisions. It puts
your repository there on a fresh branch, gives you a terminal that survives your
laptop closing, and shows you every one of those, across every machine, in one
list you can open from a terminal or a browser.

**Load the `plain-writing` skill before you write anything.** It applies to
everything you produce here, not just the documents: code comments, commit
messages, pull request descriptions, the strings the CLI prints, issue and
pull request comments, and what you write back in the conversation.
[Prose style](#prose-style) says what this repository adds to the skill and
what to do when it is not installed.

## What this repo is right now

A Bun workspace of eight private packages: six libraries, and two consumers
that use them.

| package                   | what it does                                                                                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@werk/terminal`          | Interprets terminal output and rebuilds the screen anywhere. Carries a pinned Ghostty WASM build, a snapshot format, and a DOM renderer. Its renderer interface is `RendererFactory` in `packages/terminal/src/types.ts`. |
| `@werk/session`           | The session client and wire protocol. The caller supplies the `Transport`, so the same client runs over a unix socket under Bun and over a WebSocket in a browser.                                                        |
| `@werk/session-daemon`    | Owns PTYs, persistence, and starting the local daemon.                                                                                                                                                                    |
| `@werk/terminal-beamterm` | A second implementation of `RendererFactory`, painting onto a WebGL2 canvas instead of DOM rows. It shows that a different renderer can be substituted for the bundled one.                                               |
| `@werk/workspace`         | Defines `WorkspaceMaker`, the interface for creating a workspace. One implementation makes a git worktree on this machine; another makes one over ssh. Under development and expected to change shape.                    |
| `@werk/palette`           | Catppuccin's four flavours mapped to werk's uses. The one place any colour is named.                                                                                                                                      |
| `packages/werk`           | The session CLI, named `@werk/cli` in the workspace.                                                                                                                                                                      |
| `examples/session-web`    | The local browser consumer.                                                                                                                                                                                               |

[docs/session-library.md](docs/session-library.md) covers the session packages.
Product direction lives in
[docs/product-specification.md](docs/product-specification.md), and what nobody
has answered yet lives in [docs/open-questions.md](docs/open-questions.md).

## Commands

```
bun install
bun run build
bun run typecheck
bun run test
bun test scripts --bail
bun run test:artefacts
bun run format:check
```

Run `bun run build` before `bun run typecheck`, always.
`packages/terminal-beamterm` imports `@werk/terminal` from `dist/`, so a
typecheck on a clean tree fails until a build has run.

`bun run test` names each package's test directory explicitly in
`package.json`, so a new package's tests do not run until you add it to that
line. `scripts/` is not on that line at all, which is why `bun test scripts` is
separate. `bun run test:browser` runs the Playwright suite and needs a browser
on this machine, which `bun run browser:install` tries to install.

## What earlier agents wrote down

`.claude/agent-memory/<role>/MEMORY.md` indexes findings that previous agents
recorded and verified in this repository, one line per file. Read your role's
index before starting, and open the files whose line touches what you are about
to do.

## Project rules

### Documentation reflects the present, not its history

A doc is a self-contained reference to the information we currently want
recorded. It is not a changelog of itself.

When something changes, whether a decision, a new finding or a correction,
**rewrite the doc so it reads as though it had always said the new thing**, and
make sure the rest of it is coherent after the edit: fix cross-references,
renumber, delete sentences whose premise is gone.

Do not write:

- "previously we said X, now we say Y"
- "this was originally scoped as X"
- "alternatives considered and rejected"
- "~~X~~ → Y" or any other visible trace of the edit

Git keeps the history if anyone ever wants it.

### Speculate. Do not decide.

**Default to the speculative voice.** Write "this probably wants to be X", "the
options are X or Y", "X is likely and nobody has worked out where it stops". Do
not write "werk does X" or "werk is not Y". Writing a maybe as a fact is the
single most costly mistake in this repo, because it gets read back later as
settled and nobody remembers that it wasn't.

Nothing in `docs/` is settled unless someone said it was. Do not invent
decisions, non-goals, scope exclusions, or roadmap commitments that were not
actually stated.

No file records decisions in one place. A question is settled when a document
says it is settled, in those words, or when the owner said so in the
conversation you are in. Nothing else counts: the code doing something one way
is not a decision to do it that way. When you can find neither, ask.

- A genuinely open question goes in
  [docs/open-questions.md](docs/open-questions.md), with the options laid out
  and any lean explicitly labelled as a lean.
- A research finding is a finding. It informs a decision; it is not one. What
  another project chose is evidence, not our position.
- If a doc needs a position in order to be coherent and nobody has taken one,
  say so in the doc and ask. Do not pick one and write it down as settled.

**We do not record decisions.** There is no decision register in this repository
and no document that holds one. The strongest thing a document may say is what
we are currently trying and why. Anything being built now can be replaced as
soon as it is wrong, and writing something down does not make it owed anything.
This is worth saying out loud because a reader, whether a person or an agent,
treats a recorded decision as a permanent constraint on everything after it. On
a project this young that is the expensive failure.

**A negative statement is the easiest way to write down a decision nobody
made.** "werk is not X", "X is out of scope", "we will never Y" all read as
closed doors and are almost never things anyone actually closed. Do not write
one unless it was explicitly decided. If something genuinely looks unlikely,
write down why it looks unlikely and leave the door open.

### Nothing is shipped, so nothing is protected

werk has one user and no released contract, so nothing needs backwards
compatibility. Do not add a flag, an alias, or a withheld field to preserve old
behaviour: no flag to keep a command behaving as it did, no older spelling kept
alongside a newer one, no key withheld from a record so that nothing parsing it
has to change. Change the behaviour instead. That holds for the code and the
CLI's behaviour as much as for `docs/`.

The repository does assert shapes in places: the `--json` output test in
`packages/werk/test/json-output.test.ts`, the two output modes and the
exit-code table in [docs/cli.md](docs/cli.md), and the session wire protocol in
`@werk/session`. Do not cite these as a reason to avoid a change.

Large rewrites are in scope. A change need not be small and need not be
additive: if the right shape is a different shape, write it and update every
caller.

### Platforms are tiered

**Linux gets the most effort, macOS next, Windows least. When a failure has to
be tolerated somewhere, tolerate it on Windows first.** That holds until there
is real investment in cross-platform usability and testing. It is not a claim
that Windows does not matter.

[docs/platforms.md](docs/platforms.md) says what a failing lane costs on each
platform, and whether any of it should be enforced in CI; both are leans there
rather than rulings. The epic at
https://github.com/omnilogic-labs/werk/issues/24 holds the rationale and the
child issues.

### The primary checkout stays on `main`

Other agents and sessions expect to find `main` at the repository path. Do not
check out a branch there. Work in a worktree instead. Both routes are
acceptable.

```
werk create --detach --workspace <name> -- /bin/sh
```

prints the workspace path and the branch and returns. It costs a daemon, which
it starts if none is running, and it puts the worktree under
`<stateDir>/workspaces/` rather than inside the repository.

```
git worktree add .claude/worktrees/<slug> -b <slug> main
cd .claude/worktrees/<slug> && bun install
```

needs no daemon, and costs you the `bun install` and the removal afterwards.
`.claude/night-shift/wt.sh new <slug>` runs this second route for the
night-shift pipeline, and also reports the port and the directories a unit's
test daemon should use.

### A change is proved on a branch before it lands

Commit the work, publish the branch to `origin`, dispatch a CI run against that
branch, read what the runners report and fix it, and merge to the base branch
last.

GitHub will run any ref `origin` already holds. A branch needs no merge and no
pull request to be tested. `bun scripts/ci-run.ts <lane>` starts the run and
watches it, and [docs/ci.md](docs/ci.md) has the lanes, the flags and the step
order. Do not open a pull request unless you were asked for one.

A passing local suite is evidence about one machine. werk targets Linux, macOS
and Windows, and the machine a change is written on covers at most one of them.

`main` carries known lane failures today: issue #30 on macOS and issue #31 on
Windows, both open. So the bar is a run no worse than the base: the lanes that
could observe the change pass, and nothing fails that was not failing already.
Read a red lane against the open issues rather than against a remembered list.
[docs/platforms.md](docs/platforms.md) weighs a failure on each platform. Which
lanes a change must run, and whether a documentation-only change needs one, are
leans rather than rulings, so say which lanes you ran.

Diagnose a failure on a platform you are not on the same way. Write the probe
that distinguishes the possibilities: a test that reports what it saw, a log
line, a narrowed case, or a one-file suite the lane runs instead of the whole
thing. Commit it to a branch nobody will merge, dispatch that lane, and read the
log with `gh run view <id> --log`. Iterate until the cause is in hand, then
throw the branch away and fix the real thing. A run takes about two minutes, so
cost is never a reason to skip one.

**Never report a platform as untestable.** `gh` and `bun scripts/ci-run.ts`
reach a Linux, a macOS and a Windows machine on demand, against any ref `origin`
holds. Do not submit an unverified guess for a platform whose lane you could
have dispatched. If you claim you could not verify something, give the lane
name, the run id and the log line that stopped you.

### Prose style

British spelling, plain sentences, no filler. Tables where a table is genuinely
clearer than a list. Prettier formats markdown on defaults, so run `bun run
format` before committing.

Read the `plain-writing` skill before writing, follow it, and run its revision
pass over the draft. Where it and this section disagree, this section wins.

If the `plain-writing` skill is not installed, follow this section instead and
say so in your report. No work waits on it.
