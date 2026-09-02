# 04 — Ad-hoc daemons: best practices

Scope: a daemon that is **not** managed by systemd/launchd. It is spawned on
demand by the first client that needs it, outlives that client, and is discovered
by later clients. This is the tmux/zmx/shpool/hauntty model.

Two things make werk's version of it harder than the usual one, and they colour
everything below:

- **There are N daemons, one per machine**, and the local client is also a client
  of the remote ones. §3 (the ad-hoc spawn race), §4 (readiness), §5 (filesystem
  layout) and §9 (version skew) all have to work over ssh, against a machine
  whose state you cannot see. §9 is the worst of it: "the daemon outlives the
  binary" becomes "six daemons outlive the binary". See
  [`../product/02-journeys.md`](../product/02-journeys.md) §11.
- **Windows is a first-class client.** §1's Unix socket works as `AF_UNIX` on
  Windows, and a named pipe is an option rather than a requirement; §2's
  `setsid`/`fork` discussion becomes `DETACHED_PROCESS` semantics — a detached
  child has no console, so no console-control event reaches it; and §6's
  `SIGHUP → grace → SIGKILL` teardown has to be a protocol shutdown there,
  because a signal cannot reach a detached daemon and Bun's `proc.kill(signal)`
  is `TerminateProcess` whatever signal is named ([07 §6](07-packaging.md),
  measured in [`platforms.md`](../../packages/werk-poc/findings/platforms.md)).

The principles here are language-agnostic and hold whatever
[02](02-language-choice.md) resolves to; the crate shortlist at the end is
conditional on Rust. §7 (keep running when things go wrong) and §8
(backpressure) get harder with a network in the path, not easier.

The item to promote in priority is **§11's `werk info` and `werk doctor`.** With
one machine they save support time. With six machines, two container runtimes and
a bastion in the middle they are the difference between a debuggable product and
an unusable one.

