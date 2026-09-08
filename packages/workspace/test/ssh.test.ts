/**
 * A workspace on another machine, decided against a scripted git and a scripted
 * machine.
 *
 * This is the reason both runners are injected. Every row of the failure table,
 * the exact argv of every git call, the shape of the scripts sent away, the
 * rollback and the progress a caller sees are all asserted here without a second
 * computer and without ssh.
 */
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { GitResult, GitRunner } from "../src/git.js";
import type { RemoteRunner } from "../src/remote.js";
import { createSshWorkspaceMaker } from "../src/ssh.js";
import { WorkspaceError } from "../src/types.js";
import type { Workspace, WorkspaceProgress } from "../src/types.js";

const ok = (stdout = ""): GitResult => ({ exitCode: 0, stdout, stderr: "" });
const no = (stderr = "", exitCode = 1): GitResult => ({
  exitCode,
  stdout: "",
  stderr,
});

/** A repository identity fixed in the config, so the layout below is a fixed string. */
const REPO_ID = "11111111-2222-3333-4444-555555555555";
const digest = createHash("sha256").update(REPO_ID).digest("hex").slice(0, 8);
const SLOT = `repo-${digest}`;
const ROOT = "/srv/werk";
const BARE = `${ROOT}/repos/${SLOT}.git`;
const DIRECTORY = `${ROOT}/${SLOT}/demo`;

interface GitCall {
  readonly args: readonly string[];
  readonly cwd: string;
}

/**
 * A git that answers the first table row its argv contains. Ordered, so a more
 * specific row goes above a less specific one.
 */
function scriptedGit(
  calls: GitCall[],
  rows: readonly (readonly [string, GitResult])[] = [],
): GitRunner {
  const table: (readonly [string, GitResult])[] = [
    ...rows,
    ["rev-parse --show-toplevel", ok("/repo\n")],
    ["rev-parse --verify HEAD", ok("2b1c9f\n")],
    ["symbolic-ref --quiet --short HEAD", ok("main\n")],
    ["config --local --get werk.repo-id", ok(`${REPO_ID}\n`)],
    ["config --local werk.repo-id", ok()],
    ["status --porcelain", ok("")],
    ["push --quiet", ok()],
  ];
  return async (args, cwd) => {
    calls.push({ args: [...args], cwd });
    const joined = args.join(" ");
    for (const [needle, result] of table)
      if (joined.includes(needle)) return result;
    return no(`unscripted: ${joined}`);
  };
}

/** A machine that answers each script in turn from a list, and 0 with the marker after. */
function scriptedRemote(
  scripts: string[],
  replies: readonly (GitResult | Error)[] = [],
): RemoteRunner {
  return async (script) => {
    const reply = replies[scripts.length];
    scripts.push(script);
    if (reply instanceof Error) throw reply;
    if (reply !== undefined) return reply;
    return scripts.length === 1 ? ok("werk-ready no\n") : ok();
  };
}

interface Harness {
  readonly calls: GitCall[];
  readonly scripts: string[];
  readonly progress: WorkspaceProgress[];
  readonly create: () => Promise<Workspace>;
}

function harness(
  options: {
    readonly git?: readonly (readonly [string, GitResult])[];
    readonly remote?: readonly (GitResult | Error)[];
    readonly root?: string;
    readonly name?: string;
    readonly pushConfig?: readonly string[];
  } = {},
): Harness {
  const calls: GitCall[] = [];
  const scripts: string[] = [];
  const progress: WorkspaceProgress[] = [];
  const maker = createSshWorkspaceMaker({
    host: "beast",
    root: options.root ?? ROOT,
    git: scriptedGit(calls, options.git),
    remote: scriptedRemote(scripts, options.remote),
    pushUrl: (repositoryPath) => `ssh://beast${repositoryPath}`,
    ...(options.pushConfig === undefined
      ? {}
      : { pushConfig: options.pushConfig }),
  });
  return {
    calls,
    scripts,
    progress,
    create: () =>
      maker.create(
        {
          name: options.name ?? "demo",
          from: { kind: "local-checkout", path: "/repo/packages/werk" },
        },
        { onProgress: (event) => progress.push(event) },
      ),
  };
}

