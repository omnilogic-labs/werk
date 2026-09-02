# vendor

Pinned upstream artifacts the PoC loads.

## `ghostty-vt/`

libghostty-vt as upstream builds it for `wasm32-freestanding`, plus the C
headers from the same commit. Ghostty is MIT-licensed (Mitchell Hashimoto and
contributors); the licence text is in each commit's directory as `LICENSE`.

| Path                                      | What it is                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------- |
| `PIN`                                     | The pinned commit, the download URLs, and the size and sha256 of each artifact  |
| `fetch.ts`                                | Downloads an artifact and headers for a commit into `<sha>/`, verifying the pin |
| `<sha>/ghostty-vt-small.wasm`             | The size-optimised build the adapter loads (about 740 KB, zero imports)         |
| `<sha>/ghostty-vt.wasm`                   | The speed-optimised build; fetched with `--full`, never committed               |
| `<sha>/include/ghostty/vt.h`, `vt/**/*.h` | The C API the WASM exports; the reference for the ABI                           |
| `<sha>/LICENSE`                           | Upstream's MIT licence                                                          |

Only the pinned commit's directory is checked in (`.gitignore` ignores every
other `<sha>/`). The pin is a `tip` commit: upstream publishes the WASM only
from its rolling nightly channel, both on the `tip` GitHub release and at
`tip.files.ghostty.org/<sha>/`, and the two are byte-identical for the same
commit.

To refetch, or to fetch another commit (M3 needs two more `tip` commits to
test snapshot compatibility across builds):

```console
$ bun run vendor/ghostty-vt/fetch.ts                  # the pinned commit, verified
$ bun run vendor/ghostty-vt/fetch.ts <sha>            # another commit, prints size and sha256
$ bun run vendor/ghostty-vt/fetch.ts <sha> --full     # also ghostty-vt.wasm
$ bun run vendor/ghostty-vt/fetch.ts --no-headers     # the artifact alone
```

The header listing comes from the GitHub contents API, unauthenticated (three
calls, against a limit of sixty an hour); the files themselves come from
`raw.githubusercontent.com`.

Moving the pin means: change `commit` and the artifact entries in `PIN`, run
`fetch.ts`, change the import path in `src/engine/ghostty-wasm/bytes.ts` (the
bundler needs a static string; a test checks it against `PIN`), and update
`.gitignore`'s negation.

## `ghostty-vt-ffi/`

The win32 half of the ffi adapter. `libghostty-vt@0.6.3` ships prebuilds for
`darwin-arm64` and `linux-{x64,arm64}-{glibc,musl}` and nothing for Windows,
so the PoC builds that one itself and keeps it here rather than in
`node_modules`.

| Path                       | What it is                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------ |
| `PIN`                      | The ghostty commit, the ts-libghostty commit, the zig version, and each artefact's size + sha256 |
| `build.md`                 | The exact toolchain and command line, and how the ABI was checked                                |
| `win32-x64/ghostty-vt.dll` | libghostty-vt with ts-libghostty's `shim.c` linked in, one file (about 1.6 MB)                   |
| `win32-x64/ghostty-vt.def` | The export list the link uses: upstream's 129 `ghostty_*` plus the shim's four `_p`              |
| `win32-x64/LICENSE`        | Upstream ghostty's MIT licence, from the pinned commit                                           |

It is one DLL rather than upstream's library-plus-shim pair because Windows
resolves a dependent DLL from the loading process's directory rather than
from the directory of the DLL that depends on it, and has nothing like
`$ORIGIN`. The binding dlopens the library and the shim separately and takes
an explicit path for each, so both point at the same file.

The ghostty commit is the one the binding pins, and it has to stay that way:
the struct offsets in the binding's `src/internal/generated.ts` were probed
from it. Those offsets are identical on win32 — `build.md` §4 records how
that was checked — so no Windows-specific regeneration is needed.

This buys the fast adapter on Windows, and nothing else. `Bun.Terminal` is
POSIX-only, `src/daemon/flock.ts` dlopens libc, and the daemon speaks over a
Unix socket; none of those are VT concerns. `ghostty-wasm` already runs
anywhere `bun build --compile` targets, so Windows was never without an
engine.

## `ghostty-web/`

A shallow clone of [coder/ghostty-web](https://github.com/coder/ghostty-web),
read and measured for the renderer evaluation in `findings/m4.md` and the
source of `src/web/client/renderer-ghostty-web.ts` and
`selection-ghostty-web.ts`. MIT-licensed (Copyright (c) 2025 Coder). The
clone is not checked in and not formatted (`.gitignore` and
`.prettierignore` at the repo root both list it); it is not needed to build
or test anything, only to re-read the original next to the port.

| Item    | Value                                                                                                                   |
| ------- | ----------------------------------------------------------------------------------------------------------------------- |
| Commit  | `1858a5947767a3e1c9e98dbf53b2ff87fedb2aab` (default branch `main`, 2026-06-28, release 0.4.0)                           |
| Ghostty | Pinned by the repo's `ghostty` submodule at a December 2025 commit, plus `patches/ghostty-wasm-api.patch` (1,620 lines) |

To reproduce the clone:

```console
$ git clone --depth 1 https://github.com/coder/ghostty-web.git vendor/ghostty-web
$ git -C vendor/ghostty-web rev-parse HEAD     # expect 1858a594…
```

For a later commit, `git -C vendor/ghostty-web fetch --depth 1 origin <sha> &&
git -C vendor/ghostty-web checkout <sha>`.
