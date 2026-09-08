---
repo: omnilogic-labs/werk
base_branch: main
push_policy: never
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

`CLAUDE.md` at the repo root governs everything, and two of its rules decide
more work here than anything in this file: documentation reflects the present
rather than its history, and a maybe is never written as a fact. `docs/ci.md`
says how a change is proved. `docs/platforms.md` says how much brokenness each
platform is allowed.

## Nothing here is shipped

werk is used by one person and nothing depends on it. There is no backwards
compatibility to keep, no output shape to preserve, no protocol to hold still.
Half the code can be deleted and rewritten without disrupting anything.

The failure this causes is specific and has already happened: a unit asked to
make `werk create` create a workspace put it behind an opt-in flag, so that the
old behaviour was still available, and the thing that was asked for did not
happen. If you find yourself preserving something for a user, there is no user.
Preserve the general use cases the product supports. Everything below that is
detail, and detail is expected to churn, sometimes twice in a day.

## Prove it on a runner, then land it

The gates below run on this machine. Three things do not:

- **Windows and macOS.** There is no such host here. `#30` and `#31` are open
  failures on those platforms.
- **The browser lane.** The pinned Playwright refuses chromium on this host.

So a green local suite is not evidence about any of them, and the loop that
produces evidence is: commit, publish your own branch, dispatch a run against
it, read what the runners say, fix, dispatch again. `docs/ci.md` explains it and
`scripts/ci-run.ts` does it. GitHub runs any ref `origin` already holds, with no
merge and no pull request.

**Publish your own branch freely. Never push `main`.** Integration is
serialised and happens after the evidence exists, not before it. A regression
reached `main` in exactly the gap this closes: a browser assertion pinned a
colour the palette no longer paints, the unit that broke it could not run that
lane locally and substituted a walk of the page, and only CI saw it.

When something genuinely cannot be verified here, mark it `UNVERIFIED` and say
what the grade therefore does not assert. Do not pass it on inspection. Several
units have done this correctly and it is the behaviour wanted.

## The toolchain, and the order it goes in

`bun run build` before `bun run typecheck`, always: `packages/terminal-beamterm`
imports `@werk/terminal` from `dist/`, so a typecheck from a clean tree fails
until a build has run. This is pre-existing and is not yours to fix inside
another unit.

The full local sequence, which is what CI runs and what an integration must
pass:

```
bun run build
bun run typecheck
bun run test
bun test scripts --bail
bun run test:artefacts
bun run format:check
```

`bun run test` names each package's test directory explicitly, so **a new
package's tests do not run until it is added to that script**, and `scripts/`
is not in it at all. `bun run test:browser` cannot run here.

`bun.lock` regenerates on any `bun install`. If it conflicts at integration,
take the base's copy and re-run `bun install` rather than merging it by hand.

## Servers, sockets and ports

A unit's port is reported by `provision` and is that unit's alone. Whoever
starts a server stops it, and stopping it means **signalling the process
group**: the pid a launch reports is commonly a wrapper, and the port is held by
a child. That has been observed here directly, with a reported pid of 830881 and
the port held by 830885.

A unix socket path is capped at 103 bytes and a worktree path exceeds it, so a
daemon started for testing runs against the `RUNTIME_DIR` and `STATE_DIR` that
`provision` reports, under `/tmp`, not inside the worktree.

There is usually a `werk daemon serve` running on this machine that belongs to
the primary checkout and to the person using it. It is not yours. Confirm what a
process is before signalling it, by working directory, never by command name.

## Your memory is tracked in this repository

`.claude/agent-memory/<role>/` is committed. Write what you learn there **in
your worktree** and include it in your commit and in `FILES`. Never write into
the primary checkout's copy: another agent's integrator may be mid-merge in that
tree, and an unstaged edit appearing under it is at best confusing.

## Conflicts

An integrator hands a fixer facts and asks it to resolve the conflicts. It does
not say which side should win, and it does not pass a principle. The integrator
runs on a small model and has read commit messages and a diffstat; the fixer
reads the code. An interpretation invented by the weaker model becomes an
instruction the stronger one obeys, and the resolution it would have reached
independently never happens.

That applies to whoever dispatches the integrator too.

## Prose

British spelling, plain sentences, no filler, no em dashes in new text. The
`plain-writing` skill is the standard `CLAUDE.md` points at; if it is not
invocable by name, read it from
`/home/mike/Development/is4co/agent-skills/skills/plain-writing/`.

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
- **Sub-documents that state as fact what their parent lists as absent.**

## Escalation

Decide the detail; ask about the direction. A unit that would be better after a
question nobody has answered returns `BLOCKED` with the question, or records it
as an open question in `docs/product-specification.md` with the options and any
lean labelled as a lean. Shipping a flag to avoid a decision is the thing this
repository has already been burned by.
