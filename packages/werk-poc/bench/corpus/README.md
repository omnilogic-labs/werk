# corpus

One asciicast v2 file per case; `index.ts` is the manifest the runner reads
and this list should match it. Recorded cases come from `../record-all.sh`
(vim, ls, top, htop, tmux and bun on this machine, under `Bun.Terminal`),
synthetic ones from `../generate.ts`. A `"b"` event carries base64 bytes
where a chunk is not valid UTF-8 (a PTY read cut inside a character, or a
case that cuts one on purpose); asciinema players skip it.

## Recorded

| Case           | Size   | What it is                                                                                              |
| -------------- | ------ | ------------------------------------------------------------------------------------------------------- |
| `vim`          | 80×24  | `vim -u DEFAULTS -N` on a TypeScript file: move, insert a line, `:set nu`, search, `dd`, `u`, `:q!`     |
| `vim-reattach` | 80×24  | The same vim left open on the alternate screen, with the resize to 100×30 the reattach strategies apply |
| `ls-color`     | 100×30 | `ls --color=always -la /usr/lib /usr/bin`: 164 KB of coloured columns                                   |
| `bun-install`  | 80×24  | `bun install --no-cache` in a scratch project: its progress line redrawn with cursor moves              |
| `top`          | 100×30 | `top -b -n 3 -d 1`                                                                                      |
| `htop`         | 100×30 | `htop -d 10` for 2.5 s, then `q`: alternate screen, colours, box drawing, meters                        |
| `tmux`         | 100×30 | `tmux -f /dev/null new-session`: a shell, `echo`, a vertical split, `ls --color /`, detach              |

## Synthetic

| Case                      | Size  | What it is                                                                                                                                                                                                                                            |
| ------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent-like`              | 80×24 | The M2 counter TUI on the alternate screen for five frames, back to the primary screen, long styled soft-wrapped paragraphs, OSC 9;4 progress, a title, OSC 9 notification, a bell                                                                    |
| `build-progress`          | 80×24 | Four progress bars redrawn with CR, coloured warnings                                                                                                                                                                                                 |
| `unicode-2027-off`        | 40×16 | ZWJ family, skin tones, flags, Devanagari with combining marks, CJK full-width with ASCII, Arabic, Hebrew, combining diacritics, a wide character at the last column, emoji presentation selectors, zero-width characters, tabs; `CSI ? 2027 l` first |
| `unicode-2027-on`         | 40×16 | The same lines after `CSI ? 2027 h`                                                                                                                                                                                                                   |
| `reflow`                  | 80×24 | 30 long lines with styled tails, then 80 → 40 → 30×12 → 80 → 120×30                                                                                                                                                                                   |
| `reflow-cursor-boundary`  | 40×3  | 60 characters, the terminal shrinks to 20 columns with the cursor exactly at a wrap boundary, then one more character                                                                                                                                 |
| `osc133-prompt`           | 40×6  | OSC 133 A/B/C/D marks, the first `A` mid-line                                                                                                                                                                                                         |
| `c0-controls`             | 40×12 | Every C0 byte the parser does not act on, DEL, and stray C1 / invalid UTF-8 bytes, each between two letters                                                                                                                                           |
| `interrupted-csi`         | 40×6  | Writes cut inside CSI parameters and between ESC and `[`                                                                                                                                                                                              |
| `interrupted-osc`         | 40×6  | Writes cut inside OSC 2, OSC 8 and OSC 9;4 payloads                                                                                                                                                                                                   |
| `interrupted-utf8`        | 40×6  | Writes cut inside a 3-byte character, a 4-byte one and a ZWJ sequence                                                                                                                                                                                 |
| `interrupted-sgr`         | 40×6  | Writes cut inside `38;2` and `48;5` parameters                                                                                                                                                                                                        |
| `reattach-primary`        | 60×12 | ls-like coloured lines, a soft-wrapped paragraph, a BCE row, a hyperlink; then 60 → 100 columns                                                                                                                                                       |
| `reattach-primary-shrink` | 80×10 | Eight 70-column lines; then 80 → 50 columns                                                                                                                                                                                                           |
| `reattach-alt-counter`    | 40×10 | The counter TUI on the alternate screen; then 40×10 → 60×14                                                                                                                                                                                           |
| `reattach-alt-vim-like`   | 40×8  | A vim-shaped alternate screen drawn by hand; then 40×8 → 60×12                                                                                                                                                                                        |

The fuzz cases are not on disk: `../differential.ts` generates them from
the seed at run time (random bytes; random text, SGR, CSI and OSC 0/2/7/8/9
interleaved), each fed in four random pieces.
