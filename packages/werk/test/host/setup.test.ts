/**
 * What werk would have run to set a machine up, and when it would not have.
 *
 * Nothing here opens a connection or runs a command: `fakeRunner` collects
 * every argv, so the assertions are about the commands werk builds, the order
 * it puts them in, and how many round trips it takes to decide. The four rows
 * of the decision table are each a test, because getting one of them wrong is
 * either somebody's machine being set up again behind their back or a machine
 * that never gets set up at all.
 *
 * `test/setup-run.test.ts` runs the same code against a real shell in a
 * temporary `$HOME`, which is where the script itself is proved to work.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultRoles } from "@werk/palette";
import { createStyles } from "../../src/runtime/style.js";
import type { WerkContext } from "../../src/runtime/context.js";
import type { Host } from "../../src/config/hosts.js";
import type { SetupBlock } from "../../src/config/setup.js";
import { ConfigError } from "../../src/config/errors.js";
import {
  fingerprintSetup,
  runHostSetup,
  runWorkspaceSetup,
  setupHintFile,
  setupStampFile,
  trustFile,
  walkCopy,
  SETUP_MAX_FILES,
} from "../../src/host/setup.js";
import { HostError } from "../../src/host/types.js";
import { fakeRunner, type FakeRunner } from "./fake-runner.js";

let stateDir: string;
let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "werk-setup-"));
  stateDir = path.join(root, "state");
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const beast: Host = { kind: "ssh", sshHost: "beast", setup: "my-boxes" };

/** A context with no terminal, whatever setups the case wants, and nothing else. */
function context(over: Partial<WerkContext> = {}): WerkContext {
  const written: string[] = [];
  return {
    write: (text) => void written.push(text),
    writeError: (text) => void written.push(text),
    stdoutTTY: false,
    stdinTTY: false,
    columns: 80,
    style: createStyles(0),
    theme: defaultRoles,
    colourLevel: 0,
    json: false,
    noInput: true,
    yes: false,
    runtimeDir: path.join(root, "run"),
    stateDir,
    entry: "/werk/main.ts",
    hosts: { beast },
    hostProblems: [],
    defaultHost: "beast",
    setups: {},
    hostOrigin: { beast: "/home/nobody/.werk/config.toml" },
    ...over,
  };
}
/** A context that keeps what was said on stderr, for the two silent answers. */
function recording(over: Partial<WerkContext> = {}) {
  const said: string[] = [];
  return {
    said,
    ctx: context({ writeError: (t) => void said.push(t), ...over }),
  };
}

const block = (over: Partial<SetupBlock> = {}): SetupBlock => ({
  run: ["claude plugin marketplace add official", "install.sh"],
  ...over,
});

/**
 * A machine reporting `$HOME` and, on the second line, whatever stamp it has.
 * That pair is one round trip on purpose, so the cheap case stays cheap.
 */
function machine(stamp: string | null): FakeRunner {
  return fakeRunner((argv) => {
    const command = argv.at(-1) ?? "";
    if (command.includes("printf '%s\\n' \"$HOME\""))
      return { stdout: `/home/mike\n${stamp ?? ""}` };
    return { code: 0 };
  });
}

/** The command each ssh invocation carried, which is its last argument. */
const commands = (runner: FakeRunner) =>
  runner.calls
    .filter((call) => call.argv[0] === "ssh")
    .map((call) => call.argv.at(-1) ?? "");
/** How many times the machine was asked anything. */
const trips = (runner: FakeRunner) => commands(runner).length;

async function writeHint(
  fingerprint: string,
  over: Record<string, unknown> = {},
) {
  const file = setupHintFile(stateDir, "beast");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    JSON.stringify({
      host: "beast",
      sshHost: "beast",
      block: "my-boxes",
      fingerprint,
      at: new Date().toISOString(),
      ...over,
    }),
  );
}

/* ------------------------------------------------------------ resolving one */

test("a host naming a block nothing defines is refused, naming both and the file", async () => {
  const ctx = context({ setups: {} });
  const failed = runHostSetup({ ctx, name: "beast", host: beast });
  await expect(failed).rejects.toBeInstanceOf(ConfigError);
  const error = await failed.catch((e: unknown) => e as Error);
  expect(error.message).toContain("[hosts.beast]");
  expect(error.message).toContain("/home/nobody/.werk/config.toml");
  expect(error.message).toContain("my-boxes");
});

test("a host with no setup key does nothing at all", async () => {
  const runner = machine(null);
  const outcome = await runHostSetup({
    ctx: context(),
    name: "beast",
    host: { kind: "ssh", sshHost: "beast" },
    runner,
  });
  expect(outcome).toEqual({ state: "none" });
  expect(trips(runner)).toBe(0);
});

