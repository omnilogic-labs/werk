// Turns the per-suite files windows.sh left in $SUITE_DIR into
// ci-result-windows.json, in the order the suites were declared. A suite with
// no files ran not at all (the job was cancelled, say) and is recorded as a
// skip so the shape of the report stays stable across runs.

import fs from "node:fs";
import path from "node:path";

const dir =
  process.env.SUITE_DIR ?? path.join(process.env.RUNNER_TEMP ?? ".", "suites");
const order = (process.env.SUITE_ORDER ?? "").split(/[\s,]+/).filter(Boolean);

const read = (id: string, ext: string): string | null => {
  const p = path.join(dir, `${id}.${ext}`);
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
};

const seen = new Set(order);
for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
  if (f.endsWith(".status")) {
    const id = f.slice(0, -".status".length);
    if (!seen.has(id)) {
      order.push(id);
      seen.add(id);
    }
  }
}

const suites = order.map((id) => {
  const status = read(id, "status");
  return {
    id,
    name: id,
    status: status ?? "skip",
    ms: Number(read(id, "ms") ?? 0),
    detail: read(id, "detail") ?? "did not run",
  };
});

const report = {
  os: "windows-latest",
  runner: process.env.PROBE_RUNNER ?? "unknown",
  bun: Bun.version,
  commit: process.env.GITHUB_SHA ?? "unknown",
  suites,
};

const out = process.env.PROBE_OUT ?? "ci-result-windows.json";
fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
