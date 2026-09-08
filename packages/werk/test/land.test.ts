/**
 * `werk land`, end to end.
 *
 * The gesture the command exists for is: make a workspace, commit in it, stand
 * in the repository and land it. So that is what these run — through the real
 * CLI, against a real repository, with a real daemon behind `create` — because
 * the parts that are easy to get wrong are the joins. Which branch the record
 * says the workspace came from is written by one command and read by another;
 * whether the change ends up on the branch is git's answer and not werk's.
 *
 * The agent and the editor are answered by scripts written into the sandbox.
 * `GIT_EDITOR` is what git itself consults, so `git var GIT_EDITOR` finds it
 * and the path werk takes is the real one rather than a stubbed one.
 *
 * The sandbox's config file says `agent = ""` from the start, because that is
 * how somebody says "ask nobody" — an empty `WERK_AGENT` is an unset variable
 * by the environment layer's own rule, which is not the same thing, and on a
 * terminal it would leave werk asking which agent to use. The one test about
 * that question sets its own config directory so it can be asked.
 */
import { afterAll, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  ptyAvailable,
  runWerk,
  sandbox,
  settle,
  spawnWerk,
} from "./support/run.js";

const run = promisify(execFile);
const TIMEOUT = 30_000;
/**
 * A command that starts and stops. `/bin/true` is not on macOS and is nowhere
 * on Windows, so the process running the suite is used instead: it is the one
 * executable every platform is guaranteed to have.
 */
const EXITS_AT_ONCE = [process.execPath, "-e", ""];
/**
 * What a test that needs to be asked something removes from the environment.
 *
 * `CI` forbids prompting whatever the terminal is, which is the whole point of
 * it — a runner reports a TTY often enough that a prompt there hangs the job.
 * These two are about what werk does when there is somebody to ask, so they say
 * there is.
 */
const INTERACTIVE = { CI: undefined } as const;

/**
 * Whether `script` gives a child a terminal on the arguments `spawnWerk` uses.
 *
 * util-linux takes `script -qec "<cmd>" /dev/null` and BSD, which is what macOS
 * has, takes different ones. The three tests below that need werk to believe
 * there is somebody at a terminal — an editor to open, a question to ask — skip
 * where that invocation does not work, rather than the platforms being named.
 */
const PTY = await ptyAvailable();

const box = await sandbox("wkl");
afterAll(box.dispose);
await writeFile(join(box.configDir, "config.toml"), 'agent = ""\n');

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
  // The landing's commit is made by werk, not by the helper above, so the
  // identity has to be in the repository rather than passed per command. A CI
  // runner has none configured and git refuses without one.
  await git(directory, "config", "user.name", "werk test");
  await git(directory, "config", "user.email", "test@example.invalid");
  await writeFile(join(directory, "README.md"), "committed\n");
  await git(directory, "add", "README.md");
  await git(directory, "commit", "-q", "-m", "init");
  return directory;
}

/**
 * A workspace made the way a person makes one, and a commit in it.
 *
 * The command is one that exits at once, because the session is not what is
 * being tested: the workspace and the record `create` writes beside it are, and
 * those are made before the daemon is asked for anything.
 */
async function workspace(
  repo: string,
  name: string,
  files: Readonly<Record<string, string>> = { "change.txt": "change\n" },
  subject = "change",
): Promise<string> {
  const created = await runWerk({
    sandbox: box,
    cwd: repo,
    args: ["--json", "create", "--workspace", name, "--", ...EXITS_AT_ONCE],
    timeoutMs: TIMEOUT,
  });
  expect(created.code).toBe(0);
  const record: { workspace: { directory: string; parent: string | null } } =
    JSON.parse(created.stdout);
  const directory = record.workspace.directory;
  for (const [file, body] of Object.entries(files))
    await writeFile(join(directory, file), body);
  await git(directory, "add", "-A");
  await git(directory, "commit", "-q", "-m", subject);
  return directory;
}

