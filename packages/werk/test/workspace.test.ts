/**
 * `create` end to end: the CLI, a real repository, a real daemon.
 *
 * The unit tests either side of this one settle the rendering, the naming and
 * the failure mapping. What only a real run can say is that the worktree is
 * made before the daemon is asked for anything, that the session actually
 * starts in it, and that a workspace which cannot be made fails without leaving
 * a daemon behind.
 *
 * Its runtime and state directories are its own, so it does not fight the
 * daemon `json-output.test.ts` runs in the same `bun test` invocation. They
 * live under a short `/tmp` path because a Unix socket path is capped at 103
 * bytes and a deeply nested one fails to bind.
 */
import { afterAll, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { localWorkspaceAt } from "@werk/workspace";

const run = promisify(execFile);
const MAIN = join(import.meta.dir, "../src/main.ts");
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
  "a workspace is made without being asked for, and the session runs in it",
  async () => {
    const source = await repository();
    const ran = await werk(source, "create", "--", "sleep", "30");
    expect(ran.code, ran.stderr).toBe(0);
    const info = JSON.parse(ran.stdout.trim());

    // Nothing named it, so the name is generated from the command and carries
    // enough entropy to be made twice in one repository.
    expect(info.workspace.name).toMatch(/^sleep-[0-9a-f]{8}$/);
    expect(info.workspace.branch).toBe(info.workspace.name);
    // The session is in the workspace, not in the repository it came from.
    expect(info.cwd).toBe(info.workspace.directory);
    expect(info.cwd).not.toBe(source);
    expect((await stat(info.workspace.directory)).isDirectory()).toBe(true);
    expect(
      info.workspace.directory.startsWith(join(stateDir, "workspaces")),
    ).toBe(true);
    // The one notation, composed from this record's own fields rather than
    // from a shape written out here, so the record and the notation cannot
    // disagree about how a workspace is written down.
    expect(info.workspace.reference).toBe(
      `${info.workspace.name}:${info.workspace.directory}`,
    );
    // The reference a real run produced is one the package recovers from the
    // directory alone, which is the route `werk list` and the chrome take.
    expect(localWorkspaceAt(join(stateDir, "workspaces"), info.cwd)).toEqual({
      name: info.workspace.name,
      directory: info.workspace.directory,
    });

    // The repository agrees it is a worktree of its own, on that branch.
    const listed = await git(source, "worktree", "list", "--porcelain");
    expect(listed.stdout).toContain(`branch refs/heads/${info.workspace.name}`);
    // And the committed file is there, so it is a real checkout.
    expect(await Bun.file(join(info.cwd, "README.md")).text()).toBe(
      "committed\n",
    );
  },
  TIMEOUT,
);

test(
  "creating twice in one repository makes two workspaces",
  async () => {
    const source = await repository();
    const first = await werk(source, "create", "--", "sleep", "30");
    const second = await werk(source, "create", "--", "sleep", "30");
    expect(first.code, first.stderr).toBe(0);
    expect(second.code, second.stderr).toBe(0);
    const one = JSON.parse(first.stdout.trim());
    const two = JSON.parse(second.stdout.trim());
    expect(two.workspace.name).not.toBe(one.workspace.name);
    expect(two.cwd).not.toBe(one.cwd);
    const listed = await git(source, "worktree", "list", "--porcelain");
    expect(listed.stdout).toContain(`branch refs/heads/${one.workspace.name}`);
    expect(listed.stdout).toContain(`branch refs/heads/${two.workspace.name}`);
  },
  TIMEOUT,
);

test(
  "--workspace names it, and asking for a name twice is a conflict",
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
    // Taken as typed: no suffix, because the caller chose the branch name.
    expect(info.workspace.name).toBe("demo");
    expect(info.workspace.branch).toBe("demo");

    const again = await werk(
      source,
      "create",
      "--workspace",
      "demo",
      "--",
      "true",
    );
    expect(again.code).toBe(5);
    expect(failure(again).code).toBe("BRANCH_EXISTS");
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
  "a command that is not a legal branch name still gets a workspace",
  async () => {
    // The generated name comes from argv[0], which is routinely a path. Nothing
    // a person can type as a command should be able to fail the name rule.
    const source = await repository();
    const ran = await werk(source, "create", "--", "/bin/sh", "-c", "sleep 30");
    expect(ran.code, ran.stderr).toBe(0);
    const info = JSON.parse(ran.stdout.trim());
    expect(info.workspace.name).toMatch(/^sh-[0-9a-f]{8}$/);
  },
  TIMEOUT,
);

test(
  "a repository with no commits says so rather than reporting a git failure",
  async () => {
    const empty = await mkdtemp(join(home, "empty-"));
    await git(empty, "init", "-q", "-b", "main", ".");
    const ran = await werk(empty, "create", "--", "true");
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
    // `--cwd` says which checkout to branch, and nothing else: the command
    // runs in the workspace, never in the directory named here.
    expect(ran.code, ran.stderr).toBe(0);
    const info = JSON.parse(ran.stdout.trim());
    expect(info.cwd).toBe(info.workspace.directory);
    expect(info.cwd).not.toBe(elsewhere);
    const listed = await git(source, "worktree", "list", "--porcelain");
    expect(listed.stdout).toContain("branch refs/heads/from-cwd");
  },
  TIMEOUT,
);

test(
  "list names the workspace each session is in, in the one notation",
  async () => {
    const source = await repository();
    const made = await werk(
      source,
      "create",
      "--workspace",
      "listed",
      "--",
      "sleep",
      "30",
    );
    expect(made.code, made.stderr).toBe(0);
    const info = JSON.parse(made.stdout.trim());

    // Without `--json` this is the table a person reads.
    const table = Bun.spawn(
      [
        process.execPath,
        MAIN,
        "--runtime-dir",
        runtimeDir,
        "--state-dir",
        stateDir,
        "list",
      ],
      { cwd: source, stdout: "pipe", stderr: "pipe" },
    );
    const printed = await new Response(table.stdout).text();
    expect(await table.exited).toBe(0);
    // Piped, the table is tab separated and carries no header row, so the
    // column is asserted by its position rather than by a heading.
    const row = printed
      .split("\n")
      .find((line) => line.startsWith(info.id.slice(0, 12)))!;
    expect(row, printed).toBeDefined();
    const columns = row.split("\t");
    // ID, NAME, WORKSPACE, STATE, AGE, COMMAND.
    expect(columns).toHaveLength(6);
    // The name level of the reference, which is all a column has room for.
    expect(columns[2]).toBe(info.workspace.name);
    expect(columns[1]).toBe(info.name);

    // The records stay the daemon's own. A workspace is reconstructed for the
    // table and is not mixed into what `--json` hands back.
    const records = JSON.parse((await werk(source, "list")).stdout.trim());
    const listed = records.find((r: { id: string }) => r.id === info.id);
    expect(listed).toBeDefined();
    expect(listed.workspace).toBeUndefined();
    expect(listed.cwd).toBe(info.workspace.directory);
  },
  TIMEOUT,
);
