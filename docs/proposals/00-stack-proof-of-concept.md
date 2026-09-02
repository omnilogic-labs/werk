# 00 — Proof of concept: does the stack survive contact

> **Status:** a proposal for an experiment, not a design for the product. It
> describes a throwaway program whose job is to find out whether TypeScript on
> Bun, reaching libghostty-vt through upstream's own WebAssembly build, holds up
> as the foundation for werk. Nothing here commits werk to a product shape.
> Where it states a technical fact, the fact was checked; where it proposes, it
> says so.

## What this exists to decide

Two things are settled going in, and the proof of concept is built on both:

- **libghostty-vt is werk's terminal engine, on every surface.** In the daemon,
  in the browser, and in whatever holds a terminal inside a TUI. Its C API is
  explicitly unstable and that is accepted. No other emulator is a candidate;
  xterm.js appears below only as a differential test oracle and as a possible
  source of browser-side parts that libghostty does not provide.
- **The language is TypeScript on Bun**, per
  [`../research/02-language-choice.md`](../research/02-language-choice.md) — one
  language for the CLI, the daemon and the web frontend, shipped as one
  compiled binary.

What is _not_ settled is whether that pairing works, and that is what
[`../research/README.md`](../research/README.md)'s three spikes ask:

1. Does `Bun.Terminal` work inside `bun build --compile`, and can Bun be a
   daemon that holds a PTY per session for days?
2. Does `ssh -L` with a Unix socket on each end hold up under a live PTY stream?
3. Does a libghostty binding survive `--compile`, and is it rich enough for
   two-stage reattach?

This proposal covers all three. The route to libghostty it proposes is not the
one the research assumed — Rust compiled to WASM, or the published TypeScript
bindings — because neither survives a look at what upstream actually publishes.

---

## 1. What is actually available

### Upstream ships the whole C API as WebAssembly, and nobody's binding does

Ghostty's own CI builds `libghostty-vt` for `wasm32-freestanding` on every push
to `main` and publishes the result:

```
zig build -Demit-lib-vt -Dtarget=wasm32-freestanding -Doptimize=ReleaseFast
zig build -Demit-lib-vt -Dtarget=wasm32-freestanding -Doptimize=ReleaseSmall
```

then post-processes each with `wasm-opt -O3`. The artifacts land at
`tip.files.ghostty.org/<commit-sha>/ghostty-vt.wasm` and
`…/ghostty-vt-small.wasm`, and on the rolling `tip` GitHub release with minisign
signatures. Freestanding WASM support landed upstream in October 2025 and is
maintained — there is a dedicated header, `include/ghostty/vt/wasm.h`,
documenting the allocator convention.

Checked directly against the downloaded `ghostty-vt-small.wasm` (738,713 bytes):

| Property                    | Measured                                                              |
| --------------------------- | --------------------------------------------------------------------- |
| Imports                     | **Zero.** `WebAssembly.instantiate(module, {})` is the whole contract |
| Exports                     | 189                                                                   |
| Snapshot                    | 13 functions — encode, encode_buf, encode_alloc, the full decoder     |
| Render state                | 22 functions                                                          |
| Key encoder / mouse encoder | 21 / 17 functions                                                     |
| Formatter                   | 5 functions — plain text, **VT sequences**, HTML                      |
| Scrollback compression      | `ghostty_terminal_compression_activity` + `ghostty_terminal_compress` |
| Effects / options           | `ghostty_terminal_set`, `_get`, `_get_multi`                          |
| Search, OSC, paste          | 8 / 7 / 3 functions                                                   |
| ABI self-description        | `ghostty_type_json`                                                   |
| WASM allocator              | `ghostty_wasm_alloc`, `_alloc_opaque`                                 |

`snapshot.h` confirms the two-stage decode that
[`01-libghostty-vt.md`](../research/01-libghostty-vt.md) calls the whole
ballgame — `ghostty_snapshot_decoder_ready()` validates the renderable prefix,
`_next()` walks history newest-first, `FINISH` terminates. The header states it
plainly: _"Restore READY first, then incrementally prepend history."_

`formatter.h` confirms the other thing that matters, in its first line: _"Format
terminal content as plain text, VT sequences, or HTML."_ The VT path takes a
`GhosttyFormatterScreenExtra` with flags for cursor position, SGR style,
hyperlinks, DECSCA protection, Kitty keyboard state and charset designations.

So the complete surface is sitting in a 739 KB file with no imports, no libc,
no toolchain, and no platform matrix — and, because it has no imports, it loads
identically in Bun, in Node, and in a browser.

### The engine and the language have come apart

That last property matters beyond convenience. A freestanding WASM module is
reachable from any host with a WASM runtime — Bun, a browser, Go through
`wazero` as hauntty does, Rust through `wasmtime`. The loader is a marshalling
layer over `ghostty_type_json()`, and the knowledge of how to write it is
portable. **Choosing libghostty does not constrain the language, and choosing
the language does not constrain how libghostty is reached.** If the Bun half
of this experiment fails and the fallback in
[`02-language-choice.md`](../research/02-language-choice.md) fires, the engine
work carries across.

