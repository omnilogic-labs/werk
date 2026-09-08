/**
 * The wizard with the questions answered by flags, and the two registers it
 * reports in.
 *
 * The whole conversation is the same code whether a person or a flag answers
 * each question, so driving it from flags against a fake context exercises the
 * shape of what it writes and what it says. The screens themselves are walked
 * at the bottom of this file, with clack reading its keystrokes from a
 * `PassThrough` rather than from a terminal.
 *
 * The last test here is the one that guards a hang rather than a wrong answer:
 * nothing under `src/commands/` may reach for clack itself, because a prompt
 * that skips `answered()` skips the deadline and the cancel-sentinel conversion
 * and waits forever on a pipe.
 */
import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createStyles } from "../src/runtime/style.js";
import type { WerkContext } from "../src/runtime/context.js";
import {
  runSetup,
  setupHuman,
  suggestName,
  type SetupDeps,
  type SetupReport,
} from "../src/commands/config-setup.js";
import { mergeLayers, type MergedConfig } from "../src/config/load.js";
import { builtInDefaults } from "../src/config/schema.js";
import { builtInHosts, type Host } from "../src/config/hosts.js";
import type { ConfigEdit } from "../src/config/toml-edit.js";
import { noProbe, type HostProbe } from "../src/hosts/probe.js";

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
    // No terminal, so every question has to be answered by a flag; that is the
    // form a dotfiles script uses and the only form a test can drive.
    noInput: true,
    yes: true,
    runtimeDir: "/run/werk",
    stateDir: "/state/werk",
    entry: "/werk/main.ts",
    ...overrides,
  };
}

/** Whatever is already written down, as the merge would hand it over. */
function configured(hosts: Record<string, Host> = {}): MergedConfig {
  return mergeLayers([
    {
      name: "defaults",
      origin: "built in",
      values: builtInDefaults({}, "/home/tester"),
      hosts: builtInHosts(),
    },
    {
      name: "user",
      origin: "/home/tester/.werk/config.toml",
      values: {},
      hosts,
    },
  ]);
}

/** A probe that answers whatever the case needs, in the seam's own shape. */
const probeAnswering = (
  answers: Record<string, { code: number | null; stdout?: string }>,
): HostProbe => ({
  async run(command) {
    const key = command.join(" ");
    const found = answers[key] ?? { code: 127 };
    return {
      ok: found.code !== null,
      code: found.code,
      stdout: found.stdout ?? "",
      stderr: "",
    };
  },
});

function deps(
  written: { edit?: ConfigEdit; project?: boolean },
  over: SetupDeps = {},
): SetupDeps {
  return {
    load: async () => configured(),
    aliases: async () => ({ aliases: [], skipped: 0, files: [] }),
    probe: () => noProbe,
    write: async (edit, project) => {
      written.edit = edit;
      written.project = project;
      return { file: "/home/tester/.werk/config.toml", created: true };
    },
    ...over,
  };
}

test("the flag form writes one host block and reports it as added", async () => {
  const written: { edit?: ConfigEdit } = {};
  const result = await runSetup(
    context(),
    { host: "beast", ssh: "beast.example", workspaceRoot: "/srv/werk" },
    deps(written),
  );
  expect(written.edit).toEqual({
    hosts: {
      beast: {
        kind: "ssh",
        sshHost: "beast.example",
        workspaceRoot: "/srv/werk",
      },
    },
  });
  expect(result.json.hosts).toEqual([
    {
      name: "beast",
      action: "added",
      host: {
        kind: "ssh",
        sshHost: "beast.example",
        workspaceRoot: "/srv/werk",
      },
    },
  ]);
  expect(result.json.settings).toEqual([]);
});

test("--default writes the setting beside the block", async () => {
  const written: { edit?: ConfigEdit } = {};
  const result = await runSetup(
    context(),
    { host: "beast", ssh: "beast.example", default: true },
    deps(written),
  );
  expect(written.edit?.set).toEqual({ defaultHost: "beast" });
  expect(result.json.settings).toEqual([
    { key: "defaultHost", from: "local", to: "beast" },
  ]);
});

test("a name already in force is changed rather than duplicated", async () => {
  const written: { edit?: ConfigEdit } = {};
  const result = await runSetup(
    context(),
    { host: "beast", ssh: "moved.example" },
    deps(written, {
      load: async () =>
        configured({ beast: { kind: "ssh", sshHost: "beast.example" } }),
    }),
  );
  expect(result.json.hosts[0]?.action).toBe("changed");
  expect(written.edit?.hosts).toEqual({
    beast: { kind: "ssh", sshHost: "moved.example" },
  });
});

test("without a terminal and without the flags, nothing is written", async () => {
  const written: { edit?: ConfigEdit } = {};
  await expect(runSetup(context(), {}, deps(written))).rejects.toThrow(
    /pass --host and --ssh, or run it in a terminal/,
  );
  expect(written.edit).toBeUndefined();
});

