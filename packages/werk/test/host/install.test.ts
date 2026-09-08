import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ensureRemoteWerk,
  localTarget,
  remoteLayout,
  type InstallOptions,
} from "../../src/host/install.js";
import { HostError, type RemoteFacts } from "../../src/host/types.js";
import { SOURCE_IDENTITY } from "../../src/runtime/version.js";
import { fakeRunner, type FakeRunner } from "./fake-runner.js";

let stateDir: string;
beforeAll(async () => {
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "werk-install-"));
});
afterAll(async () => {
  await fs.rm(stateDir, { recursive: true, force: true });
});

const facts = (over: Partial<RemoteFacts> = {}): RemoteFacts => ({
  uname: "Linux",
  arch: "x86_64",
  libc: "glibc",
  home: "/home/mike",
  uid: 1000,
  rsync: false,
  loginPath: "/usr/bin",
  werk: "/home/mike/.local/share/werk/bin",
  ...over,
});

/**
 * A runner that answers for a machine reporting `stamp`, and that pretends to
 * be `bun build` by writing the outfile it was asked for.
 */
function runnerFor(stamp: string | null, over: Partial<RemoteFacts> = {}) {
  const runner: FakeRunner = fakeRunner(async (argv) => {
    if (argv[1] === "build") {
      const outfile = argv[argv.indexOf("--outfile") + 1]!;
      await fs.mkdir(path.dirname(outfile), { recursive: true });
      // The bytes stand in for a 92 MB binary; what matters is that the same
      // source gives the same hash.
      await Bun.write(
        outfile,
        "werk-binary-for-" + argv[argv.indexOf("--compile") + 1],
      );
      return { code: 0 };
    }
    const remote = argv.at(-1) ?? "";
    if (remote.includes("cat ")) return { stdout: stamp === null ? "" : stamp };
    return { code: 0 };
  });
  return {
    runner,
    options: {
      sshHost: "beast",
      runner,
      facts: facts(over),
      target: { target: "bun-linux-x64" },
      stateDir,
      entry: "/repo/packages/werk/src/main.ts",
      compiled: false,
      execPath: "/usr/bin/bun",
    } satisfies InstallOptions,
  };
}

const sshCommands = (runner: FakeRunner) =>
  runner.calls
    .map((call) => call.argv.at(-1) ?? "")
    .filter((command) => !command.startsWith("/"));

test("the layout puts the version in the path", () => {
  const layout = remoteLayout("/home/mike", "bun-linux-x64", "0.0.0-abc1234");
  expect(layout.dir).toBe(
    "/home/mike/.local/share/werk/bin/bun-linux-x64-0.0.0-abc1234",
  );
  expect(layout.binary).toBe(`${layout.dir}/werk`);
  expect(layout.stampFile).toBe(`${layout.dir}/stamp`);
});

describe("ship or skip, read off the stamp", () => {
  test("a machine with nothing gets a binary", async () => {
    const { runner, options } = runnerFor(null);
    const installed = await ensureRemoteWerk(options);
    expect(installed.shipped).toBe(true);
    expect(installed.reason).toContain("had no");
    expect(runner.started.some((argv) => argv[0] === "tar")).toBe(true);
  });

  test("a machine already holding this exact build gets nothing", async () => {
    // Learn what the stamp would be, then answer with it.
    const first = runnerFor(null);
    const stamp = (await ensureRemoteWerk(first.options)).stamp;
    const { runner, options } = runnerFor(stamp);
    const installed = await ensureRemoteWerk(options);
    expect(installed.shipped).toBe(false);
    expect(installed.reason).toContain("already has");
    expect(runner.started).toHaveLength(0);
    expect(sshCommands(runner).some((c) => c.includes("tar -xzf"))).toBe(false);
  });

  test("a machine holding a different build gets a new one", async () => {
    const { runner, options } = runnerFor("0.0.0-something-else");
    const installed = await ensureRemoteWerk(options);
    expect(installed.shipped).toBe(true);
    expect(installed.reason).toContain("0.0.0-something-else");
    expect(runner.started.some((argv) => argv[0] === "tar")).toBe(true);
  });

  test("the check requires an executable binary as well as a stamp", async () => {
    // The far side answers with nothing unless both hold, which is what makes
    // a half-transferred binary re-ship rather than look installed.
    const { runner, options } = runnerFor(null);
    await ensureRemoteWerk(options);
    const check = sshCommands(runner).find((c) => c.includes("cat "))!;
    expect(check).toContain('[ -x "$d/werk" ]');
    expect(check).toContain('[ -f "$d/stamp" ]');
  });
});

