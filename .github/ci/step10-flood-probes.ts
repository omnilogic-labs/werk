// How fast a session's PTY carries a flood, by producer.
//
//   bun run .github/ci/step10-flood-probes.ts [producer ...]
//
// The daemon's slow-client rule and the snapshot lag-resume both push
// megabytes through a session and wait for the end of it. On a ConPTY the
// end took longer than a minute to arrive, and the figure recorded for it —
// about 20 KiB/s — was measured with one producer, `yes | head -c` under
// MSYS `sh`. This asks whether that is the pseudoconsole or the producer:
// it pours the same 4 MiB through the daemon's own PTY path (a real daemon
// in a private runtime directory, `run` and `attach` over the socket, so
// the emulator and the client queue are in the path exactly as the tests
// have them) from several producers, and prints one line per producer:
//
//   PROBE flood-<producer>: <MiB/s> MiB/s — <bytes> B in <s> s ...
//
// followed by what the reader's chunks looked like, since each `output`
// frame is one PTY read. A second pass, `direct-<producer>`, spawns the
// same child through `Session` with no client attached, so the socket and
// the queue are out of the path and what is left is the PTY and the
// emulator. Producers that need a program this machine lacks are skipped.
// Nothing here fails: the numbers are the verdict.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { connect } from "../../packages/werk-poc/src/client/index.ts";
import {
  stopDaemon,
  tempDir,
} from "../../packages/werk-poc/src/daemon/_testlib.ts";
import { Session } from "../../packages/werk-poc/src/daemon/session.ts";
import { loadGhosttyWasmEngine } from "../../packages/werk-poc/src/engine/ghostty-wasm/bun.ts";

const BYTES = Number(process.env.FLOOD_BYTES ?? 4 * 1024 * 1024);
/** How long one producer may take before it is cut off and reported as incomplete. */
const LIMIT_MS = Number(process.env.FLOOD_LIMIT_MS ?? 45_000);
const MiB = 1024 * 1024;

const only = process.argv.slice(2);
const want = (name: string) => only.length === 0 || only.includes(name);

console.log(
  `platform=${process.platform} arch=${process.arch} bun=${Bun.version} release=${os.release()} flood=${BYTES} B limit=${LIMIT_MS} ms`,
);

// ------------------------------------------------------------ the corpus

const work = fs.mkdtempSync(path.join(os.tmpdir(), "wp-flood-"));

/** `pattern` repeated to `bytes`, cut at a pattern boundary. */
function corpus(pattern: string, bytes: number): Buffer {
  const reps = Math.floor(bytes / pattern.length);
  return Buffer.from(pattern.repeat(reps));
}

const patterns = {
  lines: "y\n",
  longline: "y",
  escapes: "\x1b[31my\x1b[0m\n",
  lines80: `${"y".repeat(79)}\n`,
};

const files: Record<string, string> = {};
for (const [name, pattern] of Object.entries(patterns)) {
  const p = path.join(work, `${name}.txt`);
  fs.writeFileSync(p, corpus(pattern, BYTES));
  files[name] = p;
}

/** A `bun -e` script that writes `pattern` up to `bytes` in 64 KiB chunks, then DONE. */
function bunScript(pattern: string, bytes: number, stream: boolean): string {
  const chunkReps = Math.max(1, Math.floor((64 * 1024) / pattern.length));
  return [
    `const fs=require("node:fs");`,
    `const pat=${JSON.stringify(pattern)};`,
    `const chunk=Buffer.from(pat.repeat(${chunkReps}));`,
    `let left=${bytes};`,
    stream
      ? `const w=(b)=>new Promise((r)=>process.stdout.write(b,()=>r()));` +
        `while(left>0){const n=Math.min(left,chunk.length);await w(chunk.subarray(0,n));left-=n;}` +
        `await w("DONE\\n");`
      : `const w=(b,n)=>{let off=0;while(off<n){try{off+=fs.writeSync(1,b,off,n-off);}catch(e){if(e.code!=="EAGAIN")throw e;}}};` +
        `while(left>0){const n=Math.min(left,chunk.length);w(chunk,n);left-=n;}` +
        `w(Buffer.from("DONE\\n"),5);`,
  ].join("");
}