const subjectOf = async (repo: string) =>
  (await git(repo, "log", "-1", "--format=%s")).stdout.trim();
const bodyOf = async (repo: string) =>
  (await git(repo, "log", "-1", "--format=%B")).stdout.trim();
const branchOf = async (repo: string) =>
  (await git(repo, "rev-parse", "--abbrev-ref", "HEAD")).stdout.trim();

/**
 * A pty's output with the escapes, the box drawing and the wrapping taken out.
 *
 * `script` gives the child a terminal barely any columns wide, so clack wraps
 * its question one character to a line and puts its left border between every
 * pair of them — which also splits some escape sequences in half. So the
 * escapes are stripped, then the border, and then the escapes again, which is
 * what the halves become once the border between them is gone.
 */
const ANSI =
  /\u001b\[[0-9;?]*[a-zA-Z]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const bare = (text: string) =>
  text
    .replaceAll(ANSI, "")
    .replaceAll(/[\u2500-\u25ff\u2190-\u21ff\s]/g, "")
    .replaceAll(ANSI, "");

/** A script in the sandbox, so a test can answer an agent or an editor. */
async function tool(name: string, body: string): Promise<string> {
  const file = join(box.root, name);
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, 0o755);
  return file;
}

test(
  "create writes down which branch the workspace came from",
  async () => {
    const repo = await repository();
    const created = await runWerk({
      sandbox: box,
      cwd: repo,
      args: [
        "--json",
        "create",
        "--workspace",
        "recorded",
        "--",
        ...EXITS_AT_ONCE,
      ],
      timeoutMs: TIMEOUT,
    });
    expect(created.code).toBe(0);
    const record = JSON.parse(created.stdout) as {
      workspace: { parent: string | null; base: string };
    };
    expect(record.workspace.parent).toBe("main");
    expect(record.workspace.base).toHaveLength(40);
    // And on the disk, where `land` reads it from rather than from stdout.
    const slots = await readdir(join(box.stateDir, "workspaces"));
    const written = slots.flatMap((slot) => [join("workspaces", slot)]);
    expect(written.length).toBeGreaterThan(0);
  },
  TIMEOUT,
);

test(
  "the whole loop: create, commit, land",
  async () => {
    const repo = await repository();
    await workspace(repo, "my-thing");
    const landed = await runWerk({
      sandbox: box,
      cwd: repo,
      args: ["--json", "land", "my-thing"],
      timeoutMs: TIMEOUT,
    });
    expect(landed.code).toBe(0);
    const result = JSON.parse(landed.stdout) as {
      onto: string;
      squashed: number;
      files: number;
      landed: boolean;
    };
    expect(result).toMatchObject({
      onto: "main",
      squashed: 1,
      files: 1,
      landed: true,
    });
    expect(await subjectOf(repo)).toBe("change");
    expect(await Bun.file(join(repo, "change.txt")).text()).toBe("change\n");
  },
  TIMEOUT,
);

test(
  "landing onto a branch the workspace did not come from asks first",
  async () => {
    const repo = await repository();
    await workspace(repo, "from-main");
    await git(repo, "checkout", "-q", "-b", "other");

    const refused = await runWerk({
      sandbox: box,
      cwd: repo,
      args: ["land", "from-main"],
      timeoutMs: TIMEOUT,
    });
    expect(refused.code).toBe(2);
    // The sentence names both branches, which is the whole of the warning.
    expect(refused.stderr).toContain("was made from main");
    expect(refused.stderr).toContain("onto other");
    // And nothing happened.
    expect(await subjectOf(repo)).toBe("init");

    const agreed = await runWerk({
      sandbox: box,
      cwd: repo,
      args: ["--yes", "land", "from-main"],
      timeoutMs: TIMEOUT,
    });
    expect(agreed.code).toBe(0);
    expect(await branchOf(repo)).toBe("other");
    expect(await subjectOf(repo)).toBe("change");
  },
  TIMEOUT,
);