describe("the order the far side does things in", () => {
  test("the stamp is removed first and written last", async () => {
    const { runner, options } = runnerFor(null);
    await ensureRemoteWerk(options);
    const transfer = sshCommands(runner).find((c) => c.includes("tar -xzf"))!;
    expect(transfer).toBeDefined();
    const removed = transfer.indexOf("rm -f");
    const extracted = transfer.indexOf("tar -xzf");
    const chmod = transfer.indexOf("chmod 755");
    const stamped = transfer.indexOf("printf");
    // An interrupted transfer must never leave something that looks installed.
    expect(removed).toBeGreaterThanOrEqual(0);
    expect(removed).toBeLessThan(extracted);
    expect(extracted).toBeLessThan(chmod);
    expect(chmod).toBeLessThan(stamped);
  });
});

describe("how the bytes travel", () => {
  test("tar by default, because it assumes only POSIX and a shell", async () => {
    const { runner, options } = runnerFor(null);
    const installed = await ensureRemoteWerk(options);
    expect(installed.reason).toContain("tar");
    expect(runner.calls.some((call) => call.argv[0] === "rsync")).toBe(false);
    // The archive is streamed rather than read into memory.
    const transfer = runner.calls.find((call) =>
      (call.argv.at(-1) ?? "").includes("tar -xzf"),
    );
    expect(transfer?.options?.stdin).toBeDefined();
  });

  test("rsync where the machine has one", async () => {
    const { runner, options } = runnerFor(null, { rsync: true });
    const installed = await ensureRemoteWerk(options);
    expect(installed.reason).toContain("rsync");
    const rsync = runner.calls.find((call) => call.argv[0] === "rsync")!;
    expect(rsync.argv).toContain("--chmod=F755");
    // rsync gets werk's own ssh options rather than a second spelling of them.
    expect(rsync.argv[rsync.argv.indexOf("-e") + 1]).toContain(
      "ControlPath=none",
    );
    expect(rsync.argv.at(-1)).toContain("beast:");
  });

  test("a machine whose rsync cannot be reached falls back to tar", async () => {
    // rsync runs `rsync --server` over a non-login ssh, so a machine with
    // rsync on the login PATH and not on the other one exists.
    const runner: FakeRunner = fakeRunner(async (argv) => {
      if (argv[0] === "rsync") return { code: 12, stderr: "rsync: not found" };
      if (argv[1] === "build") {
        const outfile = argv[argv.indexOf("--outfile") + 1]!;
        await fs.mkdir(path.dirname(outfile), { recursive: true });
        await Bun.write(outfile, "werk-binary");
        return { code: 0 };
      }
      return { code: 0 };
    });
    const installed = await ensureRemoteWerk({
      sshHost: "beast",
      runner,
      facts: facts({ rsync: true }),
      target: { target: "bun-linux-x64" },
      stateDir,
      entry: "/repo/packages/werk/src/main.ts",
      compiled: false,
      execPath: "/usr/bin/bun",
    });
    expect(installed.reason).toContain("tar");
  });
});

