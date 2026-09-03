// A fast terminal stand-in in a process of its own: spawns a command with a
// terminal on its stdin, drains everything it writes into memory as quickly
// as a dedicated event loop can, forwards its own stdin to the command, and
// writes everything it saw to a file. The harness process cannot play this
// role itself: feeding a WASM emulator inline, or a GC pause under `bun
// test`, is enough to stall the sink for 50 ms, and at ~10 MB/s that fills
// the daemon's 256 KiB bound and marks the "fast" client lagging
// (findings/m2.md).
//
//   bun run pty-cat.ts --cols=80 --rows=24 --out=<file> --marker=<text> \
//     [--sink=pty|pipe|file] -- <argv...>
//
// Three sinks, because where the bytes are lost is itself a question
// (findings/platforms.md, "Back-pressure"). Each takes one more thing out of
// the path between the client and the bytes on disk:
//
//   --sink=pty   the command's stdin, stdout and stderr are one PTY, and
//                this process drains the master. What a real terminal does,
//                and what the fidelity scenarios have always measured.
//   --sink=pipe  the command keeps a PTY on stdin — `wp attach` needs raw
//                mode, so it needs a terminal there — and writes to a pipe
//                this process drains. No line discipline: nothing between
//                the client and this process does output processing.
//   --sink=file  as the pipe, but the command writes straight to `<out>`.
//                A regular file cannot apply back-pressure and nothing in
//                this process has to keep up, so a loss that survives this
//                sink is upstream of the client's own fd 1.
//
// The pipe and file sinks need a PTY pair for stdin, which Bun 1.3.14 will
// not hand out on its own (`Bun.spawn({ terminal })` takes all three fds and
// `Bun.Terminal` exposes no fd), so they open one through libc. Where that
// fails the run says so and falls back to the PTY. Under those two sinks
// `--cols`/`--rows` do nothing: nobody sets a window size on that pair, and
// a client whose stdout is not a terminal takes its own default size.
//
// A progress file `<out>.json` is rewritten every 100 ms with the bytes seen
// so far, whether `marker` has appeared, and which sink carried them. Under
// the PTY and pipe sinks `<out>` is written when the marker appears, again on
// every tick that adds bytes after it — a reader comparing screens wants what
// arrived after the marker too, and the pipe sink hands the marker over in a
// chunk of its own where the PTY's coalescing carried the next prompt with
// it — and once more when the child exits; under the file sink the client
// wrote it all along. This process exits with the child's code.

import fs from "node:fs";

let cols = 80;
let rows = 24;
let out = "";
let marker = "";
let sink = "pty";
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
  else if (a.startsWith("--sink=")) sink = a.slice(7);
}
if (!out || argv.length === 0 || !["pty", "pipe", "file"].includes(sink)) {
  console.error(
    "usage: pty-cat.ts --out=<file> [--marker=<text>] [--sink=pty|pipe|file] -- <argv...>",
  );
  process.exit(2);
}

const chunks: Uint8Array[] = [];
let bytes = 0;
let dumped = -1;
let sawMarker = false;
let tail = "";
const dec = new TextDecoder();

function dump(): void {
  if (sink === "file") return; // the client wrote `out` itself
  fs.writeFileSync(out, Buffer.concat(chunks));
  dumped = bytes;
}
/** Under the file sink there is nothing in memory to count: ask the file. */
function poll(): void {
  if (sink !== "file") return;
  try {
    bytes = fs.statSync(out).size;
  } catch {
    return;
  }
  if (!marker || sawMarker || bytes === 0) return;
  const from = Math.max(0, bytes - 4096);
  const buf = Buffer.alloc(bytes - from);
  const fd = fs.openSync(out, "r");
  try {
    fs.readSync(fd, buf, 0, buf.length, from);
  } finally {
    fs.closeSync(fd);
  }
  if (buf.toString("latin1").includes(marker)) sawMarker = true;
}
function progress(): void {
  poll();
  if (sawMarker && dumped !== bytes) dump();
  fs.writeFileSync(`${out}.json`, JSON.stringify({ bytes, sawMarker, sink }));
}
/** Every byte the client wrote, whatever the sink carried it. */
function take(data: Uint8Array): void {
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
}

