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
| `spikes/m5/`    | M5's transport spike: the daemon in a container behind `ssh -L` |
| `spikes/m6/`    | M6's compiled-binary check for the ffi binding and the oracle   |
| `bench/`        | `wp bench`: the differential corpus, perf, ops and soak runners |
| `findings/m4/`  | Screenshots from M4's browser check                             |
| `vendor/`       | Pinned upstream artifacts (libghostty WASM, `ghostty-web`)      |
| `findings/`     | What each milestone found, one file per milestone               |

## Running things on macOS and Windows

The same suites run on hosted runners, on demand rather than on every commit.
Add the `ci:poc` label to a pull request, or start it by hand:

```console
$ gh workflow run poc.yml --ref <branch> -f os=all   # or ubuntu, macos, windows
$ gh run download <id> -n ci-result-macos            # what each suite recorded, as JSON
```

Removing and re-adding the label runs it again. `.github/workflows/vt-win32.yml`
is the separate probe for the vendored win32 `libghostty-vt`, on the same
trigger. What the runs found is in [findings/platforms.md](./findings/platforms.md).

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
$ bun run m5 -- --rtt 0,50,200   # the transport spike; needs Docker, ~6 min
$ bun run bench/differential.ts --fuzz 50   # the differential corpus, all three engines
$ bun run bench/perf.ts                     # throughput, latency, snapshot, memory, slow client, trap
$ bun run bench/ops.ts                      # toolchain, platforms, --compile survival, size, cold start
$ bun run bench/soak.ts --duration 30m --out soak.jsonl   # the soak; --report soak.jsonl summarises later
```

And the program itself, once built:

```console
$ ./dist/wp run -- claude    # spawn under a PTY in the daemon and attach; ctrl-\ detaches
$ ./dist/wp run --engine=ghostty-ffi -- claude   # the same on the ffi engine
$ ./dist/wp caps             # the capability matrix, one column per engine
$ ./dist/wp bench diff       # the differential corpus
$ ./dist/wp bench perf       # the performance axis; --json for the numbers
$ ./dist/wp bench ops        # the operational axis
$ ./dist/wp bench soak --duration 24h --out soak.jsonl   # the soak, on temp dirs
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
starts the daemon to move or speed that up. `--socket <path>` on any command
(or `WP_SOCKET`) talks to the daemon behind that socket instead — one forwarded
from another machine with `ssh -N -L <local>:<remote> host`, say — and never
starts one.

Each probe under `spikes/m0/` also runs on its own with
`bun run spikes/m0/<probe>.ts`, and compiles with
`bun build --compile spikes/m0/<probe>.ts --outfile <out>`.
