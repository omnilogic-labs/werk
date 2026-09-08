/**
 * How a workspace gets its name: the question, the parse and the sequence.
 *
 * The three are tested apart from `create` because each fails differently. A
 * bad parse produces a name a branch cannot carry, which the real maker would
 * report as `INVALID_NAME` from somewhere unrelated. A prompt reached when
 * nothing can answer it does not fail at all, it waits. And the sequence is the
 * only thing standing between two people describing the same work and a
 * refusal.
 *
 * `test/workspace.test.ts` runs the whole of it against a real repository; what
 * is here is the part that would otherwise need one repository per case.
 */
import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { isWorkspaceName, WorkspaceError } from "@werk/workspace";
import type {
  CreateWorkspaceRequest,
  Workspace,
  WorkspaceMaker,
} from "@werk/workspace";
import { createStyles } from "../src/runtime/style.js";
import type { WerkContext } from "../src/runtime/context.js";
import { CancelledError, UsageError } from "../src/runtime/exit.js";
import {
  describedName,
  NAME_CHARS,
  NAME_WORDS,
  whimsicalName,
  wordsOf,
  workspaceNames,
} from "../src/workspace-name.js";
import { ADJECTIVES, NOUNS, VERBINGS } from "../src/workspace-words.js";
import {
  describeWork,
  makeWorkspace,
  NAME_ATTEMPTS,
} from "../src/commands/create.js";

/* ------------------------------------------------------------- the vocabulary */

test("every made-up name is one a branch and a directory can carry", () => {
  for (const list of [ADJECTIVES, NOUNS, VERBINGS]) {
    expect(list.length).toBeGreaterThan(1);
    // A repeat would quietly cost entropy rather than fail anything.
    expect(new Set(list).size).toBe(list.length);
    for (const word of list) expect(word).toMatch(/^[a-z]+$/);
  }
  // The corners of the space rather than a sample: the shortest and the longest
  // triple are both names, so everything between them is too.
  const by = (length: (word: string) => number) => (list: readonly string[]) =>
    [...list].sort((a, b) => length(a) - length(b));
  for (const pick of [by((w) => w.length), by((w) => -w.length)]) {
    const name = [pick(ADJECTIVES)[0], pick(NOUNS)[0], pick(VERBINGS)[0]].join(
      "-",
    );
    expect(isWorkspaceName(name)).toBe(true);
    expect(name.length).toBeLessThanOrEqual(NAME_CHARS);
  }
});

test("a made-up name is an adjective, a noun and a verb, in that order", () => {
  // A picker rather than a seed: the source is `node:crypto`, which has none.
  expect(whimsicalName(() => 0)).toBe(
    `${ADJECTIVES[0]}-${NOUNS[0]}-${VERBINGS[0]}`,
  );
  expect(whimsicalName((bound) => bound - 1)).toBe(
    `${ADJECTIVES.at(-1)}-${NOUNS.at(-1)}-${VERBINGS.at(-1)}`,
  );
  // And the real one is a name, drawn enough times to catch a bad entry.
  for (let n = 0; n < 200; n += 1)
    expect(isWorkspaceName(whimsicalName())).toBe(true);
});

/* ------------------------------------------------------------------ the parse */

test("a description is cut down to the words that carry the meaning", () => {
  expect(describedName("Fix the login redirect on Safari")).toBe(
    "fix-login-redirect-safari",
  );
  // Punctuation, digits and an issue number all survive as themselves.
  expect(describedName("port #42 to the new API")).toBe("port-42-new-api");
  // Accents decompose rather than disappear, and camelCase is two words.
  expect(describedName("resumé for parseURL")).toBe("resume-parse-url");
  // The filler rule is skipped rather than applied when it would leave
  // nothing, so an answer made entirely of it still names something.
  expect(describedName("just the thing I was going to do")).toBe(
    "just-the-thing-i",
  );
});

