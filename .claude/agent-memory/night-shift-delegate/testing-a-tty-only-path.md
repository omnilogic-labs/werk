---
name: testing-a-tty-only-path
description: How to give a spawned werk a real pty from a bun test, and the four spawn details that let such a test pass without running the code it exists for
metadata:
  type: project
---

A werk defect can live entirely in the case where both streams are a terminal,
and the suite spawns binaries with pipes, so it sees nothing. Issue #42 was
exactly this: every command hung under a terminal and every test passed.

**Why:** the theme probe, `askTheTerminal` in `packages/werk/src/main.ts`, runs
only when stdout is a terminal, which `probeAllowed` in
`packages/werk/src/runtime/theme.ts` decides, and when stdin can be put into raw
mode. Piping either stream skips it, so the same code path is skipped and a
defect in it stays invisible to the suite. Colour, prompts, raw mode and attach
all sit behind it.

**How to apply:** when a change touches stdin, stdout or raw mode, run the CLI
under a pty before believing a green suite.

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
  exempts any path containing `/test/`, so no EXCEPTIONS entry is needed.
- **Do not set `NO_COLOR` in the spawn environment, and do delete `CI`.** Both
  make `probeAllowed` refuse, so the test would pass without running the code it
  exists for. Point `HOME` at the scratch directory too, or the reader's own
  `~/.werk/config.toml` can name a flavour and settle the theme without asking.

## The cost of a hang test

Against unfixed sources the eight cases in `tty.test.ts` take 270 seconds to
fail, all on the 30 second deadline. Against fixed sources the file runs in
under 3 seconds. Budget for the slow case when grading a failure.

What a pty run can be compared against, and the two stdin measurements behind
the hang, are in
[`docs/testing-terminal-behaviour.md`](../../../docs/testing-terminal-behaviour.md).
