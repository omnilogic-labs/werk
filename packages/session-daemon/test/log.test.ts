import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createLogger, parseLogLevel } from "../src/log.js";
import { inspectSessionDaemon, readDaemonLog } from "../src/diagnostics.js";
import { ensureSessionDaemon } from "../src/local.js";
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});
async function directory() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "werk-log-"));
  directories.push(dir);
  return dir;
}
test("logger filters levels, bounds lines and escapes newlines", async () => {
  const dir = await directory(),
    file = path.join(dir, "daemon.log");
  const log = createLogger({ file, level: "warn" });
  log.write("info", "daemon.start");
  log.write("error", "uncaught", {
    error: "line\ninjection",
    stack: "x".repeat(20000),
  });
  log.close();
  const bytes = await fs.readFile(file);
  expect(bytes.length).toBe(8192);
  expect(bytes.toString().split("\n")).toHaveLength(2);
  expect(bytes.toString()).toContain("line\\ninjection");
  expect(bytes.toString()).not.toContain("daemon.start");
  expect(() => parseLogLevel("verbose")).toThrow("Invalid log level");
});
test("logger rotates into a bounded number of files and tail includes last error", async () => {
  const dir = await directory(),
    file = path.join(dir, "daemon.log");
  const log = createLogger({ file, maxBytes: 1, keep: 2 });
  for (let i = 0; i < 5; i++) log.write("error", "uncaught", { number: i });
  log.close();
  expect((await fs.readdir(dir)).sort()).toEqual([
    "daemon.log",
    "daemon.log.1",
    "daemon.log.2",
  ]);
  expect((await readDaemonLog(dir)).lastError).toContain("number=4");
});
test("logger I/O failure never throws", async () => {
  const dir = await directory();
  const log = createLogger({ file: dir });
  expect(() => log.write("error", "uncaught")).not.toThrow();
  expect(() => log.close()).not.toThrow();
});
test("info and doctor inspect missing daemon without creating files", async () => {
  const dir = await directory();
  const options = {
    runtimeDir: path.join(dir, "run"),
    stateDir: path.join(dir, "state"),
  };
  expect((await inspectSessionDaemon(options)).daemon).toBeNull();
  const report = await inspectSessionDaemon({ ...options, doctor: true });
  expect(report.daemon).toBeNull();
  expect(await fs.readdir(dir)).toEqual([]);
});
test("startup timeout includes daemon error tail", async () => {
  const dir = await directory();
  const log = createLogger({ file: path.join(dir, "daemon.log") });
  log.write("error", "daemon.stop", { reason: "startup-test-failure" });
  log.close();
  await expect(
    ensureSessionDaemon({
      runtimeDir: dir,
      stateDir: dir,
      daemonCommand: [process.execPath, "-e", "process.exit(1)"],
      startupTimeoutMs: 100,
    }),
  ).rejects.toThrow("startup-test-failure");
});
test("process error policy checkpoints and stops on tenth uncaught error", async () => {
  const module = path.resolve(import.meta.dir, "../src/log.ts");
  const script = `import { installDaemonErrorHandlers } from ${JSON.stringify(module)};
let checkpoints = 0, closes = 0, exitCode = null; const events = [];
const remove = installDaemonErrorHandlers({ log: { write(level, event) { events.push(event); }, close() {} }, checkpoint: async () => { checkpoints++; }, close: async () => { closes++; }, exit(code) { exitCode = code; } });
process.emit('unhandledRejection', new Error('rejection'), Promise.resolve());
for (let i = 0; i < 9; i++) process.emit('uncaughtException', new Error('fault'));
await Bun.sleep(10); const before = { checkpoints, closes, exitCode };
process.emit('uncaughtException', new Error('tenth')); await Bun.sleep(10); remove();
console.log(JSON.stringify({ before, checkpoints, closes, exitCode, events }));`;
  const child = Bun.spawn([process.execPath, "-e", script], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const result = JSON.parse(await new Response(child.stdout).text());
  expect(await child.exited).toBe(0);
  expect(result.before).toEqual({ checkpoints: 9, closes: 0, exitCode: null });
  expect(result.checkpoints).toBe(10);
  expect(result.closes).toBe(1);
  expect(result.exitCode).toBe(1);
  expect(result.events).toContain("unhandled-rejection");
});
test("daemon logs spawn, checkpoint and internal failures without request payloads", async () => {
  const { serveSessionDaemon, openLocalTransport } =
    await import("../src/index.js");
  const { loadTerminalEngine } = await import("@werk/terminal/bun");
  const { connectSessionClient } = await import("@werk/session");
  const { shellArgv, printCommand, endpointCredential } =
    await import("./commands.js");
  const dir = await directory(),
    stateDir = path.join(dir, "state");
  const events: { event: string; fields?: Record<string, unknown> }[] = [];
  let failAuthorization = false;
  const daemon = await serveSessionDaemon({
    runtimeDir: path.join(dir, "run"),
    stateDir,
    version: "test",
    engineFactory: await loadTerminalEngine(),
    log: {
      write(_level, event, fields) {
        events.push({ event, fields });
      },
      close() {},
    },
    limits: { checkpointIntervalMs: 60_000 },
    authorize() {
      if (failAuthorization) throw new Error("injected internal failure");
      return true;
    },
  });
  const client = await connectSessionClient({
    transport: await openLocalTransport(daemon.endpoint),
    credential: endpointCredential(daemon.endpoint),
  });
  try {
    await expect(
      client.create({
        argv: [path.join(dir, "missing")],
        size: { cols: 20, rows: 4 },
        cwd: dir,
      }),
    ).rejects.toThrow("Spawn failed");
    const session = await client.create({
      argv: shellArgv,
      env: { WERK_TEST_SECRET: "not-for-logs" },
      size: { cols: 20, rows: 4 },
      cwd: dir,
    });
    await daemon.checkpoint();
    // Checkpoints follow changes, so the record has to have something new to
    // save before an unwritable state directory can fail its write.
    const attachment = await client.attach(session.id, {
      permissions: { read: true, input: true },
      onEvent: () => {},
    });
    await attachment.writeInput(
      new TextEncoder().encode(printCommand("checkpoint-marker\n")),
    );
    const deadline = Date.now() + 5000;
    while (
      !(await client.readScreen(session.id)).includes("checkpoint-marker")
    ) {
      if (Date.now() > deadline)
        throw new Error("marker never reached the daemon");
      await Bun.sleep(10);
    }
    await fs.rename(stateDir, `${stateDir}-saved`);
    await fs.writeFile(stateDir, "not a directory");
    await daemon.checkpoint();
    failAuthorization = true;
    await expect(client.list()).rejects.toThrow("injected internal failure");
    const failure = events.find((entry) => entry.event === "checkpoint.failed");
    expect(failure?.fields?.sessionId).toBe(session.id);
    expect(
      events.some(
        (entry) =>
          entry.event === "session.spawn-failed" && entry.fields?.sessionId,
      ),
    ).toBe(true);
    expect(
      events.find((entry) => entry.event === "request.internal")?.fields?.stack,
    ).toContain("injected internal failure");
    expect(JSON.stringify(events)).not.toContain("not-for-logs");
  } finally {
    await client.close();
    await daemon.close();
  }
});