test("a machine that does not answer is not saved without a yes", async () => {
  const silent = probeAnswering({ true: { code: 255 } });
  const written: { edit?: ConfigEdit } = {};
  // `--yes` is what answers "save it anyway", so the run gets that far.
  const result = await runSetup(
    context({ yes: true }),
    { host: "asleep", ssh: "asleep.example" },
    deps(written, { probe: () => silent }),
  );
  expect(result.json.probe?.reachable).toBe("no");
  expect(written.edit?.hosts).toBeDefined();

  const stopped = { edit: undefined as ConfigEdit | undefined };
  await expect(
    runSetup(
      context({ yes: false }),
      { host: "asleep", ssh: "asleep.example" },
      deps(stopped, { probe: () => silent }),
    ),
  ).rejects.toThrow();
  expect(stopped.edit).toBeUndefined();
});

test("the probe reports what it found and stores none of it", async () => {
  const machine = probeAnswering({
    true: { code: 0 },
    "uname -sm": { code: 0, stdout: "Linux x86_64\n" },
    "git --version": { code: 0, stdout: "git version 2.53.0\n" },
    "sh -c command -v werk": { code: 1 },
    'sh -c printf %s "${XDG_STATE_HOME:-$HOME/.local/state}/werk/workspaces"': {
      code: 0,
      stdout: "/home/mike/.local/state/werk/workspaces",
    },
    "sh -lc command -v claude": {
      code: 0,
      stdout: "/home/mike/.local/bin/claude\n",
    },
    "sh -c command -v claude": { code: 1 },
  });
  const written: { edit?: ConfigEdit } = {};
  const result = await runSetup(
    context(),
    { host: "beast", ssh: "beast.example" },
    deps(written, { probe: () => machine }),
  );
  const report = result.json.probe!;
  expect(report.reachable).toBe("yes");
  expect(report.checks.find((one) => one.name === "system")?.detail).toBe(
    "Linux x86_64",
  );
  expect(report.checks.find((one) => one.name === "werk")?.state).toBe("no");
  // The finding the transport work needs: `claude` is on a login shell's PATH
  // and not on a plain one.
  expect(report.notes.join("\n")).toContain("login shell");
  // None of it reaches the file. A host block holds what the machine is called
  // and where werk may put things, and nothing else.
  expect(Object.keys(written.edit!.hosts!.beast as object).sort()).toEqual([
    "kind",
    "sshHost",
    "workspaceRoot",
  ]);
});

const report = (over: Partial<SetupReport> = {}): SetupReport => ({
  file: "/home/tester/.werk/config.toml",
  created: false,
  hosts: [],
  settings: [],
  probe: null,
  unchanged: false,
  ...over,
});

test("the human rendering shows an added host as a diff", () => {
  const text = setupHuman(
    report({
      hosts: [
        {
          name: "beast",
          action: "added",
          host: { kind: "ssh", sshHost: "beast.example" },
        },
      ],
      settings: [{ key: "defaultHost", from: "local", to: "beast" }],
    }),
    context(),
  );
  expect(text).toContain("+ [hosts.beast]");
  expect(text).toContain('+ sshHost = "beast.example"');
  expect(text).toContain('~ defaultHost = "beast"');
  expect(text).toContain("werk config check beast");
});

test("the human rendering marks a changed host and a removed one", () => {
  const changed = setupHuman(
    report({
      hosts: [
        {
          name: "beast",
          action: "changed",
          host: { kind: "ssh", sshHost: "moved.example" },
        },
      ],
    }),
    context(),
  );
  expect(changed).toContain("~ [hosts.beast]");
  const removed = setupHuman(
    report({ hosts: [{ name: "beast", action: "removed", host: null }] }),
    context(),
  );
  expect(removed).toContain("- [hosts.beast]");
  expect(removed).not.toContain("werk config check");
});

test("the human rendering shows what an unreachable machine did not say", () => {
  const text = setupHuman(
    report({
      hosts: [
        {
          name: "asleep",
          action: "added",
          host: { kind: "ssh", sshHost: "asleep.example" },
        },
      ],
      probe: {
        reachable: "no",
        checks: [{ name: "reachable", state: "no" }],
        notes: [
          "ssh: connect to host asleep.example port 22: No route to host",
        ],
      },
    }),
    context(),
  );
  expect(text).toContain("reachable");
  expect(text).toContain("No route to host");
});

test("a run that changed nothing says so", () => {
  expect(setupHuman(report({ unchanged: true }), context())).toBe(
    "Nothing was changed.",
  );
});

test("a suggested name is one isHostName accepts, or nothing", () => {
  expect(suggestName("mike@10.0.0.7")).toBe("10.0.0.7");
  expect(suggestName("beast")).toBe("beast");
  expect(suggestName("[fe80::1]")).toBe("fe80--1-");
  expect(suggestName("@")).toBe("");
});

test("no command reaches for clack itself", async () => {
  const dir = join(import.meta.dir, "../src/commands");
  const reaching: string[] = [];
  for (const name of await readdir(dir)) {
    if (!name.endsWith(".ts")) continue;
    const text = await readFile(join(dir, name), "utf8");
    if (text.includes("@clack/prompts")) reaching.push(name);
  }
  expect(reaching).toEqual([]);
});

