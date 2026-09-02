// The corpus manifest: one entry per .cast file, with what it is for. The
// runner (../differential.ts) reads this; README.md in this directory is
// the human-facing list and should say the same things.

export type CaseKind =
  /** Replay every event, then compare the three engines' text, cells and effects. */
  | "replay"
  /** As replay, but the final resize event is applied after each reattach strategy, and the copies compared to the source. */
  | "reattach";

export interface CorpusCase {
  name: string;
  file: string;
  kind: CaseKind;
  /** "recorded" for a real program under Bun.Terminal, "synthetic" for bench/generate.ts. */
  source: "recorded" | "synthetic";
  notes: string;
}

export const CORPUS: CorpusCase[] = [
  // Recorded sessions (bench/record.ts).
  {
    name: "vim",
    file: "vim.cast",
    kind: "replay",
    source: "recorded",
    notes: "vim editing a file: insert, a few commands, :wq",
  },
  {
    name: "vim-reattach",
    file: "vim-reattach.cast",
    kind: "reattach",
    source: "recorded",
    notes: "vim open on the alternate screen, then the resize after reattach",
  },
  {
    name: "ls-color",
    file: "ls-color.cast",
    kind: "replay",
    source: "recorded",
    notes: "ls --color=always -la of a large directory",
  },
  {
    name: "bun-install",
    file: "bun-install.cast",
    kind: "replay",
    source: "recorded",
    notes: "bun install in a scratch project; its progress output",
  },
  {
    name: "top",
    file: "top.cast",
    kind: "replay",
    source: "recorded",
    notes: "top -b -n 3, batch mode",
  },
  {
    name: "htop",
    file: "htop.cast",
    kind: "replay",
    source: "recorded",
    notes: "htop for a few seconds, alternate screen, colours, box drawing",
  },
  {
    name: "tmux",
    file: "tmux.cast",
    kind: "replay",
    source: "recorded",
    notes: "a tmux session running a shell and a split, then detached",
  },
  // Synthetic (bench/generate.ts).
  {
    name: "agent-like",
    file: "agent-like.cast",
    kind: "replay",
    source: "synthetic",
    notes:
      "the M2 counter TUI on the alternate screen, then long styled wrapped paragraphs, progress and notifications",
  },
  {
    name: "build-progress",
    file: "build-progress.cast",
    kind: "replay",
    source: "synthetic",
    notes: "progress bars redrawn with CR, warnings, colours",
  },
  {
    name: "unicode-2027-off",
    file: "unicode-2027-off.cast",
    kind: "replay",
    source: "synthetic",
    notes:
      "ZWJ, skin tones, flags, Devanagari, CJK, RTL, combining, wide at the last column, tabs; grapheme clustering off",
  },
  {
    name: "unicode-2027-on",
    file: "unicode-2027-on.cast",
    kind: "replay",
    source: "synthetic",
    notes: "the same with CSI ? 2027 h first",
  },
  {
    name: "reflow",
    file: "reflow.cast",
    kind: "replay",
    source: "synthetic",
    notes: "30 long lines then 80 -> 40 -> 30x12 -> 80 -> 120x30",
  },
  {
    name: "reflow-cursor-boundary",
    file: "reflow-cursor-boundary.cast",
    kind: "replay",
    source: "synthetic",
    notes:
      "the cursor exactly at a wrap boundary when the terminal shrinks, then one more character",
  },
  {
    name: "osc133-prompt",
    file: "osc133-prompt.cast",
    kind: "replay",
    source: "synthetic",
    notes: "OSC 133 A/B/C/D marks, one of them mid-line",
  },
  {
    name: "c0-controls",
    file: "c0-controls.cast",
    kind: "replay",
    source: "synthetic",
    notes:
      "every C0 byte the parser does not act on, DEL, and stray C1 / invalid bytes between letters",
  },
  {
    name: "interrupted-csi",
    file: "interrupted-csi.cast",
    kind: "replay",
    source: "synthetic",
    notes: "writes cut inside CSI parameters and between ESC and [",
  },
  {
    name: "interrupted-osc",
    file: "interrupted-osc.cast",
    kind: "replay",
    source: "synthetic",
    notes: "writes cut inside OSC 2, OSC 8 and OSC 9;4 payloads",
  },
  {
    name: "interrupted-utf8",
    file: "interrupted-utf8.cast",
    kind: "replay",
    source: "synthetic",
    notes: "writes cut inside a 3-byte, a 4-byte and a ZWJ sequence",
  },
  {
    name: "interrupted-sgr",
    file: "interrupted-sgr.cast",
    kind: "replay",
    source: "synthetic",
    notes: "writes cut inside 38;2 and 48;5 parameters",
  },
  {
    name: "reattach-primary",
    file: "reattach-primary.cast",
    kind: "reattach",
    source: "synthetic",
    notes:
      "ls-like colours, a soft-wrapped paragraph, a BCE row, a link; then 60 -> 100 columns",
  },
  {
    name: "reattach-primary-shrink",
    file: "reattach-primary-shrink.cast",
    kind: "reattach",
    source: "synthetic",
    notes: "eight long lines; then 80 -> 50 columns",
  },
  {
    name: "reattach-alt-counter",
    file: "reattach-alt-counter.cast",
    kind: "reattach",
    source: "synthetic",
    notes: "the counter TUI on the alternate screen; then 40x10 -> 60x14",
  },
  {
    name: "reattach-alt-vim-like",
    file: "reattach-alt-vim-like.cast",
    kind: "reattach",
    source: "synthetic",
    notes: "a vim-shaped alternate screen; then 40x8 -> 60x12",
  },
];
