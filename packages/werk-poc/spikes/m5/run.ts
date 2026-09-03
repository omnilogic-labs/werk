// M5, the transport spike: a daemon behind sshd, reached through
// `ssh -N -L <unix socket>:<unix socket>`, with a symmetric delay on the
// path for RTT. Drives the compiled `wp attach` in a PTY of its own (as
// spikes/m2 does) and reads what the stand-in terminal shows against the
// daemon's `screen`. Prints markdown tables.
//
// Two remote ends. `--remote docker` (the default) is the container M5 was
// written against: its own kernel, `tc netem`, a second machine in every
// way that matters except the wire. `--remote self` is this machine over a
// private sshd, for a host with no Docker — a hosted macOS runner — where
// the delay comes from pf's dummynet or `tc` on the loopback device. The
// daemon, the forward, the client and the protocol are the same either
// way; what the second one cannot show is a real network.
//
//   bun run m5 [--remote docker|self] [--rtt 0,50,200] [--keys 50] [--idle 120]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { connect, type Client } from "../../src/client/index.ts";
import type { ConnectionStats } from "../../src/protocol/index.ts";
import { buildWp, stopEnv, tempEnv } from "../m2/harness.ts";
import {
  alive,
  kb,
  ms,
  paintLatency,
  pct,
  Remote,
  settle,
  sh,
  sizes,
  sleep,
  Term,
  waitFor,
  type M5Remote,
} from "./lib.ts";
import { SelfRemote } from "./self.ts";

const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : dflt;
};
const REMOTE = arg("remote", "docker");
const RTTS = arg("rtt", "0,50,200").split(",").map(Number);
const KEYS = Number(arg("keys", "50"));
const IDLE_S = Number(arg("idle", "120"));

/** One daemon to measure against: the container's through the forward, or a local one as the floor. */
interface Target {
  name: string;
  wp: string;
  env: Record<string, string>;
  cwd: string;
  sessionEnv: Record<string, string>;
  ctl(): Promise<Client>;
}

const CLIENT_ENV = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: process.env.HOME ?? "/",
  TERM: "xterm-256color",
  LANG: "C.UTF-8",
};

async function session(t: Target, ctl: Client, script: string) {
  return (
    await ctl.run({
      argv: ["sh", "-c", script],
      cwd: t.cwd,
      env: t.sessionEnv,
      cols: 80,
      rows: 24,
    })
  ).id;
}

/** `wp attach` in a PTY, with the first paint confirmed against the daemon. */
async function attach(t: Target, ctl: Client, id: string, track = false) {
  const term = await Term.spawn(t.wp, ["attach", id], t.env);
  term.trackScreen = track;
  const r = await settle(ctl, id, term, null, 10_000);
  if (!r.ok) throw new Error(`first paint never matched the daemon for ${id}`);
  return term;
}

const cliConn = (stats: ConnectionStats[], id: string) =>
  stats.find((c) => c.attached === id && !c.readOnly);

// --- yes: 20 MiB through the forward, a second (library) attacher counting frames.
async function yesTest(t: Target) {
  const ctl = await t.ctl();
  const id = await session(
    t,
    ctl,
    "read x; yes | head -c 20M; echo; echo DONE; read y",
  );
  const lib = await t.ctl();
  let frames = 0,
    libBytes = 0,
    renders = 0,
    libLags = 0,
    closedEarly = false;
  const att = await lib.attach(id, {
    cols: 80,
    rows: 24,
    readOnly: true,
    onOutput: (b) => {
      frames++;
      libBytes += b.length;
    },
    onRender: () => renders++,
    onLag: () => libLags++,
  });
  void lib.waitClosed().then(() => (closedEarly = true));
  const term = await attach(t, ctl, id);
  const t0 = performance.now();
  term.write("\r");
  const done = await waitFor(() => term.text.includes("DONE"), 120_000, 50);
  const wall = term.chunks[term.chunks.length - 1]!.t - t0;
  await sleep(300);
  const final = await settle(ctl, id, term, null, 10_000);
  const conn = cliConn((await ctl.stats()).connections, id);
  const early = closedEarly;
  term.write("\x1c");
  await term.waitExit(5000);
  const lagged = /lagged (\d+)×/.exec(term.text)?.[1] ?? "0";
  await att.detach().catch(() => {});
  lib.close();
  await ctl.kill(id, "SIGKILL").catch(() => {});
  await term.close();
  ctl.close();
  return {
    line: `${done ? "" : "**timed out** "}${kb(conn?.bytesSent ?? 0)} sent in ${ms(wall)} ms (${((conn?.bytesSent ?? 0) / 1048576 / (wall / 1000)).toFixed(1)} MiB/s); lag ${lagged}× / ${kb(conn?.droppedBytes ?? 0)} dropped, max queue ${kb(conn?.maxQueuedBytes ?? 0)}; screen ${final.ok ? "matches" : "**differs**"}`,
    lib: `${frames} frames, ${kb(libBytes)}, ${renders} renders, ${libLags} lag notices${early ? ", **closed early**" : ""}`,
    chunks: sizes(term.chunks.map((c) => c.size)),
  };
}

