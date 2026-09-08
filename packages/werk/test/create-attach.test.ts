/**
 * `create` attaching, end to end, with no terminal anywhere.
 *
 * A pipe is the half of the behaviour a test can hold: the attachment degrades
 * to writing the screen and then the live bytes to stdout, which is exactly
 * what makes the stream assertions below possible. What a terminal does with
 * the alternate screen, the raw keyboard and the chrome row is not asserted
 * here and has to be walked in a pty.
 *
 * Its runtime and state directories are its own, so it does not fight the
 * daemons the other end-to-end tests run in the same `bun test` invocation.
 * They live under a short `/tmp` path because a Unix socket path is capped at
 * 103 bytes and a deeply nested one fails to bind.
 */
import { afterAll, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const MAIN = join(import.meta.dir, "../src/main.ts");
const TIMEOUT = 30000;

const home = await mkdtemp("/tmp/wka-");
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
/**
 * Standard input is a pipe nothing is ever written to, and it is held open.
 * `/dev/null` would not do: an attachment stops when its input ends, so a
 * closed stdin detaches on the first tick and the run would be measuring the
 * race rather than the behaviour. Held open, the attachment ends when the
 * session does, which is the thing each case below arranges.
 */
async function werk(cwd: string, ...args: string[]): Promise<Ran> {
  return werkWith(cwd, {}, ...args);
}
/** The same, with settings supplied through the environment layer. */
async function werkWith(
  cwd: string,
  env: Record<string, string>,
  ...args: string[]
): Promise<Ran> {
  const child = Bun.spawn(
    [
      process.execPath,
      MAIN,
      "--runtime-dir",
      runtimeDir,
      "--state-dir",
      stateDir,
      ...args,
    ],
    {
      cwd,
      env: { ...process.env, ...env },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  const code = await child.exited;
  child.stdin.end();
  return { code, stdout, stderr };
}

test(
  "create attaches, so stdout carries the session and stderr carries werk",
  async () => {
    const source = await repository();
    const ran = await werk(
      source,
      "create",
      "--name",
      "attached",
      "--",
      "sh",
      "-c",
      "printf HELLOWERK",
    );
    expect(ran.code, ran.stderr).toBe(0);

    // The screen the session drew, on stdout, as bytes. Nothing of werk's own
    // is mixed into it: a caller piping this is capturing the session.
    expect(ran.stdout).toContain("HELLOWERK");
    expect(ran.stdout).not.toContain("created ");
    expect(ran.stdout).not.toContain("workspace ");

    // The summary is status, so it is on stderr, and it does not tell somebody
    // who is already attached how to attach.
    expect(ran.stderr).toContain("created ");
    // The one notation: the name, then the directory it is in. This is the
    // whole reference as a real run produces it, not a restatement of it.
    const reference =
      /workspace (attached-[0-9a-f]{8}):(\S+) on branch (attached-[0-9a-f]{8})\n(.*)\n/.exec(
        ran.stderr,
      );
    expect(reference, ran.stderr).not.toBeNull();
    const [, name, directory, branch, sizeLine] = reference!;
    expect(branch).toBe(name);
    // The reference's path is the workspace, so it ends in the workspace name.
    expect(
      directory!.endsWith(`/${name}`) || directory!.endsWith(`\\${name}`),
    ).toBe(true);
    // The size line reports the grid and does not spell the directory out a
    // second time in a second shape.
    expect(sizeLine).toContain("80x24");
    expect(sizeLine).not.toContain(directory!);
    expect(ran.stderr).not.toContain("werk attach ");
  },
  TIMEOUT,
);

test(
  "the session's own status is reported, and is not werk's",
  async () => {
    const source = await repository();
    const ran = await werk(source, "create", "--", "sh", "-c", "exit 3");
    // 3 is `NOT_FOUND` in werk's own vocabulary, so adopting the child's status
    // would make "the command failed" and "no such session" the same answer.
    expect(ran.code).toBe(0);
    expect(ran.stderr).toContain("has ended with status 3");
  },
  TIMEOUT,
);

test(
  "--detach starts the session and returns to the caller",
  async () => {
    const source = await repository();
    const ran = await werk(source, "create", "--detach", "--", "sleep", "30");
    expect(ran.code, ran.stderr).toBe(0);

    const lines = ran.stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("created ");
    expect(lines[3]).toMatch(/^werk attach \S+$/);
    expect(ran.stderr).not.toContain("created ");

    // It is still there afterwards, which is the whole point of not attaching.
    const id = lines[3]!.split(" ")[2]!;
    const listed = await werk(source, "--json", "list");
    expect(listed.code, listed.stderr).toBe(0);
    const sessions = JSON.parse(listed.stdout.trim()) as { id: string }[];
    expect(sessions.map((s) => s.id)).toContain(id);
  },
  TIMEOUT,
);

test(
  "--json answers with the record rather than attaching, with or without --detach",
  async () => {
    const source = await repository();
    const one = await werk(source, "--json", "create", "--", "sleep", "30");
    expect(one.code, one.stderr).toBe(0);
    const both = await werk(
      source,
      "--json",
      "create",
      "--detach",
      "--",
      "sleep",
      "30",
    );
    // Asking for the record and asking not to attach are the same request said
    // twice, not a contradiction.
    expect(both.code, both.stderr).toBe(0);

    for (const ran of [one, both]) {
      expect(ran.stdout.trimEnd().split("\n")).toHaveLength(1);
      const info = JSON.parse(ran.stdout.trim()) as {
        id: string;
        workspace: { branch: string };
      };
      expect(info.id).toBeString();
      expect(info.workspace.branch).toBeString();
    }
  },
  TIMEOUT,
);

/**
 * `scrollbackBytes` reaching the daemon, through the layers rather than through
 * the flag.
 *
 * This is the case a function-level test cannot hold. The setting is parsed,
 * layered, merged and reported by `werk config` whatever the CLI does with it,
 * so the only thing that distinguishes a setting werk acts on from one it
 * ignores is what the session comes back holding. So the whole route is run:
 * the environment layer, the merge, the context, `create`, the daemon, and the
 * record it answers with.
 *
 * 65536 is well under the daemon's own 10,000,000 cap, so the assertion is
 * about the merge rather than about a clamp.
 */
test(
  "a scrollbackBytes set in a layer is what the session is created with",
  async () => {
    const source = await repository();
    const ran = await werkWith(
      source,
      { WERK_SCROLLBACK_BYTES: "65536" },
      "--json",
      "create",
      "--detach",
      "--",
      "sleep",
      "30",
    );
    expect(ran.code, ran.stderr).toBe(0);
    const info = JSON.parse(ran.stdout.trim()) as { scrollbackBytes: number };
    expect(info.scrollbackBytes).toBe(65536);
  },
  TIMEOUT,
);

test(
  "--scrollback beats the layer it would otherwise have come from",
  async () => {
    const source = await repository();
    const ran = await werkWith(
      source,
      { WERK_SCROLLBACK_BYTES: "65536" },
      "--json",
      "create",
      "--detach",
      "--scrollback",
      "32768",
      "--",
      "sleep",
      "30",
    );
    expect(ran.code, ran.stderr).toBe(0);
    const info = JSON.parse(ran.stdout.trim()) as { scrollbackBytes: number };
    expect(info.scrollbackBytes).toBe(32768);
  },
  TIMEOUT,
);
