---
name: commander-negated-flags
description: Commander stores --no-x as {x:false}; reading a noX key is silently always false
metadata:
  type: reference
---

Commander reads `--no-x` as the negation of `x`, so it stores `{x: false}` and
there is no `noX` key. A guard reading `flags.noX === true` never fires, and
never errors either, because the value is `undefined`.

`--no-input` shipped that way and nothing caught it: every test process lacks a
terminal, so `noInput` on the context was already true for the other three
reasons. A test has to drive real argv through `buildProgram` and ask the guard
what it forbids on streams it is told are terminals.
