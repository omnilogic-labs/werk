/**
 * What werk would have run to put bytes on a machine.
 *
 * Nothing here opens a connection: `fakeRunner` collects every argv, so the
 * assertions are about the commands werk builds and the order it puts them in.
 * `install.test.ts` covers the same file from its one real caller; this covers
 * the seam itself, including `sendTree`, which the installer does not use.
 */
import { describe, expect, test } from "bun:test";
import {
  sendFile,
  sendTree,
  type SendOptions,
} from "../../src/host/transfer.js";
import { HostError } from "../../src/host/types.js";
import { fakeRunner, type FakeRunner } from "./fake-runner.js";

const options = (
  runner: FakeRunner,
  over: Partial<SendOptions> = {},
): SendOptions => ({
  sshHost: "beast",
  runner,
  rsync: false,
  prepare: "mkdir -p /tmp/dest",
  finish: "printf ok > /tmp/dest/stamp",
  what: "sending a thing to beast",
  ...over,
});

/** The command each `ssh` invocation carried, which is its last argument. */
const sshCommands = (runner: FakeRunner) =>
  runner.calls
    .filter((call) => call.argv[0] === "ssh")
    .map((call) => call.argv.at(-1) ?? "");

describe("sendFile", () => {
  test("tars the file and runs prepare, the extract and finish in order", async () => {
    const runner = fakeRunner();
    expect(
      await sendFile(options(runner), "/local/werk", "/tmp/dest/werk"),
    ).toBe("tar");

    expect(runner.started).toEqual([
      ["tar", "-czf", "-", "-C", "/local", "werk"],
    ]);
    const command = sshCommands(runner)[0]!;
    const prepared = command.indexOf("mkdir -p /tmp/dest");
    const extracted = command.indexOf("tar -xzf");
    const finished = command.indexOf("printf ok");
    expect(prepared).toBeGreaterThanOrEqual(0);
    expect(prepared).toBeLessThan(extracted);
    // Last, so an interrupted transfer never looks finished.
    expect(extracted).toBeLessThan(finished);
  });

  test("moves the file into place when it arrives under another name", async () => {
    const runner = fakeRunner();
    await sendFile(options(runner), "/local/werk-linux-x64", "/tmp/dest/werk");
    expect(sshCommands(runner)[0]).toContain(
      "mv -f '/tmp/dest/werk-linux-x64' '/tmp/dest/werk'",
    );
  });

  test("no move when the names already agree", async () => {
    const runner = fakeRunner();
    await sendFile(options(runner), "/local/werk", "/tmp/dest/werk");
    expect(sshCommands(runner)[0]).not.toContain("mv -f");
  });

  test("rsync where the machine has one, prepare and finish either side", async () => {
    const runner = fakeRunner();
    expect(
      await sendFile(
        options(runner, { rsync: true, rsyncChmod: "F755" }),
        "/local/werk",
        "/tmp/dest/werk",
      ),
    ).toBe("rsync");

    const rsync = runner.calls.find((call) => call.argv[0] === "rsync")!;
    expect(rsync.argv).toContain("--chmod=F755");
    expect(rsync.argv.at(-1)).toBe("beast:/tmp/dest/werk");
    // Nothing was piped: rsync moves the bytes itself.
    expect(runner.started).toHaveLength(0);
    expect(sshCommands(runner)).toEqual([
      "mkdir -p /tmp/dest",
      "printf ok > /tmp/dest/stamp",
    ]);
  });

  test("a failed rsync falls back to tar rather than raising", async () => {
    // A machine with rsync on the login PATH and not on the other one.
    const runner = fakeRunner((argv) =>
      argv[0] === "rsync" ? { code: 127, stderr: "rsync: not found" } : {},
    );
    expect(
      await sendFile(
        options(runner, { rsync: true }),
        "/local/werk",
        "/tmp/dest/werk",
      ),
    ).toBe("tar");
    expect(runner.started).toHaveLength(1);
  });

  test("a far-side failure carries the code the caller asked for", async () => {
    const runner = fakeRunner((argv) =>
      argv[0] === "ssh" ? { code: 3, stderr: "no room" } : {},
    );
    const failed = sendFile(
      options(runner, { code: "HOST_UNSUPPORTED" }),
      "/local/werk",
      "/tmp/dest/werk",
    );
    await expect(failed).rejects.toBeInstanceOf(HostError);
    await expect(failed).rejects.toMatchObject({ code: "HOST_UNSUPPORTED" });
  });
});

describe("sendTree", () => {
  test("carries the directory's contents rather than the directory", async () => {
    const runner = fakeRunner();
    expect(await sendTree(options(runner), "/local/setup", "/tmp/dest")).toBe(
      "tar",
    );
    // `-C dir .`, so the far side gets <to>/<entry> and not <to>/setup/<entry>.
    expect(runner.started).toEqual([
      ["tar", "-czf", "-", "-C", "/local/setup", "."],
    ]);
    expect(sshCommands(runner)[0]).toContain("tar -xzf - -C '/tmp/dest'");
  });

  test("never reaches for rsync, even where the machine has one", async () => {
    const runner = fakeRunner();
    await sendTree(
      options(runner, { rsync: true }),
      "/local/setup",
      "/tmp/dest",
    );
    expect(runner.calls.some((call) => call.argv[0] === "rsync")).toBe(false);
  });

  test("runs prepare, the extract and finish in that order", async () => {
    const runner = fakeRunner();
    await sendTree(options(runner), "/local/setup", "/tmp/dest");
    const command = sshCommands(runner)[0]!;
    expect(command.indexOf("mkdir -p /tmp/dest")).toBeLessThan(
      command.indexOf("tar -xzf"),
    );
    expect(command.indexOf("tar -xzf")).toBeLessThan(
      command.indexOf("printf ok"),
    );
  });
});
