// A normalised, platform-independent summary of the differential corpus for
// the matrix workflow: per case, whether each engine pair agreed on text,
// cells and effects; per reattach case, each strategy's status; the fuzz
// agreement counts at a fixed seed; and which engines failed to load. No
// timings, so two runs on two platforms are comparable byte for byte.
//
//   bun .github/ci/matrix-summary.ts <out.json>     (cwd: packages/werk-poc)
//
// Unlike the vt-win32 probe this never throws when an engine is missing —
// a lane where `ghostty-ffi` has no prebuild records that as a difference
// from the Linux summary rather than as a crash.

import { runDifferential } from "../../packages/werk-poc/bench/differential.ts";

const out = process.argv[2] ?? "diff-summary.json";
const r = await runDifferential({ fuzz: 200, seed: 11 });
const summary = {
  engines: r.engines,
  loadErrors: Object.fromEntries(
    Object.entries(r.loadErrors).map(([k, v]) => [
      k,
      // The message names a temp path on some platforms; keep the first line.
      String(v).split("\n")[0],
    ]),
  ),
  cases: r.cases.map((c) => ({
    name: c.name,
    error: c.error ?? null,
    pairs: Object.fromEntries(
      Object.entries(c.pairs).map(([k, v]) => [
        k,
        { text: v.text, cells: v.cells, effects: v.effects },
      ]),
    ),
    reattach: c.reattach
      ? Object.fromEntries(
          Object.entries(c.reattach).map(([e, s]) => [
            e,
            Object.fromEntries(
              Object.entries(s).map(([k, v]) => [k, v.status]),
            ),
          ]),
        )
      : null,
  })),
  fuzz: r.fuzz.map((f) => ({
    mode: f.mode,
    iterations: f.iterations,
    textAgree: f.textAgree,
    cellsAgree: f.cellsAgree,
    splitInvariant: f.splitInvariant,
  })),
};
await Bun.write(out, JSON.stringify(summary, null, 2) + "\n");
console.log(
  `SUMMARY: ${summary.cases.length} cases, engines ${summary.engines.join("+")}` +
    (Object.keys(summary.loadErrors).length
      ? `, did not load: ${Object.keys(summary.loadErrors).join(",")}`
      : ""),
);
