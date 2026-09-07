# Upstream report: appending a grapheme to a cell does not dirty its row

A bug report against libghostty-vt, written out in full so that whoever files
it does not have to rediscover anything. It has not been filed: the machine it
was reproduced on has no network access. It probably belongs on
<https://github.com/ghostty-org/ghostty/issues>.

The behaviour is real on the pinned build and was reproduced from scratch on
2026-09-06 with the runnable script below.

## The build

| What     | Value                                                                                                             |
| -------- | ----------------------------------------------------------------------------------------------------------------- |
| Commit   | `3c1ef5b32fc5ea6b93d28493fabf193f595139cf`                                                                        |
| Artefact | `ghostty-vt-small.wasm`, 738,713 bytes                                                                            |
| SHA-256  | `df0cf5b020ac00c24ff58b202bc66fdd913377d1ca09ea10375946ac1da0e58a`                                                |
| Source   | <https://tip.files.ghostty.org/3c1ef5b32fc5ea6b93d28493fabf193f595139cf/ghostty-vt-small.wasm>                    |
| Headers  | <https://raw.githubusercontent.com/ghostty-org/ghostty/3c1ef5b32fc5ea6b93d28493fabf193f595139cf/include/ghostty/> |
| Host     | Bun 1.3.14 on Linux (WSL2). Nothing here looks host-specific.                                                     |

The commit is the one the `ghostty-org/ghostty` `tip` release assets were built
from on 2026-09-01. In this repository the same bytes are
`packages/terminal/assets/terminal.wasm` (`packages/terminal/assets/PROVENANCE.md`),
the pin record is `packages/werk-poc/vendor/ghostty-vt/PIN`, and the headers
quoted below are
`packages/werk-poc/vendor/ghostty-vt/3c1ef5b32fc5ea6b93d28493fabf193f595139cf/include/ghostty/vt/render.h`.
`@werk/terminal` identifies the build as
`ghostty-3c1ef5b32fc5ea6b93d28493fabf193f595139cf` (`ENGINE_BUILD` in
`packages/terminal/src/engine.ts`).

The reproduction only uses the render state C ABI, so it should be
straightforward to restate against a native build or in Zig.

## Observed

Write a printable character, render a frame, `ghostty_render_state_clean`, then
write a combining mark (or a zero width joiner) that attaches to that same
cell. The cell's contents change — its content tag becomes
`CODEPOINT_GRAPHEME` and its grapheme list grows — but

- `ghostty_render_state_update` leaves the global dirty state at
  `GHOSTTY_RENDER_STATE_DIRTY_FALSE`,
- no row reports `GHOSTTY_RENDER_STATE_ROW_DATA_DIRTY`, and
- the render state does not re-copy the row, so the state's own view of that
  cell stays at the old value for as long as the row is never dirtied by
  something else.

The last point is what makes it hard to work around from the outside: the stale
row is inside the render state, so a caller cannot notice the change by
re-reading the state it already has.

## Expected

`GHOSTTY_RENDER_STATE_DIRTY_PARTIAL` with the affected row's dirty flag set, as
for any other write that changes a cell. `render.h` documents the two states as

```
/** Not dirty at all; rendering can be skipped. */
GHOSTTY_RENDER_STATE_DIRTY_FALSE = 0,

/** Some rows changed; renderer can redraw incrementally. */
GHOSTTY_RENDER_STATE_DIRTY_PARTIAL = 1,
```

and a renderer that takes "rendering can be skipped" at its word drops the
grapheme on the floor.

## Reproduction

Self-contained, no dependencies. Save as `grapheme-dirty.mjs` next to the
artefact and run `bun grapheme-dirty.mjs ./ghostty-vt-small.wasm` (Node also
works). Every ABI constant is read from the build's own
`ghostty_type_json` manifest, so nothing is hard-coded.

