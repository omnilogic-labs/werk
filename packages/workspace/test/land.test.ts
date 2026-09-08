/**
 * Landing, against real repositories.
 *
 * Everything here goes through git rather than through a scripted runner,
 * because what is being asserted is what git ends up holding: which commit the
 * branch is on, that the copy was put away, and that a checkout is never left
 * mid-merge. A scripted `GitRunner` would assert the calls werk makes, which is
 * the thing most likely to change and the least worth pinning.
 *
 * git identity is passed per command so the suite does not depend on the
 * machine having a global config, which is what `local.test.ts` does for the
 * same reason. The lander gets its own runner carrying that identity, because
 * the commit it makes is git's and not the test's.
 */
import { afterAll, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createLander } from "../src/land.js";
import type { LandConflict, LandSurvey } from "../src/land.js";
import { createLocalWorktreeMaker } from "../src/local.js";
import { workspaceRecords } from "../src/record.js";
import type { GitResult, GitRunner } from "../src/git.js";
import { WorkspaceError } from "../src/types.js";

const run = promisify(execFile);
const made: string[] = [];

async function scratch(label: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), `werk-land-${label}-`));
  made.push(directory);
  return directory;
}
afterAll(async () => {
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

/** The runner the lander is given, so its own commit carries an identity too. */
const runner: GitRunner = (args, cwd) =>
  new Promise<GitResult>((resolve, reject) => {
    execFile(
      "git",
      [...IDENTITY, ...args],
      { cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") reject(error);
        else
          resolve({
            exitCode: error ? (error.code as number) : 0,
            stdout: stdout.toString(),
            stderr: stderr.toString(),
          });
      },
    );
  });

interface Bench {
  /** The repository the change lands in. */
  readonly source: string;
  /** The workspace's working directory. */
  readonly workspace: string;
  readonly root: string;
  readonly scratchRoot: string;
  readonly lander: ReturnType<typeof createLander>;
}

/**
 * A repository with one commit, a workspace made from it, and a lander pointed
 * at both. `create` is what writes the record landing reads, so the record is
 * written the way the CLI writes it rather than being fabricated here.
 */
async function bench(name = "fix-login", label = "bench"): Promise<Bench> {
  const source = await scratch(label);
  await git(source, "init", "-q", "-b", "main", ".");
  await writeFile(path.join(source, "README.md"), "first\n");
  await git(source, "add", "README.md");
  await git(source, "commit", "-q", "-m", "first");

  const root = await scratch("root");
  const scratchRoot = await scratch("landings");
  const workspace = await createLocalWorktreeMaker({
    root,
    git: runner,
  }).create({
    name,
    from: { kind: "local-checkout", path: source },
  });
  await workspaceRecords(root, source).put({
    name: workspace.name,
    directory: workspace.directory,
    branch: workspace.branch,
    ...(workspace.parent === undefined ? {} : { parent: workspace.parent }),
    base: workspace.base,
    source,
    createdAt: Date.now(),
  });
  return {
    source,
    workspace: workspace.directory,
    root,
    scratchRoot,
    lander: createLander({ root, scratchRoot, git: runner }),
  };
}

/** One commit in the workspace, so there is something to land. */
async function work(
  where: string,
  file = "change.txt",
  body = "change\n",
  subject = "change",
): Promise<void> {
  await writeFile(path.join(where, file), body);
  await git(where, "add", "-A");
  await git(where, "commit", "-q", "-m", subject);
}

const subjectOf = async (repo: string) =>
  (await git(repo, "log", "-1", "--format=%s")).stdout.trim();
const head = async (repo: string) =>
  (await git(repo, "rev-parse", "HEAD")).stdout.trim();

test("the maker answers which branch the workspace came from", async () => {
  const b = await bench("from-main", "parent");
  const record = await workspaceRecords(b.root, b.source).get("from-main");
  expect(record?.parent).toBe("main");
  expect(record?.base).toBe(await head(b.source));
});

test("a workspace made on a detached HEAD records no parent", async () => {
  const source = await scratch("detached");
  await git(source, "init", "-q", "-b", "main", ".");
  await writeFile(path.join(source, "README.md"), "first\n");
  await git(source, "add", "README.md");
  await git(source, "commit", "-q", "-m", "first");
  await git(source, "checkout", "-q", "--detach");
  const root = await scratch("detached-root");
  const workspace = await createLocalWorktreeMaker({
    root,
    git: runner,
  }).create({
    name: "loose",
    from: { kind: "local-checkout", path: source },
  });
  expect(workspace.parent).toBeUndefined();
  expect(workspace.base).toBe(await head(source));
});

test("a survey says what would land and changes nothing", async () => {
  const b = await bench("survey", "survey");
  await work(b.workspace);
  const before = await head(b.source);
  const survey = await b.lander.survey(b.source, "survey");
  expect(survey.onto).toBe("main");
  expect(survey.ontoIsParent).toBe(true);
  expect(survey.commits.map((c) => c.subject)).toEqual(["change"]);
  expect(survey.files).toEqual(["change.txt"]);
  expect(survey.uncommitted).toBe(0);
  expect(survey.inTheWay).toEqual([]);
  expect(await head(b.source)).toBe(before);
});

test("landing squashes onto the branch and puts the copy away", async () => {
  const b = await bench("squash", "squash");
  await work(b.workspace, "one.txt", "one\n", "first step");
  await work(b.workspace, "two.txt", "two\n", "second step");
  const survey = await b.lander.survey(b.source, "squash");
  expect(survey.commits).toHaveLength(2);

  const landed = await b.lander.land(survey, {
    message: "one squashed commit",
  });
  expect(landed.onto).toBe("main");
  expect(landed.squashed).toBe(2);
  expect(landed.files).toBe(2);
  expect(await subjectOf(b.source)).toBe("one squashed commit");
  // One commit, not two: the whole point of a squash.
  expect(
    (await git(b.source, "rev-list", "--count", "HEAD")).stdout.trim(),
  ).toBe("2");
  // And the copy is gone, from the disk and from git's list of worktrees.
  expect(await readdir(path.join(b.scratchRoot))).toHaveLength(1);
  const slot = (await readdir(b.scratchRoot))[0]!;
  expect(await readdir(path.join(b.scratchRoot, slot))).toEqual([]);
  expect((await git(b.source, "worktree", "list")).stdout).not.toContain(
    "landings",
  );
});

test("the workspace and its branch survive the landing", async () => {
  const b = await bench("survives", "survives");
  await work(b.workspace);
  const at = await head(b.workspace);
  await b.lander.land(await b.lander.survey(b.source, "survives"), {
    message: "landed",
  });
  expect(await head(b.workspace)).toBe(at);
  expect(
    (await git(b.source, "show-ref", "--verify", "refs/heads/survives")).stdout,
  ).toContain("survives");
});

test("landing onto a branch that is not the parent is still landing", async () => {
  const b = await bench("elsewhere", "elsewhere");
  await work(b.workspace);
  await git(b.source, "checkout", "-q", "-b", "other");
  const survey = await b.lander.survey(b.source, "elsewhere");
  // The refusal is the caller's to make, from this fact. The lander does it.
  expect(survey.ontoIsParent).toBe(false);
  expect(survey.workspace.parent).toBe("main");
  expect(survey.onto).toBe("other");
  await b.lander.land(survey, { message: "onto other" });
  expect(await subjectOf(b.source)).toBe("onto other");
  expect(
    (await git(b.source, "rev-parse", "--abbrev-ref", "HEAD")).stdout.trim(),
  ).toBe("other");
});

test("uncommitted work in the workspace is counted and does not land", async () => {
  const b = await bench("dirty-ws", "dirty-ws");
  await work(b.workspace);
  await writeFile(path.join(b.workspace, "not-committed.txt"), "later\n");
  await git(b.workspace, "add", "not-committed.txt");
  const survey = await b.lander.survey(b.source, "dirty-ws");
  expect(survey.uncommitted).toBe(1);
  await b.lander.land(survey, { message: "committed only" });
  expect(
    (await git(b.source, "ls-files", "not-committed.txt")).stdout.trim(),
  ).toBe("");
});

test("a tracked change in the landing checkout refuses before anything is made", async () => {
  const b = await bench("dirty-here", "dirty-here");
  await work(b.workspace);
  await writeFile(path.join(b.source, "README.md"), "edited\n");
  const survey = await b.lander.survey(b.source, "dirty-here");
  expect(survey.inTheWay).toHaveLength(1);
  await expect(
    b.lander.land(survey, { message: "should not happen" }),
  ).rejects.toMatchObject({ code: "WORKTREE_DIRTY" });
  // Nothing was made: the refusal comes before the copy.
  const slot = (await readdir(b.scratchRoot))[0];
  expect(slot).toBeUndefined();
});

test("an untracked file is not in the way", async () => {
  const b = await bench("untracked", "untracked");
  await work(b.workspace);
  await writeFile(path.join(b.source, "build.log"), "noise\n");
  const survey = await b.lander.survey(b.source, "untracked");
  expect(survey.inTheWay).toEqual([]);
  await b.lander.land(survey, { message: "landed past the noise" });
  expect(await subjectOf(b.source)).toBe("landed past the noise");
});

test("a conflict with nothing to resolve it leaves the copy behind", async () => {
  const b = await bench("clash", "clash");
  await work(
    b.workspace,
    "README.md",
    "from the workspace\n",
    "workspace edit",
  );
  await writeFile(path.join(b.source, "README.md"), "from main\n");
  await git(b.source, "commit", "-qam", "main edit");
  const survey = await b.lander.survey(b.source, "clash");
  const at = await head(b.source);

  const failure = await b.lander
    .land(survey, { message: "will not apply" })
    .catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(WorkspaceError);
  expect((failure as WorkspaceError).code).toBe("LAND_CONFLICT");
  // The branch did not move, and the copy is still there holding the conflict.
  expect(await head(b.source)).toBe(at);
  const slot = (await readdir(b.scratchRoot))[0]!;
  const copies = await readdir(path.join(b.scratchRoot, slot));
  expect(copies).toHaveLength(1);
  expect((failure as WorkspaceError).message).toContain(copies[0]!);
});

test("a resolver that settles the conflict lands it", async () => {
  const b = await bench("resolved", "resolved");
  await work(
    b.workspace,
    "README.md",
    "from the workspace\n",
    "workspace edit",
  );
  await writeFile(path.join(b.source, "README.md"), "from main\n");
  await git(b.source, "commit", "-qam", "main edit");
  const survey = await b.lander.survey(b.source, "resolved");

  const seen: LandConflict[] = [];
  const landed = await b.lander.land(survey, {
    message: "resolved by hand",
    resolve: async (conflict) => {
      seen.push(conflict);
      for (const file of conflict.paths) {
        await writeFile(path.join(conflict.directory, file), "both\n");
        await git(conflict.directory, "add", file);
      }
      return true;
    },
  });
  expect(seen).toHaveLength(1);
  expect(seen[0]!.paths).toEqual(["README.md"]);
  expect(landed.onto).toBe("main");
  expect(await subjectOf(b.source)).toBe("resolved by hand");
  const copies = await readdir(
    path.join(b.scratchRoot, (await readdir(b.scratchRoot))[0]!),
  );
  expect(copies).toEqual([]);
});

test("a resolver that gives up is a conflict, not a bad commit", async () => {
  const b = await bench("gave-up", "gave-up");
  await work(
    b.workspace,
    "README.md",
    "from the workspace\n",
    "workspace edit",
  );
  await writeFile(path.join(b.source, "README.md"), "from main\n");
  await git(b.source, "commit", "-qam", "main edit");
  const survey = await b.lander.survey(b.source, "gave-up");
  await expect(
    b.lander.land(survey, { message: "no", resolve: async () => false }),
  ).rejects.toMatchObject({ code: "LAND_CONFLICT" });
});

test("a name with no record is refused before git is asked anything", async () => {
  const b = await bench("known", "unknown");
  await expect(b.lander.survey(b.source, "never-made")).rejects.toMatchObject({
    code: "NO_SUCH_WORKSPACE",
  });
});

test("a workspace on another machine is refused in those words", async () => {
  const b = await bench("away", "away");
  await workspaceRecords(b.root, b.source).put({
    name: "away",
    directory: "/srv/werk/workspaces/repo-a3f2b1c9/away",
    branch: "away",
    parent: "main",
    base: await head(b.source),
    source: b.source,
    host: "beast",
    createdAt: Date.now(),
  });
  const failure = await b.lander
    .survey(b.source, "away")
    .catch((error: unknown) => error);
  expect((failure as WorkspaceError).code).toBe("WORKSPACE_ELSEWHERE");
  expect((failure as WorkspaceError).message).toContain("beast");
});

test("a detached HEAD has nothing to land onto", async () => {
  const b = await bench("loose", "loose");
  await work(b.workspace);
  await git(b.source, "checkout", "-q", "--detach");
  await expect(b.lander.survey(b.source, "loose")).rejects.toMatchObject({
    code: "DETACHED_HEAD",
  });
});

test("a workspace with nothing the branch lacks is nothing to land", async () => {
  const b = await bench("empty", "empty");
  await expect(b.lander.survey(b.source, "empty")).rejects.toMatchObject({
    code: "NOTHING_TO_LAND",
  });
});

test("landing outside a repository is refused", async () => {
  const b = await bench("outside", "outside");
  const elsewhere = await scratch("not-a-repo");
  await expect(b.lander.survey(elsewhere, "outside")).rejects.toMatchObject({
    code: "NOT_A_REPOSITORY",
  });
});

test("progress reports every stage, and a broken reporter does not fail it", async () => {
  const b = await bench("progress", "progress");
  await work(b.workspace);
  const steps: string[] = [];
  await b.lander.land(await b.lander.survey(b.source, "progress"), {
    message: "watched",
    onProgress: (event) => {
      if (event.state === "begin") steps.push(event.step);
      throw new Error("the renderer is broken");
    },
  });
  expect(steps).toEqual(["copy", "apply", "commit", "move", "clean-up"]);
  expect(await subjectOf(b.source)).toBe("watched");
});

test("a survey is a value, so a caller can decide from it twice", async () => {
  const b = await bench("twice", "twice");
  await work(b.workspace);
  const survey: LandSurvey = await b.lander.survey(b.source, "twice");
  expect(survey.workspace.branch).toBe("twice");
  expect(survey.ontoAt).toBe(await head(b.source));
});
