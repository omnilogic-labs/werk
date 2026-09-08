/**
 * A setup that actually runs, with the machine being this one.
 *
 * `test/host/setup.test.ts` settles what werk would have run against a scripted
 * runner, which proves the argv and never executes anything. This is the other
 * half: the script goes into a real shell, the tar pipe really moves bytes, the
 * stamp is really written and really read back, and the commands really fail.
 *
 * The machine is this one with `$HOME` moved into a temporary directory, so the
 * stamp lands under the test's own tree and nothing touches the reader's. That
 * is the same trick `test/loopback.test.ts` plays, and it is written here
 * rather than there because that file's note is about the workspace maker.
 *
 * What it cannot say anything about is ssh: the connection, the argv werk
 * builds for it and the login shell a real sshd hands a command to are
 * `scripts/remote-smoke.ts`'s job.
 */
import { afterEach, beforeEach, expect, test as bunTest } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { defaultRoles } from "@werk/palette";
import { createStyles } from "../src/runtime/style.js";
import type { WerkContext } from "../src/runtime/context.js";
import type { Host } from "../src/config/hosts.js";
import type { SetupBlock } from "../src/config/setup.js";
import {
  fingerprintSetup,
  runHostSetup,
  runWorkspaceSetup,
  setupStampFile,
} from "../src/host/setup.js";
import { spawnRunner, type RemoteRunner } from "../src/host/ssh.js";

const TIMEOUT = 30_000;

/**
 * Every case here needs a POSIX login shell and a `/tmp`, because that is what
 * a setup script is: `sh -lc` with a `$HOME` moved out of the way. Windows has
 * neither, and running a setup there is not something anybody has worked out —
 * `docs/platforms.md` has the tiering this sits under.
 */
const test = bunTest.skipIf(process.platform === "win32");

let home: string;
let stateDir: string;
beforeEach(async () => {
  // Short, beside the sandboxes, for the reason every temporary directory here
  // is short: something under it ends up in a path with a length limit.
  home = await fs.mkdtemp("/tmp/wks-");
  stateDir = path.join(home, "state");
});
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

/**
 * The real runner, with `$HOME` pointing into the test's own tree.
 *
 * That is the whole of the pretence: this machine is standing in for one werk
 * has been sent to, and everything a setup writes hangs off `$HOME`, so moving
 * it is enough to keep the run inside the test's own directory.
 */
function runnerIn(where: string): RemoteRunner {
  const real = spawnRunner();
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined && !key.startsWith("WERK_"))
      environment[key] = value;
  environment.HOME = where;
  return {
    run: (argv, options = {}) =>
      // `HOME` last either way. `spawnRunner` replaces the whole environment
      // when it is given one, and the setup's script is given the one a session
      // would get, whose `HOME` is the reader's.
      real.run(argv, {
        ...options,
        env: { ...(options.env ?? environment), HOME: where },
      }),
    start: (argv) => real.start(argv),
  };
}

const local: Host = { kind: "local", setup: "my-boxes" };

function context(over: Partial<WerkContext> = {}): WerkContext {
  const said: string[] = [];
  return {
    write: (text) => void said.push(text),
    writeError: (text) => void said.push(text),
    stdoutTTY: false,
    stdinTTY: false,
    columns: 80,
    style: createStyles(0),
    theme: defaultRoles,
    colourLevel: 0,
    json: false,
    noInput: true,
    yes: true,
    runtimeDir: path.join(home, "run"),
    stateDir,
    entry: "/werk/main.ts",
    hosts: { here: local },
    hostProblems: [],
    defaultHost: "here",
    setups: {},
    hostOrigin: {},
    ...over,
  };
}

const block = (over: Partial<SetupBlock>): SetupBlock => ({ run: [], ...over });

test(
  "a local host runs the block, stamps it, and does nothing the second time",
  async () => {
    const marker = path.join(home, "ran");
    const one = block({ run: [`printf 'x' >> ${JSON.stringify(marker)}`] });
    const ctx = context({ setups: { "my-boxes": one } });
    const runner = runnerIn(home);

    const first = await runHostSetup({
      ctx,
      name: "here",
      host: local,
      runner,
    });
    expect(first).toMatchObject({ state: "ran", commands: 1 });
    expect(await fs.readFile(marker, "utf8")).toBe("x");

    // The stamp is on the machine, under the block's own name, holding the
    // fingerprint werk computed here.
    const stamp = await fs.readFile(setupStampFile(home, "my-boxes"), "utf8");
    expect(stamp.trim()).toBe((await fingerprintSetup(one)).fingerprint);

    // A second run reads the hint, answers from it, and runs nothing.
    const second = await runHostSetup({
      ctx,
      name: "here",
      host: local,
      runner,
    });
    expect(second).toMatchObject({ state: "current", asked: false });
    expect(await fs.readFile(marker, "utf8")).toBe("x");

    // With the hint thrown away the machine answers instead, still without
    // running anything: the stamp is the authority and the hint only saves a
    // round trip.
    await fs.rm(path.join(stateDir, "hosts"), { recursive: true, force: true });
    const third = await runHostSetup({
      ctx,
      name: "here",
      host: local,
      runner,
    });
    expect(third).toMatchObject({ state: "current", asked: true });
    expect(await fs.readFile(marker, "utf8")).toBe("x");
  },
  TIMEOUT,
);

