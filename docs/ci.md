# Continuous integration

One workflow, `.github/workflows/session-libraries.yml`, carries every lane. It
runs automatically on a pull request and on a push to `main`, and on demand
against any branch GitHub already holds.

A change is proved on its branch before it is merged, not after. Publish the
branch, start a run against it, fix what the runners report, and merge to the
base branch last. A bare push of a feature branch starts nothing on its own: the
branch reaches CI through its pull request, or because someone asked for a run
by name, which is what "Starting a run on demand" below is for.

## The lanes

| Lane      | Runner                                            | What it is for                                                         |
| --------- | ------------------------------------------------- | ---------------------------------------------------------------------- |
| `native`  | `ubuntu-latest`, `macos-latest`, `windows-latest` | The whole suite on each supported platform                             |
| `musl`    | Alpine 3.22 in a job container                    | `bun:ffi` and a compiled binary finding a libc where there is no glibc |
| `browser` | `ubuntu-latest`                                   | Playwright chromium against `examples/session-web`                     |
| `soak`    | a self-hosted Linux x64 runner                    | A run longer than a hosted job's six-hour cap                          |

The `browser` lane also runs on this machine. It has been run here, and it
passes. Getting there is not one step, because Playwright publishes builds for a
list of distributions and this host is not on it.

`bun run browser:install` is the attempt to make that one step. It runs the
plain install first and only reaches for `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE`
once Playwright has refused, reading the host out of the refusal rather than
naming it, and it waits for the executable to appear rather than for the
installer to exit, because the installer has been seen finishing its work and
then never exiting. Whether it gets a browser here unaided has not been shown
end to end yet; `docs/continue/cleanup.md` has the state and the manual recipe
that did work.

The lane wants that same override set when it runs, not only when it installs,
because Playwright resolves the browser directory from the detected host. It
also wants two browsers, `chromium` and `chromium-headless-shell`.

A borrowed build is linked against the borrowed release's libraries, so a local
pass is weaker evidence than the lane on a runner, which is where the lane's
verdict comes from.

The `native` matrix keeps `fail-fast: false`. One platform failing should not
cancel the evidence the other two were about to produce.

The `soak` lane's self-hosted runner has never been provisioned, so the lane has
never run. It is a design that is written down and costed rather than a lane
that reports anything.

## Step order

Steps run cheapest first, so a run dies on the first failure having spent the
least. Sequential steps stop a job as soon as one of them fails.

`native`, after `bun install --frozen-lockfile`, with the durations measured on
one Linux x64 machine:

| Step                     | About |
| ------------------------ | ----- |
| `bun run format:check`   | 3 s   |
| `bun run build`          | 4 s   |
| `bun run typecheck`      | 8 s   |
| `bun test scripts`       | < 1 s |
| `bun run test`           | 8 s   |
| `bun run test:artefacts` | 6 s   |
| `bun run test:soak`      | 60 s  |

`typecheck`, `test` and `test:artefacts` are close enough together that a
runner's own variation probably reorders them; they are written static, then
unit, then integration, because a type error reported after an integration test
has already run is the worse thing to read.

`format:check` runs on Linux only. There is no `.gitattributes`, so a Windows
checkout is most likely CRLF and would fail on line endings rather than on
anything anyone wrote.

`musl` runs `build` before `typecheck`, because `packages/terminal-beamterm`
imports `@werk/terminal` from `dist/` and a typecheck from a clean tree cannot
resolve it. The compiled lock check comes next: it is the point of the lane and
it costs about a second.

The `bun run test:soak` step on `native` asserts no performance budget. It sets
`SOAK_SECONDS` and `SOAK_REPORT` and no `SOAK_BASELINE`, and
`scripts/session-soak.ts` keeps the regression budgets behind that variable. So
what the step proves in 60 seconds is that the daemon starts, streams, keeps
the output queued across every connection inside 32 KiB per connection,
exercises slow-viewer resynchronisation, and cleans up afterwards. The peak RSS, attach latency and
event-loop budgets are checked only where a baseline is passed, which today is
the `soak` lane alone. The step uploads `soak.json` either way, so the numbers
are recorded even though nothing compares them.

Two of the checks that do run on every pull request are weaker than they look.
The control-queue bound compares against `DEFAULT_MAX_QUEUED_BYTES`, about
64 MiB, while the checked-in baseline's observed peak is 1,688 bytes, so it
sits roughly 40,000 times above the real value and would catch a runaway rather
than a regression. The descriptor check can fail, and does the job it was
written for, but only on Linux: it reads `/proc/self/fd`, so the macOS and
Windows legs assert nothing about descriptors at all.

