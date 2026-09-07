import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { defaultSessionRuntimeDir, ensureSessionDaemon } from "../src/local.js";

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
      { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" },
      "win32",
    ),
  ).toBe("C:\\Users\\test\\AppData\\Local\\werk\\run");
  expect(
    defaultSessionRuntimeDir({ WERK_RUNTIME_DIR: "/custom" }, "win32"),
  ).toBe("/custom");
});
test.skipIf(process.platform === "win32")(
  "client rejects public runtime directory before startup",
  async () => {
    const dir = await directory();
    await fs.chmod(dir, 0o755);
    await expect(ensure(dir)).rejects.toThrow("mode 0700");
  },
);
test.skipIf(process.platform === "win32")(
  "client refuses a symlink runtime directory",
  async () => {
    const dir = await directory();
    const link = path.join(dir, "link");
    await fs.symlink(dir, link);
    await expect(ensure(link)).rejects.toThrow("not a symbolic link");
  },
);
test.skipIf(process.platform === "win32")(
  "client measures socket path in bytes before startup",
  async () => {
    await expect(ensure(`/tmp/${"é".repeat(46)}`)).rejects.toThrow("103 bytes");
  },
);
test.skipIf(process.platform === "win32")(
  "client does not trust a public endpoint record",
  async () => {
    const dir = await directory();
    await fs.writeFile(path.join(dir, "endpoint.json"), "{}", { mode: 0o644 });
    await expect(ensure(dir)).rejects.toThrow(
      "Endpoint record must be a private file",
    );
  },
);
test.skipIf(process.platform === "win32" || process.getuid?.() !== 0)(
  "client rejects another owner's runtime directory",
  async () => {
    const dir = await directory();
    await fs.chown(dir, 12345, 12345);
    await expect(ensure(dir)).rejects.toThrow("another user");
  },
);