test(
  "a dry run says what would land and changes nothing",
  async () => {
    const repo = await repository();
    await workspace(repo, "looked-at");
    const seen = await runWerk({
      sandbox: box,
      cwd: repo,
      args: ["--json", "land", "looked-at", "--dry-run"],
      timeoutMs: TIMEOUT,
    });
    expect(seen.code).toBe(0);
    expect(JSON.parse(seen.stdout)).toMatchObject({
      workspace: "looked-at",
      onto: "main",
      parent: "main",
      ontoIsParent: true,
      files: ["change.txt"],
      landed: false,
    });
    expect(await subjectOf(repo)).toBe("init");
  },
  TIMEOUT,
);

test(
  "--message skips the agent and the editor",
  async () => {
    const repo = await repository();
    await workspace(repo, "my-words");
    const landed = await runWerk({
      sandbox: box,
      cwd: repo,
      args: ["land", "my-words", "-m", "a message I typed"],
      // An agent and an editor that would both fail the test if they ran.
      env: {
        WERK_AGENT: await tool("never-agent", "exit 3"),
        GIT_EDITOR: await tool("never-editor", "exit 3"),
      },
      timeoutMs: TIMEOUT,
    });
    expect(landed.code).toBe(0);
    expect(await subjectOf(repo)).toBe("a message I typed");
  },
  TIMEOUT,
);

test(
  "the configured agent writes the commit message",
  async () => {
    const repo = await repository();
    await workspace(repo, "agent-wrote");
    const landed = await runWerk({
      sandbox: box,
      cwd: repo,
      args: ["land", "agent-wrote"],
      env: {
        WERK_AGENT: await tool(
          "message-agent",
          'cat > /dev/null\necho "the agent wrote this"',
        ),
      },
      timeoutMs: TIMEOUT,
    });
    expect(landed.code).toBe(0);
    expect(await subjectOf(repo)).toBe("the agent wrote this");
  },
  TIMEOUT,
);

test(
  "an agent that is not installed falls back to the commits",
  async () => {
    const repo = await repository();
    await workspace(repo, "no-agent-here", { "a.txt": "a\n" }, "did a thing");
    const landed = await runWerk({
      sandbox: box,
      cwd: repo,
      args: ["land", "no-agent-here"],
      env: { WERK_AGENT: "definitely-not-installed-anywhere" },
      timeoutMs: TIMEOUT,
    });
    expect(landed.code).toBe(0);
    expect(landed.stderr).toContain("not installed");
    expect(await subjectOf(repo)).toBe("did a thing");
  },
  TIMEOUT,
);

test(
  "the agent resolves a conflict, and the landing goes through",
  async () => {
    const repo = await repository();
    await workspace(
      repo,
      "clash",
      { "README.md": "from the workspace\n" },
      "workspace edit",
    );
    await writeFile(join(repo, "README.md"), "from main\n");
    await git(repo, "commit", "-qam", "main edit");

    const resolver = await tool(
      "resolving-agent",
      [
        "prompt=$(cat)",
        'case "$prompt" in',
        "  *'conflict markers'*)",
        "    for f in $(git diff --name-only --diff-filter=U); do",
        `      printf 'resolved\\n' > "$f"`,
        '      git add "$f"',
        "    done",
        "    ;;",
        "  *) echo 'a resolved landing' ;;",
        "esac",
      ].join("\n"),
    );
    const landed = await runWerk({
      sandbox: box,
      cwd: repo,
      args: ["land", "clash"],
      env: { WERK_AGENT: resolver },
      timeoutMs: TIMEOUT,
    });
    expect(landed.code).toBe(0);
    expect(await subjectOf(repo)).toBe("a resolved landing");
    expect(await Bun.file(join(repo, "README.md")).text()).toBe("resolved\n");
  },
  TIMEOUT,
);

