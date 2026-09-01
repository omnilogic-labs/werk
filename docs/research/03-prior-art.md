# 03 — Prior art

> **Scope update (2026-09).** This document covers the terminal-multiplexer
> ancestry and remains accurate. The agent-orchestration wave, the vendor
> products, and the remote-compute providers — all of which the expanded scope
> now competes with or sits on top of — are in
> [13-landscape.md](13-landscape.md). Read this one for _how to build the
> primitive_; read that one for _whether the product is differentiated_.

Ordered by how close it is to what werk is trying to be. The first section is
the "read these before designing anything" list.

## Directly adjacent: libghostty-vt session persistence

Several people are building this right now. This is a validation, not a reason
to stop — none of them combine persistence + multi-session browsing + web + a TS
client — but we should not rediscover their lessons.

### zmx — [neurosnap/zmx](https://github.com/neurosnap/zmx)

Session attach/detach for the terminal, **Zig 0.16**, using libghostty-vt for
state restore. The single most relevant project.

- **Daemon per session**, not one daemon for all: "if a single session crashes or
  is under load it doesn't kill or bog the rest of your sessions." Each session
  gets its own Unix socket file; discovery is a directory listing.
- Socket dir resolution hierarchy worth copying verbatim:
  `ZMX_DIR` → `$XDG_RUNTIME_DIR/zmx` → `$TMPDIR/zmx-$UID` → `/tmp/zmx-$UID`,
  with `ZMX_DIR_MODE` / `ZMX_LOG_MODE` for permissions.
- **The key architectural insight**: "ghostty-vt doesn't sit in the middle of an
  active terminal session, it simply receives all the same data the client
  receives so it can re-hydrate clients." The VT is a _tap_ on the stream, not a
  stage in it. PTY→client stays a direct copy at dtach latency; PTY→VT runs in
  parallel and is only consulted on reattach. **Adopt this.**
- Daemon and client both use `poll(2)`. No async runtime.
- Deliberately no windows/tabs/splits — "that's the job of your window manager."
  Preserves native scrollback and copy/paste, which tmux breaks.
