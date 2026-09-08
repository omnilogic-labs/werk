---
name: dispatch-a-real-ci-run
description: Grade a platform or workflow change by dispatching a real CI run on a published branch, never by a passing local suite
metadata:
  type: feedback
---

Push your working branch and dispatch a real CI run whenever the change touches
platform-specific code or `.github/workflows/`. A passing local suite is
evidence about one platform, and nothing local runs the workflow at all. The
owner corrected a dispatch that said "push nothing" during issue #26.

`git push -u origin <branch>` then `bun scripts/ci-run.ts all --no-watch`.
GitHub runs any ref `origin` already holds, with no merge and no pull request.
Never push `main` and never touch another agent's published branch.

A workflow change needs two dispatches. The `native` matrix is one `fromJSON`
expression, so a single named lane exercises only the narrow branch and only
`lanes=all` exercises the default list a push to `main` uses. Wait for the
first URL before dispatching the second; repeating a lane on one branch cancels
the run in flight.

Read the result against the open issues, not a remembered list of red lanes.
#30 on macOS and #31 on Windows are open.
