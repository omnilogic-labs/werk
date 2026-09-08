/**
 * Writing a config file, end to end, through the real binary.
 *
 * The unit tests either side of this settle the splice and the wizard's shape.
 * What only a real run can say is that the guard fires before anything is
 * opened for writing, that `--json` still means one value on stdout when the
 * command is a conversation, and that a file somebody hand-edited comes back
 * with their comments in it byte for byte.
 *
 * Every run goes through the shared sandbox, so the config directory it writes
 * to is a temporary one and nothing here can reach the config file of whoever
 * is running the suite. Each case gets a directory of its own inside that
 * sandbox, because they read back what they wrote.
 */
import { afterAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runWerk, sandbox } from "./support/run.js";

const TIMEOUT = 30000;
const box = await sandbox("wkc");
afterAll(box.dispose);

let made = 0;
/** A config directory of its own for each case. */
const directory = () => join(box.root, `c${made++}`);

async function werk(
  configDir: string,
  ...args: string[]
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await runWerk({
    sandbox: box,
    args,
    env: { WERK_CONFIG_DIR: configDir, NO_COLOR: "1" },
    timeoutMs: TIMEOUT,
  });
}

const fileIn = (configDir: string) => join(configDir, "config.toml");
const read = (configDir: string) =>
  readFile(fileIn(configDir), "utf8").catch(() => undefined);

test(
  "config setup with nothing to answer it exits 2 and writes nothing",
  async () => {
    const configDir = directory();
    const ran = await werk(configDir, "config", "setup");
    expect(ran.code).toBe(2);
    expect(ran.stderr).toContain("pass --host and --ssh");
    expect(await read(configDir)).toBeUndefined();
  },
  TIMEOUT,
);

test(
  "the flag form answers with one JSON value and writes the file",
  async () => {
    const configDir = directory();
    const ran = await werk(
      configDir,
      "--json",
      "--no-input",
      "--yes",
      "config",
      "setup",
      "--host",
      "beast",
      "--ssh",
      "mike@10.0.0.7",
      "--workspace-root",
      "/srv/werk/workspaces",
      "--default",
    );
    expect(ran.code, ran.stderr).toBe(0);
    expect(ran.stdout.endsWith("\n")).toBe(true);
    const body = ran.stdout.slice(0, -1);
    expect(body.includes("\n")).toBe(false);
    const value = JSON.parse(body) as {
      file: string;
      created: boolean;
      hosts: { name: string; action: string }[];
      settings: { key: string; to: string }[];
    };
    expect(value.file).toBe(fileIn(configDir));
    expect(value.created).toBe(true);
    expect(value.hosts).toEqual([
      {
        name: "beast",
        action: "added",
        host: {
          kind: "ssh",
          sshHost: "mike@10.0.0.7",
          workspaceRoot: "/srv/werk/workspaces",
        },
      },
    ] as never);
    expect(value.settings).toEqual([
      { key: "defaultHost", from: "local", to: "beast" },
    ] as never);

    // And what it wrote is what werk reads back, at the layer it wrote it to.
    const listed = await werk(configDir, "--json", "config", "list");
    expect(listed.code).toBe(0);
    const rows = JSON.parse(listed.stdout) as {
      key: string;
      value: unknown;
      layer: string;
    }[];
    expect(rows.find((row) => row.key === "hosts.beast")).toEqual({
      key: "hosts.beast",
      value: {
        kind: "ssh",
        sshHost: "mike@10.0.0.7",
        workspaceRoot: "/srv/werk/workspaces",
      },
      layer: "user",
    });
    expect(rows.find((row) => row.key === "defaultHost")?.layer).toBe("user");
    // The human table says the same thing in the words a person reads.
    const shown = await werk(configDir, "config", "list");
    expect(
      shown.stdout.split("\n").find((line) => line.startsWith("hosts.beast")),
    ).toContain("user file");
  },
  TIMEOUT,
);

