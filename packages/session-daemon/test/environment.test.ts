import { describe, expect, test } from "bun:test";
import {
  daemonEnvironment,
  sessionEnvironment,
  validateEnvironment,
} from "../src/environment";
import {
  clientEnvironment,
  remoteEnvironment,
  REMOTE_FORWARDED,
} from "../../werk/src/environment";

test("CLI forwards current caller values and removes terminal and shell state", () => {
  expect(
    clientEnvironment({
      API_KEY: "new",
      SSH_AUTH_SOCK: "/new",
      TMUX: "old",
      TERM: "old",
      PWD: "/old",
      GPG_TTY: "/old",
      missing: undefined,
    }),
  ).toEqual({ API_KEY: "new", SSH_AUTH_SOCK: "/new" });
  expect(clientEnvironment({ Term: "old", Path: "/bin" }, true)).toEqual({
    Path: "/bin",
  });
});

test("only the names travelling to another machine are forwarded there", () => {
  expect(
    remoteEnvironment({
      LANG: "en_GB.UTF-8",
      TZ: "Europe/London",
      NO_COLOR: "1",
      PATH: "/home/mike/.local/bin:/usr/bin",
      HOME: "/home/mike",
      SHELL: "/bin/zsh",
      TMPDIR: "/var/folders/xy/T/",
      SSH_AUTH_SOCK: "/private/tmp/ssh-abc/agent.501",
      AWS_SECRET_ACCESS_KEY: "secret",
      NVM_DIR: "/home/mike/.nvm",
      missing: undefined,
    }),
  ).toEqual({ LANG: "en_GB.UTF-8", TZ: "Europe/London", NO_COLOR: "1" });
});

test("nothing outside the remote allowlist can be forwarded by accident", () => {
  const everything = Object.fromEntries(
    [...REMOTE_FORWARDED, "PATH", "HOME", "API_KEY"].map((key) => [key, key]),
  );
  expect(Object.keys(remoteEnvironment(everything)).sort()).toEqual(
    [...REMOTE_FORWARDED].sort(),
  );
  expect(remoteEnvironment({})).toEqual({});
});

test("what the client sends is an overlay on the daemon's own environment", () => {
  const source = {
    PATH: "/daemon/bin",
    NVM_DIR: "/home/remote/.nvm",
    SECRET: "the daemon's",
    WERK_INTERNAL: "old",
    LINES: "90",
  };
  const env = sessionEnvironment(
    { API_KEY: "fresh", PATH: "/client/bin", TERM: "wrong" },
    "session",
    "daemon",
    "1",
    source,
    false,
  );
  // Named by the client, so the client's value wins.
  expect(env.PATH).toBe("/client/bin");
  expect(env.API_KEY).toBe("fresh");
  // Not named by the client, so the daemon's own value survives. This is the
  // rule: sending an environment narrows nothing.
  expect(env.NVM_DIR).toBe("/home/remote/.nvm");
  expect(env.SECRET).toBe("the daemon's");
  // The daemon's own run, not the session's.
  expect(env.WERK_INTERNAL).toBeUndefined();
  expect(env.LINES).toBeUndefined();
  // The last layer is werk's, whatever the client asked for.
  expect(env.TERM).toBe("xterm-256color");
  expect(env.TERM_PROGRAM).toBe("werk");
  expect(env.TERM_PROGRAM_VERSION).toBe("1");
  expect(env.WERK_SESSION).toBe("session");
  expect(env.WERK_DAEMON).toBe("daemon");
});

test("sending no environment at all is the same base as sending one", () => {
  const source = { PATH: "/daemon/bin", SECRET: "the daemon's", LINES: "90" };
  const sent = sessionEnvironment({}, "s", "d", "1", source, false);
  const none = sessionEnvironment(undefined, "s", "d", "1", source, false);
  expect(sent).toEqual(none);
  expect(none.SECRET).toBe("the daemon's");
});

