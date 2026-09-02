// Does a `Bun.file(path).arrayBuffer()` read close an fd it no longer owns?
//
// The M3 daemon tests hung on a client whose socket the daemon saw hang up
// while the client saw nothing, always after the test process had loaded
// the WASM in-process through `Bun.file(path).arrayBuffer()`. This probe
// isolates it: one Unix socket server and one client in a single process,
// then `n` reads through the API under test, then a forced GC; if the
// server's `close` fires for a client that never closed, an fd was closed
// under it. M2 saw the same shape (findings/m2.md, "a stalled Bun.file(fd)
// read ... appears to break a later Bun.connect client") and blamed the
// readiness pipe; this narrows it.
//
//   bun run spikes/m3/fd-reuse.ts            # every variant
//   bun run spikes/m3/fd-reuse.ts bunfile    # one variant

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ghosttyWasmBytes,
  ghosttyWasmPath,
} from "../../src/engine/ghostty-wasm/bytes.ts";
import { GhosttyWasmEngine } from "../../src/engine/ghostty-wasm/index.ts";
import { isUnsupported } from "../../src/engine/types.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const variants: Record<string, () => Promise<number>> = {
  "Bun.file(path).arrayBuffer()": async () =>
    (await Bun.file(ghosttyWasmPath).arrayBuffer()).byteLength,
  "Bun.file(path).bytes()": async () =>
    (await Bun.file(ghosttyWasmPath).bytes()).byteLength,
  "Bun.file(path).text()": async () =>
    (await Bun.file(ghosttyWasmPath).text()).length,
  "fs.readFileSync(path)": async () => fs.readFileSync(ghosttyWasmPath).length,
  "fs.promises.readFile(path)": async () =>
    (await fs.promises.readFile(ghosttyWasmPath)).length,
  "pipe: Bun.file(fd).text() + closeSync": async () => {
    const proc = Bun.spawn(["sh", "-c", "echo ready >&3"], {
      stdio: ["ignore", "ignore", "ignore", "pipe"],
    });
    const fd = proc.stdio[3] as number;
    const text = await Bun.file(fd).text();
    try {
      fs.closeSync(fd);
    } catch {}
    await proc.exited;
    return text.length;
  },
  "pipe: Bun.file(fd).text(), no close": async () => {
    const proc = Bun.spawn(["sh", "-c", "echo ready >&3"], {
      stdio: ["ignore", "ignore", "ignore", "pipe"],
    });
    const fd = proc.stdio[3] as number;
    const text = await Bun.file(fd).text();
    await proc.exited;
    return text.length;
  },
  "pipe: readSync loop + closeSync": async () => {
    const proc = Bun.spawn(["sh", "-c", "echo ready >&3"], {
      stdio: ["ignore", "ignore", "ignore", "pipe"],
    });
    const fd = proc.stdio[3] as number;
    const buf = Buffer.alloc(64);
    let got = 0;
    for (;;) {
      try {
        const n = fs.readSync(fd, buf, 0, 64, null);
        if (n === 0) break;
        got += n;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EAGAIN") throw e;
        await sleep(2);
      }
    }
    try {
      fs.closeSync(fd);
    } catch {}
    await proc.exited;
    return got;
  },
  "pipe: readSync loop, no close": async () => {
    const proc = Bun.spawn(["sh", "-c", "echo ready >&3"], {
      stdio: ["ignore", "ignore", "ignore", "pipe"],
    });
    const fd = proc.stdio[3] as number;
    const buf = Buffer.alloc(64);
    let got = 0;
    for (;;) {
      try {
        const n = fs.readSync(fd, buf, 0, 64, null);
        if (n === 0) break;
        got += n;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EAGAIN") throw e;
        await sleep(2);
      }
    }
    await proc.exited;
    return got;
  },
  "pipe: never read, closeSync only": async () => {
    const proc = Bun.spawn(["sh", "-c", "echo ready >&3"], {
      stdio: ["ignore", "ignore", "ignore", "pipe"],
    });
    const fd = proc.stdio[3] as number;
    try {
      fs.closeSync(fd);
    } catch {}
    await proc.exited;
    return 0;
  },
  "pipe: never read, never close": async () => {
    const proc = Bun.spawn(["sh", "-c", "echo ready >&3"], {
      stdio: ["ignore", "ignore", "ignore", "pipe"],
    });
    await proc.exited;
    return 0;
  },
  "detached daemon-style spawn + readSync + closeSync + unref": async () => {
    const proc = Bun.spawn(["sh", "-c", "echo ready >&3; sleep 0.2"], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore", "pipe"],
    });
    const fd = proc.stdio[3] as number;
    const buf = Buffer.alloc(64);
    let got = 0;
    for (;;) {
      try {
        const n = fs.readSync(fd, buf, 0, 64, null);
        if (n === 0) break;
        got += n;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EAGAIN") throw e;
        await sleep(2);
      }
    }
    try {
      fs.closeSync(fd);
    } catch {}
    proc.unref();
    return got;
  },
  "WebAssembly.compile only": async () =>
    WebAssembly.Module.exports(
      await WebAssembly.compile(await ghosttyWasmBytes()),
    ).length,
  "GhosttyWasmEngine.load": async () =>
    (await GhosttyWasmEngine.load(await ghosttyWasmBytes())).module.exportCount,
  "engine.load + create + dispose": async () => {
    const e = await GhosttyWasmEngine.load(await ghosttyWasmBytes());
    const t = e.create({ cols: 80, rows: 24, scrollback: 100 });
    t.write(new TextEncoder().encode("hello\r\n"));
    const n = t.plainText().length;
    t.dispose();
    return n;
  },
  "engine.load + encode + decode": async () => {
    const e = await GhosttyWasmEngine.load(await ghosttyWasmBytes());
    const t = e.create({ cols: 80, rows: 24, scrollback: 100 });
    t.write(new TextEncoder().encode("hello\r\n"));
    const snap = t.encodeState();
    const d = e.decodeState(snap);
    if (isUnsupported(d)) throw new Error(d.reason);
    const u = d.ready();
    while (d.next());
    const n = u.plainText().length;
    t.dispose();
    u.dispose();
    return n;
  },
  "none (control)": async () => 0,
};

