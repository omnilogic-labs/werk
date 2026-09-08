/**
 * `werk edit`, end to end: a process inside a session asks, and the client
 * attached to that session opens the file where it is sitting.
 *
 * Everything about this is real except the editor. The session is a real
 * process under a real daemon, the attachment is a second werk with the
 * session on its stdout, and the two talk through the daemon rather than to
 * each other. The `editor` setting is `cp {path} <marker>`, which is the
 * smallest program that proves the path arrived intact: the file it copies is
 * the file that was asked for, and its content is what came back.
 *
 * The path deliberately has a space and a quote in it. A configured command
 * that were pasted into a shell would break on either, and this is where that
 * would show up.
 */
import { afterAll, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  runWerk,
  sandbox,
  settle,
  spawnWerk,
  type WerkRun,
} from "./support/run.js";

const TIMEOUT = 30_000;
const box = await sandbox("wked");
afterAll(box.dispose);

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

/** A repository with a commit, since that is the least git will branch from. */
async function repository(): Promise<string> {
  const directory = await mkdtemp(join(box.root, "repo-"));
  await git(directory, "init", "-q", "-b", "main", ".");
  await writeFile(join(directory, "README.md"), "committed\n");
  await git(directory, "add", "README.md");
  await git(directory, "commit", "-q", "-m", "init");
  return directory;
}

async function werk(
  args: string[],
  env: Record<string, string | undefined> = {},
): Promise<WerkRun> {
  return await runWerk({ sandbox: box, args, env, timeoutMs: TIMEOUT });
}
/** One JSON value on stdout and nothing beside it, the way `--json` promises. */
function onlyValue(outcome: WerkRun): unknown {
  expect(outcome.code, outcome.stderr).toBe(0);
  expect(outcome.stdout.endsWith("\n")).toBe(true);
  const body = outcome.stdout.slice(0, -1);
  expect(body.includes("\n")).toBe(false);
  return JSON.parse(body);
}
async function until<T>(
  check: () => Promise<T | undefined>,
  what: string,
  ms = 15_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const answer = await check();
    if (answer !== undefined) return answer;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}
const sessions = async () =>
  JSON.parse((await werk(["list", "--json"])).stdout) as {
    id: string;
    attachments: unknown[];
  }[];

const source = await repository();
const marker = join(box.root, "opened.txt");
// A space and a quote, because both are legal in a filename and neither may
// reach the editor as syntax.
const file = join(source, "a file 'to' edit.md");
await writeFile(file, "the file itself\n");

const created = JSON.parse(
  (
    await werk([
      "create",
      "--json",
      "--detach",
      "--workspace",
      "editing",
      "--cwd",
      source,
      "--",
      "sh",
      "-c",
      "sleep 300",
    ])
  ).stdout,
) as { id: string };

/**
 * An attachment held open for the length of a case, with an editor of its own.
 *
 * Standard input is a pipe nothing is written to: an attachment stops when its
 * input ends, so `/dev/null` would detach on the first tick.
 */
function attached(editor: string): Bun.Subprocess {
  return spawnWerk({
    sandbox: box,
    args: ["attach", created.id],
    stdin: "pipe",
    env: { WERK_EDITOR: editor },
  });
}
const attachmentCount = async () =>
  (await sessions()).find((s) => s.id === created.id)?.attachments.length ?? 0;

test(
  "the path reaches the attached client, and --wait comes back",
  async () => {
    const client = attached(`cp {path} ${marker}`);
    try {
      await until(
        async () => ((await attachmentCount()) > 0 ? true : undefined),
        "the client to attach",
      );

      const outcome = onlyValue(
        await werk(["edit", "--json", file], { WERK_SESSION: created.id }),
      ) as { attachments: number; finished: boolean };
      expect(outcome.attachments).toBe(1);
      expect(outcome.finished).toBe(false);
      // The file the editor was handed is the file that was asked for, spaces,
      // quote and all.
      expect(
        await until(
          () => readFile(marker, "utf8").catch(() => undefined),
          "the editor to run",
        ),
      ).toBe("the file itself\n");

      // With --wait the answer is held until the client's editor command has
      // exited, so it comes back saying so rather than saying it was asked.
      const waited = onlyValue(
        await werk(["edit", "--json", "--wait", file], {
          WERK_SESSION: created.id,
        }),
      ) as { finished: boolean };
      expect(waited.finished).toBe(true);
    } finally {
      client.kill();
      await settle(client, TIMEOUT);
    }
  },
  TIMEOUT,
);

test(
  "an editor that fails is a failure, and is reported once the screen is back",
  async () => {
    const client = attached("sh -c 'echo no such editor >&2; exit 3' _ {path}");
    try {
      await until(
        async () => ((await attachmentCount()) > 0 ? true : undefined),
        "the client to attach",
      );
      const outcome = await werk(["edit", "--wait", file], {
        WERK_SESSION: created.id,
      });
      expect(outcome.code).toBe(1);
      expect(outcome.stderr).toContain("could not open");
      expect(outcome.stderr).toContain("status 3");
    } finally {
      client.kill();
      const ended = await settle(client, TIMEOUT);
      // The attachment says what it could not do only after the alternate
      // screen is gone, and says it on stderr so a piped stdout still carries
      // nothing but the session.
      expect(ended.stderr).toContain("could not open");
      expect(ended.stdout).not.toContain("could not open");
    }
  },
  TIMEOUT,
);

test(
  "nothing attached is a refusal, not a wait",
  async () => {
    await until(
      async () => ((await attachmentCount()) === 0 ? true : undefined),
      "the client to go",
    );
    const outcome = await werk(["edit", "--wait", file], {
      WERK_SESSION: created.id,
    });
    expect(outcome.timedOut).toBe(false);
    // The status a daemon already uses for a refusal the state made.
    expect(outcome.code).toBe(5);
    expect(outcome.stderr).toContain("attached");
  },
  TIMEOUT,
);

test(
  "outside a session it says so, and reaches no daemon to find out",
  async () => {
    const outcome = await werk(["edit", file], { WERK_SESSION: undefined });
    expect(outcome.code).toBe(2);
    expect(outcome.stderr).toContain("WERK_SESSION");
  },
  TIMEOUT,
);

test(
  "the session it is in is on this machine, so it takes no --host",
  async () => {
    const outcome = await werk(["edit", "--host", "local", file], {
      WERK_SESSION: created.id,
    });
    expect(outcome.code).toBe(2);
    expect(outcome.stderr).toContain("--host");
  },
  TIMEOUT,
);
