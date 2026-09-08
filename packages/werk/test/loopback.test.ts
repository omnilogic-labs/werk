/**
 * Reaching a machine, with the machine being this one.
 *
 * `packages/workspace/test/ssh.test.ts` settles the failure table, the argv of
 * every git call and the shape of the scripts against a scripted runner, and
 * `scripts/remote-smoke.ts` walks the whole thing against a real box that most
 * people and no CI lane have. Nothing in between ran the scripts. So the seams
 * are answered here by `test/support/loopback.ts`: the remote runner is `sh -c`
 * in a temporary `$HOME`, the push URL is a filesystem path, and the forward is
 * a relay onto a daemon socket on this machine.
 *
 * What that buys is that `git init --bare`, the exits 90, 91 and 92, `worktree
 * add --lock`, the rollback and the push all actually run, and that a mirror
 * pushed to twice is measured rather than asserted. No network and no ssh are
 * involved, which is also the limit: ssh's connection, its failures, the argv
 * werk builds for it and the forward it opens are not touched by any of this.
 *
 * git is required, and the repositories are made with `user.name`, `user.email`
 * and `commit.gpgsign` given on the command line, so a reader's signing
 * configuration cannot fail the suite.
 */
import { afterAll, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { connectSessionClient } from "@werk/session";
import { openLocalTransport } from "@werk/session-daemon";
import {
  createSshWorkspaceMaker,
  formatWorkspaceReference,
  WorkspaceError,
  workspaceReference,
  type Workspace,
  type WorkspaceProgress,
} from "@werk/workspace";
import { probeHost } from "../src/host/probe.js";
import {
  forwardLocalDaemon,
  loopbackMachine,
  type LoopbackMachine,
  type LoopbackOptions,
} from "./support/loopback.js";
import { runWerk, sandbox } from "./support/run.js";

const TIMEOUT = 30_000;
const run = promisify(execFile);
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

const box = await sandbox("wkl");
const machines: LoopbackMachine[] = [];
afterAll(async () => {
  for (const one of machines.splice(0)) await one.dispose();
  await box.dispose();
});

async function machine(
  options: LoopbackOptions = {},
): Promise<LoopbackMachine> {
  const made = await loopbackMachine(options);
  machines.push(made);
  return made;
}

/**
 * A repository with a commit and a repository identity of its own.
 *
 * The identity is written rather than left to the maker so that the layout the
 * maker will choose is known before it runs, which is what lets a case put
 * something in the way of a directory that does not exist yet. The digest is
 * spelled out here the way `packages/workspace/test/ssh.test.ts` spells it.
 */
let identities = 0;
async function repository(): Promise<{
  path: string;
  identity: string;
  slot: string;
}> {
  const path = await mkdtemp(join(box.root, "repo-"));
  await git(path, "init", "-q", "-b", "main", ".");
  await writeFile(join(path, "README.md"), "committed\n");
  await git(path, "add", "README.md");
  await git(path, "commit", "-q", "-m", "init");
  const identity = `11111111-2222-3333-4444-${String(identities++).padStart(12, "0")}`;
  await git(path, "config", "--local", "werk.repo-id", identity);
  const digest = createHash("sha256")
    .update(identity)
    .digest("hex")
    .slice(0, 8);
  return { path, identity, slot: `${basename(path)}-${digest}` };
}

function makerFor(
  host: LoopbackMachine,
  onProgress?: (event: WorkspaceProgress) => void,
) {
  const maker = createSshWorkspaceMaker({
    host: host.host,
    root: host.root,
    remote: (script, options) => host.remote(script, options),
    pushUrl: (repositoryPath) => host.pushUrl(repositoryPath),
  });
  return (name: string, from: string): Promise<Workspace> =>
    maker.create(
      { name, from: { kind: "local-checkout", path: from } },
      onProgress === undefined ? undefined : { onProgress },
    );
}

const mirrorOf = (host: LoopbackMachine, slot: string) =>
  join(host.root, "repos", `${slot}.git`);

/** Loose and packed objects, which is what a push either adds to or does not. */
async function objects(bare: string): Promise<string> {
  const counted = (await git(bare, "count-objects", "-v")).stdout;
  return counted
    .split("\n")
    .filter((line) => line.startsWith("count:") || line.startsWith("in-pack:"))
    .join(" ");
}

/** The `WorkspaceError` a creation refused with, rather than any old rejection. */
async function refusal(promise: Promise<unknown>): Promise<WorkspaceError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(WorkspaceError);
    return error as WorkspaceError;
  }
  throw new Error("the creation succeeded when it was expected to fail");
}

