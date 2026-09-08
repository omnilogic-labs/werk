# Continuous integration

One workflow, `.github/workflows/session-libraries.yml`, carries every lane. It
runs automatically on a pull request and on a push to `main`, and on demand
against any branch GitHub already holds.

A bare push of a feature branch starts nothing. The branch reaches CI through
its pull request, or because someone asked for a run by name.

## The lanes

| Lane      | Runner                                              | What it is for                                                         |
| --------- | --------------------------------------------------- | ---------------------------------------------------------------------- |
| `native`  | `ubuntu-latest`, `macos-15-intel`, `windows-latest` | The whole suite on each supported platform                             |
| `musl`    | Alpine 3.22 in a job container                      | `bun:ffi` and a compiled binary finding a libc where there is no glibc |
| `browser` | `ubuntu-latest`                                     | Playwright chromium against `examples/session-web`                     |
| `soak`    | a self-hosted Linux x64 runner                      | A run longer than a hosted job's six-hour cap                          |

The `native` matrix keeps `fail-fast: false`. One platform failing should not
cancel the evidence the other two were about to produce.

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

`native (ubuntu-latest)` passes.

`native (windows-latest)` fails at `bun run build` with
`error: BadPathName: failed to open root directory: /D:/a/werk/werk/packages/werk/src`.
This is `packages/werk/build.ts` handing `new URL(...).pathname` to `Bun.build`,
which is a `/D:/…` string on Windows, rather than anything about the workflow.
`fileURLToPath` is the likely fix.

`native (macos-15-intel)` has been seen failing two `session-daemon` tests, both
at a five-second timeout: a client waiting for a live daemon with a missing
endpoint, and retained-record eviction at the cap. Whether those are flakes that
`--retry=2` absorbs or genuine macOS failures is not established; the first runs
carrying retry traces are what would settle it.

`musl` typechecks after `build`, for the reason under step order. Whether the
steps below that then pass is unconfirmed on a runner.
