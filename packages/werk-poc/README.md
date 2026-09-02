# werk-poc

The proof of concept described in
[`docs/proposals/00-stack-proof-of-concept.md`](../../docs/proposals/00-stack-proof-of-concept.md):
a detachable process runner for the local machine, built to find out whether
TypeScript on Bun reaching libghostty-vt holds up as the foundation for werk.

This is **reference material, not product code**. The package name and the
`wp` binary name are disposable, and nothing here is meant to be migrated into
the product directly. What matters is what is written down in `findings/`.

## Layout

| Path            | What it is                                                      |
| --------------- | --------------------------------------------------------------- |
| `src/engine/`   | The terminal-engine seam and its adapters (M1, M6)              |
| `src/protocol/` | The framed wire protocol the daemon, client and web share (M2)  |
| `src/daemon/`   | The daemon: PTYs, the socket, client queues, snapshots (M2, M3) |
| `src/client/`   | The programmatic client library the CLI and web build on (M2)   |
| `src/cli/`      | The `wp` entry point and its commands                           |
| `src/web/`      | `wp serve`: the loopback web UI and the browser bundle (M4)     |
| `spikes/m0/`    | M0's smoke probes, one file per question, plus a runner         |
| `spikes/m1/`    | M1's compiled-binary check for the embedded WASM                |
| `spikes/m2/`    | M2's reattach-fidelity harness: the compiled `wp` in a PTY      |
| `spikes/m3/`    | M3's cross-commit decode, snapshot cost, and fd-reuse probes    |
| `bench/`        | The `wp bench` measurements (M6)                                |
| `findings/m4/`  | Screenshots from M4's browser check                             |
| `vendor/`       | Pinned upstream artifacts (libghostty WASM, `ghostty-web`)      |
| `findings/`     | What each milestone found, one file per milestone               |

## Running things

From the repo root, `bun install` once. Then, in this directory:

```console
$ bun run typecheck          # tsc --noEmit
$ bun run test               # bun test
$ bun run build:web          # the browser bundle -> src/web/bundle/app.js
$ bun run build              # build:web, then bun build --compile -> dist/wp
$ bun run m0                 # run every M0 probe, interpreted and compiled
$ bun run m0 -- --bun /path/to/other/bun   # the same under another Bun
$ bun run m2                 # the reattach-fidelity scenarios, as a table
$ bun run m3                 # snapshot cost and cross-commit decode tables
```

And the program itself, once built:

```console
$ ./dist/wp run -- claude    # spawn under a PTY in the daemon and attach; ctrl-\ detaches
$ ./dist/wp ls
$ ./dist/wp attach <id>
$ ./dist/wp logs <id>
$ ./dist/wp kill <id>
$ ./dist/wp serve            # loopback web UI; prints a URL with a one-time token
```

The daemon autostarts in `$XDG_RUNTIME_DIR/werk-poc` on the first `run` or
`ls`, and keeps a snapshot of every session in `$XDG_STATE_HOME/werk-poc`
(`~/.local/state/werk-poc`), written every 30 s and on exit; after a
restart those come back as read-only `corpse` sessions in `ls`. Set
`WP_STATE_DIR` and `WP_SNAPSHOT_INTERVAL_MS` in the environment of whatever
starts the daemon to move or speed that up.

Each probe under `spikes/m0/` also runs on its own with
`bun run spikes/m0/<probe>.ts`, and compiles with
`bun build --compile spikes/m0/<probe>.ts --outfile <out>`.
