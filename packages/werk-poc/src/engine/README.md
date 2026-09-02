# engine

The terminal engine seam and its adapters.

| Path            | What it is                                                                                   |
| --------------- | -------------------------------------------------------------------------------------------- |
| `types.ts`      | `VtEngine` / `VtTerminal` from the proposal, §5, with `Unsupported`, `Cell`, `Effect` and co |
| `registry.ts`   | Adapters register by id; `getEngine(id)` constructs one lazily                               |
| `ghostty-wasm/` | The adapter over upstream's freestanding WASM build (M1)                                     |

`ghostty-ffi` and the `xterm-oracle` arrive at M6.

## `ghostty-wasm/`

| File        | What it is                                                                                                                                                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `layout.ts` | Parses `ghostty_type_json()` into a `Layout`: sizes, alignments, struct fields and offsets, enum values, the packed `GhosttyCell` descriptor. No WASM dependency                                                                      |
| `loader.ts` | `GhosttyModule`: instantiates the module, marshals through the layout. `alloc`/`free`, `allocType`, `read`/`write` for scalars, structs, arrays and tagged unions, `withOpaque`, `check`, `hostFunction` for C callbacks. No Bun APIs |
| `bytes.ts`  | Bun only: the pinned artifact's bytes via `import ... with { type: "file" }`, which `bun build --compile` embeds                                                                                                                      |
| `index.ts`  | `GhosttyWasmEngine` / `GhosttyWasmTerminal` / `GhosttyWasmDecodedState`: the seam over the loader                                                                                                                                     |
| `bun.ts`    | `loadGhosttyWasmEngine()` and the registry entry                                                                                                                                                                                      |
| `*.test.ts` | Loader, terminal and reattach (emitVt, effects, snapshot) tests; `spikes/m1/embedded.test.ts` covers the compiled binary                                                                                                              |

A typical call through the loader:

```ts
const g = await GhosttyModule.load(await ghosttyWasmBytes());
const opts = g.allocType("GhosttyFormatterTerminalOptions"); // zeroed, size field set
g.writeStruct(opts, "GhosttyFormatterTerminalOptions", {
  emit: "VT",
  unwrap: true,
});
const f = g.withOpaque("formatter", (slot) =>
  g.call("ghostty_formatter_terminal_new", 0, slot, term, opts),
);
```

Functions taking a struct by value in C take a pointer to it in the wasm32
ABI; 64-bit values (`GhosttyCell`, `GhosttyRow`) cross as `BigInt`. A C
function pointer is an index into the exported function table;
`g.hostFunction(signature, fn)` puts a JS function there through a
one-function trampoline module and returns the index, which is what
`ghostty_terminal_set` takes for a callback option.
