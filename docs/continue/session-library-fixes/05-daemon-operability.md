# 05 — Daemon operability: runtime dir, musl lock, logging, environment, input pipelining

Research for the session daemon in `packages/session-daemon` and the CLI in
`packages/werk`. Line numbers are against `main` at `f87d9c0`. Experiments were
run on Ubuntu 26.04 (glibc 2.43, WSL2, systemd-logind present, `Linger=no`),
Bun 1.3.14, with the built CLI `packages/werk/dist/werk`, and in Docker with
`oven/bun:1.3.14-alpine` (Alpine 3.22, musl). The machine rebooted mid-research
and wiped `/tmp`; every result below was captured before that, and the two
probes that did not complete are marked as unverified.

This builds on [04 §3 to §5, §11](../../research/04-daemon-best-practices.md)
and [07 §2 and §4](../../research/07-packaging.md).
Where a recommendation departs from 04 (the runtime directory hierarchy in §5)
it says so and why.

## Summary

| Problem              | What is actually true                                                                                                                                                                                                                                                                                                                                                                                                                                           | Recommendation (short)                                                                                                                                                                                                                                                                                                                                                      | Effort |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| A. Runtime directory | Reproduced. Removing the runtime dir under a live daemon leaves it running and checkpointing; the next `werk` command spawns a second daemon on a fresh lock file, lists the live session as `lost`, and the two daemons rewrite the same checkpoint file in turn (`lost`, `running`, `lost`, ...). logind removes `/run/user/UID` at last logout unless lingering; macOS removes `$TMPDIR` files unaccessed for 3 days; Fedora and Arch age `/tmp` at 10 days. | Default to `/tmp/werk-UID` (tmux's choice) on POSIX and `%LOCALAPPDATA%\werk\run` on Windows, honour `WERK_RUNTIME_DIR` and `--runtime-dir`, verify ownership on both sides, move the lock to the state dir, record the daemon pid in the state dir, have the daemon defend and recreate its endpoint, and have `ensureSessionDaemon` refuse to spawn beside a live daemon. | ~15 h  |
| B. musl lock         | The premise does not hold for Bun's musl build: musl's loader treats any `libc.*` name as itself, so `dlopen("libc.so.6")` succeeds on Alpine and `flock` is exclusive there. Verified under `bun probe.ts`; the compiled-binary variant was not verified (lost to the reboot).                                                                                                                                                                                 | Keep `flock` (crash-safe on glibc, musl, macOS; Windows keeps its exclusive handle). Restore the PoC's candidate list as cheap insurance, add a non-FFI fallback on Linux (an abstract socket, verified exclusive under Bun), log which mechanism holds, and run the lock test on the Alpine CI lane.                                                                       | ~4 h   |
| C. Logging           | Nothing is written anywhere. A daemon that fails to start (a 130-byte socket path did this during the experiment) produces only "Daemon did not become ready before startup deadline" in the client.                                                                                                                                                                                                                                                            | Dependency-free line logger to `$stateDir/daemon.log` with size rotation, `--log-level`/`WERK_LOG_LEVEL`, a fixed event vocabulary, log-and-continue for `unhandledRejection`, log-checkpoint-continue for `uncaughtException` with an escalation counter, `werk info` printing paths and `werk doctor` tailing the log.                                                    | ~14 h  |
| D. Environment       | Reproduced. Sessions get the environment of whichever CLI first spawned the daemon (`SSH_AUTH_SOCK`, `COLORTERM`, a probe variable all came from the first shell). The daemon also inherits that client's cwd. `create` never sends `env`; the daemon accepts `env` with no size limit.                                                                                                                                                                         | CLI sends the whole environment minus a denylist (terminal-identity and multiplexer variables); the daemon applies it over a minimal base, not over its own `process.env`, and sets `TERM`, `COLORTERM`, `TERM_PROGRAM`, `WERK_SESSION`; spawn the daemon with a clean environment and `cwd: /`; cap env at 1 MiB total and 128 KiB per value.                              | ~8 h   |
| E. CLI input path    | One `input` request in flight, stdin paused until the ack (`main.ts:143-166`), so typing is bound to one keystroke per round trip. The daemon already processes requests serially per connection and the client allows 128 pending, so pipelining needs no protocol change.                                                                                                                                                                                     | Bounded pipelining in the CLI: keep stdin flowing until 32 requests (or 64 KiB) are unacknowledged; ordering is already guaranteed by the wire. A fire-and-forget input frame is possible later but changes the documented "acknowledges acceptance" contract.                                                                                                              | ~3 h   |

Total roughly 44 hours. A, C and D touch the same three files and the same
tests, so they are cheaper done as one change than three.

---

## A. Runtime directory location and the orphaned daemon

### Current state

- `packages/werk/src/main.ts:244-250`: the runtime dir defaults to
  `path.join(process.env.XDG_RUNTIME_DIR ?? os.tmpdir(), "werk-" + (uid ?? username))`.
  The state dir (`251-258`) is `$XDG_STATE_HOME/werk` or `~/.local/state/werk`.
- `packages/session-daemon/src/local.ts:9-20` (`resolveSessionDaemonPaths`):
  `daemon.sock`, `endpoint.json` and `daemon.lock` all live in the runtime dir.
- `local.ts:124-179` (`ensureSessionDaemon`): `probe()` reads `endpoint.json`,
  connects and calls `daemonInfo`. Any failure, including `ENOENT` on the
  endpoint file, falls through to `Bun.spawn` of the daemon command
  (`158-168`, detached, all stdio ignored, no `env` or `cwd` option). It then
  polls `probe()` every 30 ms until a 10 s deadline and reports only "Daemon
  did not become ready before startup deadline" (`178`). It never reads
  `daemon.pid`, never checks who owns the runtime dir, and never checks the
  socket path length before spawning.
- `packages/session-daemon/src/index.ts:932-1004` (`serveSessionDaemon`):
  `mkdir` 0700, refuse a dir owned by another uid (`935-937`), `chmod` 0700,
  take the lock (`940`), then check the 103-byte socket limit (`944-945`),
  unlink any old socket (`960-961`), listen, `chmod` the socket 0600, write
  `endpoint.json` 0600 (`979-981`). Nothing watches those files afterwards.
- `main.ts:259-282`: the `session-daemon` subcommand writes `daemon.pid` into
  the runtime dir after serving and removes it on `SIGINT`/`SIGTERM`.
- `index.ts:128-137`: the daemon identity file is in the state dir and is
  shared by any daemon started on that state dir. Checkpoints (`378-432`) are
  written to `$stateDir/<id>.json` every 5 s (`120`, `875-878`); on start-up a
  checkpoint whose state is `running` or `starting` is relabelled `lost`
  (`457-459`).

### Verified facts

**Reproduction (Linux, built CLI, a short `/tmp` runtime dir).** After
`werk create -- /bin/sh`, `rm -rf` of the runtime dir, and a 6 s wait, daemon 1
(pid 21725) was still running with its `sh` child (pid 21747) and had written a
checkpoint with `"state":"running"`. The next `werk list` spawned daemon 2 (pid
21788), which listed the same session id under the same `daemonId` with
`"state":"lost"`. Sampling the checkpoint file every 2.5 s then gave
`lost running lost running`: both daemons rewrite it. Daemon 1 held
`daemon.lock (deleted)` in `/proc/<pid>/fd`; daemon 2 had a fresh `daemon.lock`,
`daemon.sock`, `endpoint.json` and `daemon.pid`. So today the lock guarantees
"at most one daemon per lock-file inode", which is the same as "per runtime
dir while the directory exists" and nothing once it is gone.

**Bun socket behaviour (local probe).** After the socket file is unlinked
under a live listener, `connect` fails `ENOENT`; the same process can then
listen again on the same path (a second `net.Server`) and connections succeed;
listening on a path with a live listener fails `EADDRINUSE`; `server.close()`
unlinks the path. So a daemon can recreate its own endpoint without restarting.

**systemd-logind.** pam_systemd(8): "If the last concurrent session of a user
ends, the user runtime directory /run/user/$UID and all its contents are
removed, too." user@.service(5): `user-runtime-dir@UID.service` "creates the
user's runtime directory /run/user/UID when started, and removes it when it is
stopped." logind.conf(5): `KillUserProcesses=` "Configures whether the processes
of a user should be killed when the user logs out", default `yes` upstream since
v230; Arch builds with `--without-kill-user-processes`, Fedora carried a `no`
override and proposed dropping it, and this Ubuntu 26.04 box ships
`#KillUserProcesses=no`, `#UserStopDelaySec=10`, `#RemoveIPC=yes` as the
compiled defaults. `RemoveIPC=` "Controls whether System V and POSIX IPC objects
belonging to the user shall be removed when the user fully logs out" (default
`yes`): shared memory, message queues and semaphores, not sockets or files, so it
is not what removes werk's endpoint. `UserStopDelaySec=` (default 10 s) is how
long `user@.service` survives the last logout, so the directory goes about ten
seconds after the last ssh session closes. loginctl(1) `enable-linger`: "a user
manager is spawned for the user at boot and kept around after logouts", which
keeps `/run/user/UID` too. The XDG Base Directory spec says the same and adds
two things: "Files in this directory MAY be subjected to periodic clean-up. To
ensure that your files are not removed, they should have their access time
timestamp modified at least once every 6 hours of monotonic time or the
'sticky' bit should be set on the file", and "If $XDG_RUNTIME_DIR is not set
applications should fall back to a replacement directory with similar
capabilities and print a warning message."