/* ------------------------------------------------------------ the fingerprint */

describe("the fingerprint", () => {
  test("changes when a copied file changes, and not otherwise", async () => {
    const dir = path.join(root, "dots");
    await fs.mkdir(path.join(dir, "bin"), { recursive: true });
    await fs.writeFile(path.join(dir, "bin", "install.sh"), "echo one\n");
    const one = block({ copy: dir, to: "share/werk" });

    const first = await fingerprintSetup(one);
    expect((await fingerprintSetup(one)).fingerprint).toBe(first.fingerprint);

    await fs.writeFile(path.join(dir, "bin", "install.sh"), "echo two\n");
    expect((await fingerprintSetup(one)).fingerprint).not.toBe(
      first.fingerprint,
    );
  });

  test("changes with the commands and with where they land", async () => {
    const plain = await fingerprintSetup(block());
    expect(
      (await fingerprintSetup(block({ run: ["install.sh"] }))).fingerprint,
    ).not.toBe(plain.fingerprint);
    // The order of the commands is part of what a block says.
    expect(
      (await fingerprintSetup(block({ run: [...block().run].reverse() })))
        .fingerprint,
    ).not.toBe(plain.fingerprint);
  });

  test("is twelve hex characters, the way a build stamp is written", async () => {
    expect((await fingerprintSetup(block())).fingerprint).toMatch(
      /^[0-9a-f]{12}$/,
    );
  });

  test("rerunOnChange is not part of it", async () => {
    expect(
      (await fingerprintSetup(block({ rerunOnChange: true }))).fingerprint,
    ).toBe((await fingerprintSetup(block())).fingerprint);
  });
});

describe("what a copy may be", () => {
  test("a path that is not there is refused, by name", async () => {
    const missing = path.join(root, "nowhere");
    await expect(walkCopy(missing)).rejects.toThrow(missing);
  });

  test("a link out of the tree is named rather than dropped", async () => {
    const dir = path.join(root, "dots");
    await fs.mkdir(dir, { recursive: true });
    await fs.symlink("../../etc/passwd", path.join(dir, "secrets"));
    const failed = walkCopy(dir);
    await expect(failed).rejects.toBeInstanceOf(ConfigError);
    await expect(failed).rejects.toThrow("secrets");
  });

  test("a link inside the tree travels as the link it is", async () => {
    const dir = path.join(root, "dots");
    await fs.mkdir(path.join(dir, "bin"), { recursive: true });
    await fs.writeFile(path.join(dir, "bin", "run.sh"), "echo\n");
    await fs.symlink("bin/run.sh", path.join(dir, "here"));
    const found = await walkCopy(dir);
    expect(found.map((entry) => entry.path).sort()).toEqual([
      "bin/run.sh",
      "here",
    ]);
    expect(found.find((entry) => entry.path === "here")?.link).toBe(
      "bin/run.sh",
    );
  });

  test("more entries than the bound is a refusal rather than a transfer", async () => {
    const dir = path.join(root, "many");
    await fs.mkdir(dir, { recursive: true });
    await Promise.all(
      Array.from({ length: SETUP_MAX_FILES + 2 }, (_, i) =>
        fs.writeFile(path.join(dir, `f${i}`), ""),
      ),
    );
    await expect(walkCopy(dir)).rejects.toThrow(String(SETUP_MAX_FILES));
  });
});

/* --------------------------------------------------- deciding whether to run */