/**
 * A PTY pair through libc: `posix_openpt`, `grantpt`, `unlockpt`, `ptsname`,
 * then the slave opened by name. Returns the master fd and the slave fd, or
 * null with the reason on stderr.
 */
async function openPtyPair(): Promise<{
  master: number;
  slave: number;
} | null> {
  const names =
    process.platform === "darwin"
      ? ["libSystem.B.dylib", "libc.dylib"]
      : [
          "libc.so.6",
          "libc.so",
          `libc.musl-${process.arch === "arm64" ? "aarch64" : "x86_64"}.so.1`,
        ];
  const O_RDWR = 2;
  const O_NOCTTY = process.platform === "darwin" ? 0x20000 : 0o400;
  let last = "";
  for (const name of names) {
    try {
      const { dlopen, FFIType } = await import("bun:ffi");
      const libc = dlopen(name, {
        posix_openpt: { args: [FFIType.i32], returns: FFIType.i32 },
        grantpt: { args: [FFIType.i32], returns: FFIType.i32 },
        unlockpt: { args: [FFIType.i32], returns: FFIType.i32 },
        ptsname: { args: [FFIType.i32], returns: FFIType.cstring },
      });
      const master = libc.symbols.posix_openpt(O_RDWR | O_NOCTTY);
      if (master < 0) throw new Error(`posix_openpt returned ${master}`);
      if (libc.symbols.grantpt(master) !== 0) throw new Error("grantpt failed");
      if (libc.symbols.unlockpt(master) !== 0)
        throw new Error("unlockpt failed");
      const path = String(libc.symbols.ptsname(master));
      if (!path) throw new Error("ptsname returned nothing");
      return { master, slave: fs.openSync(path, O_RDWR) };
    } catch (e) {
      last = `${name}: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  console.error(`pty-cat: no PTY pair for the ${sink} sink (${last})`);
  return null;
}

const pair = sink === "pty" ? null : await openPtyPair();
if (!pair) sink = "pty";

/** Bytes towards the client: the PTY master either way. */
let write: (chunk: Uint8Array) => void;
let kill: () => void;
/** The child is gone and everything it wrote has reached `out`. */
let finish: () => Promise<number>;

if (pair) {
  const outFd = sink === "file" ? fs.openSync(out, "w") : undefined;
  const child = Bun.spawn(argv, {
    env: process.env as Record<string, string>,
    stdin: pair.slave,
    stdout: outFd ?? "pipe",
    stderr: "inherit",
  });
  // The parent's copies of the child's ends are not the child's; closing them
  // keeps this process from holding them open after the child has gone.
  fs.closeSync(pair.slave);
  if (outFd !== undefined) fs.closeSync(outFd);
  const drained =
    outFd === undefined
      ? (async () => {
          const reader = (
            child.stdout as ReadableStream<Uint8Array>
          ).getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) take(value);
          }
        })()
      : Promise.resolve();
  write = (chunk) => {
    fs.writeSync(pair.master, chunk);
  };
  kill = () => child.kill("SIGKILL");
  finish = async () => {
    const code = await child.exited;
    await drained;
    return code;
  };
} else {
  const child = Bun.spawn(argv, {
    env: process.env as Record<string, string>,
    terminal: { cols, rows, data: (_t, data) => take(data) },
  });
  write = (chunk) => {
    if (!child.terminal || child.terminal.closed) throw new Error("closed");
    child.terminal.write(chunk);
  };
  kill = () => child.kill("SIGKILL");
  finish = async () => {
    const code = await child.exited;
    // The last data callbacks land after the child has gone.
    await Bun.sleep(100);
    try {
      child.terminal?.close();
    } catch {}
    return code;
  };
}

const timer = setInterval(progress, 100);

// A SIGTERM to this process ends the child too, so a harness tearing down
// does not orphan a `wp attach`.
process.on("SIGTERM", () => {
  try {
    kill();
  } catch {}
});

(async () => {
  for await (const chunk of Bun.stdin.stream()) write(chunk);
})().catch(() => {});

const code = await finish();
clearInterval(timer);
dump();
progress();
process.exit(code);