### The published bindings, measured against that

Every JavaScript-reachable binding was installed and run. None of them reaches
the snapshot API — `snapshot.h` is newer than every binding's pinned Ghostty
commit.

| Capability                             | `@coder/libghostty-vt-node` | `ghostty-web` | `libghostty-vt` (bun:ffi) | `@wterm/ghostty` | **upstream `.wasm`** |
| -------------------------------------- | :-------------------------: | :-----------: | :-----------------------: | :--------------: | :------------------: |
| Binary snapshot encode                 |              ✗              |       ✗       |             ✗             |        ✗         |        **✓**         |
| Incremental decoder + `READY`          |              ✗              |       ✗       |             ✗             |        ✗         |        **✓**         |
| Per-row dirty tracking                 |              ✗              |       ✓       |             ✓             |        ✓         |        **✓**         |
| Key encoder                            |              ✗              |       ✓       |             ✓             |        ✗         |        **✓**         |
| Mouse encoder                          |              ✗              |       ✗       |             ✗             |        ✗         |        **✓**         |
| Effects: title / pwd / bell / progress |              ✗              | ✗ (discarded) |             ✗             |     partial      |        **✓**         |
| Scrollback compression                 |              ✗              |       ✗       |             ✗             |        ✗         |        **✓**         |
| Survives `bun build --compile`         |        **✗ breaks**         |       ✓       |         untested          |     untested     |        **✓**         |
| Windows                                |              ✗              |       ✓       |             ✗             |        ✓         |        **✓**         |
| Last release                           |         2026-04-24          |  2026-06-28   |        2026-05-07         |    2026-08-13    |    rolling `tip`     |

Notes worth carrying, because each one is a trap:

- **`@coder/libghostty-vt-node` is not what its reputation suggests.** Its whole
  surface is `feed`, `resize`, `snapshot`, `getVisibleText`, `formatPlain`,
  `formatHtml` and `dispose`; its `snapshot()` is a hand-assembled JSON object
  rather than `ghostty_snapshot_encode`, and it wraps only 15 upstream symbols.
  It runs under `bun run` and **fails under `bun build --compile`** —
  `Cannot find module '../package.json' from '/$bunfs/root/…'`, because its
  loader hands `node-gyp-build` a path that does not exist inside bunfs. Its npm
  `latest` tag also points at an older build than `beta`.
- **There are two different packages called `libghostty-vt-node`.** The GitHub
  repo `coder/libghostty-vt-node` is the Node-API one above and publishes as
  the scoped `@coder/libghostty-vt-node`. The _unscoped_ npm name
  `libghostty-vt-node` is `xatuke/libghostty-vt-node`, an unrelated WASM binding
  over upstream's artifact. `02-language-choice.md` describes the former.
- **`ghostty-web` carries a 1,620-line private patch** against a Ghostty pinned
  at December 2025, adding a `terminal.h` that upstream has since shipped
  itself, differently shaped. It matters here for a different reason than the
  others: it is the only existing **browser renderer** over Ghostty's VT, and
  §3 comes back to it.
- **`libghostty-vt` (`prime-radiant-inc/ts-libghostty`) is the richest native
  route** — `RenderState` with dirty iteration, `KeyEncoder`, `Formatter`,
  `renderToAnsiRect` — and it is Bun-only via `bun:ffi`, with six prebuilds and
  no Windows.

### So: are the TypeScript bindings suitable?

**No published one is** — but the conclusion that follows is not "therefore
Rust". It is that **the binding is the thing we write, and it is small.**

What werk needs from libghostty is the snapshot codec, the render state, the
formatter, both input encoders and the effects callbacks. Every published
binding predates or omits some of them. Upstream exports all of them from an
artifact that needs no linking, no compilation, no prebuild matrix and no
toolchain on any developer's machine. A loader over it is a TypeScript file
that reads struct layouts from `ghostty_type_json()` and marshals through
`ghostty_wasm_alloc`. That is a known, scoped piece of work rather than an
integration, and the same loader serves the daemon and the browser.

### And the Rust-to-WASM route?

It is buildable, and it arrives at a worse artifact than the one already
published, so it is not built here.

`Uzaaft/libghostty-rs` does not cross-compile to wasm32 on `master` — its
Rust→Zig triple map has no `wasm32-*` arm and panics with
`unsupported Rust target for vendored build`. There is an open PR that adds one;
it has been open since May 2026 and its CI step is `cargo check`, which runs
`build.rs` but never links. So the part that is demonstrated is that Zig builds
the archive and the bindings compile; the part that is not demonstrated is that
`rust-lld` links a Zig-produced wasm32 static archive — and no source anywhere
documents that boundary working. Beyond it sit further costs: a Zig toolchain
and a Rust toolchain in the build, `extern "C"` re-exports of an ABI that is
already a C ABI, and `wasm-bindgen`'s deployment targets being mutually
exclusive between bundler, browser and Node — whereas upstream's freestanding
artifact serves Bun and the browser as the same bytes.

