# Platforms

**Linux is the first-class citizen. macOS comes in a close second. Windows
tolerates the most broken things.**

That is where effort goes when something has to give, and it holds until there
is real investment in cross-platform usability and testing. It is not a claim
that Windows does not matter.

This is a first shape and is expected to change. The tiering above is the
owner's current position. Everything below it is a lean: nobody has ruled on
what a failing lane costs on each platform, and nothing in CI treats one
platform differently from another.

[ci.md](ci.md) has the lanes, the step order and where each platform stands
today. This document has what a failure on each platform is probably worth.

## What observes each platform

| Tier   | Platform | Lanes that run it                                   |
| ------ | -------- | --------------------------------------------------- |
| first  | Linux    | `native (ubuntu-latest)`, `musl`, `browser`, `soak` |
| second | macOS    | `native (macos-latest)`                             |
| third  | Windows  | `native (windows-latest)`                           |

Linux is the only platform with evidence beyond one lane, and the extra lanes
watch different things. `musl` runs Alpine 3.22 in a container and asks whether
`bun:ffi` and a compiled binary can find a libc where there is no glibc.
`browser` runs Playwright chromium against `examples/session-web`. `soak` runs
on a self-hosted Linux x64 runner and only when someone asks for it by name.

macOS and Windows have one lane each, which changes how a failure on them should
be read. Steps in a lane run in order and stop at the first failure, so a lane
that fails early leaves every step behind it unobserved. On a single-lane
platform that makes the number of problems unknown rather than one.

## What CI does today

Three facts, all readable in `.github/workflows/session-libraries.yml`:

- The `native` matrix sets `fail-fast: false`, so each platform reports
  independently and one platform failing does not cancel the other two.
- No job is marked as allowed to fail. A lane that fails, fails the run,
  whichever platform it was running.
- The one `continue-on-error: true` in the workflow sits on the `musl` lane's
  `setup-bun` step, where it covers installing a musl build of Bun when the
  glibc one will not run. It is not a tolerated platform failure.

So the tiering says where effort goes, and the workflow implements none of it.
Someone reading the board sees three equal failures and has to know the tiering
to weigh them.

## What the Windows lane is failing on

The Windows lane does not answer a refused request. Every assertion in
`packages/session-daemon/test/daemon.test.ts` that expects a rejection —
`PERMISSION_DENIED`, `LIMIT`, `CONFLICT` — gets
`Request timed out; remote outcome is unknown` instead of the error the daemon
raised, while Linux and macOS answer the same requests in under a millisecond.
The daemon queues an error reply through the same `queue` call as a successful
one, so what is different about the error path on a Windows named pipe is not
yet known and nobody has looked.

It is the first failure the lane reaches, so it bails the whole suite and the
lane grades almost nothing on Windows. Anything blocked behind it is skipped
with `test.skipIf(process.platform === "win32")` and a note saying why, rather
than left to hide the tests after it.

## Reading a lane that fails

Each reading below is a lean, and no mechanism enforces any of them.

**Linux.** A failure on Linux probably stops other work until it is fixed. Linux
is the platform werk is developed and used on, and the only platform with more
than one lane. A failure there points at the code rather than at a difference
between platforms.

**macOS.** A failure on macOS probably deserves a fix in the same round of work
rather than a separate one. Verification is the catch. A macOS fix written on a
Linux machine is a guess until a runner says otherwise. Labelling it as a guess
is probably better than holding the branch for a confirmation that cannot be
produced from here.

**Windows.** A failure on Windows probably should not hold a branch that is
sound everywhere else. This is the least settled of the three readings, because
no job is marked as allowed to fail. Acting on it today means a person chooses
to merge with the Windows lane failing. No mechanism makes that choice.

## What is not settled

1. Should a tier map to a CI mechanism at all? Four candidates nobody has
   weighed against each other:
   - `continue-on-error: true` on a lane, so it reports and does not fail the
     run;
   - an allowlist of named failures a lane is permitted to have, so an expected
     failure passes and a new one does not;
   - GitHub's required-checks configuration, so a lane reports without blocking
     a merge;
   - leaving the workflow uniform, and keeping the tiering as a rule for people
     rather than for CI.
2. What moves a platform between tiers, and who decides it has moved?
3. Do `musl`, `browser` and `soak` count as evidence for the Linux tier, or are
   they their own concern that happens to run on Linux?
4. Does the tiering say anything about new work, or only about failures? Whether
   a feature has to work on Windows on the day it lands is a separate question
   from what to do when the Windows lane fails.
5. What should a fix verified only by reasoning be called, and where should that
   label live, given that macOS and Windows fixes are usually written on Linux?

The epic at https://github.com/omnilogic-labs/werk/issues/24 tracks the work
this document came out of, including sequestering platform-specific code so the
compatibility surface can be found in one place.
