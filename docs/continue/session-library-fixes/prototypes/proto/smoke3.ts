// Trimmed smoke: one in-process daemon, one viewer, one watcher, the 200-prompt
// case and one 1.3 MB flood. DAEMON=<module path> selects the implementation.
// In-memory duplex transports: no sockets, so no /tmp runtime dir is needed.
import { mkdtemp, rm } from "node:fs/promises";
import { loadTerminalEngine } from "/home/mike/Development/omnilogic-labs/werk/packages/terminal/src/bun/index.ts";
import { createTerminalReplica } from "/home/mike/Development/omnilogic-labs/werk/packages/terminal/src/index.ts";
import {
  connectSessionClient,
  type Transport,
} from "/home/mike/Development/omnilogic-labs/werk/packages/session/src/index.ts";

const modulePath =
  process.env.DAEMON ??
  "/home/mike/Development/omnilogic-labs/werk/packages/session-daemon/src/index.ts";
const { createSessionDaemon } = await import(modulePath);
const here =
  "/tmp/claude-1000/-home-mike-Development-omnilogic-labs-werk/0226f4ff-115d-420d-851f-a7e86414335b/scratchpad/proto";
const dir = await mkdtemp(here + "/run-");
const factory = await loadTerminalEngine();
const deadline = setTimeout(() => {
  console.error("smoke exceeded 50 s; aborting");
  process.exit(2);
}, 50000);

function duplex() {
  let a: ReadableStreamDefaultController<Uint8Array>,
    b: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  const counter = { bytes: 0, frames: 0 };
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      a.close();
    } catch {}
    try {
      b.close();
    } catch {}
  };
  const client: Transport = {
    readable: new ReadableStream({
      start(c) {
        a = c;
      },
    }),
    writable: new WritableStream({
      write(bytes) {
        if (closed) throw new Error("closed");
        b.enqueue(bytes);
      },
    }),
    close,
  };
  const server: Transport = {
    readable: new ReadableStream({
      start(c) {
        b = c;
      },
    }),
    writable: new WritableStream({
      write(bytes) {
        if (closed) throw new Error("closed");
        counter.bytes += bytes.byteLength;
        counter.frames++;
        a.enqueue(bytes);
      },
    }),
    close,
  };
  return { client, server, counter };
}

const daemon = await createSessionDaemon({
  runtimeDir: dir + "/run",
  stateDir: dir + "/state",
  engineFactory: factory,
  limits: { outputQueueBytes: 64 * 1024 },
});
const watchPipe = duplex(),
  viewPipe = duplex();
daemon.accept(watchPipe.server, { id: "watcher" });
daemon.accept(viewPipe.server, { id: "viewer" });
const watcher = await connectSessionClient({
  transport: watchPipe.client,
  requestTimeoutMs: 20000,
});
const viewer = await connectSessionClient({
  transport: viewPipe.client,
  requestTimeoutMs: 20000,
});
const watchCounts: Record<string, number> = {};
const watchOrder: string[] = [];
const stop = watcher.watch((e) => {
  watchCounts[e.type] = (watchCounts[e.type] ?? 0) + 1;
  watchOrder.push(e.type);
});
await stop.ready;
const reset = () => {
  for (const k of Object.keys(watchCounts)) delete watchCounts[k];
  watchOrder.length = 0;
  watchPipe.counter.bytes = 0;
  watchPipe.counter.frames = 0;
  viewPipe.counter.bytes = 0;
  viewPipe.counter.frames = 0;
};
const row = (label: string, v: unknown) =>
  console.log(label.padEnd(20), JSON.stringify(v));

async function runSession(label: string, script: string) {
  reset();
  const counts: Record<string, number> = {};
  let outputBytes = 0,
    snapshotBytes = 0;
  const replica = createTerminalReplica(factory);
  const errors: string[] = [];
  let applied = Promise.resolve();
  const s = await viewer.create({
    argv: ["/bin/sh", "-c", "sleep 0.3; " + script],
    size: { cols: 120, rows: 40 },
    name: label,
  });
  let ended!: () => void;
  const done = new Promise<void>((r) => (ended = r));
  const t0 = performance.now();
  await viewer.attach(s.id, {
    permissions: { read: true, input: false },
    onEvent(e) {
      counts[e.type] = (counts[e.type] ?? 0) + 1;
      if (e.type === "output") outputBytes += e.data.byteLength;
      if (e.type === "snapshot" || e.type === "resync")
        snapshotBytes += e.snapshot.byteLength;
      applied = replica.apply(e).catch((x) => {
        errors.push(String(x));
      });
      if (e.type === "ended") ended();
    },
  });
  await Promise.race([
    done,
    Bun.sleep(30000).then(() => {
      throw new Error("attachment never ended");
    }),
  ]);
  await applied;
  const ms = performance.now() - t0;
  // Allow one notify interval so a trailing coalesced pulse is counted here.
  await Bun.sleep(400);
  console.log(`\n== ${label} (${ms.toFixed(0)} ms)`);
  row("viewer events", counts);
  row("viewer bytes", {
    output: outputBytes,
    snapshotPayload: snapshotBytes,
    wire: viewPipe.counter.bytes,
    frames: viewPipe.counter.frames,
  });
  row("watch events", watchCounts);
  row("watch order", watchOrder.join(" "));
  row("watch bytes", {
    wire: watchPipe.counter.bytes,
    frames: watchPipe.counter.frames,
  });
  const info = await viewer.get(s.id);
  const screen = await viewer.readScreen(s.id);
  row("final", {
    state: info.state,
    exit: info.exit,
    title: info.title,
    cwd: info.reportedCwd,
    replicaMatches: replica.readScreen() === screen,
    replicaErrors: errors,
  });
  replica.dispose();
  return s.id;
}

await runSession(
  "title-and-cwd-per-line x200",
  'i=0; while [ $i -lt 200 ]; do i=$((i+1)); printf "\\033]0;title %d\\007\\033]7;file:///tmp/%d\\007line %d\\n" $i $i $i; done',
);
await runSession("seq 1 200000 flood", "seq 1 200000");

// Checkpoint churn on idle exited sessions across one checkpoint interval.
reset();
const idleMs = Number(process.env.IDLE_MS ?? 5500);
await Bun.sleep(idleMs);
console.log(`\n== ${idleMs} ms idle with 2 exited sessions`);
row("watch events", watchCounts);
row("watch bytes", { wire: watchPipe.counter.bytes });

stop();
await viewer.close();
await watcher.close();
await daemon.close();
clearTimeout(deadline);
await rm(dir, { recursive: true, force: true });
console.log("\ndone; diagnostics", JSON.stringify(daemon.diagnostics()));
