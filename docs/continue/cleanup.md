# Making the browser lane run locally

Handoff from the night-shift run of 2026-09-08. The run itself is finished and
landed at `c699c1d`. `main` has moved on since, so every verdict below describes
that commit rather than the current tip. This is the one piece left open, plus
the tickets the run filed.

## The state on disk

```
scripts/browser-install.ts        the install script
scripts/browser-install.test.ts   18 tests, all pass
package.json                      adds the browser:install script
.claude/night-shift.md            replaces a false claim about the lane
docs/ci.md                        how to run the lane locally, and what it is worth
```

These are committed. The documentation in them claims only what has been shown:
that the lane runs here and passes, and that `bun run browser:install` is an
attempt at making the setup one step whose end-to-end behaviour is not yet
demonstrated. That wording is deliberate. The sentence it replaced was a
confident false claim, and putting another one in its place is the failure being
fixed.

## What was proved

`bun run test:browser` passes on this machine. Three tests, no failures, with
the browsers in place and `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64`
set. So the lane is not unavailable here, which is what the repository had
recorded as settled.

Getting there needed three separate things, and only the first was known:

**One, Playwright refuses the host.** It checks the host against a list of
distributions it publishes builds for and refuses before downloading anything:

```
Error: ERROR: Playwright does not support chromium on ubuntu26.04-x64
```

This host is Ubuntu 26.04 and `playwright@1.58.2` predates it. The refusal names
the host, not the browser, so a newer browser never helps.
`PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64` gets past it. The suffix
matters: `ubuntu24.04` on its own is refused in turn.

**Two, the install does its work and then does not exit.** `ffmpeg` unpacked
completely, a 5 MB binary intact on disk, and the process then sat at 0% CPU
until it was killed four minutes later. A chromium install held on past six
hours with `write_bytes` frozen at 18 MB. So the exit code does not answer
whether a browser arrived. The executable on disk does.

**Three, the override is needed at run time as well as at install time.**
Without it the lane fails with `Executable doesn't exist at
.../chromium_headless_shell-1208/...`, because Playwright resolves the browser
directory from the detected host.

The lane needs two browsers, not one: `chromium` and `chromium-headless-shell`.
Installing only the first gets you a launch failure naming the second. Note also
that `playwright install <one browser>` removed the other one that was already
present, so the two want installing together.

## What the script does

`scripts/browser-install.ts`, with its decision logic separated from the process
work so it can be tested without downloading anything.

- Runs the plain install first. Only once Playwright has actually refused does
  it reach for an override, so a supported host never touches any of this.
- Reads the host out of the refusal rather than hardcoding what this machine is,
  then tries older releases of that same distribution, nearest first. The file
  becomes dead weight the day Playwright learns Ubuntu 26.04.
- Waits on the executables appearing as well as on the process, whichever comes
  first, under a deadline. This is the part that answers problem two.

## What is left

1. **Finish the end-to-end proof.** Delete
   `~/.cache/ms-playwright/chromium_headless_shell-1208`, run
   `bun run browser:install`, and confirm both executables arrive. That run was
   in flight when work stopped and its result is not known.
2. **Then run `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64 bun run
test:browser`** from that state and confirm three tests pass.
3. **Decide whether the run-time override should be automatic.** The script
   prints it, and the person then has to remember it. Wiring it into the
   `test:browser` script would remove that, at the cost of putting a claim about
   this host into a committed file. Nobody has taken that decision.
4. **Then commit**, and close werk#46 with what the three problems actually were.

If step 1 fails, there is a recipe that did work, twice, and is worth falling
back to rather than rediscovering. Start the install, watch
`/tmp/playwright-download-*/` until the zip stops growing, copy it somewhere on
disk, kill the install, and unpack it yourself with `unzip` into
`~/.cache/ms-playwright/<browser>-<revision>/`, then `chmod -R +x` the
directory. A copy of the chromium zip is at `~/.cache/pw-zip/chromium.zip`,
which saves a 168 MB download.

## Two things about this machine, not about werk

- `/tmp` is a tmpfs of 7.9 GB. A session from 7 September left 4.4 GB of scratch
  under `/tmp/claude-1000/`, which is 56% of it. Deleting that stale directory
  would take the tmpfs from about 70% to about 15%. It is not this run's to
  delete.
- A borrowed browser build is linked against the borrowed release's libraries.
  A local pass is therefore weaker evidence than the lane on a runner, and the
  lane's verdict should keep coming from CI.

## Tickets the run filed, none of them started

| Issue                                                            | What it is                                                                                        |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [#43](https://github.com/omnilogic-labs/werk/issues/43)          | The pty test guarding #42 runs on one CI lane and skips silently on the other three               |
| [#44](https://github.com/omnilogic-labs/werk/issues/44)          | Agent memory is a harness feature rooted at the repository; the rules around it assume not        |
| [#45](https://github.com/omnilogic-labs/werk/issues/45)          | The soak lane needs a self-hosted runner and none is registered, so it has never run              |
| [#46](https://github.com/omnilogic-labs/werk/issues/46)          | The browser lane can run locally: Playwright's refusal is a host allowlist, not a missing browser |
| [#47](https://github.com/omnilogic-labs/werk/issues/47)          | `posixSummary` runs `Bun.spawnSync` on the daemon's loop, once a second per session               |
| [agent-skills#5](https://github.com/is4co/agent-skills/issues/5) | The other half of #44, in the repository that sets `memory: project`                              |

#44 and agent-skills#5 want deciding together and neither has a lean worth
acting on yet.

## Where the run got to

Eight units landed: #28, #41, #42, #40, #34, #30, #31, #20. Four tickets closed,
four left open under `Refs` because something about them is still ungraded.

CI on `main` at `c699c1d`: `browser`, `native (ubuntu-latest)`, `musl` and
`native (macos-latest)` pass, `native (windows-latest)` fails. macOS went green
during the run, which is #30's fix. Windows is #31, whose real cause is now
localised on its ticket and is not the symptom the ticket describes: a response
frame the daemon has written, with `flush.sent` reporting `ms: 0`, is not
delivered to the client for five seconds on a connection that carries later
frames fine. Any instrumentation that wakes the event loop hides it.
