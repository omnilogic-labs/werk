# @werk/session-daemon

Bun runtime ownership for terminal sessions. `createSessionDaemon` accepts an
explicit state directory and session-scoped engine factory; `accept(transport,
principal)` hosts the portable protocol over a caller-owned stream.
`serveSessionDaemon` adds a private local socket and exclusive launcher record.
`close()` explicitly kills owned processes and saves their retained screens.
Closing a client only removes its attachments.

`resolveSessionDaemonPaths` is read-only. `ensureSessionDaemon` takes an explicit
`daemonCommand` and appends `--runtime-dir` and `--state-dir`; that command must
call `serveSessionDaemon` and handle its shutdown signals. The serialisable
endpoint works with `openLocalTransport` and the portable session client.
`inspectSessionDaemon` is the read-only diagnosis behind `werk info` and
`werk doctor`, and never creates a lock, a directory or a daemon.

## Paths, locking and recovery

`defaultSessionRuntimeDir()` honours `WERK_RUNTIME_DIR`, otherwise returning
`/tmp/werk-UID` on POSIX or `%LOCALAPPDATA%\werk\run` on Windows. The CLI's
`--runtime-dir` takes precedence. `XDG_RUNTIME_DIR` and `TMPDIR` do not select
the default: their cleanup can remove the endpoint while a detached session
still runs. Library callers continue to pass explicit runtime and state paths.
Before startup, the client checks the Unix socket's 103-byte path limit and
requires an existing POSIX runtime directory to be owned by the current user
with mode `0700`. It refuses symlink directories, untrusted endpoint records,
and Unix sockets with another owner or public permissions.

`serveSessionDaemon` locks `$stateDir/daemon.lock`, so at most one daemon runs
per state directory whatever runtime directory it is given. Where the state
directory cannot hold a lock at all, which the daemon detects by taking and
releasing one on a probe file first, it falls back to `$runtimeDir/daemon.lock`
and logs the fallback with `lock.acquired`. The guarantee then narrows to one
daemon per runtime directory: two daemons sharing only a state directory become
possible again, and the record below is what keeps them apart.

The daemon writes `$stateDir/daemon.json` with its pid, a `bootId`, the runtime
directory, the endpoint, the version and its start time, and removes it on
close. `bootId` is the kernel's boot identifier on Linux and the derived boot
instant elsewhere, so a record left behind by a machine that has since rebooted
is not read as a live daemon. `ensureSessionDaemon` reads the record when its
probe fails: where the recorded pid is alive under this boot, is owned by the
current user, and started when the record says it did, it sends `SIGUSR1`,
waits for the endpoint to come back and never spawns a second daemon, reporting
`Daemon <pid> is alive but its endpoint is missing` if it does not. The start
time comes from `/proc/<pid>` on Linux and from `ps` on macOS. Windows reports
none, so there the pid and the boot identifier are the whole guard and the
`SIGUSR1` request is never sent.

Every five seconds, and immediately on `SIGUSR1`, the daemon compares its
socket's inode with the one it bound and recreates whatever has gone: the
runtime directory, the socket, `endpoint.json` and the lock file. Running
sessions and established connections are unaffected, and losing the endpoint
never ends the daemon, because it owns live PTYs. Windows has no `SIGUSR1`, so
there the periodic check carries the recovery on its own, and the value
`serveSessionDaemon` returns carries `supervise()` for a consumer that wants to
run one check itself. The socket is bound under a private temporary name and
renamed into place, so a client reading the endpoint record never finds one that
is still world-accessible. On POSIX the daemon also holds a shared `flock` on
the runtime directory and touches its files hourly; tmpfiles.d(5) states that the
aging algorithm skips a directory on which a lock is already taken.