```js
// Appending a combining mark or a zero width joiner to a cell that already
// holds a codepoint changes that cell, but leaves the render state's dirty
// flags clear, so an incremental renderer driven by those flags never
// repaints it and the render state itself never re-copies the row.
//
//   bun grapheme-dirty.mjs ./ghostty-vt-small.wasm
//   node grapheme-dirty.mjs ./ghostty-vt-small.wasm
import { readFile } from "node:fs/promises";

const { exports: e } = await WebAssembly.instantiate(
  await WebAssembly.compile(await readFile(process.argv[2])),
  {},
);
const u8 = () => new Uint8Array(e.memory.buffer);
const dv = () => new DataView(e.memory.buffer);
const check = (name, ...args) => {
  const code = e[name](...args);
  if (code !== 0) throw new Error(`${name} -> ${code}`);
};
const scratch = e.ghostty_wasm_alloc(1024);
const handle = (name, ...args) => {
  check(name, 0, scratch, ...args);
  return dv().getUint32(scratch, true);
};

// Every constant below comes from the build's own manifest.
let end = e.ghostty_type_json();
const start = end;
while (u8()[end]) end++;
const T = JSON.parse(new TextDecoder().decode(u8().slice(start, end))).types;
const V = (type, key) => T[type].values[key];
const F = (type, key) => T[type].fields[key].offset;
const DIRTY = Object.fromEntries(
  Object.entries(T.GhosttyRenderStateDirty.values).map(([k, v]) => [v, k]),
);
const bit = (raw, b) =>
  Number((raw >> BigInt(b.lsb)) & ((1n << BigInt(b.width)) - 1n));
const tagBits = T.GhosttyCell.bits.content_tag;
const codepointBits = {
  lsb:
    T.GhosttyCell.bits.content.lsb +
    T.GhosttyCell.bits.content.arms.CODEPOINT.bits.codepoint.lsb,
  width: T.GhosttyCell.bits.content.arms.CODEPOINT.bits.codepoint.width,
};

const COLS = 12,
  ROWS = 8;
const term = handle("ghostty_terminal_new", COLS, ROWS);
// One persistent render state, as an incremental renderer keeps. update()
// consumes the terminal's dirty state, so only one such state can exist.
const state = handle("ghostty_render_state_new");
const iter = handle("ghostty_render_state_row_iterator_new");
const cells = handle("ghostty_render_state_row_cells_new");

function write(text) {
  const bytes = new TextEncoder().encode(text);
  const p = e.ghostty_wasm_alloc(bytes.length);
  u8().set(bytes, p);
  e.ghostty_terminal_vt_write(term, p, bytes.length);
  e.ghostty_wasm_free(p, bytes.length);
}

// Walk a render state's rows. Returns the rows that report themselves dirty
// and the decoded text of cell (0, y) as that state holds it.
function walk(s, y) {
  dv().setUint32(scratch, iter, true);
  check(
    "ghostty_render_state_get",
    s,
    V("GhosttyRenderStateData", "ROW_ITERATOR"),
    scratch,
  );
  const rows = [];
  let text = "";
  for (let row = 0; e.ghostty_render_state_row_iterator_next(iter); row++) {
    check(
      "ghostty_render_state_row_get",
      iter,
      V("GhosttyRenderStateRowData", "DIRTY"),
      scratch,
    );
    if (dv().getUint8(scratch)) rows.push(row);
    if (row !== y) continue;
    check(
      "ghostty_render_state_row_get",
      iter,
      V("GhosttyRenderStateRowData", "CELLS_RAW"),
      scratch,
    );
    const raw = dv().getBigUint64(
      dv().getUint32(scratch + F("GhosttyCellsView", "ptr"), true),
      true,
    );
    if (
      bit(raw, tagBits) === V("GhosttyCellContentTag", "CODEPOINT_GRAPHEME")
    ) {
      dv().setUint32(scratch, cells, true);
      check(
        "ghostty_render_state_row_get",
        iter,
        V("GhosttyRenderStateRowData", "CELLS"),
        scratch,
      );
      check("ghostty_render_state_row_cells_select", cells, 0);
      check(
        "ghostty_render_state_row_cells_get",
        cells,
        V("GhosttyRenderStateRowCellsData", "GRAPHEMES_LEN"),
        scratch,
      );
      const n = dv().getUint32(scratch, true);
      check(
        "ghostty_render_state_row_cells_get",
        cells,
        V("GhosttyRenderStateRowCellsData", "GRAPHEMES_BUF"),
        scratch + 512,
      );
      const parts = [];
      for (let i = 0; i < n; i++)
        parts.push(dv().getUint32(scratch + 512 + i * 4, true));
      text = String.fromCodePoint(...parts);
    } else {
      text = String.fromCodePoint(bit(raw, codepointBits));
    }
  }
  return { rows, text };
}

const show = (text) =>
  [...text]
    .map(
      (c) =>
        "U+" + c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0"),
    )
    .join(" ");

function step(label, text, y) {
  write(text);
  // The persistent state, as a renderer uses it: update, read the flags, clean.
  check("ghostty_render_state_update", state, term);
  check(
    "ghostty_render_state_get",
    state,
    V("GhosttyRenderStateData", "DIRTY"),
    scratch,
  );
  const dirty = DIRTY[dv().getUint32(scratch, true)];
  const kept = walk(state, y);
  check("ghostty_render_state_clean", state);
  // A throwaway state, to show what the screen actually holds. Safe here only
  // because the flags above were already read and cleaned.
  const fresh = handle("ghostty_render_state_new");
  check("ghostty_render_state_update", fresh, term);
  const truth = walk(fresh, y);
  e.ghostty_render_state_free(fresh);
  console.log(
    `${label.padEnd(38)} dirty=${dirty.padEnd(7)} rows=[${String(kept.rows).padEnd(3)}]  ` +
      `state(0,${y})=${show(kept.text).padEnd(13)} screen(0,${y})=${show(truth.text)}`,
  );
}

console.log(`ghostty-vt-small.wasm, ${COLS}x${ROWS} terminal\n`);
step(`write "e"`, "e", 0);
step(`write U+0301 (combining acute)`, "́", 0);
step(`write U+0301 again`, "́", 0);
step(`write "\\r\\nx" (control: a plain write)`, "\r\nx", 1);
step(`write U+1F469 on row 2`, "\r\n\u{1F469}", 2);
step(`write U+200D (zero width joiner)`, "‍", 2);
```