test(
  "the commands stop at the first failure, and nothing is stamped",
  async () => {
    const marker = path.join(home, "ran");
    const ctx = context({
      setups: {
        "my-boxes": block({
          run: [
            `printf 'one' >> ${JSON.stringify(marker)}`,
            "exit 3",
            `printf 'three' >> ${JSON.stringify(marker)}`,
          ],
        }),
      },
    });
    const failed = runHostSetup({
      ctx,
      name: "here",
      host: local,
      runner: runnerIn(home),
    });
    await expect(failed).rejects.toMatchObject({ code: "HOST_SETUP_FAILED" });
    // The message names the command that failed, which the script's own trap
    // is the only way of knowing.
    await expect(failed).rejects.toThrow("exit 3");
    expect(await fs.readFile(marker, "utf8")).toBe("one");
    await expect(
      fs.readFile(setupStampFile(home, "my-boxes"), "utf8"),
    ).rejects.toThrow();
  },
  TIMEOUT,
);

test(
  "a copy lands where `to` says, executable bits and all",
  async () => {
    const dots = path.join(home, "dots");
    await fs.mkdir(path.join(dots, "bin"), { recursive: true });
    await fs.writeFile(
      path.join(dots, "bin", "hello.sh"),
      "#!/bin/sh\necho hi\n",
    );
    await fs.chmod(path.join(dots, "bin", "hello.sh"), 0o755);
    await fs.writeFile(path.join(dots, "note.txt"), "read me\n");

    const landed = path.join(home, "share", "werk");
    const ctx = context({
      setups: {
        "my-boxes": block({
          copy: dots,
          to: "share/werk",
          run: [`test -x ${JSON.stringify(`${landed}/bin/hello.sh`)}`],
        }),
      },
    });
    const outcome = await runHostSetup({
      ctx,
      name: "here",
      host: local,
      runner: runnerIn(home),
    });
    expect(outcome).toMatchObject({ state: "ran", copied: 2 });
    // The directory's contents, not the directory: `<to>/bin`, never
    // `<to>/dots/bin`.
    expect(await fs.readFile(path.join(landed, "note.txt"), "utf8")).toBe(
      "read me\n",
    );
    expect(
      ((await fs.stat(path.join(landed, "bin", "hello.sh"))).mode & 0o100) !==
        0,
    ).toBe(true);
  },
  TIMEOUT,
);

test(
  "the host block's env reaches the commands",
  async () => {
    const marker = path.join(home, "seen");
    const host: Host = {
      kind: "local",
      setup: "my-boxes",
      env: { WERK_TEST_TOKEN: "from the block" },
    };
    const ctx = context({
      setups: {
        "my-boxes": block({
          run: [`printf '%s' "$WERK_TEST_TOKEN" > ${JSON.stringify(marker)}`],
        }),
      },
    });
    await runHostSetup({ ctx, name: "here", host, runner: runnerIn(home) });
    expect(await fs.readFile(marker, "utf8")).toBe("from the block");
  },
  TIMEOUT,
);

test(
  "a workspace setup runs in the workspace and leaves no stamp",
  async () => {
    const workspace = path.join(home, "workspaces", "fix-login");
    await fs.mkdir(workspace, { recursive: true });
    const ctx = context({
      setups: { bootstrap: block({ run: ["pwd > where"] }) },
      workspaceSetup: "bootstrap",
    });
    const outcome = await runWorkspaceSetup({
      ctx,
      name: "here",
      host: { kind: "local" },
      directory: workspace,
      repository: "werk",
      identity: "11111111-2222-3333-4444-555555555555",
      runner: runnerIn(home),
    });
    expect(outcome).toMatchObject({ state: "ran" });
    // `pwd` may resolve /tmp through a symbolic link, so what is asserted is
    // that the command ran where the workspace is rather than the spelling.
    expect(
      (await fs.readFile(path.join(workspace, "where"), "utf8")).trim(),
    ).toContain("fix-login");
    await expect(
      fs.readFile(setupStampFile(home, "bootstrap"), "utf8"),
    ).rejects.toThrow();
  },
  TIMEOUT,
);