describe("deciding whether to run", () => {
  test("no stamp at all: run, and stamp it last", async () => {
    const runner = machine(null);
    const ctx = context({ setups: { "my-boxes": block() } });
    const outcome = await runHostSetup({
      ctx,
      name: "beast",
      host: beast,
      runner,
    });
    expect(outcome).toMatchObject({ state: "ran", commands: 2 });

    const script = commands(runner).at(-1)!;
    const first = script.indexOf("claude plugin marketplace add official");
    const second = script.indexOf("install.sh");
    const stamped = script.indexOf(setupStampFile("/home/mike", "my-boxes"));
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(second);
    // Last, so a run that stopped part-way never looks finished.
    expect(second).toBeLessThan(stamped);
    // Under a login shell, which is where `claude` is on the machines werk is
    // aimed at.
    expect(script).toContain("-lc");
  });

  test("the hint matching costs no round trip at all", async () => {
    const one = block();
    const { fingerprint } = await fingerprintSetup(one);
    await writeHint(fingerprint);
    const runner = machine(fingerprint);
    const outcome = await runHostSetup({
      ctx: context({ setups: { "my-boxes": one } }),
      name: "beast",
      host: beast,
      runner,
    });
    expect(outcome).toEqual({
      state: "current",
      block: "my-boxes",
      fingerprint,
      asked: false,
    });
    expect(trips(runner)).toBe(0);
  });

  test("no hint but a matching stamp costs one, and writes the hint", async () => {
    const one = block();
    const { fingerprint } = await fingerprintSetup(one);
    const runner = machine(fingerprint);
    const outcome = await runHostSetup({
      ctx: context({ setups: { "my-boxes": one } }),
      name: "beast",
      host: beast,
      runner,
    });
    expect(outcome).toMatchObject({ state: "current", asked: true });
    expect(trips(runner)).toBe(1);
    expect(
      JSON.parse(await fs.readFile(setupHintFile(stateDir, "beast"), "utf8")),
    ).toMatchObject({ block: "my-boxes", fingerprint });
  });

  test("a hint for another machine is a miss, not an answer", async () => {
    const one = block();
    const { fingerprint } = await fingerprintSetup(one);
    await writeHint(fingerprint, { sshHost: "somewhere-else" });
    const runner = machine(fingerprint);
    await runHostSetup({
      ctx: context({ setups: { "my-boxes": one } }),
      name: "beast",
      host: beast,
      runner,
    });
    expect(trips(runner)).toBe(1);
  });

  test("changed and rerunOnChange: run", async () => {
    const runner = machine("stale0000000");
    const outcome = await runHostSetup({
      ctx: context({ setups: { "my-boxes": block({ rerunOnChange: true }) } }),
      name: "beast",
      host: beast,
      runner,
    });
    expect(outcome).toMatchObject({ state: "ran" });
  });

  test("changed, not rerunOnChange, nothing to ask: skipped with a note", async () => {
    const runner = machine("stale0000000");
    const { said, ctx } = recording({ setups: { "my-boxes": block() } });
    const outcome = await runHostSetup({
      ctx,
      name: "beast",
      host: beast,
      runner,
    });
    expect(outcome).toMatchObject({ state: "skipped" });
    // A statement rather than a refusal, naming the flag that answers it.
    expect(said.join("")).toContain("--yes");
    // The machine was asked what it had, and nothing else.
    expect(trips(runner)).toBe(1);
  });

  test("changed, not rerunOnChange, --yes: run", async () => {
    const runner = machine("stale0000000");
    const outcome = await runHostSetup({
      ctx: context({ setups: { "my-boxes": block() }, yes: true }),
      name: "beast",
      host: beast,
      runner,
    });
    expect(outcome).toMatchObject({ state: "ran" });
  });

  test("--force runs it whatever the hint and the stamp say", async () => {
    const one = block();
    const { fingerprint } = await fingerprintSetup(one);
    await writeHint(fingerprint);
    const runner = machine(fingerprint);
    const outcome = await runHostSetup({
      ctx: context({ setups: { "my-boxes": one } }),
      name: "beast",
      host: beast,
      runner,
      force: true,
    });
    expect(outcome).toMatchObject({ state: "ran" });
  });
});

/* ------------------------------------------------------------- the transfer */

test("a copy is sent before any command runs", async () => {
  const dir = path.join(root, "dots");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "install.sh"), "echo\n");
  const runner = machine(null);
  await runHostSetup({
    ctx: context({
      setups: { "my-boxes": block({ copy: dir, to: "share/werk" }) },
    }),
    name: "beast",
    host: beast,
    runner,
  });
  // The contents of the directory, not the directory.
  expect(runner.started).toEqual([["tar", "-czf", "-", "-C", dir, "."]]);
  const [, transfer, script] = commands(runner);
  expect(transfer).toContain("mkdir -p '/home/mike/share/werk'");
  expect(transfer).toContain("tar -xzf - -C '/home/mike/share/werk'");
  // No `finish` on the transfer: the stamp is what says it worked, and it is
  // written after the commands.
  expect(transfer).not.toContain("stamp");
  expect(script).toContain("stamp");
});

/* -------------------------------------------------------------- the failures */

describe("what a failure is", () => {
  test("a far-side non-zero is HOST_SETUP_FAILED, naming the command", async () => {
    const runner = fakeRunner((argv) => {
      const command = argv.at(-1) ?? "";
      if (command.includes("printf '%s\\n' \"$HOME\""))
        return { stdout: "/home/mike\n" };
      return {
        code: 1,
        stderr:
          "install.sh: No such file\nwerk-setup: command 2 failed (exit 1)\n",
      };
    });
    const failed = runHostSetup({
      ctx: context({ setups: { "my-boxes": block() } }),
      name: "beast",
      host: beast,
      runner,
    });
    await expect(failed).rejects.toBeInstanceOf(HostError);
    await expect(failed).rejects.toMatchObject({ code: "HOST_SETUP_FAILED" });
    await expect(failed).rejects.toThrow("install.sh");
  });

  test("an ssh 255 stays HOST_UNREACHABLE", async () => {
    const runner = fakeRunner((argv) => {
      const command = argv.at(-1) ?? "";
      if (command.includes("printf '%s\\n' \"$HOME\""))
        return { stdout: "/home/mike\n" };
      return {
        code: 255,
        stderr: "ssh: connect to host beast: No route to host",
      };
    });
    const failed = runHostSetup({
      ctx: context({ setups: { "my-boxes": block() } }),
      name: "beast",
      host: beast,
      runner,
    });
    await expect(failed).rejects.toMatchObject({ code: "HOST_UNREACHABLE" });
  });
});