// --- vim: keystroke-to-paint per unit, plus a resize through the forward.
const UNITS = [
  "10j",
  "w",
  "\x1b[C",
  "\x1b[D",
  "\x1b[B",
  "\x1b[A",
  "dd",
  ":s/foo/bar/\r",
];
async function vimTest(t: Target, n = KEYS) {
  const ctl = await t.ctl();
  const id = await session(
    t,
    ctl,
    'd=$(mktemp -d); for i in $(seq 1 100); do echo "line $i: foo quick brown fox"; done > $d/f.txt; read x; vim -u NONE -i NONE -N $d/f.txt',
  );
  const term = await attach(t, ctl, id, true);
  term.write("\r");
  await waitFor(() => term.text.includes("line 1: foo"), 10_000);
  if (!(await settle(ctl, id, term, null, 10_000)).ok)
    throw new Error("vim's first screen never matched");
  const lat: number[] = [],
    perKey: number[] = [];
  let miss = 0,
    noPaint = 0;
  for (let i = 0; i < n; i++) {
    const before = term.key(),
      from = term.chunks.length,
      t0 = performance.now();
    term.write(UNITS[i % UNITS.length]!);
    const r = await settle(ctl, id, term, before, 5000);
    perKey.push(term.chunks.length - from);
    if (!r.ok) {
      miss++;
      continue;
    }
    const l = paintLatency(term, from, r.key, t0);
    if (l === null) noPaint++;
    else lat.push(l);
  }
  const before = term.key();
  term.resize(100, 30);
  const rz = await settle(ctl, id, term, before, 5000);
  const resize =
    rz.ok && rz.daemon.cols === 100 && rz.daemon.rows === 30
      ? "ok"
      : `**failed** (${rz.daemon.cols}×${rz.daemon.rows}, match ${rz.ok})`;
  term.write("\x1b:q!\r");
  await term.waitExit(5000);
  await term.close();
  await ctl.kill(id, "SIGKILL").catch(() => {});
  ctl.close();
  return {
    lat,
    resize,
    line: `${lat.length} keys: p50 ${ms(pct(lat, 50))} / p90 ${ms(pct(lat, 90))} / p99 ${ms(pct(lat, 99))} / max ${ms(Math.max(...lat))} ms; ${miss} unsettled, ${noPaint} unattributed; chunks per key p50 ${pct(perKey, 50)} / max ${Math.max(...perKey)}`,
    chunks: sizes(term.chunks.map((c) => c.size)),
  };
}

// --- a 5 fps counter for 30 s: frames observed against frames produced.
async function counterTest(t: Target) {
  const ctl = await t.ctl();
  const id = await session(
    t,
    ctl,
    'read x; i=0; while [ $i -lt 150 ]; do printf "\\033[H\\033[Kcounter: %6d\\n" $i; i=$((i+1)); sleep 0.2; done; echo END; read y',
  );
  const term = await attach(t, ctl, id);
  const from = term.chunks.length;
  term.write("\r");
  await waitFor(() => term.text.includes("END"), 60_000, 100);
  const frames = (term.text.match(/counter: +\d+/g) ?? []).length;
  const ts = term.chunks
    .slice(from)
    .filter((c) => c.size > 0)
    .map((c) => c.t);
  const gaps = ts.slice(1).map((x, i) => x - ts[i]!);
  const conn = cliConn((await ctl.stats()).connections, id);
  await term.close();
  await ctl.kill(id, "SIGKILL").catch(() => {});
  ctl.close();
  return `${frames}/150 frames in ${ts.length} PTY reads over ${ms((ts[ts.length - 1]! - ts[0]!) / 1000)} s; gap p50 ${ms(pct(gaps, 50))} / p99 ${ms(pct(gaps, 99))} / max ${ms(Math.max(...gaps))} ms; lag ${conn?.lagCount ?? 0}×`;
}

