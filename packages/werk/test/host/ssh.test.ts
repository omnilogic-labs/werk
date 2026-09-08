import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  classifySshFailure,
  loginCommand,
  requireConnection,
  shellQuote,
  sshExecArgv,
  sshForwardArgv,
  SSH_COMMON_OPTIONS,
} from "../../src/host/ssh.js";
import {
  assertSocketFits,
  forwardKey,
  forwardSocketPath,
  SOCKET_PATH_LIMIT,
} from "../../src/host/forward.js";
import { HostError } from "../../src/host/types.js";

const option = (argv: string[], name: string): string | undefined => {
  const at = argv.findIndex(
    (value, index) =>
      argv[index - 1] === "-o" && value.startsWith(`${name}=`) && index > 0,
  );
  return at < 0 ? undefined : argv[at]!.slice(name.length + 1);
};

describe("the options every invocation carries", () => {
  const invocations: [string, string[]][] = [
    ["a plain exec", sshExecArgv("beast", "uname -s")],
    ["a login exec", sshExecArgv("beast", "uname -s", { login: true })],
    [
      "a forward",
      sshForwardArgv("beast", {
        kind: "unix",
        local: "/tmp/werk-1000/h/abc.sock",
        remote: "/tmp/werk-1000/daemon.sock",
      }),
    ],
  ];

  for (const [what, argv] of invocations) {
    test(`${what} pins the control master off`, () => {
      // A `~/.ssh/config` with `ControlMaster=auto` in it would otherwise route
      // werk through a shared master, and a blackholed master hangs rather than
      // failing. A command-line -o beats the file.
      expect(option(argv, "ControlMaster")).toBe("no");
      expect(option(argv, "ControlPath")).toBe("none");
    });
    test(`${what} never prompts and bounds the connection`, () => {
      expect(option(argv, "BatchMode")).toBe("yes");
      expect(option(argv, "ConnectTimeout")).toBe("10");
      expect(option(argv, "ForwardAgent")).toBe("no");
      expect(option(argv, "ServerAliveInterval")).toBe("15");
      expect(option(argv, "ServerAliveCountMax")).toBe("3");
    });
    test(`${what} leaves the host key policy to the caller's ssh`, () => {
      // Accepting a new or changed key on somebody's behalf is a larger claim
      // than werk makes about a machine it did not set up.
      expect(argv.join(" ")).not.toContain("StrictHostKeyChecking");
      expect(argv.join(" ")).not.toContain("UserKnownHostsFile");
    });
  }
});

test("ExitOnForwardFailure is on the forward and on nothing else", () => {
  const forward = sshForwardArgv("beast", {
    kind: "unix",
    local: "/tmp/a.sock",
    remote: "/tmp/b.sock",
  });
  expect(option(forward, "ExitOnForwardFailure")).toBe("yes");
  expect(SSH_COMMON_OPTIONS.join(" ")).not.toContain("ExitOnForwardFailure");
  expect(sshExecArgv("beast", "true").join(" ")).not.toContain(
    "ExitOnForwardFailure",
  );
});

test("a forward carries no session channel", () => {
  const forward = sshForwardArgv("beast", {
    kind: "unix",
    local: "/tmp/a.sock",
    remote: "/tmp/b.sock",
  });
  expect(forward).toContain("-N");
  expect(forward).not.toContain("-tt");
  expect(forward.at(-1)).toBe("beast");
});

test("a tcp forward spells the -L the other way", () => {
  const forward = sshForwardArgv("beast", {
    kind: "tcp",
    localPort: 41000,
    remoteHost: "127.0.0.1",
    remotePort: 49731,
  });
  expect(forward[forward.indexOf("-L") + 1]).toBe("41000:127.0.0.1:49731");
});

describe("quoting and the login shell", () => {
  test("a value with a quote in it survives", () => {
    expect(shellQuote(`/home/o'brien`)).toBe(`'/home/o'\\''brien'`);
  });
  test("a login command runs under the account's own shell", () => {
    expect(loginCommand("werk --version")).toBe(
      `"\${SHELL:-/bin/sh}" -lc 'werk --version'`,
    );
  });
  test("only the login form wraps", () => {
    expect(sshExecArgv("beast", "uname -s").at(-1)).toBe("uname -s");
    expect(sshExecArgv("beast", "uname -s", { login: true }).at(-1)).toContain(
      "-lc",
    );
  });
});

