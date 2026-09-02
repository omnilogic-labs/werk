// A small agent-like TUI for the fidelity harness: a full-screen box on the
// alternate screen, a counter redrawn every 200 ms with cursor movement,
// and a status line. `q` quits.
const out = (s: string) => process.stdout.write(s);
const cols = process.stdout.columns || 80;
const rows = process.stdout.rows || 24;
let n = 0;
function frame() {
  const top = "┌" + "─".repeat(cols - 2) + "┐";
  const bottom = "└" + "─".repeat(cols - 2) + "┘";
  let s = "\x1b[?25l\x1b[H" + top;
  for (let y = 2; y < rows; y++) {
    s += `\x1b[${y};1H│\x1b[${y};${cols}H│`;
  }
  s += `\x1b[${rows};1H` + bottom;
  s += `\x1b[3;4H\x1b[1;36mcounter\x1b[0m: \x1b[33m${String(n).padStart(6)}\x1b[0m`;
  s += `\x1b[5;4Hthinking${".".repeat(n % 4)}   `;
  s += `\x1b[${rows - 1};4H\x1b[7m q to quit \x1b[0m`;
  s += `\x1b[${rows - 1};${cols - 12}H`; // park the cursor, visible
  s += "\x1b[?25h";
  out(s);
}
out("\x1b[?1049h\x1b[2J");
frame();
const timer = setInterval(() => {
  n++;
  frame();
}, 200);
(process.stdin as unknown as { setRawMode(v: boolean): void }).setRawMode(true);
process.stdin.on("data", (b: Buffer) => {
  if (b.includes(0x71) || b.includes(0x03)) {
    clearInterval(timer);
    out("\x1b[?1049l");
    process.exit(0);
  }
});
process.stdin.resume();