The condition that would revive it: **if we come to need Rust in the daemon for
its own sake** — a native session core, a `napi-rs` bridge, anything where the
Rust crate is the product rather than a wrapper — then reaching libghostty from
that crate is a genuine question again. Reaching it _through_ Rust purely to get
WASM is not. The seam in §5 keeps adding such an adapter cheap; that is the
whole record on this route.

---

## 2. Two ways to come back to a terminal

| Mechanism          | How it works                                                                                                  | Client requirement                    | Who does it                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------- | ------------------------------------- | -------------------------------------------------- |
| **Re-emit VT**     | Ask the emulator to render its current screen back into escape sequences; write those to the attaching client | Any terminal at all                   | zmx (`TerminalFormatter`); shpool's redraw         |
| **Transfer state** | Encode the emulator's state as `GHOSTSNP` bytes; the client's own emulator decodes it                         | The client must run the same emulator | hauntty; what Ghostty upstream says it is building |

werk needs both, for different surfaces:

- **`werk attach` from a CLI** lands in the user's own terminal — Ghostty,
  iTerm2, Windows Terminal, whatever. We do not control it. Re-emitting VT is
  the only mechanism available there.
- **The browser** runs an emulator we ship, and it is the same libghostty
  build the daemon runs. State transfer is the mechanism, and it is what buys
  the two-stage `READY`-then-history reattach: paint the viewport immediately,
  stream scrollback after.
- **Daemon restart** is state transfer to ourselves.
- **A terminal inside the TUI**, if one is built, is the browser case again:
  an emulator we ship, fed by state transfer.

### The two mechanisms are not equivalent, and the difference is measurable

Both were run against the upstream WASM.

**Re-emission is cheap, faithful, and lossy in exactly one way.** The formatter
with `emit=VT` and the cursor, style, hyperlink and charset flags set produced a
**211-byte** stream for a styled 40×12 screen. Replayed into a fresh terminal it
reproduced the rendered text identically, preserved the cursor position, and
re-emitting from the replayed copy produced a byte-identical stream — it is
idempotent. But **it breaks soft-wrapped lines with a hard newline.** Both
terminals render the same at 40 columns; resize both to 80 and the original
rejoins into one logical line while the replayed copy stays permanently split.

**State transfer does not have that defect.** The same experiment through
`ghostty_snapshot_encode_alloc` → `ghostty_snapshot_decoder_decode` → resize to
80 gives output identical to the source.

**And the two-stage reattach does what the header claims.** An 80×24 terminal
fed 5,000 lines, retaining 956, encoded to **54,655 bytes** with the `GHOSTSNP`
magic. `ghostty_snapshot_decoder_ready()` returned success in **6 ms** with a
282-line renderable prefix — exactly the tail of the buffer, which is what you
would paint immediately — while reporting **932 rows still pending**. `_next()`
then consumed history to completion, arriving byte-identical to the source. The
split only manifests once history exceeds a page; on a 20-line buffer the prefix
already contains everything.

The soft-wrap defect is confined to the one surface where re-emission is
unavoidable, the CLI. Even there it is probably recoverable: the daemon has to
resize its own terminal on every client resize anyway, to deliver `SIGWINCH`,
and its reflow is correct — so it can clear the client and re-emit at the new
size. That costs a scrollback re-send per resize and a `CSI 3 J` into the
user's terminal, which is ugly enough to want measuring. It is in the corpus in
§6 as the CLI's only fix, not as an alternative to state transfer.

---

## 3. One emulator everywhere, and what it costs

The decision to run libghostty on every surface has three consequences the
proof of concept has to face rather than defer.

### The browser needs a renderer, and xterm.js cannot be one

The upstream WASM parses and holds state; it draws nothing. In the browser,
something has to turn its render state into pixels, capture keys and mouse,
handle selection, IME, scrolling and links. That is the part libghostty does
not do, and it is the only part of the browser terminal where anything other
than libghostty is wanted.

xterm.js cannot be cut down to that role. Its renderers — DOM, canvas, WebGL —
read xterm's own buffer directly, and there is no supported way to drive them
from foreign terminal state. Feeding xterm.js the daemon's screen means
re-emitting VT into it, which puts a second emulator in the browser and gives
up state transfer there. So "xterm.js for the parts libghostty doesn't do" is
probably not available as stated, and the realistic routes are:

| Route                                                      | What it gives                                                                                                 | What it costs                                                                                                                          |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Rebase `ghostty-web` onto the pinned upstream artifact** | An existing canvas renderer, keyboard, selection and an xterm-shaped API, over the same bytes the daemon runs | Absorbing a 1,620-line patch against a stale pin; its `terminal.h` differs from upstream's; nobody has shown it on upstream `tip`      |
| **Own renderer over the upstream WASM**                    | Exactly the surface werk needs, no foreign API shape, dirty-row and snapshot paths designed together          | It is a terminal renderer: fonts, graphemes, cursor styles, selection, IME, scrolling. Weeks, and the long tail is where the bugs live |
| **Re-emit into xterm.js**                                  | Works today, well understood, and xterm.js parts (fit, web-links, search UI) come for free                    | Two emulators, no browser-side state transfer, and the §2 soft-wrap defect on every browser resize                                     |

