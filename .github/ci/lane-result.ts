// One record per lane, out of the records a lane's steps happen to write.
//
//   bun .github/ci/lane-result.ts <out.json> <tag>=<in.json> ...
//
// A lane that only smokes a cross-compiled binary produces one file already
// and does not need this. A lane that also runs the PoC suites natively
// produces two — the suite runner's own `ci-result-<os>.json` and the
// cross-smoke's `ci-result-<lane>.json` — and the record the docs cite is the
// pair merged: the lane's identity and machine from whichever input carries
// them, and every suite from every input, in the order the inputs are given.
//
// Suite ids collide (both runners have a `diff`), so an id already taken by
// an earlier input is prefixed with the later input's tag: `cross-diff`. An
// input that does not exist is skipped, because a lane that died before
// writing one should still produce the record that says so.

import fs from "node:fs";

const [out, ...args] = process.argv.slice(2);
if (!out || args.length === 0) {
  console.error("usage: lane-result.ts <out.json> <tag>=<in.json> ...");
  process.exit(2);
}

type Suite = { id: string; [k: string]: unknown };
type Record_ = { suites?: Suite[]; [k: string]: unknown };

const merged: Record_ = {
  lane: process.env.MATRIX_LANE ?? "unknown",
  os: process.env.MATRIX_OS ?? "unknown",
  target: process.env.MATRIX_TARGET ?? "",
  bun: Bun.version,
  commit: process.env.GITHUB_SHA ?? "unknown",
  sources: [] as string[],
  suites: [],
};
const suites: Suite[] = [];
const taken = new Set<string>();

for (const arg of args) {
  const eq = arg.indexOf("=");
  const tag = eq < 0 ? "in" : arg.slice(0, eq);
  const path = eq < 0 ? arg : arg.slice(eq + 1);
  if (!fs.existsSync(path)) {
    console.log(`skipped ${tag}: ${path} does not exist`);
    continue;
  }
  let parsed: Record_;
  try {
    parsed = JSON.parse(fs.readFileSync(path, "utf8")) as Record_;
  } catch (e) {
    console.log(`skipped ${tag}: ${path} does not parse (${String(e)})`);
    continue;
  }
  (merged.sources as string[]).push(`${tag}=${path}`);
  for (const [k, v] of Object.entries(parsed)) {
    if (k === "suites") continue;
    if (merged[k] === undefined || merged[k] === "" || merged[k] === "unknown")
      merged[k] = v;
    else if (k === "machine" && !merged.machine) merged.machine = v;
  }
  for (const s of parsed.suites ?? []) {
    const id = taken.has(s.id) ? `${tag}-${s.id}` : s.id;
    taken.add(id);
    suites.push({ ...s, id });
  }
}

merged.suites = suites;
fs.writeFileSync(out, `${JSON.stringify(merged, null, 2)}\n`);
console.log(
  `${out}: ${suites.length} suites from ${(merged.sources as string[]).length} record(s)`,
);
for (const s of suites) console.log(`  ${String(s.status).padEnd(5)} ${s.id}`);
