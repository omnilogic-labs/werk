/**
 * The refusal a person on Windows meets, through the real binary.
 *
 * On Windows werk runs only as a client, so every command that would act on
 * the machine it is running on stops and says so. The unit tests in
 * `hosts.test.ts` and `commands.test.ts` reach the Windows answer from any
 * platform by passing `win32`; these run only where werk really is a client,
 * and see what a person there sees.
 */
import { afterAll, expect } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clientOnlyTest } from "./support/platform.js";
import { runWerk, sandbox } from "./support/run.js";

const TIMEOUT = 30000;
const box = await sandbox("wkco");
afterAll(box.dispose);

let made = 0;

/** A run with a config directory of its own, holding `config` if given. */
async function werk(config: string | undefined, ...args: string[]) {
  const configDir = join(box.root, `c${made++}`);
  if (config !== undefined)
    await Bun.write(join(configDir, "config.toml"), config);
  return await runWerk({
    sandbox: box,
    args,
    env: { WERK_CONFIG_DIR: configDir, NO_COLOR: "1" },
    timeoutMs: TIMEOUT,
  });
}

/** The refusal, in both registers, with the status a script reads. */
function expectRefused(
  ran: { code: number | null; stdout: string; stderr: string },
  json: boolean,
) {
  expect(ran.code, ran.stderr).toBe(1);
  expect(ran.stdout).toBe("");
  const message = json
    ? (
        JSON.parse(ran.stderr.trim()) as {
          error: { code: string; message: string };
        }
      ).error
    : { code: undefined, message: ran.stderr };
  if (json) expect(message.code).toBe("HOST_UNSUPPORTED");
  expect(message.message).toContain("On Windows werk runs only as a client");
  expect(message.message).toContain("`werk config setup`");
  return message.message;
}

clientOnlyTest(
  "werk list with no host is refused, and says what to do",
  async () => {
    const said = expectRefused(await werk(undefined, "list"), false);
    expect(said).toContain("nothing names a host");
    // Printed so the lane's log shows the sentence a person there reads.
    console.log(`werk list on Windows says:\n${said}`);
  },
  TIMEOUT,
);

clientOnlyTest(
  "werk list --host local is refused, naming the ssh hosts there are",
  async () => {
    const said = expectRefused(
      await werk(
        '[hosts.beast]\nkind = "ssh"\nsshHost = "beast"\n',
        "--json",
        "list",
        "--host",
        "local",
      ),
      true,
    );
    expect(said).toContain("defined: beast");
    console.log(`werk list --host local on Windows says:\n${said}`);
  },
  TIMEOUT,
);

clientOnlyTest(
  "a block written as a local host is refused rather than started",
  async () => {
    expectRefused(
      await werk(
        'defaultHost = "here"\n\n[hosts.here]\nkind = "local"\n',
        "--json",
        "list",
      ),
      true,
    );
  },
  TIMEOUT,
);

clientOnlyTest(
  "werk daemon endpoint --ensure starts nothing and is refused",
  async () => {
    const said = expectRefused(
      await werk(undefined, "daemon", "endpoint", "--ensure"),
      false,
    );
    expect(said).toContain("needs a werk daemon on this machine");
    console.log(`werk daemon endpoint on Windows says:\n${said}`);
  },
  TIMEOUT,
);

clientOnlyTest(
  "werk config lists no local host and no default host",
  async () => {
    const ran = await werk(undefined, "--json", "config", "list");
    expect(ran.code, ran.stderr).toBe(0);
    const rows = JSON.parse(ran.stdout) as { key: string; value: unknown }[];
    expect(rows.map((row) => row.key)).not.toContain("hosts.local");
    // Unset, which the machine shape writes the way it writes an unset
    // workspaceSetup: the row is there and carries no value.
    const row = rows.find((entry) => entry.key === "defaultHost");
    expect(row).toBeDefined();
    expect(row?.value).toBeUndefined();
  },
  TIMEOUT,
);

clientOnlyTest(
  "the runtime directory has a default with nothing in the environment to build it from",
  async () => {
    // The sandbox sets WERK_RUNTIME_DIR and passes --runtime-dir, either of
    // which would answer before the default is asked. Every app data variable
    // Windows sets is removed too, so the default cannot lean on one.
    const appData = Object.fromEntries(
      Object.keys(process.env)
        .filter((key) => /appdata/i.test(key))
        .map((key) => [key, undefined]),
    );
    const configDir = join(box.root, `c${made++}`);
    const ran = await runWerk({
      sandbox: box,
      dirFlags: false,
      args: ["config", "get", "runtimeDir"],
      env: {
        WERK_CONFIG_DIR: configDir,
        ...appData,
        WERK_RUNTIME_DIR: undefined,
        NO_COLOR: "1",
      },
      timeoutMs: TIMEOUT,
    });
    expect(ran.code, ran.stderr).toBe(0);
    expect(ran.stdout.trim()).toBe(join(tmpdir(), "werk"));
    console.log(`werk config get runtimeDir on Windows says: ${ran.stdout}`);
  },
  TIMEOUT,
);