The lean is the first, with the third kept as the fallback for M4 if it stalls.
Which of the first two the product ends up on is an open question at the end
of this document, and the proof of concept should produce the evidence to
answer it: how much of ghostty-web's renderer survives a rebase, and how much
of it werk would keep.

### Every libghostty in the fleet has to agree

`GHOSTSNP` format version 1 carries no binary-compatibility guarantee, and the
WASM ships only from a rolling `tip` channel. With state transfer as the
mechanism between daemon and browser, that stops being a persistence footnote
and becomes an architectural constraint: **a browser page served by one daemon
decoding a snapshot produced by a daemon on another machine at a different
werk version is the ordinary fleet-upgrade journey**, and it would break on a
format change.

The likely shape of the answer is that werk pins exactly one libghostty commit
per werk release, ships the same bytes in the daemon and the browser bundle,
and either verifies that the format is stable across the commits it has shipped
or falls back to re-emission across a version mismatch. The proof of concept
measures the first half of that — whether a snapshot from one `tip` commit
decodes on another — in M3, and the update policy is an open question below.

### xterm.js's remaining role

Two places, neither of them emulation:

- **As a differential oracle in the test corpus.** There is no ground truth for
  a terminal emulator; a second independent implementation fed the same bytes
  flags disagreements for a human. Headless xterm 6 with
  `reflowCursorLine: true` matched libghostty across all eight reflow scenarios
  that were run, which makes it a usable oracle — a disagreement is a bug in
  one of them, and finding out which is the point.
- **As a source of browser parts** — `addon-fit`'s measurement, `web-links`,
  the search UI shape — if the browser renderer ends up wanting them and they
  detach from xterm's buffer cleanly. Whether any do is a finding for M4.

---

## 4. What to build

A deliberately small program: **a detachable process runner for the local
machine, and nothing else.** Working name `werk-poc`, binary `wp` — the name is
disposable and should not leak into the product.

It is minimal in features and maximal in one dimension: every place where Bun
or libghostty could fail is exercised for real rather than stubbed.

### The surface

```console
$ wp run -- claude              # spawn under a PTY in the daemon, attach
$ wp run --engine=ffi -- vim    # same, libghostty over bun:ffi instead of WASM
                                # ctrl-\ detaches
$ wp ls                         # id, command, engine, status, title, age
$ wp attach <id>                # come back to it
$ wp attach --read-only <id>
$ wp logs <id>                  # dump scrollback
$ wp kill <id>
$ wp serve                      # loopback web UI: list + click through to a live terminal
$ wp bench                      # the measurements in §6
$ wp __daemon                   # hidden; not typed by a human
```

The daemon: one process, many sessions (the simpler fork from
[`05-control-surfaces.md`](../research/05-control-surfaces.md) §A — per-session
daemons are a real option for the product and an unnecessary complication here).
Unix socket in `$XDG_RUNTIME_DIR`, `flock` before bind, atomic
bind-then-rename, readiness handshake over an inherited pipe, no PID file, no
signals for control. Snapshot every session to disk on a timer and on `SIGTERM`;
restore on start as a labelled read-only corpse. All of that is
[`04-daemon-best-practices.md`](../research/04-daemon-best-practices.md)
applied directly. The parts that are Bun-specific unknowns — spawn and detach,
the socket handshake, signal handling, the PTY callback contract — are built
properly, because finding out whether Bun can express them _is_ a result. The
snapshot timer is trivial either way.

### Deliberately not in it

Git, worktrees, branches, placement, containers as a placement, cross-machine
anything beyond the transport spike in M5, auth beyond a loopback one-time
token, a TUI, notifications, self-update, signing, Windows. Sessions are keyed
by a short id, not a workspace name. None of that is a judgement about the
product — it is all downstream of the answer this experiment produces.

### Shape, given what Bun does and does not do

Three findings constrain the design before a line is written:

**The daemon must own every PTY and relay bytes.** Bun has no `SCM_RIGHTS` — no
API, no issue, no documented workaround — so handing a PTY master to the CLI
client is off the table. The wire protocol is the only interface, from day one,
with no fast path around it. This is a firm constraint, not a preference.

**Daemonising is `detached: true` + `stdio: ["ignore","ignore","ignore"]` +
`unref()`.** Bun's `detached` calls `setsid()` on POSIX; verified by comparing
`ps -o pid,ppid,pgid,sid` between a detached and a non-detached child, which
showed the detached one as its own session leader. No double-fork, no
`bun:ffi` call to `setsid`. This is the whole mechanism, and it is the one place
where Bun is _simpler_ than the research assumed.

