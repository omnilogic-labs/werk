# 01 — What libghostty-vt actually gives us

`libghostty-vt` is the terminal core extracted from [Ghostty](https://github.com/ghostty-org/ghostty)
as a zero-dependency C API (it does not even require libc). Written in Zig,
consumed via `include/ghostty/vt.h`. Reference implementation:
[ghostling](https://github.com/ghostty-org/ghostling), a minimum-viable terminal
emulator in a single C file. API docs: <https://libghostty.tip.ghostty.org>.

Per the project's own framing it handles _VT sequence parsing_, _terminal state
management_ (cursor, styles, reflow, scrollback), and _renderer state_ — and
explicitly not rendering, fonts, or PTY management. We supply the PTY and the pixels.

Everything below describes the C API. werk reaches it through upstream's own
freestanding WebAssembly build of the library — zero imports, the whole API
exported — with a loader of our own, the same bytes in the daemon and the
browser. That route exists because no published binding exposes the two-stage
`READY`-then-history decode described in the next section, which is the single
most valuable thing in this document. The binding landscape is in
[02](02-language-choice.md); the loader and how it is exercised are in
[`../proposals/00-stack-proof-of-concept.md`](../proposals/00-stack-proof-of-concept.md).

## API groups (from `vt.h` on `main`)

| Header                                  | Group                                            | Relevance to werk                                   |
| --------------------------------------- | ------------------------------------------------ | --------------------------------------------------- |
| `terminal.h`                            | Terminal — full emulator state                   | **Core.** One instance per session.                 |
| `snapshot.h`                            | Encode / incrementally restore terminal state    | **The whole ballgame.** See below.                  |
| `render.h`                              | Render state with dirty tracking                 | **Core.** Feeds the web client diffs.               |
| `key.h`                                 | Key event → escape sequence encoding             | Browser keyboard → PTY bytes.                       |
| `mouse.h`, `focus.h`                    | Mouse / focus event encoding                     | Browser mouse → PTY bytes.                          |
| `search.h`                              | Search terminal contents incl. scrollback        | "Find the session where claude asked me something." |
| `osc.h`, `sgr.h`                        | Standalone OSC / SGR parsers                     | Useful outside a full terminal.                     |
| `paste.h`                               | Paste with validation + bracketed-paste encoding | Web paste safety.                                   |
| `formatter`                             | Render contents as plain text / VT / HTML        | `werk list` previews, log export, debugging.        |
| `unicode`, `allocator`, byte-stream I/O | Utilities                                        | Custom allocator = per-session arena accounting.    |

Key entry points:

```
ghostty_terminal_new / _free / _reset / _resize
ghostty_terminal_vt_write / _vt_write_until_ground
ghostty_terminal_get / _set / _get_multi          # options + state queries
ghostty_terminal_grid_ref / _grid_ref_track       # stable refs into the grid
ghostty_terminal_compress / _compression_activity # scrollback compression (caller-driven)
ghostty_terminal_continuation_write / _alloc / _buf
```

## The snapshot API is why this project is possible

`snapshot.h` defines a versioned, CRC-protected binary format for the complete
state of a terminal:

```
"GHOSTSNP" magic (8B) + version (u16)
  then CRC32C-protected records, in strict order:
  TERMINAL      terminal-wide state + screen count
  SCREEN        active-screen manifest        (per screen)
  PAGE          active screen rows            (per manifest)
  CONTINUATION  unfinished VT/UTF-8 input, or ground
  READY         <- empty marker: everything above is enough to render and resume
  HISTORY       scrollback manifest, newest-to-oldest
  PAGE          older screen rows
  FINISH        <- empty marker: end of snapshot
```

```
ghostty_snapshot_encode / _encode_alloc / _encode_buf
ghostty_snapshot_decoder_new / _new_buf / _decode / _ready / _next / _free
```

Why this matters, concretely:

1. **`READY` gives us a two-stage reattach.** Decode up to `READY` and you can
   paint the viewport _immediately_; then `_next()` pulls history pages one at a
   time, newest-first, and prepends them. A reattaching client is interactive
   before the scrollback has finished streaming. This is the correct UX and we
   get it for free.
2. **`CONTINUATION` preserves a half-parsed escape sequence.** Detaching
   mid-sequence — which absolutely happens when you interrupt a TUI mid-frame —
   is not corrupting.
3. **State survives the daemon.** Snapshot to disk on a timer and on SIGTERM,
   and a session can outlive a `werkd` restart or a crash. tmux cannot do this;
   when the tmux server dies, everything dies. This is a genuine differentiator,
   and it is the thing to protect in the design. (The PTY child still dies with
   the daemon — you get the _screen_ back, not the process. See "what snapshot
   does not do".)

   It is worth most on the machines you are not sitting at. A build box that
   reboots overnight and gives you back the screen and the scrollback is the
   difference between "what did it say before it died" and nothing at all — see
   the read-only-corpse journey in
   [`../product/02-journeys.md`](../product/02-journeys.md) §9.

4. **It is a wire format, not just a file format.** The reader/writer callback
   interface (`GhosttyReader`/`GhosttyWriter`) means the same encoder feeds a
   file, a socket, or a websocket. This is exactly what the `ghostty-snap`
   exploration did (see [03-prior-art.md](03-prior-art.md)).

Caveat, stated in the header: _"Snapshot format version 1 is a work in progress
and does not yet carry a binary-compatibility guarantee."_ For on-disk
persistence we must version our own container and be willing to discard
snapshots written by a different libghostty build. Treat persisted snapshots as
a **cache, never as the source of truth.**

## Render state: designed for exactly our threading model

From `render.h`:

- Two-phase update: `ghostty_render_state_begin_update()` needs exclusive access
  to the terminal; `ghostty_render_state_end_update()` needs only memory owned by
  the render state. So a renderer (or a per-client encoder) can **lock, begin,
  unlock, end** — the IO thread is blocked for a minimal window.
- Dirty tracking at two layers: a global clean/partial/full state, and per-row
  dirty flags, with `ghostty_render_state_row_iterator_next_dirty()`.

That maps one-to-one onto "send each websocket client only the rows that changed
since its last frame", with per-client frame pacing. It is the same shape as
mosh's adaptive frame rate, minus the research.

## Effects: free semantic metadata about what a session is doing

`ghostty_terminal_set()` registers callbacks ("effects") invoked synchronously
during VT writes:

| Option                                                              | Trigger                                           |
| ------------------------------------------------------------------- | ------------------------------------------------- |
| `WRITE_PTY`                                                         | Responses to queries that must go back to the PTY |
| `TITLE_CHANGED`                                                     | OSC 0 / OSC 2                                     |
| `PWD_CHANGED`                                                       | OSC 7 / OSC 9 / OSC 1337                          |
| `DESKTOP_NOTIFICATION`                                              | OSC 9 / OSC 777                                   |
| `PROGRESS_REPORT`                                                   | OSC 9;4                                           |
| `BELL`                                                              | BEL                                               |
| `CLIPBOARD_WRITE` / `CLIPBOARD_READ`                                | OSC 52 / OSC 1337 / OSC 5522                      |
| `DEVICE_ATTRIBUTES`, `XTVERSION`, `SIZE`, `COLOR_SCHEME`, `ENQUIRY` | Query responses                                   |
| `UNKNOWN_SEQUENCE`                                                  | Unsupported sequence                              |

This is the metadata layer for a _browsable_ session list: title, cwd, "needs
attention" (bell / notification), and progress — without screen-scraping. It is
strictly better than what [agentapi](https://github.com/coder/agentapi) does by
diffing rendered text.

Two hard constraints from the header, both of which shape the daemon's IO loop:

- Callbacks **must not** call `ghostty_terminal_vt_write*` on the same terminal —
  no reentrancy. So an effect must enqueue, never write. In particular
  `WRITE_PTY` must push onto an outbound queue drained after the write returns.
- Callbacks **must not block**; they stall IO processing. No `await`, no
  filesystem, no channel sends that can block. Bounded, non-blocking queues only.

## Scrollback compression is our job

> "Scrollback compression is caller-driven. The terminal exposes an opaque
> activity token so an embedding application can restart an idle timer only when
> compression-relevant state changes. Once idle, call incremental compression
> until it no longer reports pending work. libghostty-vt does not create a timer
> or background thread."

For a daemon holding dozens of long-lived sessions, this is a first-class
concern, not a footnote: `ghostty_terminal_compression_activity()` +
`ghostty_terminal_compress()` driven by a per-session idle timer is what keeps
memory bounded when a `claude` session has been sitting there for three days.

## Thread safety

The library is **not thread-safe**; the C API is not designed for it. The Rust
bindings say so explicitly. Practical consequence: each `Terminal` is owned by
exactly one thread/task, and everything else talks to it by message. This is a
constraint that pushes the whole architecture toward actor-per-session, which is
what we'd want anyway.

## What snapshot does _not_ do

- It does not persist the **child process**. A `claude` process still dies when
  its PTY master closes. Detach keeps the process alive because the _daemon_
  holds the master fd; a snapshot on disk only restores the _picture_. Restoring
  a snapshot into a session whose process is gone gives you a read-only corpse —
  useful (scrollback, "what did it say before it died"), but be honest about it
  in the UX. hauntty models this as `restore` of a dead session, and it's the
  right vocabulary.
- It does not give you PTY handling, resize arbitration, or job control. All ours.

## Sources

- [ghostty vt.h on main](https://github.com/ghostty-org/ghostty/blob/main/include/ghostty/vt.h) (and `vt/snapshot.h`, `vt/terminal.h`, `vt/render.h`)
- [libghostty API reference](https://libghostty.tip.ghostty.org/index.html)
- [Libghostty Is Coming — Mitchell Hashimoto](https://mitchellh.com/writing/libghostty-is-coming)
- [ghostling](https://github.com/ghostty-org/ghostling)
- [Ghostling makes terminal emulation a C library — heise](https://www.heise.de/en/news/Ghostling-makes-terminal-emulation-a-C-library-11222728.html)
