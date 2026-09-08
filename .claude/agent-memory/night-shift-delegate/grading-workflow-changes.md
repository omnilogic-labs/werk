---
name: grading-workflow-changes
description: A change to .github/workflows can only be graded by dispatching a real CI run with scripts/ci-run.ts; dispatch both the narrow lane and `all`, and know which reds are baseline
metadata:
  type: project
---

A change to `.github/workflows/session-libraries.yml` cannot be graded by a
green local suite. Dispatch a real run instead: `bun scripts/ci-run.ts <lane>
--no-watch` against any branch `origin` already holds, no merge and no pull
request. Push the feature branch; never `main`.

**Why:** the workflow is the thing under test, and nothing local executes it. A
criterion that says "the YAML names the right label" is a different and much
weaker claim than "the lane starts on that runner and reports".

**How to apply:**

- Dispatch **two** runs, not one. The `native` matrix is a single `fromJSON`
  expression with several branches: `lanes=macos` exercises the narrow branch,
  and only `lanes=all` exercises the default list that a pull request and a push
  to `main` actually use. A narrow dispatch leaves that string checked by
  reading alone.
- `concurrency` is keyed on the lanes input, so the two runs do not cancel each
  other — but a second dispatch of the _same_ lane on the same branch does,
  because `cancel-in-progress: true`.
- The helper attaches to the newest `workflow_dispatch` run on the branch, so
  wait for the first URL to print before dispatching the second.
- Architecture and image are evidence you can read: the "Set up job" step logs
  an `Image:` line (`macos-26-arm64`, `macos-15`). A step to print the
  architecture is not needed.
- `gh run view <id> --json jobs` gives per-step conclusions, which is usually
  enough; `gh run view --job <id> --log` gets the failing assertion.

**Know which reds are baseline before reading a run**, or a pre-existing failure
gets attributed to the change under test. As of 2026-09-08 on `main`:
`ubuntu-latest` and `musl` green; `macos` red at
`packages/session-daemon/test/supervise.test.ts:258` (#30); `windows` red at
`packages/session-daemon/test/daemon.test.ts:640` (#31); `browser` intermittent
at "built browser paints DOM, reconnects, resizes and lazily swaps to beamterm",
seen both green and red at the same commit. That list dates quickly — check the
issues rather than trusting it.

Related: [[browser-lane-not-gradeable-locally]], [[werk-cross-platform-state]].