test("a name from a description is bounded in words and in characters", () => {
  const long = describedName("rewrite the daemon session store index format");
  expect(long!.split("-")).toHaveLength(NAME_WORDS);
  const wordy = describedName(
    "internationalisation reconfiguration synchronisation",
  );
  expect(wordy!.length).toBeLessThanOrEqual(NAME_CHARS);
  // Cutting is by whole words, so a name never ends on a dash or mid-word.
  expect(wordy).not.toEndWith("-");
  expect(wordy).toBe("internationalisation-reconfiguration");
  // One word longer than the limit is the exception: there is nothing else to
  // keep, so it is simply cut, and what is left is still a name.
  const huge = describedName("a".repeat(NAME_CHARS + 20));
  expect(huge).toHaveLength(NAME_CHARS);
  expect(isWorkspaceName(huge!)).toBe(true);
});

test("a description with no words a name can use answers undefined", () => {
  for (const nothing of ["", "   ", "!!! ?? ...", "***", "。、", "🙂🙂"]) {
    expect(wordsOf(nothing)).toEqual([]);
    expect(describedName(nothing)).toBeUndefined();
  }
});

test("whatever is typed, what comes out is a name", () => {
  const typed = [
    "../weird name",
    "-x",
    "...",
    "/bin/sh -c 'sleep 30'",
    "2026",
    "ÉTÉ",
    "a..b",
    "feature/login",
  ];
  for (const description of typed) {
    const name = describedName(description);
    expect(name === undefined || isWorkspaceName(name)).toBe(true);
  }
});

/* --------------------------------------------------------------- the sequence */

/** The first `count` names, since two of the three branches never end. */
const first = (names: Iterable<string>, count: number): string[] => {
  const taken: string[] = [];
  for (const name of names) {
    taken.push(name);
    if (taken.length === count) break;
  }
  return taken;
};

test("a typed name is offered once and never altered", () => {
  expect([...workspaceNames("fix-login", "something else entirely")]).toEqual([
    "fix-login",
  ]);
});

test("a described name is offered as read, then numbered", () => {
  expect(first(workspaceNames(undefined, "fix the login redirect"), 3)).toEqual(
    ["fix-login-redirect", "fix-login-redirect-2", "fix-login-redirect-3"],
  );
});

test("with nothing to go on the names are made up, and keep being made up", () => {
  const made = first(workspaceNames(undefined, undefined), 3);
  for (const name of made) expect(name).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/);
  // Freshly each time rather than numbered: a second unrelated animal reads
  // better than `magical-otters-flexing-2`.
  expect(new Set(made).size).toBeGreaterThan(1);
  // An answer with nothing in it is the same as no answer at all.
  expect(first(workspaceNames(undefined, "!!!"), 1)[0]).toMatch(
    /^[a-z]+-[a-z]+-[a-z]+$/,
  );
});

/* ------------------------------------------------------------ making it stick */

/** A maker that refuses the names in `taken` and records what it was asked. */
function maker(taken: readonly string[]): WorkspaceMaker & {
  asked: string[];
} {
  const asked: string[] = [];
  return {
    kind: "test",
    asked,
    async create(request: CreateWorkspaceRequest): Promise<Workspace> {
      asked.push(request.name);
      if (taken.includes(request.name))
        throw new WorkspaceError(
          "BRANCH_EXISTS",
          `branch ${request.name} already exists`,
        );
      return {
        name: request.name,
        directory: `/state/workspaces/${request.name}`,
        branch: request.name,
        from: request.from,
      };
    },
  };
}
const from = { kind: "local-checkout", path: "/repo" } as const;

test("the workspace is made under the first name the maker will take", async () => {
  const host = maker(["fix-login", "fix-login-2"]);
  const workspace = await makeWorkspace(
    host,
    workspaceNames(undefined, "fix the login"),
    from,
    {},
  );
  expect(workspace.name).toBe("fix-login-3");
  expect(host.asked).toEqual(["fix-login", "fix-login-2", "fix-login-3"]);
});

test("a name somebody typed is a conflict rather than a name werk changes", async () => {
  const host = maker(["demo"]);
  await expect(
    makeWorkspace(host, workspaceNames("demo", undefined), from, {}),
  ).rejects.toMatchObject({ code: "BRANCH_EXISTS" });
  // Once, so the branch the caller asked for is the only one it went near.
  expect(host.asked).toEqual(["demo"]);
});