/* ---------------------------------------------------------- trusting a repo */

describe("a repository's own setup", () => {
  const options = (ctx: WerkContext, runner: FakeRunner) => ({
    ctx,
    name: "beast",
    host: beast,
    directory: "/srv/werk/workspaces/x/fix-login",
    repository: "werk",
    identity: "11111111-2222-3333-4444-555555555555",
    runner,
  });

  test("with no terminal and no --yes it is skipped with a note", async () => {
    const runner = machine(null);
    const { said, ctx } = recording({
      setups: { bootstrap: block({ run: ["bun install"] }) },
      workspaceSetup: "bootstrap",
    });
    const outcome = await runWorkspaceSetup(options(ctx, runner));
    expect(outcome).toMatchObject({ state: "skipped" });
    expect(said.join("")).toContain("--yes");
    // Nothing ran, and nothing was recorded as trusted.
    expect(trips(runner)).toBe(0);
    await expect(
      fs.readFile(trustFile(stateDir, options(ctx, runner).identity), "utf8"),
    ).rejects.toThrow();
  });

  test("--yes answers it once, and the answer is recorded per repository", async () => {
    const runner = machine(null);
    const ctx = context({
      setups: { bootstrap: block({ run: ["bun install"] }) },
      workspaceSetup: "bootstrap",
      yes: true,
    });
    const outcome = await runWorkspaceSetup(options(ctx, runner));
    expect(outcome).toMatchObject({ state: "ran", commands: 1 });
    const trust = JSON.parse(
      await fs.readFile(
        trustFile(stateDir, options(ctx, runner).identity),
        "utf8",
      ),
    ) as { block: string; fingerprint: string };
    expect(trust.block).toBe("bootstrap");
    expect(trust.fingerprint).toBe(
      (await fingerprintSetup(block({ run: ["bun install"] }))).fingerprint,
    );
  });

  test("a recorded answer means the next workspace asks nothing", async () => {
    const one = block({ run: ["bun install"] });
    const { fingerprint } = await fingerprintSetup(one);
    const file = trustFile(stateDir, "11111111-2222-3333-4444-555555555555");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      JSON.stringify({
        repository: "11111111-2222-3333-4444-555555555555",
        block: "bootstrap",
        fingerprint,
        at: new Date().toISOString(),
      }),
    );
    const runner = machine(null);
    const { said, ctx } = recording({
      setups: { bootstrap: one },
      workspaceSetup: "bootstrap",
    });
    expect(await runWorkspaceSetup(options(ctx, runner))).toMatchObject({
      state: "ran",
    });
    expect(said.join("")).not.toContain("--yes");
  });

  test("the commands run in the workspace, and nothing is stamped", async () => {
    const runner = machine(null);
    const ctx = context({
      setups: { bootstrap: block({ run: ["bun install"] }) },
      workspaceSetup: "bootstrap",
      yes: true,
    });
    await runWorkspaceSetup(options(ctx, runner));
    const script = commands(runner).at(-1)!;
    // Quoted for the `sh -c` sshd hands a command to, and escaped again by the
    // login wrapper around it, so the path is what is asserted rather than the
    // spelling of the quotes.
    expect(script).toContain("cd ");
    expect(script).toContain("/srv/werk/workspaces/x/fix-login");
    // A workspace is new, so there is nothing a stamp could answer.
    expect(script).not.toContain("stamp");
  });

  test("a failure says the workspace was left where it is", async () => {
    const runner = fakeRunner(() => ({
      code: 1,
      stderr: "werk-setup: command 1 failed (exit 1)\n",
    }));
    const ctx = context({
      setups: { bootstrap: block({ run: ["bun install"] }) },
      workspaceSetup: "bootstrap",
      yes: true,
    });
    const failed = runWorkspaceSetup(options(ctx, runner));
    await expect(failed).rejects.toMatchObject({
      code: "WORKSPACE_SETUP_FAILED",
    });
    await expect(failed).rejects.toThrow("still there");
  });
});
