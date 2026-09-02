// One smoke case per bench runner, at tiny parameters: each runs to the
// end, prints its tables, and leaves no daemon behind. The real numbers
// come from the full runs (`wp bench perf`, `wp bench ops`, `wp bench
// soak`), recorded in findings/m6.md.

import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runOps } from "./ops.ts";
import { runPerf } from "./perf.ts";
import { formatSummary, reportFile, runSoak } from "./soak.ts";

const quiet = () => {};

test("wp bench perf --quick runs every section", async () => {
  const report = await runPerf({ quick: true, out: quiet });
  expect(report.engines).toContain("ghostty-wasm");
  expect(report.throughput!.length).toBeGreaterThan(0);
  for (const r of report.throughput!) expect(r.best).toBeGreaterThan(0);
  expect(report.latency!.daemon.p50).toBeGreaterThan(0);
  expect(report.snapshot!.every((r) => r.roundTrip)).toBe(true);
  expect(report.memory!.churn.length).toBe(3);
  expect(report.slow!.slow.maxQueuedBytes).toBeLessThanOrEqual(
    report.slow!.queueBound,
  );
  expect(report.trap!.steps.length).toBeGreaterThan(0);
  expect(report.tables).toContain("## Trap isolation");
}, 180_000);

test("wp bench ops --quick reports without compiling", async () => {
  const report = await runOps({ quick: true, out: quiet });
  expect(report.toolchain.find((t) => t.tool === "bun")?.present).toContain(
    Bun.version,
  );
  expect(
    report.platforms.find((p) => p.engine === "ghostty-ffi")?.platforms,
  ).toContain("linux-x64-glibc");
  expect(report.variants.every((v) => v.compileMs === null)).toBe(true);
  expect(
    report.coldStart.some(
      (c) => c.what.includes("__daemon to ready") && c.p50Ms > 0,
    ),
  ).toBe(true);
}, 120_000);

test("wp bench soak runs for a few seconds and its log summarises", async () => {
  const out = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "wp-soak-test-")),
    "soak.jsonl",
  );
  const summary = await runSoak({
    durationMs: 6000,
    intervalMs: 2000,
    idle: 1,
    noisy: 1,
    attachEveryMs: 1500,
    out,
    log: quiet,
  });
  expect(summary.samples).toBeGreaterThanOrEqual(3);
  expect(summary.sessions.runningAtEnd).toBe(2);
  expect(summary.rss.end).toBeGreaterThan(0);
  expect(summary.attach.all.n).toBeGreaterThan(0);
  expect(formatSummary(summary)).toContain("RSS slope");
  expect(reportFile(out)).toContain("Daemon RSS start / end / max");
  fs.rmSync(path.dirname(out), { recursive: true, force: true });
}, 60_000);