**`/tmp` on Linux.** tmpfiles.d(5): age is judged from mtime, atime and (for
files) ctime, and any recent one prevents cleanup. Fedora and Arch ship
`q /tmp 1777 root root 10d`; tmux issue #4640 ("tmux session files vulnerable
to systemd-tmpfiles removal") is the resulting bug, and quotes tmpfiles.d: "If
the aging algorithm finds a lock is already taken on some directory, it (and
everything below it) is skipped", so a daemon holding a shared `flock` on its
own directory is exempt. systemd-tmpfiles(8) `--remove` likewise skips entries
"unless an exclusive or shared BSD lock is taken on them". Whether Debian and
Ubuntu age `/tmp` at all was not checked; as far as I know they ship it without
an age.

**macOS.** Apple DTS on developer forum thread 71382: `daily_clean_tmps_days`
"defaults to 3, meaning that a file gets deleted if it hasn't been accessed in
three days"; the per-user `$TMPDIR` under `/var/folders` is cleaned on the same
3-day rule by a `dirhelper` job; "the specific details aren't considered API".
`com.apple.periodic-daily` runs `/etc/periodic/daily/110.clean-tmps`. tmux users
see "no server running on /private/tmp/tmux-501/default" after a few idle days
and recover with `kill -USR1`.

**Windows.** Storage Sense is off by default but Windows may switch it on when
disk space runs low, and it targets temporary files including `%TEMP%`. The
cross-platform proposal (01 §3 table) already chose `%LOCALAPPDATA%\werk` for the
PoC. Today's CLI default on Windows is `os.tmpdir()`, that is `%TEMP%`.

**What others do.**

| Tool      | Socket location                                                                                                                                                         | Defence                                                                                                                                                                              |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| tmux      | `tmux-UID` under `$TMUX_TMPDIR` or `/tmp`; the directory "must not be world readable, writable or executable"                                                           | "If the socket is accidentally removed, the SIGUSR1 signal may be sent to the tmux server process to recreate it (note that this will fail if any parent directories are missing)"   |
| screen    | "$HOME/.screen or simply to /tmp/screens or preferably to /usr/local/screens chosen at compile-time"; non-setuid users may set "any mode 700 directory" in `$SCREENDIR` | none documented                                                                                                                                                                      |
| dtach     | an explicit socket path argument, no default directory                                                                                                                  | none                                                                                                                                                                                 |
| zellij    | `$XDG_RUNTIME_DIR/zellij/<version>/`, override `ZELLIJ_SOCKET_DIR`                                                                                                      | none; issues #3909 (asks for a `/tmp/zellij-UID` fallback "like tmux"), #4155 (crash when `$XDG_RUNTIME_DIR` is unwritable), #3708 (attach over ssh)                                 |
| gpg-agent | `/run/user/UID/gnupg` when present, else `~/.gnupg`; `gpgconf --create-socketdir` for non-default homes                                                                 | the opposite of self-healing: "a periodic self-test to detect a stolen socket ... gpg-agent will then terminate itself" (`--disable-check-own-socket`); removal also ends it (T2756) |
| ssh-agent | current OpenBSD manual: "a random path matching $HOME/.ssh/agent/s.*"; `-T` restores the older `$TMPDIR/ssh-XXXXXXXXXX/agent.<ppid>`                                    | none; note OpenSSH moved from `/tmp` to the home directory                                                                                                                           |

