# 02 — Language choice, and the binding landscape

What werk should be written in, and how it reaches `libghostty-vt`. The stated
intent is **TypeScript on Bun, shipped as one fat cross-platform binary with
`git` and `ssh` inside it**; this document is what that has to survive.

Three things weight the question the way they do:

1. **Bun shipped a native PTY API.** `Bun.Terminal` (v1.3.5 POSIX, v1.3.14
   Windows ConPTY) removes `node-pty` — the scariest dependency in a TypeScript
   version of this — from the critical path. [07 §4](07-packaging.md).
2. **The daemon is the smaller half of the product.** Placement, git
   orchestration, a fleet aggregator, a TUI, a web UI and a desktop shell are
   all work TypeScript does well, and there is more of them than there is
   daemon.
3. **Distribution is a product feature.** "One binary, nothing installed,
   anywhere" is promise five, and Bun cross-compiles eight targets from one CI
   runner with first-class asset embedding. [07 §2–3](07-packaging.md).

The engine is settled — libghostty-vt on every surface — so the question this
document has to answer is how TypeScript reaches it inside a compiled binary.
The answer turns out not to be any published binding: **Ghostty's own CI
publishes the whole C API as a freestanding WebAssembly module with zero
imports**, and a loader over that is the binding. It is specified and put
through its paces in
[`../proposals/00-stack-proof-of-concept.md`](../proposals/00-stack-proof-of-concept.md).

## The binding landscape

