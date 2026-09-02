# 05 — Control surfaces: the design space

Not a design. A map of the decisions, with what prior art chose and why.

---

## A. The big architectural fork: one daemon or one per session

|                                                            | One daemon, N sessions         | One daemon per session                                                                   |
| ---------------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------- |
| Who does it                                                | tmux, shpool, zellij, hauntty  | **zmx**                                                                                  |
| Discovery                                                  | Ask the daemon                 | List sockets in a directory                                                              |
| Blast radius                                               | One crash/OOM kills everything | Isolated: "if a single session crashes or is under load it doesn't kill or bog the rest" |
| Cross-session features (browse, search-all, global web UI) | Natural                        | Needs a separate coordinator                                                             |
| Memory                                                     | Shared runtime, one process    | N processes, N runtimes                                                                  |
| Upgrade                                                    | One restart affects all        | Per-session, gradual                                                                     |

werk wants both isolation _and_ cross-session browsing, so consider the hybrid:
**session daemons own PTYs and VT state; a separate, restartable `werk serve`
process discovers them by scanning the socket directory and fans out to the web.**
The web server then holds no session state and can crash freely. This is close to
Zellij's "one web server per machine" combined with zmx's isolation.

The cost is a second hop in the data path (session daemon → web server → browser).
Given the browser path is already the slow path and the fast path is a local
attach, that's probably acceptable — but measure before committing.

There is a third dimension the two-column table misses: **placement**. werk runs
a daemon _per machine_, so whichever way this fork is resolved locally, something
has to aggregate across machines as well — see
[09-remote-transport.md](09-remote-transport.md) and
[12-placement-backends.md](12-placement-backends.md). The `werk serve` process
above is the natural home for that aggregation, which makes the hybrid look
better rather than worse.

## B. Invocation ergonomics

`./bin/werk claude` is the right feel (VibeTunnel's `vt claude` proves it), with
one real problem: **flag collision.** `werk claude --help` is ambiguous, and
`werk --list` vs a program literally named `--list` is a rule you have to state.
Options:

- `werk run -- claude --dangerously-skip-permissions` — unambiguous, verbose.
- First non-flag token ends werk's own parsing (`clap`'s `trailing_var_arg` +
  `allow_hyphen_values`). `werk claude --foo` works; `werk --list` works. This is
  the git/`env`/`nice` convention and is what users expect.
- Both: bare form for the common case, `run --` when you need to be explicit.

Also decide early: does `werk claude` **attach a new session** or **reattach if
one already exists for this cwd+command**? The cwd-keyed variant is very pleasant
for agent work ("`werk claude` in this repo always gets me back to my session")
but surprising when you actually wanted two. Suggest: explicit `-n/--new` and
`--name`, with a documented default.

Environment to set for the child: `WERK_SESSION` (id), `WERK` (socket path) so
nested invocations and hooks can find us — and so `werk` can refuse to nest
accidentally.

## C. Detach key

The genuinely hard UX problem, because our primary payload is `claude`, a TUI
that wants nearly every control key.

