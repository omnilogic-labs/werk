// The loopback TCP landing: what `WP_TCP_LISTEN` adds, what the token
// refuses, and that a daemon without it is unchanged. The landing exists so
// that a Windows client can reach a daemon through `ssh -L`, which forwards
// no Unix socket on either side; the socket is still the transport.

import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { connect, DaemonError } from "../client/index.ts";
import { stopDaemon, tempDir } from "./_testlib.ts";
import { daemonPaths } from "./paths.ts";
import { parseSocketTarget, readToken, TOKEN_FILE } from "./tcp.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  delete process.env.WP_TCP_LISTEN;
});

function fresh(): string {
  const dir = tempDir();
  cleanups.push(() => stopDaemon(dir));
  return dir;
}

test("a --socket string names a path or a loopback port", () => {
  expect(parseSocketTarget("/run/user/1000/werk-poc/wp.sock")).toEqual({
    kind: "unix",
    path: "/run/user/1000/werk-poc/wp.sock",
  });
  expect(parseSocketTarget("tcp:127.0.0.1:5555")).toEqual({
    kind: "tcp",
    hostname: "127.0.0.1",
    port: 5555,
  });
  expect(parseSocketTarget("tcp://localhost:80")).toEqual({
    kind: "tcp",
    hostname: "localhost",
    port: 80,
  });
  expect(() => parseSocketTarget("tcp:127.0.0.1:no")).toThrow();
  // A Windows path is a path, colon and all.
  expect(parseSocketTarget("C:\\Users\\x\\wp.sock").kind).toBe("unix");
});

test("no token file, and nothing on TCP, unless the environment asks", async () => {
  const dir = fresh();
  const client = await connect({ dir });
  expect(fs.existsSync(path.join(dir, TOKEN_FILE))).toBe(false);
  expect(fs.readdirSync(dir).sort()).toEqual(["wp.lock", "wp.log", "wp.sock"]);
  client.close();
});

test("with WP_TCP_LISTEN the daemon also answers on 127.0.0.1, but only with the token", async () => {
  const dir = fresh();
  process.env.WP_TCP_LISTEN = "1";
  const overSocket = await connect({ dir });
  const tokenFile = path.join(dir, TOKEN_FILE);
  expect(fs.existsSync(tokenFile)).toBe(true);
  const { port, token } = readToken(tokenFile);
  expect(port).toBeGreaterThan(0);
  expect(token.length).toBe(48);
  expect(fs.statSync(tokenFile).mode & 0o777).toBe(0o600);

  const overTcp = await connect({ socket: `tcp:127.0.0.1:${port}`, token });
  expect(overTcp.daemon.pid).toBe(overSocket.daemon.pid);
  expect((await overTcp.ls()).length).toBe(0);
  overTcp.close();

  // The same landing without the token, and with the wrong one.
  for (const bad of [undefined, "0".repeat(48)]) {
    const e = await connect({
      socket: `tcp:127.0.0.1:${port}`,
      token: bad,
    }).then(
      () => null,
      (err: unknown) => err,
    );
    expect(e).toBeInstanceOf(DaemonError);
    expect((e as DaemonError).code).toBe("unauthorised");
  }

  // The socket is unchanged: still there, still this user's alone.
  const paths = daemonPaths(dir);
  expect(fs.statSync(paths.socket).mode & 0o777).toBe(0o600);
  overSocket.close();
});
