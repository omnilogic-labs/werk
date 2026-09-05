// Diagnostic observations for the proposed library contracts, not a release gate.
// Run from packages/werk-poc: bun run spikes/library-readiness/api-boundaries.ts
// Every observation reports whether the desired contract holds. An unexpected
// exception fails the run; known gaps are reported explicitly in the JSON.
import path from "node:path";
import { connect } from "../../src/client/index.ts";
import {
  Capture,
  stopDaemon,
  tempDir,
  waitFor,
} from "../../src/daemon/_testlib.ts";
import { Session } from "../../src/daemon/session.ts";
import type { VtEngine } from "../../src/engine/types.ts";
import { GhosttyWasmEngine } from "../../src/engine/ghostty-wasm/index.ts";
import { ghosttyWasmBytes } from "../../src/engine/ghostty-wasm/bytes.ts";

const observations: { contract: string; holds: boolean; evidence: unknown }[] =
  [];
const dir = tempDir();
const client = await connect({ dir, requestTimeoutMs: 2000 });
try {
  const { id } = await client.run({
    argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
  });
  const capture = new Capture(client);
  const first = await capture.attach(id);
  let rejected = false;
  try {
    await client.attach("missing-session", { cols: 80, rows: 24 });
  } catch {
    rejected = true;
  }
  const before = capture.renders.length;
  await first.repaint();
  const receivesPaint = await waitFor(
    () => capture.renders.length > before,
    300,
  );
  const attached = (await client.ls()).find(
    (s) => s.id === id,
  )!.attachedClients;
  observations.push({
    contract: "failed attachment preserves previous subscription",
    holds: rejected && receivesPaint,
    evidence: { rejected, receivesPaint, serverAttachedClients: attached },
  });

  const old = await capture.attach(id);
  // Reattaching to the SAME session must also invalidate the old handle.
  const current = await client.attach(id, { cols: 80, rows: 24 });
  let staleResizeRejected = false;
  try {
    await old.resize(93, 27);
  } catch {
    staleResizeRejected = true;
  }
  const size = await client.screen(id);
  await old.detach();
  const remaining = (await client.ls()).find(
    (s) => s.id === id,
  )!.attachedClients;
  observations.push({
    contract: "stale attachment cannot mutate or detach its replacement",
    holds: size.cols === 80 && size.rows === 24 && remaining === 1,
    evidence: {
      staleResizeRejected,
      cols: size.cols,
      rows: size.rows,
      remainingAttachments: remaining,
    },
  });
  await current.detach();

  let failed = 0;
  for (let i = 0; i < 10; i++) {
    try {
      await client.run({ argv: [path.join(dir, "missing-executable")] });
    } catch {
      failed++;
    }
  }
  const sessions = await client.ls();
  observations.push({
    contract:
      "failed spawns leave another session running and no phantom sessions",
    holds:
      failed === 10 &&
      sessions.length === 1 &&
      sessions[0]!.status === "running",
    evidence: {
      failed,
      sessions: sessions.length,
      status: sessions[0]?.status,
    },
  });
} finally {
  await stopDaemon(dir, client);
}

// Count ownership cleanup directly; no emulator internals or memory heuristics.
let created = 0;
let disposed = 0;
const fakeEngine = {
  id: "ownership-probe",
  create() {
    created++;
    return {
      onEffect() {},
      dispose() {
        disposed++;
      },
    };
  },
} as unknown as VtEngine;
let spawnRejected = false;
try {
  new Session({
    id: "failed-spawn",
    argv: [path.join(dir, "missing-executable")],
    cwd: process.cwd(),
    env: {},
    cols: 80,
    rows: 24,
    engine: fakeEngine,
    log() {},
  });
} catch {
  spawnRejected = true;
}
observations.push({
  contract: "failed spawn disposes the engine terminal it allocated",
  holds: spawnRejected && created === disposed,
  evidence: { spawnRejected, created, disposed },
});

// A listening peer that accepts TCP but never answers hello.
const peers = new Set<import("bun").Socket<unknown>>();
let opened = 0;
let closed = 0;
const listener = Bun.listen<unknown>({
  hostname: "127.0.0.1",
  port: 0,
  socket: {
    open(s) {
      opened++;
      peers.add(s);
    },
    data() {},
    end(s) {
      s.end();
    },
    close(s) {
      closed++;
      peers.delete(s);
    },
  },
});
try {
  let timedOut = false;
  try {
    await connect({ socket: `tcp:127.0.0.1:${listener.port}`, timeoutMs: 100 });
  } catch (e) {
    timedOut = String(e).includes("hello timed out");
  }
  await waitFor(() => closed === opened, 500);
  observations.push({
    contract: "hello timeout closes the abandoned connection",
    holds: timedOut && opened === 1 && closed === 1,
    evidence: { timedOut, opened, closed },
  });
} finally {
  for (const peer of peers) peer.terminate();
  listener.stop(true);
}

// Confirm the engine seam already permits independent memory per session.
const bytes = await ghosttyWasmBytes();
const a = await GhosttyWasmEngine.load(bytes);
const b = await GhosttyWasmEngine.load(bytes);
const ta = a.create({ cols: 80, rows: 24, scrollback: 2000 });
const tb = b.create({ cols: 80, rows: 24, scrollback: 2000 });
try {
  ta.write(new TextEncoder().encode("first"));
  tb.write(new TextEncoder().encode("second"));
  const separateMemory = a.module.memory !== b.module.memory;
  observations.push({
    contract: "per-session engine memory fits the existing engine interface",
    holds:
      separateMemory &&
      ta.plainText().includes("first") &&
      tb.plainText().includes("second"),
    evidence: {
      separateMemory,
      memoryBytes: [
        a.module.memory.buffer.byteLength,
        b.module.memory.buffer.byteLength,
      ],
    },
  });
} finally {
  ta.dispose();
  tb.dispose();
}

console.log(
  JSON.stringify(
    {
      bun: Bun.version,
      platform: process.platform,
      arch: process.arch,
      observations,
    },
    null,
    2,
  ),
);
