// The reattach-fidelity scenarios for M2's stop condition: "reattach into a
// real terminal is visibly wrong for `vim` or an agent, or a slow client
// stalls a fast one". Each scenario drives the compiled `wp` in a PTY of
// its own (harness.ts), compares the stand-in terminal's screen with the
// daemon's, and returns what it saw. `run-all.ts` prints them as a table;
// `fidelity.test.ts` asserts them under `bun test`.

import fs from "node:fs";
import path from "node:path";
import {
  compare,
  daemonClient,
  diffScreens,
  freshEngine,
  settle,
  sleep,
  UserTerminal,
  waitFor,
  wp,
  wpRun,
  type TestEnv,
} from "./harness.ts";

export interface Outcome {
  pass: boolean;
  /** One line per thing observed; failures are prefixed `FAIL:`. */
  notes: string[];
}

export interface Scenario {
  name: string;
  run(env: TestEnv): Promise<Outcome>;
}

/** `WP_M2_VERBOSE=1` echoes every note to stderr as it happens, with a timestamp. */
const verbose = process.env.WP_M2_VERBOSE === "1";
const t0 = performance.now();

class Report {
  notes: string[] = [];
  pass = true;
  check(cond: boolean, ok: string, fail = ok): void {
    this.note(cond ? ok : `FAIL: ${fail}`);
    if (!cond) this.pass = false;
  }
  note(s: string): void {
    this.notes.push(s);
    if (verbose)
      console.error(`[${((performance.now() - t0) / 1000).toFixed(1)}s] ${s}`);
  }
  screensAgree(
    what: string,
    r: Awaited<ReturnType<typeof compare>>,
    max = 6,
  ): void {
    this.check(
      r.diff.length === 0,
      `${what}: screens agree (${r.daemon.cols}×${r.daemon.rows})`,
      `${what}: ${r.diff.length} rows differ: ${r.diff.slice(0, max).join(" ; ")}`,
    );
    this.check(
      r.cursorMatch,
      `${what}: cursor agrees (${r.daemon.cursor.x},${r.daemon.cursor.y})`,
      `${what}: cursor differs from daemon (${r.daemon.cursor.x},${r.daemon.cursor.y})`,
    );
  }
  done(): Outcome {
    return { pass: this.pass, notes: this.notes };
  }
}

const detachedRe = /\[detached ([0-9a-f]+)\]/;

async function detach(t: UserTerminal, r: Report, what: string) {
  t.write("\x1c");
  const exited = await t.waitExit(5000);
  r.check(
    exited && t.exitCode === 0 && detachedRe.test(t.text),
    `${what}: ctrl-\\ detached, wp exited 0, printed [detached]`,
    `${what}: after ctrl-\\: exited=${exited} code=${t.exitCode} tail=${JSON.stringify(t.text.slice(-80))}`,
  );
}

async function running(env: TestEnv, id: string) {
  const c = await daemonClient(env);
  try {
    return (await c.ls()).find((s) => s.id === id) ?? null;
  } finally {
    c.close();
  }
}

// ---------------------------------------------------------------------------

