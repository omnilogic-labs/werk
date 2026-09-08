# Testing terminal behaviour

What a test learns from running werk under a real terminal, and what it cannot
learn by comparing that run with a piped one. The recipe for giving a spawned
process a pty is in
[`.claude/agent-memory/night-shift-delegate/testing-a-tty-only-path.md`](../.claude/agent-memory/night-shift-delegate/testing-a-tty-only-path.md).

## Two stdin measurements

Both measured on bun 1.3.14, Linux, 2026-09-08.

`process.stdin.isPaused()` returns `false` at process start. It reports
`flowing === false`, and the state at startup is `null`, which is neither
flowing nor paused. So `isPaused()` is not a usable "was this stream flowing
before I touched it" predicate. Code that captures it and restores it later is
dead code that reads as though it handled the case.

Removing a `data` listener does not stop the read. The stream stays in flowing
mode with the libuv handle held, and the process never exits. `pause()` is what
releases it. A script that adds a listener and removes it hangs; the same script
with `pause()` added exits 0.

## Output cannot be compared across the two registers

`werk list` prints a table header on a terminal and nothing at all through a
pipe. Comparing a pty run with a piped run therefore fails on content even when
nothing is wrong. Compare a pty run with a `NO_COLOR` pty run instead: same
register, probe refused. Compare the opening line rather than the whole output,
because `werk doctor` reports the daemon log and its timestamps differ per run.

Exit codes do match across registers, so those are safe to read off a piped run
rather than writing a number down.

Related:
[`feedback-no-help-output-snapshots.md`](../.claude/agent-memory/night-shift-delegate/feedback-no-help-output-snapshots.md),
on reading an expected value off its source of truth rather than pinning it.
