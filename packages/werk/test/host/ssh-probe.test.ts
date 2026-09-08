import { describe, expect, test } from "bun:test";
import {
  PROBE_END,
  PROBE_FIELDS,
  PROBE_SCRIPT,
  PROBE_START,
  parseProbe,
  probeFacts,
  sshProbe,
} from "../../src/host/ssh-probe.js";
import { HostError } from "../../src/host/types.js";
import { fakeRunner } from "./fake-runner.js";

/** A machine's answer, in the order the script prints it. */
const answer = (
  fields: Partial<Record<(typeof PROBE_FIELDS)[number], string>>,
) =>
  [
    PROBE_START,
    fields.uname ?? "Linux",
    fields.arch ?? "x86_64",
    fields.libc ?? "glibc",
    fields.home ?? "/home/mike",
    fields.uid ?? "1000",
    fields.git ?? "/usr/bin/git",
    fields.rsync ?? "",
    fields.loginPath ?? "/home/mike/.local/bin:/usr/bin",
    fields.claudeConfig ?? "",
    fields.installed ?? "",
    PROBE_END,
  ].join("\n") + "\n";

test("the field order is fixed and the script prints that many", () => {
  expect([...PROBE_FIELDS]).toEqual([
    "uname",
    "arch",
    "libc",
    "home",
    "uid",
    "git",
    "rsync",
    "loginPath",
    "claudeConfig",
    "installed",
  ]);
  expect(parseProbe("beast", answer({})).uname).toBe("Linux");
});

test("the fields are read positionally, not by guessing", () => {
  const facts = parseProbe(
    "beast",
    answer({
      uname: "Linux",
      arch: "aarch64",
      libc: "musl",
      home: "/root",
      uid: "0",
      git: "",
      rsync: "/usr/bin/rsync",
      loginPath: "/usr/bin",
      claudeConfig: "/root/.claude",
      installed: "0.0.0-abc1234",
    }),
  );
  expect(facts).toEqual({
    uname: "Linux",
    arch: "aarch64",
    libc: "musl",
    home: "/root",
    uid: 0,
    rsync: true,
    loginPath: "/usr/bin",
    claudeConfig: "/root/.claude",
    installed: "0.0.0-abc1234",
    werk: "/root/.local/share/werk/bin",
  });
  // git was empty, so the key is absent rather than an empty string.
  expect("git" in facts).toBe(false);
});

test("a machine with no rsync and no werk of its own reads that way", () => {
  const facts = parseProbe("beast", answer({}));
  expect(facts.rsync).toBe(false);
  expect(facts.installed).toBeUndefined();
  expect(facts.claudeConfig).toBeUndefined();
  expect(facts.git).toBe("/usr/bin/git");
});

test("a profile's banner before the sentinel costs nothing", () => {
  const banner =
    "Welcome to Ubuntu 24.04.1 LTS\n\n  System load: 0.4\nLast login: Tue\n";
  expect(parseProbe("beast", banner + answer({})).home).toBe("/home/mike");
});

test("CRLF from a machine that speaks it is stripped", () => {
  const crlf = answer({}).replaceAll("\n", "\r\n");
  expect(parseProbe("beast", crlf).arch).toBe("x86_64");
});

test("a home directory with a space in it survives", () => {
  expect(parseProbe("beast", answer({ home: "/home/mike smith" })).home).toBe(
    "/home/mike smith",
  );
  // And the derived path is built from it rather than from a re-split.
  expect(parseProbe("beast", answer({ home: "/home/mike smith" })).werk).toBe(
    "/home/mike smith/.local/share/werk/bin",
  );
});

describe("what werk refuses to read", () => {
  const refuses = (stdout: string, matching: RegExp) => {
    let raised: unknown;
    try {
      parseProbe("beast", stdout);
    } catch (error) {
      raised = error;
    }
    expect(raised).toBeInstanceOf(HostError);
    expect((raised as HostError).code).toBe("HOST_UNSUPPORTED");
    expect((raised as HostError).message).toMatch(matching);
  };

  test("no sentinel at all", () => {
    refuses("bash: werk: command not found\n", /did not answer/);
  });
  test("an opening sentinel with no close", () => {
    refuses(`${PROBE_START}\nLinux\n`, /did not answer/);
  });
  test("too few fields", () => {
    refuses(`${PROBE_START}\nLinux\nx86_64\n${PROBE_END}\n`, /2 fields/);
  });
  test("too many fields", () => {
    refuses(answer({}).replace(PROBE_END, `extra\n${PROBE_END}`), /11 fields/);
  });
  test("a C library werk does not recognise", () => {
    refuses(answer({ libc: "uclibc" }), /C library/);
  });
  test("a relative home directory", () => {
    refuses(answer({ home: "~" }), /absolute path/);
  });
  test("a uid that is not a number", () => {
    refuses(answer({ uid: "mike" }), /id -u/);
  });
  test("what came back is quoted in the failure", () => {
    let raised: HostError | undefined;
    try {
      parseProbe("beast", "bash: banner\n");
    } catch (error) {
      raised = error as HostError;
    }
    expect(raised?.detail).toContain("bash: banner");
  });
});

describe("the script itself", () => {
  test("asks about musl by looking for a loader rather than running ldd", () => {
    expect(PROBE_SCRIPT).toContain("ld-musl-");
    expect(PROBE_SCRIPT).not.toContain("ldd");
  });
  test("never tries to build JSON in sh", () => {
    expect(PROBE_SCRIPT).not.toContain("{");
  });
});

test("the probe runs under a login shell, once", async () => {
  const runner = fakeRunner(() => ({ stdout: answer({}) }));
  const facts = await probeFacts("beast", runner);
  expect(facts.home).toBe("/home/mike");
  expect(runner.calls).toHaveLength(1);
  expect(runner.calls[0]!.argv.at(-1)).toContain("-lc");
  expect(runner.calls[0]!.argv.at(-1)).toContain(PROBE_START);
});

describe("the HostProbe over ssh", () => {
  test("a non-zero status is an answer and not a failure", async () => {
    const runner = fakeRunner(() => ({ code: 1, stderr: "not found" }));
    const result = await sshProbe("beast", runner).run(
      ["command", "-v", "git"],
      { timeoutMs: 5_000 },
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe("not found");
  });
  test("a connection that failed still raises", async () => {
    const runner = fakeRunner(() => ({
      code: 255,
      stderr: "ssh: Could not resolve hostname beast",
    }));
    await expect(
      sshProbe("beast", runner).run(["true"], { timeoutMs: 5_000 }),
    ).rejects.toThrow(HostError);
  });
  test("login is asked for rather than assumed", async () => {
    const runner = fakeRunner();
    const probe = sshProbe("beast", runner);
    await probe.run(["true"], { timeoutMs: 5_000 });
    await probe.run(["true"], { timeoutMs: 5_000, login: true });
    // The command reaches the far side either way; what differs is whether a
    // login shell is asked for, so that is what this asserts rather than the
    // exact quoting the seam applies.
    expect(runner.calls[0]!.argv.at(-1)).toContain("true");
    expect(runner.calls[0]!.argv.join(" ")).not.toContain("-lc");
    expect(runner.calls[1]!.argv.at(-1)).toContain("-lc");
  });
});