The single best general reference is Laurence Tratt's
[Some Reflections on Writing Unix Daemons](https://tratt.net/laurie/blog/2024/some_reflections_on_writing_unix_daemons.html),
written after ~20 years of maintaining three of them. Most of the principles
below are his, with the ad-hoc-spawn and PTY specifics added.

---

## 1. Front-end / back-end split over a Unix domain socket

**The pattern.** One user-facing binary with subcommands; a backend process; all
communication over a Unix domain socket. Tratt: he regrets _not_ doing this from
the start in his other daemons, and calls it the pattern he'd use for all of them.

**Never use signals for control.** Tratt is emphatic: signals depend on PIDs (you
can signal the wrong process after PID reuse), handlers run asynchronously so
almost nothing is safe to do inside them, and programmers are systematically
over-optimistic about what is signal-safe. `pizauth reload` sends a socket command
instead of `kill -HUP`. Do the same: `werk reload`, `werk kill <id>`, `werk detach <id>`
are all socket round-trips.

Signals we _do_ handle, minimally, via `tokio::signal` or `signal-hook` (which
turn signals into ordinary events rather than handler callbacks):

- `SIGTERM`/`SIGINT` → graceful shutdown: snapshot every session to disk, close
  sockets, exit.
- `SIGPIPE` → **ignore it** (Rust's std already sets `SIG_IGN` for `SIGPIPE` at
  startup, but confirm it survives any `fork`/`exec` you do). A client
  disconnecting must never kill the daemon; `EPIPE`/`ECONNRESET` on a client
  socket is a normal, expected event.
- `SIGCHLD` → do not handle directly; use the runtime's child reaping.

**Socket presence is the liveness check.** No PID files as the source of truth.
"Presence of the socket file reliably indicates daemon status" — with the stale-
socket caveat handled in §3.

## 2. Do not `fork()` to daemonize. Re-exec yourself.

The textbook advice is double-fork + `setsid()`: fork, `setsid()` in the child to
become session leader, fork again so the grandchild can never reacquire a
controlling terminal, exit the intermediate. The `daemonize2` and `fork` crates
implement this.

**But `fork()` in a process with threads is a trap**, and any Rust program with a
tokio runtime, a thread pool, or even certain allocators has threads. After
`fork()` only async-signal-safe functions are legal in the child: a lock held by a
thread that doesn't exist in the child is held forever. Deadlocks here are rare,
non-deterministic, and horrible.

**Recommended: spawn a fresh copy of the binary.** The client `exec`s itself (or
`/proc/self/exe`) with a hidden subcommand — `werk __daemon` — with a clean
environment, `setsid`, and stdio redirected to `/dev/null`. `std::process::Command`
plus `CommandExt::pre_exec` (or `process_group(0)` / `setsid` via `nix`/`rustix`)
does this. The daemon starts from a known-good single-threaded state.

If you must daemonize in-process, do it **before** starting the runtime, before
spawning any thread, and before any allocation that could take a lock.

Either way:

- `setsid()` so the daemon has no controlling terminal and is immune to the
  client's `SIGHUP`, `^C`, and terminal close.
- `chdir("/")` (or to the state dir) so you don't pin a mount.
- Reopen fds 0/1/2 on `/dev/null`. Never inherit the client's tty — that is how
  a "background" daemon ends up writing garbage over someone's TUI three hours
  later.
- Clear inherited fds. `CLOEXEC` everything you open; audit what the PTY child
  inherits.

## 3. The ad-hoc spawn race is the hard part

Two `werk` invocations start simultaneously and both find no socket. Handle it
explicitly:

1. **Lock before binding.** `open()` + `flock(LOCK_EX|LOCK_NB)` on
   `$RUNTIME/werk/daemon.lock`. Winner spawns the daemon; loser skips to step 3.
   (`flock` releases automatically on process death — no stale-lock cleanup, which
   is exactly why it beats a PID file.)
2. **Bind atomically.** `bind()` to a temp path in the same directory, then
   `rename()` into place. `bind()` fails with `EADDRINUSE` on an existing path, so
   without this you get a race between `unlink` and `bind`.
3. **Connect with bounded retry.** Exponential backoff, hard timeout, then a real
   error message.
4. **Detect and clean stale sockets.** A socket file whose daemon died still
   exists. `connect()` returning `ECONNREFUSED` means stale: take the lock,
   re-verify, `unlink`, respawn. Never blind-`unlink` a socket you haven't proven
   dead — that's how you orphan a live daemon.

## 4. Readiness handshake — do not sleep-and-hope

The client must know the daemon is listening, and must get a _useful error_ when
it isn't. Pass an anonymous pipe to the spawned daemon. The daemon writes either
a `ready` byte or an error string and exits non-zero; then closes the write end.
The client reads until EOF with a timeout. This turns "daemon failed to start
because the port was taken / the state dir was unwritable" from a silent hang
into a printed message.

`sd_notify`-style readiness, but hand-rolled — the same idea systemd formalised.

The pipe does not travel: on Windows in Bun 1.3.14 the parent's end of an extra
stdio slot is a raw HANDLE that nothing reads
([`platforms.md`](../../packages/werk-poc/findings/platforms.md)). The portable
form is the client polling `connect` and completing `hello` under a deadline,
with the daemon writing its failure reason to a log the client prints on
timeout; where the pipe works it is only a faster route to the same message.

## 5. Filesystem layout: XDG, per-uid, 0700

Follow zmx's hierarchy, which is the well-considered version:

```
$WERK_DIR                    explicit override
$XDG_RUNTIME_DIR/werk        preferred: tmpfs, already 0700, cleaned on logout
$TMPDIR/werk-$UID            multi-user safe fallback
/tmp/werk-$UID               last resort
```

- Directory mode `0700`, socket mode `0600`, both configurable.
- **Verify ownership before trusting anything in `/tmp`.** `stat` the directory
  and socket and refuse if the owner isn't the current uid — otherwise another
  local user can pre-create `/tmp/werk-1000` and you hand them your sessions.
- On the daemon side, use `SO_PEERCRED` (Linux) / `LOCAL_PEERCRED` (macOS) to
  verify the connecting uid rather than relying only on filesystem permissions.
- Persisted snapshots and logs go under `$XDG_STATE_HOME/werk` (they must survive
  reboot); runtime sockets do not.
- **Ship `werk info`** that prints every path it will use. Tratt calls this out
  specifically; it makes every support conversation shorter.

## 6. Process lifecycle: own your children properly

This is PTY-daemon-specific and is where the real bugs live.

- The PTY child must `setsid()` and then `ioctl(TIOCSCTTY)` on the slave fd so it
  is a session leader with the PTY as its controlling terminal. Without this,
  job control and `^C` do not work and the child gets no `SIGWINCH`.
- Set the window size with `TIOCSWINSZ` _before_ exec, and again on every resize;
  the kernel delivers `SIGWINCH` to the foreground process group.
- **On Linux, `prctl(PR_SET_CHILD_SUBREAPER, 1)`** in the daemon. Orphaned
  grandchildren (anything the shell or `claude` spawned and abandoned) reparent to
  `werkd` instead of PID 1, so we receive their `SIGCHLD` and can `wait()` them.
  This is how systemd, upstart, and nosh track double-forked services. Note the
  flag is _not_ inherited by `fork`, but _is_ preserved across `execve`.
- **macOS has no subreaper.** Fall back to per-session process groups and
  `killpg(-pgid, SIGHUP/SIGTERM)` on teardown, and accept that runaway
  grandchildren can escape.
- Reap decisively: on session kill, `SIGHUP` the process group, wait with a grace
  period, then `SIGKILL`. Zombies accumulate in a daemon that runs for weeks.

## 7. Keep running when things go wrong

Tratt's central lesson: _"A fundamental part of being a daemon is the ability to
keep running (correctly!) when things go wrong."_ Daemons hit vastly more edge
cases than short-lived programs simply because they run continuously — `EINTR`,
unexpected pipe closure, weird child states. He notes that deciding to continue
in every case except memory exhaustion accounted for roughly **half of extsmail's
source code**.

Concretely for werk:

- **A failure in one session must not touch another.** Session-per-task with the
  task boundary as the error boundary; `catch_unwind` (or a supervisor that
  restarts the task) so a panic in VT handling loses one session's fidelity, not
  the daemon.
- Never `unwrap()` on anything derived from a client, a PTY, or the filesystem.
- Retry/degrade rather than exit: if the snapshot directory becomes unwritable,
  log it and keep serving; don't take the fleet down over a full disk.

## 8. Backpressure is the central design problem

A PTY produces faster than a slow websocket consumes. `claude` streaming or a
`yes` loop will out-run a phone on hotel wifi within milliseconds.

**Never let a slow client block the PTY read loop.** The read loop's only job is:
read → write to the VT tap → fan out to attached clients' bounded queues → loop.
A client whose queue is full does not get backpressure applied upstream; it gets
**switched to snapshot mode**.

This is exactly the ghostty-snap design (see [03](03-prior-art.md)):

| Client state    | What we send                                                  |
| --------------- | ------------------------------------------------------------- |
| Keeping up      | `PTY_DATA` — raw bytes, lowest latency, no VT cost            |
| Falling behind  | Stop streaming; keep feeding the VT; coalesce                 |
| Caught up again | `SNAPSHOT` or `VIEWPORT_DELTA` from render state's dirty rows |

And it's the mosh insight formalised: because you can diff any two terminal
states, you are never obliged to transmit every octet, and you can modulate frame
rate to conditions. libghostty's per-row dirty tracking and two-phase render-state
update exist to make exactly this cheap.

Corollaries:

- Bound every queue. Unbounded channels in a daemon are a memory leak with extra
  steps.
- Bound scrollback per session, and drive `ghostty_terminal_compress()` from an
  idle timer keyed on `ghostty_terminal_compression_activity()` — libghostty
  will not do this for you (see [01](01-libghostty-vt.md)).
- Bound total sessions and total memory; refuse new sessions with a clear error
  rather than OOMing the box.

## 9. Version skew: the daemon outlives the binary

A long-lived daemon will still be running when you `npm i -g` a new client. Plan
for it:

- **Protocol version in the handshake**, first message, both directions.
- The client's error on mismatch must be actionable: "daemon is running v3, client
  is v4 — run `werk daemon restart` (sessions will be snapshotted and restored)".
- Consider a snapshot-and-reexec upgrade path: serialize all sessions, `exec` the
  new binary, restore. The snapshot API makes this feasible; the PTY fds can be
  carried across `exec` if not `CLOEXEC`. This is a genuinely differentiating
  feature and worth designing for early even if built later.
- Keep the protocol in its **own versioned crate**, the way shpool ships
  `shpool-protocol`.

## 10. Configuration and CLI: keep it small

Tratt: limit flags to roughly `-c` (config), `-d` (don't daemonize / foreground),
`-v` (stackable verbosity); prefer one config file over several; provide sensible
defaults so most users configure nothing. Configuration complexity correlates
strongly with unreliability, and "do one thing well" suits daemons especially
because they get forgotten once running.

`-d`/`--foreground` is non-negotiable for development and for running under a
supervisor later.

## 11. Logging and observability

- The daemon has no terminal, so logs are the only window. `tracing` +
  `tracing-subscriber` with JSON output to `$XDG_STATE_HOME/werk/werkd.log`,
  per-session spans carrying the session id.
- Rotate, or you will fill a disk during a runaway output loop.
- Tratt's warning: daemon problems hide in logs users never check. **Surface
  errors to the user where they are** — `werk list` should show a session in a
  failed state, not just log it.
- `werk info` (paths, versions, pinned ghostty commit) and `werk doctor` (socket
  reachable, dirs writable, TERM/terminfo sane) pay for themselves.

## 12. Testing

Tratt: "Just because automated testing is hard doesn't mean that one should avoid
automated testing." He added test suites late to two daemons and both had been
harbouring subtle bugs for years.

- **Black-box tests that drive the real binary** with `XDG_RUNTIME_DIR` and
  `XDG_STATE_HOME` pointed at a temp dir. Spawn, attach, detach, kill, assert.
- Accept `sleep`-based timing tests where necessary — imperfect tests beat none.
- VT-specific: golden tests feeding recorded byte streams (asciicast files from
  real `claude`, `top`, `vim` sessions) into a terminal, snapshotting, restoring,
  and asserting the formatter output matches. This is cheap because libghostty
  gives us `formatPlain`/`formatHtml` and a deterministic emulator.
- Fuzz the client↔daemon protocol decoder. It's parsing untrusted-ish input.

## 13. Security posture

- Socket `0600` + peer-credential check (§5). The daemon runs as the user and can
  execute arbitrary code as that user — treat every input surface accordingly.
- The web server is the real risk. See [05](05-control-surfaces.md); Zellij's
  model (mandatory HTTPS on non-loopback, hashed tokens, HttpOnly session
  cookies, opt-in, reverse proxy for rate limiting) is the bar.
- Tratt raises one subtle point: a single monolithic binary containing every
  subcommand widens the surface for gadget-based attacks; he'd prefer several
  minimal binaries. Weigh that against his own other recommendation that a single
  binary with subcommands is best for discoverability. For us, the split that
  matters is `werk` (client) vs `werkd` (daemon), which we get for free from the
  TS-client/native-daemon architecture.

## 14. On async

Tratt's cautionary data point: adding async/await to `snare` caused code
splitting, awkward `Mutex` requirements, and memory leaks; removing it eliminated
41 dependencies and 20% of binary size **for identical functionality**. And zmx
ships this exact product on a plain `poll(2)` loop.

That said, werk's serving surface (HTTP, WebSocket, TLS, many concurrent clients)
is genuinely where async earns its keep, and `axum`/`tokio` are not optional-ish
in that world. A defensible split:

- **Session core**: one thread per session (or a small pool), synchronous, owning
  the non-thread-safe `Terminal`, talking over channels. No async near the VT.
- **Serving layer**: tokio, async, translating between sockets and those channels.

That also respects libghostty's "callbacks must not block" rule naturally,
because the effect callbacks run on a thread that only ever does non-blocking
channel sends.

## Crate shortlist

| Need                      | Crates                                                                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PTY                       | `portable-pty` (cross-platform incl. ConPTY), `pty-process` (tokio/std `Command` + pty, sets controlling terminal), `rustix-openpty`, or raw `rustix::pty` / `nix` |
| Syscalls, termios, ioctls | `rustix` (preferred, no libc dep by default) or `nix`                                                                                                              |
| Async runtime + net       | `tokio`, `tokio-util` (framed codecs)                                                                                                                              |
| Unix sockets              | `tokio::net::UnixListener`, or `interprocess` for a cross-platform abstraction                                                                                     |
| HTTP / WS                 | `axum` + `tokio-tungstenite`; `tower-http` for TLS/compression/limits                                                                                              |
| SSH (if embedding)        | `russh` (low-level, Tokio-based; client + server)                                                                                                                  |
| Signals                   | `tokio::signal`, `signal-hook`                                                                                                                                     |
| Daemonize (if you must)   | `daemonize2`, `fork` — prefer re-exec, see §2                                                                                                                      |
| Logs                      | `tracing`, `tracing-subscriber`, `tracing-appender`                                                                                                                |
| CLI                       | `clap` (derive)                                                                                                                                                    |
| Node bridge               | `napi-rs`                                                                                                                                                          |
| Protocol                  | `serde` + `postcard`/`bincode` for the binary path, `serde_json` for control                                                                                       |

## Sources

- [Some Reflections on Writing Unix Daemons — Laurence Tratt](https://tratt.net/laurie/blog/2024/some_reflections_on_writing_unix_daemons.html)
- [PR_SET_CHILD_SUBREAPER(2const) — man7](https://man7.org/linux/man-pages/man2/PR_SET_CHILD_SUBREAPER.2const.html) · [Don't Fear the Subreaper](https://medium.com/@william.la.martin/dont-fear-the-subreaper-19c8127c031e) · [Dealing with process termination in Linux (Rust examples)](https://iximiuz.com/en/posts/dealing-with-processes-termination-in-Linux/)
- [daemon(7) "New-Style Daemons"](https://man7.org/linux/man-pages/man7/daemon.7.html) · [daemonize crate](https://docs.rs/daemonize) · [fork crate](https://docs.rs/fork)
- [portable-pty](https://docs.rs/portable-pty) · [pty-process](https://docs.rs/pty-process) · [rustix-openpty](https://crates.io/crates/rustix-openpty)
- [shpool](https://github.com/shell-pool/shpool) · [zmx](https://github.com/neurosnap/zmx)
