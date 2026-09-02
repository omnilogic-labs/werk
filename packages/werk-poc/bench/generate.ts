// Writes the synthetic corpus cases into bench/corpus/*.cast. Deterministic;
// run `bun run bench/generate.ts` after changing a case and commit the
// files. Recorded sessions come from bench/record.ts instead.

import path from "node:path";
import { CastBuilder, writeCast, type Cast } from "./cast.ts";

const DIR = path.join(import.meta.dir, "corpus");
const enc = new TextEncoder();

const ALT_ON = "\x1b[?1049h\x1b[2J\x1b[H";
const ALT_OFF = "\x1b[?1049l";

/** The counter TUI from spikes/m2/counter.ts, one frame, drawn for a given size. */
export function counterFrame(cols: number, rows: number, n: number): string {
  const top = "┌" + "─".repeat(cols - 2) + "┐";
  const bottom = "└" + "─".repeat(cols - 2) + "┘";
  let s = "\x1b[?25l\x1b[H" + top;
  for (let y = 2; y < rows; y++) s += `\x1b[${y};1H│\x1b[${y};${cols}H│`;
  s += `\x1b[${rows};1H` + bottom;
  s += `\x1b[3;4H\x1b[1;36mcounter\x1b[0m: \x1b[33m${String(n).padStart(6)}\x1b[0m`;
  s += `\x1b[5;4Hthinking${".".repeat(n % 4)}   `;
  s += `\x1b[${rows - 1};4H\x1b[7m q to quit \x1b[0m`;
  s += `\x1b[${rows - 1};${cols - 12}H`;
  s += "\x1b[?25h";
  return s;
}

const LOREM =
  "The quick brown fox jumps over the lazy dog while the daemon keeps the PTY " +
  "open and the client comes and goes; every byte the child writes is fed to " +
  "the emulator once and re-emitted to whoever attaches next, so what the " +
  "viewer sees is the screen and not the stream. ";

/** Long styled paragraphs, soft-wrapped by the terminal, as an agent's transcript looks. */
function paragraphs(n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) {
    const style = [
      "\x1b[1m",
      "\x1b[3m",
      "\x1b[38;5;75m",
      "\x1b[38;2;200;120;40m",
      "",
    ][i % 5];
    s += `${style}[${i + 1}] ${LOREM.repeat(1 + (i % 3))}\x1b[0m\r\n\r\n`;
  }
  return s;
}

function unicodeTorture(): { on: Cast; off: Cast } {
  const lines = [
    "ZWJ family: 👨‍👩‍👧 end",
    "skin tones: 👍🏽 👋🏿 end",
    "flags: 🇬🇧🇯🇵🇺🇳 end",
    "devanagari: नमस्ते क्षत्रिय end",
    "cjk/ascii: 漢字abc全角ＡＢＣ日本語 end",
    "arabic: مرحبا بالعالم end",
    "hebrew: שלום עולם end",
    "combining: é ä ñ ộ end",
    "wide at last col: " + "x".repeat(20 - 18 - 1) + "日本",
    "x".repeat(39) + "字tail",
    "emoji presentation: ☺ ☺️ ✔ ✔️ ❤️ end",
    "zero width: a​b‌c‍d end",
    "tabs:\ta\tb\tc end",
  ];
  const body = lines.join("\r\n") + "\r\n";
  const mk = (mode: string, title: string) =>
    new CastBuilder(40, 16, title).o(mode).o(body).build();
  return {
    off: mk("\x1b[?2027l", "unicode torture, DEC 2027 off"),
    on: mk("\x1b[?2027h", "unicode torture, DEC 2027 on"),
  };
}

function reflow(): Cast {
  // Wrap, shrink, regrow: the M2 reflow sequence as a regression.
  const b = new CastBuilder(80, 24, "reflow: wrap, shrink, regrow");
  for (let i = 0; i < 30; i++)
    b.o(
      `${String(i).padStart(3, "0")} ${"word ".repeat(12)}${i % 2 ? "\x1b[1mbold tail\x1b[0m" : "plain tail"}\r\n`,
    );
  b.o("prompt> ");
  b.r(40, 24).r(30, 12).r(80, 24).r(120, 30);
  return b.build();
}

