/**
 * `create` end to end: the CLI, a real repository, a real daemon.
 *
 * The unit tests either side of this one settle the rendering, the naming and
 * the failure mapping. What only a real run can say is that the worktree is
 * made before the daemon is asked for anything, that the session actually
 * starts in it, and that a workspace which cannot be made fails without leaving
 * a daemon behind.
 *
 * Its sandbox is its own, so it does not fight the daemon
 * `json-output.test.ts` runs in the same `bun test` invocation, and its
 * directories live under a short `/tmp` path because a Unix socket path is
 * capped at 103 bytes and a deeply nested one fails to bind.
 */
import { afterAll, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { workspaceAt } from "@werk/workspace";
import { runWerk, sandbox, type WerkRun } from "./support/run.js";

const run = promisify(execFile);
const TIMEOUT = 30000;

const box = await sandbox("wkw");
afterAll(box.dispose);

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
  const directory = await mkdtemp(join(box.root, "repo-"));
  await git(directory, "init", "-q", "-b", "main", ".");
  await Bun.write(join(directory, "README.md"), "committed\n");
  await git(directory, "add", "README.md");
  await git(directory, "commit", "-q", "-m", "init");
  return directory;
}

async function werk(cwd: string, ...args: string[]): Promise<WerkRun> {
  return await runWerk({
    sandbox: box,
    args: ["--json", ...args],
    cwd,
    timeoutMs: TIMEOUT,
  });
}
const failure = (ran: WerkRun) => JSON.parse(ran.stderr.trim()).error;

test(
  "a workspace is made without being asked for, and the session runs in it",
  async () => {
    const source = await repository();
    const ran = await werk(source, "create", "--", "sleep", "30");
    expect(ran.code, ran.stderr).toBe(0);
    const info = JSON.parse(ran.stdout.trim());

    // Nothing named it and nothing could be asked, so werk made one up: three
    // words, and no digest.
    expect(info.workspace.name).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/);
    expect(info.workspace.branch).toBe(info.workspace.name);
    // The session is in the workspace, not in the repository it came from.
    expect(info.cwd).toBe(info.workspace.directory);
    expect(info.cwd).not.toBe(source);
    expect((await stat(info.workspace.directory)).isDirectory()).toBe(true);
    expect(
      info.workspace.directory.startsWith(join(box.stateDir, "workspaces")),
    ).toBe(true);
    // The one notation, composed from this record's own fields rather than
    // from a shape written out here, so the record and the notation cannot
    // disagree about how a workspace is written down.
    expect(info.workspace.reference).toBe(
      `${info.workspace.name}:${info.workspace.directory}`,
    );
    // The reference a real run produced is one the package recovers from the
    // directory alone, which is the route `werk list` and the chrome take.
    expect(workspaceAt(join(box.stateDir, "workspaces"), info.cwd)).toEqual({
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
    // A sandbox of its own, with no daemon in it, so that "no daemon was left
    // behind" is a statement about this run alone.
    const alone = await sandbox("wkwsolo");
    try {
      const ran = await runWerk({
        sandbox: alone,
        args: ["--json", "create", "--", "sleep", "30"],
        timeoutMs: TIMEOUT,
      });
      expect(ran.code).toBe(2);
      expect(JSON.parse(ran.stderr.trim()).error.code).toBe("NOT_A_REPOSITORY");
      // The daemon record is written by a daemon that started. There is none.
      await expect(stat(join(alone.stateDir, "daemon.json"))).rejects.toThrow();
    } finally {
      await alone.dispose();
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
  "--describe names the workspace, and describing the same work twice numbers it",
  async () => {
    // The question `create` asks, answered on the command line. A description
    // is prose, and what reaches the branch is a name: the filler is gone and
    // what is left is joined up.
    const source = await repository();
    const ran = await werk(
      source,
      "create",
      "--describe",
      "Fix the login redirect on Safari",
      "--",
      "sleep",
      "30",
    );
    expect(ran.code, ran.stderr).toBe(0);
    expect(JSON.parse(ran.stdout.trim()).workspace.name).toBe(
      "fix-login-redirect-safari",
    );

    // Nothing in the name makes it unique, so the same description again is
    // numbered rather than refused. Only a name somebody typed is a conflict.
    const again = await werk(
      source,
      "create",
      "--describe",
      "Fix the login redirect on Safari",
      "--",
      "sleep",
      "30",
    );
    expect(again.code, again.stderr).toBe(0);
    expect(JSON.parse(again.stdout.trim()).workspace.name).toBe(
      "fix-login-redirect-safari-2",
    );
  },
  TIMEOUT,
);

test(
  "a description with nothing a name can be made of falls back to a made-up one",
  async () => {
    const source = await repository();
    const ran = await werk(source, "create", "--describe", "!!!", "--", "true");
    expect(ran.code, ran.stderr).toBe(0);
    expect(JSON.parse(ran.stdout.trim()).workspace.name).toMatch(
      /^[a-z]+-[a-z]+-[a-z]+$/,
    );
  },
  TIMEOUT,
);

test(
  "a repository with no commits says so rather than reporting a git failure",
  async () => {
    const empty = await mkdtemp(join(box.root, "empty-"));
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
    const elsewhere = await mkdtemp(join(box.root, "elsewhere-"));
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
    const table = await runWerk({
      sandbox: box,
      args: ["list"],
      cwd: source,
      timeoutMs: TIMEOUT,
    });
    const printed = table.stdout;
    expect(table.code, table.stderr).toBe(0);
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