/** The comments somebody wrote are their work, and only their own line moves. */
test(
  "config set leaves every comment byte for byte where it was",
  async () => {
    const configDir = directory();
    const before = [
      "# what this file is",
      "",
      "# how loud the daemon is",
      'logLevel = "warn"',
      "scrollbackBytes = 4096",
      "",
      "# the machine in the cupboard",
      "[hosts.beast]",
      'kind = "ssh"',
      "# reached over the wired network",
      'sshHost = "10.0.0.7"',
      "",
      "# nothing below here yet",
      "",
    ].join("\n");
    await Bun.write(fileIn(configDir), before);

    const ran = await werk(configDir, "config", "set", "logLevel", "debug");
    expect(ran.code, ran.stderr).toBe(0);
    const after = (await read(configDir))!;

    expect(after).toBe(
      before.replace('logLevel = "warn"', 'logLevel = "debug"'),
    );
    const comments = (text: string) =>
      text.split("\n").filter((line) => line.trimStart().startsWith("#"));
    expect(comments(after)).toEqual(comments(before));
    const changed = after
      .split("\n")
      .filter((line, index) => line !== before.split("\n")[index]);
    expect(changed).toEqual(['logLevel = "debug"']);
  },
  TIMEOUT,
);

test(
  "running setup twice with the same name replaces the block",
  async () => {
    const configDir = directory();
    const first = await werk(
      configDir,
      "--no-input",
      "--yes",
      "config",
      "setup",
      "--host",
      "t",
      "--ssh",
      "one.example",
    );
    expect(first.code, first.stderr).toBe(0);
    const second = await werk(
      configDir,
      "--no-input",
      "--yes",
      "config",
      "setup",
      "--host",
      "t",
      "--ssh",
      "two.example",
    );
    expect(second.code, second.stderr).toBe(0);
    const after = (await read(configDir))!;
    expect(after.match(/\[hosts\.t\]/g)).toHaveLength(1);
    expect(after).toContain('sshHost = "two.example"');
    expect(after).not.toContain("one.example");
  },
  TIMEOUT,
);

test(
  "config unset says what the value falls back to",
  async () => {
    const configDir = directory();
    await werk(configDir, "config", "set", "logLevel", "debug");
    const ran = await werk(configDir, "config", "unset", "logLevel");
    expect(ran.code, ran.stderr).toBe(0);
    expect(ran.stdout).toContain("no longer set");
    expect(ran.stdout).toContain("info");
    expect((await read(configDir))!).not.toContain("logLevel");
  },
  TIMEOUT,
);

test(
  "config set says so when a stronger layer is beating what it wrote",
  async () => {
    const configDir = directory();
    const ran = await runWerk({
      sandbox: box,
      args: ["config", "set", "logLevel", "debug"],
      env: {
        WERK_CONFIG_DIR: configDir,
        WERK_LOG_LEVEL: "error",
        NO_COLOR: "1",
      },
      timeoutMs: TIMEOUT,
    });
    expect(ran.code, ran.stderr).toBe(0);
    expect(ran.stdout).toContain("WERK_LOG_LEVEL=error is beating it");
    expect((await read(configDir))!).toContain('logLevel = "debug"');
  },
  TIMEOUT,
);

test(
  "config set refuses a value the file would refuse",
  async () => {
    const configDir = directory();
    const ran = await werk(configDir, "config", "set", "logLevel", "loud");
    expect(ran.code).toBe(2);
    expect(ran.stderr).toContain("logLevel must be one of");
    expect(await read(configDir)).toBeUndefined();
  },
  TIMEOUT,
);

test(
  "config check answers for the machine werk is running on",
  async () => {
    const configDir = directory();
    await Bun.write(
      fileIn(configDir),
      '[hosts.beast]\nkind = "ssh"\nsshHost = "beast"\n',
    );
    const ran = await werk(configDir, "--json", "config", "check");
    expect(ran.code, ran.stderr).toBe(0);
    const rows = JSON.parse(ran.stdout) as {
      host: string;
      probed: boolean;
      report: { reachable: string };
    }[];
    expect(rows.map((row) => row.host).sort()).toEqual(["beast", "local"]);
    // Nothing can reach an ssh host yet, which reads as "not checked" and not
    // as "unreachable".
    expect(rows.find((row) => row.host === "beast")?.probed).toBe(false);
    expect(rows.find((row) => row.host === "local")?.report.reachable).toBe(
      "yes",
    );
  },
  TIMEOUT,
);
