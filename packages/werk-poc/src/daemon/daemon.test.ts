// Sessions against a real daemon: run, attach, input, reattach fidelity,
// several clients, read-only, effects, kill, exit status, logs, and the
// slow-client rule. One daemon per file, in a temporary runtime directory.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { connect, type Client } from "../client/index.ts";
import {
  agreesWithDaemon,
  gridEngine,
  gridOfCapture,
  rowIndex,
} from "./_grid.ts";
import { platform } from "../platform/index.ts";
import {
  Capture,
  flood,
  floodDelivered,
  sleep,
  stopDaemon,
  tempDir,
  waitFor,
} from "./_testlib.ts";
import { QUEUE_BOUND } from "./connection.ts";

const dir = tempDir();
let client: Client;
let pid: number;
const extra: Client[] = [];

beforeAll(async () => {
  client = await connect({ dir });
  pid = client.daemon.pid;
  await gridEngine();
});

afterAll(async () => {
  for (const c of extra) c.close();
  await stopDaemon(dir, client, pid);
});

async function another(): Promise<Client> {
  const c = await connect({ dir, autostart: false });
  extra.push(c);
  return c;
}

const sh = (script: string) => ["sh", "-c", script];

test("run, attach, see output; input is echoed back", async () => {
  const { id } = await client.run({
    argv: sh("echo hello; exec sh"),
    env: { PS1: "$ ", PATH: process.env.PATH! },
  });
  expect(id).toMatch(/^[0-9a-f]{6}$/);
  const cap = new Capture(client);
  const att = await cap.attach(id);
  expect(att.status).toBe("running");
  expect(await waitFor(() => cap.all.includes("hello"), 3000)).toBe(true);
  expect(cap.renders.length).toBe(1);
  expect(cap.render.startsWith("\x1b[H\x1b[2J")).toBe(true);
  await waitFor(() => cap.all.includes("$ "), 3000);
  att.input("echo hi\r");
  // The echo is a property of the screen rather than of the stream: a ConPTY
  // re-encodes the same input rather than passing the bytes through, so the
  // command and its output are read where a user would read them — on the
  // client's own grid, rebuilt from everything the client received.
  expect(
    await waitFor(
      () => {
        const g = gridOfCapture(cap);
        const i = rowIndex(g, /(^|\s)echo hi$/);
        return i >= 0 && g.rows[i + 1] === "hi";
      },
      3000,
      50,
    ),
  ).toBe(true);
  // And that grid is the daemon's own screen, cell for cell: reattach
  // fidelity, with nothing claimed about the bytes in between.
  expect((await agreesWithDaemon(client, id, cap)).detail).toBe("");
  await att.detach();
  await client.kill(id, "SIGKILL");
});

