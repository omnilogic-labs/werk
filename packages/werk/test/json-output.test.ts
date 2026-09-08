/**
 * `--json` means one JSON value on stdout, and nothing else.
 *
 * Scripts, CI steps and agents read werk by piping stdout into a parser, so a
 * stray progress line, a second value or a human sentence leaking past the
 * `--json` gate breaks a caller silently. Every command that answers with a
 * value is therefore run for real, against a daemon of its own, and its stdout
 * is required to be exactly one parseable value on one line.
 *
 * The sandbox is what keeps the daemon's directory short — a Unix socket path
 * is capped at 103 bytes and a per-run temporary directory nested any deeper
 * than this fails to bind — and what keeps the three writing subcommands off
 * the config file of whoever is running the suite.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Command } from "@commander-js/extra-typings";
import { buildProgram } from "../src/app.js";
import { runWerk, sandbox, type Sandbox } from "./support/run.js";

const TIMEOUT = 30000;
let box!: Sandbox;

/**
 * Run a command with `--json` and return the value it printed, having first
 * required stdout to hold exactly one of them: one line, ending in a newline,
 * that a parser accepts whole. Anything printed alongside the value — a note, a
 * second record, a human rendering — shows up as either an extra line or as
 * trailing text the parser rejects.
 */
async function runJson(...args: string[]): Promise<unknown> {
  const { code, stdout, stderr } = await runWerk({
    sandbox: box,
    args: ["--json", ...args],
    cwd: box.root,
    timeoutMs: TIMEOUT,
  });
  expect(code, `werk ${args.join(" ")} failed: ${stderr}`).toBe(0);
  expect(stdout.endsWith("\n"), `${args[0]} printed no line`).toBe(true);
  const body = stdout.slice(0, -1);
  expect(body.includes("\n"), `${args[0]} printed more than one line`).toBe(
    false,
  );
  return JSON.parse(body);
}

/**
 * The commands run from a repository because `create` makes a workspace out of
 * one, and a workspace needs a commit to branch from.
 */
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

beforeAll(async () => {
  box = await sandbox("wkj");
  await git(box.root, "init", "-q", "-b", "main", ".");
  await git(box.root, "commit", "-q", "--allow-empty", "-m", "init");
});
afterAll(() => box.dispose());

let session = "";

test(
  "list answers with an array, and starts the daemon the rest need",
  async () => {
    expect(await runJson("list")).toEqual([]);
  },
  TIMEOUT,
);
test(
  "create answers with the session record",
  async () => {
    const info = (await runJson(
      "create",
      "--name",
      "probe",
      "--",
      process.execPath,
      "-e",
      "setTimeout(() => {}, 60000)",
    )) as {
      id: string;
      name: string;
      cwd: string;
      workspace: {
        name: string;
        directory: string;
        branch: string;
        reference: string;
        host?: string;
      };
    };
    expect(info.name).toBe("probe");
    expect(info.workspace).toBeObject();
    expect(info.cwd).toBe(info.workspace.directory);
    // No host on a workspace made on this machine: absent is what the workspace
    // model says by leaving `Workspace.host` off, and the reference reads the
    // same way, with no `@` in it.
    expect(info.workspace.host).toBeUndefined();
    expect(info.workspace.reference).toBe(
      `${info.workspace.name}:${info.workspace.directory}`,
    );
    session = info.id;
  },
  TIMEOUT,
);
test(
  "info and doctor answer with a report",
  async () => {
    expect(await runJson("info")).toBeObject();
    expect(await runJson("doctor")).toBeObject();
  },
  TIMEOUT,
);
test(
  "setup answers with what the machine's setup came to",
  async () => {
    // Nothing in the sandbox names a `[setup.<name>]` block, so there is
    // nothing to run and the record says so rather than being absent.
    expect(await runJson("setup")).toEqual({
      host: "local",
      setup: { state: "none" },
    });
  },
  TIMEOUT,
);
test(
  "daemon endpoint answers with something a client could dial",
  async () => {
    const report = (await runJson("daemon", "endpoint")) as {
      endpoint: { kind: string };
      runtimeDir: string;
      stateDir: string;
      pid: number | null;
      version: string;
      build: string;
    };
    expect(["unix", "tcp"]).toContain(report.endpoint.kind);
    expect(report.runtimeDir).toBe(box.runtimeDir);
    expect(report.stateDir).toBe(box.stateDir);
    expect(report.pid).toBeInteger();
    // The daemon under test was started by this same werk, so the identity it
    // reports and the identity of the binary that asked are one string.
    expect(report.version).toBe(report.build);
  },
  TIMEOUT,
);
test(
  "completion answers with the script beside the shell it is for",
  async () => {
    for (const shell of ["bash", "zsh", "fish"]) {
      const answer = (await runJson("completion", shell)) as {
        shell: string;
        script: string;
      };
      expect(answer.shell).toBe(shell);
      // A script carries newlines, and one JSON value on one line is the rule,
      // so this is also the case that says the escaping holds.
      expect(answer.script).toContain("werk complete");
    }
  },
  TIMEOUT,
);
test(
  "config answers on every one of its subcommands",
  async () => {
    expect(await runJson("config", "list")).toBeArray();
    expect(await runJson("config", "get", "logLevel")).toBeObject();
    expect(await runJson("config", "sources")).toBeArray();
    expect(await runJson("config", "path")).toBeDefined();
    expect(await runJson("config", "check")).toBeArray();
  },
  TIMEOUT,
);

