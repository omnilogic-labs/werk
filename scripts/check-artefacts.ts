import {
  mkdir,
  mkdtemp,
  copyFile,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
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
  "palette",
  "terminal",
  "terminal-beamterm",
  "session",
  "session-daemon",
  "workspace",
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
  if (!name.endsWith(".js") || name === "server.js" || name === "bridge.js")
    continue;
  const text = await readFile(join(browser, name), "utf8");
  assert.ok(
    !/\bBun\.|["']bun:|["']node:/.test(text),
    `Browser boundary violation in ${name}`,
  );
}
assert.ok((await stat(join(browser, "terminal.wasm"))).size > 100000);
assert.ok(
  (await stat(join(browser, "beamterm_renderer_bg.wasm"))).size > 100000,
);
const directory = await mkdtemp(join(tmpdir(), "werk-artefact-"));
const binary = join(
  directory,
  process.platform === "win32" ? "werk.exe" : "werk",
);
await copyFile(
  join(
    repository,
    "packages/werk/dist",
    process.platform === "win32" ? "werk.exe" : "werk",
  ),
  binary,
);
const fixture = join(directory, "echo.js");
await writeFile(
  fixture,
  'process.stdout.write("ready\\n"); let pending=""; for await (const chunk of Bun.stdin.stream()) { pending += new TextDecoder().decode(chunk); let i; while ((i=pending.indexOf("\\n")) >= 0) { console.log("received:"+pending.slice(0,i).trim()); pending=pending.slice(i+1); } }',
);
const runtimeDir = join(directory, "runtime"),
  stateDir = join(directory, "state");
// `werk create` makes a workspace, and a workspace is a git worktree, so it
// needs a repository with a commit to branch from. The point of this check is
// that the binary works away from this checkout, so it brings its own rather
// than borrowing one. The identity flags let it commit on a runner that has
// none configured.
const checkout = join(directory, "checkout");
await mkdir(checkout, { recursive: true });
async function git(...args: string[]) {
  const child = Bun.spawn(
    [
      "git",
      "-c",
      "user.name=werk artefact check",
      "-c",
      "user.email=artefact@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd: checkout, stdout: "ignore", stderr: "pipe" },
  );
  assert.equal(
    await child.exited,
    0,
    `git ${args.join(" ")}: ${await new Response(child.stderr).text()}`,
  );
}
await git("init", "-q", "-b", "main", ".");
await writeFile(join(checkout, "README.md"), "committed\n");
await git("add", "README.md");
await git("commit", "-q", "-m", "init");
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
  label = "",
) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const value = await body();
    if (predicate(value)) return value;
    await Bun.sleep(20);
  }
  throw new Error(`Artefact condition timed out${label ? `: ${label}` : ""}`);
}
// $stateDir/daemon.json is the daemon's own record of itself, written after it starts
// serving, so a fresh read may still show the previous daemon; wait for one that is neither
// missing nor the pid we just killed.
async function daemonPid(previous?: number) {
  return waitFor(
    async () => {
      try {
        const record = JSON.parse(
          await readFile(join(stateDir, "daemon.json"), "utf8"),
        );
        return Number(record?.pid);
      } catch {
        return Number.NaN;
      }
    },
    (value) => Number.isInteger(value) && value > 0 && value !== previous,
    `daemon.json pid (not ${previous})`,
  );
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
  pid = await daemonPid();
  // Outside a repository there is nothing to branch from, and the binary says
  // so rather than starting a session anyway. This is the refusal that made the
  // check need a checkout of its own.
  const refused = Bun.spawn(
    [
      binary,
      "create",
      "--json",
      ...globalArgs,
      "--",
      process.execPath,
      fixture,
    ],
    { cwd: directory, stdout: "ignore", stderr: "pipe" },
  );
  const refusal = await new Response(refused.stderr).text();
  assert.equal(await refused.exited, 2, refusal);
  assert.equal(JSON.parse(refusal.trim()).error.code, "NOT_A_REPOSITORY");
  // The copied binary starts a detached owner using only its embedded assets.
  const createdProcess = Bun.spawn(
    [
      binary,
      "create",
      "--json",
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
      process.execPath,
      fixture,
    ],
    { cwd: checkout, stdout: "pipe", stderr: "pipe" },
  );
  const createdOutput = await new Response(createdProcess.stdout).text();
  assert.equal(
    await createdProcess.exited,
    0,
    await new Response(createdProcess.stderr).text(),
  );
  const created = JSON.parse(createdOutput);
  assert.equal(created.name, "artefact");
  // The packaged binary branched the repository it was run in and put the
  // session in the worktree it made, rather than in the directory it was run
  // from.
  assert.equal(created.cwd, created.workspace.directory);
  assert.notEqual(created.cwd, checkout);
  assert.match(await cli("info", "--json"), /capabilities/);
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
  assert.equal(JSON.parse(await cli("list", "--json"))[0].state, "running");
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
  // Wait for the periodic persisted running-state checkpoint before abrupt death.
  await waitFor(
    async () => {
      try {
        return JSON.parse(
          await readFile(join(stateDir, `${created.id}.json`), "utf8"),
        );
      } catch {
        return undefined;
      }
    },
    (value) =>
      value?.info?.state === "running" &&
      value?.info?.checkpoint?.time > created.createdAt + 1000,
  );
  const killed = pid!;
  process.kill(killed, "SIGKILL");
  await Bun.sleep(300);
  pid = undefined;
  await cli("list");
  pid = await daemonPid(killed);
  const recovered = JSON.parse(await cli("list", "--json"));
  assert.equal(recovered[0].state, "lost");
  assert.equal(recovered[0].checkpoint.decodable, true);
  assert.match(await cli("logs", created.id), /received:second/);
  // Attaching to a record with no live process returns instead of hanging and reports the
  // outcome on stderr; a lost record has none for the daemon to report. stdin stays open,
  // as it is for a person at a terminal: EOF detaches, which would race the ended event.
  const dead = Bun.spawn([binary, "attach", created.id, ...globalArgs], {
    cwd: directory,
    stdin: "pipe",
    stdout: "ignore",
    stderr: "pipe",
  });
  const deadTimer = setTimeout(() => dead.kill(), 10000);
  const deadError = await new Response(dead.stderr).text();
  assert.equal(await dead.exited, 0, deadError);
  clearTimeout(deadTimer);
  assert.match(deadError, /was lost/);
  // A record the daemon did see finish reports its status instead. The global flags go
  // before `--`, or they become arguments to the session's own command.
  const exiting = Bun.spawn(
    [
      binary,
      "create",
      "--json",
      ...globalArgs,
      "--name",
      "artefact-exit",
      "--",
      process.execPath,
      "-e",
      "process.exit(3)",
    ],
    { cwd: checkout, stdout: "pipe", stderr: "pipe" },
  );
  const exitingOutput = await new Response(exiting.stdout).text();
  assert.equal(
    await exiting.exited,
    0,
    await new Response(exiting.stderr).text(),
  );
  const shortLived = JSON.parse(exitingOutput);
  await waitFor(
    async () => JSON.parse(await cli("list", "--json")),
    (sessions: { id: string; state: string }[]) =>
      sessions.some((s) => s.id === shortLived.id && s.state === "exited"),
    "shortLived exited",
  );
  const finished = Bun.spawn([binary, "attach", shortLived.id, ...globalArgs], {
    cwd: directory,
    stdin: "pipe",
    stdout: "ignore",
    stderr: "pipe",
  });
  const finishedTimer = setTimeout(() => finished.kill(), 10000);
  const finishedError = await new Response(finished.stderr).text();
  assert.equal(await finished.exited, 0, finishedError);
  clearTimeout(finishedTimer);
  assert.match(finishedError, /status 3/);
  await cli("remove", shortLived.id);
  await cli("remove", created.id);
  assert.deepEqual(JSON.parse(await cli("list", "--json")), []);
  console.log(
    "Compiled binary outside checkout: workspace creation, detached create, stdin input, reconnect, resize, abrupt-death lost-screen recovery, ended-session outcome reporting and removal passed. Browser boundaries, assets and built declarations passed.",
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