describe("where the binary comes from", () => {
  test("an interpreted client builds one for the target", async () => {
    const { runner, options } = runnerFor(null);
    await ensureRemoteWerk(options);
    const build = runner.calls.find((call) => call.argv[1] === "build")!;
    expect(build.argv[0]).toBe("/usr/bin/bun");
    expect(build.argv).toContain("--target=bun-linux-x64");
    expect(build.argv).toContain("WERK_COMPILED=true");
    expect(build.argv).toContain("--no-compile-autoload-dotenv");
    expect(build.argv).toContain("/repo/packages/werk/src/main.ts");
  });

  test("its stamp carries the binary's hash, not just `-source`", async () => {
    // `0.0.0-source` is the identity of every working tree, so on its own it
    // would leave a stale binary over there after the source had changed.
    const { options } = runnerFor(null);
    const installed = await ensureRemoteWerk(options);
    expect(installed.stamp.startsWith(`${SOURCE_IDENTITY}-`)).toBe(true);
    expect(installed.stamp).toMatch(/-[0-9a-f]{12}$/);
    expect(installed.binary).toContain(installed.stamp);
  });

  test("a build that fails says to run `bun run build`", async () => {
    const runner = fakeRunner((argv) =>
      argv[1] === "build" ? { code: 1, stderr: "no such command" } : {},
    );
    let raised: HostError | undefined;
    try {
      await ensureRemoteWerk({
        sshHost: "beast",
        runner,
        facts: facts(),
        target: { target: "bun-linux-x64" },
        stateDir,
        entry: "/repo/packages/werk/src/main.ts",
        compiled: false,
        execPath: "/usr/bin/bun",
      });
    } catch (error) {
      raised = error as HostError;
    }
    expect(raised?.code).toBe("HOST_BOOTSTRAP_FAILED");
    expect(raised?.message).toContain("bun run build");
  });

  test("a compiled client sends itself when the shapes match", async () => {
    const here = localTarget("linux", "x64")!;
    const binary = path.join(stateDir, "werk");
    await Bun.write(binary, "compiled-werk");
    const runner = fakeRunner(() => ({}));
    const installed = await ensureRemoteWerk({
      sshHost: "beast",
      runner,
      facts: facts(),
      target: { target: here },
      stateDir,
      entry: "/unused",
      build: "0.0.0-abc1234",
      compiled: true,
      execPath: binary,
      // The local platform decides whether this is the matching case, so the
      // test only asserts the branch it can reach on the machine it is on.
    }).catch((error: HostError) => error);
    if (localTarget() === here) {
      expect((installed as { shipped: boolean }).shipped).toBe(true);
      expect(runner.calls.some((call) => call.argv[1] === "build")).toBe(false);
    } else {
      expect((installed as HostError).code).toBe("HOST_BOOTSTRAP_FAILED");
    }
  });

  test("a compiled client cannot reach a machine of another shape", async () => {
    const runner = fakeRunner(() => ({}));
    let raised: HostError | undefined;
    try {
      await ensureRemoteWerk({
        sshHost: "beast",
        runner,
        facts: facts({ arch: "aarch64" }),
        target: { target: "bun-linux-arm64-musl" },
        stateDir,
        entry: "/unused",
        build: "0.0.0-abc1234",
        compiled: true,
        execPath: "/opt/werk/werk",
      });
    } catch (error) {
      raised = error as HostError;
    }
    expect(raised?.code).toBe("HOST_BOOTSTRAP_FAILED");
    expect(raised?.message).toContain("bun-linux-arm64-musl");
    // Nothing was compiled: it holds no source and no bun.
    expect(runner.calls.some((call) => call.argv[1] === "build")).toBe(false);
  });
});

describe("the local target", () => {
  test("is what bun would call this machine", () => {
    expect(localTarget("linux", "x64")).toBe("bun-linux-x64");
    expect(localTarget("linux", "arm64")).toBe("bun-linux-arm64");
  });
  test("is nothing for a machine werk cannot send itself from", () => {
    expect(localTarget("darwin", "arm64")).toBeUndefined();
    expect(localTarget("win32", "x64")).toBeUndefined();
  });
});
