---
name: browser-lane-not-gradeable-locally
description: bun run test:browser cannot be graded on this machine — pinned Playwright 1.58.2 refuses to install chromium on ubuntu26.04-x64; mark it UNVERIFIED (environment), do not install browsers
metadata:
  type: project
---

`bun run test:browser` cannot be run on this development machine. The pinned
`playwright` 1.58.2 in `examples/session-web` refuses to install its browser:
`ERROR: Playwright does not support chromium on ubuntu26.04-x64`. The suite then
fails at browser launch in `examples/session-web/test/browser.test.ts`, while the
two non-browser tests in that run still pass.

**Why:** the host is ahead of what that Playwright release knows about. It is an
environment gap, not a defect in any change under test, and it is orthogonal to
whatever is being built.

**How to apply:** when a unit's criteria include the browser leg, grade it
`UNVERIFIED (environment)` with that error quoted, rather than `FAIL`. Let the
`browser` CI lane grade it instead: publish the branch and dispatch a run with
`bun scripts/ci-run.ts browser` (`docs/ci.md`). No merge and no pull request is
needed, and a green lane on a real run is the only acceptance evidence this leg
has. Do not assume the lane is green because it was green last time — #33 exists
because #18 turned it red on `main` and nothing local noticed.

Do not reach for `bunx playwright install chromium` as a workaround. It succeeds,
but installs a _newer_ Playwright's browser build (a different numbered
directory) which the pinned version will not use, so the suite fails identically
and the machine is left with an unused ~115 MB download to clean up.

Related: [[werk-cross-platform-state]].