/**
 * The three that write. They write into the sandbox's config directory, which
 * is where every run in this file already reads from, so a host block written
 * here is seen by the rest of the suite and by nobody's home directory.
 *
 * `setup` is a conversation, and this is what proves the conversation still
 * obeys the `--json` rule: the prompts paint on stderr, so a run answered
 * entirely by flags prints one value on stdout and nothing else.
 */
test(
  "the writing subcommands answer with what they did",
  async () => {
    expect(await runJson("config", "set", "logLevel", "debug")).toMatchObject({
      key: "logLevel",
      value: "debug",
      file: join(box.configDir, "config.toml"),
    });
    expect(await runJson("config", "unset", "logLevel")).toMatchObject({
      key: "logLevel",
      value: null,
    });
    expect(
      await runJson(
        "--yes",
        "config",
        "setup",
        "--host",
        "probehost",
        "--ssh",
        "probe.example",
      ),
    ).toMatchObject({ unchanged: false });
  },
  TIMEOUT,
);
test(
  "logs answers with the retained screen",
  async () => {
    expect(await runJson("logs", session)).toBeString();
  },
  TIMEOUT,
);
test(
  "kill and remove answer with what they did",
  async () => {
    expect(await runJson("kill", session)).toBeObject();
    expect(await runJson("remove", session)).toBeObject();
    expect(await runJson("list")).toEqual([]);
  },
  TIMEOUT,
);

/**
 * The commands that answer with something other than a value, each named so the
 * exemption is a decision someone took rather than a command nobody got round
 * to. A new command is in neither list and fails the test below until it is
 * classified.
 */
const EXEMPT: Record<string, string> = {
  // Write a stream of terminal output or of events until they are interrupted;
  // there is no single value for them to answer with.
  "werk attach": "streams",
  "werk watch": "streams",
  // Run the daemon in this process until it is signalled.
  "werk daemon serve": "does not return",
  // Answers a shell in the completion wire protocol, which is not JSON and is
  // read by the installed script rather than by a person or a parser.
  "werk complete": "emits the completion protocol",
};
const EXERCISED = [
  // Its human rendering is the bare script, so `eval "$(werk completion bash)"`
  // still works; `--json` wraps it beside the shell name and install hint.
  "werk completion bash",
  "werk completion zsh",
  "werk completion fish",
  "werk create",
  "werk list",
  "werk logs",
  "werk kill",
  "werk remove",
  "werk info",
  "werk doctor",
  "werk daemon endpoint",
  "werk config list",
  "werk config get",
  "werk config sources",
  "werk config path",
  "werk config check",
  "werk config set",
  "werk config unset",
  // A conversation, and still one value on stdout: the prompts it would draw
  // paint on stderr, and this run answers every one of them with a flag.
  "werk config setup",
  "werk setup",
];

/** Every command that runs something, i.e. every node with no subcommands. */
function leaves(command: Command, path = "werk"): string[] {
  if (command.commands.length === 0) return [path];
  return command.commands.flatMap((child) =>
    leaves(child as Command, `${path} ${(child as Command).name()}`),
  );
}

test("every command is either exercised here or exempt from the register", () => {
  const classified = new Set([...EXERCISED, ...Object.keys(EXEMPT)]);
  const unclassified = leaves(buildProgram(["--no-color"])).filter(
    (path) => !classified.has(path),
  );
  expect(unclassified).toEqual([]);
});
