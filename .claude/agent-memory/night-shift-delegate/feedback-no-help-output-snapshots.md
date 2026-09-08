---
name: feedback-no-help-output-snapshots
description: Do not write tests that match CLI help or other user-facing prose verbatim; assert properties instead
metadata:
  type: feedback
---

Do not write tests that must match help output — or any user-facing prose —
verbatim. No golden files, no snapshots, no frozen blocks of rendered text.

**Why:** werk is early and unshipped, and `CLAUDE.md` records that nothing in it
is settled: user-facing prose is expected to be rewritten constantly, and #8
exists to rewrite all of it again. A snapshot that
gets regenerated on every ordinary change stops being read and starts being
reset, so it catches nothing while still costing a diff every time. This
overrode work already committed — `packages/werk/test/help.golden.txt` was
deleted rather than kept.

**How to apply:** when a test needs to cover help, errors, or any rendered
prose, assert properties that survive rewording:

- structure over text — every command declares a summary, a description and at
  least one example;
- values read back off the source of truth — assert the help contains
  `specFor(command).examples[0].run` rather than a pasted string;
- substrings that name the _concept_ under test (`toContain("command to run")`),
  not the whole sentence;
- make omission a compile error where the type system can (a non-empty tuple
  field on a spec) instead of a test that lists what must exist.

Exact-match assertions are still fine for narrow machine-facing things: a single
table cell, an empty stderr, a JSON error code.