**`Bun.Terminal`'s output is callback-only.** No `ReadableStream`, no async
iterator — `data(terminal, bytes)` and `exit(terminal, code, signal)`, where
`exit` reports PTY lifecycle rather than the child's exit code and `signal` is
always `null`. `proc.stdout` is `null` when a terminal is attached. The read
loop is therefore a callback that must never block: copy to the client queues,
tap the VT, return.

### Backpressure is a design item, not a detail

A callback-only read loop has no natural backpressure. A browser tab watching
`cat /dev/urandom | base64` from a slow network grows its client queue without
bound, and the daemon goes with it. The design has to say what happens, and
the ghostty-snap rule from
[`03-prior-art.md`](../research/03-prior-art.md) is the proposed one: each
client has a bounded queue; when it fills, the daemon stops streaming raw bytes
to that client and marks it lagging; when the queue drains, it sends a fresh
render — a snapshot for a browser client, a re-emission for a CLI client — and
resumes streaming. Input stays live throughout, memory stays bounded per
client, and a slow viewer never slows a fast one. The PTY itself is never
paused for a viewer. How Bun's socket writes report a full buffer, and whether
that signal arrives in time, is an M2 measurement.

---

## 5. The seam

One interface, two libghostty adapters, chosen per session at runtime. The
interface exists so that the WASM-versus-native question is answered by the
same program on identical calls, so that the differential corpus can drive an
oracle through the same calls, and so that the adapter is the piece that
outlives the proof of concept.

```ts
interface VtEngine {
  readonly id: string; // "ghostty-wasm" | "ghostty-ffi" | "xterm-oracle"
  readonly caps: Capabilities; // what this engine can actually do
  create(opts: { cols: number; rows: number; scrollback: number }): VtTerminal;

  // reattach mechanism 2, decode side — you decode into a new terminal,
  // so this lives on the engine rather than on an instance
  decodeState(
    bytes: Uint8Array,
  ): { ready(): VtTerminal; next(): Page | null } | Unsupported;

  // browser input → PTY bytes; needed by any client running this emulator
  encodeKey(ev: KeyEvent, mode: TerminalModes): Uint8Array | Unsupported;
  encodeMouse(ev: MouseEvent, mode: TerminalModes): Uint8Array | Unsupported;
}

interface VtTerminal {
  write(bytes: Uint8Array): void; // PTY output in
  resize(cols: number, rows: number): void;

  // reattach mechanism 1 — for a CLI client in someone else's terminal
  emitVt(opts?: {
    cursor?: boolean;
    style?: boolean;
  }): Uint8Array | Unsupported;

  // reattach mechanism 2, encode side
  encodeState(): Uint8Array | Unsupported;

  // incremental update for the web surface. One consumer per attached
  // client: each holds its own dirty cursor, so a slow client's unread
  // rows are not cleared by a fast one reading first.
  renderConsumer():
    { dirtyRows(): Iterable<Row>; dispose(): void } | Unsupported;

  // semantic metadata, for the "needs you" signal
  onEffect(cb: (e: Effect) => void): void; // title, pwd, bell, progress, notification, write-pty

  plainText(): string; // the lowest common denominator, for differential testing
  styledCells(): Cell[][]; // text plus attributes, for the same purpose
  dispose(): void;
}
```

Every capability an engine lacks returns a typed `Unsupported` rather than
throwing, so the capability matrix in §1 stops being a table someone maintains
by hand and becomes **output of the program**.

The render-consumer shape follows libghostty's own two-phase render state —
`begin_update` needs the terminal, `end_update` needs only the consumer's
memory — and it is the thing M4 tests. A single shared dirty set would work for
one browser tab and silently break for two.

### The adapters

| Adapter        | Over                                                                         | Why it is here                                                                                                                               |
| -------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `ghostty-wasm` | Our own loader over upstream's `ghostty-vt-small.wasm`, pinned by commit SHA | The proposed answer. The only route that serves the daemon and the browser from the same bytes                                               |
| `ghostty-ffi`  | `libghostty-vt` (`ts-libghostty`) over `bun:ffi`                             | Measures the WASM-versus-native question directly, on identical calls. If WASM is within noise of native, the platform matrix goes away      |
| `xterm-oracle` | `@xterm/headless` 6 + `addon-serialize`, `reflowCursorLine: true`            | **Not a candidate.** A second implementation for the differential corpus, and nothing else. Effects come through `parser.registerOscHandler` |

The oracle's effects hooks were run: headless xterm 6 reports title, OSC 7 pwd,
OSC 9 and OSC 777 notifications, OSC 9;4 progress, OSC 133 marks and the bell
through its parser API, and it does so identically under `bun run` and inside
a `--compile` binary on Bun 1.3.14. So it can stand in for libghostty on the
effects axis of the corpus too, not only on rendered text.

---

## 6. How we measure

Four axes. The first three are `wp bench` subcommands; the fourth is CI.

