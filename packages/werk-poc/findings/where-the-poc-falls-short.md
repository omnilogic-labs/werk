# Where the proof of concept falls short

This file lists the things the proof of concept was built to do and does not
yet do well. It covers the session runner only: starting a process under a
pseudo-terminal, keeping it alive, and letting a person come back to it from a
terminal or a browser. Workspaces, git and machine provisioning are not part of
the proof of concept and are not treated as gaps here.

The broad verification below was run on 2026-09-03. Fresh native checks, persistence checks and client API diagnostics are recorded
in [library-readiness.md](./library-readiness.md). The results
are in [How this was checked](#how-this-was-checked). The rest of `findings/`
records what each milestone measured; this file records what is missing, what is
broken, and what nobody has measured yet.

Nothing here is a decision. Where a gap has an obvious repair, it is written
down as an option.

## Words used in this file

| Word            | Meaning                                                                                                                                 |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| session         | One command running under a pseudo-terminal inside the daemon.                                                                          |
| daemon          | The background process that owns every session on one machine.                                                                          |
| attach, detach  | Connecting a client to a session and disconnecting it. The session keeps running either way.                                            |
| emulator        | The terminal state machine that turns the session's output bytes into a grid of cells. Here it is libghostty-vt.                        |
| snapshot        | A binary dump of the emulator's state: the grid, the scrollback, the cursor and the modes.                                              |
| state transfer  | Rebuilding a screen elsewhere by sending the snapshot and decoding it. The browser does this.                                           |
| re-emission     | Rebuilding a screen elsewhere by sending escape sequences that repaint it. The terminal client does this.                               |
| corpse          | A session restored from a snapshot after the daemon restarted. It has no process behind it, so it is read-only.                         |
| engine, adapter | The code that drives one emulator library behind a shared interface. There are three: `ghostty-wasm`, `ghostty-ffi` and `xterm-oracle`. |
| platform layer  | The files in `src/platform/` that hold everything that differs between Linux, macOS and Windows, so that nothing else has to know.      |
| effect          | Something the session's output asks the terminal to do besides drawing: set a title, ring a bell, report progress, send a notification. |

## How this was checked

Machine: `linux-x64-glibc` under WSL2, kernel `6.18.33.2-microsoft-standard-WSL2`,
Intel Core i9-14900HX, Bun 1.3.14. This is the same machine most of `findings/`
was measured on. Repository at commit `7a1473c`. All commands were run in
private runtime and state directories, and nothing was left running afterwards.

| Check                                    | Command                                        | Result                                                               |
| ---------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------- |
| Types                                    | `bun run typecheck`                            | Clean, both TypeScript configurations.                               |
| Unit and integration tests               | `bun test`                                     | 171 pass, 0 fail, 23 files, 48.7 s.                                  |
| Build                                    | `bun run build`                                | `dist/wp`, 104,913,024 bytes (100 MB).                               |
| Pseudo-terminal probes                   | `bun run m0`                                   | 28 of 28 cells pass, Bun 1.3.14 and 1.4.0, interpreted and compiled. |
| Reattach fidelity                        | `bun run m2`                                   | 9 of 9 scenarios pass, including the slow-client one.                |
| Snapshot cost and cross-version decoding | `bun run m3`                                   | 53 decodes, all identical, none refused.                             |
| Emulator agreement                       | `bun run bench/differential.ts --fuzz 50`      | Reproduces the table in `m6.md` cell for cell.                       |
| Throughput and fault isolation           | `bun run bench/perf.ts --only throughput,trap` | Reproduces `m6.md`.                                                  |
| Memory and slow client                   | `bun run bench/perf.ts --only memory,slow`     | Reproduces `m6.md`.                                                  |
| Command-line walkthrough                 | `wp run`, `ls`, `logs`, `attach`, `kill`       | Works, including corpse restore after `SIGTERM`.                     |
| Web interface                            | `wp serve` plus a real Chrome browser          | Works with all four renderers.                                       |
| Protocol through a forwarded socket      | `socat` relay in front of the daemon socket    | `ls`, attach and typed input all work through the relay.             |

Three headline numbers reproduced closely enough to trust:

- Throughput, `ghostty-wasm`: 128 to 142 MiB/s on the recorded corpus, 449 to
  562 MiB/s on plain text, 89 to 93 MiB/s on colour-heavy output. The threshold
  that would have changed the design is 20 MiB/s.
- Memory: 0.65 to 0.84 MiB of daemon memory per idle session, 1.15 MiB for a
  session holding a full 2,000-line scrollback. The threshold that would have
  changed the design is 5 MiB.
- Slow client: the fast client received all 12,582,912 bytes with no dropped
  output while the stopped client lost 12.35 MB, its queue peaking at 260,526
  bytes under the 262,144-byte limit.

What could not be checked on this machine, and is therefore still only as good
as the runs recorded elsewhere in `findings/`: the 24-hour soak, a real
`ssh -L` forward with added latency, and everything on macOS and Windows.

## What works

Recorded briefly, because the gaps below only make sense against it.

| Capability                                          | State                                                                                                |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Run a process under a pseudo-terminal in a daemon   | Works, compiled and interpreted, on Bun 1.3.14 and 1.4.0.                                            |
| Ctrl+C, terminal resize, detached daemon survives   | Works. The daemon outlives its parent and its parent's terminal.                                     |
| Come back to a session and see the screen as it was | Works for `vim`, `top` and a redrawing full-screen program, checked cell by cell against the daemon. |
| Survive a daemon restart                            | Works for `ghostty-wasm` sessions. They come back read-only as corpses.                              |
| Show the same session in a browser                  | Works. The browser runs the same emulator and rebuilds the screen from a snapshot.                   |
| Reach a daemon through a forwarded socket           | Works. The framed protocol crosses a forward without corruption.                                     |
| Run on eight build targets                          | Works. The emulator produces identical results on all eight.                                         |

## Where it falls short

### 1. The terminal client reattaches on the less accurate of the two paths

**What happens.** The daemon can rebuild a screen two ways. The browser gets a
binary snapshot, which is exact. The terminal client gets re-emission, which is
not. Re-emission loses four things, each confirmed by a test:

1. Lines that were soft-wrapped come back with a hard line break in them. The
   copy then reflows differently from the original when the window is resized.
2. Cells erased with a background colour come back with the default background.
3. A hyperlink that was closed before the snapshot is dropped, even though the
   cell still records that it had one.
4. Cells that were never written, sitting between two styled runs, are repainted
   using the first run's style. On a status line this draws a visible bar of
   reversed video across the blank part of the row.

**Evidence.** `m1.md` records the first three. `m6.md` records the fourth. The
comparison corpus shows the effect end to end: the `reattach-primary` case
differs when the screen is re-emitted and then resized, and is exact when the
snapshot is transferred instead.

**Why it matters.** The terminal is the main way people use this. It is on the
worse path.

**Options.** Resize the session to the client's size first and re-emit
afterwards, which the corpus shows gives exact text and cursor position in every
primary-screen case. Or send the snapshot to the terminal client as well, which
means the client has to carry an emulator, which it already can. Or fix the four
defects in libghostty's formatter upstream.

### 2. Only one of the three engines can save a session

**What happens.** `ghostty-ffi` cannot encode or decode snapshots. A session
running on it writes no snapshot file, and after a daemon restart it is not
listed at all. Not as a corpse, not as an error. It is simply gone.

**Evidence.** Confirmed by running a session with `wp run --engine=ghostty-ffi`,
stopping the daemon with `SIGTERM`, and listing sessions afterwards. The state
directory was empty and `wp ls` returned no rows.

**Why it matters.** The second engine is not a fallback for the part that
matters. If the WebAssembly route ever becomes unusable, saved sessions go with
it.

**Options.** Treat `ghostty-wasm` as the only session engine and keep the others
for comparison testing. Or refuse to start a session on an engine that cannot
save, unless the caller asks for that. Or record such a session in the list as
explicitly unsaveable, so that its disappearance is not silent.

### 3. Saved state can be up to thirty seconds old

**What happens.** Snapshots are written on a thirty-second timer, when the child
exits, and during a graceful shutdown. A daemon killed with `SIGKILL`, stopped
by the out-of-memory killer, or lost to a power cut leaves the last snapshot up
to thirty seconds stale. There is no log of raw output behind the snapshot to
fill the gap.

**Evidence.** `server.ts` sets `DEFAULT_SNAPSHOT_INTERVAL_MS` to 30,000. The
tests exercise the timer, the child exit and graceful shutdown.
`snapshot-recovery.test.ts` also forcibly terminates the daemon and checks the
last checkpoint returns unchanged as a read-only corpse. A power cut and lost
output between checkpoints remain unmeasured.

**Why it matters.** For a coding agent that has been running for an hour, thirty
seconds of lost screen is usually harmless. For the last thirty seconds before a
crash, which is when something interesting probably happened, it is the worst
thirty seconds to lose.

**Options.** Shorten the interval. Write a snapshot when a session goes quiet
after a burst of output. Append raw output to a file and replay the tail on
restore. Do nothing, and accept the gap.

### 4. Every session on a daemon shares one WebAssembly instance

**What happens.** The engine registry keeps one instance per engine name, not
one per session. Every `ghostty-wasm` session lives in the same WebAssembly
memory. Three faults break that shared instance for every session at once:
freeing the same terminal twice, repeating a trapping call seven times, and
resizing a terminal to an absurd size.

**Evidence.** `registry.ts` memoises one instance per engine name. The fault
tests reproduce all three: the double free poisons the allocator so the next
session cannot be created, seven repeats of a trapping call exhaust the module's
internal stack, and a resize to 65,535 by 65,535 grew the process to 3.4 GiB
before returning an out-of-memory error.

**Why it matters.** None of this can be triggered by a session's own output. The
fuzz corpus feeds random bytes and random escape sequences and never causes a
fault. The exposure is a bug in werk's own handling of terminal handles. One
such bug takes down every session on the machine.

**Options.** Give each session its own instance, which the proposal costed at
about 450 KiB each and which the memory measurements say there is room for. Or
run the engine in a worker that can be restarted. Either would also remove the
memory residue described next. The daemon rejects malformed dimensions and
grids above 262,144 cells before creation, attachment or resize; this limits
client-requested allocations but does not isolate internal handle faults.

### 5. Repeatedly creating and destroying sessions leaks a small amount of memory

**What happens.** Killing and re-creating a set of sessions adds roughly 64 KiB
of WebAssembly memory per terminal that ever existed, for some output patterns
and not others. It is linear over eight rounds of testing. Forcing garbage
collection does not recover it.

**Evidence.** Reproduced during this check: three rounds of killing and
re-creating fifty sessions added about 1 MiB of process memory and 3 to 4 MiB of
WebAssembly memory per round. It reproduces without the daemon, so it is not the
daemon's bookkeeping. It depends on the shape of the terminal's memory pages
when it is freed, which points at libghostty's allocator rather than at a
missing free in the adapter.

**Why it matters.** At 64 KiB per session lifetime it takes roughly fifteen
hundred sessions to cost 100 MiB. It is small. It is also the only unbounded
growth the proof of concept found, and nobody has run long enough to see whether
it stays linear.

**Options.** One instance per session removes it, because the instance is thrown
away with the session. Re-creating the shared instance periodically removes it
too. Narrowing the trigger and reporting it upstream is worth doing either way.

### 6. The rule for a slow client is measured in bytes, and the byte count is wrong for most cases

**What happens.** Each connected client has a queue. When the queue would pass
256 KiB the daemon stops sending that client output, marks it as behind, and
repaints its screen when it catches up. The mechanism works and is prompt. The
number is sized for a socket on the same machine.

**Evidence, three ways:**

- On this machine, a client that stops reading for about 50 milliseconds is far
  enough behind to have its output dropped. An ordinary garbage-collection pause
  or a window drag in a real terminal can take that long.
- On macOS the operating system gives a socket an 8 KiB buffer where Linux gives
  208 KiB. A client that never falls behind on Linux was dropped and repainted
  twenty or more times.
- Through an `ssh -L` forward at 200 ms round-trip time, 16.6 MB of a 30 MB
  stream was dropped, because the limit is effectively the amount of data that
  fits in the network path.

**Why it matters.** The consequence of being marked behind is that output is
thrown away and the screen is repainted. That is correct behaviour for a client
that has genuinely stalled and wrong for a client that paused for a moment.

**Options.** Express the limit as time rather than bytes. Scale it with a
round-trip time the client measures when it connects. Raise it on macOS by
asking the operating system for a bigger socket buffer, which the platform layer
already does and which reduced the number of drops from about twenty to about
three. Any combination of these.

### 7. Two clients attached to one session fight over the window size

**What happens.** The daemon owns the size of a session. Whoever attached or
resized most recently sets it. The other client is not told. Its screen is
simply the wrong size until it resizes something.

**Evidence.** `session.ts` resizes the session inside `attach()`, and the
protocol has no message for a size change. This was confirmed by reading the
protocol definition: nothing exists to send.

**Why it matters.** One person with two terminals open on the same session gets
a broken screen in one of them. Two people, or a terminal and a browser tab, get
it constantly. The browser's own renderers do not even agree on a grid size for
the same window: a live run gave 142×30 for the `minimal` renderer, 142×36 for
`ghostty-web`, 151×32 for `wterm` and 142×32 for `beamterm`, because each derives
its own cell box from its own font metrics.

**Options.** Tell the other clients when the size changes, so they can redraw or
letterbox. Let the smallest attached client set the size. Refuse to resize when
someone else is attached. Let a client attach in a mode where it does not affect
the size and pads or crops instead.

### 8. Scrollback is not reachable from the terminal client

**What happens.** Attaching paints the visible screen only. There is no way to
scroll up in the terminal client. History is reachable only by detaching and
running `wp logs`, which prints everything at once.

In the browser, scrolling and selection work in three of the four renderers —
`ghostty-web`, `wterm` and `beamterm`, chosen with `?renderer=` — where a live
run confirmed scrolling through scrollback, clamping at the top, returning to
the bottom, and a selection that returns text. The default `minimal` renderer
has neither: it ignores the scroll wheel and offers no selection.

**Evidence.** `m2.md` records that the first paint after attaching is the
visible screen and that `logs` exists for history. In the browser code, the
scroll-wheel handler and the selection controller are wired up for three of
the four renderers and absent from `minimal`.

**Why it matters.** Coming back to a long-running process and reading what it
did while you were away is the main thing people will want to do.

**Options.** Add scrolling to the terminal client, which means the client
holding an emulator of its own, or the daemon answering requests for older rows.
Make one of the other renderers the default in the browser. Both are additions
rather than repairs.

### 9. Everything above the visible screen is capped at 2,000 lines

**What happens.** The emulator keeps 2,000 lines of scrollback per session. Once
that is exceeded, the oldest lines are discarded. The snapshot contains only
what the emulator holds, so what is discarded is gone for good. There is no
separate capture of raw output.

**Why it matters.** A build, a test run or an agent working for an hour will
produce far more than 2,000 lines. The session survives; most of what it printed
does not.

**Options.** Raise the cap and pay for it in memory, which is measurable: about
1.1 MiB per session at 2,000 lines. Write raw output to a file per session and
keep the emulator for the screen. Decide that the screen is all werk promises
and say so plainly.

### 10. Effects are collected and then discarded

**What happens.** The daemon subscribes to everything the emulator reports
besides drawing: title changes, working-directory changes, bells, progress
reports and desktop notifications. It forwards them to attached clients as
notices. Nothing does anything with them.

**Evidence.** The `TITLE` column in `wp ls` was empty for every session run
during this check. The effect notices exist in the protocol and have no consumer
beyond the browser's bell flash.

**Why it matters.** The information needed to answer "which of these needs me"
is being produced and thrown away. It is the cheapest thing on this list to use.

**Options.** Record the last title and working directory on the session and show
them in the list. Record progress reports and show them. Keep a timestamp of the
last bell or notification. None of this requires a decision about what the
product does with the information; storing it is separable from acting on it.

### 11. Windows runs sessions, slowly, and cannot be reached the same way

**What happens.** Windows works, which was not expected. The daemon starts, the
pseudo-terminal is real, and reattach matches the daemon's screen cell for cell.
The problems are underneath that.

| Problem                                                                                | Measured                                                                                                |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| The Windows pseudo-terminal carries about 200,000 lines per second whatever is on them | 0.6 MiB/s for short lines against 4.9 MiB/s on Linux; roughly ten times the cost per line.              |
| Round-trip latency inside the process                                                  | 15.6 ms at the median, against 59 to 95 microseconds on Linux. Roughly two hundred times slower.        |
| Basic pseudo-terminal probes                                                           | Three or four of seven fail, and which ones varies between runs.                                        |
| Signals                                                                                | Nothing can be delivered as a signal. Every kill is an immediate termination and no handler runs.       |
| Foreign function interface on Windows on ARM                                           | Absent in Bun 1.3.14, so there is no native engine there and the daemon's lock is a named pipe instead. |
| Process exit                                                                           | A process that used the WebAssembly engine sometimes never exits and cannot be killed from outside.     |
| Reaching a daemon remotely                                                             | Windows OpenSSH forwards neither Unix sockets nor named pipes, so a forward has to land on a TCP port.  |

**Why it matters.** As a place to sit and use a session, Windows is usable. As a
machine to leave work running on and connect back to, it is the weakest of the
three, and the remote path is different in kind rather than in degree.

**Options.** The TCP landing exists behind an environment variable and is
protected by a token file. What that token file's permissions actually prevent
has not been measured. See open question 4 in
[`../../../docs/product/04-open-questions.md`](../../../docs/product/04-open-questions.md),
which asks whether Windows is a host or only a client.

### 12. A remote session costs two round trips per keystroke on some paths

**What happens.** OpenSSH only turns off the delay that batches small network
writes when the connection carries an interactive session. A plain port forward
does not, so a keystroke can cost two network round trips plus a delayed
acknowledgement instead of one.

**Evidence.** On Linux through a container: 133 ms per keystroke at 50 ms
round-trip time over a plain forward, against 51 ms when the same forward shares
a connection that has an interactive session on it. On macOS the same test cost
one round trip either way, so the penalty depends on the path and has not been
isolated.

**Why it matters.** 133 ms against 51 ms is the difference between a session
that feels remote and one that feels broken.

**Options.** Open an unused interactive session alongside the forward, which was
measured and works. Replace the external `ssh` command with an ssh client inside
werk that sets the option itself, which the research already leans towards for
other reasons. Neither is built.

### 13. Sessions have no names, and a corpse cannot be restarted

**What happens.** A session is identified by six hexadecimal characters. There
is no way to name one, rename one, or find one by what it is doing. A corpse can
be read and removed but not restarted, even though its snapshot header records
the command, the working directory and the size it was created with. Corpses
accumulate until removed by hand.

**Why it matters.** With more than a handful of sessions, the list stops being
useful. And the most obvious thing to want from a corpse is to start it again.

**Options.** All additions rather than repairs. The information needed for
restarting is already on disk.

### 14. Saved sessions are tied to one exact build of the emulator

**What happens.** The snapshot file records the Ghostty commit that produced it.
On restore, the daemon compares that against its own and refuses to decode
anything that differs. The pin is a rolling development build, not a release.
Any update to it makes every existing corpse unreadable, with no migration path.

**Evidence.** Confirmed by reading the restore path: a mismatched file is listed
as a corpse with the reason `mismatch` and never handed to the decoder. Testing
four builds spanning a day of upstream development found all 53 combinations
decoded identically, and two of the four builds were byte-identical to each
other under different commit identifiers.

**Why it matters.** The refusal is stricter than the evidence requires. The
snapshot format changed less often than the pin will.

**Options.** Key the rule on the snapshot format version the decoder already
checks, and let the decoder's own refusal be the signal. Key it on the hash of
the emulator file rather than the commit. Keep the strict rule and write
something that migrates snapshots when the pin moves. Nobody has yet seen what
an upstream format change looks like, which is the main reason to leave this
open.

### 15. Defects found while verifying

Four small things, all confirmed by running the code.

| Defect                                                                                                                                                                   | Where                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| `wp bench diff` from the compiled binary cannot find the recorded comparison cases. Every case reports a missing file, the table prints empty cells, and it exits 0.     | The `.cast` files are not embedded.    |
| The token `wp serve` prints is described as one-time in the code comment and the README. It can be redeemed any number of times, and its value is also the cookie value. | `src/web/server.ts`                    |
| `--socket` is accepted by every command but ignored by `wp serve`, which always connects to the local daemon. The usage text says every command takes it.                | `src/cli/main.ts`, `src/web/server.ts` |
| An engine that fails to load is cached as a failure and never retried for the lifetime of the daemon.                                                                    | `src/engine/registry.ts`               |

## What nobody has measured

| Not measured                                                              | Why it matters                                                                                                               |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| The 24-hour soak. Thirty minutes stands in for it.                        | It is the only question a short sitting cannot answer. The thirty-minute shape is a fill and then a plateau, which is right. |
| Packet loss and reordering on a remote connection.                        | Every remote test used a traffic shaper or a loopback connection. Real networks lose and reorder packets.                    |
| More than 20 sessions for more than 30 minutes, or 50 sessions over time. | Memory at 50 sessions was measured once, at a point in time. Nothing has run a fleet for a day.                              |
| Restoring a daemon that has hundreds of snapshots.                        | History is decoded before the socket opens. At two files this costs 13 ms. At two hundred it is unknown.                     |
| Bun 1.4 for anything except the basic pseudo-terminal probes.             | The daemon, the engine and the web interface have only been measured on 1.3.14.                                              |
| What the Windows token file's permissions actually prevent.               | On Windows it is the only protection on the TCP landing.                                                                     |

## Where the code already separates cleanly

Recorded because the next question is likely to be which parts become a
reusable package. These are facts about the code as it stands, not a proposal.

| Part                                       | Lines (excluding tests) | Depends on Bun?                                                                                                                   |
| ------------------------------------------ | ----------------------: | --------------------------------------------------------------------------------------------------------------------------------- |
| `src/engine/ghostty-wasm/` core four files |                   2,802 | No. `loader.ts`, `layout.ts`, `encoders.ts` and `index.ts` use no Bun API. Reading the file bytes is separate.                    |
| `src/engine/ghostty-ffi/`                  |                     735 | Yes. Uses `bun:ffi`, `node:fs`, `process` and `Bun.file`.                                                                         |
| `src/engine/xterm-oracle/`                 |                     423 | No Bun API, but depends on the `@xterm/headless` package.                                                                         |
| `src/protocol/`                            |                     445 | No.                                                                                                                               |
| `src/web/client/`                          |                   4,380 | No. It has its own TypeScript configuration with browser types and no Bun types, and the build checks this.                       |
| `src/platform/`                            |                   1,356 | Yes, by definition. Everything that differs between operating systems lives here and nothing outside it reads `process.platform`. |
| `src/daemon/`                              |                   2,405 | Yes.                                                                                                                              |
| `src/client/`                              |                     550 | Yes.                                                                                                                              |
| `src/cli/`                                 |                     809 | Yes.                                                                                                                              |

Two qualifications on the parts that do not depend on Bun:

- The memory layout of the emulator's structures is read at runtime from the
  library's own description of itself, so no offsets are copied by hand. The
  widths of pointers and plain numbers are hardcoded, guarded by a check that
  refuses to run against any layout other than 32-bit WebAssembly.
- The daemon reads six things from the emulator that are not part of the shared
  interface, using runtime checks: whether the alternate screen is active, the
  full text including scrollback, the cursor position, the total row count, the
  size, and the WebAssembly memory for statistics. All three engines happen to
  provide them and every call site has a fallback, so nothing breaks today. A
  fourth engine would have to provide them or lose those features quietly.

Whole proof of concept, for scale: 15,042 lines under `src/` excluding tests,
4,114 lines of tests under `src/`, and 9,364 more lines under `spikes/` and
`bench/`.

## Questions this leaves open

These are choices nobody has made. They are listed here because several gaps
above cannot be closed without answering one of them. Product-level questions
live in
[`../../../docs/product/04-open-questions.md`](../../../docs/product/04-open-questions.md).

1. Does the terminal client carry an emulator of its own? Answering yes fixes
   the re-emission losses and makes scrolling possible in the terminal. It also
   makes the client bigger and gives it state to keep in step.
2. Is one WebAssembly instance per session worth 450 KiB each? The measurements
   say there is room. Nothing else about it has been decided.
3. Is the limit on a lagging client a size or a time?
4. When two clients disagree about the window size, who wins, and is the loser
   told?
5. How much output does werk promise to keep: the screen, a fixed amount of
   scrollback, or everything?
6. Is Windows a machine you leave work on, or a machine you connect from?
7. What is the rule for reading a snapshot written by a different build, and who
   is responsible for migrating one?
