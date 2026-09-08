/**
 * The host against real repositories.
 *
 * The scripted tests next door decide which failure a caller is told about;
 * these decide that the thing git actually makes is a workspace — a directory
 * that exists, on its own branch, that the source repository agrees is one of
 * its worktrees. git identity is passed per command so the suite does not
 * depend on the machine having a global config.
 */
import { afterAll, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  createLocalWorktreeMaker,
  workspaceAt,
  repositorySlot,
} from "../src/local.js";
import {
  formatWorkspaceReference,
  workspaceReference,
} from "../src/reference.js";
import { WorkspaceError } from "../src/types.js";
import type { Workspace, WorkspaceProgress } from "../src/types.js";

const run = promisify(execFile);
const made: string[] = [];

/** A temporary directory that is removed however the test ends. */
async function scratch(label: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), `werk-ws-${label}-`));
  made.push(directory);
  return directory;
}
afterAll(async () => {
  // Cleanup failure is not a test failure: Windows keeps handles on the objects
  // git just wrote for longer than the suite does.
  for (const directory of made)
    await rm(directory, { recursive: true, force: true }).catch(() => {});
});

const IDENTITY = [
  "-c",
  "user.name=werk test",
  "-c",
  "user.email=test@example.invalid",
  "-c",
  "commit.gpgsign=false",
];
const git = (cwd: string, ...args: string[]) =>
  run("git", [...IDENTITY, ...args], { cwd, encoding: "utf8" });

/** A repository with one commit in it, which is the least git will branch from. */
async function repository(label = "repo"): Promise<string> {
  const directory = await scratch(label);
  await git(directory, "init", "-q", "-b", "main", ".");
  await writeFile(path.join(directory, "README.md"), "committed\n");
  await git(directory, "add", "README.md");
  await git(directory, "commit", "-q", "-m", "init");
  return directory;
}
const hostFor = async (root?: string) =>
  createLocalWorktreeMaker({ root: root ?? (await scratch("root")) });

async function created(name = "demo"): Promise<{
  workspace: Workspace;
  source: string;
  root: string;
}> {
  const source = await repository();
  const root = await scratch("root");
  const workspace = await createLocalWorktreeMaker({ root }).create({
    name,
    from: { kind: "local-checkout", path: source },
  });
  return { workspace, source, root };
}

test("a workspace is a directory on a branch of its own", async () => {
  const { workspace, source } = await created();
  expect(workspace.name).toBe("demo");
  expect(workspace.branch).toBe("demo");
  expect(workspace.from).toEqual({ kind: "local-checkout", path: source });
  expect((await stat(workspace.directory)).isDirectory()).toBe(true);
  // A linked worktree carries a `.git` file rather than a directory.
  expect(await stat(path.join(workspace.directory, ".git"))).toBeDefined();
  const { stdout } = await git(
    workspace.directory,
    "rev-parse",
    "--abbrev-ref",
    "HEAD",
  );
  expect(stdout.trim()).toBe("demo");
});

test("a local workspace reports the two stages it has, and carries no host", async () => {
  // Two of the seven steps, because a worktree on this machine costs two. The
  // local maker emits them so the callback a remote creation leans on is
  // exercised by the maker every other test already runs.
  const source = await repository();
  const root = await scratch("root");
  const seen: WorkspaceProgress[] = [];
  const workspace = await createLocalWorktreeMaker({ root }).create(
    { name: "demo", from: { kind: "local-checkout", path: source } },
    { onProgress: (event) => seen.push(event) },
  );
  expect(seen.map((e) => `${e.step} ${e.state}`)).toEqual([
    "resolve-source begin",
    "resolve-source end",
    "check-out begin",
    "check-out end",
  ]);
  expect(seen[3]!.detail).toBe(workspace.directory);
  // Absent, because absence is what says "the machine werk is running on".
  expect(workspace.host).toBeUndefined();
});

test("a renderer that throws does not break the creation it was watching", async () => {
  const source = await repository();
  const root = await scratch("root");
  const workspace = await createLocalWorktreeMaker({ root }).create(
    { name: "demo", from: { kind: "local-checkout", path: source } },
    {
      onProgress: () => {
        throw new Error("the caller's line painter fell over");
      },
    },
  );
  expect((await stat(workspace.directory)).isDirectory()).toBe(true);
});

test("a workspace the host made is recovered from its directory alone", async () => {
  // The round trip that `werk list` and the chrome depend on: they hold a
  // directory and no name. Both sides come from the host rather than from a
  // path written out here, so the join and its inverse cannot drift apart.
  const { workspace, root } = await created("fix-login");
  expect(workspaceAt(root, workspace.directory)).toEqual(
    workspaceReference(workspace),
  );
  // The reference recovered this way is what the notation writes.
  expect(
    formatWorkspaceReference(workspaceAt(root, workspace.directory)!, "path"),
  ).toBe(`${workspace.name}:${workspace.directory}`);
  // A directory inside the workspace is not itself a workspace.
  expect(
    workspaceAt(root, path.join(workspace.directory, "src")),
  ).toBeUndefined();
  // Nor is the checkout the workspace was branched from.
  expect(workspaceAt(root, (await created()).source)).toBeUndefined();
});

