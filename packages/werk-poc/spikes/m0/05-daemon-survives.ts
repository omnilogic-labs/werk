// Probe 5: does a PTY held by a detached Bun daemon survive (a) the parent
// exiting and (b) the parent's own controlling terminal closing? Three roles
// in one file: `probe` (default), `parent` and `daemon`.

import {
  compiled,
  deadline,
  finish,
  log,
  psInfo,
  selfArgv,
  sleep,
  waitFor,
} from "./_lib.ts";
import {
  mkdtempSync,
  readFileSync,
  existsSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const P = "05-daemon-survives";
const [role = "probe", dir = "", hold = ""] = process.argv.slice(2);

if (role === "daemon") {
  // Hold a PTY whose shell writes a tick to `ticks` every 200 ms; relay what
  // the PTY says into `relay` so we know the data path is alive too.
  const proc = Bun.spawn(
    [
      "sh",
      "-c",
      `while :; do echo tick >> "${dir}/ticks"; echo TICK; sleep 0.2; done`,
    ],
    {
      terminal: {
        data: (_t, d) => writeFileSync(join(dir, "relay"), d, { flag: "a" }),
      },
    },
  );
  process.on("SIGHUP", () =>
    writeFileSync(join(dir, "sighup"), "daemon got SIGHUP\n", { flag: "a" }),
  );
  writeFileSync(
    join(dir, "daemon.json"),
    JSON.stringify({
      daemon: process.pid,
      child: proc.pid,
      ps: psInfo(process.pid),
    }),
  );
  setTimeout(() => process.exit(0), 20_000).unref();
  await proc.exited;
} else if (role === "parent") {
  const d = Bun.spawn(selfArgv(import.meta.path, ["daemon", dir]), {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  d.unref();
  await waitFor(() => existsSync(join(dir, "daemon.json")), 5000);
  if (hold === "hold") {
    // stay attached to our own terminal until it goes away, like `wp run` would
    process.on("SIGHUP", () => process.exit(0));
    console.log("parent holding; daemon pid " + d.pid);
    await sleep(30_000);
  }
  console.log("parent exiting; daemon pid " + d.pid);
  process.exit(0);
} else {
  deadline(P, 40_000);
  log("compiled:", compiled);

  async function scenario(
    name: string,
    launch: (dir: string) => Promise<void>,
  ) {
    const dir = mkdtempSync(join(tmpdir(), "werk-m0-05-"));
    await launch(dir);
    const info = JSON.parse(readFileSync(join(dir, "daemon.json"), "utf8")) as {
      daemon: number;
      child: number;
      ps: ReturnType<typeof psInfo>;
    };
    const ticks = () =>
      existsSync(join(dir, "ticks"))
        ? readFileSync(join(dir, "ticks"), "utf8").split("\n").length
        : 0;
    const relay = () =>
      existsSync(join(dir, "relay"))
        ? readFileSync(join(dir, "relay"), "utf8").split("TICK").length
        : 0;
    const t0 = ticks(),
      r0 = relay();
    await sleep(1500);
    const t1 = ticks(),
      r1 = relay();
    const psNow = psInfo(info.daemon);
    const childNow = psInfo(info.child);
    const gotHup = existsSync(join(dir, "sighup"));
    // MSYS `ps` does not report native Windows processes, so on win32
    // liveness is signal 0 plus the tick counter (spike/win32-daemon).
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const daemonAlive = alive(info.daemon);
    const obs = {
      scenario: name,
      daemonPsAtStart: info.ps,
      daemonPsAfter: psNow,
      childPsAfter: childNow,
      daemonAlive,
      ticksGrew: t1 - t0,
      relayGrew: r1 - r0,
      daemonGotSighup: gotHup,
    };
    log(JSON.stringify(obs));
    try {
      process.kill(info.daemon, "SIGKILL");
    } catch {}
    try {
      process.kill(info.child, "SIGKILL");
    } catch {}
    rmSync(dir, { recursive: true, force: true });
    const ok =
      process.platform === "win32"
        ? daemonAlive && t1 > t0 && r1 > r0
        : !!psNow &&
          psNow.sid === psNow.pid &&
          psNow.ppid !== process.pid &&
          t1 > t0 &&
          r1 > r0;
    return { ok, obs };
  }

  // (a) plain: parent is an ordinary child of the probe, exits
  const a = await scenario("parent-exits", async (dir) => {
    const p = Bun.spawn(selfArgv(import.meta.path, ["parent", dir]), {
      stdout: "pipe",
    });
    await p.exited;
  });

  // (b) parent runs inside its own PTY (a nested Bun.Terminal); the PTY is closed after the parent exits
  const b = await scenario("parent-pty-closed", async (dir) => {
    let out = "";
    const p = Bun.spawn(selfArgv(import.meta.path, ["parent", dir]), {
      terminal: { data: (_t, d) => (out += Buffer.from(d).toString()) },
    });
    await p.exited;
    p.terminal!.close();
    await sleep(200);
  });

  // (c) parent runs under `script`, which owns a PTY and tears it down when the parent exits
  let c: Awaited<ReturnType<typeof scenario>> | null = null;
  if (Bun.which("script")) {
    c = await scenario("parent-under-script", async (dir) => {
      const cmd = selfArgv(import.meta.path, ["parent", dir])
        .map((s) => `'${s}'`)
        .join(" ");
      // util-linux takes `script -qc <cmd> <file>`; BSD takes
      // `script -q <file> <cmd> <args...>`.
      const argv =
        process.platform === "darwin"
          ? ["script", "-q", "/dev/null", "bash", "-c", cmd]
          : ["script", "-qc", cmd, "/dev/null"];
      const p = Bun.spawn(argv, {
        stdout: "ignore",
        stdin: "ignore",
      });
      await p.exited;
      await sleep(200);
    });
  }

  // (d) the parent is still alive, attached to its PTY, when that PTY is closed under it
  let parentHup: string | null = null;
  const d = await scenario("parent-alive-pty-closed", async (dir) => {
    let out = "";
    const p = Bun.spawn(selfArgv(import.meta.path, ["parent", dir, "hold"]), {
      terminal: { data: (_t, d) => (out += Buffer.from(d).toString()) },
    });
    await waitFor(() => out.includes("parent holding"), 5000);
    p.terminal!.close();
    const gone = await Promise.race([
      p.exited.then(() => true),
      sleep(3000).then(() => false),
    ]);
    parentHup = gone
      ? `parent died on PTY close (signal ${p.signalCode}, code ${p.exitCode})`
      : "parent did not die when its PTY closed";
    if (!gone) p.kill("SIGKILL");
    await p.exited;
  });
  log(parentHup);
  const all = [a, b, ...(c ? [c] : []), d];
  const ok = all.every((s) => s.ok);
  finish(
    P,
    ok ? "pass" : "fail",
    ok
      ? `daemon is its own session leader and its PTY child keeps running in ${all.length}/${all.length} scenarios`
      : "daemon or PTY child did not survive",
    { scenarios: all.map((s) => s.obs), parentHup },
  );
}
