---
name: feedback-no-help-output-snapshots
description: Never pin user-facing prose or a colour literal in a test; assert properties, and read exact values off the source of truth they come from
metadata:
  type: feedback
---

Do not write tests that must match help output, or any user-facing prose,
verbatim. No golden files, no snapshots, no frozen blocks of rendered text. The
owner's words during issue #7: "every change we make in the early product
development will need to update this text". That overrode work already
committed: `packages/werk/test/help.golden.txt` was deleted.

Assert properties that survive rewording instead:

- structure over text: every command declares a summary, a description and at
  least one example;
- values read off the source of truth, such as the example a command's own spec
  carries, not a pasted string;
- substrings naming the concept under test, not the whole sentence.

Exact matches remain fine for machine-facing values: a table cell, an empty
stderr, a JSON error code. A colour is one, but read it from `@werk/palette`
rather than typing the hex. Two assertions in
`examples/session-web/test/browser.test.ts` pinned the pre-Catppuccin palette;
#18 moved it, one went red and one went quietly vacuous.