/** For Windows shells: a path they read without escaping trouble. */
const win = (p: string) => p.replace(/\//g, "\\");

interface Producer {
  name: string;
  /** What the child is expected to write before DONE, in bytes, before any line-discipline expansion. */
  bytes: number;
  /** Null when this machine lacks the program. */
  argv: () => string[] | null;
}

const bun = process.execPath;
const producers: Producer[] = [
  {
    // What daemon.test.ts and attach-snapshot.test.ts run today.
    name: "yes-head",
    bytes: BYTES,
    argv: () =>
      Bun.which("sh")
        ? ["sh", "-c", `yes | head -c ${BYTES}; echo DONE`]
        : null,
  },
  {
    name: "sh-cat",
    bytes: BYTES,
    argv: () =>
      Bun.which("sh") ? ["sh", "-c", `cat "${files.lines}"; echo DONE`] : null,
  },
  {
    name: "cmd-type",
    bytes: BYTES,
    argv: () =>
      process.platform === "win32" && Bun.which("cmd")
        ? ["cmd", "/c", `type "${win(files.lines!)}" & echo DONE`]
        : null,
  },
  {
    name: "pwsh-bytes",
    bytes: BYTES,
    argv: () =>
      process.platform === "win32" && Bun.which("powershell")
        ? [
            "powershell",
            "-NoProfile",
            "-Command",
            `$s=[Console]::OpenStandardOutput(); $b=[IO.File]::ReadAllBytes('${win(files.lines!)}'); $s.Write($b,0,$b.Length); $s.Flush(); [Console]::Out.WriteLine('DONE')`,
          ]
        : null,
  },
  {
    name: "bun-lines",
    bytes: BYTES,
    argv: () => [bun, "-e", bunScript(patterns.lines, BYTES, false)],
  },
  {
    name: "bun-lines-stream",
    bytes: BYTES,
    argv: () => [bun, "-e", bunScript(patterns.lines, BYTES, true)],
  },
  {
    name: "bun-longline",
    bytes: BYTES,
    argv: () => [bun, "-e", bunScript(patterns.longline, BYTES, false)],
  },
  {
    name: "bun-escapes",
    bytes: BYTES,
    argv: () => [bun, "-e", bunScript(patterns.escapes, BYTES, false)],
  },
  {
    name: "bun-lines80",
    bytes: BYTES,
    argv: () => [bun, "-e", bunScript(patterns.lines80, BYTES, false)],
  },
];

// ------------------------------------------------------------- helpers

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function quantiles(xs: number[]): string {
  if (xs.length === 0) return "no reads";
  const s = [...xs].sort((a, b) => a - b);
  const at = (q: number) =>
    s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
  return `${s.length} reads: min ${s[0]} / p50 ${at(0.5)} / p90 ${at(0.9)} / max ${s[s.length - 1]} B`;
}

const rate = (bytes: number, ms: number) =>
  ms > 0 ? (bytes / MiB / (ms / 1000)).toFixed(2) : "?";

// --------------------------------------------- through the daemon

const dir = tempDir();
const client = await connect({ dir, requestTimeoutMs: 20_000 });
console.log(`daemon pid ${client.daemon.pid} in ${dir}`);

for (const p of producers) {
  if (!want(p.name)) continue;
  const argv = p.argv();
  if (!argv) {
    console.log(`PROBE flood-${p.name}: skipped — no program for it here`);
    continue;
  }
  const chunks: number[] = [];
  const dec = new TextDecoder();
  let received = 0;
  let lagged = 0;
  let tail = "";
  let first = 0;
  let done = 0;
  const t0 = performance.now();
  const { id } = await client.run({ argv, cols: 80, rows: 24 });
  await client.attach(id, {
    cols: 80,
    rows: 24,
    onOutput: (b) => {
      if (first === 0) first = performance.now();
      chunks.push(b.length);
      received += b.length;
      tail = (tail + dec.decode(b, { stream: true })).slice(-32);
      if (done === 0 && tail.includes("DONE")) done = performance.now();
    },
    onRender: (b) => {
      if (first === 0 && b.length > 0) first = performance.now();
    },
    onLag: () => lagged++,
  });
  while (done === 0 && performance.now() - t0 < LIMIT_MS) await sleep(20);
  const end = done || performance.now();
  const recvMs = end - (first || t0);
  const wallMs = end - t0;
  const complete = done !== 0;
  console.log(
    `PROBE flood-${p.name}: ${rate(received, recvMs)} MiB/s — ${received} B in ${(recvMs / 1000).toFixed(1)} s (wall ${(wallMs / 1000).toFixed(1)} s${complete ? "" : `, incomplete at ${LIMIT_MS} ms`}; ${p.bytes} B written${lagged ? `; the client lagged ${lagged}x` : ""})`,
  );
  console.log(`  reads flood-${p.name}: ${quantiles(chunks)}`);
  await client.kill(id, "SIGKILL").catch(() => {});
  await sleep(200);
}

await stopDaemon(dir, client);

// ------------------------------------------------ the PTY on its own

const engine = await loadGhosttyWasmEngine();
for (const p of producers) {
  if (!want(p.name)) continue;
  const argv = p.argv();
  if (!argv) continue;
  const t0 = performance.now();
  let exitedAt = 0;
  const s = new Session({
    id: "probe0",
    argv,
    cwd: process.cwd(),
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        (kv): kv is [string, string] => typeof kv[1] === "string",
      ),
    ),
    cols: 80,
    rows: 24,
    engine,
    log: () => {},
    onExit: () => (exitedAt = performance.now()),
  });
  while (exitedAt === 0 && performance.now() - t0 < LIMIT_MS) await sleep(20);
  const complete = exitedAt !== 0;
  const ms = (exitedAt || performance.now()) - t0;
  console.log(
    `PROBE direct-${p.name}: ${rate(s.bytesFromPty, ms)} MiB/s — ${s.bytesFromPty} B from the PTY in ${(ms / 1000).toFixed(1)} s${complete ? "" : ` (incomplete at ${LIMIT_MS} ms)`}`,
  );
  if (!complete) s.kill("force");
  await sleep(200);
  s.dispose();
}

fs.rmSync(work, { recursive: true, force: true });
process.exit(0);