Prior art: tmux `Ctrl-b` prefix; screen `Ctrl-a`; **zmx `Ctrl-\`** (SIGQUIT's key,
rarely used by TUIs); **hauntty `Ctrl-;`**; abduco `Ctrl-\`.

Recommendations:

1. Default to something a TUI won't claim — `Ctrl-\` has the best track record.
2. **Always provide an out-of-band escape**: `werk detach <id>` from another
   terminal, and detach-on-terminal-close. zmx supports disabling the key entirely
   (`ZMX_NO_DETACH_KEY`) and relying on these; that option must exist.
3. Make it configurable, and make the binding **visible** — a status line or an
   OSC-set title suffix is friendlier than shpool's approach of injecting a prefix
   into the user's shell prompt (which doesn't work for a TUI anyway).
4. Consider requiring a double-tap or a prefix+key so a single stray keystroke
   never detaches mid-thought.
5. Escape hatch: a literal-next key (tmux's `prefix prefix`) to send the detach
   key through to the child.

## D. Client ↔ daemon protocol

Take the shape from tmux control mode and Zellij, the framing from ghostty-snap.

**Two channels, not one.** Zellij split its browser connection into a terminal
channel and a control subchannel "to prevent blocking and improve performance."
The same applies to the local socket: bulk PTY bytes must not sit behind a
`list-sessions` response, and a control notification must not wait behind a
screenful of output.

**Two encodings.** Control messages as newline-delimited JSON (trivial from
TypeScript, greppable, easy to log). Data as length-prefixed binary frames
(`PTY_DATA`, `SNAPSHOT`, `VIEWPORT_DELTA`, `VIEWPORT_FULL`, `RESIZE`, `INPUT`).

**tmux control mode is the reference for the request/response discipline**: each
command produces exactly one block — `%begin` / output / `%end`-or-`%error` — plus
asynchronous `%`-prefixed notifications interleaved. It's ugly on the wire but the
_semantics_ (correlated responses + out-of-band events on one stream) are exactly
what a client needs, and it's what iTerm2's tmux integration is built on. JSON-RPC
2.0 with ids + notifications gives the same semantics with a spec and off-the-shelf
TS libraries.

**Version the handshake** and ship the protocol as its own versioned artifact
(shpool ships `shpool-protocol` as a separate crate). See [04 §9](04-daemon-best-practices.md).

## E. Web surface

The web surface spans every machine in the fleet, not just the one it runs on,
which makes the security discussion below more load-bearing rather than less: the
blast radius of one authenticated session is code execution on every machine werk
can reach.

**Rendering.** The browser runs the same libghostty build as the daemon, loaded
from upstream's freestanding WASM, and receives terminal state as `GHOSTSNP`
bytes rather than as re-emitted escape sequences. **The browser then runs the
same emulator as the daemon** — the client-side state and the server-side state
are the same implementation, which is what makes mosh-style speculative echo and
diff reconciliation tractable instead of a research project. What _draws_ that
state is open: [ghostty-web](https://github.com/coder/ghostty-web) is the only
existing renderer over Ghostty's VT but pins a December 2025 Ghostty behind a
private patch, so the routes are rebasing it onto the pinned upstream artifact
or writing our own. xterm.js cannot be cut down to a renderer over foreign
state — its renderers read its own buffer — so it is not on that list. The
options are laid out in
[`../proposals/00-stack-proof-of-concept.md`](../proposals/00-stack-proof-of-concept.md) §3.

**Transport.** Two websockets (terminal + control), per Zellij. Session URLs
should be bookmarkable.

**Security — this is the part to get right.** A web terminal is remote code
execution by design; the auth boundary _is_ the security model. Zellij's bar,
which we should meet or exceed:

- Mandatory HTTPS with a user-supplied cert when listening on anything but
  loopback, **not disableable**.
- Token auth, tokens stored hashed; only a session token in an HttpOnly cookie, so
  JS can't read the credential.
- Entirely opt-in — `werk serve` never starts implicitly.
- No built-in rate limiting; document "put nginx in front" for untrusted networks.
- Honest threat model: once authenticated, a user has full access to that Unix
  user's sessions on that machine.

The obvious default is **loopback-only, no TLS needed, printed one-time token**.
Reaching it from elsewhere is the unsolved part: VibeTunnel documents a mesh VPN
(Tailscale) or an SSH tunnel and builds nothing, which is the cheapest option and
also the one that does least for a user on a phone.

## F. SSH surface

Three genuinely different options:

1. **Don't write an SSH server.** Let `sshd` do authentication, and make
   `werk attach` the thing it runs — as a `ForceCommand`, an
   `authorized_keys` `command=`, or the user's login shell. Zero new auth code,
   zero host-key management, inherits every hardening the box already has.
   `ssh box werk attach my-session` just works today. This is the strongest
   option by some distance: [09](09-remote-transport.md) finds that forwarding
   the daemon's Unix socket over ssh removes the need for a remote protocol
   entirely.
2. **Embed an SSH server.** Go: [wish](https://github.com/charmbracelet/wish)
   makes this genuinely easy (middleware model, PTY and resize handled). Rust:
   [russh](https://github.com/Eugeny/russh) is a low-level building-block library —
   more work. Buys you: a separate port with its own key-based ACL, no system user
   needed per client, session routing by SSH username (`ssh werk@box -t
