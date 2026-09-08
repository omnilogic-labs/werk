---
name: push-and-run-real-ci
description: Push your own branch and dispatch a real CI run when the change touches platform-specific code; a green Linux run is not evidence about macOS or Windows
metadata:
  type: feedback
---

Push your own working branch and dispatch a real CI run against it. Do not treat
a green local run as evidence that a cross-platform change works.

**Why:** the owner corrected a dispatch that said "push nothing" during issue
#26, and was explicit that it mattered more for that unit than for most: the
change moved the platform code in `packages/session-daemon`, on a Linux machine,
and that code exists precisely because macOS and Windows behave differently. A
refactor there can look green locally and be broken on both platforms it exists
for. A run across the matrix is the only evidence that says otherwise.

**How to apply:** when the change touches platform-specific code, or anything
whose behaviour differs by platform, push the branch and dispatch a run before
returning. Report the run URL and what each lane said.

```sh
git push -u origin <your-branch>
bun scripts/ci-run.ts all          # or linux / macos / windows / musl / browser / soak
bun scripts/ci-run.ts all --no-watch   # dispatch and print the URL
```

GitHub can run any ref `origin` already holds. **No merge and no pull request is
needed** — the helper refuses with exit 2 if `origin` lacks the branch at the
commit in hand, and it never pushes for you. `docs/ci.md` carries the lanes and
the step order.

What stayed forbidden in that run: pushing `main`, opening a pull request, and
touching another agent's published branch. Those are worth confirming rather
than assuming, since the boundary is about whose work you might overwrite.

**Reading the result.** Failures already present on `main` are not yours. During
the #26 run these were open and known: #30 (macOS, a daemon alive with no
endpoint, `supervise.test.ts`) and #31 (Windows, a preview request timing out
instead of rejecting, `daemon.test.ts`). Check the open issues for known lane
failures before reporting a red lane as a regression — and report anything else
red.

See [[session-daemon-platform-risk]] for what a local run cannot tell you about
this package.
