---
name: testing-a-tty-only-path
description: How to give a spawned werk a real pty from a bun test, and the two stdin facts that make a TTY-only bug invisible to a piped test suite
metadata:
  type: project
---

A werk defect can live entirely in the both-streams-are-a-terminal case, and the
suite spawns binaries with pipes, so it sees nothing. Issue #42 was exactly
this: every command hung under a terminal and every test passed.

**Why:** the theme probe in `packages/werk/src/runtime/ground.ts` runs only when
stdout is a terminal and stdin can be put into raw mode. Piping either stream
skips it. Any future work on colour, prompts, raw mode or attach has the same
blind spot.

**How to apply:** when a change touches stdin, stdout or raw mode, run the CLI
under a pty before believing a green suite.

## The two stdin facts that cost the most time

Both measured on bun 1.3.14, Linux, 2026-09-08.

`process.stdin.isPaused()` returns `false` at process start. It reports
`flowing === false`, and the state at startup is `null`, which is neither
flowing nor paused. So `isPaused()` is not a usable "was this stream flowing
before I touched it" predicate, and code that captures it and restores it later
is dead code that reads as though it handled the case.

Removing a `data` listener does not stop the read. The stream stays in flowing
mode with the libuv handle held, and the process never exits. `pause()` is what
releases it. A script that adds a listener and removes it hangs; the same script
with `pause()` added exits 0.

## Giving a spawned process a pty, with no new dependency

`script` is the whole mechanism. `packages/werk/test/tty.test.ts` is the worked
example.

```
Bun.spawn(["script", "-qec", command, "/dev/null"], { stdin: "pipe", ... })
```

Four things about it are not obvious:

- **`script`'s own stdin is the pty master.** Writing to it reaches the child as
  terminal input, which is how a terminal that answers `OSC 11` gets tested
  without a native pty binding.
- **The pty echoes what is written to it, in caret notation.** An `ESC` byte
  comes back as the two characters `^[`, which no escape-sequence strip removes.
  Rebuild the echoed form from what was written and subtract it.
- **`-qec` is util-linux. BSD and macOS `script` take different arguments.**
  Probe the capability at module top level and `describe.skipIf` on the result,
  rather than comparing `process.platform`. `scripts/check-platform-code.ts`
  exempts any path containing `/test/`, so no EXCEPTIONS entry is needed either
  way.
- **Do not set `NO_COLOR` in the spawn environment, and do delete `CI`.** Both
  make `probeAllowed` refuse, so the test would pass without running the code it
  exists for. Point `HOME` at the scratch directory too, or the reader's own
  `~/.werk/config.toml` can name a flavour and settle the theme without asking.

## Output cannot be compared across the two registers

`werk list` prints a table header on a terminal and nothing at all through a
pipe. Comparing a pty run with a piped run therefore fails on content even when
nothing is wrong. Compare a pty run with a `NO_COLOR` pty run instead: same
register, probe refused. Compare the opening line rather than the whole output,
because `werk doctor` reports the daemon log and its timestamps differ per run.

Exit codes do match across registers, so those are safe to read off a piped run
rather than writing a number down. Related:
[[feedback-no-help-output-snapshots]].

## The cost of a hang test

Against unfixed sources the eight cases in `tty.test.ts` take 270 seconds to
fail, all on the 30 second deadline. Against fixed sources the file runs in
under 3 seconds. Budget for the slow case when grading a failure.
