---
name: reading-a-retried-test-failure
description: Under `bun test --retry`, the reported error can belong to an earlier attempt; how to tell, and why a lane looked flaky when it was not
metadata:
  type: reference
---

Under `bun test --retry=2`, the error printed against the final attempt is not
always that attempt's error. Read the timings before believing the line number.

**Why.** Bun's test timeout does not run the test's `finally`. Measured
directly: a test that awaits a never-resolving promise inside `try`/`finally`
and hits its timeout prints no output from the `finally`, and the next test
starts. So an attempt that ends at the timeout cleans up nothing, and Bun kills
its leftover subprocesses instead, which is the `killed N dangling processes`
line. Whatever that attempt was awaiting is still pending. It rejects when those
subprocesses die, and lands against whichever attempt is running by then.

**Two reading cues.**

- A silent gap the length of the test's timeout, ending in `killed N dangling
processes`, is an abandoned attempt.
- A duration far below what the test needs to reach its first assertion, a few
  hundred milliseconds against several seconds, means the error came from
  earlier. Playwright's `Target page, context or browser has been closed` is the
  usual shape of it.

Bun prints one `(fail)` line per test, for the last attempt only, so a middle
attempt leaves no summary of its own.

**What this cost once.** Issue #40 was opened because the `browser` lane looked
green and red at the same code across four runs. It was not. The four runs sit
on four different commits, and each outcome is what the code at that commit
predicts. The apparent flake was one real assertion failure on attempt 1 (a
pinned colour the palette no longer painted, fixed by #33), then an abandoned
attempt 2, then attempt 2's pending `waitForFunction` charged to attempt 3.

**What to do about it.** Give every wait in a test a ceiling well under the
test's own timeout, so a stall fails as that wait, at that line, inside the
attempt that caused it. Playwright's default ceiling is 30 seconds, which is the
same as a common test timeout, so the two race and the test timeout wins.

Related: [[dispatch-a-real-ci-run]].
