# Terminal WASM

`terminal.wasm` is the upstream Ghostty freestanding `ghostty-vt-small.wasm`
from commit `3c1ef5b32fc5ea6b93d28493fabf193f595139cf`, vendored as an immutable
artefact. Source: <https://github.com/ghostty-org/ghostty/tree/3c1ef5b32fc5ea6b93d28493fabf193f595139cf>.

SHA-256: `df0cf5b020ac00c24ff58b202bc66fdd913377d1ca09ea10375946ac1da0e58a`.

The accompanying `LICENSE` is the upstream MIT licence. The library adapter is
independently implemented against the artefact's self-describing C ABI. An asset
upgrade requires a new engine build identity and snapshot compatibility
validation.