A kernel file handle on Windows and `flock` on POSIX keep the lock exclusive
across crashes. POSIX `flock` comes through `bun:ffi`, which tries
`libSystem.B.dylib` then `libc.dylib` on macOS and `libc.so.6`, `libc.so` then
`libc.musl-<arch>.so.1` on Linux; musl's loader resolves any `libc.*` name to
itself, so the first name already works on Alpine. Where no libc can be opened,
Linux falls back to holding an abstract unix socket named from a hash of the
lock path. That fallback is scoped to the network namespace rather than the
filesystem, so two containers sharing a state directory but not a namespace
would both acquire it, and an abstract name carries no owner and no permission
bits: the name follows from the lock path, and any process in the same namespace
that binds it first leaves the daemon reading its own bind failure as "Daemon
already running" and declining to start. The name is only ever a mutex, so
nothing is carried over it. `flock`, which holds wherever a libc can be opened,
is bounded by the lock file's ownership and mode instead. The daemon logs
`lock.acquired` with the mechanism that holds it, and `werk info` reports the
mechanism it would use as `lockMechanism`.

Windows local endpoints bind only to 127.0.0.1 and require a random per-start
credential; `ensureSessionDaemon` supplies it automatically. Direct clients must
pass the TCP endpoint's credential to `connectSessionClient`. Runtime and state
directories receive a current-user-only Windows ACL.

## Authority

The accepting consumer supplies authentication and an `authorize` callback.
Without that callback all connections have owner authority; local sockets are
inside a directory restricted to the current user. A bridge must provide its
own authenticated principal and grants. A grant callback returns false to deny
an operation, true to allow it, or a permissions object for attachment grants.

## Queues and scheduling

Each attachment has one ordered stream on its connection, holding frames the
daemon encoded once. Only output is droppable. When a connection's
`limits.outputQueueBytes` (256 KiB) is exceeded, the stream with the largest
output backlog loses that backlog and gets a resync placeholder that reserves
its stream position at once and is snapshotted only when it reaches the head, so
a viewer that cannot keep up pays for one snapshot rather than one per event. A
resize also invalidates, because the pinned engine can reflow a restored wrapped
line differently from a replica. Nothing else does: effects, exits and
size-holder changes ride the stream as control frames.
`limits.resyncIntervalMs` (250 ms) is the minimum spacing between resyncs on one
stream, which bounds what a persistently slow viewer costs when each snapshot is
hundreds of kilobytes. Streams are served round-robin after the connection's
control queue, `ended` is always delivered, and requests are processed serially
per connection.

`controlQueueMessages` defaults to 8,192, which holds a second of coalesced
notifications for a fleet of the default 128 sessions; the byte limit is the
bound that matters, and the message count only keeps a stalled watcher from
accumulating an unbounded number of very small frames. Control queue exhaustion
disconnects the connection.

`limits.sessions` (128) bounds live processes and in-flight creates, so a
retained record never refuses a new session. `limits.retainedSessions` (512)
bounds exited, failed and lost records: passing it evicts the oldest through the
same path as `remove`, which deletes the state file, disposes the terminal and
notifies `removed`. Startup keeps as many retained files as the cap allows and
leaves the rest on disk untouched, so eviction only ever drops records this
daemon holds. Consumers that want to keep a saved screen copy the checkpoint
file or call `remove` themselves; eviction is the backstop.

`activity` and `effect` are the only watch events a busy session produces
without bound, one of each per chunk of output. They coalesce per session and
per kind: the first goes out on the leading edge, then at most one more of that
kind per `limits.notifyIntervalMs` (250 ms), the latest payload winning.
Repeated effects of one kind within a window are therefore not counted, and a
pending notification is drained before a state change, so nothing trails
`exited`. Attachment streams are unaffected: an attachment receives every
effect. `publicInfo` is computed once per event rather than once per watcher. An
`authorize` callback that refuses hides the event from that watcher; one that
throws anything else is recorded as `notify.internal` and the event still
reaches every other watcher.

## Size ownership

