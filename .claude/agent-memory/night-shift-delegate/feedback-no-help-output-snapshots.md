---
name: feedback-no-help-output-snapshots
description: Do not pin user-facing prose or colour literals in tests; read the expected value off the source of truth it comes from
metadata:
  type: feedback
---

Do not write tests that must match help output — or any user-facing prose —
verbatim. No golden files, no snapshots, no frozen blocks of rendered text.

**Why:** the owner's words during issue #7: "literally every change we make in
the early product development will need to update this text". A snapshot that
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

**The same rule reaches colour, learned in #33.** A test may assert an exact
colour — that is a machine-facing value — but it must read it out of
`@werk/palette` rather than type the hex or the `rgb(...)` string. Two
assertions in `examples/session-web/test/browser.test.ts` pinned the palette
werk used before Catppuccin; #18 moved the palette and one of them went red on
`main`, while the other went quietly vacuous (`not.toBe(<a colour nothing
paints any more>)` passes whatever the page does). The vacuous one is the worse
failure: nobody would have found it.

Derive from the same route the code under test takes — the preview strip maps
SGR 31 through `dark.terminal.ansi[1]`, so the test does too. Note that
`page.evaluate` does not close over the test's scope, so a derived value has to
be passed in as an argument rather than referenced inside the callback.

**The one trap, learned in #8.** A property assertion covers placement, not
truth. `help-format.test.ts` had the `--json` footer pasted as a constant; it
was changed to import `JSON_FOOTER` from `runtime/help.ts`, which correctly
stopped the test pinning wording. In the same pass the footer was reworded to
"Every command takes --json and prints its result as JSON", which is false for
`attach` and `watch` — both stream and neither calls `result()`. No test could
have caught it, because the test now asserts only that the last line of every
page equals whatever the module says. A verifier found it by reading the string
against `commands/attach.ts`.

So: when a string makes a factual claim about behaviour, the property assertion
is not enough on its own. Either assert the claim against the behaviour (that
every command the footer covers really does return a result), or accept that
the sentence's truth is a review question rather than a test question, and put
it in front of a reviewer. Prefer wording that is true by construction: "Every
command accepts --json" is checkable from the flag table; "prints its result as
JSON" is a claim about every command's implementation.