describe("the forwarded socket stays inside the length cap", () => {
  const pathological =
    "deploy@build-07-runner-eu-west-1.internal.very-long.example.com";

  test("a pathological destination costs nothing", () => {
    const socket = forwardSocketPath(
      "/tmp/werk-1000",
      forwardKey(pathological, "/run/user/1000/werk/daemon.sock"),
    );
    expect(Buffer.byteLength(socket)).toBeLessThan(SOCKET_PATH_LIMIT);
    expect(Buffer.byteLength(socket)).toBeLessThanOrEqual(31);
    expect(() => assertSocketFits(pathological, socket)).not.toThrow();
  });

  test("the key depends on both the machine and its socket", () => {
    expect(forwardKey("a", "/x.sock")).not.toBe(forwardKey("b", "/x.sock"));
    expect(forwardKey("a", "/x.sock")).not.toBe(forwardKey("a", "/y.sock"));
    // The separator is there so that these cannot collide.
    expect(forwardKey("ab", "/c")).not.toBe(forwardKey("a", "b/c"));
    expect(forwardKey("a", "/x.sock")).toMatch(/^[0-9a-f]{8}$/);
  });

  test("a runtime directory long enough to bust the cap is refused by name", () => {
    const socket = forwardSocketPath(
      path.join("/tmp", "w".repeat(120)),
      forwardKey("beast", "/tmp/daemon.sock"),
    );
    expect(() => assertSocketFits("beast", socket)).toThrow(
      /103|runtime directory/,
    );
  });
});

describe("what ssh's stderr is read as", () => {
  const failed = (stderr: string) =>
    classifySshFailure(
      "beast",
      { code: 255, stdout: "", stderr, timedOut: false },
      "reaching beast",
    );

  test("a changed host key says to settle it with ssh", () => {
    const error = failed(
      "@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@",
    );
    expect(error.code).toBe("HOST_AUTH_FAILED");
    expect(error.message).toContain("ssh beast");
  });
  test("an unknown host key under BatchMode says to accept it once", () => {
    const error = failed("Host key verification failed.");
    expect(error.code).toBe("HOST_AUTH_FAILED");
    expect(error.message).toContain("accept it");
  });
  test("a refused key is auth", () => {
    expect(failed("beast: Permission denied (publickey).").code).toBe(
      "HOST_AUTH_FAILED",
    );
  });
  for (const stderr of [
    "ssh: Could not resolve hostname beast: Name or service not known",
    "ssh: connect to host beast port 22: Connection timed out",
    "ssh: connect to host beast port 22: No route to host",
    "ssh: connect to host beast port 22: Connection refused",
  ])
    test(`${stderr.slice(0, 40)}… is unreachable`, () => {
      expect(failed(stderr).code).toBe("HOST_UNREACHABLE");
    });
  test("anything unrecognised is unreachable with ssh's own words kept", () => {
    const error = failed("ssh: something nobody has seen before");
    expect(error.code).toBe("HOST_UNREACHABLE");
    expect(error.message).toContain("something nobody has seen before");
  });
  test("a timeout the runner imposed is unreachable too", () => {
    expect(
      classifySshFailure(
        "beast",
        { code: null, stdout: "", stderr: "", timedOut: true },
        "reaching beast",
      ).code,
    ).toBe("HOST_UNREACHABLE");
  });
});

describe("requireConnection separates ssh's failure from the command's", () => {
  test("exit 255 is ssh's", () => {
    expect(() =>
      requireConnection(
        "beast",
        { code: 255, stdout: "", stderr: "Permission denied", timedOut: false },
        "asking beast",
      ),
    ).toThrow(HostError);
  });
  test("any other status belongs to the command and passes through", () => {
    expect(
      requireConnection(
        "beast",
        { code: 1, stdout: "", stderr: "", timedOut: false },
        "asking beast",
      ).code,
    ).toBe(1);
  });
});