### Recommendation

**Path policy.** `--runtime-dir`, then `WERK_RUNTIME_DIR`, then `/tmp/werk-UID`
on Linux and macOS and `%LOCALAPPDATA%\werk\run` on Windows. This departs from
04 §5, which lists `$XDG_RUNTIME_DIR/werk` first with "cleaned on logout" as a
merit; for werk that cleaning is the failure. `$XDG_RUNTIME_DIR` would be safe
only where lingering is on, and detecting linger (the `/var/lib/systemd/linger/<user>`
marker, as far as I know, or `loginctl show-user -p Linger`) costs a check on
every command and still leaves the macOS and Windows cases. A home-directory
path (`~/.local/state/werk/run`, the ssh-agent choice) survives everything but
risks the 103/107-byte `sun_path` limit and unix sockets on NFS homes, which do
not work; it could be a documented alternative rather than the default.
`/tmp/werk-UID` is short, local, predictable across machines (which the
`ssh -L` examples in 09 want) and survives logout. `werk info` prints the
choice; the XDG spec asks for a warning when falling back from
`$XDG_RUNTIME_DIR`, which `werk doctor` can carry rather than every command.

**Ownership on both sides.** The daemon already refuses a runtime dir owned by
another uid. The client does not, and `/tmp` is sticky-bit 1777 so another
local user can pre-create `/tmp/werk-1000/endpoint.json`. That matters more
once D sends the environment. `ensureSessionDaemon` should `lstat` the dir,
require `uid === getuid()` and mode `& 0o077 === 0`, and refuse otherwise with a
message naming the path.

**Defend the files.** Two cheap measures: the daemon takes a shared `flock` on
the runtime directory fd for its lifetime (Linux only; tmpfiles skips locked
directories), and it touches socket, endpoint and lock (`utimes`) every hour
(covers macOS's 3-day access rule and the XDG 6-hour rule if `$XDG_RUNTIME_DIR`
is ever used). The sticky bit on the files is the XDG alternative and is
harmless to set on POSIX.

**Self-heal.** Every 5 s, and immediately when an accept fails or a connection
count drops to zero, the daemon compares `stat(paths.socket).ino` with the inode
it bound. On mismatch or `ENOENT`: recreate the directory 0700 (with the uid
check), listen a fresh `net.Server` on the path, rewrite `endpoint.json`, and
retake the lock on a fresh file, logging `endpoint.recreated`. tmux's SIGUSR1
does the same on request; a `SIGUSR1` handler that runs the check at once is
worth keeping for `werk doctor --repair`. gpg-agent's "terminate on stolen
socket" is the wrong policy for a process that owns live PTYs.

**Lock in the state dir.** Move `daemon.lock` to `$stateDir/daemon.lock`. The
state dir is what the checkpoints and identity actually share, and it is not
subject to runtime cleaning, so the guarantee becomes "at most one daemon per
state dir" rather than "per runtime-dir inode". In the reproduction above,
daemon 2 would then have failed with "Daemon already running" and daemon 1's
self-heal would have restored the endpoint within the client's 10 s deadline.
Risk: `flock` on an NFS state dir; on Linux it is emulated through `fcntl`
locks and works when `lockd` does, on macOS it may fail. Fall back to the
runtime-dir lock plus the pid record below when `flock` returns `ENOLCK` or
`ENOTSUP`, and log which.

**Pid record and orphan detection.** Write `$stateDir/daemon.json`
`{ pid, bootId, runtimeDir, endpoint, version, startedAt }` (the daemon, not the
CLI; `daemon.pid` in the runtime dir can go). `bootId` is a random id also
returned by `daemonInfo`, so pid reuse cannot be mistaken for the same daemon.
`ensureSessionDaemon`, when the probe fails: read `daemon.json`; if the pid is
alive (`process.kill(pid, 0)`), send `SIGUSR1` on POSIX and poll the endpoint
for a few seconds before concluding anything; only spawn when no recorded
daemon is alive, and say "daemon <pid> is alive but its endpoint is missing" in
the timeout error otherwise. On Windows there is no signal; the periodic
self-check carries it, and the TCP endpoint plus credential file are the only
things in the runtime dir, so the same recreate loop rewrites them.

**Small fixes alongside.** Check the socket path length in
`ensureSessionDaemon` before spawning (today the daemon dies on it silently);
take the lock after that check in `serveSessionDaemon` (today the lock file is
created first, `940` before `944`, which the hardening test tolerates).

### Code touch points

- `packages/werk/src/main.ts:244-258` (defaults, Windows branch), `259-282`
  (`daemon.pid` removal, `SIGUSR1` handler).
- `packages/session-daemon/src/local.ts:9-20` (paths gain `pidRecord`, lock in
  state dir), `124-179` (ownership check, path-length check, orphan detection,
  richer timeout error).
- `packages/session-daemon/src/index.ts:932-1004` (endpoint monitor, recreate,
  directory flock, touch timer, `daemon.json`), `138-153` (`bootId` in
  `DaemonInfo`).
- `packages/session-daemon/src/platform/lock.ts` (shared lock on a directory
  fd is `flock(fd, LOCK_SH)`, same symbol).
- `packages/session-daemon/README.md`, `docs/session-library.md`, 04 §5 (rewrite
  the hierarchy to match; the doc rule is to rewrite, not annotate).

### Tests

- Hardening: serve, remove the runtime dir, assert the endpoint reappears
  within the self-heal interval and a new client connects to the same daemon
  id and `bootId`.
- Hardening: serve, remove the runtime dir, call `ensureSessionDaemon` with a
  command that would start a second daemon; assert no second process starts,
  the first daemon's endpoint is used, and the checkpoint keeps
  `"state":"running"` for two intervals.
