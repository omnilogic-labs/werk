import { expect, test } from "bun:test";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pkg = join(import.meta.dir, "..", "..");
const out = join(pkg, "dist", "m1", "embedded");

test("the pinned wasm is embedded in a --compile binary", async () => {
  const build = Bun.spawnSync(
    [
      "bun",
      "build",
      "--compile",
      join(import.meta.dir, "embedded.ts"),
      "--outfile",
      out,
    ],
    { cwd: pkg, stdout: "pipe", stderr: "pipe" },
  );
  expect(build.exitCode).toBe(0);

  // Run it from an empty directory so nothing on disk can be found by accident.
  const cwd = await mkdtemp(join(tmpdir(), "werk-poc-m1-"));
  expect(await readdir(cwd)).toEqual([]);
  const run = Bun.spawnSync([out], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: "/nonexistent" },
  });
  const stdout = run.stdout.toString();
  expect(run.exitCode).toBe(0);
  expect(stdout).toContain("wasm: /$bunfs/root/");
  expect(stdout).toContain("exports: 189");
  expect(stdout).toContain("bold: true");
  expect(stdout).toContain("compiled ok\n日本 😀\n");
  console.log(
    `compiled binary: ${(Bun.file(out).size / 1048576).toFixed(1)} MB, ${stdout.split("\n")[0]}`,
  );
}, 60_000);
