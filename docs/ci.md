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
| `native`  | `ubuntu-latest`, `macos-latest`, `windows-latest` | The whole suite on Linux and macOS, and the client's tests on Windows  |
| `musl`    | Alpine 3.22 in a job container                    | `bun:ffi` and a compiled binary finding a libc where there is no glibc |
| `browser` | `ubuntu-latest`                                   | Playwright chromium against `examples/session-web`                     |
| `soak`    | a self-hosted Linux x64 runner                    | A run longer than a hosted job's six-hour cap                          |

The `browser` lane also runs on the development machine, and it has passed
there. Playwright 1.65.1 supports Ubuntu 26.04, which is what this machine runs
under WSL2, so `bun run browser:install` works with no override. That was
checked locally and in CI. The script fetches two browsers, `chromium` and
`chromium-headless-shell`, and waits for their executables to appear rather than
for the installer to exit, because an installer has been seen finishing its work
and then never exiting. Its fallback for a host Playwright refuses, which reads
the host out of the refusal and borrows an older release of the same
distribution, is tracked by werk#46 and is not needed here. `KNOWN_RELEASES` in
`scripts/browser-install.ts` holds the list that fallback uses.

On a runner the lane runs `bunx playwright install --with-deps chromium` in
`examples/session-web` and sets no environment override, because
`ubuntu-latest` is a release Playwright publishes for.

The `native` matrix keeps `fail-fast: false`. One platform failing should not
cancel the evidence the other two were about to produce.

The `soak` lane's self-hosted runner has never been provisioned, so the lane has
never run. It is a design that is written down and costed rather than a lane
that reports anything.

### What the Windows lane runs

On Windows werk is a client. The owner's ruling is that Windows does not need a
local daemon, a supervisor, a PTY or a session host, only the client: the CLI's
parsing, help, config and its layers and paths, themes and output, the
workspace and ssh code that builds commands for another machine, and the
session protocol and client. So `native (windows-latest)` runs the tests of
that and nothing that starts, ensures or talks to a local daemon.

| Step on Linux and macOS  | Step on Windows                   | What Windows leaves out                                                                                               |
| ------------------------ | --------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `bun run test`           | `bun run test:client`             | `packages/session-daemon/test`, and `create-attach`, `daemon-endpoint`, `edit` and `loopback` in `packages/werk/test` |
| `bun run test:artefacts` | `bun run test:artefacts --client` | Everything after the compiled binary answers `help`, all of which runs a daemon                                       |
| `bun run test:soak`      | none                              | The whole soak, which is a daemon under load                                                                          |

Three of the CLI files are left out whole because every test in them creates
a local session or asks for the daemon's endpoint. The fourth, `loopback`,
makes this machine the far end of an ssh connection and has werk set up
workspaces and a daemon on it as it would on a remote host. werk's far machine
is a POSIX one, and Windows as a host is refused before anything is sent, so on
Windows that file tests a host werk will not use. The client's half of the same
work, the commands it sends to the far machine, is covered by
`packages/workspace/test/ssh.test.ts`, which runs everywhere.

Files that mix the two keep their client tests on Windows and mark the rest with
`daemonTest` from `packages/werk/test/support/platform.ts`, which skips a test
on Windows only:

- `json-output.test.ts`: `list`, `create`, `land`, `info` and `doctor`,
  `daemon endpoint`, `logs`, and `kill` and `remove`, which all reach the
  daemon.
- `land.test.ts`: every case that makes its workspace with `werk create`. The
  two refusals that need no session still run.
- `workspace.test.ts`: every case that creates a session.

A test that acts on the `local` host is marked `localHostTest` from the same
file, which also skips on Windows only. The CLI refuses `local` there, so these
cannot pass, and the refusal itself is what Windows tests instead, in
`client-only.test.ts`:

- `json-output.test.ts`: `setup`, which reports the local machine's setup.
  `completion` and every `config` subcommand still run.
- `workspace.test.ts`: the three refusals that start no daemon (outside a
  repository, a taken branch or bad name, and a repository with no commits),
  because each is reached by acting on `local`. Nothing in that file runs on
  Windows.
