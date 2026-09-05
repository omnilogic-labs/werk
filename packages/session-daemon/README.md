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

Native POSIX PTYs and group termination are implemented. Windows hosting and
richer process-tree inspection are follow-up work; capabilities report the
available operations. This package does not promise survival across daemon
replacement, complete output retention or a CPU/OOM isolation boundary.
