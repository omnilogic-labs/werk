---
repo: omnilogic-labs/werk
base_branch: main
push_policy: after-each
concurrency_cap: 3
priority_order: [security, bug, feature]

hooks:
  preflight: bash .claude/night-shift/preflight.sh
  provision: bash .claude/night-shift/wt.sh new
  teardown: bash .claude/night-shift/wt.sh remove
  integrate: bash .claude/night-shift/wt.sh integrate
  sweep: bash .claude/night-shift/sweep.sh
  serving: bash .claude/night-shift/serving.sh
  build: bun run build
  typecheck: bun run typecheck
  test: bun run test

references:
  - docs/platforms.md
  - docs/ci.md
prior_art: true
---

# werk, for night-shift

## Read these first

`CLAUDE.md` at the repo root governs everything here, and its project rules
decide more work than anything in this file. `docs/ci.md` says how a change is
proved. `docs/platforms.md` says how much brokenness each platform is allowed.

## Nothing here is shipped

`CLAUDE.md` carries the rule. The failure it prevents has already happened here:
a unit asked to make `werk create` create a workspace put it behind an opt-in
flag, so the old behaviour was still available and the thing that was asked for
did not happen. If you find yourself preserving something for a user, there is
no user. Preserve the general use cases the product supports. Everything below
that is detail, and detail is expected to churn, sometimes twice in a day.

## Prove it on a runner, then land it

`CLAUDE.md` carries the rule. What it does not carry:

```
bun scripts/ci-run.ts all --ref <your branch>      every lane but soak
bun scripts/ci-run.ts macos --ref <your branch>    one lane by name
```

Lanes are `linux`, `macos`, `windows`, `musl`, `browser`, and `soak`, which is
asked for by name because it is long. `scripts/ci-run.ts --help` has the flags.

Integration is serialised and happens after the evidence exists, not before it.
A regression reached `main` because nobody dispatched the lane. A browser test
pinned a colour the palette no longer painted. The unit that broke it could not
run the browser lane on its machine and replaced the assertion with a manual
walk of the page, so only CI caught it.

`#30` on macOS and `#31` on Windows are open failures, so measure a run against
that baseline rather than against green.

**`UNVERIFIED` is for what no runner can reach.** When something genuinely
cannot be verified, mark it `UNVERIFIED` and say what the grade therefore does
not assert. Do not pass it on inspection.

`bun run test:browser` needs a browser on this machine and Playwright refuses
hosts it has no build for. The lane has been run here and passes, so it is not
out of reach. `bun run browser:install` is the attempt to make getting there one
step, and `docs/continue/cleanup.md` carries what is proved, what is not, and
the manual recipe that worked.

## The toolchain, and the order it goes in

The commands and their ordering trap are in `CLAUDE.md`. That sequence is what
CI runs and what an integration must pass. Two things it does not say apply to a
pipeline unit.

The build-before-typecheck failure is pre-existing. It is not yours to fix
inside another unit.

A unit's footprint is checked against its merge base, not against the tip:
`git diff $(git merge-base main HEAD) HEAD`. `main` moves under a live branch, so
`git diff main` renders another lane's landed files as deletions on yours and
fails a criterion that nothing did wrong.

`bun.lock` regenerates on any `bun install`. If it conflicts at integration,
take the base's copy and re-run `bun install` rather than merging it by hand.

## Servers, sockets and ports

A unit's port is reported by `provision` and is that unit's alone. Whoever
starts a server stops it, and stopping it means **signalling the process
group**: the pid a launch reports is commonly a wrapper, and a child of it holds
the port.

A unix socket path is capped at around 100 bytes on Unix, and a worktree path
can exceed it, so a daemon started for testing runs against the `RUNTIME_DIR` and
`STATE_DIR` that `provision` reports rather than a path inside the worktree.

A `werk daemon serve` belonging to the primary checkout, and to whoever is using
it, is commonly running alongside you. It is not yours. Confirm what a process is
before signalling it, by working directory, never by command name.

## Your memory is tracked in this repository

`.claude/agent-memory/<role>/` is committed and every agent that arrives reads
all of it, so its length is a cost everyone pays. Write what you learn there
**in your worktree** and include it in your commit and in `FILES`. Never write
into the primary checkout's copy: another agent's integrator may be mid-merge in
that tree, and an unstaged edit appearing under it is at best confusing.

What earns a file is the one thing the next unit would get wrong without it. If
reading it would not change what someone does, it is not a memory.

**Write it about the repository, not about your machine.** The test is whether
the sentence stays true for someone on macOS or Windows. Where the fact is about
your host, record what the reader has to find out on theirs, the way the sections
above this one do. No absolute paths out of a home directory, no host
identifiers, no process ids.

Date a measurement when the date tells the reader when to re-take it, as in
"measured on bun 1.3.14, Linux, 2026-09-08". Do not date a status list: which
lanes are failing today rots within the week, so point at the open issues
instead.

Keep it to a handful of lines. Past roughly twenty-five lines it is a document,
and a document belongs in `docs/`, or on the issue that commissioned it, where
somebody maintains it. Do not restate what this file, `CLAUDE.md` or `docs/`
already says; two copies of a fact go stale separately and the reader cannot
tell which is current.

Prefer editing an existing file to adding one. Read the role's memory before you
write, and update its `MEMORY.md` in the same commit so the index matches the
directory. The prose standard below applies to memory as much as to anything
else.

## Conflicts

When a conflict goes from an integrator to a fixer, pass the commit messages and
the diff and nothing else. Do not name a preferred side and do not pass a
principle. The integrator runs on a small model and has not read the code; the
fixer has. An interpretation the integrator invents becomes an instruction the
fixer obeys, and the resolution the fixer would have reached on its own never
happens. That applies to whoever dispatches the integrator too.

## Prose

The `plain-writing` skill is the standard `CLAUDE.md` points at. If it is not
invocable by name where you are, it is a directory of markdown you can read
directly; find where it is installed rather than skipping it. A skills directory
can look empty when it is not, because `find` does not follow symlinks by
default, so use `find -L` or `ls` before concluding the files are missing.

A rewrite of user-facing prose can quietly turn a true sentence into a false
one. It happened here: a footer became "every command prints its result as
JSON", which is false for `attach` and `watch`, and no test could catch it
because the test reads the same constant the page does. **A property assertion
covers a string's placement, not its truth.** Prefer wording that is true by
construction.

## What tends to be wrong here

Offered so a unit recognises the shape rather than rediscovering it.

- **Built, documented, wired to nothing.** A flag that parses into a key nothing
  reads, config settings that resolve and are never consulted, an escape hatch
  with no caller, a CI step that asserts nothing. Check that what you add is
  actually reached.
- **Tests that construct the value under test by hand.** The suite is strong at
  the function level and at the spawned-binary level and thin exactly where flag
  parsing, config merge and context construction meet.
- **A guard written in one place and missing from the one that needs it.**
- **A document under `docs/product/` that states a feature as built when
  `docs/product-specification.md` lists it as not built.** Nobody has caught one
  of these yet, so it is a risk rather than a sighting. Check what a document
  claims exists against "What exists today" before repeating it.

## Escalation

A unit that would be better after a question nobody has answered returns
`BLOCKED` with the question, or records it as an open question in
`docs/open-questions.md` with the options and any lean labelled as a lean.
Decide the detail yourself. Do not ship a flag to avoid a decision.
