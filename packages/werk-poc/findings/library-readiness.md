# Readiness for a session library

The next deliverable is an internal session library, after the cross-platform
proof of concept establishes the fundamentals. Product work follows that
library. This review concerns process ownership, attachment, terminal state and
sharing; it does not propose a product implementation.

## Assessment

The architecture is plausible and has substantial executable evidence. A daemon
owns the PTYs independently of clients; terminal and browser clients use a common
client API; an engine interface separates terminal interpretation from process
ownership; platform implementations contain the operating-system differences.
There is no finding here that justifies replacing the stack wholesale.

The PoC does not yet establish all the guarantees a solid library would need.
Native lifecycle coverage is uneven, the long soak is outstanding, and internal
emulator faults are not isolated per session. Reusing its interfaces unchanged
would also carry known reattachment and multi-client size gaps into the library.

## What the evidence supports

| Capability                                        | Evidence and limit                                                                                                                                                                                                                 |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Disconnect and reattach while a process continues | Daemon, launcher, browser and M2 tests exercise this. This is the central success of the PoC.                                                                                                                                      |
| Terminal and browser attachment                   | Both exist. Browser snapshots preserve emulator state; terminal re-emission has documented fidelity losses.                                                                                                                        |
| Simultaneous writers                              | Writers feed one PTY in daemon arrival order. The two-writer regression checks both inputs arrive once and both clients agree with the daemon at a common size.                                                                    |
| Cross-platform execution                          | The workflow gives three targets full native suites; the other five have smoke and comparison checks. Eight compilable targets are not eight equally tested lifecycle implementations.                                             |
| Windows reattachment                              | The detailed platform findings record nine M2 scenarios and 171 tests passing on three runs. Older summaries saying those suites stop at ConPTY are stale. Runtime-exit hangs and platform-specific limitations remain documented. |
| Recovery after daemon death                       | Saved screens return as read-only corpses. The child process is not restored. This does not demonstrate uninterrupted work through a daemon crash or upgrade.                                                                      |
| Long-lived operation                              | The recorded soak covers 30 minutes. A 24-hour run is still needed to assess sustained session churn and memory growth.                                                                                                            |

Platform results above are the repository's recorded evidence, not fresh runs on
macOS or Windows. See [platforms.md](./platforms.md),
[the workflow](../../../.github/workflows/poc.yml), and
[the existing gap analysis](./where-the-poc-falls-short.md).

## Small repairs exercised in this review

Checkpoint eligibility includes initial state and size changes as well as PTY
output. A session that has never printed can therefore be saved, and resizing a
quiet or exited session updates its saved screen. An unchanged size does not
cause another write.

A checkpoint is marked clean only after its file write succeeds. A failed write
is logged and leaves the session pending for the next timer pass. It does not
abort the rest of the checkpoint pass or the shutdown cleanup. This preserves
the existing snapshot format and interval; it does not add output journalling or
promise recovery of bytes generated since the last checkpoint.

[Snapshot recovery tests](../src/daemon/snapshot-recovery.test.ts) exercise these
three failures against real daemons in temporary directories. All three failed
before the repairs and passed afterwards on Linux with Bun 1.3.14. The storage
failure is a file temporarily occupying the state directory's path, so the check
does not depend on POSIX permission bits. Its portability still needs a native
Windows run. A fourth test forcibly terminates the daemon and checks that the
last checkpoint returns unchanged as a read-only corpse, with input and resize
unable to mutate it.

[Daemon tests](../src/daemon/daemon.test.ts) also exercise two writers sending to
the same process without an ownership handoff. Either cross-client arrival order
is valid; both clients must see the same resulting screen.

## Local verification

Run on 2026-09-05 on Linux with Bun 1.3.14, against the working tree containing
these repairs:

| Check               | Result                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `bun run typecheck` | Both TypeScript configurations pass.                                                                                |
| `bun test`          | 182 pass, 0 fail, 24 files, 52.35 s.                                                                                |
| `bun run build`     | Browser bundle and compiled `dist/wp` build successfully.                                                           |
| `bun run m0`        | All 28 cells pass: seven probes, interpreted and compiled, on Bun 1.3.14 and 1.4.0.                                 |
| `bun run m2`        | All nine compiled reattach scenarios pass, including vim resize, alternate-screen detach and a stopped slow client. |

The new test file is discovered by the native full-suite runners once included
in the checkout; Windows enumerates tracked test files. No native macOS or
Windows run, power-cut test or 24-hour soak was performed in this review.

## Deferred sharing semantics

Sharing implementation is deferred while the cross-platform fundamentals are
proved. The intended model is simultaneous writers feeding one PTY, with exactly
one resize owner who can transfer that permission. Shared viewing is through the
website; support for shared viewing in arbitrary terminal clients is optional.
When the owner resizes, every browser should follow the same terminal size.

The PoC still uses last-resize-wins without notifying other clients. It does not
implement that ownership model. Browser emulators also follow local window sizes,
which prevents faithful mirroring across differently sized windows today.

## Proposed proof before extraction

1. **Lifetime:** close the launching terminal and disconnect every client, then
   reattach and confirm the original child and its descendants remain. Exercise
   termination and forced termination on native Linux, macOS and Windows.
2. **Reattachment:** compare screen, cursor and modes after reconnecting from a
   terminal or browser, including full-screen applications, changed window size
   and a slow client recovering from dropped output.
3. **Failure containment:** exercise failed spawns, storage failures and engine
   faults while another session continues. The daemon now rejects invalid and
   excessive dimensions before allocating or resizing: dimensions must be positive
   integers no larger than 4,096, with at most 262,144 cells in total. This is a
   PoC allocation budget, not a discovered platform limit. Internal handle faults
   can still affect other sessions through the shared WASM instance.
4. **Persistence boundary:** run the abrupt-death checkpoint test on native
   platforms. It verifies screen recovery as a read-only corpse, not process
   recovery. Decide whether surviving daemon replacement is required; it would
   probably need a separate PTY-owning process rather than more snapshot code.
5. **Endurance and packaging:** run the sustained churn/slow-client soak, and run
   the agreed lifecycle and fidelity checks against compiled binaries on the
   primary native platforms at the same revision.

These are proposed acceptance experiments, not new product commitments. The
largest architectural choices to revisit after these measurements are whether
the terminal client interprets state locally, the engine fault boundary, and
whether live processes must outlast their owning daemon. No changes to those
boundaries are made in this review.

An eventual package probably wants explicit contracts for session lifecycle,
ordered output and size changes, attachment cancellation, engine capabilities and
resource disposal. The existing platform and engine seams are useful evidence
for those contracts. Package extraction should follow those experiments rather
than treating today's PoC exports as a settled API.
