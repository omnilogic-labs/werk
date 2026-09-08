/**
 * The prompt guard, and the property it exists for.
 *
 * The unit tests below fix the matrix — who may be asked, and what happens when
 * the answer never comes — but the one that matters runs the compiled binary
 * with stdin closed. That is the failure mode being guarded against: a prompt
 * reached without a terminal does not fail, it waits, and a test of the guard
 * function alone would still pass while the CLI hung a pipeline.
 */
import { beforeAll, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Chalk } from "chalk";
import type { SessionInfo } from "@werk/session";
import type { WerkContext } from "../src/runtime/context.js";
import { CancelledError, UsageError } from "../src/runtime/exit.js";
import {
  canPrompt,
  confirm,
  recency,
  selectSession,
  sessionChoices,
} from "../src/runtime/interactive.js";

function context(overrides: Partial<WerkContext> = {}): WerkContext {
  return {
    write: () => {},
    writeError: () => {},
    stdoutTTY: false,
    stdinTTY: false,
    columns: 80,
    colour: new Chalk({ level: 0 }),
    colourLevel: 0,
    json: false,
    noInput: true,
    yes: false,
    runtimeDir: "/run/werk",
    stateDir: "/state/werk",
    entry: "/werk/main.ts",
    ...overrides,
  };
}
const session = (over: Partial<SessionInfo> = {}): SessionInfo =>
  ({
    id: "8f2c1b04e9d1",
    daemonId: "d1",
    state: "running",
    argv: ["/bin/sh"],
    cwd: "/home/mike",
    size: { cols: 80, rows: 24 },
    scrollbackBytes: 1000,
    createdAt: 0,
    name: "demo",
    labels: {},
    attachments: [],
    processTree: { children: 0 },
    ...over,
  }) as SessionInfo;

/** Streams a prompt can be driven through without a terminal in sight. */
function channel() {
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  return { input, output };
}

test("prompting is exactly what the context already decided", () => {
  expect(canPrompt(context({ noInput: false }))).toBe(true);
  expect(canPrompt(context({ noInput: true }))).toBe(false);
  // `--yes` answers confirmations; it does not grant a terminal.
  expect(canPrompt(context({ noInput: true, yes: true }))).toBe(false);
});

test("a session cannot be picked when there is nobody to ask", async () => {
  const promise = selectSession(context(), [session()], "Which?", {
    ...channel(),
    timeoutMs: 50,
  });
  await expect(promise).rejects.toBeInstanceOf(UsageError);
});

test("an empty list is said plainly rather than offered", async () => {
  const promise = selectSession(context({ noInput: false }), [], "Which?", {
    ...channel(),
    timeoutMs: 50,
  });
  await expect(promise).rejects.toThrow(/no sessions/);
});

test("a prompt nobody answers is a cancellation, not an answer", async () => {
  // Nothing is ever written to this input, which is the idle-pipe case: without
  // the deadline the promise would never settle.
  const promise = selectSession(
    context({ noInput: false }),
    [session()],
    "Which?",
    { ...channel(), timeoutMs: 20 },
  );
  await expect(promise).rejects.toBeInstanceOf(CancelledError);
});

test("the picker answers with the id of the row that was chosen", async () => {
  const { input, output } = channel();
  const sessions = [
    session({ id: "aaa", name: "old", createdAt: 1 }),
    session({ id: "bbb", name: "new", createdAt: 2 }),
  ];
  const chosen = selectSession(
    context({ noInput: false }),
    sessions,
    "Which session?",
    { input, output, timeoutMs: 2000 },
  );
  // The list opens on the most recent, so a bare return takes it.
  setTimeout(() => input.write("\r"), 20);
  expect(await chosen).toBe("bbb");
});

test("--yes answers a confirmation without reading anything", async () => {
  const { input, output } = channel();
  expect(
    await confirm(context({ yes: true }), "Remove it?", {
      input,
      output,
      timeoutMs: 20,
    }),
  ).toBe(true);
});

test("a confirmation with no terminal and no --yes is a usage error", async () => {
  const promise = confirm(context(), "Remove it?", {
    ...channel(),
    timeoutMs: 20,
  });
  await expect(promise).rejects.toBeInstanceOf(UsageError);
});

