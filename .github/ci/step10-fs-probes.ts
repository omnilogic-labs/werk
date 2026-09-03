// What the Windows filesystem and runtime say about the things
// `launch.test.ts`, `tcp.test.ts` and the two compiled-binary spikes ask
// them: a live socket's reparse point under `stat`, `lstat`, `readdir` and
// `readlink`; a stale one under the same and under `Bun.connect`; the ACL
// of the runtime directory, the lock and the token file; whether a junction
// or a file symlink reaches the socket; whether a launcher process that
// spawned the daemon can exit while it is being read from a pipe; and what
// `os.tmpdir()` honours. One `PROBE <name>: <verdict>` line per question,
// never a throw. Run from the repository root:
//
//   bun run .github/ci/step10-fs-probes.ts

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { connect } from "../../packages/werk-poc/src/client/index.ts";
import { spawnDaemon } from "../../packages/werk-poc/src/daemon/launch.ts";
import { daemonPaths } from "../../packages/werk-poc/src/daemon/paths.ts";
import { platform } from "../../packages/werk-poc/src/platform/index.ts";

function say(name: string, verdict: string): void {
  console.log(`PROBE ${name}: ${verdict.replace(/\r?\n/g, " | ")}`);
}

function firstLine(e: unknown): string {
  const s = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return s.split("\n")[0]!.trim();
}

function errCode(fn: () => unknown): string {
  try {
    const r = fn();
    return `ok ${typeof r === "object" ? JSON.stringify(r) : String(r)}`;
  } catch (e) {
    return `${(e as NodeJS.ErrnoException).code ?? "?"} ${firstLine(e)}`;
  }
}

function run(argv: string[]): string {
  try {
    const r = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
    return `${r.stdout?.toString() ?? ""}${r.stderr?.toString() ?? ""}`
      .replace(/\r/g, "")
      .trim();
  } catch (e) {
    return `(${argv[0]} not run: ${firstLine(e)})`;
  }
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wp-fs-"));
}

function dirents(dir: string): string {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .map(
        (d) =>
          `${d.name}[file=${d.isFile()} dir=${d.isDirectory()} symlink=${d.isSymbolicLink()} socket=${d.isSocket()}]`,
      )
      .join(", ");
  } catch (e) {
    return `readdir failed: ${firstLine(e)}`;
  }
}

function fsAnswers(label: string, file: string): void {
  say(
    `${label}-existsSync`,
    errCode(() => fs.existsSync(file)),
  );
  say(
    `${label}-statSync`,
    errCode(() => {
      const st = fs.statSync(file);
      return `mode=${st.mode.toString(8)} socket=${st.isSocket()} file=${st.isFile()} symlink=${st.isSymbolicLink()}`;
    }),
  );
  say(
    `${label}-lstatSync`,
    errCode(() => {
      const st = fs.lstatSync(file);
      return `mode=${st.mode.toString(8)} socket=${st.isSocket()} file=${st.isFile()} symlink=${st.isSymbolicLink()}`;
    }),
  );
  say(
    `${label}-readlinkSync`,
    errCode(() => fs.readlinkSync(file)),
  );
  say(
    `${label}-accessSync`,
    errCode(() => fs.accessSync(file)),
  );
  say(`${label}-readdir`, dirents(path.dirname(file)));
  say(`${label}-icacls`, run(["icacls", file]));
}

async function alive(pid: number): Promise<boolean> {
  return platform.isAlive(pid);
}

async function waitGone(pid: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!(await alive(pid))) return true;
    await Bun.sleep(20);
  }
  return !(await alive(pid));
}

console.log(
  `platform=${process.platform} arch=${process.arch} bun=${Bun.version} release=${os.release()} user=${os.userInfo().username} tmpdir=${os.tmpdir()}`,
);
say("whoami", run(["whoami"]));

const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wp-fs-state-"));
process.env.WP_STATE_DIR = stateRoot;