export const shellColour: Scenario = {
  name: "shell: coloured lines, attach, compare, detach",
  async run(env) {
    const r = new Report();
    const id = await wpRun(env, [
      "sh",
      "-c",
      "printf '\\033[31mred\\033[0m \\033[1;32mbold green\\033[0m\\n\\033[44mblue bg\\033[0m plain\\n'; exec bash --norc --noprofile",
    ]);
    const c = await daemonClient(env);
    const t = await UserTerminal.spawn(env, ["attach", id]);
    try {
      await waitFor(() => t.text.includes("$ "), 5000);
      r.screensAgree("after attach", await settle(c, id, t, 3000));
      const cells = t.vt.styledCells();
      const red = cells[0]?.[0];
      const green = cells[0]?.[4];
      r.check(
        red?.fg.kind === "palette" && red.fg.index === 1,
        "styled: 'red' is palette 1",
        `styled: first cell fg is ${JSON.stringify(red?.fg)}`,
      );
      r.check(
        green?.bold === true &&
          green.fg.kind === "palette" &&
          green.fg.index === 2,
        "styled: 'bold green' is bold palette 2",
        `styled: cell (4,0) is ${JSON.stringify(green)}`,
      );
      t.write("echo typed-through\r");
      await waitFor(() => t.text.includes("typed-through\r\n"), 3000);
      r.screensAgree("after typing", await settle(c, id, t, 3000));
      await detach(t, r, "shell");
      const s = await running(env, id);
      r.check(
        s?.status === "running" && s.attachedClients === 0,
        "ls: session still running with 0 clients",
        `ls: ${JSON.stringify(s)}`,
      );
      const logs = await wp(env, ["logs", id]);
      r.check(
        logs.code === 0 && logs.stdout.includes("typed-through"),
        "logs: prints the screen",
        `logs: ${logs.code} ${logs.stderr}`,
      );
    } finally {
      await t.close();
      c.close();
    }
    return r.done();
  },
};

function hundredLines(env: TestEnv): string {
  const file = path.join(env.root, "hundred.txt");
  fs.writeFileSync(
    file,
    Array.from(
      { length: 100 },
      (_, i) => `line ${i + 1}: ${"x".repeat(i % 40)}`,
    ).join("\n") + "\n",
  );
  return file;
}

const VIM = ["vim", "-u", "NONE", "-i", "NONE", "-N"];

export const vimReattach: Scenario = {
  name: "vim: run, detach, reattach, compare, :q! propagates",
  async run(env) {
    const r = new Report();
    const file = hundredLines(env);
    const id = await wpRun(env, [...VIM, file]);
    const c = await daemonClient(env);
    const t1 = await UserTerminal.spawn(env, ["attach", id]);
    try {
      await waitFor(() => t1.text.includes("line 1:"), 5000);
      await sleep(300);
      r.screensAgree("first attach", await settle(c, id, t1, 3000));
      r.check(
        t1.altScreen(),
        "first attach: stand-in terminal is on the alternate screen",
      );
      // Move around so the reattach has a non-trivial cursor to restore.
      t1.write("10jw");
      await sleep(300);
      r.screensAgree("after moving", await settle(c, id, t1, 3000));
      await detach(t1, r, "vim");
    } finally {
      await t1.close();
    }
    const t2 = await UserTerminal.spawn(env, ["attach", id]);
    try {
      await waitFor(() => t2.text.includes("line 1:"), 5000);
      const s = await settle(c, id, t2, 3000);
      r.screensAgree("reattach", s);
      r.check(t2.altScreen(), "reattach: alternate screen mirrored");
      const cur = t2.cursor();
      r.check(
        cur.y === 10 && cur.x > 0,
        `reattach: cursor at (${cur.x},${cur.y}) as left`,
        `reattach: cursor at (${cur.x},${cur.y}), expected row 10`,
      );
      t2.write(":q!\r");
      const exited = await t2.waitExit(5000);
      r.check(
        exited &&
          t2.exitCode === 0 &&
          /\[exited [0-9a-f]+: code 0\]/.test(t2.text),
        ":q! ends the session; wp exits 0 with [exited]",
        `after :q!: exited=${exited} code=${t2.exitCode} tail=${JSON.stringify(t2.text.slice(-60))}`,
      );
      r.check(!t2.altScreen(), "after exit: back on the primary screen");
      const info = await running(env, id);
      r.check(
        info?.status === "exited",
        "ls: exited(0)",
        `ls: ${JSON.stringify(info)}`,
      );
      await wp(env, ["kill", id]);
    } finally {
      await t2.close();
      c.close();
    }
    return r.done();
  },
};