function reflowCursorBoundary(): Cast {
  // The cursor sits exactly at a wrap boundary when the terminal shrinks,
  // then a character is written. Where it lands is the case.
  return new CastBuilder(40, 3, "reflow with the cursor at a wrap boundary")
    .o("a".repeat(60))
    .r(20, 3)
    .o("!")
    .build();
}

function interrupted(): Cast[] {
  // Every event is one write; the split points are the case.
  const midCsi = new CastBuilder(40, 6, "interrupted mid-CSI")
    .o("one \x1b[1;3")
    .o("1mred bold italic\x1b[0m two\r\n")
    .o("\x1b")
    .o("[2;5H")
    .o("at 2;5\x1b[")
    .o("")
    .o("4m")
    .o("under\x1b[0m")
    .build();
  const midOsc = new CastBuilder(40, 6, "interrupted mid-OSC")
    .o("\x1b]2;half a ti")
    .o("tle\x07")
    .o("\x1b]8;;http://exam")
    .o("ple.com\x1b\\link\x1b]8;;\x1b\\ plain\r\n")
    .o("\x1b]9;4;1;")
    .o("42\x07after progress\r\n")
    .build();
  const euro = enc.encode("€");
  const family = enc.encode("👨‍👩‍👧");
  const midUtf8 = new CastBuilder(40, 6, "interrupted mid-UTF-8")
    .o(euro.subarray(0, 1))
    .o(euro.subarray(1))
    .o(" ok ")
    .o(family.subarray(0, 5))
    .o(family.subarray(5, 9))
    .o(family.subarray(9))
    .o(" ok\r\n日")
    .o(enc.encode("本").subarray(0, 2))
    .o(enc.encode("本").subarray(2))
    .o("語\r\n")
    .build();
  const midSgrLong = new CastBuilder(40, 6, "interrupted mid-truecolour SGR")
    .o("\x1b[38;2;10")
    .o(";20;")
    .o("30m")
    .o("rgb\x1b[0m \x1b[48;5;")
    .o("214m")
    .o("bg\x1b[0m\r\n")
    .build();
  return [midCsi, midOsc, midUtf8, midSgrLong];
}

function reattachPrimary(): Cast {
  // Output on the primary screen with soft wraps, BCE and a link, then the
  // resize the runner applies after each reattach strategy.
  const b = new CastBuilder(60, 12, "reattach then resize, primary screen");
  b.o("$ ls --color\r\n");
  for (let i = 0; i < 6; i++)
    b.o(
      `\x1b[1;34mdir${i}\x1b[0m  \x1b[32mexec${i}\x1b[0m  plain${i}  ${"file-with-a-long-name-".repeat(2)}${i}.txt\r\n`,
    );
  b.o(LOREM.repeat(2) + "\r\n");
  b.o("\x1b[44m\x1b[K\x1b[0m\r\n");
  b.o(
    "\x1b]8;;https://example.com\x1b\\a link\x1b]8;;\x1b\\ and \x1b[4munderlined\x1b[0m\r\n",
  );
  b.o("$ ");
  b.r(100, 12);
  return b.build();
}

function reattachPrimaryShrink(): Cast {
  const b = new CastBuilder(80, 10, "reattach then shrink, primary screen");
  for (let i = 0; i < 8; i++) b.o(`${i}: ${LOREM.slice(0, 70)}\r\n`);
  b.o("$ ");
  b.r(50, 10);
  return b.build();
}

function reattachAltCounter(): Cast {
  const b = new CastBuilder(
    40,
    10,
    "reattach then resize, alternate screen, counter TUI",
  );
  b.o(ALT_ON);
  for (let n = 0; n < 3; n++) b.o(counterFrame(40, 10, n));
  b.r(60, 14);
  return b.build();
}

function reattachAltVimLike(): Cast {
  // A vim-shaped alternate screen drawn by hand: tildes, a status line,
  // the cursor in the text.
  const b = new CastBuilder(
    40,
    8,
    "reattach then resize, alternate screen, vim-like",
  );
  b.o(ALT_ON);
  b.o(
    "first line of the file\r\nsecond line\r\n" +
      "\x1b[1;34m~\x1b[0m\r\n".repeat(4),
  );
  b.o("\x1b[8;1H\x1b[7m file.txt  2L, 34B \x1b[0m\x1b[8;30H2,1\x1b[2;3H");
  b.r(60, 12);
  return b.build();
}

