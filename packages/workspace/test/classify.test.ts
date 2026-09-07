/**
 * Which failure a caller is told about, decided against a scripted git.
 *
 * The point of injecting a `GitRunner` is here: every branch of the mapping
 * gets asserted without a repository, including the two that are awkward to
 * arrange for real — git missing from the machine, and `git worktree add`
 * refusing for a reason the pre-checks did not anticipate.
 */
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLocalWorktreeHost } from "../src/local.js";
import { WorkspaceError } from "../src/types.js";
import type { GitResult, GitRunner } from "../src/git.js";

const ok = (stdout = ""): GitResult => ({ exitCode: 0, stdout, stderr: "" });
const no = (stderr = ""): GitResult => ({ exitCode: 1, stdout: "", stderr });

/** A git that answers each subcommand from a table, and refuses anything absent. */
function scripted(answers: Record<string, GitResult>): GitRunner {
  return async (args) => answers[args[0] ?? ""] ?? no("unscripted");
}
/** The repository every test below starts from: real, with a commit, no branches. */
const healthy = {
  "rev-parse": ok("/repo\n"),
  "show-ref": no(),
  worktree: ok(),
};

async function failureOf(
  git: GitRunner,
  name = "demo",
): Promise<WorkspaceError> {
  const root = await mkdtemp(path.join(tmpdir(), "werk-classify-"));
  try {
    const host = createLocalWorktreeHost({ root, git });
    await host.create({ name, from: { kind: "local-checkout", path: root } });
    throw new Error("expected a failure");
  } catch (error) {
    expect(error).toBeInstanceOf(WorkspaceError);
    return error as WorkspaceError;
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

test("a name that is not a name never reaches git", async () => {
  let calls = 0;
  const counting: GitRunner = async (args) => {
    calls += 1;
    return scripted(healthy)(args, "");
  };
  expect((await failureOf(counting, "a/b")).code).toBe("INVALID_NAME");
  expect(calls).toBe(0);
});

test("a path outside a repository says so", async () => {
  const error = await failureOf(
    scripted({ ...healthy, "rev-parse": no("fatal: not a git repository") }),
  );
  expect(error.code).toBe("NOT_A_REPOSITORY");
});
test("a toplevel of nothing is not a repository either", async () => {
  // git can exit 0 having printed nothing; an empty answer is not a path.
  const error = await failureOf(
    scripted({ ...healthy, "rev-parse": ok("\n") }),
  );
  expect(error.code).toBe("NOT_A_REPOSITORY");
});

test("a repository with no commits is named as such", async () => {
  let call = 0;
  const git: GitRunner = async (args) => {
    if (args[0] !== "rev-parse") return scripted(healthy)(args, "");
    // The toplevel resolves; verifying HEAD is what fails.
    call += 1;
    return call === 1 ? ok("/repo\n") : no("fatal: Needed a single revision");
  };
  expect((await failureOf(git)).code).toBe("NO_COMMITS");
});

test("an existing branch is a conflict rather than a git failure", async () => {
  const error = await failureOf(scripted({ ...healthy, "show-ref": ok() }));
  expect(error.code).toBe("BRANCH_EXISTS");
  expect(error.message).toContain("demo");
});

test("git refusing the add carries what git said", async () => {
  const error = await failureOf(
    scripted({
      ...healthy,
      worktree: {
        exitCode: 128,
        stdout: "",
        stderr: "fatal: something unanticipated",
      },
    }),
  );
  expect(error.code).toBe("GIT_FAILED");
  expect(error.detail).toBe("fatal: something unanticipated");
});

test("no git on the machine is its own failure, not a refusal", async () => {
  const absent: GitRunner = async () => {
    throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
  };
  const error = await failureOf(absent);
  expect(error.code).toBe("GIT_MISSING");
  expect(error.message).toContain("git");
});
test("a spawn failure that is not a missing git is not swallowed", async () => {
  const broken: GitRunner = async () => {
    throw new Error("some other spawn problem");
  };
  const root = await mkdtemp(path.join(tmpdir(), "werk-classify-"));
  try {
    const host = createLocalWorktreeHost({ root, git: broken });
    await expect(
      host.create({
        name: "demo",
        from: { kind: "local-checkout", path: root },
      }),
    ).rejects.toThrow("some other spawn problem");
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

test("the host says which kind of place it makes workspaces in", () => {
  expect(createLocalWorktreeHost({ root: "/tmp/x" }).kind).toBe(
    "local-worktree",
  );
});