- `commands.test.ts`: where a local workspace goes.
- `host-place.test.ts`: the two cases that place a workspace on a local host.
- `tty.test.ts`: the list table, which lists the local host.

`client-only.test.ts` runs only on Windows. It checks the refusal through the
real binary, that `werk config` lists no local host and no default host, and
that `werk config get runtimeDir` answers with nothing in the environment to
build a default from.

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
`scripts/session-soak.ts` keeps the regression budgets behind that variable.

What the step proves in 60 seconds:

- the daemon starts;
- it streams;
- it keeps the output queued across every connection inside 32 KiB per
  connection;
- slow-viewer resynchronisation runs;
- it cleans up afterwards.

What it does not prove is anything about speed or memory. The peak RSS, attach
latency and event-loop budgets are checked only where a baseline is passed,
which today is the `soak` lane alone. The step uploads `soak.json` either way,
so the numbers are recorded even though nothing compares them.

Two of the checks that do run on every pull request are weaker than they look.
The control-queue bound compares against `DEFAULT_MAX_QUEUED_BYTES`, about
64 MiB, while the checked-in baseline's observed peak is 1,688 bytes, so it
sits roughly 40,000 times above the real value and would catch a runaway rather
than a regression. The descriptor check can fail, and does the job it was
written for, but only on Linux: it reads `/proc/self/fd`, so the macOS leg
asserts nothing about descriptors at all.

## Re-runs on failure

Two layers, covering different failures.

**Tests.** Three steps pass `--retry=2`, so a test gets three attempts before it
counts as failed: `bun run test` on `native` (`bun run test:client` on Windows), the two named daemon test files on
`musl`, and `bun run test:browser` on `browser`. `bun test scripts` on `native`
passes `--bail` alone, with no retry. Two further steps read as tests and are
not: `test:artefacts` runs `scripts/check-artefacts.ts` and `test:soak` runs
`scripts/session-soak.ts`, so neither has a `--retry` to pass.

`--bail` ends a step at the first test that fails all of its attempts. A test
that fails and then passes leaves the failed attempt's error in the log and a
passing summary, so a flake is still visible; a test that never passes prints
`(attempt 3)` and `Bailed out after 1 failure`. `--retry` re-runs the test, not
the file, so state a test carried across attempts is its own to reset.

Two attempts of retry is a guess at a useful number rather than something
measured. It costs about ten seconds on a five-second timeout and it may want
raising or lowering once there is a record of how often a flake needs a second
chance.

**Everything else.** `--retry` reaches tests and nothing else: not `build`, not
`typecheck`, not `test:artefacts`, not `test:soak`, not a runner that dies. None
of those has been seen flaking, so nothing re-runs them automatically. A first
failure there is probably real and worth reading. Re-run the failed jobs of a
finished run by hand:

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

Per-platform outcomes are not recorded in this document, because they go stale
within a few commits and a stale record reads as current. To find out where a
platform stands, run `bun scripts/ci-run.ts all` on the branch in hand, or read
the most recent run at
<https://github.com/omnilogic-labs/werk/actions/workflows/session-libraries.yml>.

`native (macos-latest)` runs on arm64, the architecture `macos-latest` names,
and the label tracks GitHub's current GA image, so the lane does not need
bumping by hand. No x64 macOS lane runs alongside it. That is the owner's
direction rather than an omission: x64 macOS is not exercised here.

How much a failure should hold up other work is in [platforms.md](platforms.md).

## Open questions

Genuinely open. Where there is a lean it is labelled as a lean.

### 1. What should the routine soak step assert?

The 60-second `bun run test:soak` step runs on every pull request and every push
to `main`, on Linux and macOS, and asserts nothing about performance. The
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
could be given a way to count handles on macOS.

### 2. Should the unprovisioned `soak` lane stay listed?

The lane and its `workflow_dispatch` option describe a day-long run on a
self-hosted Linux x64 runner that does not exist. The options are to keep it and
say plainly that its runner has never been provisioned, or to remove the lane
until somebody provisions one.

**Lean:** keep it. The design is written down and costed, and what was missing
was the caveat rather than the lane. The cost is a lane in the table and a
`workflow_dispatch` option that nobody can currently use.