test("rows are most recent first, whichever field last moved", () => {
  const a = session({ id: "a", name: "a", createdAt: 100 });
  const b = session({ id: "b", name: "b", createdAt: 1, lastOutputAt: 300 });
  const c = session({ id: "c", name: "c", createdAt: 2, lastInputAt: 200 });
  expect(recency(b)).toBe(300);
  expect(sessionChoices([a, b, c]).map((choice) => choice.value)).toEqual([
    "b",
    "c",
    "a",
  ]);
});

test("a row says the name, the state and the command", () => {
  const [choice] = sessionChoices([
    session({ id: "8f2c1b04e9d1", name: "demo", argv: ["bash", "-l"] }),
  ]);
  expect(choice?.label).toBe("demo  running  bash -l");
  expect(choice?.hint).toBe("8f2c1b04e9d1");
});

test("a nameless session is offered under its id", () => {
  const [choice] = sessionChoices([session({ name: "" })]);
  expect(choice?.label.startsWith("8f2c1b04e9d1")).toBe(true);
});

/* ------------------------------------------------- the compiled executable */

const root = path.resolve(import.meta.dir, "..");
const binary = path.join(root, "dist", "werk");

/** The newest source file, so a stale binary is rebuilt rather than trusted. */
async function newestSource(dir: string): Promise<number> {
  let newest = 0;
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    newest = Math.max(
      newest,
      entry.isDirectory()
        ? await newestSource(full)
        : (await fs.stat(full)).mtimeMs,
    );
  }
  return newest;
}

beforeAll(async () => {
  const built = await fs.stat(binary).then(
    (s) => s.mtimeMs,
    () => 0,
  );
  if (built > (await newestSource(path.join(root, "src")))) return;
  const build = Bun.spawn([process.execPath, "run", "build"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if ((await build.exited) !== 0)
    throw new Error(await new Response(build.stderr).text());
}, 300_000);

interface Run {
  code: number | null;
  stderr: string;
  timedOut: boolean;
}
/**
 * Run the CLI with a stdin that will never answer and a deadline of its own. A
 * regression here is a process that never returns, so the timeout is the
 * assertion: without it the suite would hang rather than fail.
 */
async function run(args: string[], stdin: "ignore" | "pipe"): Promise<Run> {
  const env = { ...process.env, NO_COLOR: "1" };
  // CI would forbid prompting on its own, which would prove nothing about the
  // guard: the run has to look as ordinary as the terminals it was given.
  delete env.CI;
  const child = Bun.spawn([binary, ...args], {
    stdin,
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  const finished = child.exited.then((code) => code);
  const timedOut = Symbol("timeout");
  const timer = new Promise<typeof timedOut>((resolve) =>
    setTimeout(() => resolve(timedOut), 10_000),
  );
  const outcome = await Promise.race([finished, timer]);
  const stderr = await new Response(child.stderr).text();
  if (outcome === timedOut) {
    child.kill("SIGKILL");
    return { code: null, stderr, timedOut: true };
  }
  return { code: outcome, stderr, timedOut: false };
}

async function scratch(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "werk-interactive-"));
}

for (const command of ["attach", "kill", "logs", "remove"])
  test(`${command} with no session and no terminal exits 2 at once`, async () => {
    const dir = await scratch();
    const outcome = await run(
      [command, "--runtime-dir", dir, "--state-dir", dir],
      "ignore",
    );
    expect(outcome.timedOut).toBe(false);
    expect(outcome.code).toBe(2);
    expect(outcome.stderr).toMatch(/name a session/);
    // Refusing happens before anything connects, so no daemon was started to
    // serve a command that was never going to run.
    expect(await fs.readdir(dir)).toEqual([]);
  }, 30_000);

test("an idle pipe is refused rather than waited on", async () => {
  const dir = await scratch();
  const outcome = await run(
    ["attach", "--runtime-dir", dir, "--state-dir", dir],
    "pipe",
  );
  expect(outcome.timedOut).toBe(false);
  expect(outcome.code).toBe(2);
}, 30_000);

test("--json reports the refusal as a record", async () => {
  const dir = await scratch();
  const outcome = await run(
    ["remove", "--json", "--runtime-dir", dir, "--state-dir", dir],
    "ignore",
  );
  expect(outcome.code).toBe(2);
  expect(JSON.parse(outcome.stderr).error.code).toBe("USAGE");
}, 30_000);
