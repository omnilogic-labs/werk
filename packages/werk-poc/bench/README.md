# bench

The `wp bench` measurements from the proposal, §6: the differential corpus
(`wp bench diff`), the performance axis (`wp bench perf`), the operational
axis (`wp bench ops`) and the soak (`wp bench soak`). M0's latency probe
lives in `../spikes/m0/`; `perf` re-runs its bare-PTY path for a same-run
baseline.

| Path                   | What it is                                                                                                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `differential.ts`      | The runner: every corpus case into `ghostty-wasm`, `ghostty-ffi` and `xterm-oracle`; plainText, styledCells and effects compared pairwise; reattach strategies; fuzz    |
| `perf.ts`              | VT throughput per engine, relay latency through the real daemon, snapshot cost, daemon RSS for 1/10/50 sessions and across churn, the slow client, wasm trap isolation  |
| `ops.ts`               | Toolchain, platform matrix, `bun build --compile` survival and binary size per engine set (compiled into `../dist/bench-ops/`), cold start of `wp ls` and `wp __daemon` |
| `soak.ts`              | Twenty sessions on a daemon of its own, sampled to a JSONL file every interval; `--report` summarises a log; `_lib.ts` holds what the three runners share               |
| `bench.test.ts`        | One smoke case per runner at tiny parameters; the real numbers are in `../findings/m6.md`                                                                               |
| `cast.ts`              | asciicast v2 read/write, plus a `"b"` event for a chunk that is not valid UTF-8                                                                                         |
| `corpus/`              | The cases, one `.cast` each, and `index.ts`, the manifest the runner reads                                                                                              |
| `generate.ts`          | Writes the synthetic cases; `bun run bench/generate.ts` after changing one                                                                                              |
| `record.ts`            | Records a real program under `Bun.Terminal` into a `.cast`, with scripted input                                                                                         |
| `record-all.sh`        | The recorded cases, re-recordable                                                                                                                                       |
| `differential.test.ts` | A smoke case; the full run is `wp bench diff`                                                                                                                           |

## Running it

```console
$ bun run bench/differential.ts                    # every case, no fuzz
$ bun run bench/differential.ts --fuzz 50           # plus 50 iterations of each fuzz mode
$ bun run bench/differential.ts reattach unicode    # cases whose name contains either
$ bun run bench/differential.ts zzz --fuzz 200 --seed 3   # fuzz only (no case matches "zzz")
$ ./dist/wp bench diff --fuzz 50                    # the same from the compiled binary
```

Output is one block per case with each pair's verdict and, for a
disagreement, the first few differing rows, cells or effects, then the
summary tables. Nothing is scored: a differing pair is a finding for a
human to attribute, and `findings/m6.md` records the attributions.

The other three:

```console
$ bun run bench/perf.ts                          # every section; ~3 min
$ bun run bench/perf.ts --only throughput,trap   # a subset; --json for the numbers
$ bun run bench/ops.ts                           # compiles five binaries into dist/bench-ops/; ~2 min
$ bun run bench/ops.ts --no-compile              # report on the binaries an earlier run left
$ bun run bench/soak.ts --duration 24h --out soak.jsonl --interval 60s
$ bun run bench/soak.ts --report soak.jsonl      # the summary from a log, any time
```

`--quick` on any of them is what the smoke test uses: tiny parameters, no
compiles. Every daemon these start lives on a temporary directory and is
shut down at the end; `pgrep -af __daemon` should be empty afterwards. The
soak writes the daemon's own log next to its JSONL as `<name>.daemon.log`.

## What is compared, and what is not

- **plainText**: the viewport, trailing whitespace trimmed, wide characters
  once. The oracle's own trim only drops never-written cells, so the
  adapter trims whitespace too.
- **styledCells**: text, fg, bg, bold/italic/underline/inverse/strikethrough,
  width. A never-written cell and a written plain space count as the same
  cell (`"" versus " "`), reported as a count rather than a difference; a
  re-emission necessarily writes spaces.
- **effects**: title, pwd, bell, progress, notification and write-pty
  replies, in order. Identity replies (DA1, DA2, XTVERSION) are listed but
  not counted — two emulators name themselves differently by design. The
  oracle's `other` marks (OSC 133) are not counted either.
- **reattach** cases end with a resize event. Each engine restores a copy
  from the source three ways — re-emit then resize both, resize the
  source then re-emit at the new size, and state transfer then resize
  both — and the copy is compared with the source after the resize:
  `exact`, `padding` (only `"" versus " "` cells differ), `differs`, or
  `unsupported`.
- **fuzz**: random bytes and random valid sequences from a seeded PRNG,
  each fed in four random pieces; plainText agreement per pair, cells
  agreement per pair, and per engine whether the pieces read the same as
  the whole (split invariance).