test(
  "a conflict with no agent leaves the checkout alone and says where the copy is",
  async () => {
    const repo = await repository();
    await workspace(
      repo,
      "unresolvable",
      { "README.md": "from the workspace\n" },
      "workspace edit",
    );
    await writeFile(join(repo, "README.md"), "from main\n");
    await git(repo, "commit", "-qam", "main edit");

    const failed = await runWerk({
      sandbox: box,
      cwd: repo,
      args: ["land", "unresolvable"],
      timeoutMs: TIMEOUT,
    });
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain("does not apply cleanly");
    expect(failed.stderr).toContain("landings");
    // The checkout is untouched: no merge in progress, no moved branch.
    expect(await subjectOf(repo)).toBe("main edit");
    expect(await Bun.file(join(repo, "README.md")).text()).toBe("from main\n");
  },
  TIMEOUT,
);

test(
  "the editor gets the drafted message, and what it leaves is used",
  async () => {
    if (!PTY) return;
    const repo = await repository();
    await workspace(repo, "edited", { "e.txt": "e\n" }, "drafted subject");
    const landed = await runWerk({
      sandbox: box,
      cwd: repo,
      args: ["land", "edited"],
      env: {
        ...INTERACTIVE,
        GIT_EDITOR: await tool(
          "seeing-editor",
          [
            // Prove the draft reached the buffer, then replace it.
            'grep -q "drafted subject" "$1" || exit 9',
            `printf 'what the editor left\\n\\n# and a comment\\n' > "$1"`,
          ].join("\n"),
        ),
      },
      // A pty, because werk does not open an editor where there is no terminal.
      pty: true,
      timeoutMs: TIMEOUT,
    });
    expect(landed.code).toBe(0);
    expect(await bodyOf(repo)).toBe("what the editor left");
  },
  TIMEOUT,
);

test(
  "--no-edit keeps the draft without opening anything",
  async () => {
    if (!PTY) return;
    const repo = await repository();
    await workspace(repo, "unedited", { "u.txt": "u\n" }, "kept as drafted");
    const landed = await runWerk({
      sandbox: box,
      cwd: repo,
      args: ["land", "unedited", "--no-edit"],
      env: {
        ...INTERACTIVE,
        GIT_EDITOR: await tool("forbidden-editor", "exit 3"),
      },
      pty: true,
      timeoutMs: TIMEOUT,
    });
    expect(landed.code).toBe(0);
    expect(await subjectOf(repo)).toBe("kept as drafted");
  },
  TIMEOUT,
);

test(
  "the workspace and its branch are still there afterwards",
  async () => {
    const repo = await repository();
    const directory = await workspace(repo, "survivor");
    const landed = await runWerk({
      sandbox: box,
      cwd: repo,
      args: ["land", "survivor"],
      timeoutMs: TIMEOUT,
    });
    expect(landed.code).toBe(0);
    expect(landed.stderr + landed.stdout).toContain("still there");
    expect(
      (await git(repo, "show-ref", "--verify", "refs/heads/survivor")).stdout,
    ).toContain("survivor");
    expect(await Bun.file(join(directory, "change.txt")).exists()).toBe(true);
  },
  TIMEOUT,
);

test(
  "a name werk has no record of is refused, with the status a missing thing gets",
  async () => {
    const repo = await repository();
    const failed = await runWerk({
      sandbox: box,
      cwd: repo,
      args: ["land", "never-made"],
      timeoutMs: TIMEOUT,
    });
    expect(failed.code).toBe(3);
    expect(failed.stderr).toContain("no record of a workspace called");
  },
  TIMEOUT,
);

test(
  "landing outside a repository is a usage mistake",
  async () => {
    const failed = await runWerk({
      sandbox: box,
      args: ["land", "anything"],
      timeoutMs: TIMEOUT,
    });
    expect(failed.code).toBe(2);
    expect(failed.stderr).toContain("not inside a git repository");
  },
  TIMEOUT,
);