export const vimResize: Scenario = {
  name: "vim: reattach at a new size, then SIGWINCH while attached",
  async run(env) {
    const r = new Report();
    const file = hundredLines(env);
    const id = await wpRun(env, [...VIM, file], { cols: 80, rows: 24 });
    const c = await daemonClient(env);
    const t1 = await UserTerminal.spawn(env, ["attach", id]);
    try {
      await waitFor(() => t1.text.includes("line 1:"), 5000);
      await settle(c, id, t1, 3000);
      await detach(t1, r, "80×24 attach");
    } finally {
      await t1.close();
    }
    const t2 = await UserTerminal.spawn(env, ["attach", id], {
      cols: 100,
      rows: 30,
    });
    try {
      await waitFor(() => t2.text.includes("line 1:"), 5000);
      await sleep(300);
      const s = await settle(c, id, t2, 3000);
      r.check(
        s.daemon.cols === 100 && s.daemon.rows === 30,
        "reattach at 100×30: daemon resized the session",
        `daemon says ${s.daemon.cols}×${s.daemon.rows}`,
      );
      r.screensAgree("reattach at 100×30", s);
      const lines = t2.screen().split("\n");
      r.check(
        lines.length === 30 &&
          lines.slice(0, 28).every((l) => /^line \d+:/.test(l)),
        "vim redrew 28 file rows for the taller window",
        `rows: ${lines.length}; first non-file row: ${lines.findIndex((l) => !/^line \d+:/.test(l))}`,
      );
      t2.resize(120, 35);
      await sleep(500);
      const s2 = await settle(c, id, t2, 3000);
      r.check(
        s2.daemon.cols === 120 && s2.daemon.rows === 35,
        "SIGWINCH to 120×35: wp attach relayed the resize",
        `after SIGWINCH the daemon says ${s2.daemon.cols}×${s2.daemon.rows}`,
      );
      r.screensAgree("after SIGWINCH", s2);
      t2.write(":q!\r");
      await t2.waitExit(5000);
      await wp(env, ["kill", id]);
    } finally {
      await t2.close();
      c.close();
    }
    return r.done();
  },
};

export const topTui: Scenario = {
  name: "top -d 1: attach, detach, reattach, compare",
  async run(env) {
    const r = new Report();
    if (!Bun.which("top")) return { pass: true, notes: ["skipped: no top"] };
    const id = await wpRun(env, ["top", "-d", "1"]);
    const c = await daemonClient(env);
    const t1 = await UserTerminal.spawn(env, ["attach", id]);
    try {
      await waitFor(() => /PID/.test(t1.text), 5000);
      await sleep(200);
      r.screensAgree("attach", await settle(c, id, t1, 4000));
      await detach(t1, r, "top");
    } finally {
      await t1.close();
    }
    await sleep(1500);
    const t2 = await UserTerminal.spawn(env, ["attach", id]);
    try {
      await waitFor(() => /PID/.test(t2.text), 5000);
      await sleep(200);
      const s = await settle(c, id, t2, 4000);
      r.screensAgree("reattach", s);
      r.check(
        t2.altScreen() === s.daemon.altScreen,
        `top: alternate screen ${s.daemon.altScreen ? "on" : "off"} in the daemon and mirrored`,
        `top: daemon alt=${s.daemon.altScreen}, terminal alt=${t2.altScreen()}`,
      );
      t2.write("q");
      const exited = await t2.waitExit(5000);
      r.check(
        exited && t2.exitCode === 0,
        "q ends top; wp exits 0",
        `exited=${exited} code=${t2.exitCode}`,
      );
      await wp(env, ["kill", id]);
    } finally {
      await t2.close();
      c.close();
    }
    return r.done();
  },
};

