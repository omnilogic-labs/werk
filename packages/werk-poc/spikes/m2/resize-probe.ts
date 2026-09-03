// A child that says what size it thinks its terminal is, for the resize
// scenario: three answers on one line, redrawn whenever any of them changes.
//
//   size <cols>x<rows>   what `process.stdout` reports when polled
//   events <n>           how many `resize` events the runtime has raised
//   asked <cols>x<rows>  what the terminal answers when the child parks
//                        the cursor at the far corner and asks where it is
//
// The last is the terminal's own word — the daemon's emulator on a pty that
// passes bytes through, the ConPTY on Windows — with nothing of the child's
// runtime in between. `q` quits.
export {};
const out = (s: string) => process.stdout.write(s);
let events = 0;
let asked = "?";
let last = "";
function draw(): void {
  const line = `size ${process.stdout.columns}x${process.stdout.rows} events ${events} asked ${asked}`;
  if (line === last) return;
  last = line;
  out(`\x1b[H\x1b[2J${line}\r\n`);
}
process.stdout.on("resize", () => {
  events++;
  draw();
});
draw();
setInterval(() => {
  draw();
  // Save the cursor, go to the far corner (clamped to the last cell), ask
  // for a cursor position report, and come back.
  out("\x1b7\x1b[999;999H\x1b[6n\x1b8");
}, 100);
(process.stdin as unknown as { setRawMode(v: boolean): void }).setRawMode(true);
process.stdin.on("data", (b: Buffer) => {
  const m = /\x1b\[(\d+);(\d+)R/.exec(b.toString("latin1"));
  if (m) {
    asked = `${m[2]}x${m[1]}`;
    draw();
  }
  if (b.includes(0x71) || b.includes(0x03)) process.exit(0);
});
process.stdin.resume();