- Native: pre-create the runtime dir with mode 0777 and, where a second uid is
  available in CI, another owner; assert both daemon and client refuse.
- Native (Linux): hold a shared flock on the directory and confirm
  `systemd-tmpfiles --clean` with an aged config skips it (optional; document if
  CI cannot run it).
- Artefact test: the copied-binary lifecycle already kills the daemon abruptly;
  add "runtime dir removed while running" to it.

### Effort

About 15 hours: path policy and Windows default 2, client-side ownership and
length checks 1, self-heal loop and touch timer 4, state-dir lock with fallback
2, pid record and orphan detection 3, tests and docs 3.

### Risks

- Polyinstantiated or per-session `/tmp` (SELinux `namespace.conf`,
  `pam_tmpdir`) makes `/tmp/werk-UID` invisible across logins; `--runtime-dir`
  and `WERK_RUNTIME_DIR` remain the escape hatch, and `werk doctor` should
  print the resolved path.
- `flock` over NFS for the state-dir lock (above).
- The self-heal interval is a window in which a client can still spawn a second
  daemon; the state-dir lock closes it.
- The sticky-bit and touch measures are belt and braces; if they annoy anyone
  they can go without changing the design.

---

## B. The lock on musl

### Current state

`packages/session-daemon/src/platform/lock.ts:5-30`: on POSIX, `dlopen` of
`libSystem.B.dylib` (darwin) or `libc.so.6` (everything else), then
`flock(fd, 6)` (`LOCK_EX | LOCK_NB`, the same values on Linux and macOS) on
`daemon.lock` opened with `"a"` and mode 0600. Windows uses an exclusive
`CreateFileW` handle (`win32.ts:77-100`). The PoC (`werk-poc/src/platform/posix.ts:66-81`)
tried `["libc.so.6", "libc.so"]` in turn; the product lock dropped the list
(`a492a64`). The packaging doc (07 §2) records that musl builds still need
`libstdc++.so.6` and `libgcc_s.so.1`, and 07 §4 that `dlopen` works inside
compiled binaries after #30720. Windows ARM64 has no `bun:ffi`, which the README
already states.

### Verified facts

On `oven/bun:1.3.14-alpine` (Alpine 3.22; `ldd bun` shows
`/lib/ld-musl-x86_64.so.1`, `libc.musl-x86_64.so.1 => /lib/ld-musl-x86_64.so.1`,
`libstdc++.so.6`, `libgcc_s.so.1`; `/lib` holds only those two libc names) a
probe under `bun probe.ts` gave:

| name                        | result on musl                                     | result on glibc (Ubuntu 26.04) |
| --------------------------- | -------------------------------------------------- | ------------------------------ |
| `libc.so.6`                 | OK, `flock` 0, child's `flock` on the same file -1 | OK, child -1                   |
| `libc.so`                   | OK                                                 | fails                          |
| `libc.musl-x86_64.so.1`     | OK                                                 | fails                          |
| `libc.musl-aarch64.so.1`    | OK (this file cannot exist on x86_64)              | fails                          |
| `/lib/ld-musl-x86_64.so.1`  | OK                                                 | fails                          |
| `/lib/ld-musl-aarch64.so.1` | fails, "No such file or directory"                 | fails                          |
| `libc`                      | fails                                              | fails                          |

The impossible aarch64 name succeeding is the proof: musl's `ldso/dynlink.c`
`load_library` has a block commented "Catch and block attempts to reload the
implementation itself" that matches names beginning `lib` followed by one of
`c.`, `pthread.`, `rt.`, `m.`, `dl.`, `util.`, `xnet.` and returns the already
loaded `ldso` for them. So `dlopen("libc.so.6")` resolves to musl itself, the
`flock` symbol is found, and exclusivity holds across processes. The review's
premise ("that library does not exist, so the daemon cannot start") is true of
the file and not of the call.

Not verified: the same probe compiled with `bun build --compile
--target=bun-linux-x64-musl` and run on plain `alpine:3.22` with `libstdc++`
and `libgcc` installed. That job was lost to the reboot. Because the name is
resolved by the system loader at run time, and #30717/#30720 concerned embedded
libraries rather than system ones, the compiled result should match, but it
should be confirmed on the existing Alpine lane in `.github/workflows/poc.yml`
(`linux-x64-musl`, job container `alpine:3.22`) before anyone relies on it.

Also verified under Bun on Linux: listening on an abstract unix socket
(`"\0name"`) is exclusive (a second listener in the same process and one in a
child both get `EADDRINUSE`), and per the Node net docs an abstract socket
"will disappear automatically when all open references to the socket are
closed", so it releases on death like `flock`.

`process.versions` on Bun's musl build, and whether Bun reports its libc
anywhere, was part of the lost probe and is unverified. Detection is not needed
for the recommendation below.

### Recommendation

Keep `flock` as the primary mechanism on POSIX; it is the one that is tied to
the file (and so to the state or runtime dir), crash-safe, and now shown to work
on glibc, musl and macOS. Make `lock.ts` robust in three cheap ways:

1. Try `["libc.so.6", "libc.so", "libc.musl-<arch>.so.1"]` on Linux as the PoC
   did (`<arch>` from `process.arch`: `x64` to `x86_64`, `arm64` to `aarch64`).
   This costs nothing and covers a loader that does not intercept the name.
2. If every `dlopen` fails, fall back on Linux to holding an abstract socket
   named from a hash of the lock path (`"\0werk:" + sha256(path).slice(0, 32)`),
   kept open for the daemon's lifetime; report `lock.mechanism = "abstract-socket"`
   in the log and `daemonInfo`. Its identity is the network namespace rather than
   the filesystem, so two containers sharing a state dir but not a netns would
   both succeed; that is why it is the fallback and not the primary.
3. On macOS there is no abstract namespace and `libSystem.B.dylib` always
   exists, so no fallback is needed; on Windows ARM64 the README's "unsupported"
   stands until Bun ships FFI there.

Do not replace `flock` with "the listening socket is the lock": a stale socket
file must be unlinked before bind, and the unlink-then-bind race is exactly
what 04 §3 warns produces two daemons. Do not use an `O_EXCL` pid file: pid
reuse and no automatic release.

### Code touch points