test("daemon startup keeps only the documented base and configuration", () => {
  expect(
    daemonEnvironment(
      {
        HOME: "/home/test",
        PATH: "/bin",
        TMPDIR: "/tmp",
        WERK_LOG_LEVEL: "debug",
        XDG_STATE_HOME: "/state",
        SECRET: "secret",
        SSH_AUTH_SOCK: "/agent",
        TMUX: "old",
      },
      false,
    ),
  ).toEqual({
    HOME: "/home/test",
    PATH: "/bin",
    TMPDIR: "/tmp",
    WERK_LOG_LEVEL: "debug",
    XDG_STATE_HOME: "/state",
  });
});

test("Windows names merge case-insensitively and the caller's spelling wins once", () => {
  const env = sessionEnvironment(
    { Path: "caller", term: "wrong" },
    "s",
    "d",
    "1",
    {
      PATH: "daemon",
      SystemRoot: "C:\\Windows",
      ComSpec: "cmd.exe",
      SECRET: "the daemon's",
    },
    true,
  );
  expect(env.PATH).toBe("caller");
  expect(env.TERM).toBe("xterm-256color");
  expect(env.SYSTEMROOT).toBe("C:\\Windows");
  expect(env.COMSPEC).toBe("cmd.exe");
  expect(env.SECRET).toBe("the daemon's");
  expect(
    Object.keys(env).filter((key) => key.toUpperCase() === "PATH"),
  ).toHaveLength(1);
});

test("environment bounds count UTF-8 bytes and envp overhead", () => {
  expect(() =>
    validateEnvironment({ OK: "x".repeat(128 * 1024) }),
  ).not.toThrow();
  for (const env of [
    { KEY: "é".repeat(65537) },
    { ["é".repeat(129)]: "x" },
    { "a=b": "x" },
    { "a\0b": "x" },
    { KEY: "a\0b" },
    Object.fromEntries(Array.from({ length: 1025 }, (_, i) => [String(i), ""])),
    Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [String(i), "x".repeat(128 * 1024)]),
    ),
  ])
    expect(() => validateEnvironment(env)).toThrow("environment");
});

describe("werk's own directory on a session's PATH", () => {
  const bin = "/home/mike/.local/share/werk/bin/bun-linux-x64-0.0.0-abc/";
  const dir = bin.slice(0, -1);

  test("goes at the front, so `werk edit` in a session finds it", () => {
    const env = sessionEnvironment(
      undefined,
      "s",
      "d",
      "1",
      { PATH: "/usr/bin", WERK_BIN_DIR: dir },
      false,
    );
    expect(env.PATH).toBe(`${dir}:/usr/bin`);
    // The cause is the daemon's own business; a session sees only the effect.
    expect(env.WERK_BIN_DIR).toBeUndefined();
  });

  test("goes in front of a PATH the client sent, not behind it", () => {
    const env = sessionEnvironment(
      { PATH: "/client/bin" },
      "s",
      "d",
      "1",
      { PATH: "/usr/bin", WERK_BIN_DIR: dir },
      false,
    );
    expect(env.PATH).toBe(`${dir}:/client/bin`);
  });

  test("is the whole PATH when there was none", () => {
    const env = sessionEnvironment(
      undefined,
      "s",
      "d",
      "1",
      { WERK_BIN_DIR: dir },
      false,
    );
    expect(env.PATH).toBe(dir);
  });

  test("is added once, so a restarted session does not grow its PATH", () => {
    const env = sessionEnvironment(
      undefined,
      "s",
      "d",
      "1",
      { PATH: `${dir}:/usr/bin`, WERK_BIN_DIR: dir },
      false,
    );
    expect(env.PATH).toBe(`${dir}:/usr/bin`);
  });

  test("separates with a semicolon on Windows", () => {
    const env = sessionEnvironment(
      undefined,
      "s",
      "d",
      "1",
      { PATH: "C:\\Windows", WERK_BIN_DIR: "C:\\werk\\bin" },
      true,
    );
    expect(env.PATH).toBe("C:\\werk\\bin;C:\\Windows");
  });

  test("a daemon that did not say leaves PATH exactly as it was", () => {
    // A werk run from source says nothing, because the directory of a `bun`
    // holds no werk.
    const env = sessionEnvironment(
      undefined,
      "s",
      "d",
      "1",
      {
        PATH: "/usr/bin",
      },
      false,
    );
    expect(env.PATH).toBe("/usr/bin");
  });
});
