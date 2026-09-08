/**
 * The prompt guard, and the property it exists for.
 *
 * The unit tests below fix the matrix — who may be asked, and what happens when
 * the answer never comes — but the one that matters runs the compiled binary
 * with stdin closed. That is the failure mode being guarded against: a prompt
 * reached without a terminal does not fail, it waits, and a test of the guard
 * function alone would still pass while the CLI hung a pipeline.
 *
 * `--no-input` is the one cause a hand-built context cannot cover. Every test
 * process has no terminal, so a context written here is already forbidden from
 * prompting whether or not the flag was ever read, and the flag was in fact
 * read under a name commander does not produce. So the flag is driven through
 * the real command tree instead, and asked what it forbids on a terminal that
 * would otherwise allow prompting.
 *
 * What that still does not reach is the invocation a person makes: a real
 * terminal, outside CI, with `--no-input` typed. Nothing here allocates a pty,
 * so the streams are always pipes and the case is reconstructed from its
 * parts rather than walked. Closing that gap wants a pty harness the suite
 * does not have.
 */
import { beforeAll, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import fs from "node:fs/promises";
import { createStyles } from "../src/runtime/style.js";
import type { SessionInfo } from "@werk/session";
import { buildProgram } from "../src/app.js";
import {
  GLOBAL_FLAGS,
  hoistGlobalFlags,
  splitChildArgv,
} from "../src/runtime/argv.js";
import {
  promptingForbidden,
  type GlobalFlags,
  type WerkContext,
} from "../src/runtime/context.js";
import { CancelledError, UsageError } from "../src/runtime/exit.js";
import {
  canPrompt,
  confirm,
  recency,
  selectSession,
  sessionChoices,
} from "../src/runtime/interactive.js";
import {
  compiledWerk,
  runWerk,
  sandbox,
  type Sandbox,
  type WerkRun,
} from "./support/run.js";

function context(overrides: Partial<WerkContext> = {}): WerkContext {
  return {
    write: () => {},
    writeError: () => {},
    stdoutTTY: false,
    stdinTTY: false,
    columns: 80,
    style: createStyles(0),
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

/** Thrown from a hook to stop a real parse before the command reaches a daemon. */
class Parsed extends Error {
  constructor(readonly flags: GlobalFlags) {
    super("parsed");
  }
}
/**
 * What commander actually hands an action, for a command line typed the way a
 * user types it. `main.ts`'s two argv transformations run first, so a flag
 * after the command name is read the same way it is in a shell.
 */
async function flagsFor(argv: string[]): Promise<GlobalFlags> {
  const { globals, rest } = hoistGlobalFlags(splitChildArgv(argv).own);
  const ordered = [...globals, ...rest];
  const program = buildProgram(ordered).hook("preAction", (_root, action) => {
    throw new Parsed(action.optsWithGlobals() as GlobalFlags);
  });
  try {
    await program.parseAsync(ordered, { from: "user" });
  } catch (error) {
    if (error instanceof Parsed) return error.flags;
    throw error;
  }
  throw new Error("the command ran instead of being intercepted");
}
/** A terminal on both streams and no CI, so only the flag can forbid a prompt. */
const terminal = { stdinTTY: true, stdoutTTY: true };

test("--no-input forbids prompting on a real terminal", async () => {
  expect(promptingForbidden(await flagsFor(["kill"]), terminal, {})).toBe(
    false,
  );
  expect(
    promptingForbidden(await flagsFor(["--no-input", "kill"]), terminal, {}),
  ).toBe(true);
  // Global flags are accepted after the command name as well as before it.
  expect(
    promptingForbidden(await flagsFor(["kill", "--no-input"]), terminal, {}),
  ).toBe(true);
});

test("every negated global flag parses to the key it is read from", async () => {
  // Commander reads `--no-x` as the negation of `x`, so it stores `x: false`
  // and there is no `noX` key to read. `--no-input` was read from the name it
  // is spelled with, so the guard behind it was dead on every terminal. This
  // holds the whole class rather than the one instance: a negated flag added
  // later and read from the wrong key fails here.
  const negated = GLOBAL_FLAGS.filter((spec) =>
    spec.flags.startsWith("--no-"),
  ).map((spec) => spec.flags);
  expect(negated).toContain("--no-input");
  expect(negated.length).toBeGreaterThan(1);
  for (const flag of negated) {
    const base = flag.slice("--no-".length);
    const key = base.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    const wrong = "no" + key[0]!.toUpperCase() + key.slice(1);
    const passed = (await flagsFor([flag, "kill"])) as Record<string, unknown>;
    const absent = (await flagsFor(["kill"])) as Record<string, unknown>;
    // Typed, the un-negated key is `false`. Untyped it is anything but, which
    // is `true` on its own and `undefined` where a `--color` is declared
    // beside its `--no-color`.
    expect(passed[key], flag).toBe(false);
    expect(absent[key], flag).not.toBe(false);
    // The name the flag is spelled with is never a key. Reading it is the
    // defect, and it is silent: the value is `undefined`, so a `=== true`
    // guard behind it simply never fires.
    expect(Object.keys(passed), flag).not.toContain(wrong);
    expect(passed[wrong], flag).toBeUndefined();
  }
});

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

let binary = "";
beforeAll(async () => {
  binary = await compiledWerk();
}, 300_000);

/**
 * Run the CLI with a stdin that will never answer and a deadline of its own. A
 * regression here is a process that never returns, so the timeout is the
 * assertion: without it the suite would hang rather than fail.
 */
async function run(
  box: Sandbox,
  args: string[],
  stdin: "ignore" | "pipe",
): Promise<WerkRun> {
  return await runWerk({
    sandbox: box,
    args,
    binary,
    stdin,
    // CI would forbid prompting on its own, which would prove nothing about
    // the guard: the run has to look as ordinary as the terminals it was
    // given.
    env: { NO_COLOR: "1", CI: undefined },
    timeoutMs: 10_000,
  });
}

for (const command of ["attach", "kill", "logs", "remove"])
  test(`${command} with no session and no terminal exits 2 at once`, async () => {
    const box = await sandbox("wki");
    try {
      const outcome = await run(box, [command], "ignore");
      expect(outcome.timedOut).toBe(false);
      expect(outcome.code).toBe(2);
      expect(outcome.stderr).toMatch(/name a session/);
      // Refusing happens before anything connects, so no daemon was started to
      // serve a command that was never going to run.
      expect(await fs.readdir(box.runtimeDir)).toEqual([]);
      expect(await fs.readdir(box.stateDir)).toEqual([]);
    } finally {
      await box.dispose();
    }
  }, 30_000);

test("an idle pipe is refused rather than waited on", async () => {
  const box = await sandbox("wki");
  try {
    const outcome = await run(box, ["attach"], "pipe");
    expect(outcome.timedOut).toBe(false);
    expect(outcome.code).toBe(2);
  } finally {
    await box.dispose();
  }
}, 30_000);

test("--json reports the refusal as a record", async () => {
  const box = await sandbox("wki");
  try {
    const outcome = await run(box, ["remove", "--json"], "ignore");
    expect(outcome.code).toBe(2);
    expect(JSON.parse(outcome.stderr).error.code).toBe("USAGE");
  } finally {
    await box.dispose();
  }
}, 30_000);
