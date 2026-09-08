/**
 * What a session is started with, from the client's side.
 *
 * The two bases are asserted next door, in
 * `packages/session-daemon/test/environment.test.ts`, against the daemon's own
 * merge. What is asserted here is the last word: a host block's `env` beats
 * both of them, and a block that says nothing changes neither.
 */
import { expect, test } from "bun:test";
import {
  clientEnvironment,
  environmentFor,
  remoteEnvironment,
} from "../src/environment.js";

const shell = {
  LANG: "en_GB.UTF-8",
  PATH: "/home/mike/.local/bin",
  EDITOR: "vi",
  API_KEY: "secret",
};

test("a block's env beats the allowlist that decides what leaves this machine", () => {
  const away = environmentFor(
    { env: { LANG: "C.UTF-8", CARGO_HOME: "/opt/cargo" } },
    false,
    shell,
  );
  // The allowlist bounds what travels by default. A name in the block is not a
  // default: somebody wrote it against that machine, so it goes as well.
  expect(away).toEqual({
    LANG: "C.UTF-8",
    CARGO_HOME: "/opt/cargo",
  });
  // And nothing the allowlist kept back arrives because of it.
  expect(away).not.toHaveProperty("API_KEY");
  expect(away).not.toHaveProperty("PATH");
});
test("a block's env beats the value this shell already has for the name", () => {
  const here = environmentFor({ env: { EDITOR: "werk edit --wait" } }, true, {
    ...shell,
    TERM: "xterm",
  });
  expect(here.EDITOR).toBe("werk edit --wait");
  // The rest of the denylist's answer is untouched: this is an overlay on it.
  expect(here.API_KEY).toBe("secret");
  expect(here).not.toHaveProperty("TERM");
});
test("a block with no env at all leaves both answers exactly as they were", () => {
  expect(environmentFor({}, true, shell)).toEqual(clientEnvironment(shell));
  expect(environmentFor({}, false, shell)).toEqual(remoteEnvironment(shell));
});