test(
  "a mirror, a push and a locked worktree, all of them real",
  async () => {
    const host = await machine();
    const source = await repository();
    const events: WorkspaceProgress[] = [];
    const workspace = await makerFor(host, (event) => events.push(event))(
      "demo",
      source.path,
    );

    // The reference werk would write down for it, at the level that names the
    // machine. Nothing else in the suite has ever had a host to render.
    expect(workspace.host).toBe(host.host);
    expect(workspace.branch).toBe("demo");
    expect(
      formatWorkspaceReference(workspaceReference(workspace), "full"),
    ).toBe(`demo@${host.host}:${workspace.directory}`);
    expect(workspace.directory).toBe(join(host.root, source.slot, "demo"));

    // The mirror is bare, which is what keeps werk out of the machine's
    // configuration, and it holds the branch that was pushed.
    const bare = mirrorOf(host, source.slot);
    expect(
      (await git(bare, "rev-parse", "--is-bare-repository")).stdout.trim(),
    ).toBe("true");
    expect(
      (await git(bare, "show-ref", "--verify", "refs/heads/demo")).stdout,
    ).toContain("refs/heads/demo");

    // The worktree is a linked one hanging off that mirror, on that branch,
    // locked, with the committed file in it.
    expect(await readFile(join(workspace.directory, ".git"), "utf8")).toContain(
      join(bare, "worktrees"),
    );
    expect(await readFile(join(workspace.directory, "README.md"), "utf8")).toBe(
      "committed\n",
    );
    const listed = (await git(bare, "worktree", "list", "--porcelain")).stdout;
    expect(listed).toContain("branch refs/heads/demo");
    expect(listed).toContain("locked");

    // The stages a caller can paint, in the order they happen. A maker that
    // assumes a reachable machine with git on it emits nothing for reaching it,
    // installing werk or starting a daemon.
    expect(events.map((event) => `${event.step} ${event.state}`)).toEqual([
      "resolve-source begin",
      "resolve-source end",
      "prepare-repository begin",
      "prepare-repository end",
      "transfer begin",
      "transfer end",
      "check-out begin",
      "check-out end",
    ]);
  },
  TIMEOUT,
);

test(
  "a second workspace shares the mirror and ships nothing again",
  async () => {
    const host = await machine();
    const source = await repository();
    const create = makerFor(host);
    const one = await create("one", source.path);
    const bare = mirrorOf(host, source.slot);
    const before = await objects(bare);

    const two = await create("two", source.path);
    expect(two.directory).not.toBe(one.directory);
    // One mirror for the repository, not one per workspace.
    expect(await readdir(join(host.root, "repos"))).toEqual([
      `${source.slot}.git`,
    ]);
    // The first branch is still there, so the mirror was reused rather than
    // made again.
    for (const name of ["one", "two"])
      expect(
        (await git(bare, "show-ref", "--verify", `refs/heads/${name}`)).stdout,
      ).toContain(`refs/heads/${name}`);
    // And the second push negotiated: the far end already had every object, so
    // nothing travelled twice. This is the whole argument for a push against a
    // persistent mirror rather than a bundle, and it is the one claim a
    // scripted git cannot make.
    expect(await objects(bare)).toBe(before);
  },
  TIMEOUT,
);

