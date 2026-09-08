import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectSessionClient } from "../packages/session/dist/index.js";
import {
  DEFAULT_MAX_QUEUED_BYTES,
  type Transport,
} from "../packages/session/dist/protocol.js";
import { createSessionDaemon } from "../packages/session-daemon/dist/index.js";
import { loadTerminalEngine } from "../packages/terminal/dist/bun/index.js";

// Uses package exports, which resolve to built artefacts. Delay is per frame;
// split headers and bodies independently to exercise remote byte boundaries.
function pair(delay: () => number): [Transport, Transport] {
  const a = new TransformStream<Uint8Array, Uint8Array>();
  const b = new TransformStream<Uint8Array, Uint8Array>();
  const aw = a.writable.getWriter(),
    bw = b.writable.getWriter();
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await Promise.allSettled([aw.abort(), bw.abort()]);
  };
  const writable = (
    writer: WritableStreamDefaultWriter<Uint8Array>,
    slow: boolean,
  ) =>
    new WritableStream<Uint8Array>({
      async write(bytes) {
        if (slow) await Bun.sleep(delay());
        for (let offset = 0; offset < bytes.length;) {
          const size = offset < 8 ? 1 : 4096;
          await writer.write(bytes.slice(offset, offset + size));
          offset += size;
        }
      },
      close,
      abort: close,
    });
  return [
    { readable: a.readable, writable: writable(bw, false), close },
    { readable: b.readable, writable: writable(aw, true), close },
  ];
}
const duration = Number(process.env.SOAK_SECONDS ?? 60);
assert.ok(
  Number.isFinite(duration) && duration >= 10 && duration <= 86400,
  "SOAK_SECONDS must be 10..86400",
);
const directory = await mkdtemp(join(tmpdir(), "werk-soak-"));
const outputLimit = 32768;
const daemon = await createSessionDaemon({
  runtimeDir: join(directory, "run"),
  stateDir: join(directory, "state"),
  // The daemon cannot know what built it, so the caller says. A soak is not a
  // client and has no build of its own to report.
  version: "soak",
  engineFactory: await loadTerminalEngine(),
  limits: { outputQueueBytes: outputLimit, checkpointIntervalMs: 1000 },
});
let slowDelay = 2;
async function connect(slow = false) {
  const [clientTransport, daemonTransport] = pair(() => (slow ? slowDelay : 2));
  daemon.accept(daemonTransport, { id: slow ? "slow-viewer" : "remote-owner" });
  return connectSessionClient({
    transport: clientTransport,
    requestTimeoutMs: 10000,
  });
}
const client = await connect(),
  slow = await connect(true);
const latencies: number[] = [],
  lag: number[] = [],
  rss: number[] = [];
let maxOutput = 0,
  maxControl = 0,
  churn = 0,
  resyncs = 0;
let queueViolation = false;
let expected = performance.now() + 100;
const timer = setInterval(() => {
  const now = performance.now();
  lag.push(Math.max(0, now - expected));
  expected = now + 100;
  rss.push(process.memoryUsage().rss);
  const d = daemon.diagnostics();
  maxOutput = Math.max(maxOutput, d.outputQueueBytes);
  maxControl = Math.max(maxControl, d.controlQueueBytes);
  // What each half of this asserts. The output bound is a real one: the harness
  // configures a 32 KiB queue per connection and the baseline's aggregate peak
  // is 33,255 bytes over two connections, so a backpressure regression shows
  // here. Both bounds are on the aggregate against a per-connection allowance,
  // so one connection can exceed its own share while the total stays under.
  // The control bound is the protocol's own limit, about 64 MiB, against a
  // baseline peak of 1,688 bytes, so it sits roughly 40,000 times above the
  // observed value and catches a runaway rather than a regression. See open
  // question 1 in `docs/ci.md`.
  if (
    d.outputQueueBytes > outputLimit * d.connections ||
    d.controlQueueBytes > DEFAULT_MAX_QUEUED_BYTES * d.connections
  )
    queueViolation = true;
}, 100);
const handles = async () =>
  process.platform === "linux" ? (await readdir("/proc/self/fd")).length : null;
