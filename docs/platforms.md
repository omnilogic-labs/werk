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

[ci.md](ci.md) has the lanes, the step order, and how to find out where each
platform stands right now. This document has what a failure on each platform is
probably worth.

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

Windows has already shown that. Two runs of branch `issue-30`, at `8bd72f6` and
at `3e7b06e`, produced two different Windows failures in
`packages/session-daemon/test/daemon.test.ts` rather than the same one twice:
four requests that should have been refused timed out in the first, and a
directory that could not be made private in the second. The count of Windows
problems is unknown, not one.

## The workflow implements none of the tiering

The tiering says where effort goes, and the workflow implements none of it.
Someone reading the board sees three equal failures and has to
know the tiering to weigh them.

Three facts, all readable in `.github/workflows/session-libraries.yml`:

- The `native` matrix sets `fail-fast: false`, so each platform reports
  independently and one platform failing does not cancel the other two.
- No job is marked as allowed to fail. A lane that fails, fails the run,
  whichever platform it was running.
- The one `continue-on-error: true` in the workflow sits on the `musl` lane's
  `setup-bun` step, where it covers installing a musl build of Bun when the
  glibc one will not run. It is not a tolerated platform failure.

## Reading a lane that fails

Each reading below is a lean. No mechanism enforces any of them.

| Platform | What a failure probably costs                               | What enforces it |
| -------- | ----------------------------------------------------------- | ---------------- |
| Linux    | Stops other work until it is fixed                          | Nothing          |
| macOS    | A fix in the same round of work, rather than a separate one | Nothing          |
| Windows  | Should not hold a branch that is sound everywhere else      | Nothing          |

Linux reads that way because it is the platform werk is developed and used on,
and the only one with more than one lane, so a failure there points at the code
rather than at a difference between platforms. Windows is the least settled of
the three, because no job is marked as allowed to fail: acting on that reading
today means a person chooses to merge with the Windows lane failing.

A macOS fix written on a Linux machine is a guess until a runner says otherwise,
and `bun scripts/ci-run.ts macos` is what turns it into an observation.

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
places the code branches on platform can be found in one place.
