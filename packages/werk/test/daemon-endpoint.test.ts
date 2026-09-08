/**
 * `werk daemon endpoint`, and the one version identity behind it.
 *
 * Two things are worth asserting for real rather than in a unit: that asking
 * what is listening never starts anything, and that the daemon reports the
 * identity of the werk that started it. Both are only true end to end — the
 * first is about a process that must not appear, and the second is about two
 * processes agreeing — so these run the CLI and look at the files it left.
 *
 * The directories live under a short path in `/tmp` because a Unix socket path
 * is capped at 103 bytes and a deeper temporary directory fails to bind.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  formatBuildIdentity,
  SOURCE_IDENTITY,
} from "../src/runtime/version.js";

const MAIN = join(import.meta.dir, "../src/main.ts");
const TIMEOUT = 30000;
const homes: string[] = [];

async function sandbox() {
  const home = await mkdtemp("/tmp/wke-");
  homes.push(home);
  return { home, runtimeDir: join(home, "r"), stateDir: join(home, "s") };
}
afterEach(async () => {
  for (const home of homes.splice(0)) {
    try {
      const record = JSON.parse(
        await readFile(join(home, "s", "daemon.json"), "utf8"),
      );
      if (Number.isInteger(record?.pid)) process.kill(record.pid, "SIGTERM");
    } catch {}
    await rm(home, { recursive: true, force: true });
  }
});

async function werk(
  where: { runtimeDir: string; stateDir: string },
  ...args: string[]
) {
  const child = Bun.spawn(
    [
      process.execPath,
      MAIN,
      "--runtime-dir",
      where.runtimeDir,
      "--state-dir",
      where.stateDir,
      ...args,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  return { code: await child.exited, stdout, stderr };
}
const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

interface Report {
  endpoint: { kind: string; path?: string; credential?: string };
  runtimeDir: string;
  stateDir: string;
  pid: number | null;
  version: string;
  build: string;
}

test("a build is named after the tree it came from, or says it cannot", () => {
  expect(formatBuildIdentity("0.0.0", "a1b2c3d", false)).toBe("0.0.0-a1b2c3d");
  expect(formatBuildIdentity("0.0.0", "a1b2c3d", true)).toBe(
    "0.0.0-a1b2c3d-dirty",
  );
  // No git, or a tree that is not a checkout. The string has to compare
  // unequal to a real build rather than pass for one.
  expect(formatBuildIdentity("0.0.0", undefined, false)).toBe("0.0.0-unknown");
  expect(formatBuildIdentity("0.0.0", "", true)).toBe("0.0.0-unknown");
  expect(SOURCE_IDENTITY).not.toBe(
    formatBuildIdentity("0.0.0", "a1b2c3d", false),
  );
});

test(
  "asking what is listening never starts anything",
  async () => {
    const where = await sandbox();
    const { code, stdout, stderr } = await werk(
      where,
      "--json",
      "daemon",
      "endpoint",
    );
    // 7 is the status for a daemon that is not answering, which a caller
    // retries differently from a refusal it did answer with.
    expect(code).toBe(7);
    expect(stdout).toBe("");
    expect(JSON.parse(stderr).error.code).toBe("CLOSED");
    expect(await exists(join(where.stateDir, "daemon.json"))).toBe(false);
    expect(await exists(join(where.runtimeDir, "endpoint.json"))).toBe(false);
  },
  TIMEOUT,
);

test(
  "--ensure starts a daemon and the next ask finds the same one",
  async () => {
    const where = await sandbox();
    const started = JSON.parse(
      (await werk(where, "--json", "daemon", "endpoint", "--ensure")).stdout,
    ) as Report;
    expect(started.pid).toBeInteger();

    const found = await werk(where, "--json", "daemon", "endpoint");
    expect(found.code).toBe(0);
    const again = JSON.parse(found.stdout) as Report;
    expect(again.endpoint).toEqual(started.endpoint);
    expect(again.pid).toBe(started.pid);
  },
  TIMEOUT,
);

test(
  "the daemon reports the identity of the werk that started it",
  async () => {
    const where = await sandbox();
    const report = JSON.parse(
      (await werk(where, "--json", "daemon", "endpoint", "--ensure")).stdout,
    ) as Report;
    const printed = (await werk(where, "--version")).stdout.trim();
    expect(report.version).toBe(report.build);
    expect(report.build).toBe(printed);
    // Run from source rather than built, so it says so instead of inventing a
    // build id it has no way to know.
    expect(printed).toBe(SOURCE_IDENTITY);
    expect(printed).toEndWith("-source");
  },
  TIMEOUT,
);

test(
  "the human block names the endpoint without printing a credential",
  async () => {
    const where = await sandbox();
    const record = JSON.parse(
      (await werk(where, "--json", "daemon", "endpoint", "--ensure")).stdout,
    ) as Report;
    const { code, stdout } = await werk(where, "daemon", "endpoint");
    expect(code).toBe(0);
    expect(stdout).toContain("endpoint");
    expect(stdout).toContain(where.runtimeDir);
    expect(stdout).toContain(where.stateDir);
    expect(stdout).toContain(String(record.pid));
    expect(stdout).toContain(record.build);
    if (record.endpoint.credential !== undefined)
      expect(stdout).not.toContain(record.endpoint.credential);
  },
  TIMEOUT,
);