test(
  "the repository names itself once and reuses the name after",
  async () => {
    const host = await machine();
    // Not `repository()`, because the point is the identity the maker writes.
    const path = await mkdtemp(join(box.root, "unnamed-"));
    await git(path, "init", "-q", "-b", "main", ".");
    await git(path, "commit", "-q", "--allow-empty", "-m", "init");
    const read = () =>
      git(path, "config", "--local", "--get", "werk.repo-id").then(
        (result) => result.stdout.trim(),
        () => undefined,
      );
    expect(await read()).toBeUndefined();

    const create = makerFor(host);
    const one = await create("one", path);
    const identity = await read();
    expect(identity).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    const two = await create("two", path);
    // Read back rather than written again, so both workspaces land in the one
    // directory the repository is entitled to.
    expect(await read()).toBe(identity);
    expect(join(two.directory, "..")).toBe(join(one.directory, ".."));
    expect(await readdir(join(host.root, "repos"))).toHaveLength(1);
  },
  TIMEOUT,
);

test(
  "no git on the machine is its own refusal, decided by the exit and not the wording",
  async () => {
    const host = await machine({ withoutGit: true });
    const source = await repository();
    const error = await refusal(makerFor(host)("demo", source.path));
    expect(error.code).toBe("REMOTE_GIT_MISSING");
    expect(error.message).toContain(host.host);
    // Nothing was made, because the script exits before it creates anything.
    await expect(readdir(host.root)).rejects.toThrow();
  },
  TIMEOUT,
);

test(
  "a directory in the way and a branch already there are told apart",
  async () => {
    const host = await machine();
    const source = await repository();
    const create = makerFor(host);

    // 91: the directory the worktree would go in is there and is not empty.
    const occupied = join(host.root, source.slot, "occupied");
    await mkdir(occupied, { recursive: true });
    await writeFile(join(occupied, "someone-elses-file"), "mine\n");
    const inTheWay = await refusal(create("occupied", source.path));
    expect(inTheWay.code).toBe("DIRECTORY_EXISTS");
    expect(inTheWay.message).toContain(`${host.host}:${occupied}`);
    // Refused, not emptied.
    expect(await readdir(occupied)).toEqual(["someone-elses-file"]);

    // 92: the branch is in the mirror while the directory is not there, which
    // is the order the script checks them in. Pushed straight into the mirror,
    // because a workspace that made the branch would have made the directory
    // with it and the first check would answer instead.
    const bare = mirrorOf(host, source.slot);
    await create("first", source.path);
    await git(source.path, "push", "--quiet", bare, "HEAD:refs/heads/taken");
    const clash = await refusal(create("taken", source.path));
    expect(clash.code).toBe("BRANCH_EXISTS");
    expect(clash.message).toContain(bare);
  },
  TIMEOUT,
);

test(
  "a history that did not get there is a transfer failure carrying what git said",
  async () => {
    const host = await machine({ brokenPush: true });
    const source = await repository();
    const error = await refusal(makerFor(host)("demo", source.path));
    expect(error.code).toBe("TRANSFER_FAILED");
    expect(error.detail).toContain("does not appear to be a git repository");
    // The mirror was prepared before the push, and a failed push is not a
    // reason to take it away again.
    const bare = mirrorOf(host, source.slot);
    expect(
      (await git(bare, "rev-parse", "--is-bare-repository")).stdout.trim(),
    ).toBe("true");
  },
  TIMEOUT,
);