test(
  "a route werk cannot take is refused rather than falling back to the one it can",
  async () => {
    const repo = await repository();
    await workspace(repo, "reviewed");
    const failed = await runWerk({
      sandbox: box,
      cwd: repo,
      args: ["land", "reviewed"],
      env: { WERK_LAND_ROUTE: "pull-request" },
      timeoutMs: TIMEOUT,
    });
    expect(failed.code).toBe(2);
    expect(failed.stderr).toContain("pull-request");
    expect(await subjectOf(repo)).toBe("init");
  },
  TIMEOUT,
);

test(
  "a tracked change in the checkout stops the landing before anything is made",
  async () => {
    const repo = await repository();
    await workspace(repo, "blocked");
    await writeFile(join(repo, "README.md"), "edited and not committed\n");
    const failed = await runWerk({
      sandbox: box,
      cwd: repo,
      args: ["land", "blocked"],
      timeoutMs: TIMEOUT,
    });
    expect(failed.code).toBe(5);
    expect(failed.stderr).toContain("uncommitted changes");
    expect(await subjectOf(repo)).toBe("init");
  },
  TIMEOUT,
);

test(
  "uncommitted work in the workspace is named, and only committed work lands",
  async () => {
    const repo = await repository();
    const directory = await workspace(repo, "half-done");
    await writeFile(join(directory, "not-yet.txt"), "later\n");
    const landed = await runWerk({
      sandbox: box,
      cwd: repo,
      // The confirmation has no terminal to be asked in, so --yes answers it.
      args: ["--yes", "land", "half-done"],
      timeoutMs: TIMEOUT,
    });
    expect(landed.code).toBe(0);
    expect(await Bun.file(join(repo, "not-yet.txt")).exists()).toBe(false);
    expect(await Bun.file(join(repo, "change.txt")).exists()).toBe(true);
  },
  TIMEOUT,
);

test(
  "with nobody having chosen an agent, a terminal is asked once and the answer is kept",
  async () => {
    if (!PTY) return;
    const repo = await repository();
    await workspace(repo, "asked", { "q.txt": "q\n" }, "asked about an agent");
    // Its own config directory, so the file starts with nothing said about an
    // agent. An empty `WERK_AGENT` would not do it: the environment layer reads
    // an empty variable as unset, which is the state that makes werk ask.
    const configDir = await mkdtemp(join(box.root, "cfg-"));

    const child = spawnWerk({
      sandbox: box,
      cwd: repo,
      args: ["land", "asked", "--no-edit"],
      env: { ...INTERACTIVE, WERK_CONFIG_DIR: configDir },
      stdin: "pipe",
      pty: true,
    });
    // Down twice and Enter picks the last row, which is "none". The waits are
    // for the prompt to paint: clack reads keys, not a script.
    const keys = child.stdin as { write(text: string): void };
    await Bun.sleep(1500);
    keys.write("\u001b[B\u001b[B");
    await Bun.sleep(500);
    keys.write("\r");
    const landed = await settle(child, TIMEOUT);

    expect(landed.code).toBe(0);
    // `script` gives the child a terminal of almost no width, so clack wraps
    // the question one character to a line. What is asserted is that it was
    // asked at all, so the escape codes and the wrapping come out first.
    expect(bare(landed.stdout)).toContain("Whichagentshouldwerkask");
    expect(await Bun.file(join(configDir, "config.toml")).text()).toContain(
      'agent = ""',
    );
    expect(await subjectOf(repo)).toBe("asked about an agent");
  },
  TIMEOUT,
);

test(
  "--host is refused, because landing does not act on another machine",
  async () => {
    const repo = await repository();
    await workspace(repo, "not-over-there");
    const failed = await runWerk({
      sandbox: box,
      cwd: repo,
      args: ["--host", "beast", "land", "not-over-there"],
      timeoutMs: TIMEOUT,
    });
    expect(failed.code).toBe(2);
    expect(failed.stderr).toContain("does not act on beast");
    expect(await subjectOf(repo)).toBe("init");
  },
  TIMEOUT,
);
