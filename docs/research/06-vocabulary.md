# 06 — Vocabulary, escape sequences, and gotchas

Fluency list. If a design conversation uses a term here, everyone should know it.

## PTY and process control

| Term                                                 | Meaning / why it matters                                                                                                                                           |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **PTY master / slave** (`ptmx` / `pts`)              | The pair. `werkd` holds the master; the child gets the slave as its stdio. Holding the master open is _why_ detach works — the child never sees EOF.               |
| **Controlling terminal**                             | A session's terminal. Set with `ioctl(TIOCSCTTY)` after `setsid()`. Without it, `^C`, `^Z`, and job control silently don't work.                                   |
| **Session leader / process group / foreground pgrp** | The kernel's job-control structure. Signals from the tty (`SIGINT`, `SIGWINCH`) go to the _foreground process group_.                                              |
| **`setsid()`**                                       | New session, no controlling terminal. Used both to daemonize `werkd` and to set up each PTY child.                                                                 |
| **`TIOCSWINSZ` / `TIOCGWINSZ`**                      | Set/get window size. Setting it makes the kernel send `SIGWINCH`.                                                                                                  |
| **`SIGWINCH`**                                       | "Your terminal resized." Every resize path ends here.                                                                                                              |
| **`termios` / raw mode / `cfmakeraw`**               | Client-side: disable `ICANON`, `ECHO`, `ISIG` so keystrokes pass through unmangled. Must be restored on exit _and_ on panic, or you leave the user's shell broken. |
| **`ISIG`**                                           | When on, the tty turns `^C` into `SIGINT`. Our client must have it _off_ so `^C` reaches `claude`, not our client.                                                 |
| **Orphan / zombie / reaping / subreaper**            | See [04 §6](04-daemon-best-practices.md). `PR_SET_CHILD_SUBREAPER` on Linux; process groups on macOS.                                                              |
| **`CLOEXEC`**                                        | Every fd we don't intend the child to inherit must have it. Leaking the daemon's socket into `claude` is a real bug class.                                         |

## Terminal emulation

| Term                                                                             | Meaning                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **VT / ANSI escape sequences**                                                   | The byte language. CSI (`ESC [`), OSC (`ESC ]`), DCS (`ESC P`), SGR (colors/styles as CSI `m`).                                                                                                                                |
| **Active screen / viewport / scrollback / history**                              | libghostty's snapshot format distinguishes these explicitly: active-screen pages make the terminal renderable, history pages are older scrollback ordered newest→oldest.                                                       |
| **Reflow**                                                                       | Rewrapping wrapped lines on resize. A major reason to use a real emulator instead of a byte log.                                                                                                                               |
| **Grapheme cluster**                                                             | A user-perceived character; may be several codepoints and occupy 1–2 cells. `libghostty-rs` exposes grapheme extraction from cell iterators.                                                                                   |
| **Dirty tracking**                                                               | Which rows changed since last frame. libghostty tracks it globally and per row. Our diff-to-browser path is built on it.                                                                                                       |
| **Alternate screen** (`CSI ?1049h/l`)                                            | The full-screen buffer TUIs switch into. `claude`, `vim`, `top` all use it. Reattach must restore the _mode_, not just the content.                                                                                            |
| **Bracketed paste** (`?2004`)                                                    | Wraps pasted text so programs can distinguish it from typing. Must be forwarded correctly from the browser or paste behaves bizarrely in `claude`.                                                                             |
| **Mouse modes** (`?1000` click, `?1002` drag, `?1003` any, `?1006` SGR encoding) | Must be tracked so the browser knows whether to send mouse events and in which encoding. libghostty has a mouse encoder for this.                                                                                              |
| **Kitty keyboard protocol** (`CSI > u`)                                          | Modern disambiguated key reporting. Ghostty supports it; the browser client must too, or modified keys get lost. libghostty's `KeyEncoder` handles the encoding.                                                               |
| **Synchronized output** (`?2026`)                                                | "Don't render until I say done." Prevents tearing on partial frames — relevant when we're the one pacing frames to a browser.                                                                                                  |
| **DA / DSR / XTVERSION**                                                         | Device attributes / status report / version queries. Programs _ask questions_ and block for answers, so our VT must answer them — libghostty's `WRITE_PTY` effect exists precisely for this. Fail to wire it up and TUIs hang. |

## OSC sequences worth knowing by number