- `packages/session-daemon/src/platform/lock.ts` (candidate list, fallback,
  a `mechanism` field on the release handle).
- `packages/session-daemon/src/index.ts:940` (log the mechanism, see C).
- `.github/workflows/session-libraries.yml`: add a musl lane running
  `packages/session-daemon/test/native.test.ts` in an `alpine:3.22` container
  with `libstdc++ libgcc` installed, mirroring `poc.yml:1151-1200`.

### Tests

- The existing "kernel daemon ownership is exclusive and reusable"
  (`native.test.ts:67-78`) and "kernel lock rejects concurrent ownership"
  (`hardening.test.ts:429-461`) run unchanged on the Alpine lane.
- A unit test that forces the `dlopen` path to fail (inject the candidate list)
  and asserts the abstract-socket fallback is exclusive across a spawned child.
- A compiled-binary run of the lock test on Alpine (the unverified case).

### Effort

About 4 hours: 1 for the candidate list and fallback, 1 for tests, 2 for the CI
lane.

### Risks

- Something else in the daemon may break on musl before the lock is reached
  (07 §2's `libstdc++` note); the CI lane finds it.
- The abstract-socket fallback is Linux-only and netns-scoped, as above.

---

## C. Logging

### Current state

- No `console`, no log file, no logger in `packages/session-daemon/src` (grep
  confirms). Failures are swallowed: unreadable checkpoints (`index.ts:281-283`),
  the connection loop (`868`), engine faults (`605-622`, state set to `failed`
  with no record of the error beyond `exit.reason`), checkpoint failures
  (`420-426`, only in `info.checkpoint.reason`), spawn failures (only in the
  response to the one client).
- `local.ts:166`: the detached daemon has all three stdio ignored, so the CLI's
  `main().catch` (`main.ts:366-371`) prints the daemon's start-up error to
  `/dev/null`.
- The PoC had a `wp.log` in the runtime dir (`werk-poc/src/daemon/main.ts:87-92`)
  and a `log` callback threaded into sessions. 04 §11 recommends
  `$XDG_STATE_HOME/werk/werkd.log` with rotation and "surface errors to the user
  where they are"; 04 §4 and proposal 01 §3 both assume "the failure reason comes
  from the daemon's log file" on start-up timeout.

### Verified facts

- During the A experiment the daemon was first started with a 130-byte runtime
  path (the scratchpad). The client said only "Daemon did not become ready
  before startup deadline". Running `werk session-daemon` in the foreground
  showed the real reason: "Unix socket path exceeds portable length limit"
  (`index.ts:944-945`). Nothing recorded it.
- Bun 1.3.14 honours `process.on("uncaughtException")` and
  `process.on("unhandledRejection")`; with both handlers installed a thrown
  error in a timer and a rejected promise were both reported and the process
  continued ("still alive" printed after).
- The state dir is the right home: it survives the runtime dir being removed
  (A), it survives the daemon, and 04 §5 already places logs there.

### Recommendation

**Logger.** A `createLogger({ file, level, maxBytes = 5 MiB, keep = 3 })` in
`packages/session-daemon/src/log.ts`, dependency-free: `openSync(file, "a")`,
`writeSync` per line (synchronous append is simplest and survives a crash mid
write; the daemon writes tens of lines a minute, not thousands), a line cap of
8 KiB, and every write wrapped so that a logging failure (disk full, `EBADF`
after rotation) never throws into the daemon. Rotation by size after each
write: close, rename `.2` to `.3`, `.1` to `.2`, `daemon.log` to `.1`, reopen;
on Windows close before rename and tolerate a rename failure by truncating
instead. One line per entry, `ISO-time LEVEL event key=value ...`, values
JSON-quoted when they contain spaces; this reads under `tail -f` and still
parses. JSON lines are the alternative if a consumer wants to ingest them;
either is fine, pick one.

**Level and flag.** `error`, `warn`, `info`, `debug`; `--log-level` on
`session-daemon`, `WERK_LOG_LEVEL` as the environment form, default `info`.
`ensureSessionDaemon` passes the level through when the CLI was given one.

**Events.** Fixed vocabulary, so `werk doctor` can grep it:

| Level | Event                                                                                          | Fields                                                                                                                       |
| ----- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| info  | `daemon.start`, `daemon.stop`                                                                  | version, pid, bootId, paths, lock mechanism, reason                                                                          |
| info  | `lock.acquired`; error `lock.refused`                                                          | path, mechanism                                                                                                              |
| info  | `endpoint.written`, `endpoint.lost`, `endpoint.recreated`, `runtime-dir.recreated` (A)         | path                                                                                                                         |
| info  | `connection.accept`, `connection.drop`                                                         | conn id, principal, reason: `hello-timeout`, `protocol`, `control-queue-full`, `encode-failure`, `transport-error`, `closed` |
| info  | `session.create`, `session.exit`; warn `session.spawn-failed`; error `session.failed`          | session id, argv[0], cwd, principal, exit code, error                                                                        |
| warn  | `checkpoint.failed`, `checkpoint.unreadable` (recovery), `checkpoint.oversize`                 | session id, reason                                                                                                           |
| debug | `attachment.attach`, `attachment.detach`, `attachment.revoked`, `request.error` (non-INTERNAL) | ids, code                                                                                                                    |
| error | `request.internal` (an `INTERNAL` response), `uncaught`, `unhandled-rejection`                 | method, stack                                                                                                                |

Never log environment, input bytes, credentials, or full `argv` above `debug`
(`argv` can carry secrets on the command line).

**Uncaught errors.** `unhandledRejection`: log with stack and continue; these
come from one connection or one session and the boundaries in 04 §7 already
isolate them. `uncaughtException`: log with stack, run one checkpoint pass, and
continue; keep a counter and if more than ten arrive within a minute, log
`daemon.stop reason=repeated-uncaught`, close gracefully (which checkpoints and
terminates children as today) and exit 1. Exiting on the first one would orphan
every PTY child and lose up to 5 s of checkpoint; continuing is Tratt's rule
and matches 04 §7.

**Surface it.** `werk info` prints, without needing a daemon: runtime dir,
state dir, socket or endpoint, lock path and mechanism, log path, recorded pid
and bootId, CLI version; and, if a daemon answers, its `daemonInfo`. `werk
doctor` checks: runtime dir exists, owned by us, mode 0700; endpoint readable
and connect plus `hello` succeed; recorded pid alive; lock held (try and fail
to take it); state dir writable and free space; the last twenty log lines and
the last `error` line; `TERM` and terminfo for `xterm-256color`. The
`ensureSessionDaemon` timeout error should append the last `error` line from
the log, which turns the silent case above into "daemon did not become ready:
Unix socket path exceeds portable length limit".

### Code touch points

- New `packages/session-daemon/src/log.ts`; `DaemonConfig` gains
  `log?: Logger` and `logLevel?`.
- `index.ts`: `createSessionDaemon` (connection accept/drop `805-874`, create
  and exit `562-648`, checkpoint `378-432`, recovery `433-483`), and
  `serveSessionDaemon` (`932-1004`, start/stop/lock/endpoint events).
- `local.ts:124-179`: pass `--log-level`, read the log tail on timeout.
- `main.ts`: `--log-level` parsing (`53-62`), `session-daemon` handlers
  (`259-282`), `info` (`322-324`), new `doctor`.
- `packages/session-daemon/README.md`, `docs/session-library.md`.

### Tests

- Logger unit tests: rotation at the byte limit with `keep` files, line cap,
  write failure does not throw (open on a read-only file).
- Hardening: a forced spawn failure and a forced checkpoint failure each leave
  one line with the expected event and session id; an `INTERNAL` error logs a
  stack.
- Hardening: `unhandledRejection` inside a callback leaves the daemon serving;
  a synthetic burst of eleven uncaught exceptions ends it with checkpoints
  written.
- Artefact test: start with an over-long runtime dir and assert the client
  error contains the daemon's reason.

### Effort

About 14 hours: logger 3, wiring events 3, uncaught policy 1, `info` and
`doctor` 4, tests and docs 3.

### Risks

- Log growth from chatty events; `activity` and `output` are never logged, and
  rotation bounds the rest.
- Secrets in logs; the vocabulary above avoids env, input and full argv.
- Windows rename-while-open on rotation; handled by close-then-rename and a
  truncate fallback.

---

## D. Environment

### Current state

- `index.ts:580-584`: the child env is
  `{ ...process.env, TERM: "xterm-256color", ...p.env }`.
- `local.ts:158-167`: the daemon is spawned with no `env` and no `cwd`, so it
  inherits both from the CLI that happened to start it.
- `main.ts:308-317`: `create` sends `argv`, `cwd`, `size`, `name`, `labels`; no
  `env`. `packages/session/src/types.ts:59` already declares
  `env?: Record<string, string>`.
- `index.ts:530-541`: `env` is type-checked (an object of strings) but the size
  limits at `543-549` cover only `name` and `labels`; the only bound on `env`
  is the 8 MiB frame. `env` is not part of `SessionInfo` (`565-576`), so it is
  not checkpointed to disk. Good; keep it that way.
- The PoC's tests (`werk-poc/src/daemon/daemon.test.ts:52`) already passed a
  minimal `{ PS1, PATH }` env, which is the "clean base" idea in miniature.

### Verified facts

- Reproduction: with `WERK_PROBE=first`, `SSH_AUTH_SOCK=/tmp/agent-first` and
  `COLORTERM` unset, `werk create` started the daemon; `/proc/<pid>/environ`
  contained `WERK_PROBE=first` (52 variables, 4074 bytes) and the daemon's cwd
  was the CLI's cwd. A second `werk create` from a shell with
  `WERK_PROBE=second`, `SSH_AUTH_SOCK=/tmp/agent-second`,
  `COLORTERM=truecolor` produced a session whose screen read
  `PROBE=first AGENT=/tmp/agent-first TERM=xterm-256color COLORTERM=`.
- tmux(1): "When the tmux server starts, it copies the current environment into
  a global environment, which is then used to initialize session environments
  when new sessions are created." `update-environment` is "a comma-separated
  list of variables that will be updated in new session environments from the
  global environment when a new session is created" (and on attach, from the
  attaching client); `-E` on `new-session`/`attach-session` disables it;
  `new-session -e VAR=value` sets per-session variables. The default list from
  `options-table.c`: `DISPLAY KRB5CCNAME MSYSTEM SSH_ASKPASS SSH_AUTH_SOCK
SSH_AGENT_PID SSH_CONNECTION WAYLAND_DISPLAY WINDOWID XAUTHORITY
XDG_CURRENT_DESKTOP XDG_SESSION_DESKTOP XDG_SESSION_TYPE`.
- screen(1): windows are "forked from the parent screen process, not from the
  invoking shell", so they see screen's environment; `TERM` is set to `screen`.
