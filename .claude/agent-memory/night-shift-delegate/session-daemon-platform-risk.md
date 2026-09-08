---
name: session-daemon-platform-risk
description: A null-answering platform reader silently disables its guards, platformCapabilities is wire-visible, and three session-daemon tests need Windows or root
metadata:
  type: project
---

Three things about the platform code in `packages/session-daemon` are easy to miss.

**A reader that answers `null` off one platform turns off every guard that
consumes it, and says nothing.** `processStartedAt` answered `null` anywhere but
Linux, which disabled both the pid-reuse check and the `SIGUSR1` nudge in
`ensureSessionDaemon`; the test that would have caught it was skipped by
`skipIf(platform !== "linux")`. Issue #30 was that pair. Skip a capability's test
only on the platforms that lack the capability, so a silent `null` fails loudly.

**`platformCapabilities`, exported from `src/platform/index.ts`, travels over the
wire.** It is spread into the daemon's capabilities in `src/index.ts` and
returned by `daemonInfo()`, and `packages/session/src/types.ts` ends that type
with `[key: string]: unknown`, so a new field typechecks silently and changes the
protocol payload. Put new predicates in a separately named export.

**Three tests need Windows or root**, so Windows job objects, the loopback
credential and directory-ownership rejection are verified by inspection alone:
`test/native.test.ts` twice, and `test/local.test.ts` once.
