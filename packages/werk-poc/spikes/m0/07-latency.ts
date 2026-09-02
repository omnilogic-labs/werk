// Probe 7: the latency floor. A byte goes client -> unix socket -> daemon ->
// PTY -> `cat` -> PTY -> data callback -> socket -> client. Reported as
// round-trip percentiles, against the in-process PTY round trip (no socket)
// and, where socat exists, a native relay doing the same job.

import { deadline, finish, log, waitFor } from "./_lib.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const P = "07-latency";
deadline(P, 90_000);
const N = Number(process.env.M0_LAT_N ?? 2000);
const dir = mkdtempSync(join(tmpdir(), "werk-m0-07-"));

function pct(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  return {
    n: s.length,
    p50: +q(0.5).toFixed(1),
    p90: +q(0.9).toFixed(1),
    p99: +q(0.99).toFixed(1),
    max: +s[s.length - 1]!.toFixed(1),
  };
}

/** Sends one byte at a time, timing until the echo comes back through `recv`. */
async function measure(
  send: (b: Uint8Array) => void,
  waitEcho: () => Promise<void>,
  n: number,
) {
  const us: number[] = [];
  const b = new Uint8Array([0x61]);
  for (let i = 0; i < n; i++) {
    const t = Bun.nanoseconds();
    send(b);
    await waitEcho();
    us.push((Bun.nanoseconds() - t) / 1000);
  }
  return pct(us.slice(Math.floor(n / 10))); // drop warm-up
}

function echoWaiter() {
  let resolve: (() => void) | null = null;
  return {
    got: () => {
      resolve?.();
      resolve = null;
    },
    wait: () => new Promise<void>((r) => (resolve = r)),
  };
}

// A: in-process PTY round trip, no socket
const a = echoWaiter();
const child = Bun.spawn(["sh", "-c", "stty raw -echo; echo READY; exec cat"], {
  terminal: {
    data: (_t, d) => {
      if (d.includes(0x61)) a.got();
    },
  },
});
await Bun.sleep(300);
const inProcess = await measure((b) => child.terminal!.write(b), a.wait, N);
log("in-process pty rtt (us):", inProcess);
child.kill("SIGKILL");
await child.exited;
child.terminal!.close();

// B: through a unix socket relay in this process
const w = echoWaiter();
const sockPath = join(dir, "relay.sock");
let serverSock: Bun.Socket<undefined> | null = null;
const relayChild = Bun.spawn(["sh", "-c", "stty raw -echo; exec cat"], {
  terminal: { data: (_t, d) => serverSock?.write(d) },
});
const server = Bun.listen({
  unix: sockPath,
  socket: {
    open: (s) => {
      serverSock = s;
    },
    data: (_s, d) => {
      relayChild.terminal!.write(d);
    },
    close: () => {
      serverSock = null;
    },
  },
});
const client = await Bun.connect({
  unix: sockPath,
  socket: {
    data: (_s, d) => {
      if (d.includes(0x61)) w.got();
    },
  },
});
await waitFor(() => serverSock !== null, 2000);
const viaSocket = await measure((b) => client.write(b), w.wait, N);
log("bun relay rtt via unix socket (us):", viaSocket);
client.end();
server.stop(true);
relayChild.kill("SIGKILL");
await relayChild.exited;
relayChild.terminal!.close();

// C: socat as a native relay for the same job, if present
let native: ReturnType<typeof pct> | null = null;
const socat = Bun.which("socat");
if (socat) {
  const nativeSock = join(dir, "native.sock");
  const sc = Bun.spawn(
    [socat, `UNIX-LISTEN:${nativeSock}`, "EXEC:cat,pty,raw,echo=0"],
    { stdout: "ignore", stderr: "ignore" },
  );
  await waitFor(
    () => Bun.spawnSync(["test", "-S", nativeSock]).exitCode === 0,
    3000,
  );
  const nw = echoWaiter();
  const nc = await Bun.connect({
    unix: nativeSock,
    socket: {
      data: (_s, d) => {
        if (d.includes(0x61)) nw.got();
      },
    },
  });
  native = await measure((b) => nc.write(b), nw.wait, N);
  log("socat native relay rtt (us):", native);
  nc.end();
  sc.kill("SIGKILL");
  await sc.exited;
}

rmSync(dir, { recursive: true, force: true });
finish(
  P,
  "pass",
  `p50/p99 us — pty only ${inProcess.p50}/${inProcess.p99}; via bun socket relay ${viaSocket.p50}/${viaSocket.p99}; socat ${native ? `${native.p50}/${native.p99}` : "n/a"}; dtach not installed`,
  {
    iterations: N,
    inProcess,
    viaSocket,
    socatNative: native,
    dtach: Bun.which("dtach") ?? null,
  },
);