| Sequence        | Meaning                                                       | Use in werk                                                                                                                                                                                                                                                                                                                                   |
| --------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **OSC 0 / 2**   | Set window/icon title                                         | Session title in `werk list` and the web UI                                                                                                                                                                                                                                                                                                   |
| **OSC 7**       | Report cwd                                                    | "Which repo is this session in"                                                                                                                                                                                                                                                                                                               |
| **OSC 8**       | Hyperlinks                                                    | Clickable links in the web renderer                                                                                                                                                                                                                                                                                                           |
| **OSC 9 / 777** | Desktop notification                                          | "This agent needs you"                                                                                                                                                                                                                                                                                                                        |
| **OSC 9;4**     | Progress report                                               | Progress bars in the session browser                                                                                                                                                                                                                                                                                                          |
| **OSC 52**      | Clipboard read/write                                          | Copy from a remote session; **a security decision** — a program can read your clipboard                                                                                                                                                                                                                                                       |
| **OSC 133**     | Semantic prompt / [FTCS](https://docs.otty.sh/vt/osc/osc-133) | `A` prompt start, `B` prompt end / input start, `C` command start, `D` command end + exit status. Enables command boundaries, jump-to-prompt, exit-status marks, and structured "what happened" without scraping. Supported by Ghostty, iTerm2, kitty, WezTerm; tmux notably [does not forward it](https://github.com/tmux/tmux/issues/3064). |
| **OSC 1337**    | iTerm2 extensions (cwd, clipboard, images)                    | Interop                                                                                                                                                                                                                                                                                                                                       |

## The TERM problem

Non-obvious and it will bite. The child's `TERM` tells it which escape sequences
it may emit, resolved through terminfo **on the machine running the child**.

- If werk sets `TERM=xterm-ghostty` to unlock everything libghostty supports, the
  child needs Ghostty's terminfo installed locally or `tput`/ncurses programs
  fail. This is the single most-reported Ghostty-over-SSH problem.
- tmux ships `screen-256color`/`tmux-256color` for this reason, which is _also_ a
  perennial source of "colors are wrong in tmux" complaints.
- Safe default: `xterm-256color`, plus `COLORTERM=truecolor`, with an opt-in for a
  richer `TERM` when we can verify the terminfo entry resolves.
- Consider shipping our own terminfo entry (`werk`) that honestly describes what
  we support, and installing it into `~/.terminfo` on first run.

## Concepts to borrow by name

- **State Synchronization Protocol (SSP)** — mosh. Sync _object state_, not a byte
  stream; diff any two states; modulate frame rate to conditions.
- **Speculative / predictive local echo** — mosh. Both ends hold terminal state,
  so the client can predict a keystroke's effect and reconcile later. Feasible for
  us because ghostty-web runs the same emulator in the browser.
- **Control mode** — tmux `-CC`. `%begin`/`%end`/`%error` blocks + `%`-prefixed
  async notifications on one stream.
- **Tap, not stage** — zmx. The VT receives a copy of the stream for rehydration;
  it is not in the latency path. It applies twice in werk: the VT taps the byte
  stream, and the fleet aggregator taps the daemons.
- **Snapshot as cache, never source of truth** — [01](01-libghostty-vt.md).
- **Front-end / back-end split** — Tratt. One user binary, one daemon, a Unix
  socket, no signals.
- **Build here, activate there** — Nix's `--target-host`. The clean separation of
  "where the work is prepared" from "where it runs".
- **Expose everything as one more ssh host** — DevPod. Whatever is underneath —
  a container, a k8s pod, a cloud VM — the user gets an ssh host. The pattern
  that makes heterogeneous placements feel like one thing.
- **Peek before attach** — Claude Code's Agent view. `Space` shows and replies
  inline; `Enter` commits to the session. The single most transferable UX pattern
  in [13-landscape.md](13-landscape.md).
- **Attach means a real terminal** — Overmind. Not a log tail, not a summary view.

## New vocabulary: placement and transport

| Term                                                   | Meaning / why it matters                                                                                                                                                                                       |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Placement**                                          | _Ours._ Where a workspace physically lives: `local`, `ssh:host`, `container:host`. The concept that makes "run it somewhere" a parameter. See [`../product/01-object-model.md`](../product/01-object-model.md) |
| **Bootstrap**                                          | Getting werk's own binary onto a machine it has never run on. Detect platform → push a version-pinned payload → run it detached. [09 §1](09-remote-transport.md)                                               |
| **Unix-socket forwarding**                             | `ssh -L local_socket:remote_socket` — OpenSSH ≥6.7. **If an argument contains a `/`, it's a socket path, not a port.** The finding that lets werk speak its local protocol to a remote daemon unchanged        |
| **`ControlMaster` / `ControlPath` / `ControlPersist`** | ssh connection multiplexing across separate processes. `%C` hashes the connection params to stay under the 104-byte socket path limit. **Unavailable on Windows.** An optimisation, never a foundation         |
| **`ServerAliveInterval` / `ServerAliveCountMax`**      | The only reliable way to detect a dead ssh peer. Travels inside the encrypted channel, unlike TCP keepalive. Every liveness check must be bounded by these                                                     |
| **`StrictHostKeyChecking=accept-new`**                 | Accepts a host key on first contact, **still hard-fails if a recorded key changes**. The right default for hosts werk provisions. Never `=no`                                                                  |
| **`MaxSessions`**                                      | Server-side cap on concurrent channels per ssh connection. **Default 10**                                                                                                                                      |
| **`dial-stdio`**                                       | What `DOCKER_HOST=ssh://` actually runs: `ssh host -- docker system dial-stdio`, turning one process's stdio into an Engine API tunnel                                                                         |
| **Connection hijacking**                               | Docker's mechanism for turning an HTTP exec request into a raw duplex stream. With `Tty:false`, output is multiplexed behind an 8-byte `[type,0,0,0,len32]` header; with `Tty:true` it's raw                   |
| **`--init` / tini**                                    | PID 1 has no default signal handlers and does not reap zombies. Non-negotiable for a container holding a multi-day agent session                                                                               |
| **microVM**                                            | Firecracker/Cloud Hypervisor. ~125ms to guest init with a real kernel boundary, against tens of ms–2s for a warm container and 30–60s for a cloud VM                                                           |
| **Seatbelt / bubblewrap / Landlock**                   | Local isolation without a container runtime. Claude Code's own sandbox uses the first two; Landlock lets a process _self_-restrict, only ever tightening — good defence-in-depth inside a container            |

## New vocabulary: git orchestration

| Term                                          | Meaning / why it matters                                                                                                                                                                                                  |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`git bundle`**                              | A repo as a single file — or a **stream**. `git bundle create - --all \| ssh host 'git bundle unbundle -'` works because the reader is purely sequential. Read-only: **you cannot push into a bundle**                    |
| **`git stash export` / `import`**             | New in **git 2.51**. A documented interchange format for stash entries, and `gitfaq(7)`'s own answer to "how do I sync a working tree across systems". Preserves the staged/unstaged split. **No competitor uses it yet** |
| **`git stash create`**                        | Makes a stash-shaped commit and prints its SHA **without touching any ref**. Parent 1 = `HEAD`, parent 2's tree = the index, own tree = the working tree. An ordinary pushable object                                     |
| **`receive.denyCurrentBranch=updateInstead`** | Lets a push update a _checked-out_ branch. Refuses if the target tree differs from `HEAD` at all — override with a `push-to-checkout` hook running `git read-tree -u -m --reset`                                          |
| **Promisor remote / partial clone**           | `--filter=blob:none` defers object fetch — and **requires the origin to stay reachable**. `log -p`, `blame`, `bisect` all error offline. Avoid                                                                            |
| **Prunable / locked worktree**                | A worktree whose directory was removed is `prunable`. `git worktree lock` protects one from `prune` racing an in-use workspace                                                                                            |
| **`git check-ref-format --branch`**           | The authority on legal branch names. **Shell out to it** rather than reimplementing the rules                                                                                                                             |
| **`git replay`**                              | Headless rebase that **never touches the working tree or index** — so it works on a bare repo. Still explicitly experimental in 2.55                                                                                      |
| **commit-graph `--changed-paths`**            | Bloom filters for path-limited history. `git commit-graph write --changed-paths --reachable` after transfer speeds `log -p -- <file>`, which agents run constantly                                                        |
| **reftable**                                  | The new ref backend. Opt-in via `git init --ref-format=reftable`; default in Git 3.0, which has not shipped                                                                                                               |

## New vocabulary: packaging

| Term                         | Meaning / why it matters                                                                                                                                                                                  |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`bun build --compile`**    | Bun runtime + bundled JS as a length-prefixed trailer: appended to ELF, a `.bun` PE section, a `__BUN` Mach-O segment                                                                                     |
| **`$bunfs`**                 | The virtual path embedded assets resolve to. **Readable in memory, not spawnable** — an embedded executable must be written to a real path and `chmod +x` first                                           |
| **`Bun.Terminal`**           | Bun's native PTY API (v1.3.5 POSIX, v1.3.14 Windows ConPTY). Replaces `node-pty`                                                                                                                          |
| **`--bytecode`**             | JSC unlinked bytecode precompiled at build time. 1.4–2× startup, 2–8× size, **pinned to the exact Bun version**, and not obfuscation                                                                      |
| **`LC_CODE_SIGNATURE`**      | The Mach-O load command Bun has repeatedly mis-sized after appending its trailer — the root of three separate 2026 SIGKILL regressions                                                                    |
| **Authenticode stripping**   | `signtool` appends to the end of a PE, where Bun's trailer lives. Bun ≥1.2.23 strips any prior signature before appending                                                                                 |
| **Rename-aside self-update** | Windows locks a running exe. Rename it to `.old`, move the new one in, delete `.old` lazily on next launch                                                                                                |
| **Sidecar**                  | Tauri's term for an external binary bundled with the app, named per target triple. How a desktop shell reuses the compiled Bun binary — and **each one must be separately signed and notarised on macOS** |

## Library shortlist by role

Organised by the language options in [02](02-language-choice.md). The Rust, Go
and Zig lists apply if the fallback is taken.

**TypeScript on Bun** (the current leading option):

| Need             | Library                                                                                                                     |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------- |
| PTY              | **`Bun.Terminal`** — native, no addon                                                                                       |
| HTTP / WS        | **`Bun.serve`** — routes, native WS pub/sub topics, HTML-import bundling. Hono only if the route count grows                |
| VT state         | `libghostty-vt-node` (thin — no render state), or a `bun:ffi` shim over `libghostty-vt.a`, or `@xterm/headless`             |
| TUI              | **Ink** (React; used by Claude Code and Gemini CLI), or **OpenTUI** (Zig core, prebuilt native binaries — `--compile` risk) |
| CLI              | **citty** or `util.parseArgs`. **Not oclif** — it introspects its own directory at runtime                                  |
| Browser terminal | **`@xterm/xterm` v6** + `addon-webgl` + `addon-serialize`; **ghostty-web** worth a spike                                    |
| Docker           | **`dockerode`** — solves hijacking, multiplex framing, resize. Smoke-test under Bun                                         |
| Frontend         | Svelte 5 or Solid (smallest, best per-widget updates); React if Ink familiarity wins. Tailwind v4 + copy-paste components   |
| Names            | **`human-id`** — `adjective+noun+verb`, 15M pool, actively maintained                                                       |
| Desktop, later   | **Tauri v2**, the compiled binary as a signed sidecar                                                                       |
| Notifications    | **ntfy.sh** by default; a webhook for teams                                                                                 |

**Rust daemon**: `tokio`, `axum`, `tokio-tungstenite`, `tower-http`, `portable-pty`
or `pty-process`, `rustix`/`nix`, `libghostty-vt` (Uzaaft), `tracing`, `clap`,
`serde`, `russh`, `napi-rs`.

**Go daemon**: `mitchellh/go-libghostty`, `creack/pty`, `charmbracelet/wish`,
`gorilla/websocket`, `bubbletea`, stdlib `net/http`, `go:embed` for bundling git
and ssh.

**Zig daemon**: libghostty-vt directly, `std.Io` (0.16+) or
[zio](https://github.com/lalinsky/zio), plus hand-rolled HTTP/WS.

**Formats**: [asciicast v3](https://docs.asciinema.org/manual/asciicast/v3/) for
recordings; libghostty `GHOSTSNP` for state snapshots; JSON-RPC 2.0 or NDJSON for
control.

## Sources

- [OSC 133 — Contour](https://contour-terminal.org/vt-extensions/osc-133-shell-integration/) · [OSC 133 — FTCS](https://docs.otty.sh/vt/osc/osc-133) · [WezTerm shell integration](https://wezterm.org/shell-integration.html) · [Shell integration in Windows Terminal](https://devblogs.microsoft.com/commandline/shell-integration-in-the-windows-terminal/)
- [Mosh: An Interactive Remote Shell for Mobile Clients (USENIX ATC '12)](https://www.usenix.org/conference/atc12/technical-sessions/presentation/winstein)
- [iTerm2 tmux integration](https://iterm2.com/documentation-tmux-integration.html)
- [`gitfaq(7)`](https://git-scm.com/docs/gitfaq) · [`git-stash`](https://git-scm.com/docs/git-stash) · [`ssh_config(5)`](https://man.openbsd.org/ssh_config) · [Bun executables](https://bun.sh/docs/bundler/executables)
- [asciicast v3](https://docs.asciinema.org/manual/asciicast/v3/)
