import { expect, test } from "bun:test";
import {
  daemonEnvironment,
  sessionEnvironment,
  validateEnvironment,
} from "../src/environment";
import { clientEnvironment } from "../../werk/src/environment";

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

test("explicit environment is isolated and terminal identity is owned", () => {
  const source = {
    PATH: "/bin",
    SECRET: "stale",
    WERK_INTERNAL: "old",
    LINES: "90",
  };
  const env = sessionEnvironment(
    { API_KEY: "fresh", TERM: "wrong", WERK_SESSION: "wrong" },
    "session",
    "daemon",
    "1",
    source,
    false,
  );
  expect(env).toEqual({
    PATH: "/bin",
    API_KEY: "fresh",
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    TERM_PROGRAM: "werk",
    TERM_PROGRAM_VERSION: "1",
    WERK_SESSION: "session",
    WERK_DAEMON: "daemon",
  });
  const inherited = sessionEnvironment(
    undefined,
    "session",
    "daemon",
    "1",
    source,
    false,
  );
  expect(inherited.SECRET).toBe("stale");
  expect(inherited.WERK_INTERNAL).toBeUndefined();
  expect(inherited.LINES).toBeUndefined();
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

test("Windows environment merges case-insensitively with a runnable system base", () => {
  const env = sessionEnvironment(
    { Path: "caller", term: "wrong" },
    "s",
    "d",
    "1",
    {
      PATH: "daemon",
      SystemRoot: "C:\\Windows",
      ComSpec: "cmd.exe",
      SECRET: "old",
    },
    true,
  );
  expect(env.PATH).toBe("caller");
  expect(env.TERM).toBe("xterm-256color");
  expect(env.SYSTEMROOT).toBe("C:\\Windows");
  expect(env.COMSPEC).toBe("cmd.exe");
  expect(env.SECRET).toBeUndefined();
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