const initialHandles = await handles();
const started = performance.now();
try {
  const fixture = join(directory, "steady.js");
  await writeFile(
    fixture,
    'let n=0; setInterval(()=>process.stdout.write(`steady:${n++} ${"x".repeat(2048)}\\n`),10);',
  );
  const steady = await client.create({
    argv: [process.execPath, fixture],
    size: { cols: 80, rows: 24 },
    name: "steady",
  });
  const fastAttachment = await client.attach(steady.id, { onEvent() {} });
  const slowAttachment = await slow.attach(steady.id, {
    onEvent(e) {
      if (e.type === "resync") resyncs++;
    },
  });
  slowDelay = 200;
  while (performance.now() - started < duration * 1000) {
    assert.equal(queueViolation, false, "configured queue bounds exceeded");
    const session = await client.create({
      argv: [
        process.execPath,
        "-e",
        'console.log("churn-ready");setInterval(()=>{},1000)',
      ],
      size: { cols: 40, rows: 8 },
      name: "churn",
    });
    const start = performance.now();
    const attachment = await client.attach(session.id, { onEvent() {} });
    latencies.push(performance.now() - start);
    await attachment.detach();
    await client.terminate(session.id, "force");
    const deadline = Date.now() + 5000;
    while ((await client.get(session.id)).state === "running") {
      assert.ok(Date.now() < deadline, "child exit timed out");
      await Bun.sleep(10);
    }
    assert.equal((await client.get(session.id)).processTree.children, 0);
    await client.remove(session.id);
    churn++;
    await Bun.sleep(150);
  }
  slowDelay = 2;
  await slowAttachment.detach();
  await fastAttachment.detach();
  await client.terminate(steady.id, "force");
  const deadline = Date.now() + 5000;
  while ((await client.get(steady.id)).state === "running") {
    assert.ok(Date.now() < deadline);
    await Bun.sleep(10);
  }
  await client.remove(steady.id);
  assert.deepEqual(await client.list(), []);
  await client.close();
  await slow.close();
  await daemon.close();
  const cleanup = daemon.diagnostics();
  assert.equal(cleanup.connections, 0);
  assert.equal(cleanup.attachments, 0);
  assert.equal(cleanup.sessions, 0);
  const finalHandles = await handles();
  clearInterval(timer);
  const percentile = (values: number[], p: number) =>
    [...values].sort((a, b) => a - b)[
      Math.min(values.length - 1, Math.floor(values.length * p))
    ] ?? 0;
  const report = {
    platform: process.platform,
    architecture: process.arch,
    bun: Bun.version,
    requestedSeconds: duration,
    elapsedSeconds: (performance.now() - started) / 1000,
    churnSessions: churn,
    slowViewerResyncs: resyncs,
    rssStartBytes: rss[0],
    rssPeakBytes: rss.reduce((peak, value) => Math.max(peak, value), 0),
    rssEndBytes: rss.at(-1),
    eventLoopP99Ms: percentile(lag, 0.99),
    attachP99Ms: percentile(latencies, 0.99),
    maxOutputQueueBytes: maxOutput,
    maxControlQueueBytes: maxControl,
    outputLimitPerConnectionBytes: outputLimit,
    initialHandles,
    finalHandles,
    cleanup,
  };
  console.log(JSON.stringify(report, null, 2));
  if (process.env.SOAK_REPORT)
    await writeFile(
      process.env.SOAK_REPORT,
      JSON.stringify(report, null, 2) + "\n",
    );
  assert.ok(resyncs > 0, "slow viewer must exercise resynchronisation");
  // The regression budgets are the only performance assertions here, and they
  // need a baseline to compare against. The `native` lanes set no
  // `SOAK_BASELINE`, so on every pull request this block is skipped and the run
  // asserts liveness, framing, backpressure and cleanup instead. `docs/ci.md`
  // says so where the lane is described.
  if (process.env.SOAK_BASELINE) {
    const baseline = await Bun.file(process.env.SOAK_BASELINE).json();
    assert.ok(
      report.rssPeakBytes <= baseline.rssPeakBytes * 2,
      "RSS exceeded 2x baseline",
    );
    assert.ok(
      report.attachP99Ms <= Math.max(100, baseline.attachP99Ms * 3),
      "attach latency exceeded budget",
    );
    assert.ok(
      report.eventLoopP99Ms <= Math.max(100, baseline.eventLoopP99Ms * 3),
      "event loop lag exceeded budget",
    );
  }
  // Linux only: `handles()` reads `/proc/self/fd` and returns `null` anywhere
  // else, so the macOS and Windows legs assert nothing about descriptors. The
  // allowance of four is for runtime bookkeeping.
  if (initialHandles !== null && finalHandles !== null)
    assert.ok(
      finalHandles <= initialHandles + 4,
      "file descriptor growth after cleanup",
    );
} finally {
  clearInterval(timer);
  await Promise.allSettled([client.close(), slow.close()]);
  await daemon.close();
  await rm(directory, { recursive: true, force: true });
}
