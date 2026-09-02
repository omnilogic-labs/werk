// The reattach-fidelity scenarios under `bun test`, run in a process of
// their own: `run-all.ts` is spawned and its table asserted on. Sharing the
// test process with the other files was not viable — pipes, sockets and
// PTYs the harness owned were closed under it (an `EPIPE` in `wp run`, a
// request with no reply, a `wp attach` that never attached), about one run
// in three, and never when the harness had the process to itself
// (findings/m2.md). The scenarios themselves are in scenarios.ts.

import { expect, test } from "bun:test";
import path from "node:path";

test("reattach fidelity: every scenario passes (spikes/m2/run-all.ts)", async () => {
  const proc = Bun.spawn(
    [process.execPath, "run", path.join(import.meta.dir, "run-all.ts")],
    {
      cwd: path.join(import.meta.dir, "..", ".."),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  console.log(out.slice(out.indexOf("| Scenario")));
  if (code !== 0) console.log(out + err);
  expect(out.match(/^(PASS|FAIL)  /gm)?.length).toBe(8);
  expect(out.match(/^FAIL  /gm) ?? []).toEqual([]);
  expect(code).toBe(0);
}, 120_000);
