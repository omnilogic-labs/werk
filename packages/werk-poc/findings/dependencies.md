# dependencies

What the proof of concept takes from npm, why each package is there, and what
the ecosystem turned out to hold when the question "should this be a
dependency" was put to it component by component.

The PoC is mostly hand-written. That is a result rather than a preference:
each component was checked against what is actually published before it was
written, and most of them came back with nothing that fits. This file records
both halves — the nine runtime packages and what they do that is not obvious
from their names, and the searches that found nothing, which are the more
useful half because they say where the ecosystem stops.

Nothing here is a decision about what werk depends on. A package that fits the
PoC may not fit a product, and a gap in what is published today is a gap
today. The versions and the issue numbers below were checked on 3 September 2026.

## What the proof of concept depends on

Nine runtime packages. `package.json` gives every one a caret range except
`@xterm/headless`, which asks for the major; the versions below are what those
ranges resolve to.

| Package                  | Version | Licence    | Where                                 | Why                                                           |
| ------------------------ | ------- | ---------- | ------------------------------------- | ------------------------------------------------------------- |
| `libghostty-vt`          | 0.6.3   | Apache-2.0 | the engine                            | the pinned VT artifact                                        |
| `@xterm/headless`        | 6.0.0   | MIT        | `src/engine/xterm-oracle/`            | the differential oracle — the only maintained second emulator |
| `@xterm/addon-serialize` | 0.14.0  | MIT        | the same                              | reads the oracle's screen back out                            |
| `@xterm/addon-unicode11` | 0.9.0   | MIT        | the same                              | width rules the other two engines already apply               |
| `atomically`             | 2.1.1   | MIT        | `src/daemon/snapshot.ts`              | commits a snapshot with a rename that retries                 |
| `escape-html`            | 1.0.3   | MIT        | `src/web/pages.ts`                    | HTML escaping for the two served pages                        |
| `@wterm/core`            | 0.4.1   | Apache-2.0 | `src/web/client/renderer-wterm.ts`    | one of the four browser renderers                             |
| `@wterm/dom`             | 0.4.1   | Apache-2.0 | the same                              | the same                                                      |
| `@beamterm/renderer`     | 1.0.0   | MIT        | `src/web/client/renderer-beamterm.ts` | one of the four browser renderers                             |

Development dependencies are `fast-check` 4.9.0 (MIT), which does the fuzz
harness's shrinking, plus `typescript`, `bun-types` and `@types/escape-html`.

Three more things the PoC leans on are built into Bun and cost nothing:
`util.parseArgs` from `node:util` parses `wp`'s arguments,
`Bun.serve({ routes })` routes the web server, and `monitorEventLoopDelay`
from `node:perf_hooks` measures the daemon's event-loop lag. Each has a rough
edge worth recording.

## What each one is doing

### `util.parseArgs`, and the `--` boundary

The awkward requirement is that a child's flags survive
`wp run -- claude --dangerously-skip-permissions` untouched. With
`tokens: true`, `parseArgs` emits an `option-terminator` token carrying the
index of the `--`, so the boundary is recoverable from the original `argv`
rather than from `positionals`, which would reorder the child's flags.
`strict: false` is load-bearing too: it is what lets undeclared flags through
as booleans, which is what the CLI wants.

One rough edge: `parseArgs` intercepts single-dash tokens as short options
even where no short alias is declared anywhere, so `src/cli/main.ts`
reclassifies those back to positionals. `wp` documents no single-dash flags
except a top-level `-h`, which is handled before parsing.

### `Bun.serve({ routes })`

Declarative routing works on the pinned 1.3.14, including a WebSocket upgrade
from inside a route handler. Two things about it matter.

A matched route runs _instead of_ the `fetch` handler, so the one-time-token
and cookie gate is applied inside every route rather than wrapped around them.
A gate that lived only in `fetch` would leave every route reachable.

And `Bun.serve<SocketData>` with only the first type parameter given makes
TypeScript unable to infer the router's path type, which silently degrades
every handler's `req` to an implicit `any`. Spelling out the route-path union
as the second parameter is what fixes it.

Route parameters reproduce `decodeURIComponent` exactly for percent-escapes,
including `%2F`, unicode, `+` and `%25`; they diverge only for a literal
unescaped `/` inside an id, which cannot occur here because session ids are
daemon-issued hex. Hono and Elysia both run under Bun, and at this size
neither adds anything the router does not already do.

### `monitorEventLoopDelay` returns a singleton

It samples from a separate native thread, so it does not use the loop it is
measuring — which a timer measuring its own lateness necessarily does. The
sampler runs inside the daemon, because the daemon's loop is what the soak
stresses.

The trap, worth recording for anyone else reaching for this API under Bun: it
returns a singleton. Two calls give literally the same object, and `reset()`
on one zeroes the other. So a design with one histogram for the rolling window
and a second for the whole run silently reports the same numbers for both. One
histogram, reset per reporting window, with the run-wide totals carried
forward beside it, is what works — and run-wide percentiles are not
recoverable that way, only run-wide count and maximum.

### `atomically`

A snapshot commits by writing a temp file and renaming it over the target. A
bare rename has no retry, and on Windows a virus scanner or a search indexer
holding the target makes that rename fail transiently. `atomically`'s
`stubborn-fs` layer retries every call, `rename` included, on `EPERM`,
`EBUSY`, `EACCES` and `EMFILE` with backoff. `write-file-atomic`, the obvious
alternative, does not retry rename and has an open issue about exactly this.