export const counterTui: Scenario = {
  name: "counter TUI (200 ms redraws): attach, detach, reattach, compare",
  async run(env) {
    const r = new Report();
    const script = path.join(import.meta.dir, "counter.ts");
    const id = await wpRun(env, [process.execPath, "run", script]);
    const c = await daemonClient(env);
    const t1 = await UserTerminal.spawn(env, ["attach", id]);
    let n1 = NaN;
    try {
      await waitFor(() => t1.text.includes("counter"), 5000);
      r.screensAgree("attach", await settle(c, id, t1, 3000));
      // Read before detaching: the detach puts the terminal back on its
      // primary screen, where the counter is not.
      n1 = Number(/counter:\s+(\d+)/.exec(t1.screen())?.[1]);
      await detach(t1, r, "counter");
    } finally {
      await t1.close();
    }
    await sleep(700);
    const t2 = await UserTerminal.spawn(env, ["attach", id]);
    try {
      await waitFor(() => t2.text.includes("counter"), 5000);
      const s = await settle(c, id, t2, 3000);
      r.screensAgree("reattach", s);
      const n2 = Number(/counter:\s+(\d+)/.exec(t2.screen())?.[1]);
      r.check(
        n2 >= n1 + 3,
        `counter kept counting while detached (${n1} at detach, ${n2} on reattach)`,
      );
      const box = t2.vt.styledCells();
      r.check(
        box[2]?.[3]?.bold === true &&
          box[2]?.[3]?.fg.kind === "palette" &&
          box[2]?.[3]?.fg.index === 6,
        "styled: 'counter' label is bold cyan after reattach",
        `styled: ${JSON.stringify(box[2]?.[3])}`,
      );
      t2.write("q");
      const exited = await t2.waitExit(5000);
      r.check(
        exited && t2.exitCode === 0,
        "q ends the TUI; wp exits 0",
        `exited=${exited} code=${t2.exitCode}`,
      );
      await wp(env, ["kill", id]);
    } finally {
      await t2.close();
      c.close();
    }
    return r.done();
  },
};

export const altScreenDetach: Scenario = {
  name: "alternate screen: what the terminal shows after detaching from vim",
  async run(env) {
    const r = new Report();
    const file = hundredLines(env);
    const id = await wpRun(env, [...VIM, file]);
    const marker = "$ ls\r\nhundred.txt\r\n$ wp attach " + id + "\r\n";
    for (const mirror of [true, false]) {
      const t = await UserTerminal.spawn(env, ["attach", id], undefined, {
        WP_ALT_SCREEN: mirror ? "1" : "0",
      });
      // What the user's shell had on screen before typing `wp attach`.
      t.vt.write(new TextEncoder().encode(marker));
      try {
        await waitFor(() => t.text.includes("line 1:"), 5000);
        await sleep(300);
        r.check(
          t.altScreen() === mirror,
          `mirror=${mirror}: terminal on alternate screen while attached = ${mirror}`,
        );
        await detach(t, r, `mirror=${mirror}`);
        const screen = t.screen();
        const first = screen.split("\n")[0] ?? "";
        r.note(
          `mirror=${mirror}: after detach, alt=${t.altScreen()}, row 0 = ${JSON.stringify(first)}, row 3 = ${JSON.stringify(screen.split("\n")[3])}`,
        );
        if (mirror) {
          r.check(
            !t.altScreen() &&
              first === "$ ls" &&
              screen.includes(`[detached ${id}]`),
            "mirror=on: primary screen restored, the pre-attach shell lines are back, [detached] follows them",
            `mirror=on: alt=${t.altScreen()} first=${JSON.stringify(first)}`,
          );
        } else {
          r.check(
            !t.altScreen() && first.startsWith("line 1:"),
            "mirror=off: vim's screen stays painted on the primary screen and the pre-attach lines are gone",
            `mirror=off: first=${JSON.stringify(first)}`,
          );
        }
      } finally {
        await t.close();
      }
    }
    await wp(env, ["kill", "--signal", "SIGKILL", id]);
    return r.done();
  },
};