async function failureOf(h: Harness): Promise<WorkspaceError> {
  try {
    await h.create();
  } catch (error) {
    expect(error).toBeInstanceOf(WorkspaceError);
    return error as WorkspaceError;
  }
  throw new Error("expected a failure");
}

test("the maker says which kind of place it makes workspaces in", () => {
  const maker = createSshWorkspaceMaker({
    host: "beast",
    root: ROOT,
    remote: async () => ok(),
    pushUrl: (p) => p,
  });
  expect(maker.kind).toBe("ssh-worktree");
});

test("a workspace on another machine is a mirror, a push and a locked worktree", async () => {
  const h = harness();
  const workspace = await h.create();

  expect(workspace).toEqual({
    name: "demo",
    directory: DIRECTORY,
    branch: "demo",
    // What the branch started at, and the branch it started from: the two facts
    // landing needs and the two nothing can recover afterwards.
    base: "2b1c9f",
    parent: "main",
    from: { kind: "local-checkout", path: "/repo/packages/werk" },
    host: "beast",
  });

  // Every local git call, in order, with the directory it ran in. Local checks
  // come first so a mistake the person made costs no network at all.
  expect(h.calls).toEqual([
    { args: ["rev-parse", "--show-toplevel"], cwd: "/repo/packages/werk" },
    { args: ["rev-parse", "--verify", "HEAD"], cwd: "/repo" },
    {
      args: ["symbolic-ref", "--quiet", "--short", "HEAD"],
      cwd: "/repo",
    },
    { args: ["config", "--local", "--get", "werk.repo-id"], cwd: "/repo" },
    { args: ["status", "--porcelain"], cwd: "/repo" },
    {
      args: ["push", "--quiet", `ssh://beast${BARE}`, "HEAD:refs/heads/demo"],
      cwd: "/repo",
    },
  ]);

  // The push names a URL and nothing else: no `git remote add` beforehand, no
  // `-u` to write one afterwards, so the user's `.git/config` is untouched.
  // And never `--force`.
  const push = h.calls.at(-1)!.args;
  expect(push).not.toContain("-u");
  expect(push).not.toContain("--set-upstream");
  expect(push).not.toContain("--force");
  expect(push).not.toContain("-f");
  expect(h.calls.map((c) => c.args[0])).not.toContain("remote");

  // The mirror is bare, so `receive.denyCurrentBranch` never applies and there
  // is no hook for werk to own on every machine.
  expect(h.scripts[0]).toContain(`git init -q --bare "$bare"`);
  expect(h.scripts[0]).toContain(`bare='${BARE}'`);
  expect(h.scripts[0]).toContain(`dir='${DIRECTORY}'`);
  // The worktree is locked, so a prune cannot race a live workspace.
  expect(h.scripts[1]).toBe(
    `git -C '${BARE}' worktree add --lock -q '${DIRECTORY}' 'demo'`,
  );
  expect(h.scripts).toHaveLength(2);
});

test("the stages a caller can report, in order", async () => {
  const h = harness({
    git: [["status --porcelain", ok(" M src/a.ts\n?? b\n")]],
  });
  await h.create();
  expect(h.progress.map((e) => `${e.step} ${e.state}`)).toEqual([
    "resolve-source begin",
    "resolve-source end",
    "prepare-repository begin",
    "prepare-repository end",
    "transfer begin",
    "transfer end",
    "check-out begin",
    "check-out end",
  ]);
  expect(h.progress[1]!.detail).toBe("/repo");
  expect(h.progress[2]!.detail).toBe(`beast:${BARE}`);
  // Uncommitted work does not travel, and the count is how the caller learns to
  // say so once. Not a prompt, which would break `--json`, and not a refusal.
  expect(h.progress[4]!.detail).toBe(
    "uncommitted changes in 2 files stay on this machine",
  );
  expect(h.progress[7]!.detail).toBe(DIRECTORY);
});