**Capability.** Probe every method on every adapter, print the matrix. Cheap,
and it keeps the documentation honest as upstream moves.

**Correctness, differentially.** Feed the same byte stream to the two libghostty
adapters and the oracle and compare plain text, styled cells and emitted
effects. Disagreements are flagged for a human, not auto-scored — a
disagreement between WASM and native libghostty is a loader bug; a
disagreement with the oracle is a bug in one of the two emulators, and which
one is the finding. The corpus:

- recorded asciicasts of real sessions: an agent, `vim`, `htop`, a noisy build,
  `ls --color`, a `tmux` inside;
- Unicode torture — ZWJ emoji, Devanagari, CJK width, RTL, combining marks;
- **reattach then resize on the primary screen** — restore a session, resize
  it, and compare against a terminal that was never detached. Through state
  transfer, and through re-emission with and without the clear-and-re-emit
  strategy from §2;
- **reattach then resize on the alternate screen** — the same sequence with
  `vim` and with an agent TUI. libghostty's header says the alternate screen
  does not reflow, by design; every full-screen program lives there, and only
  the primary screen has been measured so far;
- the reflow sequence — wrap, shrink, regrow — as a regression test;
- interrupted escape sequences — cut the stream mid-CSI, resume, confirm the
  `CONTINUATION` record does what the header claims;
- fuzz: random bytes and randomly-generated valid CSI/OSC.

**Performance.** Throughput feeding the VT; latency added to the PTY→client
path over an untouched byte copy, and over `dtach` as the native floor for the
same job; snapshot size, encode time, and time-to-first-paint on decode;
resident memory for _N_ sessions × _M_ MiB of scrollback; what happens to
memory across session churn; and behaviour under a deliberately slow client.

Then **soak**: twenty sessions, a mix of idle shells and a looping noisy
producer, held for 24 hours with the snapshot timer running. Record RSS, GC
pause distribution and attach latency at intervals. Point-in-time throughput
is unlikely to be what disqualifies a JavaScript daemon; heap growth over days
is, and nothing else in the plan measures it.

Two measurements already exist as a baseline, taken against the upstream WASM in
Bun and Node: **VT parse throughput around 107 MiB/s in Bun**, and **100
concurrent terminals in one instance at 47 MiB, with freeing and re-allocating
100 more adding exactly zero further memory** across three rounds. A single
120×40 terminal held flat at 1.94 MiB from 10,000 lines through 400,000 — the
default scrollback cap holds. If those survive the PoC's own measurement, memory
and throughput are not the constraint on this design.

**Operational.** Does each adapter survive `bun build --compile`? What
toolchain does a clean build need? What is the platform matrix? Binary size
delta? This axis has already eliminated one route — `@coder/libghostty-vt-node`
fails under `--compile` — and it is the axis most likely to eliminate another.

Every measurement records the exact Bun version it ran on, and M0 runs on two:
the 1.3.14 on this machine and the current 1.4.x, because the 1.4 Rust rewrite
reintroduced a macOS signing regression within days of shipping and the PTY
layer is native runtime code of the same vintage.

---

## 7. Order of work, and where to stop

Each milestone has a condition that means stop and reconsider rather than push
on.

| #      | Deliverable                                                                                                                                                                                   | Stop if                                                                                                               |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **M0** | Smoke tests only, no product code. Everything in the list below                                                                                                                               | `Bun.Terminal` does not work compiled, or cannot deliver `SIGINT`, or cannot deliver `SIGWINCH`                       |
| **M1** | The `ghostty-wasm` adapter: loader, `ghostty_type_json` layout discovery, write / resize / plainText / emitVt / effects / both encoders                                                       | The ABI cannot be marshalled reliably from `ghostty_type_json`                                                        |
| **M2** | Daemon + `wp run` / `attach` / `ls` / `kill`, re-emit VT on reattach, detach key, per-client bounded queues with the lagging-client rule from §4                                              | Reattach into a real terminal is visibly wrong for `vim` or an agent, or a slow client stalls a fast one              |
| **M3** | Snapshot: encode to disk on a timer and on `SIGTERM`, restore on start, two-stage `READY` decode. Then encode on one `tip` commit and decode on the next two                                  | The snapshot cannot be round-tripped, the decoder's prefix is not renderable, or no two adjacent `tip` commits agree  |
| **M4** | `wp serve`: one page, a session list, one live terminal rendered by the §3 lean, driven by state transfer plus per-consumer dirty rows, keys and mouse through the WASM encoders              | The browser cannot decode what the daemon encodes, or the renderer route costs more than the rest of the PoC combined |
| **M5** | The transport spike: a container running `sshd`, the daemon inside it, `ssh -L` with a Unix socket on each end, `tc netem` for latency; `wp attach` through the forward under `yes` and `vim` | Frames coalesce badly enough that a TUI is unusable at 50 ms RTT, or the forward drops under load                     |
| **M6** | The `ghostty-ffi` adapter and the `xterm-oracle`, then `wp bench` across all of it, including the soak                                                                                        | —                                                                                                                     |

