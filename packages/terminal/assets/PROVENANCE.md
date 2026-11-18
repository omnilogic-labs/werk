# Terminal WASM

`terminal.wasm` is the official libghostty-vt 1.0.1 small build,
`ghostty-vt-1.0.1-small.wasm`, vendored unchanged as an immutable artefact.
Source: <https://release.files.ghostty.org/libghostty-vt/1.0.1/ghostty-vt-1.0.1-small.wasm>,
listed in that release's `SHA256SUMS`. The minisign signature was not checked.

Version: libghostty-vt 1.0.1 (upstream tag `vt-1.0.1`).

SHA-256: `e226900d2126faab515668e5400b69fc78ba3d99aaf9525b325f79707b29bf01`.

The accompanying `LICENSE` is the upstream MIT licence, identical to the one in
`libghostty-vt-1.0.1.tar.gz`. The library adapter is independently implemented
against the artefact's self-describing C ABI. An asset upgrade requires a new
engine build identity (`ENGINE_BUILD` in `src/engine.ts`, now
`ghostty-vt-1.0.1`) and snapshot compatibility validation: upstream does not
cover the snapshot byte format by its 1.x ABI stability promise.
