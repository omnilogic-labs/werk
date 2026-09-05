# Readiness for session workspace libraries

## Assessment

**There is enough evidence to settle the package organisation and rough API shape
and begin the library work.** The PoC demonstrates the important seams: a host
owns processes independently of clients, transports connect clients to that host,
a terminal engine interprets state, and platform adapters contain operating-system
differences. The remaining findings do not justify replacing that architecture.

The recommended next step is three private workspace packages in this repository:
terminal state/emulation, a portable session client and contracts, and the Bun
session host. The [packaging proposal](../../../docs/proposals/02-session-library.md)
sets out their dependencies, illustrative API, and the order of implementation.
It treats the PoC as reference material rather than a finished library API.

This is a judgement about architectural readiness. The existing client has
attachment and cleanup defects, and the host has a shared engine fault boundary.
Those matter during implementation, but they can be addressed within these
packages. A 24-hour soak, broader network testing and production operating limits
would strengthen operational confidence without needing to precede the package
split.

The requirement most likely to reshape the host is live-process survival through
daemon replacement. Current recovery restores a saved screen, not its process.
Keep that limitation explicit and keep process ownership behind the host API.

## What the evidence supports

| Capability                                        | Evidence and limit                                                                                                                                                         |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Disconnect and reattach while a process continues | Daemon, launcher, browser and M2 checks exercise this. It is the PoC's central success.                                                                                    |
| Terminal and browser attachment                   | Both exist. Snapshot transfer preserves emulator state; terminal VT re-emission has documented fidelity losses.                                                            |
| Simultaneous writers                              | Writers feed one PTY in daemon arrival order. The regression checks that both inputs arrive once and both clients agree with the daemon at a common size.                  |
| Native platform seams                             | Fresh hosted Linux x64, macOS arm64 and Windows x64 checks are recorded below. Eight cross-compiled targets are not eight equally tested native lifecycle implementations. |
| Snapshot compatibility                            | The measured builds can round-trip state. This is not a compatibility promise for future engine builds; hosted M3 only has the committed pin.                              |
| Recovery after daemon death                       | Checkpoints return as read-only corpses. The child process is not restored, nor are bytes since the checkpoint guaranteed.                                                 |
| Long-lived operation                              | The previous recorded soak covers 30 minutes. The fresh five-minute run checks basic operation; neither establishes 24-hour stability.                                     |

See [platforms.md](./platforms.md), [M6](./m6.md), and the
[gap analysis](./where-the-poc-falls-short.md) for detailed earlier evidence.

## Revision and reproducibility

Checks ran on 2026-09-05 with Bun 1.3.14. The initial working tree included the
checkpoint/dimension repairs and tests described below, based on
`583cad79ffa9f43639ba0387cc6623d05fa78f7e`. An isolated CI branch,
`ci/library-readiness-20260905`, records that candidate as
`3c31ab7e1989a7f75acd46e67d0190a94b0f009a`; the user's checkout stays on `main`.
The subsequent assessment probe and documentation do not change runtime code.
The added probe typechecks. Repository formatting passes using Prettier through
Node; the local `bun run format:check` invocation crashes with SIGSEGV, while the
hosted Linux candidate formatting check passes.