There is a large and fast-moving ecosystem around libghostty. Two curated lists
track it: [Uzaaft/awesome-libghostty](https://github.com/Uzaaft/awesome-libghostty)
and [lawrencecchen/awesome-libghostty](https://github.com/lawrencecchen/awesome-libghostty).

### The ones that matter to us

| Language    | Project                                                                                                 | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Rust**    | [Uzaaft/libghostty-rs](https://github.com/uzaaft/libghostty-rs)                                         | Workspace: `libghostty-vt-sys` (raw FFI, bindgen from `vt.h`) + `libghostty-vt` (safe API). Exposes `Terminal`, `RenderState`, `KeyEncoder`, `MouseEncoder`, `RowIterator`/`CellIterator` with grapheme extraction, screen + scrollback access. MIT, pre-1.0, ~380★. `build.rs` fetches a **pinned ghostty commit** and builds with **Zig 0.16.x**; override with `GHOSTTY_SOURCE_DIR`. Static by default, `link-dynamic` feature. Runs **Miri** over the unsafe boundaries. Nix flake. Ships a Rust port of ghostling. |
| **Go**      | [mitchellh/go-libghostty](https://github.com/mitchellh/go-libghostty)                                   | By Ghostty's author. cgo, static by default via pkg-config, `-tags dynamic` for shared. Uses **zig as the C cross-compiler** (already required). Targets linux/macos/windows × x86_64/aarch64. `Terminal`, `RenderState`, `Formatter`, `KeyEvent`/`MouseEvent` + encoders, selection/snapshot, `ColorScheme`/SGR. MIT, ~150★, good test + benchmark coverage. "I'm not promising any API stability yet."                                                                                                                |
| **Any**     | **upstream `ghostty-vt.wasm`**                                                                          | Ghostty's CI builds `libghostty-vt` for `wasm32-freestanding` on every push to `main` and publishes it at `tip.files.ghostty.org/<sha>/` with minisign signatures. **Zero imports, 189 exports** — the full snapshot codec, render state, both input encoders, formatter, effects, search and scrollback compression, plus `ghostty_type_json()` describing every struct layout. 739 KB. Loads identically in Bun, Node and a browser. **This is the route werk takes**, with a loader of our own.                      |
| **Node/TS** | [coder/libghostty-vt-node](https://github.com/coder/libghostty-vt-node)                                 | Node-API addon wrapping 15 upstream symbols: `feed`, `resize`, a hand-assembled JSON `snapshot`, `getVisibleText`, `formatPlain`, `formatHtml`. No render state, no encoders, no binary snapshot. **Fails under `bun build --compile`** — its loader hands `node-gyp-build` a path that does not exist inside bunfs. Not to be confused with the unscoped npm package of the same name, which is an unrelated WASM wrapper.                                                                                             |
| **Bun/TS**  | `libghostty-vt` ([prime-radiant-inc/ts-libghostty](https://github.com/prime-radiant-inc/ts-libghostty)) | The richest native TypeScript route — `RenderState` with dirty iteration, `KeyEncoder`, `Formatter` — over `bun:ffi`, six prebuilds, no Windows, and a pinned Ghostty that predates `snapshot.h`. Kept as the **native comparison point** against the WASM route, on identical calls.                                                                                                                                                                                                                                   |
| **Browser** | [coder/ghostty-web](https://github.com/coder/ghostty-web)                                               | Ghostty's VT compiled to WASM behind an **xterm.js-shaped API** with its own canvas renderer, keyboard input and selection. Pinned to a December 2025 Ghostty behind a 1,620-line private patch, so it does not decode upstream `tip` snapshots. Matters as the only existing **browser renderer** over Ghostty's VT; the proposal's lean is to rebase it onto the pinned upstream artifact.                                                                                                                            |
| Zig         | native                                                                                                  | No binding needed — it _is_ Zig. Also [libghostty-vaxis](https://github.com/rockorager/libghostty-vaxis) for the Vaxis TUI lib, [browstty](https://github.com/Snoupix/browstty) for a Zig→WASM browser terminal.                                                                                                                                                                                                                                                                                                        |

Also exists: C++, Python, Dart/Flutter, Swift, .NET, Elixir NIFs, Odin, MoonBit.
The ecosystem is not a constraint on our choice.

**Two things follow from the WASM artifact.** Every _native_ path needs the
**Zig toolchain at build time**, because that is how `libghostty-vt.a` gets
produced; "choosing Rust to avoid Zig" is not a thing. The freestanding WASM
needs no toolchain at all — upstream builds it, we download and pin it. And
because it has no imports, it is reachable from any host with a WASM runtime:
Bun, a browser, Go through `wazero` as hauntty does, Rust through `wasmtime`.
**The engine choice and the language choice are independent of each other.**
The loader is a marshalling layer over `ghostty_type_json()`, and the knowledge
of how to write it carries across languages.

## The options

### Rust

**For**

- `libghostty-rs` is a complete native binding: render state, iterators, both
  encoders, Miri-verified unsafe boundaries. It has no capability the upstream
  WASM lacks, but it has them behind a safe API someone else maintains.
- The serving surface is where most of our code will live, and Rust's ecosystem
  there is the deepest and most stable of the three: `tokio`, `axum` +
  `tokio-tungstenite` for HTTP/WS, `russh` if we ever embed SSH, `portable-pty` /
  `pty-process` for PTYs, `rustix`/`nix` for the termios and ioctl work,
  `tracing` for structured logs, `clap` for the CLI.
- **The TS-client bridge**: with `napi-rs` we can compile the _same core crate_
  into a Node addon. `werk` (TypeScript) then links the identical VT/session code
  the daemon runs, rather than reimplementing anything. This is the strongest
  strategic argument, given the client is TS by decree.
- Laurie Tratt, after ~20 years of writing Unix daemons in C, now recommends Rust
  for daemons of moderate complexity: "substantially higher productivity than C"
  plus a type system that makes the multi-threading daemons inevitably need
  tractable.
- Prior art exists in-language: **shpool** (Google) is a Rust session-persistence
  daemon; **zellij** is a Rust client/server multiplexer with a web client.

**Against**

- FFI is `unsafe`, and the terminal is not thread-safe — we must be disciplined
  about single ownership per session. (Mitigated: the safe wrapper + Miri.)
- Build chain: `build.rs` fetching and compiling ghostty with Zig makes CI and
  reproducibility more work than `go build`. Plan to vendor or cache.
- Tratt's specific warning is worth heeding: adding async/await to `snare` caused
  "code splitting, complex Mutex requirements, and memory leaks"; removing it
  dropped 41 dependencies and 20% of binary size for identical functionality.
  A single-threaded `poll(2)`/epoll loop is a legitimate design for this daemon —
  zmx does exactly that — and tokio is a choice, not a requirement.

### Go

**For**

- Fastest route to something working. Goroutine-per-session, `net.Listener` on a
  Unix socket, `net/http` + websockets in the stdlib orbit, one static binary,
  trivial cross-compilation.
- The bindings are written by Ghostty's own author, which is a good signal for
  tracking upstream API changes.
- [charmbracelet/wish](https://github.com/charmbracelet/wish) makes "serve this
  over SSH" close to free: an SSH server with sensible defaults and middleware,
  including a `bubbletea` middleware that wires a program to an SSH session's PTY
  with window-resize handled natively. If SSH access is a headline feature rather
  than a "let sshd do it" afterthought, this is a real advantage over Rust, where
  `russh` is a low-level building-block library.
- Precedent: [hauntty](https://github.com/seruman/hauntty) is a Go session daemon
  using ghostty-vt; [headless-terminal](https://github.com/montanaflynn/headless-terminal)
  is a Go CLI backed by libghostty-vt; agentapi is Go.

**Against**

- **cgo overhead**: roughly 30–40 ns per call (≈40 ns single-threaded on Go 1.21;
  Go 1.26 cut baseline overhead ~30% via optimized stack switching), versus ~1 ns
  for a native call. This is only a problem if we cross the boundary per byte or
  per cell. Feed the VT in large `[]byte` chunks and read back render state in
  batches and it disappears into the noise. It does mean the "iterate every cell
  across the FFI boundary each frame" design is off the table in Go — which is
  precisely the design the browser diff path wants.
- cgo also complicates cross-compilation and adds friction with the race detector
  and profiling. (`zig cc` mitigates the cross-compile part.)
- hauntty's answer is interesting: it **avoids cgo entirely** by compiling
  ghostty-vt to WASM and running it in a Go WASM runtime, mirroring
  `go-libghostty`'s interface. That trades FFI cost for WASM-runtime cost and
  removes the C toolchain from the build. Worth knowing; not obviously better.

### Zig

**For**

- **Zero FFI.** `libghostty-vt` is Zig; import it as a module. No bindings, no
  binding lag, no `unsafe` boundary, no cgo. Every capability lands the day
  upstream ships it.
- Smallest binaries, no runtime, no GC. For a daemon that sits resident for weeks
  holding N terminal states, that is aesthetically and practically appealing.
- **zmx proves it.** It is a working, shipped, libghostty-vt-based session
  persistence tool written in Zig 0.16 with a `poll(2)` loop and Unix sockets.
  The daemon half of werk is a solved problem in Zig.

**Against**

- The _serving_ half is not. We need HTTP, WebSocket, TLS, probably SSH, JSON, and
  auth. Zig 0.16 (April 2026) introduced `std.Io` — colorless async by passing an
  `Io` interface the way an `Allocator` is passed — but the only implementation
  shipping in stdlib is `std.Io.Threaded`, error handling in the interface is
  incomplete, and parts of the interface are unimplemented. Third-party
  [zio](https://github.com/lalinsky/zio) provides an io_uring-backed `std.Io`, but
  that's a young dependency for a load-bearing role.
- No SSH server library worth the name. We'd shell out or not offer SSH.
- Pre-1.0 churn is real ("Writergate" replaced the entire reader/writer stack in
  0.15/0.16). We'd be absorbing that churn in _our_ code, not just at a binding.

### TypeScript on Bun

**For**

- **One language for the whole product.** Daemon, CLI, TUI, web server, web
  frontend, and later a desktop shell. Six surfaces in one language is a large
  structural simplification, and plausibly the difference between one team and
  two.
- **`Bun.Terminal` exists.** A native PTY API with `write`/`resize`/`setRawMode`,
  built [in response to a feature request](https://github.com/oven-sh/bun/issues/22468)
  that cited "CLI dev tools / TUI apps need interactive PTY subprocesses" — our
  exact case. Windows ConPTY included. This was the single biggest hole in the
  TypeScript plan and it is now filled.
- **Distribution is genuinely best-in-class here.** Eight targets from one Linux
  runner, first-class asset embedding, and a production existence proof in
  [opencode](https://github.com/anomalyco/opencode) — a TUI + CLI + embedded web
  UI at 46–63 MB per platform, which is structurally the same product as werk.
  Go and Rust cross-compile as well or better but have no bundler-level story for
  **embedding another executable**, which is precisely what bundling git and ssh
  requires ([08-bundled-tooling.md](08-bundled-tooling.md)).
- **The serving surface is fine.** `Bun.serve` gives HTTP, WebSocket with native
  pub/sub topics, and HTML-import bundling that embeds the frontend in the binary
  ([11 §4](11-interfaces.md)). The usual argument for Rust here — that the
  ecosystem for websockets, HTTP and TLS is deepest there — is much weaker in
  2026 than it used to be.
- **Ink is the incumbent TUI framework for exactly this genre**, used by Claude
  Code and Gemini CLI.

**Against**

- **No published TypeScript binding reaches the snapshot API**, and the
  snapshot API is [01](01-libghostty-vt.md)'s entire argument for this project
  existing. So the binding is ours to write and maintain: a loader over the
  upstream WASM that reads struct layouts from `ghostty_type_json()`. It is
  small and it has been marshalled end to end once already, but it tracks a C
  API that is explicitly unstable and ships only from a rolling `tip` channel,
  and the snapshot format carries no compatibility guarantee across builds.
  That is accepted; the cost is an update policy nobody has set yet.
- **Native addons inside `--compile` are a live bug area** — mixed exports across
  multiple embedded NAPI modules, an unfixed Windows failure
  ([07 §4](07-packaging.md)). libghostty does not touch this — a `.wasm` is an
  embedded asset, not an addon, and a `--compile` executable with an embedded
  `.wasm` has been run with no `.wasm` on disk. OpenTUI's Zig core would be the
  only native addon in the binary, if it is used at all.
- **Size.** ~57 MB before anything, 100–150 MB with git and ssh embedded, against
  ~15 MB for Go and ~3 MB for Rust on the same job.
- **Signing is version-fragile.** Three separate macOS SIGKILL/invalid-signature
  regressions in 2026, the most recent fixed ten days before this research
  ([07 §5](07-packaging.md)). This is ongoing maintenance, not setup.
- **Windows sharp edges land squarely on a supervisor**: every `kill(signal)`
  is `TerminateProcess`, so graceful teardown has to go through the protocol;
  `AF_UNIX` works but only a Bun client reaches it, so daemon IPC probably wants
  a loopback TCP option; ConPTY re-encodes output rather than passing bytes
  through, which is awkward for a product about faithful terminal state. All
  three are measured in
  [`platforms.md`](../../packages/werk-poc/findings/platforms.md).
- **The latency floor** for a JS process holding N PTYs at high throughput is
  worse than a native one. Probably irrelevant given the "tap, not stage" design
  from [03](03-prior-art.md) — the fast path is a byte copy — but it should be
  measured rather than assumed.

**The native alternative, kept for comparison.** `ts-libghostty` over `bun:ffi`
reaches the same C API natively. `dlopen` of an embedded shared library inside
a compiled binary works,
[after a recent fix](https://github.com/oven-sh/bun/issues/30717). It costs a
prebuild matrix — the tarball's five targets plus a vendored `win32-x64` build,
with no `darwin-x64` build and no `bun:ffi` at all on `win32-arm64` in Bun
1.3.14 — so it is measured against the WASM route on identical calls rather
than proposed as the primary. On the one machine both ran, the WASM route was
the faster ([`m6.md`](../../packages/werk-poc/findings/m6.md)); whether that
holds elsewhere, and whether the matrix is worth carrying, remains a comparison
rather than a verdict.

## Recommendation

**TypeScript on Bun is the defensible default.** The principle that decides it
is that the VT work is the part every language does well, and what differs is
everything around it — and _everything around it_ here is six surfaces, a
placement layer and a distribution promise rather than a websocket server.
TypeScript is the better language for all of that.

**Three things must be verified before committing**, in this order, because any
one of them failing changes the answer:

1. **Does `Bun.Terminal` work inside `bun build --compile`?** Nobody documents it
   either way. Nothing else matters if this fails.
2. **Does our loader over the upstream WASM survive `--compile`**, and is it
   rich enough for two-stage reattach? The ABI has been marshalled from
   `ghostty_type_json()` once; the proposal turns that into an adapter and a
   corpus.
3. **Does the forwarded-Unix-socket transport hold up under a live PTY stream?**
   ([09 §0](09-remote-transport.md).) Language-independent, but it decides the
   architecture.

Those are three spikes, not three months, and
[`../proposals/00-stack-proof-of-concept.md`](../proposals/00-stack-proof-of-concept.md)
is the program that runs them. Do them before writing anything else.

**If they fail**, the fallback is **Go**, not Rust: `mitchellh/go-libghostty` is
written by Ghostty's own author, `creack/pty` is boring and works,
cross-compilation is trivial, `go:embed` handles bundling git and ssh, and the
binary is 15 MB instead of 150. The engine work carries across: hauntty already
runs the same upstream WASM inside Go through `wazero`, and the loader
knowledge is the same. The usual argument for Rust over Go — a deeper serving
ecosystem and richer bindings — matters little when the serving surface is a
websocket fan-out and the binding is a WASM loader. Rust is the right answer
only if per-cell diffing across the FFI boundary turns out to be on the hot path,
which the "tap, not stage" design specifically avoids.

Go is also the answer if **"working next week" beats "right in six months"**:
`wish` + `go-libghostty` + goroutines gets to a demo faster than anything else
here, cgo overhead is a non-issue if we batch, and hauntty and agentapi are both
existence proofs.

Whatever wins, the engine is the same bytes: upstream's freestanding WASM,
pinned by commit. Only a native route would bring the **Zig toolchain** into
the build.

## Sources

- [awesome-libghostty](https://github.com/Uzaaft/awesome-libghostty) · [libghostty-rs](https://github.com/uzaaft/libghostty-rs) · [go-libghostty](https://github.com/mitchellh/go-libghostty) · [libghostty-vt-node](https://github.com/coder/libghostty-vt-node) · [ghostty-web](https://github.com/coder/ghostty-web)
- [Some Reflections on Writing Unix Daemons — Laurence Tratt](https://tratt.net/laurie/blog/2024/some_reflections_on_writing_unix_daemons.html)
- [CGO Performance in Go 1.21 — Shane](https://shane.ai/posts/cgo-performance-in-go1.21/) · [directcgo](https://github.com/maxpoletaev/directcgo)
- [Zig 0.16 release notes](https://ziglang.org/download/0.16.0/release-notes.html) · [Async I/O in Zig 0.16, today](https://lalinsky.com/2026/05/11/async-io-in-zig-016-today.html) · [Writergate](https://github.com/ziglang/zig/pull/24329)
- [charmbracelet/wish](https://github.com/charmbracelet/wish) · [russh](https://github.com/Eugeny/russh)
- Bun: [`Bun.Terminal` reference](https://bun.com/reference/bun/Terminal) · [v1.3.5 release](https://bun.com/blog/bun-v1.3.5) · [executables docs](https://bun.sh/docs/bundler/executables) · [opencode](https://github.com/anomalyco/opencode). Full analysis in [07-packaging.md](07-packaging.md).