test("something other than a taken name is reported as it happened", async () => {
  const host: WorkspaceMaker = {
    kind: "test",
    create: async () => {
      throw new WorkspaceError("NO_COMMITS", "nothing to branch from");
    },
  };
  await expect(
    makeWorkspace(host, workspaceNames(undefined, undefined), from, {}),
  ).rejects.toMatchObject({ code: "NO_COMMITS" });
});

test("the search for a free name gives up rather than going on forever", async () => {
  const host = maker([]);
  // A maker that refuses everything, against the endless made-up sequence.
  const refusing: WorkspaceMaker = {
    kind: "test",
    create: async (request) => {
      host.asked.push(request.name);
      throw new WorkspaceError("DIRECTORY_EXISTS", `${request.name} is there`);
    },
  };
  await expect(
    makeWorkspace(refusing, workspaceNames(undefined, undefined), from, {}),
  ).rejects.toMatchObject({ code: "DIRECTORY_EXISTS" });
  expect(host.asked).toHaveLength(NAME_ATTEMPTS);
});

/* -------------------------------------------------------------- the question */

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
    hosts: {},
    hostProblems: [],
    defaultHost: "local",
    setups: {},
    hostOrigin: {},
    ...overrides,
  };
}

/**
 * clack reads keys from whatever stream it is handed, so the question can be
 * answered without a terminal. Keys go in one at a time so the prompt has a
 * turn to render and install its listener before the next arrives.
 */
function answering(keys: readonly string[]) {
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  let sent = 0;
  const timer = setInterval(() => {
    if (sent < keys.length) input.write(keys[sent++]);
  }, 25);
  return { prompt: { input, output }, done: () => clearInterval(timer) };
}
const asking = () => context({ noInput: false });

test("what is typed at the question is what the name is made from", async () => {
  const talk = answering(["fix the login", "\r"]);
  try {
    expect(await describeWork(asking(), {}, talk.prompt)).toBe("fix the login");
  } finally {
    talk.done();
  }
});

test("enter alone answers the question, and means 'name it for me'", async () => {
  const talk = answering(["\r"]);
  try {
    // Empty rather than undefined: somebody answered, and the answer has no
    // name in it, which `workspaceNames` turns into a made-up one.
    expect(await describeWork(asking(), {}, talk.prompt)).toBe("");
    expect(first(workspaceNames(undefined, ""), 1)[0]).toMatch(
      /^[a-z]+-[a-z]+-[a-z]+$/,
    );
  } finally {
    talk.done();
  }
});

test("the question is skipped wherever the answer would change nothing", async () => {
  // Answered in advance.
  expect(await describeWork(asking(), { describe: "fix the login" })).toBe(
    "fix the login",
  );
  // Already named, so there is nothing to ask about.
  expect(await describeWork(asking(), { workspace: "demo" })).toBeUndefined();
  // The machine register: one value on stdout, and no question beside it.
  expect(
    await describeWork(context({ noInput: false, json: true }), {}),
  ).toBeUndefined();
  // And nobody to ask, which is a pipe, `--no-input` or CI. This is the case
  // that would otherwise wait rather than fail.
  expect(await describeWork(context(), {})).toBeUndefined();
});

test("a question nothing answers ends the run rather than waiting on it", async () => {
  const talk = answering([]);
  try {
    await expect(
      describeWork(asking(), {}, { ...talk.prompt, timeoutMs: 20 }),
    ).rejects.toBeInstanceOf(CancelledError);
  } finally {
    talk.done();
  }
  // The guard the deadline sits behind: with no terminal there is no question
  // to time out on in the first place. `describeWork` skips it, so reaching
  // `text` directly is what proves the guard is still there.
  const { text } = await import("../src/runtime/interactive.js");
  await expect(text(context(), { message: "?" })).rejects.toBeInstanceOf(
    UsageError,
  );
});