test("a clean tree has nothing to say about uncommitted work", async () => {
  const h = harness();
  await h.create();
  expect(h.progress[4]!.detail).toBeUndefined();
});

test("one file reads as one file", async () => {
  const h = harness({ git: [["status --porcelain", ok(" M only.ts\n")]] });
  await h.create();
  expect(h.progress[4]!.detail).toBe(
    "uncommitted changes in 1 file stay on this machine",
  );
});

test("git refusing to report the dirty tree is not a reason to refuse", async () => {
  // A person about to be told their uncommitted work stays behind is not helped
  // by being told instead that `git status` exited 128.
  const h = harness({
    git: [["status --porcelain", no("fatal: whatever", 128)]],
  });
  await h.create();
  expect(h.progress[4]!.detail).toBeUndefined();
});

test("the repository names itself once, and reuses the name after", async () => {
  // A path is a local fact and cannot decide where anything lands on another
  // machine, so a repository gets an identity of its own. This is the first
  // thing werk writes into a user's repository: one namespaced line that
  // `git config --unset werk.repo-id` reverses.
  const first = harness({
    git: [["config --local --get werk.repo-id", no()]],
  });
  const workspace = await first.create();
  const write = first.calls.find(
    (c) => c.args[0] === "config" && c.args[2] === "werk.repo-id",
  )!;
  expect(write.args.slice(0, 3)).toEqual(["config", "--local", "werk.repo-id"]);
  const identity = write.args[3]!;
  expect(identity).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
  // The slot is the readable leaf and the digest of that identity, not of any
  // path: the same shape the local maker uses, from a fact that travels.
  const expected = createHash("sha256")
    .update(identity)
    .digest("hex")
    .slice(0, 8);
  expect(workspace.directory).toBe(`${ROOT}/repo-${expected}/demo`);

  // A repository that already carries one is read, never written again.
  const second = harness();
  await second.create();
  expect(
    second.calls.filter(
      (c) => c.args[0] === "config" && c.args[2] === "werk.repo-id",
    ),
  ).toEqual([]);
});

test("a name that is not a name reaches neither machine", async () => {
  const h = harness({ name: "a/b" });
  expect((await failureOf(h)).code).toBe("INVALID_NAME");
  expect(h.calls).toEqual([]);
  expect(h.scripts).toEqual([]);
});

test("the local checks come before anything is sent anywhere", async () => {
  const outside = harness({
    git: [["rev-parse --show-toplevel", no("fatal: not a git repository")]],
  });
  expect((await failureOf(outside)).code).toBe("NOT_A_REPOSITORY");
  expect(outside.scripts).toEqual([]);

  const empty = harness({
    git: [["rev-parse --verify HEAD", no("fatal: Needed a single revision")]],
  });
  expect((await failureOf(empty)).code).toBe("NO_COMMITS");
  expect(empty.scripts).toEqual([]);
});

test("no git on this machine is still its own failure", async () => {
  const absent: GitRunner = async () => {
    throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
  };
  const maker = createSshWorkspaceMaker({
    host: "beast",
    root: ROOT,
    git: absent,
    remote: async () => ok(),
    pushUrl: (p) => p,
  });
  await expect(
    maker.create({
      name: "demo",
      from: { kind: "local-checkout", path: "/repo" },
    }),
  ).rejects.toMatchObject({ code: "GIT_MISSING" });
});

test("each numbered refusal from the machine is its own reason", async () => {
  // Distinct exits rather than parsed stderr, for the reason `local.ts` gives:
  // git's wording moves between versions and locales, and the exit status of a
  // refusal is not fixed. A script werk wrote can pick its own numbers.
  const table: readonly [number, string][] = [
    [90, "REMOTE_GIT_MISSING"],
    [91, "DIRECTORY_EXISTS"],
    [92, "BRANCH_EXISTS"],
  ];
  for (const [exitCode, code] of table) {
    const h = harness({ remote: [{ exitCode, stdout: "", stderr: "" }] });
    expect((await failureOf(h)).code, String(exitCode)).toBe(code);
    // Nothing was pushed: the machine said no before any history moved.
    expect(h.calls.map((c) => c.args[0])).not.toContain("push");
  }
});

