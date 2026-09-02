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

## `ghostty-web/`

Not vendored yet. M4 rebases it onto the pinned artifact.