export const slowClient: Scenario = {
  name: "slow client: one wp attach SIGSTOPped under yes | head -c 4M",
  async run(env) {
    const r = new Report();
    const id = await wpRun(env, ["bash", "--norc", "--noprofile"]);
    const c = await daemonClient(env);
    // The fast client runs under pty-cat.ts in a process of its own, so
    // that nothing this harness does can slow its terminal down.
    const outFile = path.join(env.root, "fast.bin");
    const progress = (): { bytes: number; sawMarker: boolean } => {
      try {
        return JSON.parse(fs.readFileSync(`${outFile}.json`, "utf8"));
      } catch {
        return { bytes: 0, sawMarker: false };
      }
    };
    const fast = Bun.spawn(
      [
        process.execPath,
        "run",
        path.join(import.meta.dir, "pty-cat.ts"),
        "--cols=80",
        "--rows=24",
        `--out=${outFile}`,
        "--marker=FLOOD-2-DONE",
        "--",
        env.wp,
        "attach",
        id,
      ],
      { env: env.env, stdin: "pipe", stdout: "ignore", stderr: "pipe" },
    );
    const slow = await UserTerminal.spawn(env, ["attach", id]);
    const fastVt = (await freshEngine()).create({
      cols: 80,
      rows: 24,
      scrollback: 1000,
    });
    try {
      await waitFor(
        () => slow.text.includes("$ ") && progress().bytes > 0,
        5000,
      );
      r.check(
        await waitFor(() => false, 200).then(
          async () =>
            (await c.ls()).find((x) => x.id === id)?.attachedClients === 2,
        ),
        "both clients attached",
      );
      const chunksBefore = slow.chunks.length;
      process.kill(slow.pid, "SIGSTOP");
      const t0 = performance.now();
      // The marker is computed so the echoed command line cannot match it.
      fast.stdin.write("yes | head -c 4M; echo FLOOD-$((1+1))-DONE\r");
      fast.stdin.flush();
      const ok = await waitFor(() => progress().sawMarker, 30000, 50);
      const floodMs = performance.now() - t0;
      r.check(
        ok,
        `fast client saw the end of the flood after ${floodMs.toFixed(0)} ms`,
      );
      const fastBytes = fs.readFileSync(outFile);
      // The outer PTY's onlcr turns the session's "y\r\n" into "y\r\r\n".
      const ys = (fastBytes.toString("latin1").match(/y\r+\n/g) ?? []).length;
      r.check(
        ys === 2_097_152,
        `fast client received every line (${ys.toLocaleString()} of 2,097,152, ${fastBytes.length.toLocaleString()} bytes)`,
        `fast client received ${ys.toLocaleString()} of 2,097,152 lines`,
      );
      await sleep(Math.max(0, 2000 - floodMs));
      const stopped = await c.stats();
      const attached = stopped.connections.filter((x) => x.attached === id);
      const slowStats = attached.find((x) => x.lagging);
      const fastStats = attached.find((x) => !x.lagging);
      r.check(
        attached.length === 2 && !!slowStats && !!fastStats,
        "daemon: two attached connections, exactly one lagging while stopped",
        `daemon stats: ${JSON.stringify(attached)}`,
      );
      r.check(
        fastStats?.lagCount === 0,
        `fast client never lagged: max queue ${fastStats?.maxQueuedBytes.toLocaleString()} B, ${fastStats?.shortWrites} short writes / ${fastStats?.drains} drains, ${fastStats?.bytesSent.toLocaleString()} B sent`,
        `fast client lagged ${fastStats?.lagCount}× and lost ${fastStats?.droppedBytes.toLocaleString()} B`,
      );
      r.check(
        (slowStats?.droppedBytes ?? 0) > 5_000_000 &&
          (slowStats?.maxQueuedBytes ?? Infinity) <= stopped.queueBound,
        `slow client: dropped ${slowStats?.droppedBytes.toLocaleString()} B in ${slowStats?.lagCount} episode(s), max queue ${slowStats?.maxQueuedBytes.toLocaleString()} B (bound ${stopped.queueBound.toLocaleString()}), kernel took ${slowStats?.firstShortWriteAfterBytes?.toLocaleString()} B before the first short write`,
        `slow client stats: ${JSON.stringify(slowStats)}`,
      );
      r.check(
        stopped.rssBytes !== null && stopped.rssBytes < 200 * 1024 * 1024,
        `daemon RSS ${((stopped.rssBytes ?? 0) / 1048576).toFixed(1)} MiB during the flood`,
      );
      // The fast client's rendering: everything it received, replayed into
      // a fresh terminal, against the session's own screen.
      fastVt.write(fastBytes);
      const daemonScreen = await c.screen(id);
      const diff = diffScreens(daemonScreen.text, fastVt.plainText());
      const fc = fastVt.cursor();
      r.check(
        diff.length === 0 &&
          fc.x === daemonScreen.cursor.x &&
          fc.y === daemonScreen.cursor.y,
        "fast client at the end: screens and cursor agree",
        `fast client at the end: ${diff.length} rows differ: ${diff.slice(0, 4).join(" ; ")}; cursor (${fc.x},${fc.y}) vs (${daemonScreen.cursor.x},${daemonScreen.cursor.y})`,
      );
      process.kill(slow.pid, "SIGCONT");
      const rendered = await waitFor(() => {
        for (let i = chunksBefore; i < slow.chunks.length; i++) {
          if (Buffer.from(slow.chunks[i]!).includes("\x1b[H\x1b[2J"))
            return true;
        }
        return false;
      }, 5000);
      r.check(rendered, "slow client received a render after SIGCONT");
      await sleep(300);
      const after = await c.stats();
      r.check(
        after.connections.every((x) => !x.lagging),
        "daemon: nobody lagging after the slow client drained",
      );
      r.screensAgree(
        "slow client after its render",
        await settle(c, id, slow, 3000),
      );
      r.note(
        `slow client got ${slow.bytes.toLocaleString()} bytes, fast ${fastBytes.length.toLocaleString()}`,
      );
      fast.stdin.write("\x1c");
      fast.stdin.flush();
      const fastCode = await Promise.race([
        fast.exited,
        sleep(5000).then(() => -1),
      ]);
      r.check(
        fastCode === 0 &&
          fs.readFileSync(outFile, "latin1").includes(`[detached ${id}]`),
        "fast: ctrl-\\ detached, wp exited 0, printed [detached]",
        `fast: exit ${fastCode}; stderr ${await new Response(fast.stderr).text()}`,
      );
      await detach(slow, r, "slow");
      await wp(env, ["kill", "--signal", "SIGKILL", id]);
    } finally {
      try {
        process.kill(slow.pid, "SIGCONT");
      } catch {}
      try {
        fast.kill("SIGTERM"); // pty-cat kills its wp attach on SIGTERM
      } catch {}
      await slow.close();
      fastVt.dispose();
      c.close();
    }
    return r.done();
  },
};

export const unknownId: Scenario = {
  name: "unknown id: clear error, exit 1",
  async run(env) {
    const r = new Report();
    await wp(env, ["ls"]); // autostarts the daemon
    const t = await UserTerminal.spawn(env, ["attach", "nope"]);
    try {
      const exited = await t.waitExit(5000);
      r.check(
        exited && t.exitCode === 1 && t.text.includes("no session nope"),
        "wp attach nope: exit 1, 'no session nope'",
        `exited=${exited} code=${t.exitCode} text=${JSON.stringify(t.text)}`,
      );
    } finally {
      await t.close();
    }
    const k = await wp(env, ["kill", "nope"]);
    r.check(
      k.code === 1 && k.stderr.includes("no session"),
      "wp kill nope: exit 1",
    );
    return r.done();
  },
};

export const scenarios: Scenario[] = [
  shellColour,
  vimReattach,
  vimResize,
  topTui,
  counterTui,
  altScreenDetach,
  slowClient,
  unknownId,
];
