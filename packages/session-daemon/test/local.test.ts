import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { connectSessionClient } from "@werk/session";
import { loadTerminalEngine } from "@werk/terminal/bun";
import { createSessionDaemon } from "../src/index.js";
import {
  defaultSessionRuntimeDir,
  ensureSessionDaemon,
  openLocalTransport,
  socketTransport,
} from "../src/local.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});
async function directory() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "werk-path-"));
  directories.push(dir);
  return dir;
}
function ensure(runtimeDir: string) {
  // An unsafe path must fail before inspecting or spawning this command.
  return ensureSessionDaemon({
    runtimeDir,
    stateDir: runtimeDir,
    daemonCommand: [],
  });
}
test("runtime default survives logout and ignores temporary directory settings", () => {
  expect(
    defaultSessionRuntimeDir(
      { XDG_RUNTIME_DIR: "/run/user/42", TMPDIR: "/other" },
      "linux",
      42,
    ),
  ).toBe("/tmp/werk-42");
  expect(defaultSessionRuntimeDir({}, "darwin", 501)).toBe("/tmp/werk-501");
  expect(
    defaultSessionRuntimeDir(
      {},
      "win32",
      0,
      "C:\\Users\\test\\AppData\\Local\\Temp",
    ),
  ).toBe("C:\\Users\\test\\AppData\\Local\\Temp\\werk");
  expect(
    defaultSessionRuntimeDir({ WERK_RUNTIME_DIR: "/custom" }, "win32"),
  ).toBe("/custom");
});
test("client rejects public runtime directory before startup", async () => {
  const dir = await directory();
  await fs.chmod(dir, 0o755);
  await expect(ensure(dir)).rejects.toThrow("mode 0700");
});
test("client refuses a symlink runtime directory", async () => {
  const dir = await directory();
  const link = path.join(dir, "link");
  await fs.symlink(dir, link);
  await expect(ensure(link)).rejects.toThrow("not a symbolic link");
});
test("client measures socket path in bytes before startup", async () => {
  await expect(ensure(`/tmp/${"é".repeat(46)}`)).rejects.toThrow("103 bytes");
});
test("client does not trust a public endpoint record", async () => {
  const dir = await directory();
  await fs.writeFile(path.join(dir, "endpoint.json"), "{}", { mode: 0o644 });
  await expect(ensure(dir)).rejects.toThrow(
    "Endpoint record must be a private file",
  );
});
test.skipIf(process.getuid?.() !== 0)(
  "client rejects another owner's runtime directory",
  async () => {
    const dir = await directory();
    await fs.chown(dir, 12345, 12345);
    await expect(ensure(dir)).rejects.toThrow("another user");
  },
);
test("a tcp endpoint is dialled on loopback and carries its credential", async () => {
  const dir = await directory();
  const credential = "the-credential";
  const daemon = await createSessionDaemon({
    runtimeDir: path.join(dir, "run"),
    stateDir: path.join(dir, "state"),
    version: "test",
    engineFactory: await loadTerminalEngine(),
    authenticate: async (supplied) => {
      if (supplied !== credential) throw new Error("Invalid credential");
      return { id: "forwarded" };
    },
  });
  const server = net.createServer((socket) =>
    daemon.accept(socketTransport(socket)),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = {
    kind: "tcp" as const,
    host: "127.0.0.1" as const,
    port: (server.address() as net.AddressInfo).port,
    credential,
  };
  try {
    await expect(
      connectSessionClient({
        transport: await openLocalTransport(endpoint),
        credential: "wrong",
        requestTimeoutMs: 1000,
      }),
    ).rejects.toThrow();
    const client = await connectSessionClient({
      transport: await openLocalTransport(endpoint),
      credential: endpoint.credential,
    });
    try {
      expect((await client.daemonInfo()).id).toBe(daemon.info.id);
    } finally {
      await client.close();
    }
  } finally {
    server.close();
    await daemon.close();
  }
});
