/**
 * `create --workspace` end to end: the CLI, a real repository, a real daemon.
 *
 * The unit tests either side of this one settle the rendering and the failure
 * mapping. What only a real run can say is that the worktree is made before the
 * daemon is asked for anything, that the session actually starts in it, and
 * that a workspace which cannot be made fails without leaving a daemon behind.
 *
 * Its runtime and state directories are its own, so it does not fight the
 * daemon `json-contract.test.ts` runs in the same `bun test` invocation. They
 * live under a short `/tmp` path because a Unix socket path is capped at 103
 * bytes and a deeply nested one fails to bind.
 */
import { afterAll, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const MAIN = new URL("../src/main.ts", import.meta.url).pathname;
const TIMEOUT = 30000;

const home = await mkdtemp("/tmp/wkw-");
const runtimeDir = join(home, "r");
const stateDir = join(home, "s");

afterAll(async () => {
  try {
    const record = JSON.parse(
      await readFile(join(stateDir, "daemon.json"), "utf8"),
    );
    if (Number.isInteger(record?.pid)) process.kill(record.pid, "SIGTERM");
  } catch {}
  await rm(home, { recursive: true, force: true }).catch(() => {});
});

const git = (cwd: string, ...args: string[]) =>
  run(
    "git",
    [
      "-c",
      "user.name=werk test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, encoding: "utf8" },
  );

/** A repository with a commit, since that is the least git will branch from. */
async function repository(): Promise<string> {
  const directory = await mkdtemp(join(home, "repo-"));
  await git(directory, "init", "-q", "-b", "main", ".");
  await Bun.write(join(directory, "README.md"), "committed\n");
  await git(directory, "add", "README.md");
  await git(directory, "commit", "-q", "-m", "init");
  return directory;
}

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}
async function werk(cwd: string, ...args: string[]): Promise<Ran> {
  const child = Bun.spawn(
    [
      process.execPath,
      MAIN,
      "--json",
      "--runtime-dir",
      runtimeDir,
      "--state-dir",
      stateDir,
      ...args,
    ],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  return { code: await child.exited, stdout, stderr };
}
const failure = (ran: Ran) => JSON.parse(ran.stderr.trim()).error;

test(
  "a workspace is made, and the session runs in it",
  async () => {
    const source = await repository();
    const ran = await werk(
      source,
      "create",
      "--workspace",
      "demo",
      "--",
      "sleep",
      "30",
    );
    expect(ran.code, ran.stderr).toBe(0);
    const info = JSON.parse(ran.stdout.trim());

    expect(info.workspace).toEqual({
      name: "demo",
      directory: info.workspace.directory,
      branch: "demo",
    });
    // The session is in the workspace, not in the repository it came from.
    expect(info.cwd).toBe(info.workspace.directory);
    expect(info.cwd).not.toBe(source);
    expect((await stat(info.workspace.directory)).isDirectory()).toBe(true);
    expect(
      info.workspace.directory.startsWith(join(stateDir, "workspaces")),
    ).toBe(true);

    // The repository agrees it is a worktree of its own, on that branch.
    const listed = await git(source, "worktree", "list", "--porcelain");
    expect(listed.stdout).toContain("branch refs/heads/demo");
    // And the committed file is there, so it is a real checkout.
    expect(await Bun.file(join(info.cwd, "README.md")).text()).toBe(
      "committed\n",
    );
  },
  TIMEOUT,
);

test(
  "without the flag nothing is made and the record is what it always was",
  async () => {
    const source = await repository();
    const ran = await werk(source, "create", "--", "sleep", "30");
    expect(ran.code, ran.stderr).toBe(0);
    const info = JSON.parse(ran.stdout.trim());
    expect(info.workspace).toBeUndefined();
    expect(info.cwd).toBe(source);
    const listed = await git(source, "worktree", "list", "--porcelain");
    expect(listed.stdout).not.toContain("refs/heads/demo");
  },
  TIMEOUT,
);

test(
  "outside a repository it is a usage failure that starts no daemon",
  async () => {
    // Its own runtime and state directories, with no daemon in them, so that
    // "no daemon was left behind" is a statement about this run alone.
    const alone = await mkdtemp("/tmp/wkw-solo-");
    try {
      const child = Bun.spawn(
        [
          process.execPath,
          MAIN,
          "--json",
          "--runtime-dir",
          join(alone, "r"),
          "--state-dir",
          join(alone, "s"),
          "create",
          "--workspace",
          "demo",
          "--",
          "sleep",
          "30",
        ],
        { cwd: alone, stdout: "pipe", stderr: "pipe" },
      );
      const stderr = await new Response(child.stderr).text();
      expect(await child.exited).toBe(2);
      expect(JSON.parse(stderr.trim()).error.code).toBe("NOT_A_REPOSITORY");
      // The daemon record is written by a daemon that started. There is none.
      await expect(stat(join(alone, "s", "daemon.json"))).rejects.toThrow();
    } finally {
      await rm(alone, { recursive: true, force: true }).catch(() => {});
    }
  },
  TIMEOUT,
);

test(
  "a branch that is taken is a conflict, and a bad name is a usage failure",
  async () => {
    const source = await repository();
    await git(source, "branch", "taken");
    const conflict = await werk(
      source,
      "create",
      "--workspace",
      "taken",
      "--",
      "true",
    );
    expect(conflict.code).toBe(5);
    expect(failure(conflict).code).toBe("BRANCH_EXISTS");

    const bad = await werk(
      source,
      "create",
      "--workspace",
      "a/b",
      "--",
      "true",
    );
    expect(bad.code).toBe(2);
    expect(failure(bad).code).toBe("INVALID_NAME");
  },
  TIMEOUT,
);

test(
  "a repository with no commits says so rather than reporting a git failure",
  async () => {
    const empty = await mkdtemp(join(home, "empty-"));
    await git(empty, "init", "-q", "-b", "main", ".");
    const ran = await werk(
      empty,
      "create",
      "--workspace",
      "demo",
      "--",
      "true",
    );
    expect(ran.code).toBe(2);
    expect(failure(ran).code).toBe("NO_COMMITS");
  },
  TIMEOUT,
);

test(
  "--cwd chooses the repository to branch from",
  async () => {
    const source = await repository();
    const elsewhere = await mkdtemp(join(home, "elsewhere-"));
    const ran = await werk(
      elsewhere,
      "create",
      "--workspace",
      "from-cwd",
      "--cwd",
      source,
      "--",
      "sleep",
      "30",
    );
    expect(ran.code, ran.stderr).toBe(0);
    const info = JSON.parse(ran.stdout.trim());
    expect(info.cwd).toBe(info.workspace.directory);
    const listed = await git(source, "worktree", "list", "--porcelain");
    expect(listed.stdout).toContain("branch refs/heads/from-cwd");
  },
  TIMEOUT,
);