// ------------------------------------------------------------ live socket
{
  const dir = tempDir();
  const paths = daemonPaths(dir);
  process.env.WP_TCP_LISTEN = "1";
  const started = await spawnDaemon({ dir });
  delete process.env.WP_TCP_LISTEN;
  say(
    "daemon-start",
    `pid ${started.pid} report=${JSON.stringify(started.report)} in ${started.ms.toFixed(0)} ms`,
  );
  let pid = started.pid;
  try {
    const c = await connect({ dir, autostart: false });
    pid = c.daemon.pid;
    c.close();
    say("daemon-hello", `ok pid ${pid}`);
  } catch (e) {
    say("daemon-hello", `fail — ${firstLine(e)}`);
  }
  fsAnswers("live-socket", paths.socket);
  say(
    "dir-statSync",
    errCode(() => fs.statSync(dir).mode.toString(8)),
  );
  say("dir-icacls", run(["icacls", dir]));
  say(
    "lock-statSync",
    errCode(() => fs.statSync(paths.lock).mode.toString(8)),
  );
  say("lock-icacls", run(["icacls", paths.lock]));
  const token = path.join(dir, "wp.tcp");
  say(
    "token-statSync",
    errCode(() => fs.statSync(token).mode.toString(8)),
  );
  say("token-icacls", run(["icacls", token]));
  say("state-icacls", run(["icacls", stateRoot]));
  say("temp-icacls", run(["icacls", os.tmpdir()]));
  say("localappdata-icacls", run(["icacls", process.env.LOCALAPPDATA ?? ""]));

  // A chmod'd copy: does mode 0o600 change anything an ACL can see?
  const restricted = path.join(dir, "restricted.txt");
  fs.writeFileSync(restricted, "x", { mode: 0o600 });
  say("chmod600-icacls", run(["icacls", restricted]));
  say(
    "chmod600-statSync",
    errCode(() => fs.statSync(restricted).mode.toString(8)),
  );

  // Explicit paths: a junction to the directory, and a file symlink to the socket.
  const elsewhere = tempDir();
  const junction = path.join(elsewhere, "link");
  say(
    "junction-create",
    errCode(() => fs.symlinkSync(dir, junction, "junction")),
  );
  const viaJunction = path.join(junction, "wp.sock");
  {
    const t0 = performance.now();
    try {
      const c = await connect({ socket: viaJunction, timeoutMs: 3000 });
      say(
        "junction-connect",
        `ok pid ${c.daemon.pid} in ${(performance.now() - t0).toFixed(0)} ms`,
      );
      c.close();
    } catch (e) {
      say(
        "junction-connect",
        `fail — ${firstLine(e)} after ${(performance.now() - t0).toFixed(0)} ms`,
      );
    }
  }
  const forwarded = path.join(elsewhere, "forwarded.sock");
  say(
    "symlink-create",
    errCode(() => fs.symlinkSync(paths.socket, forwarded)),
  );
  say("symlink-readdir", dirents(elsewhere));
  {
    const t0 = performance.now();
    try {
      const c = await connect({ socket: forwarded, timeoutMs: 3000 });
      say(
        "symlink-connect",
        `ok pid ${c.daemon.pid} in ${(performance.now() - t0).toFixed(0)} ms`,
      );
      c.close();
    } catch (e) {
      say(
        "symlink-connect",
        `fail — ${firstLine(e)} after ${(performance.now() - t0).toFixed(0)} ms`,
      );
    }
  }
  // A path nothing listens on, with the rejection caught rather than asserted.
  {
    const missing = path.join(elsewhere, "nothing.sock");
    const t0 = performance.now();
    const e = await connect({ socket: missing, timeoutMs: 1000 }).then(
      () => null,
      (err: unknown) => err,
    );
    say(
      "missing-connect",
      `${e ? firstLine(e) : "connected?!"} after ${(performance.now() - t0).toFixed(0)} ms`,
    );
  }

  // A launcher of its own: a bun process that autostarts against a fresh
  // directory, prints the pid, and exits while this process reads its stdout.
  {
    const dir2 = tempDir();
    const client = pathToFileURL(
      path.resolve("packages/werk-poc/src/client/index.ts"),
    ).href;
    const code = `const { connect } = await import(${JSON.stringify(client)}); const c = await connect({ dir: ${JSON.stringify(dir2)} }); console.log(c.daemon.pid); c.close();`;
    const t0 = performance.now();
    const r = Bun.spawnSync([process.execPath, "-e", code], {
      stdout: "pipe",
      stderr: "pipe",
      env: process.env as Record<string, string>,
    });
    const ms = performance.now() - t0;
    const out = r.stdout.toString().trim();
    const err = r.stderr.toString().replace(/\r/g, "").trim().split("\n")[0];
    const pid2 = Number(out);
    say(
      "launcher-leaves",
      `exit ${r.exitCode} in ${ms.toFixed(0)} ms, stdout=${JSON.stringify(out)} ${err ?? ""}; daemon alive after: ${pid2 ? await alive(pid2) : "no pid"}`,
    );
    if (pid2) {
      try {
        const c = await connect({ dir: dir2, autostart: false });
        say(
          "launcher-daemon-answers",
          `pid ${c.daemon.pid} (launcher said ${pid2})`,
        );
        await c.shutdown();
        c.close();
        await waitGone(pid2, 3000);
      } catch (e) {
        say("launcher-daemon-answers", `fail — ${firstLine(e)}`);
      }
    }
    say("launcher-dir-readdir", dirents(dir2));
    fs.rmSync(dir2, { recursive: true, force: true });
  }

  // A session child that announces its own pid to a file.
  {
    try {
      const c = await connect({ dir, autostart: false });
      const pidFile = path.join(dir, "child.pid");
      const code = `await Bun.write(${JSON.stringify(pidFile)}, String(process.pid)); await Bun.sleep(30_000);`;
      const { id } = await c.run({ argv: [process.execPath, "-e", code] });
      const end = Date.now() + 5000;
      while (Date.now() < end && !fs.existsSync(pidFile)) await Bun.sleep(20);
      const childPid = Number(fs.readFileSync(pidFile, "utf8"));
      const info = (await c.ls()).find((s) => s.id === id);
      say(
        "child-pid-file",
        `session ${id} status=${info?.status} child pid ${childPid} alive=${await alive(childPid)}`,
      );
      await c.shutdown();
      c.close();
      const gone = await waitGone(pid, 3000);
      const childGone = await waitGone(childPid, 3000);
      say(
        "shutdown-takes-child",
        `daemon gone=${gone} child gone=${childGone}`,
      );
      fsAnswers("after-shutdown-socket", paths.socket);
      pid = 0;
    } catch (e) {
      say("child-pid-file", `fail — ${firstLine(e)}`);
    }
  }
  if (pid) {
    try {
      const c = await connect({ dir, autostart: false });
      await c.shutdown();
      c.close();
      await waitGone(pid, 3000);
    } catch {}
  }
  fs.rmSync(elsewhere, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
}

// ----------------------------------------------------------- stale socket
{
  const dir = tempDir();
  const paths = daemonPaths(dir);
  const first = await connect({ dir });
  const pid1 = first.daemon.pid;
  process.kill(pid1, "SIGKILL");
  const gone = await waitGone(pid1, 3000);
  first.close();
  say("stale-killed", `pid ${pid1} gone=${gone}`);
  fsAnswers("stale-socket", paths.socket);
  {
    const t0 = performance.now();
    const e = await connect({ dir, autostart: false, timeoutMs: 5000 }).then(
      () => null,
      (err: unknown) => err,
    );
    say(
      "stale-connect",
      `${e ? firstLine(e) : "connected?!"} after ${(performance.now() - t0).toFixed(0)} ms`,
    );
  }
  {
    const t0 = performance.now();
    try {
      const second = await connect({ dir });
      say(
        "stale-replaced",
        `new pid ${second.daemon.pid} (old ${pid1}) in ${(performance.now() - t0).toFixed(0)} ms`,
      );
      fsAnswers("replaced-socket", paths.socket);
      await second.shutdown();
      second.close();
      await waitGone(second.daemon.pid, 3000);
    } catch (e) {
      say(
        "stale-replaced",
        `fail — ${firstLine(e)} after ${(performance.now() - t0).toFixed(0)} ms`,
      );
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

// ------------------------------------------------------------- tmpdir env
{
  const probeDir = tempDir();
  const code = `console.log(require("node:os").tmpdir())`;
  for (const env of [
    { TMPDIR: probeDir },
    { TEMP: probeDir },
    { TMP: probeDir },
    { TMPDIR: probeDir, TEMP: probeDir, TMP: probeDir },
  ]) {
    const r = Bun.spawnSync([process.execPath, "-e", code], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        PATH: process.env.PATH ?? "",
        SystemRoot: process.env.SystemRoot ?? "",
        ...env,
      },
    });
    say(
      `tmpdir-${Object.keys(env).join("+")}`,
      `${r.stdout.toString().trim()} (want ${probeDir})`,
    );
  }
  fs.rmSync(probeDir, { recursive: true, force: true });
}

say(
  "dist-binary",
  `wp=${fs.existsSync("packages/werk-poc/dist/wp")} wp.exe=${fs.existsSync("packages/werk-poc/dist/wp.exe")}`,
);

fs.rmSync(stateRoot, { recursive: true, force: true });