Output on the pinned build:

```
ghostty-vt-small.wasm, 12x8 terminal

write "e"                              dirty=FULL    rows=[0,1,2,3,4,5,6,7]  state(0,0)=U+0065        screen(0,0)=U+0065
write U+0301 (combining acute)         dirty=FALSE   rows=[   ]  state(0,0)=U+0065        screen(0,0)=U+0065 U+0301
write U+0301 again                     dirty=FALSE   rows=[   ]  state(0,0)=U+0065        screen(0,0)=U+0065 U+0301 U+0301
write "\r\nx" (control: a plain write) dirty=PARTIAL rows=[0,1]  state(0,1)=U+0078        screen(0,1)=U+0078
write U+1F469 on row 2                 dirty=PARTIAL rows=[1,2]  state(0,2)=U+1F469       screen(0,2)=U+1F469
write U+200D (zero width joiner)       dirty=FALSE   rows=[   ]  state(0,2)=U+1F469       screen(0,2)=U+1F469 U+200D
```

Reading the output:

- `state(0,y)` is the cell as the long-lived render state holds it;
  `screen(0,y)` is the same cell read through a render state created after the
  write. They diverge exactly on the appended-grapheme lines.
- The first line reports `FULL` because it is that render state's first update,
  which is expected.
- The two `PARTIAL` lines are the control: an ordinary write dirties the row it
  touched and the row the cursor left, as documented.
- Lines 2, 3 and 6 are the bug. The second combining mark is worth keeping in
  the report: it changes nothing in the packed `GhosttyCell` at all — only the
  grapheme list grows — so a caller cannot detect it by diffing raw cells
  either.

## Scope of the claim

Established by this script on this build:

- A combining mark appended to an existing cell does not dirty its row.
- A zero width joiner appended to an existing cell does not dirty its row.

Not established, and worth someone checking before it is asserted anywhere:

- Whether other cell mutations that do not move the cursor are affected. 25
  scripts covering insert and delete of characters and lines, scroll regions,
  tabs and backspace, alt screen, hyperlinks, underline colours and OSC 4/10/11
  showed nothing else, which is evidence rather than proof.
- Appending U+FE0F to a narrow ASCII base also reported `FALSE`, but left the
  packed cell and the grapheme list unchanged, so there may be nothing to
  report there.
- Where in the Zig source the omission is. The cursor-moving write path clearly
  dirties; the grapheme-append path appears not to. That is a guess from the
  outside — no Zig source was read.

## The workaround in place

`packages/terminal/src/engine.ts` sets a `wrote` flag on every
`ghostty_terminal_vt_write` (line 402). In `frame()` (lines 644 to 706), if a
frame follows a write and the dirty walk did not deliver the cursor's row and
the row above it, those rows are decoded from a throwaway render state created
and freed for that frame alone. Two rows cover the case because a write can
wrap the cursor to the next row.

It costs 0.02 to 0.05 ms on the frames that need it and nothing on the rest,
which is acceptable, but it does mean every frame after a write pays a render
state allocation whenever the write produced no dirty rows at all — an
SGR-only write, for instance. If upstream fixes the dirty flag, that fallback
and the `wrote` flag can both go.