Its mode and fsync options are passed explicitly rather than taken as
defaults, because the default mode is `0o666` where the snapshot is `0o600`.

### `escape-html`

Byte-identical output to a six-line hand-written escape, checked over 803
inputs: every ASCII character, all permutations of the five escaped
characters, astral emoji, combining marks, CJK, right-to-left text and 500
seeded random Unicode strings, with no mismatch. `he` and `stringify-entities`
are the wrong tool here — both escape non-ASCII by default, which would mangle
UTF-8 output.

The package is `export =` CommonJS, and under this project's
`verbatimModuleSyntax` every ESM import form is rejected, so `src/web/pages.ts`
reaches it through `createRequire`.

### `fast-check`

It closes a gap rather than saving lines. When two engines disagree, what the
corpus can report on its own is the full-length random input that triggered
it; property-based shrinking reduces that to a minimal case with a replayable
seed and path, which is what a differential corpus is for — handing a person
something they can read.

The hand-written mulberry32 generator stays and still decides where each write
is cut, re-seeded per input so a case cuts identically whether it was reached
by sampling or by shrinking. The arbitraries keep the original length ranges
and branch weights, so the distribution the fuzz explores is unchanged; the
floor of 200 bytes means a shrunk case bottoms out there rather than at a
single byte.

A shrink search is capped at two seconds per mode, because bytes-mode fuzzing
disagrees on essentially every run — the DEL-handling gap
[m6.md](./m6.md#the-differential-corpus) records — so shrinking is a steady
cost rather than a rare tail. A 200-iteration run goes from about 6.1 s to
about 9.9 s with it.

## What the ecosystem turned out not to hold

Roughly 85% of the PoC's hand-written code came back with no credible
replacement when checked against npm, and the parts with the least competition
are the parts closest to what werk is for. Each of these is a finding about
what is published, not a position on what werk should do.

**`proper-lockfile` is not kernel locking.** It is `mkdir` plus an mtime
heuristic. It cannot release a lock when the holder dies, which is the
property `src/platform/` needs.

**`fs-native-extensions` (Apache-2.0, 1.5.1) is the one library that would
genuinely replace the locking half of both platform files.** It does real
per-platform kernel locking — `fcntl`, `flock`, `LockFileEx` — and ships
prebuilds for ten targets, including the `win32-arm64` the platform seam
special-cases. It loads under Bun and then hard-panics on the first call with
`unsupported uv function: uv_get_osfhandle`. That is Bun issue **#18546**,
still open; the library works correctly under Node. Bun issue **#33992**, a
request for `Bun.file().lock()`, is the other trigger that would make this
area reconsiderable.

**`env-paths` has no runtime directory at all**, and `xdg-basedir`'s is one
line with no fallback, where the daemon needs a real one.

**`node-pty` and `@lydell/node-pty` both fail `bun build --compile`**,
resolving a platform package path that `$bunfs` cannot see. Confirmed by
running them.

**No published binding reaches libghostty's snapshot codec, mouse encoder or
effect callbacks**, and nothing marshals a wasm32 C ABI from a runtime
manifest — component-model tooling wants WIT, where this is plain freestanding
wasm. Every struct library in TypeScript wants layouts written out by hand
rather than ingesting a machine-emitted one.

**`@xterm/headless` remains the only maintained second emulator** worth using
as an oracle.

**asciinema's parser is not a standalone package**, and it carries UTF-8
strings only, so it cannot hold the raw-bytes extension the corpus needs for a
PTY read cut mid-character.

**Framing libraries assume Node streams and varint lengths**, and none
expresses a mixed JSON-and-raw-bytes hot path. Selective-drop back-pressure —
never drop a control frame, drop output frames when the queue fills, repaint
once it drains — is application policy that no multiplexer or queue library
expresses.

**No standalone IME or composition library exists**; every project hand-rolls
the hidden-textarea technique.

**Micro-benchmark libraries time one function repeatedly**, where the bench
instruments a long-lived daemon's relay.

Two searches found something real but narrow, gaps rather than replacements:
`pidusage` can read resident memory for an arbitrary PID on Windows, where the
platform layer can only read its own; and `d3-array`'s `quantile` interpolates
where the hand-written percentile uses nearest-rank, which is slightly more
accurate on small samples.

**One question came back unanswered, and should not be read as settled.**
Whether `koffi`, `ffi-rs` or `win32-api` work under Bun and survive
`--compile` was never verified. Their absence from this file means nobody
checked, not that nothing exists.

## Two things next door

`ssh2` does support forwarding to a remote Unix socket, and its native pieces
are optional. Shelling out to the system `ssh` — what the transport spike does
— inherits the user's config, agent, jump hosts and hardware keys for free and
stays current with OpenSSH's algorithms. Its behaviour under
`bun build --compile` is unverified.
[`../../../docs/research/09-remote-transport.md`](../../../docs/research/09-remote-transport.md)
is where the transport question is set out.

`dockerode`'s `docker-modem` transport reaches a container on a remote Docker
host over SSH by running `docker system dial-stdio` on the far end. That is a
second hop nothing here has measured — [m5.md](./m5.md) reaches a container on
the same kernel — and it bears on container placement, which the PoC does not
have.

## Package facts age

Everything above was checked on 3 September 2026, against the versions
`package.json` resolves to on that date and against what npm and the two Bun
issues said then. Versions move, open issues close, and a search that found
nothing can find something a month later — the two renderer packages are the
fastest-moving of these, and the locking finding turns on a Bun bug that is
open rather than on anything about the library. Re-check before treating any
of it as current.