async function probe(name: string, reads: number): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wp-m3-fd-"));
  const sock = path.join(dir, "s.sock");
  let serverSawClose = 0;
  let serverGot = 0;
  const server = Bun.listen<undefined>({
    unix: sock,
    socket: {
      data(_s, chunk) {
        serverGot += chunk.length;
      },
      close() {
        serverSawClose++;
      },
    },
  });
  // The reads under test come first, so that whatever they leave behind
  // (an fd closed late by a finalizer, say) lands on a socket opened after
  // them — the order the daemon tests had.
  for (let i = 0; i < reads; i++) await variants[name]!();
  let clientSawClose = 0;
  const client = await Bun.connect<undefined>({
    unix: sock,
    socket: {
      data() {},
      close() {
        clientSawClose++;
      },
    },
  });
  client.write("hello");
  await sleep(50);
  const before = serverGot;
  Bun.gc(true);
  await sleep(300);
  Bun.gc(true);
  await sleep(300);
  const n = client.write("again");
  await sleep(100);
  const result =
    serverSawClose > 0
      ? `BROKEN: server saw close (client saw close ${clientSawClose}×), write returned ${n}, server received ${serverGot - before} of 5`
      : `ok: server received ${serverGot - before} of 5`;
  client.end();
  server.stop(true);
  fs.rmSync(dir, { recursive: true, force: true });
  return result;
}

const only = process.argv[2];
console.log(`bun ${Bun.version}`);
for (const name of Object.keys(variants)) {
  if (only && !name.includes(only)) continue;
  for (const reads of [1, 4]) {
    console.log(`${name.padEnd(32)} ×${reads}: ${await probe(name, reads)}`);
  }
}