/* --------------------------------------------------- the conversation itself */

/**
 * The interactive path, driven through streams rather than through a terminal.
 *
 * clack reads its keystrokes from whatever stream it is handed, so the whole
 * conversation can be walked with a `PassThrough` on each side. That is the
 * only way anything here reaches the screens a person actually sees: the
 * flag-answered tests above never draw a prompt, and the end-to-end test in
 * `config-write.test.ts` runs with no terminal at all.
 *
 * Keys go in one at a time, on a timer, so each prompt has a turn to render
 * and to install its own listener before the next one arrives. `\r` submits.
 */
const DOWN = "\u001b[B";
const ENTER = "\r";

function conversation(keys: readonly string[]) {
  const input = new PassThrough();
  const output = new PassThrough();
  // Nothing reads the drawn frames, so they are drained rather than buffered.
  output.resume();
  let sent = 0;
  const timer = setInterval(() => {
    if (sent < keys.length) input.write(keys[sent++]);
  }, 25);
  return { prompt: { input, output }, done: () => clearInterval(timer) };
}

/** A context that is allowed to ask, and has answered nothing in advance. */
const asking = () => context({ noInput: false, yes: false });

test("the conversation adds a machine picked out of the ssh config", async () => {
  const written: { edit?: ConfigEdit } = {};
  const talk = conversation([
    ENTER, // Which machine? the first row, beast
    ENTER, // What should werk call it? the suggested name
    ENTER, // Where should workspaces go? nothing, so no key is written
    ENTER, // Make it the default? yes
    ENTER, // Write it? yes
  ]);
  try {
    const result = await runSetup(
      asking(),
      {},
      deps(written, {
        prompt: talk.prompt,
        aliases: async () => ({
          aliases: [
            {
              name: "beast",
              hostName: "10.0.0.7",
              user: "mike",
              file: "/home/tester/.ssh/config",
              system: false,
            },
          ],
          skipped: 0,
          files: ["/home/tester/.ssh/config"],
        }),
      }),
    );
    expect(result.json.hosts).toEqual([
      {
        name: "beast",
        action: "added",
        host: { kind: "ssh", sshHost: "beast" },
      },
    ]);
    expect(written.edit).toEqual({
      hosts: { beast: { kind: "ssh", sshHost: "beast" } },
      set: { defaultHost: "beast" },
    });
  } finally {
    talk.done();
  }
}, 20000);

test("re-running offers a menu, and quitting writes nothing", async () => {
  const written: { edit?: ConfigEdit } = {};
  // Four rows down from "Add another" is "Nothing; leave it as it is".
  const talk = conversation([DOWN, DOWN, DOWN, DOWN, ENTER]);
  try {
    const result = await runSetup(
      asking(),
      {},
      deps(written, {
        prompt: talk.prompt,
        load: async () =>
          configured({ beast: { kind: "ssh", sshHost: "beast.example" } }),
      }),
    );
    expect(result.json.unchanged).toBe(true);
    expect(result.json.hosts).toEqual([]);
    expect(written.edit).toBeUndefined();
  } finally {
    talk.done();
  }
}, 20000);

test("the menu removes a host, and takes a default pointing at it with it", async () => {
  const written: { edit?: ConfigEdit } = {};
  const talk = conversation([
    DOWN,
    DOWN,
    DOWN,
    ENTER, // "Remove one"
    ENTER, // which one: beast, the only row
    ENTER, // Remove beast from the file? yes
  ]);
  try {
    const merged = mergeLayers([
      {
        name: "defaults",
        origin: "built in",
        values: builtInDefaults({}, "/home/tester"),
        hosts: builtInHosts(),
      },
      {
        name: "user",
        origin: "/home/tester/.werk/config.toml",
        values: { defaultHost: "beast" },
        hosts: { beast: { kind: "ssh", sshHost: "beast.example" } },
      },
    ]);
    const result = await runSetup(
      asking(),
      {},
      deps(written, { prompt: talk.prompt, load: async () => merged }),
    );
    expect(result.json.hosts).toEqual([
      { name: "beast", action: "removed", host: null },
    ]);
    expect(written.edit).toEqual({
      hosts: { beast: null },
      set: { defaultHost: "local" },
    });
  } finally {
    talk.done();
  }
}, 20000);

test("answering no to the last question writes nothing", async () => {
  const written: { edit?: ConfigEdit } = {};
  const talk = conversation([
    "beast.example",
    ENTER, // Which machine? typed, since there are no aliases to offer
    ENTER, // the suggested name
    ENTER, // no workspace root
    ENTER, // make it the default: yes
    DOWN,
    ENTER, // Write it? no
  ]);
  try {
    await expect(
      runSetup(asking(), {}, deps(written, { prompt: talk.prompt })),
    ).rejects.toThrow();
    expect(written.edit).toBeUndefined();
  } finally {
    talk.done();
  }
}, 20000);