- zellij: the server's environment is the one it started with; issue #1637
  ("update SSH_AUTH_SOCK after reconnect") is open, #1987 asks for per-pane
  variables, and users document that after an ssh reconnect "SSH_AUTH_SOCK still
  points to a socket file that got cleaned up".
- execve(2): the total of argv and envp "is limited to 1/4 of the allowed stack
  size" (2 MiB with the usual 8 MiB stack, capped at 6 MiB), "the limit per
  string is 32 pages (the kernel constant MAX_ARG_STRLEN)", 128 KiB, else
  `E2BIG`. A spawn that hits it surfaces today as "Spawn failed" (`625-630`).

### Recommendation

**What the CLI sends.** The whole `process.env` minus a denylist, not an
allowlist. The review's own example (an API key set in the later shell) is
exactly what an allowlist would drop, and tmux's `update-environment` is an
allowlist only on top of a full copy taken at server start; werk cannot rely on
that copy because the daemon may be started by a supervisor with an empty
environment, or by an unrelated earlier shell as verified. Denylist:

- terminal identity, which belongs to the daemon's emulated terminal: `TERM`,
  `COLORTERM`, `TERM_PROGRAM`, `TERM_PROGRAM_VERSION`, `TERMCAP`, `LINES`,
  `COLUMNS`, `WINDOWID`;
- multiplexer nesting markers: `TMUX`, `TMUX_PANE`, `STY`, `WINDOW`, `ZELLIJ`,
  `ZELLIJ_SESSION_NAME`, `ZELLIJ_PANE_ID`, `WERK_SESSION`;