test(
  "a check-out that failed is undone, and the mirror is left for its siblings",
  async () => {
    const host = await machine();
    const source = await repository();
    // A plain file where the worktree wants to be. It is not a directory, so
    // the preparation script lets it through, and `git worktree add` refuses.
    await mkdir(join(host.root, source.slot), { recursive: true });
    await writeFile(join(host.root, source.slot, "demo"), "in the way\n");

    const error = await refusal(makerFor(host)("demo", source.path));
    expect(error.code).toBe("GIT_FAILED");
    expect(error.message).toContain("worktree add failed");
    // Said out loud, because leaving something behind on somebody's machine is
    // not something to do silently.
    expect(error.message).toContain("is left in place");

    const bare = mirrorOf(host, source.slot);
    // The branch the push created is gone.
    await expect(
      git(bare, "show-ref", "--verify", "refs/heads/demo"),
    ).rejects.toThrow();
    // Nothing is registered as a worktree of the mirror.
    const listed = (await git(bare, "worktree", "list", "--porcelain")).stdout;
    expect(listed).not.toContain("branch refs/heads/demo");
    // And the mirror itself, with the objects that got there, survives: every
    // workspace of this repository shares it.
    expect(
      (await git(bare, "rev-parse", "--is-bare-repository")).stdout.trim(),
    ).toBe("true");
    expect(await objects(bare)).not.toBe("count: 0 in-pack: 0");
  },
  TIMEOUT,
);

test(
  "the machine answers about itself when it is asked",
  async () => {
    const host = await machine();
    const report = await probeHost(host.probe);
    expect(report.reachable).toBe("yes");
    const state = (name: string) =>
      report.checks.find((check) => check.name === name)?.state;
    expect(state("git")).toBe("yes");
    expect(state("system")).toBe("yes");
    // The rule werk applies locally, spelled for that machine's own shell, so
    // the answer is that machine's `$HOME` and not this process's.
    expect(report.workspaceRoot).toBe(
      join(host.home, ".local", "state", "werk", "workspaces"),
    );
    // A probe never creates anything, so the root it names is not there yet.
    expect(report.workspaceRootExists).toBe(false);
    expect(report.workspaceRootUsable).toBe(true);
    expect(report.notes.join(" ")).toContain("werk will create it");
  },
  TIMEOUT,
);

test(
  "a session is created and read back through the forwarded socket",
  async () => {
    // The daemon half. A real werk daemon, started the way a client starts one
    // on a machine it has reached, and reached back through a socket where a
    // forward would have put it.
    const far = await sandbox("wkld");
    const near = await sandbox("wkln");
    try {
      const started = await runWerk({
        sandbox: far,
        args: ["--json", "daemon", "endpoint", "--ensure"],
        timeoutMs: TIMEOUT,
      });
      expect(started.code, started.stderr).toBe(0);
      const report = JSON.parse(started.stdout) as {
        endpoint: { kind: string; path?: string };
      };
      // Windows reports loopback TCP with a credential, and forwarding that is
      // a different mechanism that nothing has needed yet.
      expect(report.endpoint.kind).toBe("unix");

      const forward = await forwardLocalDaemon({
        host: "loop",
        runtimeDir: near.runtimeDir,
        remoteSocket: report.endpoint.path!,
      });
      try {
        // Both of these refuse a directory that is not 0700 and a socket that
        // is not private to its owner, so getting this far is itself the
        // assertion that the relay was put somewhere werk would accept.
        const client = await connectSessionClient({
          transport: await openLocalTransport(forward.endpoint),
        });
        try {
          const info = await client.create({
            argv: [process.execPath, "-e", "setTimeout(() => {}, 60000)"],
            cwd: near.root,
            size: { cols: 80, rows: 24 },
            name: "through-the-forward",
          });
          const read = await client.get(info.id);
          expect(read.id).toBe(info.id);
          expect(read.name).toBe("through-the-forward");
          expect(read.state).toBe("running");
          expect((await client.list()).map((one) => one.id)).toContain(info.id);
          await client.terminate(info.id, "force");
        } finally {
          await client.close();
        }
      } finally {
        await forward.close();
      }
    } finally {
      await near.dispose();
      await far.dispose();
    }
  },
  TIMEOUT,
);