At most one attachment holds a session's size, and no attachment need hold it.
`attach` takes `holdSize`: `never` never takes it and is never a successor,
`if-free` takes it when nobody holds it, `claim` also takes it from the current
holder. The default is `if-free` where the granted permissions include input
and `never` otherwise, so a watcher does not capture the size of a session
someone else is typing into. Taking the size from a holder, whether through
`claim` at attach or the `claimSize` request afterwards, needs input and the
`claimSize` action from the grant callback. Taking a free size is not a
takeover and the callback does not see it, though the `claimSize` request
itself is refused without input. A callback written as an allowlist refuses
`claimSize` by construction, and an attach that asked to claim then attaches
without the size rather than failing. A holder that leaves passes the size to an
input-capable attachment, then to one that asked to claim, then to the most
recent, ignoring attachments that asked for `never`; where nobody qualifies the
size becomes free. `transferSize` refuses a recipient that asked for `never`.

## Preview tiles

`preview` attachments are scheduled per record rather than per viewer. A record
formats its active screen once per interval for each distinct format its tiles
asked for, and encodes that text for each of them, so twenty tiles on one
session cost one formatter call per interval rather than twenty. A record with
no preview viewer arms no timer, and a frame goes out only after the screen
changes, which means output or a resize. `limits.previewIntervalMs` (500 ms) is
the default rate, clamped by `limits.previewMinIntervalMs` (250 ms) and
`limits.previewMaxIntervalMs` (5,000 ms); a record ticks as fast as its most
impatient tile asked for. Preview viewers are outside the output broadcast and
the resync machinery, so a tile never costs a snapshot, and its queued frame is
overwritten where it stands when a newer one arrives rather than accumulating
behind a slow connection. Attaching with `preview` to an engine that cannot
format a screen is refused with `UNSUPPORTED`. Measured on one Linux machine at
120x40, a text frame costs about 0.11 ms and 6.7 KB against about 0.53 ms and
287 KB for a snapshot of the same screen, so twenty busy tiles at 500 ms are
about 6 ms of daemon CPU and 240 KB/s.

## Scrollback, checkpoints and restore

`limits.scrollbackMaxBytes` (10,000,000) bounds the page-memory budget a
session's scrollback may have. The daemon always passes an explicit budget to
the engine, so a session never runs on the engine's own default; a `create`
without `scrollbackBytes` takes the cap, one above it is refused with `LIMIT`
rather than clamped, and the value the session got is on `SessionInfo`. The cap
is advertised as `capabilities.scrollbackMaxBytes`. Bytes here are page memory
rather than text, and the engine retains whole pages: at the default cap and
120 columns that is roughly 9,200 rows, a snapshot of about 0.7 MB and about
12 MB of engine memory per session that has filled it. Nothing bounds the sum
across sessions.

A record is written when it has something new to save: output, a resize, an
effect, a state change, and once more when its process exits.
`limits.checkpointIntervalMs` (5 s) is how often the daemon looks rather than
how often it writes, and shutdown saves only what has changed since the last
write. A record restored from disk, a `lost` one included, has nothing new to
say, so its file stays as it was recovered until something writes to it again.
The `checkpoint` watch event therefore follows a file that was written and
reports change rather than daemon liveness; a write that fails leaves the
record owing one, and the next look retries it.

Checkpoints retain metadata and versioned snapshots; recovery never restores a
live process. Startup validates a saved snapshot's header — engine build,
snapshot format, non-empty bytes within `checkpointMaxBytes` — instead of
decoding it, and `checkpoint.decodable` reports that check, so a daemon holding
hundreds of retained records builds a terminal for none of them: 128 records at
the default cap start in about 0.2 s and 120 MB rather than about 11 s and
1.6 GB (one Linux machine, Bun 1.3.14). A record's screen is decoded the first
time something needs it in the daemon: `readScreen` and `readHistory` restore
on demand, and so does attaching a `preview` tile, whose text the daemon
formats itself. An attachment that replicates the terminal is sent the
checkpoint bytes as its snapshot and decodes them on the client, so it costs
the daemon nothing. Where the header passes and the bytes do not, the record
records the failure, refuses further attachments with `UNSUPPORTED` and keeps
the bytes rather than overwriting them. Restoring applies the record's own
`scrollbackBytes` capped by the current `limits.scrollbackMaxBytes`, so a cap
lowered between runs prunes the oldest pages as the screen comes back.