// --- load: SIGSTOP the client under `yes`, then kill the forward and come back.
async function loadTest(t: Target, remote: M5Remote) {
  const notes: string[] = [];
  const ctl = await t.ctl();
  const id = await session(t, ctl, "read x; yes");
  const term = await attach(t, ctl, id);
  term.write("\r");
  await sleep(1500);
  const b0 = term.bytes;
  process.kill(term.pid, "SIGSTOP");
  await sleep(2500);
  const during = cliConn((await ctl.stats()).connections, id);
  notes.push(
    `during a 3 s SIGSTOP of the host \`wp attach\`: ssh -N ${alive(remote.ssh!.pid) ? "alive" : "**gone**"}; daemon sees the client lagging=${during?.lagging}, queued ${kb(during?.queuedBytes ?? 0)}, dropped ${kb(during?.droppedBytes ?? 0)}; a second connection through the same forward answered \`stats\``,
  );
  await sleep(500);
  process.kill(term.pid, "SIGCONT");
  await sleep(2000);
  const after = cliConn((await ctl.stats()).connections, id);
  const renders = (term.text.match(/\x1b\[H\x1b\[2J/g) ?? []).length;
  notes.push(
    `after SIGCONT: ${kb(term.bytes - b0)} more received, ${renders} render(s) seen by the client, lagging=${after?.lagging}, lag ${after?.lagCount}×, ${kb(after?.droppedBytes ?? 0)} dropped in all; ssh -N ${alive(remote.ssh!.pid) ? "alive" : "**gone**"}`,
  );
  ctl.close();
  const t0 = performance.now();
  remote.ssh!.kill("SIGKILL");
  const exited = await term.waitExit(5000);
  notes.push(
    `ssh -N killed mid-stream: wp attach ${exited ? `exited ${term.exitCode} after ${ms(performance.now() - t0)} ms` : "**still running after 5 s** (hang)"}; last line: ${JSON.stringify(term.text.slice(-90).split("\r\n").filter(Boolean).pop() ?? "")}`,
  );
  await term.close();
  await remote.forward();
  const ctl2 = await t.ctl();
  const s = (await ctl2.ls()).find((x) => x.id === id);
  const term2 = await attach(t, ctl2, id).catch(
    (e) => (notes.push(`reattach: ${e}`), null),
  );
  notes.push(
    `new forward: session ${s?.status ?? "**missing**"}, ${s?.attachedClients} client(s) listed; reattach ${term2 ? "painted and matched" : "**failed**"}`,
  );
  if (term2) await term2.close();
  await ctl2.kill(id, "SIGKILL").catch(() => {});
  ctl2.close();
  return notes;
}

// --- idle: an attached vim, nothing typed for a while, then a key.
async function idleTest(t: Target, remote: M5Remote) {
  const ctl = await t.ctl();
  const id = await session(
    t,
    ctl,
    "d=$(mktemp -d); seq 1 100 > $d/f.txt; vim -u NONE -i NONE -N $d/f.txt",
  );
  const term = await attach(t, ctl, id, true);
  await sleep(IDLE_S * 1000);
  const before = term.key(),
    from = term.chunks.length,
    t0 = performance.now();
  term.write("j");
  const r = await settle(ctl, id, term, before, 5000);
  const l = r.ok ? paintLatency(term, from, r.key, t0) : null;
  term.write("\x1b:q!\r");
  await term.waitExit(5000);
  await term.close();
  await ctl.kill(id, "SIGKILL").catch(() => {});
  ctl.close();
  return `after ${IDLE_S} s idle: ssh -N ${alive(remote.ssh!.pid) ? "alive" : "**gone**"}, \`j\` ${r.ok ? `painted in ${ms(l ?? NaN)} ms` : "**never painted**"}`;
}

async function main() {
  const wp = buildWp();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wp-m5-")); // short: sun_path is 108 bytes
  const remote: M5Remote =
    REMOTE === "self" ? new SelfRemote(tmp, wp) : new Remote(tmp, wp);
  const local = tempEnv(wp);
  const stop = async () => {
    await remote.stop();
    await stopEnv(local);
  };
  process.on("SIGINT", () => void stop().then(() => process.exit(130)));
  const out: string[] = [];
  const say = (s: string) => {
    console.log(s);
    out.push(s);
  };
  try {
    await remote.start();
    const far: Target = {
      name: "container via ssh -L",
      wp,
      env: { ...CLIENT_ENV, WP_SOCKET: remote.localSock },
      cwd: remote.cwd,
      sessionEnv: remote.sessionEnv,
      ctl: () =>
        connect({ socket: remote.localSock, requestTimeoutMs: 30_000 }),
    };
    const ttySock = path.join(remote.tmp, "tty.sock");
    await remote.forward("tty", ttySock);
    const farTty: Target = {
      ...far,
      name: "container via ssh -tt",
      env: { ...CLIENT_ENV, WP_SOCKET: ttySock },
      ctl: () => connect({ socket: ttySock, requestTimeoutMs: 30_000 }),
    };
    const near: Target = {
      name: "local daemon",
      wp,
      env: local.env,
      cwd: os.tmpdir(),
      sessionEnv: { ...CLIENT_ENV },
      ctl: () => connect({ dir: local.dir, requestTimeoutMs: 30_000 }),
    };
    say(`## Setup\n`);
    say(
      `- host: ${sh(["ssh", "-V"], false).stderr.trim()}, kernel ${os.release()}, ${process.arch}; ${remote.describe()}`,
    );
    say(
      `- \`wp --socket ${remote.localSock} ls\` from the host:\n\n\`\`\`\n${sh([wp, "--socket", remote.localSock, "ls"], false).stdout.trim() || "(no sessions)"}\n\`\`\``,
    );
    const c = await far.ctl();
    say(
      `- hello through the forward: protocol ${c.daemon.protocol}, wp ${c.daemon.wp}, engine ${c.daemon.engine.slice(0, 8)}, daemon pid ${c.daemon.pid} (in the container)`,
    );
    c.close();
    const rttRows: string[] = [],
      yesRows: string[] = [],
      vimRows: string[] = [],
      ctrRows: string[] = [],
      chunkRows: string[] = [];
    for (const rtt of RTTS) {
      remote.netem(rtt);
      await sleep(200);
      const ctl = await far.ctl();
      const app: number[] = [];
      for (let i = 0; i < 20; i++) {
        const t0 = performance.now();
        await ctl.stats();
        app.push(performance.now() - t0);
      }
      ctl.close();
      const ban: number[] = [];
      for (let i = 0; i < 5; i++) ban.push(await remote.bannerMs());
      rttRows.push(
        `| ${rtt} | ${ms(pct(ban, 50))} | ${ms(pct(app, 50))} / ${ms(pct(app, 90))} | ${remote.execBulkMiBs().toFixed(1)} |`,
      );
      console.error(`rtt ${rtt}: yes`);
      const y = await yesTest(far);
      yesRows.push(`| ${rtt} | ${y.line} | ${y.lib} |`);
      console.error(`rtt ${rtt}: vim`);
      const v = await vimTest(far);
      vimRows.push(`| ${rtt}, \`-N\` | ${v.line} | ${v.resize} |`);
      const vt = await vimTest(farTty);
      vimRows.push(`| ${rtt}, \`-tt\` | ${vt.line} | ${vt.resize} |`);
      chunkRows.push(`| ${rtt} | ${y.chunks} | ${v.chunks} |`);
      console.error(`rtt ${rtt}: counter`);
      ctrRows.push(`| ${rtt} | ${await counterTest(far)} |`);
    }
    // `yes` again with the daemon's queue bound at 4 MiB, above the forward's bandwidth-delay product.
    await remote.restartDaemon(await far.ctl(), ["WP_QUEUE_BOUND=4194304"]);
    for (const rtt of RTTS) {
      remote.netem(rtt);
      console.error(`rtt ${rtt}: yes, 4 MiB queue bound`);
      const y = await yesTest(far);
      yesRows.push(`| ${rtt}, queue bound 4 MiB | ${y.line} | ${y.lib} |`);
    }
    await remote.restartDaemon(await far.ctl(), []);
    console.error("local floor: yes, vim");
    const yFloor = await yesTest(near);
    yesRows.push(`| local, no ssh | ${yFloor.line} | ${yFloor.lib} |`);
    const floor = await vimTest(near);
    vimRows.push(`| local, no ssh | ${floor.line} | ${floor.resize} |`);
    chunkRows.push(`| local, no ssh | ${yFloor.chunks} | ${floor.chunks} |`);
    say(
      `\n## RTT\n\n| applied RTT (ms) | TCP banner p50 (ms) | \`stats\` round trip via forward p50 / p90 (ms) | exec channel bulk (MiB/s) |\n| --- | --- | --- | --- |\n${rttRows.join("\n")}`,
    );
    say(
      `\n## \`yes | head -c 20M\`\n\n| RTT | \`wp attach\` in a PTY | library attacher on the same forward |\n| --- | --- | --- |\n${yesRows.join("\n")}`,
    );
    say(
      `\n## vim, keystroke to paint\n\n| RTT | latency | resize |\n| --- | --- | --- |\n${vimRows.join("\n")}`,
    );
    say(
      `\n## PTY read sizes\n\n| RTT | during \`yes\` | during vim |\n| --- | --- | --- |\n${chunkRows.join("\n")}`,
    );
    say(
      `\n## 5 fps counter, 30 s\n\n| RTT | observed |\n| --- | --- |\n${ctrRows.join("\n")}`,
    );
    const loadRtt = RTTS.includes(50) ? 50 : RTTS[RTTS.length - 1]!;
    remote.netem(loadRtt);
    console.error("load / recovery");
    say(
      `\n## Load and recovery (RTT ${loadRtt} ms)\n\n${(await loadTest(far, remote)).map((n) => `- ${n}`).join("\n")}`,
    );
    remote.netem(0);
    console.error(`idle ${IDLE_S} s`);
    say(`\n## Idle\n\n- ${await idleTest(far, remote)}`);
  } finally {
    await stop();
  }
}

await main();
