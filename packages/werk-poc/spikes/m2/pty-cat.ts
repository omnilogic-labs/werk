// A fast terminal stand-in in a process of its own: spawns a command under
// a PTY, drains the PTY into memory as quickly as a dedicated event loop
// can, forwards its own stdin to the PTY, and writes everything it saw to a
// file. The harness process cannot play this role itself: feeding a WASM
// emulator inline, or a GC pause under `bun test`, is enough to stall the
// PTY for 50 ms, and at ~10 MB/s that fills the daemon's 256 KiB bound and
// marks the "fast" client lagging (findings/m2.md).
//
//   bun run pty-cat.ts --cols=80 --rows=24 --out=<file> --marker=<text> -- <argv...>
//
// A progress file `<out>.json` is rewritten every 100 ms with the bytes
// seen and whether `marker` has appeared; when it appears, everything so
// far is written to `<out>`. On the child's exit `<out>` is written again
// with everything, and this process exits with the child's code.

import fs from "node:fs";

let cols = 80;
let rows = 24;
let out = "";
let marker = "";
let argv: string[] = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a === "--") {
    argv = args.slice(i + 1);
    break;
  }
  if (a.startsWith("--cols=")) cols = Number(a.slice(7));
  else if (a.startsWith("--rows=")) rows = Number(a.slice(7));
  else if (a.startsWith("--out=")) out = a.slice(6);
  else if (a.startsWith("--marker=")) marker = a.slice(9);
}
if (!out || argv.length === 0) {
  console.error(
    "usage: pty-cat.ts --out=<file> [--marker=<text>] -- <argv...>",
  );
  process.exit(2);
}

const chunks: Uint8Array[] = [];
let bytes = 0;
let sawMarker = false;
let tail = "";
const dec = new TextDecoder();

function dump(): void {
  fs.writeFileSync(out, Buffer.concat(chunks));
}
function progress(): void {
  fs.writeFileSync(`${out}.json`, JSON.stringify({ bytes, sawMarker }));
}

const proc = Bun.spawn(argv, {
  env: process.env as Record<string, string>,
  terminal: {
    cols,
    rows,
    data: (_t, data) => {
      const copy = new Uint8Array(data);
      chunks.push(copy);
      bytes += copy.length;
      if (marker && !sawMarker) {
        tail = (tail + dec.decode(copy, { stream: true })).slice(-4096);
        if (tail.includes(marker)) {
          sawMarker = true;
          dump();
          progress();
        }
      }
    },
  },
});

const timer = setInterval(progress, 100);

// A SIGTERM to this process ends the child too, so a harness tearing down
// does not orphan a `wp attach`.
process.on("SIGTERM", () => {
  try {
    proc.kill("SIGKILL");
  } catch {}
});

(async () => {
  for await (const chunk of Bun.stdin.stream()) {
    if (!proc.terminal || proc.terminal.closed) break;
    proc.terminal.write(chunk);
  }
})().catch(() => {});

const code = await proc.exited;
await Bun.sleep(100);
clearInterval(timer);
dump();
progress();
try {
  proc.terminal?.close();
} catch {}
process.exit(code);