test("no git on the far machine is a different remedy from no git here", async () => {
  const h = harness({ remote: [{ exitCode: 90, stdout: "", stderr: "" }] });
  const error = await failureOf(h);
  expect(error.code).toBe("REMOTE_GIT_MISSING");
  expect(error.message).toContain("beast");
});

test("a machine that did not answer is told apart from one that refused", async () => {
  // ssh spends 255 on everything it could not do at all.
  const transport = harness({
    remote: [{ exitCode: 255, stdout: "", stderr: "ssh: connect: timed out" }],
  });
  const byExit = await failureOf(transport);
  expect(byExit.code).toBe("HOST_UNREACHABLE");
  expect(byExit.detail).toBe("ssh: connect: timed out");

  // A runner that could not even be called says the same thing.
  const thrown = harness({
    remote: [new Error("getaddrinfo ENOTFOUND beast")],
  });
  expect((await failureOf(thrown)).code).toBe("HOST_UNREACHABLE");
});

test("a runner that can tell auth apart says so itself", async () => {
  // This file cannot separate a refused key from an unreachable machine, so a
  // transport that can raises the reason it wants and it passes through.
  const h = harness({
    remote: [new WorkspaceError("HOST_AUTH_DENIED", "beast refused the key")],
  });
  const error = await failureOf(h);
  expect(error.code).toBe("HOST_AUTH_DENIED");
  expect(error.message).toBe("beast refused the key");
});

test("a machine that answers without running the script is unsupported", async () => {
  // A shell that ran none of it also exits 0, so the marker is what separates
  // "it worked" from "this is not a machine the maker knows how to drive".
  const h = harness({ remote: [ok("")] });
  expect((await failureOf(h)).code).toBe("HOST_UNSUPPORTED");
});

test("anything else the preparation said carries what it said", async () => {
  const h = harness({
    remote: [{ exitCode: 3, stdout: "", stderr: "mkdir: permission denied" }],
  });
  const error = await failureOf(h);
  expect(error.code).toBe("GIT_FAILED");
  expect(error.detail).toBe("mkdir: permission denied");
});

test("a history that did not get there has its own reason, because its remedy does", async () => {
  const h = harness({
    git: [["push --quiet", no("fatal: the remote end hung up", 128)]],
  });
  const error = await failureOf(h);
  expect(error.code).toBe("TRANSFER_FAILED");
  expect(error.detail).toBe("fatal: the remote end hung up");
  // The push is the last thing that happened; nothing was checked out.
  expect(h.scripts).toHaveLength(1);
  expect(h.progress.map((e) => `${e.step} ${e.state}`)).toEqual([
    "resolve-source begin",
    "resolve-source end",
    "prepare-repository begin",
    "prepare-repository end",
    "transfer begin",
  ]);
});

test("a check-out that failed is undone, and the mirror is left alone", async () => {
  const h = harness({
    remote: [
      ok("werk-ready yes\n"),
      no("fatal: could not create worktree", 128),
    ],
  });
  const error = await failureOf(h);
  expect(error.code).toBe("GIT_FAILED");
  expect(error.detail).toBe("fatal: could not create worktree");

  // Reversed, best-effort, bounded, and in one script.
  const rollback = h.scripts[2]!;
  expect(rollback).toContain(
    `git -C "$bare" worktree remove --force "$dir" >/dev/null 2>&1 || true`,
  );
  expect(rollback.indexOf("worktree remove")).toBeLessThan(
    rollback.indexOf("worktree prune"),
  );
  expect(rollback.indexOf("worktree prune")).toBeLessThan(
    rollback.indexOf("branch -D"),
  );
  expect(rollback).toContain(`branch -D 'demo'`);
  // The mirror is shared by every workspace of this repository, so nothing
  // removes it because one creation failed.
  expect(rollback).not.toContain("rm -rf");
  expect(rollback).not.toContain(`init`);
  // This attempt made it, so the message says where it was left.
  expect(error.message).toContain(
    `the mirror beast:${BARE} was made by this attempt`,
  );
  expect(h.scripts).toHaveLength(3);
});