function agentLike(): Cast {
  const b = new CastBuilder(
    80,
    24,
    "agent-like: counter TUI then wrapped styled paragraphs",
  );
  b.o(ALT_ON);
  for (let n = 0; n < 5; n++) b.o(counterFrame(80, 24, n));
  b.o(ALT_OFF);
  b.o(paragraphs(12));
  b.o("\x1b]9;4;1;80\x07\x1b]0;agent: working\x07");
  b.o(paragraphs(4));
  b.o("\x1b]9;4;0\x07\x1b]9;done\x07\x07");
  return b.build();
}

function progressBars(): Cast {
  const b = new CastBuilder(80, 24, "noisy build: progress bars with CR");
  for (let i = 0; i < 4; i++) {
    b.o(`\x1b[1mBuilding target ${i}\x1b[0m\r\n`);
    for (let p = 0; p <= 100; p += 7) {
      const filled = Math.round(p / 4);
      b.o(
        `\r[\x1b[32m${"#".repeat(filled)}\x1b[0m${" ".repeat(25 - filled)}] ${String(p).padStart(3)}%`,
      );
    }
    b.o("\r[\x1b[32m#########################\x1b[0m] 100%\r\n");
    b.o(`\x1b[33mwarning\x1b[0m: something in file${i}.ts:12:3\r\n`);
  }
  b.o("\x1b[1;32mdone\x1b[0m in 3.2s\r\n");
  return b.build();
}

function osc133Prompt(): Cast {
  // Semantic prompt marks mid-line: kitty's spec lets a terminal move to a
  // fresh line on 133;A when the cursor is not at column 0.
  return new CastBuilder(40, 6, "OSC 133 prompt marks mid-line")
    .o(
      "abc\x1b]133;A\x07$ \x1b]133;B\x07ls\x1b]133;C\x07\r\nout\x1b]133;D;0\x07",
    )
    .o("\x1b]133;A\x07$ ")
    .build();
}

function c0Controls(): Cast {
  // Every C0 byte the parser does not act on, DEL, and stray C1 bytes as
  // raw (invalid UTF-8) bytes, each between two letters.
  const b = new CastBuilder(40, 12, "C0 controls, DEL and stray C1 bytes");
  const bytes: number[] = [];
  for (let c = 0; c < 0x20; c++)
    if (![0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1b].includes(c))
      bytes.push(c);
  bytes.push(0x7f, 0x80, 0x85, 0x9b, 0x9c, 0xc0, 0xff);
  for (const c of bytes) b.o(new Uint8Array([0x61, c, 0x62, 0x20]));
  return b.build();
}

export const SYNTHETIC: Record<string, () => Cast | Cast[]> = {
  "osc133-prompt": osc133Prompt,
  "c0-controls": c0Controls,
  "unicode-2027-off": () => unicodeTorture().off,
  "unicode-2027-on": () => unicodeTorture().on,
  reflow,
  "reflow-cursor-boundary": reflowCursorBoundary,
  "reattach-primary": reattachPrimary,
  "reattach-primary-shrink": reattachPrimaryShrink,
  "reattach-alt-counter": reattachAltCounter,
  "reattach-alt-vim-like": reattachAltVimLike,
  "agent-like": agentLike,
  "build-progress": progressBars,
};

const INTERRUPTED = [
  "interrupted-csi",
  "interrupted-osc",
  "interrupted-utf8",
  "interrupted-sgr",
];

if (import.meta.main) {
  for (const [name, make] of Object.entries(SYNTHETIC)) {
    const c = make();
    writeCast(path.join(DIR, `${name}.cast`), Array.isArray(c) ? c[0]! : c);
  }
  interrupted().forEach((c, i) =>
    writeCast(path.join(DIR, `${INTERRUPTED[i]}.cast`), c),
  );
  console.log(
    `wrote ${Object.keys(SYNTHETIC).length + INTERRUPTED.length} cases to ${DIR}`,
  );
}
