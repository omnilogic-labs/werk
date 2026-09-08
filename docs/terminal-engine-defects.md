# Defects in the pinned terminal engine

Behaviour of the pinned Ghostty WASM build that werk works around. The build is
`ghostty-vt-small.wasm` from ghostty commit
`3c1ef5b32fc5ea6b93d28493fabf193f595139cf`, which is
`packages/terminal/assets/terminal.wasm` here.

## An appended grapheme does not dirty its row

The pinned engine build has a defect. A combining mark or a zero width joiner
that attaches to a cell already holding a codepoint changes that cell: its
content tag becomes `CODEPOINT_GRAPHEME` and its grapheme list grows. But
`ghostty_render_state_update` leaves the global dirty state at
`GHOSTTY_RENDER_STATE_DIRTY_FALSE`, no row reports itself dirty, and the render
state does not re-copy the row, so its own view of that cell stays at the old
value until something else dirties the row. That last part is what makes it hard
to handle from outside: the stale row is inside the render state, so a caller
cannot notice the change by re-reading the state it already has. An ordinary
write is the control and behaves as documented, dirtying the row it touched and
the row the cursor left.

Only the render state C ABI is involved, so the behaviour restates against a
native build or in Zig: write `e`, update and clean a long-lived render state,
write U+0301, and the next update reports `FALSE` while a render state created
fresh after that write shows both codepoints in the cell.

What is established is that a combining mark and a zero width joiner appended to
an existing cell each leave the row clean. Whether other cell mutations that do
not move the cursor are affected is not, though scripts covering insert and
delete of characters and lines, scroll regions, tabs and backspace, alt screen,
hyperlinks, underline colours and OSC 4/10/11 found nothing else. Where the
omission sits in the Zig source is unknown, and the behaviour has not been
reported to <https://github.com/ghostty-org/ghostty/issues>, which is where it
belongs.

`packages/terminal/src/engine.ts` works around it with a `wrote` flag set on
every `ghostty_terminal_vt_write`. Where a frame follows a write and the dirty
walk did not deliver the cursor's row and the row above it, two rows because a
write can wrap the cursor, those rows are decoded from a throwaway render state
created and freed for that frame alone. It costs 0.02 to 0.05 ms on the frames
that need it and nothing on the rest, and a frame after a write that produced no
dirty rows at all, an SGR-only write for instance, pays a render state
allocation for nothing. The fallback and the flag can both go once the engine
dirties those rows.
