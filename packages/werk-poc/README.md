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
| `src/web/`      | The `wp serve` page (M4)                                        |
| `spikes/m0/`    | M0's smoke probes, one file per question, plus a runner         |
| `spikes/m1/`    | M1's compiled-binary check for the embedded WASM                |
| `bench/`        | The `wp bench` measurements (M6)                                |
| `vendor/`       | Pinned upstream artifacts (libghostty WASM, `ghostty-web`)      |
| `findings/`     | What each milestone found, one file per milestone               |

## Running things

From the repo root, `bun install` once. Then, in this directory:

```console
$ bun run typecheck          # tsc --noEmit
$ bun run test               # bun test
$ bun run build              # bun build --compile -> dist/wp
$ bun run m0                 # run every M0 probe, interpreted and compiled
$ bun run m0 -- --bun /path/to/other/bun   # the same under another Bun
```

Each probe under `spikes/m0/` also runs on its own with
`bun run spikes/m0/<probe>.ts`, and compiles with
`bun build --compile spikes/m0/<probe>.ts --outfile <out>`.
