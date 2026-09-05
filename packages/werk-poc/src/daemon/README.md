# daemon

The one-process, many-sessions daemon: PTY ownership, the Unix socket, the
per-client bounded queues, and the lifecycle that starts and finds it. Half of
M2 (the CLI's interactive commands are the other half).

## What is here

| File            | What it is                                                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `paths.ts`      | Where the socket, lock and log live (`$XDG_RUNTIME_DIR/werk-poc`), the snapshot directory (`$XDG_STATE_HOME/werk-poc`), and the 0700 owner check. |
| `launch.ts`     | Autostart: `spawnDaemon` (detached, best-effort readiness report) and `ensureDaemon` (connect, or start and wait).                                |
| `main.ts`       | The `wp __daemon` role: take the lock, start the server, report readiness, run until shutdown.                                                    |
| `server.ts`     | The socket: accept, the `hello` handshake, dispatch control messages to sessions.                                                                 |
| `connection.ts` | One client connection and its bounded outbound queue (the §4 lagging-client rule).                                                                |
| `session.ts`    | One child under a PTY, its `VtTerminal` tap, attach/detach, re-emission on attach; or a corpse restored from a snapshot with no child at all.     |
| `snapshot.ts`   | The snapshot file: a JSON header line then the `GHOSTSNP` bytes, written by temp-and-rename, read back at start.                                  |

Everything the daemon does differently per operating system — the lock, the
default directories, spawning and readiness, the socket's stale-file and mode
handling, `SO_SNDBUF`, liveness, RSS, which signals exist — is in
[`../platform/`](../platform), once for POSIX and once for Windows. Nothing in
this directory reads `process.platform`.

The programmatic client that drives all of this is in [`../client/`](../client);
the wire protocol they share is in [`../protocol/`](../protocol); the
interactive commands on top are in [`../cli/`](../cli).

## Lifecycle, as [`04-daemon-best-practices.md`](../../../../docs/research/04-daemon-best-practices.md) asks

- **Lock before bind.** `platform.lock()` on `wp.lock` —
  `flock(LOCK_EX|LOCK_NB)` on a POSIX system, `LockFileEx` or an exclusive
  named pipe on Windows; the loser of a race skips to connecting. The kernel
  drops the lock when the holder dies, so there is no stale-lock cleanup.
- **Bind atomically.** The server binds a temp socket name in the same
  directory and `rename`s it onto `wp.sock`; the rename replaces a stale socket
  from a dead daemon without a separate unlink.
- **Readiness best-effort, the socket authoritative.** On a POSIX system the
  launcher spawns the daemon with `stdio: ["ignore","ignore","ignore","pipe"]`
  and the daemon writes `ready\n` (or an error line) to fd 3 and closes it; on
  Windows it names a file the daemon writes and the launcher polls, because
  the parent's end of that pipe cannot be read there. Either way a successful
  `hello` over the socket is the authority (see the finding in
  `../../findings/m2.md`).
- **No PID file, no signals for control.** `ls`, `kill`, `detach`, `shutdown`
  are all socket round-trips. Where signals reach a detached daemon —
  `SIGTERM`/`SIGINT`/`SIGHUP` on a POSIX system, none on Windows — they
  trigger the same graceful shutdown: every session is snapshotted to the
  state directory, then the children are killed and the process exits.
- **Snapshot on a timer, restore on start.** Every 30 s each new session, or
  session whose output or size has changed since its last successful snapshot,
  is encoded and written. Failed writes are logged and retried on later ticks;
  a session is written once more when its child exits. On start every file
  in the state directory becomes a read-only `corpse` session, decoded in
  two stages (`ready()`, then history), or listed undecoded when its
  libghostty commit is not this daemon's. `kill --rm` deletes the file.

## Running one by hand

The daemon is normally started by the client library, never typed. To drive it
directly:

```console
$ bun run ../cli/main.ts __daemon --dir=/tmp/werk-poc-dev   # foreground, blocks
$ WP_DIR=... bun run ../cli/main.ts ls                       # from another shell
```

`--dir` overrides the runtime directory; `--ready-fd=<n>` names the readiness
pipe (the launcher passes both). `--state-dir` and `--snapshot-interval=<ms>`
override the snapshot directory and timer, as do `WP_STATE_DIR` and
`WP_SNAPSHOT_INTERVAL_MS` in the environment, which is how the tests keep
their daemons out of the real state directory. With none of them, it uses
the default directories and reports nothing.
