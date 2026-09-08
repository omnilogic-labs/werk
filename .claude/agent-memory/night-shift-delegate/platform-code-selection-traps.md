---
name: platform-code-selection-traps
description: No OS condition exists in package exports, an unset bun feature() flag is silently false, and pure functions are the answer werk already uses
metadata:
  type: project
---

Conditional exports cannot select a platform. There is no OS-based `exports`
condition in Node or Bun, and neither runtime's set of recognised conditions
contains one. It is the mechanism people reach for first.

An unset `bun:bundle` `feature()` flag evaluates to `false` with no error, so a
forgotten build flag ships the opposite branch silently. That is why build-time
selection fits werk poorly. Go's old `// +build` constraints failed the same
way: a misplaced one was ignored rather than rejected. A marker convention must
fail loudly when the marker is absent, not only when wrong.

Test platform code you cannot run by making it a pure function that takes the
platform as a parameter, so both branches run everywhere. `daemonEnvironment`
and `libcCandidates` already do this.

All three come from the platform-code survey in issue #26, whose full text is a
comment on that issue. It is evidence rather than a decision.
