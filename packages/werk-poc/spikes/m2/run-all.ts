// Runs every reattach-fidelity scenario against the compiled `wp`, each in
// its own temporary runtime directory with its own daemon, and prints a
// pass/fail table. `bun run spikes/m2/run-all.ts [name-substring]`.

import { buildWp, stopEnv, tempEnv } from "./harness.ts";
import { scenarios } from "./scenarios.ts";

const filter = process.argv[2];
const wp = buildWp();
const rows: { name: string; pass: boolean; ms: number; notes: string[] }[] = [];
for (const s of scenarios) {
  if (filter && !s.name.includes(filter)) continue;
  const env = tempEnv(wp);
  const t0 = performance.now();
  let outcome: { pass: boolean; notes: string[] } | undefined;
  try {
    outcome = await s.run(env);
  } catch (e) {
    outcome = { pass: false, notes: [`threw: ${(e as Error).stack ?? e}`] };
  } finally {
    // A failed scenario keeps its directory (daemon log, wp trace).
    await stopEnv(env, !outcome?.pass);
  }
  const o = outcome!;
  rows.push({ name: s.name, ...o, ms: performance.now() - t0 });
  console.log(`${o.pass ? "PASS" : "FAIL"}  ${s.name}`);
  for (const n of o.notes) console.log(`        ${n}`);
}
console.log("\n| Scenario | Result | Time |\n| --- | --- | --- |");
for (const r of rows)
  console.log(
    `| ${r.name} | ${r.pass ? "pass" : "FAIL"} | ${(r.ms / 1000).toFixed(1)} s |`,
  );
process.exit(rows.every((r) => r.pass) ? 0 : 1);