## Re-runs on failure

Two layers, covering different failures.

**Tests.** Every `bun test` step passes `--retry=2`, so a test gets three
attempts before it counts as failed, and `--bail`, so the first test that fails
all of its attempts ends the step. A test that fails and then passes leaves the
failed attempt's error in the log and a passing summary, so a flake is still
visible; a test that never passes prints `(attempt 3)` and `Bailed out after 1
failure`. `--retry` re-runs the test, not the file, so state a test carried
across attempts is its own to reset.

Two attempts of retry is a guess at a useful number rather than something
measured. It costs about ten seconds on a five-second timeout and it may want
raising or lowering once there is a record of how often a flake needs a second
chance.

**Everything else.** `--retry` reaches tests and nothing else: not `build`, not
`typecheck`, not `test:artefacts`, not a runner that dies. None of those has
been seen flaking, so nothing re-runs them automatically — a first failure there
is probably real and worth reading. Re-run the failed jobs of a finished run by
hand:

```sh
gh run rerun --failed <run-id>
```

If a non-test step is ever seen flaking, a retry loop around that step is
probably the next layer rather than a third-party retry action.

### What a retried failure looks like

Bun prints one `(fail)` line per test and it belongs to the last attempt, so the
attempts before it appear as errors with no summary line of their own. Two
things follow. A gap the length of a test's timeout, ending in `killed N
dangling processes`, is an attempt that was abandoned rather than one that
passed. And a duration far shorter than the test takes to reach its first
assertion, a few hundred milliseconds against several seconds, marks an error
that came from an earlier attempt: read it as a consequence of the failure above
it, not as a failure of its own.

That second case is possible because Bun's test timeout does not run the test's
`finally`. An attempt that ends there cleans up nothing and leaves its
subprocesses for Bun to kill, which is what the `killed N dangling processes`
line reports. Whatever the attempt was awaiting is still pending, and it rejects
once those subprocesses die, by which time `--retry` has moved on, so the
rejection is charged to the attempt that happens to be running.

**So a test's own waits need a ceiling below its timeout.** Then a stall stays a
failure of that wait, at that line, in the attempt that caused it. The browser
test is the case that needs this: Playwright's default ceiling is 30 seconds and
matches the test timeout exactly, so
`examples/session-web/test/browser.test.ts` calls `page.setDefaultTimeout` to
bring every page wait down to 10 seconds.

## Starting a run on demand

GitHub can only run a ref it already holds, so the branch has to be on `origin`
first. It does not have to be merged, and it does not need a pull request.

```sh
bun scripts/ci-run.ts linux
```

The helper resolves the current branch, refuses with exit 2 if `origin` does not
have it at the commit in hand and prints the `git push` that would fix that, then
dispatches and watches the run. It never pushes.

```sh
bun scripts/ci-run.ts --help            # the lanes and the flags
bun scripts/ci-run.ts macos --no-watch  # dispatch and print the URL
bun scripts/ci-run.ts soak --soak-seconds 3600
bun scripts/ci-run.ts all --dry-run     # print the commands, touch nothing
```

The same thing without the helper:

```sh
gh workflow run session-libraries.yml --ref <branch> -f lanes=<lane>
```

`lanes` takes `all`, `linux`, `macos`, `windows`, `musl`, `browser` or `soak`,
and defaults to `all`. `linux`, `macos` and `windows` each narrow the `native`
matrix to that one runner. `soak` runs the self-hosted long lane and nothing
else, so an ad-hoc dispatch of the others never starts a day-long run;
`soak_seconds` sets its duration and defaults to 86400.

A pull request and a push to `main` run `native`, `musl` and `browser`, and skip
`soak`.

The helper finds the run it created by asking `gh run list` for the newest
`workflow_dispatch` run on that branch. Two dispatches on the same branch within
the same second could attach it to the wrong one.

## Where the platforms stand

At `3e7b06e` on branch `issue-30`, in run
[34192546207](https://github.com/omnilogic-labs/werk/actions/runs/34192546207):

| Lane                      | Outcome | Where it stopped                                  |
| ------------------------- | ------- | ------------------------------------------------- |
| `browser`                 | pass    |                                                   |
| `musl`                    | pass    |                                                   |
| `native (ubuntu-latest)`  | pass    |                                                   |
| `native (macos-latest)`   | fail    | `bun run test`, `daemon.test.ts:581`              |
| `native (windows-latest)` | fail    | `bun run test`, `daemon.test.ts:118`              |
| `soak`                    | not run | its self-hosted runner has never been provisioned |

Both failing lanes stop in `packages/session-daemon/test/daemon.test.ts`, for
two different reasons. Neither has an issue of its own yet.

Windows cannot make a directory private. `privateWindowsDirectory`
(`src/platform/win32.ts:146`) throws `Cannot restrict Windows directory` with
nothing after the colon, meaning the command it ran failed and said nothing. It
is reached through `makePrivate` and `ensurePrivateDirectory` from
`serveSessionDaemon`, called from the test's setup at the line the trace names,
`daemon.test.ts:118`. The test that asks for it, "PTY survives clients, grants,
size ownership, watch and retained recovery", fails on its third attempt under
`--retry=2` after timing out at five seconds. The log records that one throw and
that one timeout, so whether the throw is what leaves the test hanging is a
guess, and what the first two attempts did is not recorded either. The run bails
after that failure, reporting 34 tests across four files with the failing one
among them, and the step exits with code 1. `bun run format:check` is skipped on
Windows; `build`, `typecheck` and `bun test scripts` all pass.

Windows stopped somewhere else in the run before this one, at `8bd72f6`: four
requests that should have been refused timed out instead, at lines 165, 214, 344
and 401 of the same file, and the step exited with code 3. Two runs on the same
branch have therefore produced two different Windows failures, and the number of
Windows problems is unknown rather than one.

macOS stops on an unhandled error between tests rather than on a failing
assertion, and every test in `daemon.test.ts` passed on that lane. It stops
once, at line 581, where a burst of fifty writes has to reach the screen and
three watching tiles before the `until` helper's deadline and does not. It looks intermittent rather than settled. The run before it,
[34191444466](https://github.com/omnilogic-labs/werk/actions/runs/34191444466)
at `8bd72f6`, passed the whole macOS lane, and no file under `src/` changed
between the two commits. A loaded runner is a guess; nobody has measured it.

`packages/session-daemon/test/supervise.test.ts` passes on macOS in both runs.
Twelve of its tests run and two skip, and none fails, including the client that
waits for a live daemon rather than spawning a second one.

`native (macos-latest)` runs on arm64, the architecture `macos-latest` names;
the label tracks GitHub's current GA image, which is macOS 26 today, so the lane
does not need bumping by hand. No x64 macOS lane runs alongside it. That is the
owner's direction rather than an omission: x64 macOS is not exercised here.

The measurement above is taken on a branch rather than on `main`, which carries
the risk that a lane passes there for a reason the branch supplies. The branch
carries one behaviour change over its base, in how a process start time is read;
everything else on it is tests and documentation.

How much any of this should hold up other work is in
[platforms.md](platforms.md).

## Open questions

Genuinely open. Where there is a lean it is labelled as a lean.

### 1. What should the routine soak step assert?

The 60-second `bun run test:soak` step runs on every pull request and every push
to `main`, on all three platforms, and asserts nothing about performance. The
options:

- Set `SOAK_BASELINE` on the Linux leg of `native` against the checked-in
  `docs/session-library/linux-x64-baseline.json`. That baseline was collected on
  a development machine rather than on a hosted runner, so the comparison would
  be across two different machines and would probably need looser multipliers
  than the current 2x and 3x.
- Assert absolute ceilings chosen by hand rather than budgets relative to a
  baseline. That survives a change of runner, and it needs somebody to pick the
  numbers.
- Keep the step as a liveness, framing, backpressure and cleanup exercise, and
  say so where it is described rather than letting it read as a gate.
- Drop it from the pull request path and run it on a schedule instead, which
  buys back 60 seconds per platform per run.

**Lean:** the third now and the first afterwards. Describe the step accurately
today, then collect a 60-second baseline on a hosted `ubuntu-latest` runner so
that a like-for-like comparison becomes possible. The cost of the third on its
own is that nothing catches a performance regression until somebody dispatches
the `soak` lane by hand.

Whether the two always-on checks should be tightened is part of the same
question. The control-queue bound could compare against something near the
observed peak rather than against the protocol limit, and the descriptor check
could be given a way to count handles on macOS and Windows.

### 2. Should the unprovisioned `soak` lane stay listed?

The lane and its `workflow_dispatch` option describe a day-long run on a
self-hosted Linux x64 runner that does not exist. The options are to keep it and
say plainly that its runner has never been provisioned, or to remove the lane
until somebody provisions one.

**Lean:** keep it. The design is written down and costed, and what was missing
was the caveat rather than the lane. The cost is a lane in the table and a
`workflow_dispatch` option that nobody can currently use.
