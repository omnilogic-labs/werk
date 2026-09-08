---
name: session-daemon-platform-risk
description: platformCapabilities in session-daemon is wire-visible, and three of its tests need Windows or root before they run at all
metadata:
  type: project
---

`packages/session-daemon` holds werk's platform code and is least covered by
tests that run on any single machine. Two facts about it, found while planning
issue #26, are easy to miss.

`platformCapabilities`, exported from `src/platform/index.ts`, is spread into
the daemon's capabilities in `src/index.ts`, returned by `daemonInfo()`, and so
travels over the wire. `packages/session/src/types.ts` ends that type with
`[key: string]: unknown`, so adding a field typechecks silently and changes the
observable protocol payload. Put new predicates in a separately named export.

Three tests need Windows or root, so Windows job objects, the loopback
credential and directory-ownership rejection are verified by inspection alone:

- `test/native.test.ts`, Windows kernel job cleans descendants after abrupt
  owner death;
- `test/native.test.ts`, Windows endpoint requires its per-start credential;
- `test/local.test.ts`, client rejects another owner's runtime directory (root).
