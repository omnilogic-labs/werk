/**
 * `--json` means one JSON value on stdout, and nothing else.
 *
 * Scripts, CI steps and agents read werk by piping stdout into a parser, so a
 * stray progress line, a second value or a human sentence leaking past the
 * `--json` gate breaks a caller silently. Every command that answers with a
 * value is therefore run for real, against a daemon of its own, and its stdout
 * is required to be exactly one parseable value on one line.
 *
 * The daemon lives under a short directory in `/tmp` on purpose: a Unix socket
 * path is capped at 103 bytes and a per-run temporary directory nested any
 * deeper than this fails to bind.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Command } from "@commander-js/extra-typings";
import { buildProgram } from "../src/app.js";

const MAIN = join(import.meta.dir, "../src/main.ts");
const TIMEOUT = 30000;
let home = "";
let runtimeDir = "";
let stateDir = "";

/**
 * Run a command with `--json` and return the value it printed, having first
 * required stdout to hold exactly one of them: one line, ending in a newline,
 * that a parser accepts whole. Anything printed alongside the value — a note, a
 * second record, a human rendering — shows up as either an extra line or as
 * trailing text the parser rejects.
 */
async function runJson(...args: string[]): Promise<unknown> {
  const child = Bun.spawn(
    [
      process.execPath,
      MAIN,
      "--json",
      "--runtime-dir",
      runtimeDir,
      "--state-dir",
      stateDir,
      ...args,
    ],
    { cwd: home, stdout: "pipe", stderr: "pipe" },
  );
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  expect(await child.exited, `werk ${args.join(" ")} failed: ${stderr}`).toBe(
    0,
  );
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
  home = await mkdtemp("/tmp/wkj-");
  runtimeDir = join(home, "r");
  stateDir = join(home, "s");
  await git(home, "init", "-q", "-b", "main", ".");
  await git(home, "commit", "-q", "--allow-empty", "-m", "init");
});
afterAll(async () => {
  try {
    const record = JSON.parse(
      await readFile(join(stateDir, "daemon.json"), "utf8"),
    );
    if (Number.isInteger(record?.pid)) process.kill(record.pid, "SIGTERM");
  } catch {}
  await rm(home, { recursive: true, force: true });
});

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
      workspace: { name: string; directory: string; branch: string };
    };
    expect(info.name).toBe("probe");
    expect(info.workspace).toBeObject();
    expect(info.cwd).toBe(info.workspace.directory);
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
    expect(report.runtimeDir).toBe(runtimeDir);
    expect(report.stateDir).toBe(stateDir);
    expect(report.pid).toBeInteger();
    // The daemon under test was started by this same werk, so the identity it
    // reports and the identity of the binary that asked are one string.
    expect(report.version).toBe(report.build);
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
