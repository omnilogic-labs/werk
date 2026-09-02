// A session on `--engine=ghostty-ffi`: the daemon loads the ffi engine on
// demand, the session renders through the binding's toAnsiRect, and an
// engine that does not exist is refused with a clear error.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { connect, DaemonError, type Client } from "../client/index.ts";
import { Capture, sleep, stopDaemon, tempDir, waitFor } from "./_testlib.ts";

const dir = tempDir();
let client: Client;
let pid: number;

beforeAll(async () => {
  client = await connect({ dir });
  pid = client.daemon.pid;
});

afterAll(async () => {
  await stopDaemon(dir, client, pid);
});

test("run --engine=ghostty-ffi, attach, get a correct render; reattach after output", async () => {
  const { id } = await client.run({
    argv: [
      "sh",
      "-c",
      "printf 'one\\r\\n\\033[1mtwo\\033[0m\\r\\n'; sleep 1; echo three; sleep 30",
    ],
    engine: "ghostty-ffi",
    cols: 40,
    rows: 6,
  });
  const info = (await client.ls()).find((s) => s.id === id)!;
  expect(info.engine).toBe("ghostty-ffi");
  const first = new Capture(client);
  await first.attach(id, { cols: 40, rows: 6 });
  expect(await waitFor(() => first.all.includes("two"), 3000)).toBe(true);
  await first.att.detach();
  const deadline = Date.now() + 3000;
  while (!(await client.logs(id, "text")).includes("three")) {
    expect(Date.now()).toBeLessThan(deadline);
    await sleep(50);
  }
  const second = new Capture(client);
  await second.attach(id, { cols: 40, rows: 6 });
  expect(second.renders.length).toBe(1);
  // The render is the binding's toAnsiRect: every row addressed, bold kept, the cursor placed on row 4.
  expect(second.render).toContain("one");
  expect(second.render).toContain("\x1b[0;1mtwo");
  expect(second.render).toContain("three");
  expect(second.render).toMatch(/\x1b\[4;1H$/);
  const screen = await client.screen(id);
  expect(screen.text.split("\n").slice(0, 3)).toEqual(["one", "two", "three"]);
  expect(screen.cursor).toEqual({ x: 0, y: 3 });
  expect(screen.altScreen).toBe(false);
  await second.att.detach();
  await client.kill(id, "SIGKILL");
});

test("an engine that cannot be loaded is refused with the reason", async () => {
  await expect(
    client.run({ argv: ["sh"], engine: "ghostty-native-2" }),
  ).rejects.toThrow(DaemonError);
  try {
    await client.run({ argv: ["sh"], engine: "ghostty-native-2" });
  } catch (e) {
    expect((e as DaemonError).message).toContain('engine "ghostty-native-2"');
    expect((e as DaemonError).message).toContain("no engine registered");
  }
});
