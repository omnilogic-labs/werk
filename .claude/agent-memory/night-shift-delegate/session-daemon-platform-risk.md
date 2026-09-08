---
name: session-daemon-platform-risk
description: A null-answering platform reader silently disables its guards, platformCapabilities is wire-visible, three session-daemon tests need Windows or root, and a Windows fault there reads as a client timeout
metadata:
  type: project
---

Four things about the platform code in `packages/session-daemon` are easy to miss.

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

**A response the daemon has already written can go undelivered on Windows.** The
client reports `Request timed out; remote outcome is unknown` at whichever
assertion was waiting, so the failing line names the victim, and `--retry`
hides most of it. Measured for issue #31: the daemon logged the error,
`socket.write` settled in 0 ms, later frames went out on the same connection, a
fresh connection answered in 3 ms, and the client saw nothing for five seconds.
Whatever loses it is in the client's receive path, not the request path.
Instrument a race like that in memory: a log file, a console line, or a bare
20 ms `setInterval` in the test file each made it stop happening.