[GitHub Actions run 33954599641](https://github.com/omnilogic-labs/werk/actions/runs/33954599641)
was dispatched with:

```console
gh workflow run poc.yml --ref ci/library-readiness-20260905 -f lanes=poc
```

The [checked-in evidence summary](./library-readiness/2026-09-05.json) preserves
commands, local observations and native suite verdicts. Full local logs and the
soak JSONL are under `/tmp/werk-readiness-20260905` for this session; native logs
are in the run's `ci-result-*` artifacts. Read the suite verdicts rather than
using the workflow badge as an all-tests-pass claim.

## Fresh local checks

Local machine: Linux x64 under WSL2, kernel
`6.18.33.2-microsoft-standard-WSL2`, Intel Core i9-14900HX.
Commands below run from `packages/werk-poc`.

| Check                                                                                             | Result                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run typecheck`                                                                               | Both TypeScript configurations pass.                                                                                                                                                                                                                       |
| `bun test`                                                                                        | 182 pass, 0 fail, 24 files; 52.41 seconds.                                                                                                                                                                                                                 |
| `bun run build`                                                                                   | Browser bundle and compiled `dist/wp` build.                                                                                                                                                                                                               |
| `bun run m0`                                                                                      | All 28 cells pass: seven probes, interpreted and compiled, on locally available Bun 1.3.14 and 1.4.0.                                                                                                                                                      |
| `bun run m2`                                                                                      | All nine compiled reattachment scenarios pass.                                                                                                                                                                                                             |
| `bun run m3`                                                                                      | Snapshot cost and available cross-commit decode probes complete successfully.                                                                                                                                                                              |
| `bun run bench/differential.ts --fuzz 50`                                                         | All 23 corpus cases are exercised; all three engines are split-invariant in 50/50 random-byte and 50/50 sequence cases. Engine-to-engine differences remain; completion is not universal fidelity.                                                         |
| `bun run bench/perf.ts --json`                                                                    | Full source runner completes. WASM corpus median throughput is 172 MiB/s at 80×24 and 164 MiB/s at 200×50. The fast client receives the entire 12 MiB flood with no lag; the slow client resynchronises. Fault probes reproduce shared-instance fragility. |
| `bun run bench/ops.ts --json`                                                                     | Five engine/binary configurations compile and the operational measurements complete.                                                                                                                                                                       |
| `./dist/wp bench soak --duration 5m --interval 10s --out /tmp/werk-readiness-20260905/soak.jsonl` | 31 samples; all 20 sessions remain running, replica has zero lag episodes, attach p50 0.6 ms/p99 1.8 ms. RSS ends at 113.4 MiB, peaks at 115.2 MiB.                                                                                                        |

The short soak holds ten idle and ten noisy sessions with one roaming attachment;
it does not perform sustained process churn or deliberately stop a slow viewer.
Its memory slope is not evidence for or against a long-term leak. The performance
runner separately exercises finite churn and a stopped client, after the soak
finishes. Lightweight diagnostic/corpus work overlaps part of the short soak, so
its timings are indicative rather than an isolated performance baseline.

Two compiled benchmark checks expose an asset-packaging gap:

- `./dist/wp bench diff --fuzz 50` exits zero but reports all 23 corpus files
  missing under `/$bunfs/root/corpus/`. Fuzz runs; the corpus does not. Count this
  as incomplete coverage, not a passing corpus run.
- `./dist/wp bench perf --json` exits one on the same missing `vim.cast` path.
  Running both benchmarks from source supplies the corpus and produces the
  measurements above. Compiling the executable alone does not prove all of its
  features have their assets.

## Fresh native checks

The three primary native lanes use the same candidate commit and Bun 1.3.14.
The build job cross-compiles all eight targets. The other five native lanes were
not dispatched for this assessment.

| Native lane                     | Result and interpretation                                                                                                                                                                                                                                                                                                     |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux x64, Ubuntu hosted runner | Typecheck, build, 113 engine/protocol tests, M0, M3, operational smoke and cross-platform differential comparison pass. Full suite: 181 pass/1 fail; M2: 8 pass/1 fail. Both failures are the known fast-client-lags-under-flood case allowed by the lane gate.                                                               |
| macOS arm64, hosted runner      | Same broad result, including successful native and cross-compiled code signing. Full suite: 181 pass/1 fail; M2: 8 pass/1 fail, again the allowed slow-client scenario.                                                                                                                                                       |
| Windows x64, hosted runner      | Two attempts: full suite 173 pass/9 fail. The invalid-dimensions test times out at 5 seconds, followed by eight connection-closed failures. All four recovery tests and all nine M2 scenarios pass; typecheck/build and cross-platform differential comparison pass. Three M0 probes fail as recorded by the Windows harness. |

The Windows lane fails its gate on both attempts at the same revision. The
initial timeout is reproducible; its underlying cause has not been isolated,
so it should not be dismissed as a transient CI flake. It is an explicit native
validation item for the library implementation, alongside attachment/request
lifetime rules. The other eight failures follow the loss of the shared test
connection; the report does not establish eight independent runtime defects.

The Linux/macOS failures mean queue pressure can drop intermediate output even
for the nominally fast viewer on these smaller machines. The library needs an
explicit gap/resynchronisation contract and calibrated queue limits; it should
not promise lossless raw delivery to every viewer. Differential agreement across
platforms means each engine behaves consistently on the corpus, not that every
engine agrees with every other engine or that re-emission is exact.

## Additional API-boundary assessment

[api-boundaries.ts](../spikes/library-readiness/api-boundaries.ts) exercises the
current code directly. Run it with:

```console
bun run spikes/library-readiness/api-boundaries.ts
```

This is a diagnostic report, not a pass/fail release gate: each observation's
`holds` field states whether the proposed contract is met. It exits nonzero for
an unexpected execution error. These observations were taken locally, not in the
hosted run.

| Question                                                 | Observation                                                                                                                                          | Implication for the library                                                                                                 |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Does a failed attach preserve the previous subscription? | No: attaching an unknown ID is rejected and the server still has one attachment, but the previous render callback receives no repaint.               | Make attachment replacement transactional and expose its lifetime.                                                          |
| Can an old handle affect its replacement?                | Yes: reattach to the same session, then the old handle resizes the new attachment to 93×27 and detaches it.                                          | Give handles an attachment generation, not just a session ID; reject/no-op stale operations.                                |
| Do failed spawns disrupt another session?                | Ten invalid executable requests are rejected; the existing session stays running and there are no phantom session records.                           | The host/client boundary already contains this request failure.                                                             |
| Is engine allocation unwound on failed spawn?            | A counting engine allocates one terminal and receives zero disposal calls when the real spawn fails.                                                 | Define ownership/cleanup during partial startup. This check measures cleanup calls, not leaked byte size.                   |
| Does hello timeout close its socket?                     | The request times out, but the accepting TCP peer sees no closure within another 500 ms; the probe explicitly terminates it.                         | Cancellation/deadline handling must release the transport.                                                                  |
| Does per-session WASM memory require a new terminal API? | No: two engines expose separate memories and independent screens through the existing interface. Each memory is 1,703,936 bytes in this small probe. | A session-scoped factory fits the proposed split. This is not a measurement of incremental RSS or complete fault isolation. |

Code inspection also finds that the client's outbound queue and the daemon's
non-droppable control/paint queue have no total byte budget. The 256 KiB limit
applies to droppable output. Bounded input/control traffic and request concurrency
should therefore be part of the library contract rather than inferred from the
PoC's slow-output test.

The full fault runner reproduces poisoning after seven repeated invalid calls,
and inability to allocate a fresh terminal after a double free. These are
internal handle faults, not observed traps from arbitrary PTY output. Dimensions
are now checked before client-requested allocation, but per-session memory and
failure cleanup still belong in the host implementation.

## Checkpoint and dimension repairs in the assessed candidate

Checkpoint eligibility includes initial state, PTY output and size changes.
An unchanged size does not cause another write. A checkpoint becomes clean only
after its file write succeeds; a failed write is logged and remains pending for
the next timer pass without aborting other checkpoint writes or shutdown cleanup.

[Snapshot recovery tests](../src/daemon/snapshot-recovery.test.ts) cover a quiet
initial checkpoint, resizing an exited session, an unavailable state directory
and abrupt daemon death restoring an unchanged read-only corpse. The storage
failure uses a file occupying the directory path, independent of POSIX permission
bits. [Daemon tests](../src/daemon/daemon.test.ts) also cover two writers and
invalid/excessive dimensions. Dimensions must be positive integers up to 4,096,
with at most 262,144 cells: a PoC allocation budget, not a platform limit.

These changes preserve the snapshot format and interval. They do not add output
journalling, process recovery or per-session engine fault isolation.

## Work that can proceed within the proposed boundaries

- Define attachment identity/cancellation, ordered snapshot/output/resize events,
  capability reporting and explicit host startup before consumers depend on them.
- Implement the first create/attach/detach/reattach path through the workspace
  packages, then cover failure cleanup and resynchronisation as library guarantees.
- Reserve separate input and resize permissions. The intended sharing direction
  is simultaneous writers and one transferable resize owner; the PoC currently
  uses last-resize-wins and browser replicas derive their own local size.
- Verify built packages and embedded assets in a consumer outside the checkout.
- Continue endurance, remote loss/reordering, native lifecycle and upgrade work
  as confidence-building implementation tasks. A 24-hour soak and power-cut test
  were not performed here.

The detailed sequence and suggested public surface are in the
[session-library proposal](../../../docs/proposals/02-session-library.md).