my-session`). Costs you: you now own an SSH implementation's security.
3. **Mosh-style UDP.** Only if roaming/flaky-network is a headline requirement.
   The libghostty snapshot protocol gives us most of what mosh's SSP provides, so
   this is more tractable than it used to be — but it's a whole second transport.

Recommendation: **start with (1)**, design the protocol so (2) is additive.

## G. Programmatic / agent surface

This is where werk can be more than "tmux with better reattach."

- **HTTP + SSE**, agentapi-shaped: `GET /sessions`, `POST /sessions`,
  `GET /sessions/:id/screen` (plain or HTML via libghostty's formatter),
  `POST /sessions/:id/input`, `GET /events` (SSE). agentapi's own set is
  `/messages`, `/message`, `/status` (`stable`|`running`), `/events`.
- **Do not screen-scrape for semantics.** agentapi's documented fragility is that
  TUI changes break its heuristics for stripping echoed input and input-box
  chrome. We have better signals from libghostty effects (see [01](01-libghostty-vt.md)):
  title (OSC 0/2), cwd (OSC 7), progress (OSC 9;4), desktop notification (OSC
  9/777), bell — plus OSC 133 prompt/command boundaries where the program emits
  them. Build the semantic layer on those; fall back to text diffing only where
  you must, and label it as best-effort.
  - Worth tracking: there are open Claude Code issues requesting OSC 133 emission
    ([#32635](https://github.com/anthropics/claude-code/issues/32635),
    [#22528](https://github.com/anthropics/claude-code/issues/22528),
    [#26235](https://github.com/anthropics/claude-code/issues/26235)). If that
    lands, the semantic layer gets dramatically better for our main use case.
- **MCP server.** Since the primary payload is `claude`, exposing werk as an MCP
  server (list sessions, read screen, send input, wait for idle) lets one agent
  supervise others. agentapi is explicitly used this way.
- **Notifications out.** Bell/notification/progress effects → webhook, push, or a
  `werk watch` that blocks until a named session needs attention. For a fleet of
  agents, "tell me which one is waiting on me" is the actual product.

## H. Multi-client and resize arbitration

Unavoidable once the web surface exists: a terminal has one size, and two clients
may disagree.

Policies in the wild: tmux uses the **smallest** attached client (with
`window-size` options to change this); hauntty exposes **configurable resize
arbitration policies**; zmx doesn't document one.

Options: smallest-wins (safe, everyone sees everything); first/primary-wins
(others letterbox or scroll); per-client reflow (impossible — the child process
has one `TIOCSWINSZ`). Also decide: **read-only attach** (hauntty has it) is
valuable for "watch what the agent is doing" and should probably be the default
for extra web viewers.

Related: which client's input reaches the PTY? Simplest defensible rule — all
writable clients' input is merged, read-only clients' is dropped, and the UI shows
how many clients are attached.

## I. What `werk list` should show

Because we hold VT state, `list` can be much better than tmux's. Available
essentially for free: title, cwd, last-activity timestamp, exit status if dead,
"needs attention" (bell/notification since you last looked), progress percentage,
and **a rendered thumbnail of the last N lines** via the plain-text formatter.
For a fleet of `claude` sessions that last one is the feature.

## J. Alternatives to the whole premise, worth considering once

- **Just use dtach + an existing web terminal.** If the VT state doesn't buy
  enough, this is a weekend instead of a quarter. Write down what it buys.
- **Be a library, not a shell.** Ship the session core and let people embed it;
  `werk` becomes one thin front-end among several.
- **Let Ghostty do it.** Mitchell: "We're doing this ourselves using the binary
  snapshot protocol." If upstream ships reconnectable sessions, werk's value must
  be the _fleet management_ layer (browse, search, notify, web, agent control),
  not the transport. Design so that's where the code lives.
- **Sessions as files.** A per-session directory with a FIFO for input, a log for
  output, and a JSON status file — scriptable by anything, no protocol at all.
  Crude, but a genuinely useful secondary surface and trivial to add.
- **Record everything.** Write [asciicast v3](https://docs.asciinema.org/manual/asciicast/v3/)
  alongside every session. Nearly free given we hold the stream, and it turns
  every session into a shareable, replayable artifact plus a golden-test corpus.

## Sources

Inline above; see also [03-prior-art.md](03-prior-art.md).
