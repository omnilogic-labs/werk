# Where platform-specific code lives

Someone should be able to ask "what makes the Windows code the Windows code?"
and answer it by looking, rather than by reading everything. This is what we are
currently trying in order to make that possible. It is a first shape and we
should expect to change it.

## The two places

**`packages/session-daemon/src/platform/` holds the implementations.**
`win32.ts` is the Windows one, `posix.ts` is the Unix one, and `lock.ts` and
`index.ts` are the seams that pick between them. Everything that talks to a
kernel job object, a `flock`, a process group or a PowerShell ACL is in there.

**`EXCEPTIONS` in [`scripts/check-platform-code.ts`](../scripts/check-platform-code.ts)
lists the branching that is still somewhere else.** Each entry names a file, how
many platform-conditional lines it has, why they are there, and whether anyone
means to keep them: `stays` for a branch that looks like it belongs where it is,
`wants-moving` for one that reads as debt.

Reading those two together is meant to be the whole answer. Neither is enough on
its own, which is worth saying because it is not obvious: `win32.ts` never
mentions `process.platform` at all, because the whole file is already the Windows
answer and nothing in it needs to ask. A scanner looking for branching would say
that file is clean. The directory holds implementations; the list holds
decisions. The question needs both.

## Why a list rather than a marker

A marker you have to remember to add is a marker you can forget, and forgetting
is silent. So the list is inverted: nothing has to be labelled, and a platform
branch that nobody has declared is what fails the check. The loud case is the one
where somebody did not think about it.

The count is exact rather than an upper bound. A file that grows a branch fails,
and so does a file that loses one without the number coming down. The second half
is the part that keeps the list honest, since a ceiling with room under it
gradually stops describing anything.

## Running it

```sh
bun scripts/check-platform-code.ts
```

It prints the offending file, line and pattern, or a one-line summary of the
surface. `bun test scripts` runs it as a test, which is how it reaches CI: the
`native` job runs that on Linux, macOS and Windows.

The check is a text scanner rather than anything that understands TypeScript, so
it can rot into a matcher that finds nothing and reports a clean tree. Its tests
therefore assert that it still works and not only that the repository passes:
every pattern has a line it must catch and a line it must not, the walk has to
have read a plausible number of files including named ones, and the patterns the
codebase actually uses have to still be found. A walk that silently matched
nothing would fail those rather than pass quietly — which matters most on
Windows, where a path-separator mistake is exactly how a walk goes quiet.

## The habits this is built on

Three things already in the codebase seem to be working, and the shape above is
mostly an attempt to name them.

**Take the platform as a parameter, and default it.** `daemonEnvironment(source,
windows)`, `libcCandidates(platform, arch)`, `defaultSessionRuntimeDir(env,
platform, uid)` and the predicates in `platform/rules.ts` all read the platform
only as a default. The Windows answer is then reachable from a Linux machine,
which is the only way most of it gets exercised at all — the tests for those run
both branches everywhere.

**Decide once, then branch on the decision.** `serveSessionDaemon` works out a
loopback credential from the platform in one place; everything after that asks
whether there is a credential, not what the platform is. `relock` asks whether
the lock it holds is a `flock`, which is a fact about the mechanism rather than
about the operating system. This tends to read better than the platform test it
replaces, because the thing being asked about is the thing that matters.

**Say what a platform can do, not which one it is.** `platformCapabilities`
carries `pty`, `processGroups` and `processTreeSummary`. A caller that wants to
know whether it can signal a process group is better served by that than by a
list of operating systems that can.

## The doors

`index.ts`, `lock.ts` and `rules.ts` are imported from outside the directory.
`posix.ts` and `win32.ts` are reached through them. Keeping the per-platform
files behind the seams is what lets a caller stay unaware of which one it got,
and it is cheap to check by grepping for the import path.

## Open questions

**The check does not read tests.** Most of what is in there is `test.skipIf`,
which is a platform branch whose entire purpose is letting a test decline to run,
and nobody has worked out what the rule for those should be — whether they want
counting, a different rule, or nothing at all.

**Whether the exact counts are worth their churn.** Every change to a
platform-conditional line means editing the list. The lean is that this is worth
it while the surface is small enough to enumerate, because it is what stops the
numbers drifting upward as a cushion. If it becomes irritating, path-level
allowlisting without counts is the obvious thing to try instead.

**Whether the seam should become one module per platform.** The daemon's SIGUSR1
handling, its `/proc` reads and its socket recreation are the largest remaining
cluster, and they sit on the least testable path in the repository. They probably
want to move, and there is a good argument that the move should happen where real
runners can be read rather than on one developer's machine.

**Whether `scripts/` belongs under the same rule as `packages/*/src`.** It is
held to it today, on the reasoning that a rule with a hole in it tends to become
the hole.

Which platforms are expected to work and how much brokenness each one gets is a
separate matter, and epic #24 carries it along with the state of the CI lanes in
[ci.md](ci.md).