A record with no live process gives its terminal back once its screen is safely
on disk and nothing has read it for `limits.terminalIdleMs` (60 s); the next
read decodes the checkpoint again. A record whose checkpoint is missing or
undecodable keeps its terminal, because it is then the only copy of the screen,
and so does one a tile or an attachment is still reading.

Attaching to a record with no live process registers no viewer: the attachment
queues the saved screen, the recorded exit when there is one, and `ended`, and
counts against the attachment limit only while it is being delivered. Input and
resize on a record with no live process are refused as `CONFLICT`, so a saved
screen is never reflowed after the process that produced it has gone.
Unreadable checkpoints are preserved. Snapshot decode failures remain visible
in retained session listings.

## Logging

`createLogger({ file, level, maxBytes, keep })` writes
`time LEVEL event key=value` lines, rotating at 5 MB and keeping three files by
default, and `parseLogLevel` validates `error`, `warn`, `info` and `debug`.
`DaemonConfig.log` takes any `Logger`; the default is `silentLogger`, so a
library embedder logs nothing until it asks to. Events come from a fixed
vocabulary covering startup and shutdown, the lock, the endpoint and runtime
directory, connections, session lifecycle and eviction, checkpoints, previews,
attachments, request failures and uncaught errors. Environment values, input
bytes, credentials and full argv are never written above `debug`. A write that
fails closes the file and the next line reopens it, so logging never propagates
an error into the daemon.

`installDaemonErrorHandlers` is the CLI's process policy rather than the
library's: it logs an `unhandledRejection` and continues, and on an
`uncaughtException` logs, checkpoints and continues, closing the daemon and
exiting after ten in a minute. An embedder chooses whether to install it.

`inspectSessionDaemon({ runtimeDir, stateDir, doctor })` reports the resolved
paths, the lock mechanism it would use, the recorded pid and `bootId`, and the
daemon's own identity and capabilities when one answers. With `doctor` it adds
runtime-directory ownership and mode, state-directory writability and free
space, whether the lock is held and by which mechanism, `TERM` and terminfo
availability, and the last twenty log lines with the most recent `ERROR` line.
A startup that times out carries that last error line into its own message, so
a daemon that died on an over-long socket path says so.

## Platform support

Native Linux and macOS use Bun PTYs, foreground Ctrl-C, and descendant process
and job-control group termination. Linux and macOS report cached process-tree
summaries. Windows x64 uses Bun 1.3.14 inline ConPTY, Ctrl-C, and a Job Object
with kill-on-close ownership; both terminate and force end the job. Windows
ARM64 hosting is explicitly unsupported because the required Bun FFI is
unavailable. Capabilities expose those differences.

Windows job adoption follows Bun spawn synchronously, but Bun's terminal API
does not expose suspended creation: a very fast child can start a descendant
before adoption. On macOS, a descendant that has already reparented cannot
always be attributed to its original shell. These are process-tree containment
limits, not security isolation guarantees. Explicit daemon shutdown ends owned
processes; this package does not promise survival across daemon replacement,
complete output retention or a CPU/OOM isolation boundary.

## Environment

Local startup uses `/` as the daemon's working directory (the home directory
on Windows) and passes only `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`,
`TMPDIR`, `XDG_RUNTIME_DIR`, `XDG_STATE_HOME`, `WERK_*` configuration and Windows
system/profile variables. Session requests carrying `env` use the minimal base
and the caller's values, with werk's terminal identity applied last. Requests
without `env` inherit the daemon's environment with its `WERK_*`, `LINES` and
`COLUMNS` removed. See `@werk/session` for environment bounds and owned values.

## Tests

Run `bun test packages/session-daemon/test` from the workspace for native and
hardening checks. Native fixtures cover PTY input/resize/exit, exclusive ownership,
detached descendant termination, POSIX foreground interruption, and Windows
job cleanup after abrupt owner death and TCP credential refusal. Linux execution
is verified locally; Windows and macOS require their native CI runners.