test("the source repository agrees the worktree is one of its own", async () => {
  const { workspace, source } = await created();
  const { stdout } = await git(source, "worktree", "list", "--porcelain");
  expect(stdout).toContain("branch refs/heads/demo");
  // git reports the path it resolved, which on macOS differs from the one we
  // asked for by `/private`, so compare the leaf and the slot rather than the
  // whole string.
  expect(stdout).toContain(path.basename(workspace.directory));
});

test("the directory is the repository's slot under the root", async () => {
  const { workspace, source, root } = await created();
  const { stdout } = await git(source, "rev-parse", "--show-toplevel");
  const toplevel = stdout.trim();
  expect(workspace.directory).toBe(
    path.join(root, repositorySlot(toplevel), "demo"),
  );
  expect(path.basename(path.dirname(workspace.directory))).toMatch(
    /-[0-9a-f]{8}$/,
  );
});

test("two repositories can each have a workspace of the same name", async () => {
  const root = await scratch("root");
  const host = createLocalWorktreeMaker({ root });
  const one = await host.create({
    name: "demo",
    from: { kind: "local-checkout", path: await repository("one") },
  });
  const two = await host.create({
    name: "demo",
    from: { kind: "local-checkout", path: await repository("two") },
  });
  expect(one.directory).not.toBe(two.directory);
  expect(path.dirname(one.directory)).not.toBe(path.dirname(two.directory));
});

test("a branch that already exists is refused before anything is made", async () => {
  const source = await repository();
  await git(source, "branch", "taken");
  const root = await scratch("root");
  const host = createLocalWorktreeMaker({ root });
  await expect(
    host.create({
      name: "taken",
      from: { kind: "local-checkout", path: source },
    }),
  ).rejects.toMatchObject({ code: "BRANCH_EXISTS" });
  expect(await readdir(root)).toEqual([]);
});

test("an occupied directory is refused, an empty one is not", async () => {
  const source = await repository();
  const root = await scratch("root");
  const host = createLocalWorktreeMaker({ root });
  const { stdout } = await git(source, "rev-parse", "--show-toplevel");
  const target = path.join(root, repositorySlot(stdout.trim()), "demo");

  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, "in-the-way"), "x");
  await expect(
    host.create({
      name: "demo",
      from: { kind: "local-checkout", path: source },
    }),
  ).rejects.toMatchObject({ code: "DIRECTORY_EXISTS" });

  await rm(path.join(target, "in-the-way"));
  const workspace = await host.create({
    name: "demo",
    from: { kind: "local-checkout", path: source },
  });
  expect(workspace.directory).toBe(target);
});

test("somewhere that is not a repository is refused", async () => {
  const host = await hostFor();
  const plain = await scratch("plain");
  const error = await host
    .create({ name: "demo", from: { kind: "local-checkout", path: plain } })
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(WorkspaceError);
  expect((error as WorkspaceError).code).toBe("NOT_A_REPOSITORY");
});

test("a repository with no commits says it has none", async () => {
  const empty = await scratch("empty");
  await git(empty, "init", "-q", "-b", "main", ".");
  const host = await hostFor();
  const error = await host
    .create({ name: "demo", from: { kind: "local-checkout", path: empty } })
    .catch((e: unknown) => e);
  expect((error as WorkspaceError).code).toBe("NO_COMMITS");
});

test("a name that is not a name makes no directory", async () => {
  const root = await scratch("root");
  const host = createLocalWorktreeMaker({ root });
  const source = await repository();
  for (const name of ["", "a/b", "-x", ".."])
    await expect(
      host.create({ name, from: { kind: "local-checkout", path: source } }),
    ).rejects.toMatchObject({ code: "INVALID_NAME" });
  expect(await readdir(root)).toEqual([]);
});

test("a dirty working tree branches from what was committed", async () => {
  const source = await repository();
  await writeFile(path.join(source, "README.md"), "uncommitted\n");
  await writeFile(path.join(source, "untracked.txt"), "also uncommitted\n");
  const host = await hostFor();
  const workspace = await host.create({
    name: "demo",
    from: { kind: "local-checkout", path: source },
  });
  expect(
    await Bun.file(path.join(workspace.directory, "README.md")).text(),
  ).toBe("committed\n");
  await expect(
    stat(path.join(workspace.directory, "untracked.txt")),
  ).rejects.toThrow();
});

test("a subdirectory of a repository resolves to the repository", async () => {
  const source = await repository();
  const inside = path.join(source, "packages", "deep");
  await mkdir(inside, { recursive: true });
  const host = await hostFor();
  const workspace = await host.create({
    name: "demo",
    from: { kind: "local-checkout", path: inside },
  });
  const { stdout } = await git(source, "rev-parse", "--show-toplevel");
  expect(path.basename(path.dirname(workspace.directory))).toBe(
    repositorySlot(stdout.trim()),
  );
});

test("a workspace can be made from a workspace's own directory", async () => {
  // The source is itself a linked worktree, which is the shape werk will be
  // standing in as soon as anyone works inside one.
  const { workspace } = await created("first");
  const host = await hostFor();
  const second = await host.create({
    name: "second",
    from: { kind: "local-checkout", path: workspace.directory },
  });
  expect((await stat(second.directory)).isDirectory()).toBe(true);
  const { stdout } = await git(
    second.directory,
    "rev-parse",
    "--abbrev-ref",
    "HEAD",
  );
  expect(stdout.trim()).toBe("second");
});