**M0 is genuinely first**, and it is larger than a smoke test usually is,
because everything downstream of it assumes answers nobody has written down.
Bun's own complete bundled documentation for 1.3.14 mentions `Bun.Terminal` in
five files and ties it to standalone executables in none of them. The list:

- `Bun.Terminal` inside a `--compile` binary, on both Bun versions.
- Ctrl+C reaching the child as `SIGINT`. An open Bun issue reports that
  `Bun.spawn({ terminal })` does not make the PTY the child's controlling
  terminal, which would mean **Ctrl+C never delivers `SIGINT`** — for a
  session runner that is disqualifying until proven fixed.
- `SIGWINCH` reaching the child on `resize()`, and `vim` redrawing to it.
- The `exit` callback's real contract. Its semantics on Linux are disputed; a
  probe on this machine saw it fire twice for one session.
- The PTY surviving the daemon being detached, and then surviving the parent's
  terminal closing — `setsid` should make the second one true, and it is the
  one that matches "close the laptop".
- A child that toggles raw mode, and what the daemon observes.
- The latency floor: bytes from the `data` callback to a Unix socket client,
  against `dtach` doing the same relay natively.

**M1 is less risky than it looks**, because the experiments behind §1 and §2
already marshalled the ABI end to end. Notes worth carrying into it:

- `ghostty_type_json()` returns a pointer to a 43,503-byte NUL-terminated JSON
  document describing all 159 types with exact offsets, sizes and alignments. It
  is a reliable oracle — the whole binding was derived from it and only then
  confirmed against the headers. Build the loader on it rather than on
  hand-transcribed layouts, which is also what makes upstream drift survivable.
- `ghostty_terminal_new(const GhosttyAllocator*, GhosttyTerminal*, u16 cols, u16 rows)`
  accepts `0` for the allocator to select the default.
- `ghostty_terminal_resize` takes **five** arguments — add cell width and height
  in pixels.
- `GhosttyFormatterTerminalOptions` is declared by value in the header but
  arrives **as a pointer** under the wasm32 C ABI. All three nested option
  structs are size-prefixed and each `size` field must be set independently.

If M1 stalls, M2's daemon can be built first against a raw relay with no
emulator — dtach-shaped, no reattach fidelity — so that the Bun questions keep
being answered while the loader is finished. The seam makes that a one-line
swap later.

**M4 is the one whose size is least certain.** The daemon side — snapshot out,
dirty rows out, key bytes in — is small. The renderer is not, and §3 says why.
The milestone is capped at proving the round trip on one route; the product's
renderer is a decision for after the PoC, informed by what the rebase costs.

**M5 needs no second machine.** The research README calls the transport the
largest unmeasured architectural risk and every documented use of socket
forwarding is a request/response proxy. A container with `sshd` and `netem` is
enough to find out whether a live PTY stream survives the forward, and it is
cheaper than M4.

---

## 8. What would change the answer

Written before the measurements so they cannot be rationalised afterwards.
These are proposed thresholds, and worth arguing with now rather than later.