test("a mirror that was already there is not something to mention", async () => {
  const h = harness({
    remote: [
      ok("werk-ready no\n"),
      no("fatal: could not create worktree", 128),
    ],
  });
  const error = await failureOf(h);
  expect(error.message).not.toContain("was made by this attempt");
});

test("a rollback that did not finish is a note, never the primary error", async () => {
  const h = harness({
    remote: [
      ok("werk-ready no\n"),
      no("fatal: could not create worktree", 128),
      { exitCode: 93, stdout: " branch-delete\n", stderr: "" },
    ],
  });
  const error = await failureOf(h);
  // What the person needs first is why the workspace was not made.
  expect(error.code).toBe("GIT_FAILED");
  expect(error.message).toStartWith("git worktree add failed for");
  expect(error.message).toContain("clearing up on beast did not finish");
  expect(error.message).toContain("branch-delete");
});

test("a signal aborted between stages stops the sequence", async () => {
  // The stage boundaries are as fine-grained as an injected runner allows: a
  // call already sent is not recalled, and the next one is not made.
  const controller = new AbortController();
  const calls: GitCall[] = [];
  const scripts: string[] = [];
  const inner = scriptedGit(calls);
  const maker = createSshWorkspaceMaker({
    host: "beast",
    root: ROOT,
    git: async (args, cwd) => {
      const result = await inner(args, cwd);
      // Abandoned as the local checks finish, before anything is sent away.
      if (args[0] === "status") controller.abort();
      return result;
    },
    remote: scriptedRemote(scripts),
    pushUrl: (p) => `ssh://beast${p}`,
  });
  await expect(
    maker.create(
      { name: "demo", from: { kind: "local-checkout", path: "/repo" } },
      { signal: controller.signal },
    ),
  ).rejects.toThrow();
  expect(scripts).toEqual([]);
  expect(calls.map((c) => c.args[0])).not.toContain("push");
});

test("a root with a space in it survives the shell", async () => {
  const awkward = "/srv/werk state/it's here";
  const h = harness({ root: awkward });
  const workspace = await h.create();
  expect(workspace.directory).toBe(`${awkward}/${SLOT}/demo`);
  // Single-quoted, with the embedded quote closed and reopened, so the script
  // sees one word. A workspace name is validated; a root path is not.
  expect(h.scripts[0]).toContain(
    `dir='/srv/werk state/it'\\''s here/${SLOT}/demo'`,
  );
  expect(h.scripts[0]).toContain(
    `bare='/srv/werk state/it'\\''s here/repos/${SLOT}.git'`,
  );
  expect(h.scripts[1]).toBe(
    `git -C '/srv/werk state/it'\\''s here/repos/${SLOT}.git' worktree add --lock -q '/srv/werk state/it'\\''s here/${SLOT}/demo' 'demo'`,
  );
});

test("configuration the caller hands the push goes in front of it", async () => {
  const h = harness({ pushConfig: ["-c", "core.sshCommand=ssh -F /dev/null"] });
  await h.create();
  expect(h.calls.at(-1)!.args).toEqual([
    "-c",
    "core.sshCommand=ssh -F /dev/null",
    "push",
    "--quiet",
    `ssh://beast${BARE}`,
    "HEAD:refs/heads/demo",
  ]);
});

test("a renderer that throws does not break a creation on another machine", async () => {
  const maker = createSshWorkspaceMaker({
    host: "beast",
    root: ROOT,
    git: scriptedGit([]),
    remote: scriptedRemote([]),
    pushUrl: (p) => `ssh://beast${p}`,
  });
  const workspace = await maker.create(
    { name: "demo", from: { kind: "local-checkout", path: "/repo" } },
    {
      onProgress: () => {
        throw new Error("the caller's line painter fell over");
      },
    },
  );
  expect(workspace.host).toBe("beast");
});
