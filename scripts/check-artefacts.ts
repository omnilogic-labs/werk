import {
  mkdtemp,
  copyFile,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { connectSessionClient } from "../packages/session/dist/index.js";
import { openLocalTransport } from "../packages/session-daemon/dist/index.js";
import { createTerminalReplica } from "../packages/terminal/dist/index.js";
import { loadTerminalEngine } from "../packages/terminal/dist/bun/index.js";
const repository = resolve(import.meta.dir, "..");
for (const name of [
  "terminal",
  "terminal-beamterm",
  "session",
  "session-daemon",
]) {
  const manifest = JSON.parse(
    await readFile(join(repository, "packages", name, "package.json"), "utf8"),
  );
  assert.equal(manifest.private, true);
  assert.ok(manifest.files.includes("dist"));
  for (const entry of Object.values(manifest.exports) as any[]) {
    if (typeof entry === "string") {
      await stat(join(repository, "packages", name, entry));
      continue;
    }
    await stat(join(repository, "packages", name, entry.types));
    await stat(join(repository, "packages", name, entry.default));
  }
}
const browser = join(repository, "examples/session-web/dist");
for (const name of await readdir(browser)) {
  if (!name.endsWith(".js") || name === "server.js") continue;
  const text = await readFile(join(browser, name), "utf8");
  assert.ok(
    !/\bBun\.|bun:ffi|node:|werk-poc/.test(text),
    `Browser boundary violation in ${name}`,
  );
}
assert.ok((await stat(join(browser, "terminal.wasm"))).size > 100000);
assert.ok(
  (await stat(join(browser, "beamterm_renderer_bg.wasm"))).size > 100000,
);
if (process.platform === "win32") {
  console.log(
    "Portable artefact checks passed; native PTY hosting is explicitly unsupported on this runtime.",
  );
  process.exit(0);
}
const directory = await mkdtemp(join(tmpdir(), "werk-artefact-"));
const binary = join(directory, "werk");
await copyFile(join(repository, "packages/werk/dist/werk"), binary);
const runtimeDir = join(directory, "runtime"),
  stateDir = join(directory, "state");
const globalArgs = ["--runtime-dir", runtimeDir, "--state-dir", stateDir];
let pid: number | undefined;
let client: Awaited<ReturnType<typeof connectSessionClient>> | undefined;
async function cli(...args: string[]) {
  const child = Bun.spawn([binary, ...args, ...globalArgs], {
    cwd: directory,
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = new Response(child.stdout).text(),
    error = new Response(child.stderr).text();
  const timeout = setTimeout(() => child.kill(), 15000);
  const code = await child.exited;
  clearTimeout(timeout);
  assert.equal(code, 0, await error);
  return output;
}
async function waitFor<T>(
  body: () => Promise<T>,
  predicate: (value: T) => boolean,
) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = await body();
    if (predicate(value)) return value;
    await Bun.sleep(20);
  }
  throw new Error("Artefact condition timed out");
}
async function connect() {
  const endpoint = JSON.parse(
    await readFile(join(runtimeDir, "endpoint.json"), "utf8"),
  );
  return connectSessionClient({
    transport: await openLocalTransport(endpoint),
    requestTimeoutMs: 3000,
  });
}
async function stopDaemon() {
  if (pid) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
    await waitFor(async () => {
      try {
        await stat(join(runtimeDir, "endpoint.json"));
        return false;
      } catch {
        return true;
      }
    }, Boolean);
    pid = undefined;
  }
}
try {
  assert.match(await cli("help"), /create/);
  await cli("list");
  pid = Number(await readFile(join(runtimeDir, "daemon.pid"), "utf8"));
  // The copied binary starts a detached owner using only its embedded assets.
  const createdProcess = Bun.spawn(
    [
      binary,
      "create",
      ...globalArgs,
      "--cols",
      "40",
      "--rows",
      "8",
      "--name",
      "artefact",
      "--label",
      "test=packaged",
      "--",
      "/bin/sh",
      "-c",
      'printf ready; while IFS= read -r line; do printf "received:%s\\n" "$line"; done',
    ],
    { cwd: directory, stdout: "pipe", stderr: "pipe" },
  );
  const createdOutput = await new Response(createdProcess.stdout).text();
  assert.equal(
    await createdProcess.exited,
    0,
    await new Response(createdProcess.stderr).text(),
  );
  const created = JSON.parse(createdOutput);
  assert.equal(created.name, "artefact");
  assert.match(await cli("info"), /capabilities/);
  client = await connect();
  await waitFor(
    () => client!.readScreen(created.id),
    (s) => s.includes("ready"),
  );
  const replica = createTerminalReplica(await loadTerminalEngine());
  let replicaError: unknown;
  const attachment = await client.attach(created.id, {
    permissions: { read: true, input: true },
    onEvent: (e) => {
      void replica.apply(e).catch((error) => (replicaError = error));
    },
  });
  await attachment.writeInput(new TextEncoder().encode("first\n"));
  await attachment.resize({ cols: 53, rows: 11 });
  await waitFor(
    () => client!.readScreen(created.id),
    (s) => s.includes("received:first"),
  );
  await waitFor(
    async () => replica.readScreen(),
    (s) => s.includes("received:first"),
  );
  assert.equal(replicaError, undefined);
  await attachment.detach();
  replica.dispose();
  await client.close();
  client = undefined;
  assert.equal(JSON.parse(await cli("list"))[0].state, "running");
  assert.match(await cli("logs", created.id), /received:first/);
  // Exercise Buffer-backed stdin through the compiled consumer, then detach on EOF.
  const attached = Bun.spawn([binary, "attach", created.id, ...globalArgs], {
    cwd: directory,
    stdin: "pipe",
    stdout: "ignore",
    stderr: "pipe",
  });
  attached.stdin.write("second\n");
  attached.stdin.end();
  const attachTimer = setTimeout(() => attached.kill(), 10000);
  assert.equal(
    await attached.exited,
    0,
    await new Response(attached.stderr).text(),
  );
  clearTimeout(attachTimer);
  client = await connect();
  await waitFor(
    () => client!.readScreen(created.id),
    (s) => s.includes("received:second"),
  );
  const reconnect = createTerminalReplica(await loadTerminalEngine());
  const second = await client.attach(created.id, {
    permissions: { read: true, input: false },
    onEvent: (e) => {
      void reconnect.apply(e).catch((error) => (replicaError = error));
    },
  });
  await waitFor(
    async () => reconnect.readScreen(),
    (s) => s.includes("received:second"),
  );
  assert.equal(reconnect.readScreen(), await client.readScreen(created.id));
  await second.detach();
  reconnect.dispose();
  await client.close();
  client = undefined;
  await stopDaemon();
  await cli("list");
  pid = Number(await readFile(join(runtimeDir, "daemon.pid"), "utf8"));
  const recovered = JSON.parse(await cli("list"));
  assert.equal(recovered[0].state, "exited");
  assert.equal(recovered[0].checkpoint.decodable, true);
  assert.match(await cli("logs", created.id), /received:second/);
  await cli("remove", created.id);
  assert.deepEqual(JSON.parse(await cli("list")), []);
  console.log(
    "Compiled binary outside checkout: detached create, stdin input, reconnect, resize, screen recovery and removal passed. Browser boundaries, assets and built declarations passed.",
  );
} finally {
  await client?.close();
  await stopDaemon().catch(() => {
    if (pid)
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
  });
  await rm(directory, { recursive: true, force: true });
}