| Finding                                                                        | What it implies                                                                                                                                                   |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Bun.Terminal` does not work under `--compile`, and node-pty is the only route | The TypeScript plan survives but inherits VibeTunnel's forked node-pty and its prebuild matrix                                                                    |
| Ctrl+C or `SIGWINCH` cannot be made to work through `Bun.Terminal`             | Blocking. Either a fix upstream, or a different PTY layer, or the Go fallback — and per §1 the engine work carries across                                         |
| The WASM ABI cannot be marshalled reliably                                     | The `bun:ffi` route becomes primary, Windows becomes a question again, and the browser needs its own loader anyway                                                |
| VT throughput below ~20 MiB/s                                                  | Not fatal — the VT is a tap, not a stage — but it moves the fan-out design                                                                                        |
| Per-session memory materially above ~5 MiB idle                                | Bounds how many sessions a machine holds; changes the fleet story before it is built                                                                              |
| RSS grows without bound over the 24-hour soak                                  | The daemon cannot be long-lived in Bun as designed. Per-session daemons with periodic recycling, or the Go fallback                                               |
| A wasm trap in one session poisons the shared instance                         | Instance-per-session at ~450 KiB each, rather than one shared instance                                                                                            |
| A lagging client cannot be detected before its queue grows past the threshold  | Bun's socket write signal is not usable for backpressure; the daemon needs its own accounting on every write                                                      |
| Snapshots do not decode across adjacent `tip` commits                          | State transfer works only within one werk version; the fleet needs re-emission across a mismatch, and the browser bundle must ship with the daemon that serves it |
| Rebasing `ghostty-web` costs more than writing a renderer                      | The renderer is werk's own from the start, and M4 is scoped to that                                                                                               |
| The forwarded socket coalesces or drops frames under a live PTY at modest RTT  | The remote transport needs framing of its own over the forward, or a TCP loopback landing — the architecture in `09-remote-transport.md` changes                  |

---

## 9. What this does not settle

- **Windows.** The WASM route is architecturally portable and `Bun.Terminal`'s
  Windows support is contradicted by Bun's own shipped type definitions, which
  still say POSIX-only in the release whose blog post announces ConPTY. Worth a
  separate look, not a fold-in. The proof of concept's client-side code should
  simply avoid precluding it — no `AF_UNIX` assumption in the client that a
  named pipe could not satisfy.
- **Whether one daemon or one per session.** The PoC uses one; the product's
  answer is open and this experiment does not inform it much either way — except
  that the soak result would push toward per-session if memory does not hold.
- **Anything above the session ring.** Workspaces, placement, git, the fleet.
- **The libghostty update policy.** The C API is explicitly unstable, the WASM
  ships only from a rolling `tip` channel pinned by commit SHA, and there is no
  versioned release. `ghostty_type_json` is upstream's answer to layout drift;
  whether it absorbs a real breaking change is unverified. How often werk moves
  its pin, and what a move does to snapshots on disk and daemons in the fleet,
  is a policy nobody has set — M3 produces the evidence for it.
- **The remote transport beyond one hop.** M5 measures a forward to one host.
  A container on a remote docker host, reached by ssh and then `docker exec`, is
  a second hop and is not measured here.

---

## 10. Open questions for the reader

Genuine forks where the answer changes what gets built.

1. **Which renderer route for the browser?** §3 leans toward rebasing
   `ghostty-web` onto the pinned upstream artifact, with an own renderer as the
   alternative and re-emission into xterm.js as the fallback for the PoC only.
   The rebase is the cheapest way to find out how much of ghostty-web werk would
   keep; if the answer is "the shell and none of the internals", the own
   renderer is the honest route and should be sized as such.
2. **How does the fleet handle a libghostty version mismatch?** Refuse to
   attach, fall back to re-emission, or forbid mismatches by upgrading every
   daemon in lockstep. Each is coherent; the third is the simplest and the
   least forgiving on a fleet where one host is asleep during `werk upgrade`.
3. **Does the PoC's code survive into the product?** The proposal assumes the
   seam, both libghostty adapters, the loader and the corpus are kept as
   `packages/vt` — the corpus is the most valuable long-lived asset this work
   produces regardless of anything else — and that the daemon is burnt. If the
   daemon is meant to become `packages/werkd` instead, several of the
   exclusions in §4 should move.
4. **Is the oracle worth keeping after the PoC?** It costs one dependency and
   earns a second opinion on every corpus case. The argument against is that it
   is a dependency on the thing werk chose not to use.

## Sources

Verified first-hand for this proposal: the upstream `ghostty-vt-small.wasm`
artifact (downloaded, parsed for imports and exports, 738,713 bytes, zero
imports, 189 exports); `include/ghostty/vt/snapshot.h`, `formatter.h` and
`terminal.h` on `main`; npm registry metadata for `libghostty-vt-node`,
`libghostty-vt`, `ghostty-web` and `@xterm/headless`; the local toolchain (Bun
1.3.14, Node 24, git 2.53, Docker — no Zig, no cargo).

Verified by measurement during the research behind it: every published binding
installed and run under both Node 24 and Bun 1.3.14, including
`bun build --compile`; `Bun.Terminal`'s prototype and callback signatures;
`detached` session-leader behaviour under `ps`; abstract Unix socket round-trip
under `Bun.listen`; `WebSocket.publish` return values; a `--compile` executable
with an embedded `.wasm` running with no `.wasm` on disk; the WASM throughput
and memory figures in §6; and `@xterm/headless@6.0.0`'s `parser` hooks
reporting title, OSC 7, OSC 9, OSC 9;4, OSC 777, OSC 133 and bell under both
`bun run` and a `--compile` binary.

The measurements in §1 and §2 were run directly against the upstream WASM and
`@xterm/headless@6.0.0` on Node 24: the eight-scenario reflow differential, the
`GHOSTSNP` encode and two-stage `READY` decode with row accounting, the VT
re-emission round-trip and its soft-wrap loss under resize, and the ABI recovery
from `ghostty_type_json`. Things they did **not** cover, all in the plan above:
the alternate screen, snapshot compatibility across libghostty builds, the
forwarded-socket transport, and anything longer than a few minutes of runtime.

Documentary: Ghostty's `test.yml` and `release-tip.yml` workflows,
`src/build/GhosttyLibVt.zig`, `src/lib_vt.zig`, `include/ghostty/vt/wasm.h`;
`Uzaaft/libghostty-rs` `build.rs` and PR #36; `bun-types@1.3.14`'s shipped
`.d.ts` and `.mdx` documentation corpus; Bun issues #33237, #40289, #30717,
#26045, #16706 and PR #20265; `xtermjs/xterm.js` #6130 and #2570;
`seruman/hauntty`, `neurosnap/zmx`, `coder/ghostty-web` and
`amantus-ai/vibetunnel` build files and architecture documents.
