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

The accepting consumer supplies authentication and an `authorize` callback.
Without that callback all connections have owner authority; local sockets are
inside a directory restricted to the current user. A bridge must provide its
own authenticated principal and grants. A grant callback returns false to deny
an operation, true to allow it, or a permissions object for attachment grants.

Limits bound sessions, attachments, queued output and control messages. Slow
viewers receive replacement snapshots; control queue exhaustion disconnects the
connection. Requests are processed serially per connection. Checkpoints retain
metadata and versioned snapshots; recovery never restores a live process.
Unreadable checkpoints are preserved. Snapshot decode failures remain visible
in retained session listings.

Native Linux and macOS use Bun PTYs, foreground Ctrl-C, and descendant process
and job-control group termination. Linux and macOS report cached process-tree
summaries. Windows x64 uses Bun 1.3.14 inline ConPTY, Ctrl-C, and a Job Object
with kill-on-close ownership; both terminate and force end the job. Windows
ARM64 hosting is explicitly unsupported because the required Bun FFI is
unavailable. Capabilities expose those differences.

Windows local endpoints bind only to 127.0.0.1 and require a random per-start
credential; `ensureSessionDaemon` supplies it automatically. Direct clients must
pass the TCP endpoint's credential to `connectSessionClient`. Runtime and state
directories receive a current-user-only Windows ACL. A kernel file handle on
Windows and flock on POSIX keep launcher ownership exclusive across crashes.

Windows job adoption follows Bun spawn synchronously, but Bun's terminal API
does not expose suspended creation: a very fast child can start a descendant
before adoption. On macOS, a descendant that has already reparented cannot
always be attributed to its original shell. These are process-tree containment
limits, not security isolation guarantees. Explicit daemon shutdown ends owned
processes; this package does not promise survival across daemon replacement,
complete output retention or a CPU/OOM isolation boundary.

Run `bun test packages/session-daemon/test` from the workspace for native and
contract checks. Native fixtures cover PTY input/resize/exit, exclusive ownership,
detached descendant termination, POSIX foreground interruption, and Windows
job cleanup after abrupt owner death and TCP credential refusal. Linux execution
is verified locally; Windows and macOS require their native CI runners.