- Detach on `ctrl+\`, disableable via `ZMX_NO_DETACH_KEY`.
- Spinoffs: [zmosh](https://github.com/mmonad/zmosh) (adds auto-reconnect),
  [gmx](https://github.com/nicosuave/gmx) (Ghostty splits + zmx sessions).

### hauntty — [seruman/hauntty](https://github.com/seruman/hauntty)

Go daemon for persistent sessions, ghostty-vt **compiled to WASM** rather than
cgo (avoids the C toolchain; mirrors `go-libghostty`'s interface).

- **One daemon, many sessions**, auto-started on first attach/create/restore,
  with optional auto-exit when the last session dies.
- **Persists dead session state to disk on an interval (default 30s)** and
  supports `ht restore <name>` and pruning. This is the "snapshot as cache"
  model from [01](01-libghostty-vt.md) — restore gives you the screen, not the
  process.
- Read-only attach, multi-client attach, and **configurable resize arbitration
  policies** — a decision we will also have to make.
- Detach key `ctrl+;` by default.
- Author is explicit that it's a learning project; the _shape_ is what's useful.

### ghostty-snap — [ghostty discussion #12176](https://github.com/ghostty-org/ghostty/discussions/12176)

A reconnectable-terminal exploration: ~900 LOC server holding PTY + terminal
state, clients attach/detach. Its framed protocol is the design we should steal:

- `PTY_DATA` — raw output, the low-latency path
- `SNAPSHOT` — full VT state, sent **when the client lags**
- `VIEWPORT_DELTA` / `VIEWPORT_FULL` — binary dirty-row or full viewport updates

The adaptive rule: when network buffers fill, the server stops streaming raw
bytes and starts buffering _through the emulator_, then sends a snapshot once the
pipe clears. Input stays responsive and memory stays bounded regardless of
connection quality. Style-dictionary dedup + row hashing for the wire format.

The proposal was declined on contribution-policy grounds (AI-generated), but
Mitchell's reply is the headline: **"We're doing this ourselves using the binary
snapshot protocol."** Ghostty upstream intends to ship reconnectable terminals.
Plan for werk to be _complementary_ to that, not a race against it — our value is
multi-session management, the web surface, and the agent-oriented control plane,
not the transport.

### Others in this space

- [speedmux](https://news.ycombinator.com/item?id=47211795), openmux, vanish —
  libghostty-powered multiplexers, all young.
- [Trolley](https://github.com/weedonandscott/trolley) — "terminal emulator
  runtime for distributing TUI applications."

## Classic session persistence

### dtach / abduco

The minimalist position, and the correct baseline to measure against. **dtach is
a thin proxy, not an emulator**: it has no VT state at all, so reattach shows you
whatever the program redraws. `abduco` is the same idea, detach on `Ctrl+\`,
composed with `dvtm` when you actually want panes. Together they make the
argument that _session persistence and window management are separate programs_.

werk's entire reason to be more than dtach is the libghostty VT state. Be able to
articulate what that buys (correct reattach without a redraw, browsable content,
search, snapshots, semantic metadata) or just use dtach.

### shpool — [shell-pool/shpool](https://github.com/shell-pool/shpool)

Google-internal, now open source. **Rust.** "Think tmux, then aim... lower."

- Named sessions, `shpool daemon` subcommand holds subshells in a table.
- Maintains in-memory VT100 state to **redraw the screen on reattach** — exactly
  our mechanism, with a much weaker emulator.
- Explicit philosophy: "managing different terminals is the job of your display
  or window manager, not your session persistence tool." Does not break native
  scrollback or copy/paste.
- Ships `shpool-protocol` as a **separate crate** defining the client↔daemon
  protocol. Good structure to copy: the protocol is a versioned artifact, not an
  implementation detail.
- Injects a prompt prefix for known shells (bash/zsh/fish) so you know which
  session you're in. Nice touch; consider an OSC-based equivalent that doesn't
  mutate the user's prompt.

### tmux / GNU screen

The thing everyone compares to. Two things to take:

- **Control mode (`tmux -CC`)** is the canonical machine-readable control
  surface. A client sends newline-terminated commands on stdin; each produces a
  block on stdout: `%begin` … output … `%end` or `%error`, plus asynchronous
  `%`-prefixed notifications. iTerm2's native tmux integration is built entirely
  on it — tmux keeps running when iTerm2 quits, and `tmux -CC attach` restores
  the windows. This is the proof that "multiplexer as a protocol server with a
  native front-end" works, and it is the closest existing thing to what
  `werk` (TS client) ↔ `werkd` should be.
- **What to avoid**: tmux is in the middle of the stream, so tmux _and_ your
  terminal must both support every new terminal feature — a permanent bottleneck.
  It also replaces native scrollback with its own. zmx and shpool both explicitly
  reject this. So should we: stay a tap, not a stage.

### mosh — [USENIX ATC '12 paper](https://www.usenix.org/conference/atc12/technical-sessions/presentation/winstein)

Not a multiplexer, but the intellectual ancestor of the transport design. The
**State Synchronization Protocol** synchronizes _object state_ rather than a byte
stream: because SSP can diff any two states, it need not send every octet the
host produced, and can **modulate frame rate based on network conditions**.
Because both ends hold terminal state, the client can speculatively echo
keystrokes and later reconcile against the authoritative screen.

Read this paper. libghostty's snapshot + dirty-row render state give us the
primitives mosh had to build from scratch; the _policy_ (when to diff, when to
snapshot, how to pace frames) is what the paper teaches.

## Terminal-in-the-browser

### Zellij web client — [zellij.dev/documentation/web-client](https://zellij.dev/documentation/web-client.html)

The most directly instructive web design, from a Rust client/server multiplexer.

- **One web server per machine**, serving multiple sessions to multiple clients.
  Not one server per session. Easier administration.
- It reuses the existing Zellij _client_ code per connection as a translation
  layer between browser websockets and the server's IPC channels. Strong pattern:
  the web front-end is just another client speaking the same protocol.
- **Two websockets**: a terminal channel (stdin up, render commands down) and a
  separate control subchannel (resize, config changes, logs, session switching).
  Split deliberately to prevent head-of-line blocking. Adopt this.
- Sessions are **bookmarkable URLs**.
- Security model: HTTPS mandatory with a user-provided cert if listening on a
  public interface, and it cannot be disabled; token auth with tokens hashed in a
  local DB; session cookies are HttpOnly, and the login token itself is never
  stored in the browser; entirely opt-in. Documented limitations: no built-in
  rate limiting (put nginx in front), and **authenticated users are fully
  trusted** because the server only ever serves one Unix user's sessions on one
  machine.

That last point is the honest framing for werk too: _a web terminal is remote
code execution by design._ The auth boundary is the entire security model.

### sshx — [sshx.io](https://sshx.io/)

Rust server, collaborative terminals on an infinite canvas. Architecture: hybrid
Hyper service splitting **gRPC (Tonic)** for CLI sharing clients and **WebSocket
(Axum)** for browser listeners; core session logic kept independent of message
transport; end-to-end encryption with Argon2 + AES. The transport-independent
core is the structural lesson.

### VibeTunnel — [amantus-ai/vibetunnel](https://github.com/amantus-ai/vibetunnel)

Closest to werk's _stated use case_: "turn any browser into your terminal",
built by and for people running fleets of Claude Code sessions.

- Three parts: a macOS menu-bar app managing lifecycle, a **Node.js/TypeScript
  server** handling terminal sessions, and a Lit + **xterm.js** web frontend.
- `vt` is a **wrapper command** you prefix onto anything (`vt claude`) — exactly
  the `./bin/werk claude` ergonomic. It resolves shell aliases and manages
  session titles.
- Terminal-title management is used as the fleet-status mechanism: you see at a
  glance what each Claude instance is doing. We get this more robustly via
  libghostty's `TITLE_CHANGED` / `PROGRESS_REPORT` / notification effects.
- Security: multiple auth modes, localhost-only mode, or tunneling via Tailscale
  or ngrok. **Tailscale is the pragmatic answer to remote access** and probably
  belongs in our docs rather than in our code.

### ttyd / gotty / wetty

The previous generation: expose a shell over HTTP+WS. Simpler than us, no
persistence, worth knowing as the "why not just this" baseline.

## Agent-specific prior art

### agentapi — [coder/agentapi](https://github.com/coder/agentapi)

HTTP API for Claude Code, Codex, Goose, Aider, Amp, Gemini, Copilot, Cursor CLI.
The most relevant _semantic_ prior art, and a cautionary tale.

- Runs the agent in a PTY behind an **in-memory terminal emulator**, translates
  API calls into keystrokes and parses output back into messages.
- Message boundaries by **snapshot-and-diff**: snapshot before injecting a user
  message, treat subsequent terminal changes as agent output, treat later changes
  as updates to that message.
- Strips echoed input lines and trailing TUI chrome (`>`, `------`).
- Endpoints: `GET /messages`, `POST /message`, `GET /status` (`stable` |
  `running`), `GET /events` (SSE).
- The documented fragility: TUI updates break the chrome-stripping heuristics.

The lesson: **screen-scraping a TUI to recover semantics is brittle.** werk
should expose the raw session faithfully first, and layer semantics on signals
that are actually structured — OSC 133 command boundaries, OSC 9;4 progress, OSC
7 cwd, bell/notification effects — rather than on regexes over rendered text. But
an agentapi-shaped HTTP surface _on top of_ a werk session is an obvious and
valuable second-order product.

Coder is worth watching generally: they wrote `libghostty-vt-node`, `ghostty-web`,
and `agentapi`. They are assembling the same stack.

### Agent multiplexers (mostly macOS, mostly native UIs)

[Forge](https://github.com/rsml/forge) ("native macOS terminal multiplexer built
for parallel CLI agents"), [agterm](https://github.com/umputun/agterm),
[Mux0](https://github.com/10xChengTu/Mux0), [Factory Floor](https://github.com/alltuner/factoryfloor)
(worktrees per agent), [Supacode](https://github.com/supabitapp/supacode),
[Zentty](https://github.com/dedene/zentty). Nearly all are macOS-native GUIs on
libghostty. **The gap werk fills is the headless/remote/browser one** — none of
these help you check on a session from your phone.

## Recording formats

[asciinema](https://github.com/asciinema/asciinema) — **asciicast v3** is
newline-delimited JSON: a header line with terminal metadata, then 3-element
arrays of `[interval, code, data]` with _relative_ timestamps (v2 used absolute;
relative makes editing far easier), event codes including `o`utput, `i`nput,
`r`esize (`"{COLS}x{ROWS}"`), `m`arker, and a new `x` exit-status event.
`#`-prefixed lines are comments.

Since we hold the stream anyway, writing asciicast v3 alongside is nearly free
and gives us shareable, replayable sessions and a debugging artifact. Adopt the
format rather than inventing one.

## Sources

All links inline above. Curated index: [awesome-libghostty](https://github.com/Uzaaft/awesome-libghostty).