- shell bookkeeping: `_`, `PWD`, `OLDPWD`, `SHLVL`;
- `GPG_TTY` (names the client's tty, which the session does not have).

Everything else goes: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`,
`LC_*`, `TZ`, `SSH_AUTH_SOCK`, `SSH_AGENT_PID`, `SSH_CONNECTION`, `DISPLAY`,
`WAYLAND_DISPLAY`, `XAUTHORITY`, `DBUS_SESSION_BUS_ADDRESS`, `XDG_*`, and any
secret the user has exported. A `--env KEY=VALUE` and `--no-env` on `create`
would mirror tmux's `-e` and `-E`; whether they are wanted now is open.

**What the daemon does with it.** When the request carries `env`, spawn with
`{ ...base, ...p.env, ...owned }` where `base` is a minimal set the daemon
guarantees (`PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, and on Windows
`SystemRoot`, `ComSpec`, `PATHEXT`, `TEMP`, `TMP`, `USERPROFILE`, `APPDATA`,
`LOCALAPPDATA`, taken from the daemon's own environment) and `owned` is what
werk sets itself: `TERM=xterm-256color` (as today), `COLORTERM=truecolor` (the
CLI renderer and the DOM renderer both paint 24-bit colour, `main.ts:109`),
`TERM_PROGRAM=werk`, `TERM_PROGRAM_VERSION`, `WERK_SESSION=<id>`,
`WERK_DAEMON=<daemon id>`. When the request carries no `env` (a bridge or an
older client), keep today's inherit behaviour so nothing regresses, but drop
the daemon's own `WERK_*` and `LINES`/`COLUMNS`. Merge case-insensitively on
Windows (`Path` and `PATH` are the same variable there). Document both modes in
`packages/session/README.md`.

**Spawn the daemon clean.** `ensureSessionDaemon` should pass an explicit
`env` (`PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `TMPDIR`,
`XDG_RUNTIME_DIR`, `XDG_STATE_HOME`, `WERK_*`, plus the Windows set above) and
`cwd: "/"` (`os.homedir()` on Windows), as 04 §2 asks. That stops the daemon
carrying the first client's secrets for weeks and pinning its cwd, both
verified today.

**Limits on the request.** Reject with `LIMIT` when `env` has more than 1024
entries, a key over 256 bytes or containing `=` or NUL, a value over 128 KiB
(`MAX_ARG_STRLEN`), or a total over 1 MiB (half the usual execve budget,
leaving room for argv). Reject with `INVALID_ARGUMENT` on non-string values as
today.

**Later, not now.** A per-attach refresh in the tmux `update-environment`
style only helps new processes; the shell already running has the old
`SSH_AUTH_SOCK`. The usual user-level fix is a stable symlink
(`~/.ssh/agent.sock`) updated at login. Whether werk should offer something like
`attach --env` is an open question for `docs/product/04-open-questions.md`.

### Code touch points

- `main.ts:308-317` (build the filtered env), `53-62` (flags if added).
- `local.ts:158-167` (`env` and `cwd` on the daemon spawn).
- `index.ts:530-549` (limits), `580-584` (base plus env plus owned),
  `platform/index.ts:11-36` (case-insensitive merge on win32).
- `packages/session/README.md`, `packages/session-daemon/README.md`.

### Tests

- Daemon: a session created with `env` sees exactly base plus env plus owned
  and nothing from a variable set in the daemon's `process.env`; a session
  created without `env` still inherits.
- Daemon: limits refuse before `engineFactory.create` (mirror
  `hardening.test.ts:374`).
- Daemon: the checkpoint file for a session created with a secret in `env`
  never contains that value.
- CLI (artefact test): create from a shell with a marker variable set after the
  daemon started; the session prints it. The denylist is applied (`TMUX` set in
  the client shell is absent in the session).
- Windows lane: a child started with the base set can run `cmd /c echo`.

### Effort

About 8 hours: CLI filter 1, daemon merge and limits 2, clean daemon spawn 1,
tests 3, docs 1.

### Risks

- Dropping something someone relied on inheriting from the first shell; the
  denylist is short and documented, and inherit mode remains for clients that
  send nothing.
- Windows children fail to start without `SystemRoot`; the base set covers it,
  the Windows lane checks it.
- Larger `create` frames (tens of KiB for conda or nvm environments); well
  within the 8 MiB frame and the new 1 MiB cap.

---

## E. CLI input path

### Current state

- `main.ts:143-166`: on every stdin chunk the CLI pauses stdin, chains a
  promise that calls `attachment.writeInput` for each 16 KiB slice and awaits
  each, and resumes stdin only after the last acknowledgement. The comment says
  "Keep one acknowledged request in flight". `docs/session-library.md` states
  it: "Stdin pauses while input acceptance is pending, with one input request
  in flight."
- `packages/session/src/index.ts:148-160`: `writeInput` is
  `request("input", ...)`; `259-339`: `request` assigns a serial id, enforces
  `maxPendingRequests` (128 by default, `271-274`), a 5 s default timeout, and
  sends in call order through one `FramedTransport`; no retry.
- `packages/session-daemon/src/index.ts:824-873`: the connection loop is
  `for await (const message of c.wire.messages())` with `await request(...)`
  per message, so requests on one connection are handled strictly in wire
  order; the `input` handler (`655-666`) writes to the PTY and returns `null`.
  The daemon README says the same: "Requests are processed serially per
  connection."
- `packages/session/src/protocol.ts:40-44`: bytes are encoded as
  `{"$bytes":[n, n, ...]}`, roughly 3.6 wire bytes per input byte plus ~100
  bytes of envelope per request.
- `examples/session-web/src/client.ts:169, 174-181`: the browser client already
  calls `writeInput` without awaiting between keystrokes (`run(() => ...)`), so
  the CLI is the only consumer that serialises on the acknowledgement.

### Verified facts

- The protocol contract (`packages/session/README.md` and proposal 02 line
  391): `writeInput` "acknowledges acceptance, not execution"; "Requests
  default to a five-second deadline with at most 128 pending requests";
  "Timeout and cancellation errors explicitly mark remote outcomes unknown. No
  operation is automatically retried"; "Creation and input timeouts have an
  unknown remote outcome; consumers ... must not automatically replay those
  operations". Nothing requires an acknowledgement before the next input is
  sent; the one-in-flight rule is a CLI choice.
- Ordering is a property of the wire (one framed stream, serial handling), so N
  outstanding input requests are applied in the order sent. This is why
  pipelining needs no protocol change.
- Arithmetic rather than measurement: at 100 ms RTT the current loop admits at
  most ten input requests per second, and every keystroke waits a full RTT
  before stdin resumes, so a held key or a fast typist queues behind the
  acknowledgement even when throughput would suffice.

### Recommendation

**Now: bounded pipelining in the CLI.** Keep stdin flowing; count requests
(and bytes) in flight; call `process.stdin.pause()` only when 32 requests or
64 KiB are unacknowledged and `resume()` when the count drops below; any
rejection sets `error` and finishes as today. The Ctrl-`]` scan per chunk stays.
The 16 KiB slicing stays (it keeps each frame small and bounded by the daemon's
control queue). 32 is well under the client's 128 pending limit and leaves room
for `resize` and `detach`. Update the sentence in `docs/session-library.md`.

**Later, if measured: an unacknowledged input frame.** A `{ type: "input",
attachmentId, data }` message with no response would halve message count and
remove the response frames; errors would arrive as an attachment event
(`ended` with reason `input-refused`, or a new `error` event). It changes the
documented "acknowledges acceptance" contract, needs its own flow control (the
daemon's control queue bound already drops a connection that floods), and gives
the caller no signal when the PTY is gone. Only worth it if a real ssh-forwarded
measurement shows the response frames matter after pipelining; the soak harness
already injects latency and could carry that measurement.

**Also worth noting.** The `$bytes` array encoding is fine for keystrokes and
tolerable for pastes; a base64 string would be a wire-format change and belongs
with any later protocol revision, not here.

### Code touch points

- `main.ts:141-166` (window counter, pause/resume thresholds), `206-208`
  (await outstanding before returning).
- `docs/session-library.md` (the one-in-flight sentence).
- Optionally `packages/session/src/index.ts`: an `Attachment.inputWriter({
maxInFlight, maxBytes })` helper so the browser bridge and the CLI share it.

### Tests

- Session client test with a delayed duplex (the `duplex()` pattern in
  `hardening.test.ts:37-125` plus a per-frame delay, as `session-soak.ts`
  does): 100 single-byte inputs complete in about one RTT plus 100/32 RTTs, not
  100 RTTs, and an echoing child reproduces the bytes in order.
- Window never exceeds the threshold (assert `pending.size` through a spy or a
  counting transport).
- Error path: input after the child exits rejects `CONFLICT` and ends the
  attach with that error while earlier inputs were delivered.

### Effort

About 3 hours including tests and the doc sentence.

### Risks

- Up to 32 requests are lost-in-flight on a timeout instead of one; the
  contract already says the outcome is unknown and must not be replayed, so
  nothing new is promised.
- A stalled daemon holds 64 KiB of the user's typing in memory on the client;
  bounded and small.

---

## Sources

- logind.conf(5): https://man7.org/linux/man-pages/man5/logind.conf.5.html
- pam_systemd(8): https://man7.org/linux/man-pages/man8/pam_systemd.8.html
- loginctl(1): https://man7.org/linux/man-pages/man1/loginctl.1.html
- user@.service(5): https://man7.org/linux/man-pages/man5/user@.service.5.html
- XDG Base Directory Specification: https://specifications.freedesktop.org/basedir-spec/latest/
- tmpfiles.d(5): https://man7.org/linux/man-pages/man5/tmpfiles.d.5.html ·
  systemd-tmpfiles(8): https://man7.org/linux/man-pages/man8/systemd-tmpfiles.8.html
- Fedora change "KillUserProcesses by default": https://fedoraproject.org/wiki/Changes/KillUserProcesses_by_default ·
  ArchWiki systemd/User: https://wiki.archlinux.org/title/Systemd/User
- tmux(1): https://man7.org/linux/man-pages/man1/tmux.1.html ·
  `options-table.c`: https://raw.githubusercontent.com/tmux/tmux/master/options-table.c ·
  tmux #4640: https://github.com/tmux/tmux/issues/4640
- screen(1): https://man7.org/linux/man-pages/man1/screen.1.html ·
  dtach(1): https://linux.die.net/man/1/dtach
- zellij #3909: https://github.com/zellij-org/zellij/issues/3909 · #4155:
  https://github.com/zellij-org/zellij/issues/4155 · #1637:
  https://github.com/zellij-org/zellij/issues/1637 · #1987:
  https://github.com/zellij-org/zellij/issues/1987 · Zellij and Claude Code over
  ssh: https://fabiorehm.com/blog/2025/11/19/using-zellij-and-claude-code-over-ssh/
- gpg-agent(1): https://www.gnupg.org/documentation/manuals/gnupg26/gpg-agent.1.html ·
  gpgconf: https://www.gnupg.org/documentation/manuals/gnupg/Invoking-gpgconf.html ·
  T2756: https://dev.gnupg.org/T2756
- ssh-agent(1): https://man.openbsd.org/ssh-agent.1
- Apple DTS on temporary directory cleanup: https://developer.apple.com/forums/thread/71382 ·
  https://til.codeinthehole.com/posts/how-temp-files-are-removed-on-macos/
- Storage Sense: https://support.microsoft.com/en-us/windows/experience/storage-filemanagement/manage-drive-space-with-storage-sense
- musl `ldso/dynlink.c`: https://git.musl-libc.org/cgit/musl/tree/ldso/dynlink.c
- Bun FFI: https://bun.sh/docs/api/ffi
- execve(2): https://man7.org/linux/man-pages/man2/execve.2.html
- Node `net` (IPC paths, abstract sockets): https://nodejs.org/api/net.html
- In-repo: `docs/research/04-daemon-best-practices.md` §2 to §5, §7, §11;
  `docs/research/07-packaging.md` §2, §4; `docs/proposals/01-cross-platform.md`
  §3 table; `docs/proposals/02-session-library.md` (paths and `writeInput`
  contract); `packages/werk-poc/src/platform/posix.ts`, `daemon/paths.ts`,
  `daemon/main.ts`; `packages/werk-poc/findings/platforms.md` (musl lanes).
