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

The artefact test requires a runtime with native PTY support for its process
checks. Its Windows branch currently checks packaging only. Neither a successful
build nor a local test run establishes native macOS/Windows behaviour or a 24-hour
soak result; those require their own measured runs.

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
