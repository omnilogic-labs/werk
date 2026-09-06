# Session libraries

The workspace provides private Bun packages with built JavaScript, declarations
and explicit exports. `@werk/session` implements the portable protocol and client
with an injected duplex transport. `@werk/terminal` owns terminal interpretation,
snapshots and replicas; its core takes WASM explicitly, `./bun` loads embedded
assets and `./dom` mounts the bundled renderer. `@werk/terminal-beamterm` supplies
an optional renderer through the same factory. `@werk/session-daemon` owns PTYs,
checkpoints, local transport and detached startup.

The CLI and browser example consume public package entry points. Closing either
consumer leaves the process with its daemon. Shutting down that daemon ends its
processes and retains screen checkpoints; reopening the state directory recovers
read-only records, not live processes. Protocol compatibility is separate from
snapshot compatibility. Daemon capabilities report native operations available
on the running platform.

## Build and validate

From the repository root:

```sh
bun install
bun run build
bun run typecheck
bun run test
bun run test:browser
bun run test:artefacts
bun run format:check
```

`build` orders library builds before consumers and compiles `packages/werk/dist/werk`
with its terminal WASM. `test:artefacts` checks built exports and declarations,
portable browser bundles and both renderer assets, then copies the executable to
a temporary directory outside the checkout. It exercises detached ownership,
input, resize, reconnect, saved-screen recovery and removal there. The CLI renders
a snapshot replica as ANSI cells in a TTY; external terminal display fidelity
still depends on that terminal's fonts and supported attributes.

The artefact test uses a portable Bun child and executes its native PTY lifecycle
checks on Linux, macOS and Windows x64. It kills the copied daemon abruptly after
a running-state checkpoint, then verifies a `lost` record and its saved screen.
The native CI matrix also runs screen and process lifecycle tests on each OS.
Local Linux evidence does not establish native macOS/Windows success; those
results require the corresponding CI runners.

## Run the consumers

```sh
packages/werk/dist/werk create --name demo -- /bin/sh
packages/werk/dist/werk list
packages/werk/dist/werk watch
packages/werk/dist/werk attach SESSION_ID
packages/werk/dist/werk logs SESSION_ID
packages/werk/dist/werk kill SESSION_ID --intent force
packages/werk/dist/werk remove SESSION_ID
```

Ctrl-] detaches. `attach --read-only` requests no input permission. Stdin pauses
while input acceptance is pending, with one input request in flight. `logs
--history` reads retained history; it is not a complete durable output log.
`info` prints daemon identity and capabilities. All commands accept explicit
`--runtime-dir PATH` and `--state-dir PATH`. The CLI supplies its own
`session-daemon` command to the detached launcher.

For the local browser consumer, start a daemon via a CLI command with an explicit
runtime directory, then run:

```sh
bun examples/session-web/dist/server.js /absolute/runtime/endpoint.json 4319
```

Open `http://127.0.0.1:4319`. The example supports listing, attachment, input and
renderer selection. Its bridge is a local owner surface; see the
[browser README](../examples/session-web/README.md) for its access boundary.
Package asset directories retain licence and provenance records beside their
pins. No library or consumer imports PoC source.

## Operational measurements

`bun run test:soak` exercises a steady PTY, repeated create/attach/terminate/remove
cycles and an independently delayed viewer. The injected transport fragments
frame headers into single bytes and bodies into 4 KiB chunks. A two-millisecond
frame delay represents an artificial remote path; the slow viewer uses 200 ms.
This measures framing and backpressure under injected latency, not a real SSH,
container or wide-area network deployment. Viewer resynchronisations must occur.
The harness samples RSS, event-loop lag and daemon queue diagnostics every 100 ms,
and measures attachment completion latency and retained-state cleanup. Linux also
counts `/proc/self/fd` before and after; other platforms report that measurement
as unavailable rather than substituting an invented native handle count.

```sh
SOAK_SECONDS=60 SOAK_REPORT=soak.json bun run test:soak
SOAK_SECONDS=86400 SOAK_BASELINE=docs/session-library/linux-x64-baseline.json SOAK_REPORT=soak.json bun run test:soak
```

The duration accepts 10 through 86,400 seconds. `SOAK_BASELINE` enables regression
budgets: peak RSS at most twice the baseline, and p99 attachment/event-loop latency
at most three times the baseline with a 100 ms floor. These initial thresholds
provide investigation triggers, not capacity promises. Output queues must stay
within the configured 32 KiB per connection and control queues within 16 MiB per
connection. After cleanup there must be no sessions, connections or attachments;
Linux descriptors may increase by at most four for runtime bookkeeping.

The checked-in [Linux x64 baseline](session-library/linux-x64-baseline.json) ran
on Bun 1.3.14 for **60.312 seconds**, with 168 churn sessions and 242 slow-viewer
resynchronisations. Peak RSS was 191,111,168 bytes, p99 attachment latency 130.10 ms
and p99 event-loop lag 79.94 ms. Aggregate output queue peak was 49,933 bytes over
two connections. File descriptors returned from 13 to 13, and all diagnostic
resource counts returned to zero. Command:
`SOAK_REPORT=docs/session-library/linux-x64-baseline.json bun scripts/session-soak.ts`.
This is a short baseline, not a 24-hour soak result. The manual CI workflow offers
a full-day run on a self-hosted Linux x64 runner because hosted jobs have a shorter
time limit. Its runner must be provisioned before that evidence can be collected.
Regressions should retain the JSON report and be investigated before updating the
baseline; changing the reference should identify the runtime, platform and workload.

## Compatibility and upgrades

The packages remain private and should be built and deployed together. The
handshake carries the protocol version independently of the engine build and
snapshot format version. A protocol mismatch refuses the connection. An engine
or snapshot mismatch permits the connection and listing, but a saved screen may
be undecodable. Consumers should inspect `checkpoint.decodable` and its reason;
they should not interpret successful connection as proof of snapshot support.

Before replacing a daemon, inspect the active sessions and save the state
directory. A planned shutdown terminates its processes and retains checkpoints.
An abrupt death can recover the last persisted screen as a `lost` read-only
record; it does not revive the process or recover output newer than that
checkpoint. There is no uninterrupted process-preserving daemon upgrade contract.
Undecodable checkpoint files are preserved for diagnosis or use with a compatible
engine. Keep a copy of those files before removing a record or changing engines.
Creation and input timeouts have an unknown remote outcome; consumers should
reconcile session listings and must not automatically replay those operations.
