---
name: dispatch-a-real-ci-run
description: Grade a platform or workflow change by dispatching a real CI run on a published branch, and dispatch twice for a workflow change
metadata:
  type: feedback
---

Publish the branch and dispatch a real run, as `CLAUDE.md` requires, whenever
the change touches platform-specific code or `.github/workflows/`. Nothing local
runs the workflow at all.

A workflow change needs two dispatches. The `native` matrix is one `fromJSON`
expression, so a single named lane exercises only the narrow branch and only
`lanes=all` exercises the default list a push to `main` uses. Wait for the
first URL before dispatching the second; repeating a lane on one branch cancels
the run in flight.

Read the result against the open issues, not a remembered list of red lanes.
#30 on macOS and #31 on Windows are open. Before calling a lane intermittent,
put the commit beside every outcome: the browser lane once looked green and
red at the same code, and it was four runs on four commits, see
[[reading-a-retried-test-failure]].