test("reattach after output arrived while nobody was attached", async () => {
  const { id } = await client.run({
    argv: sh("echo one; sleep 1; echo two; sleep 30"),
    rows: 6,
    cols: 40,
  });
  const first = new Capture(client);
  await first.attach(id, { cols: 40, rows: 6 });
  expect(await waitFor(() => first.all.includes("one"), 3000)).toBe(true);
  await first.att.detach();
  await sleep(1500);
  expect(first.all).not.toContain("two");
  const second = new Capture(client);
  await second.attach(id, { cols: 40, rows: 6 });
  expect(second.renders.length).toBe(1);
  expect(second.render).toContain("one");
  expect(second.render).toContain("two");
  // the render places the cursor: row 3, column 1
  expect(second.render).toMatch(/\x1b\[3;1H/);
  expect(second.output).toBe("");
  await second.att.detach();
  await client.kill(id, "SIGKILL");
});

test("two clients attached at once both receive output; read-only input is ignored", async () => {
  const { id } = await client.run({
    argv: ["sh"],
    env: { PS1: "$ ", PATH: process.env.PATH! },
  });
  const a = new Capture(client);
  await a.attach(id);
  const bClient = await another();
  const b = new Capture(bClient);
  await b.attach(id, { readOnly: true });
  await waitFor(() => a.all.includes("$ ") && b.all.includes("$ "), 3000);
  const info = (await client.ls()).find((s) => s.id === id)!;
  expect(info.attachedClients).toBe(2);

  b.att.input("echo from-ro\r");
  await sleep(300);
  expect(a.all).not.toContain("from-ro");
  expect(b.all).not.toContain("from-ro");

  a.att.input("echo both\r");
  expect(
    await waitFor(
      () => a.output.includes("both\r\n") && b.output.includes("both\r\n"),
      3000,
    ),
  ).toBe(true);
  await a.att.detach();
  await b.att.detach();
  await client.kill(id, "SIGKILL");
});

test("two writers share one input stream and both see the resulting screen", async () => {
  const { id } = await client.run({
    argv: [
      process.execPath,
      "-e",
      `
      process.stdin.setRawMode(true);
      let input = "";
      process.stdin.on("data", bytes => {
        input += bytes.toString();
        if (input.length === 8) console.log("received:" + input);
      });
      console.log("READY");
    `,
    ],
  });
  const a = new Capture(client);
  const b = new Capture(await another());
  try {
    await a.attach(id);
    await b.attach(id);
    expect(
      await waitFor(
        () => a.all.includes("READY") && b.all.includes("READY"),
        3000,
      ),
    ).toBe(true);
    // No ownership handoff or lock. The daemon orders the two connections;
    // either ordering is valid, but each writer's bytes must arrive once.
    a.att.input("left");
    b.att.input("rite");
    expect(
      await waitFor(() => {
        const first = gridOfCapture(a).rows.find((row) =>
          row.startsWith("received:"),
        );
        const second = gridOfCapture(b).rows.find((row) =>
          row.startsWith("received:"),
        );
        return (
          (first === "received:leftrite" || first === "received:riteleft") &&
          first === second
        );
      }, 3000),
    ).toBe(true);
    expect((await agreesWithDaemon(client, id, a)).detail).toBe("");
    expect((await agreesWithDaemon(client, id, b)).detail).toBe("");
  } finally {
    await a.att?.detach();
    await b.att?.detach();
    await client.kill(id, "SIGKILL");
  }
});

test("invalid dimensions are rejected without changing a session or its attachment", async () => {
  const { id } = await client.run({
    argv: [
      process.execPath,
      "-e",
      'console.log("still here"); setInterval(() => {}, 1000)',
    ],
  });
  const cap = new Capture(client);
  await cap.attach(id);
  const other = await another();
  const badSizes = [
    [0, 24],
    [-1, 24],
    [80, 0],
    [80, 1.5],
    [NaN, 24],
    [Infinity, 24],
    [65535, 65535],
    [4097, 1],
    [1024, 1024],
  ];
  try {
    for (const [cols, rows] of badSizes) {
      await expect(cap.att.resize(cols!, rows!)).rejects.toMatchObject({
        code: "bad-request",
      });
      await expect(
        other.attach(id, { cols: cols!, rows: rows! }),
      ).rejects.toMatchObject({ code: "bad-request" });
      await expect(
        other.run({ argv: [process.execPath, "-e", ""], cols, rows }),
      ).rejects.toMatchObject({ code: "bad-request" });
    }
    expect(
      await waitFor(
        async () => (await client.screen(id)).text.includes("still here"),
        3000,
      ),
    ).toBe(true);
    expect(await client.screen(id)).toMatchObject({ cols: 80, rows: 24 });
    expect((await client.ls()).find((s) => s.id === id)?.attachedClients).toBe(
      1,
    );
    await cap.att.resize(100, 30);
    expect(await client.screen(id)).toMatchObject({ cols: 100, rows: 30 });
    expect(client.daemon.pid).toBe(pid);
  } finally {
    await cap.att.detach();
    await client.kill(id, "SIGKILL");
  }
});

test("ls shows the title after an OSC 2, and the pwd after an OSC 7", async () => {
  const { id } = await client.run({
    argv: sh(
      `printf '\\033]2;my title\\007\\033]7;file://host/tmp/there\\007'; sleep 30`,
    ),
  });
  let info = (await client.ls()).find((s) => s.id === id)!;
  for (let i = 0; i < 30 && info.title !== "my title"; i++) {
    await sleep(50);
    info = (await client.ls()).find((s) => s.id === id)!;
  }
  expect(info.title).toBe("my title");
  expect(info.pwd).toBe("file://host/tmp/there");
  expect(info.status).toBe("running");
  expect(info.argv[0]).toBe("sh");
  expect(info.engine).toBe("ghostty-wasm");
  await client.kill(id, "SIGKILL");
});

test("title effects reach an attached client", async () => {
  const { id } = await client.run({
    argv: sh(`sleep 0.2; printf '\\033]0;later\\007'; sleep 30`),
  });
  const cap = new Capture(client);
  await cap.attach(id);
  expect(
    await waitFor(
      () => cap.effects.some((e) => e.kind === "title" && e.value === "later"),
      3000,
    ),
  ).toBe(true);
  await cap.att.detach();
  await client.kill(id, "SIGKILL");
});

test("kill signals the child; ls reports the signal; attached clients hear exited", async () => {
  const { id } = await client.run({ argv: ["sleep", "30"] });
  const cap = new Capture(client);
  await cap.attach(id);
  const r = await client.kill(id);
  expect(r.action).toBe("killed");
  expect(r.kill!.mode).toBe("terminate");
  // How the platform carried it out: a signal to the child's process group on
  // POSIX, the session's Job Object on Windows, and `TerminateProcess` on the
  // child alone where no job could be made (../platform/).
  expect(["group-signal", "signal", "job", "terminate"]).toContain(
    r.kill!.delivery,
  );
  expect(await waitFor(() => cap.exited !== null, 3000)).toBe(true);
  const info = (await client.ls()).find((s) => s.id === id)!;
  expect(info.status).toBe("exited");
  expect(info.kill!.mode).toBe("terminate");
  expect(info.exitedAt).not.toBeNull();
  // A signal name only where an exit status has one to give. Windows has
  // none: Bun echoes back whatever name `proc.kill` was passed even though
  // `TerminateProcess` is what ran, so the daemon reports no signal there.
  if (platform.signalsExits) {
    expect(cap.exited!.signalCode).toBe("SIGTERM");
    expect(info.signalCode).toBe("SIGTERM");
    expect(r.kill!.signal).toBe("SIGTERM");
  } else {
    expect(cap.exited!.signalCode).toBeNull();
    expect(info.signalCode).toBeNull();
  }
  // the session is still there for ls and logs until it is removed
  const removed = await client.kill(id);
  expect(removed.action).toBe("removed");
  expect((await client.ls()).find((s) => s.id === id)).toBeUndefined();
  // Caught rather than asserted with `expect().rejects`, which on Windows
  // never resumes for a promise that is still pending when it is handed over
  // — the same request answers in a millisecond through `catch`
  // (.github/ci/win32-kill.test.ts, run 33707210922).
  const missing = await client.kill(id).then(
    () => null,
    (e: Error) => e.message,
  );
  expect(missing).toMatch(/no session/);
});

test("exit code is recorded and the last output survives the exit", async () => {
  const { id } = await client.run({ argv: sh("echo bye; exit 3") });
  const cap = new Capture(client);
  await cap.attach(id);
  expect(await waitFor(() => cap.exited !== null, 3000)).toBe(true);
  expect(cap.exited!.exitCode).toBe(3);
  expect(cap.all).toContain("bye");
  const info = (await client.ls()).find((s) => s.id === id)!;
  expect(info.status).toBe("exited");
  expect(info.exitCode).toBe(3);
  // attaching to an exited session still renders its final screen and says so
  const late = new Capture(client);
  const att = await late.attach(id);
  expect(att.status).toBe("exited");
  expect(late.render).toContain("bye");
  expect(await waitFor(() => late.exited !== null, 1000)).toBe(true);
  await client.kill(id);
});

test("logs returns scrollback beyond the viewport, as text or as VT", async () => {
  const { id } = await client.run({
    argv: sh(
      "i=1; while [ $i -le 100 ]; do echo line$i; i=$((i+1)); done; printf '\\033[31mred\\033[0m\\n'; sleep 30",
    ),
    rows: 10,
    cols: 40,
  });
  const cap = new Capture(client);
  await cap.attach(id, { cols: 40, rows: 10 });
  expect(await waitFor(() => cap.all.includes("red"), 3000)).toBe(true);
  const text = await client.logs(id, "text");
  expect(text).toContain("line1\n");
  expect(text).toContain("line100\nred");
  expect(text).not.toContain("\x1b");
  const vt = await client.logs(id, "vt");
  expect(vt).toContain("line1\r\n");
  expect(vt).toMatch(/\x1b\[(31|38;5;1)mred/);
  // the viewport render has only the tail
  const again = new Capture(client);
  await again.attach(id, { cols: 40, rows: 10 });
  expect(again.render).toContain("line100");
  expect(again.render).not.toContain("line1\r\n");
  await client.kill(id, "SIGKILL");
});

test("resize from the attacher reaches the child", async () => {
  // The child prints its size on WINCH and, because a runtime is free not to
  // deliver that promptly — an MSYS one lets a resize wait until the process
  // next reads input (§11 of docs/proposals/01-cross-platform.md) — polls it
  // as well. Either way what is asserted is the same: the new size reached
  // the child's terminal.
  const { id } = await client.run({
    argv: [
      "bash",
      "-c",
      "trap 'stty size' WINCH; echo ready; while :; do sleep 0.1; stty size; done",
    ],
    cols: 80,
    rows: 24,
  });
  const cap = new Capture(client);
  await cap.attach(id, { cols: 80, rows: 24 });
  expect(await waitFor(() => cap.all.includes("ready"), 3000)).toBe(true);
  await cap.att.resize(120, 40);
  expect(await waitFor(() => cap.all.includes("40 120"), 5000)).toBe(true);
  // a second attacher's size wins
  const other = new Capture(await another());
  await other.attach(id, { cols: 100, rows: 30 });
  expect(await waitFor(() => cap.all.includes("30 100"), 5000)).toBe(true);
  const info = (await client.ls()).find((s) => s.id === id)!;
  expect([info.cols, info.rows]).toEqual([100, 30]);
  await other.att.detach();
  await client.kill(id, "SIGKILL");
});

test("a slow client lags and is re-rendered; a fast one keeps receiving; memory stays bounded", async () => {
  // 8 MiB of full rows from Bun itself (_testlib.ts `flood`): the same
  // producer on every platform, and one a ConPTY carries in under a second
  // where `yes | head -c` under MSYS would take minutes. `expected` is the
  // POSIX line discipline's count; a ConPTY sends about an eighth more, so
  // it is a floor.
  const bytes = 8 * 1024 * 1024;
  const expected = floodDelivered(bytes);
  const { id } = await client.run({ argv: flood(bytes) });
  const fast = new Capture(client);
  await fast.attach(id);
  const slowClient = await another();
  const slow = new Capture(slowClient);
  await slow.attach(id);
  const before = await client.stats();
  slowClient.pauseReading();

  expect(await waitFor(() => fast.all.includes("DONE"), 15000)).toBe(true);
  const mid = await client.stats();
  const slowMid = mid.connections.find(
    (c) => c.attached === id && c !== undefined && c.lagging,
  )!;
  expect(slowMid).toBeDefined();
  expect(slowMid.lagCount).toBeGreaterThanOrEqual(1);
  expect(slowMid.droppedBytes).toBeGreaterThan(expected / 2);
  expect(slowMid.maxQueuedBytes).toBeLessThanOrEqual(QUEUE_BOUND + 70_000);
  expect(slowMid.queuedBytes).toBeLessThanOrEqual(QUEUE_BOUND);
  expect(slow.lagged.length).toBe(0); // the notice sits in its unread buffer
  expect(slow.resumed).toBe(0);

  slowClient.resumeReading();
  expect(await waitFor(() => slow.resumed >= 1, 5000)).toBe(true);
  expect(slow.lagged.length).toBeGreaterThanOrEqual(1);
  expect(slow.lagged[0]!.droppedBytes).toBeGreaterThan(0);
  expect(slow.renders.length).toBeGreaterThanOrEqual(2);
  expect(slow.renders.at(-1)).toContain("DONE");
  expect(slow.outputBytes).toBeLessThan(expected / 2);

  const after = await client.stats();
  const slowAfter = after.connections.find(
    (c) => c.attached === id && c.droppedBytes > 0,
  )!;
  expect(slowAfter.lagging).toBe(false);
  const fastConn = after.connections.find(
    (c) => c.attached === id && c.droppedBytes === 0,
  );
  console.log(
    [
      `slow client: fast client received ${fast.outputBytes} of ${expected} bytes` +
        (fast.lagged.length
          ? ` (lagged ${fast.lagged.length}x, re-rendered)`
          : " with no lag"),
      `slow client: dropped ${slowAfter.droppedBytes} bytes over ${slowAfter.lagCount} lag episode(s), max queue ${slowAfter.maxQueuedBytes} B (bound ${after.queueBound} B)`,
      `slow client: first short write after ${slowAfter.firstShortWriteAfterBytes} B, ${slowAfter.shortWrites} short writes, ${slowAfter.drains} drains, last drain latency ${slowAfter.lastDrainLatencyMs?.toFixed(2)} ms`,
      `fast client: ${fastConn?.shortWrites ?? "?"} short writes, ${fastConn?.drains ?? "?"} drains, max queue ${fastConn?.maxQueuedBytes ?? "?"} B`,
      `daemon RSS: ${(before.rssBytes! / 1048576).toFixed(1)} MiB before, ${(mid.rssBytes! / 1048576).toFixed(1)} MiB during, ${(after.rssBytes! / 1048576).toFixed(1)} MiB after`,
    ].join("\n"),
  );
  if (fast.lagged.length === 0)
    expect(fast.outputBytes).toBeGreaterThanOrEqual(expected);
  expect(after.rssBytes!).toBeLessThan(400 * 1024 * 1024);
  expect(after.rssBytes! - before.rssBytes!).toBeLessThan(64 * 1024 * 1024);

  await fast.att.detach();
  await slow.att.detach();
  await client.kill(id, "SIGKILL");
}, 30000);

test("an unknown engine is refused", async () => {
  await expect(
    client.run({ argv: ["sh"], engine: "ghostty-native-2" }),
  ).rejects.toThrow(/no engine registered/);
});
