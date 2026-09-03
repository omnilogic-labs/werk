// Direct probes of the platform primitives the werk proof of concept leans
// on, run under Bun on a Windows runner. Each probe prints one `PROBE <name>:
// <verdict>` line and never throws, so one run answers every question at
// once. Run from the repository root:
//
//   bun run .github/ci/windows-probes.ts
//
// The exit code is the verdict: 1 when a probe printed `fail` that is not
// named in `PROBES_KNOWN_FAIL` (space-separated), 0 otherwise. Every probe
// runs either way.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const probes = process.argv.slice(2);
const want = (name: string) => probes.length === 0 || probes.includes(name);

const verdicts: { name: string; failed: boolean }[] = [];

function say(name: string, verdict: string): void {
  console.log(`PROBE ${name}: ${verdict}`);
  verdicts.push({ name, failed: /\bfail\b/.test(verdict) });
}

function firstLine(e: unknown): string {
  const s = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return s.split("\n")[0]!.trim();
}

console.log(
  `platform=${process.platform} arch=${process.arch} bun=${Bun.version} release=${os.release()}`,
);

// ------------------------------------------------------------- bun:ffi
if (want("ffi")) {
  try {
    const { dlopen, FFIType } = await import("bun:ffi");
    let ok = false;
    for (const [libName, sym] of [
      ["kernel32.dll", "GetCurrentProcessId"],
      ["msvcrt.dll", "_getpid"],
      ["ucrtbase.dll", "_getpid"],
    ] as const) {
      try {
        const lib = dlopen(libName, {
          [sym]: { args: [], returns: FFIType.u32 },
        });
        const pid = (lib.symbols as Record<string, () => number>)[sym]!();
        say("ffi-dlopen", `ok — ${libName}!${sym}() = ${pid}`);
        ok = true;
        break;
      } catch (e) {
        say("ffi-dlopen-attempt", `${libName}!${sym} — ${firstLine(e)}`);
      }
    }
    if (!ok) say("ffi-dlopen", "fail — no candidate library opened");
  } catch (e) {
    say("ffi-dlopen", `fail — bun:ffi unavailable: ${firstLine(e)}`);
  }
}

// --------------------------------------------------------- flock, as werk does
if (want("flock")) {
  try {
    const { platform } =
      await import("../../packages/werk-poc/src/platform/index.ts");
    const p = path.join(os.tmpdir(), `wp-probe-${process.pid}.lock`);
    const lock = platform.lock(p);
    say("flock", lock ? "ok — lock taken" : "fail — lock refused (no error)");
    lock?.release();
  } catch (e) {
    say("flock", `fail — ${firstLine(e)}`);
  }
}

// ------------------------------------------------- AF_UNIX / named pipes
async function socketProbe(name: string, addr: string): Promise<void> {
  let listener: { stop: (force?: boolean) => void } | undefined;
  try {
    listener = Bun.listen<undefined>({
      unix: addr,
      socket: {
        data(socket, chunk) {
          socket.write(chunk);
        },
        open() {},
        error() {},
      },
    });
  } catch (e) {
    say(name, `listen fail — ${firstLine(e)}`);
    return;
  }
  try {
    const echoed = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("connect timed out")),
        5000,
      );
      Bun.connect<undefined>({
        unix: addr,
        socket: {
          open(socket) {
            socket.write("ping");
          },
          data(socket, chunk) {
            clearTimeout(timer);
            resolve(new TextDecoder().decode(chunk));
            socket.end();
          },
          error(_s, e) {
            clearTimeout(timer);
            reject(e);
          },
          connectError(_s, e) {
            clearTimeout(timer);
            reject(e);
          },
        },
      }).catch((e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
    let onDisk = "unknown";
    try {
      onDisk = fs.existsSync(addr) ? "yes" : "no";
    } catch {}
    say(
      name,
      `ok — listen and connect round-tripped ${JSON.stringify(echoed)} (address on disk: ${onDisk})`,
    );
  } catch (e) {
    say(name, `listen ok, connect fail — ${firstLine(e)}`);
  } finally {
    try {
      listener?.stop(true);
    } catch {}
  }
}

if (want("unix")) {
  await socketProbe(
    "unix-socket-fs-path",
    path.join(os.tmpdir(), `wp-probe-${process.pid}.sock`),
  );
  await socketProbe(
    "unix-socket-named-pipe",
    `\\\\.\\pipe\\wp-probe-${process.pid}`,
  );
}

// ------------------------------------------------------------ Bun.Terminal
if (want("terminal")) {
  say(
    "Bun.Terminal-type",
    typeof (Bun as unknown as { Terminal?: unknown }).Terminal,
  );
  const chunks: string[] = [];
  try {
    const proc = Bun.spawn(["cmd.exe", "/c", "echo hello-from-pty"], {
      // @ts-expect-error the option is typed POSIX-only; probing it anyway
      terminal: {
        cols: 80,
        rows: 24,
        data: (_t: unknown, d: Uint8Array) =>
          chunks.push(new TextDecoder().decode(d)),
        exit: () => {},
      },
    });
    say(
      "spawn-terminal-accepted",
      `proc.terminal is ${String((proc as { terminal?: unknown }).terminal?.constructor?.name)}`,
    );
    const until = Date.now() + 5000;
    while (Date.now() < until && chunks.join("").length === 0)
      await Bun.sleep(25);
    await proc.exited;
    await Bun.sleep(100);
    const text = chunks.join("");
    say(
      "spawn-terminal",
      text.length > 0
        ? `ok — the child wrote ${text.length} bytes to the terminal: ${JSON.stringify(text.slice(0, 120))}`
        : "no data — spawn returned but nothing came back through the terminal callback",
    );
  } catch (e) {
    say("spawn-terminal", `fail — ${firstLine(e)}`);
  }
}

// ------------------------------------------------------- detached + fd 3
if (want("detached")) {
  try {
    const proc = Bun.spawn({
      cmd: ["cmd.exe", "/c", "echo detached-ok"],
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    await proc.exited;
    say("spawn-detached", `ok — exit ${proc.exitCode}`);
  } catch (e) {
    say("spawn-detached", `fail — ${firstLine(e)}`);
  }
  // Exactly what src/daemon/launch.ts does: a fourth stdio pipe the child
  // reports readiness on, read with fs.readSync off the returned fd number.
  try {
    const proc = Bun.spawn(["cmd.exe", "/c", "echo ready>&3"], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore", "pipe"],
    });
    const fd = (proc as { stdio: unknown[] }).stdio[3];
    say("readiness-pipe-fd", `stdio[3] is ${typeof fd} ${String(fd)}`);
    if (typeof fd === "number") {
      const buf = Buffer.alloc(4096);
      const deadline = Date.now() + 3000;
      let read = "";
      let verdict = "no bytes before the deadline";
      while (Date.now() < deadline) {
        try {
          const n = fs.readSync(fd, buf, 0, buf.length, null);
          if (n === 0) {
            verdict = `ok — EOF after ${JSON.stringify(read)}`;
            break;
          }
          read += buf.subarray(0, n).toString("utf8");
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (code === "EAGAIN") {
            await Bun.sleep(5);
            continue;
          }
          verdict = `fail — ${firstLine(e)}`;
          break;
        }
      }
      say("readiness-pipe-read", verdict);
    }
    await proc.exited;
  } catch (e) {
    say("readiness-pipe-read", `fail — ${firstLine(e)}`);
  }
}

// ------------------------------------------------------- libghostty-vt ffi
if (want("ghostty")) {
  try {
    const mod =
      await import("../../packages/werk-poc/src/engine/ghostty-ffi/bun.ts");
    const platform = (mod as { ffiPlatform: () => string }).ffiPlatform();
    say("ffi-platform", platform);
    try {
      await (
        mod as { extractPrebuilds: (p?: string) => Promise<unknown> }
      ).extractPrebuilds(platform);
      say("ffi-prebuild", "ok — a prebuild exists for this platform");
    } catch (e) {
      say("ffi-prebuild", `fail — ${firstLine(e)}`);
    }
    try {
      await (
        mod as { loadGhosttyFfiEngine: () => Promise<unknown> }
      ).loadGhosttyFfiEngine();
      say("ffi-engine", "ok — engine loaded");
    } catch (e) {
      say("ffi-engine", `fail — ${firstLine(e)}`);
    }
  } catch (e) {
    say("ffi-platform", `fail — module did not import: ${firstLine(e)}`);
  }
}

// ------------------------------------------------------------------ paths
if (want("paths")) {
  try {
    const mod = await import("../../packages/werk-poc/src/daemon/paths.ts");
    const m = mod as {
      defaultRuntimeDir: () => string;
      defaultStateDir: () => string;
    };
    say("runtime-dir", m.defaultRuntimeDir());
    say("state-dir", m.defaultStateDir());
    say("getuid", typeof process.getuid);
  } catch (e) {
    say("paths", `fail — ${firstLine(e)}`);
  }
}

// ------------------------------------------------ ConPTY, bytes and cells
// ConPTY re-encodes what a child writes rather than passing the bytes
// through, so a proof-of-concept assertion naming an exact byte sequence
// cannot hold here. What an oracle can rest on instead is the grid: the
// cells the engine ends up with after consuming whatever ConPTY chose to
// emit. These probes ask whether that grid is stable — the same input, four
// sessions, compared as bytes and as cells — and print what one session
// actually emitted, so the shape is on the record rather than inferred.
//
// `conpty-*-grid-repeatable` is the watchdog for step 3 of
// docs/proposals/01-cross-platform.md: a grid that differs between runs of
// the same input is the result that says a Windows host cannot carry the
// fidelity guarantee the proof of concept measures.
if (want("conpty")) {
  const dec = new TextDecoder();

  interface Session {
    bytes: Uint8Array;
    text: string;
    rows: string[];
    cells: string;
    cursor: string;
  }

  type Drive = (
    write: (s: string) => void,
    text: () => string,
  ) => Promise<void>;

  const until = async (pred: () => boolean, ms: number): Promise<boolean> => {
    const end = Date.now() + ms;
    while (Date.now() < end && !pred()) await Bun.sleep(25);
    return pred();
  };

  /** Everything one ConPTY emitted for one scripted session, and the grid it leaves. */
  async function conptySession(
    argv: string[],
    drive: Drive | null,
    engine: {
      create: (o: { cols: number; rows: number; scrollback: number }) => {
        write: (b: Uint8Array) => void;
        plainText: () => string;
        styledCells: () => unknown;
        cursor: () => { x: number; y: number };
        dispose: () => void;
      };
    },
  ): Promise<Session> {
    const chunks: Uint8Array[] = [];
    let done = false;
    const proc = Bun.spawn(argv, {
      env: { ...process.env, PS1: "$ ", TERM: "xterm-256color" },
      // @ts-expect-error the option is typed POSIX-only; it works here
      terminal: {
        cols: 80,
        rows: 24,
        data: (_t: unknown, d: Uint8Array) => chunks.push(new Uint8Array(d)),
        exit: () => {
          done = true;
        },
      },
    });
    const term = proc as unknown as {
      terminal?: { write: (b: string) => void; close: () => void };
    };
    const text = () => chunks.map((c) => dec.decode(c)).join("");
    if (drive) await drive((s) => term.terminal?.write(s), text);
    else await until(() => done, 10_000);
    await Bun.sleep(400);
    try {
      term.terminal?.close();
    } catch {}
    try {
      proc.kill();
    } catch {}
    const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let off = 0;
    for (const c of chunks) {
      bytes.set(c, off);
      off += c.length;
    }
    const vt = engine.create({ cols: 80, rows: 24, scrollback: 1000 });
    vt.write(bytes);
    const plain = vt.plainText();
    const cells = JSON.stringify(vt.styledCells());
    const cur = vt.cursor();
    vt.dispose();
    return {
      bytes,
      text: dec.decode(bytes),
      rows: plain.split("\n").filter((r) => r.trim() !== ""),
      cells,
      cursor: `${cur.x},${cur.y}`,
    };
  }

  const sha = (b: Uint8Array | string) =>
    new Bun.CryptoHasher("sha256").update(b).digest("hex").slice(0, 12);

  try {
    const { loadGhosttyWasmEngine } =
      await import("../../packages/werk-poc/src/engine/ghostty-wasm/bun.ts");
    const engine = await loadGhosttyWasmEngine();

    // A session that writes and exits on its own: no input from this side,
    // so a difference between runs belongs to ConPTY rather than to timing
    // the probe controls.
    const runs: Record<string, Session[]> = { static: [], echo: [] };
    for (let i = 0; i < 4; i++) {
      runs.static!.push(
        await conptySession(
          [
            "sh",
            "-c",
            "printf 'hello\\n'; printf '\\033[1;31mred\\033[0m plain\\n'; printf 'line3\\n'",
          ],
          null,
          engine,
        ),
      );
    }

    // The session daemon.test.ts drives: a shell, a prompt, a typed line, and
    // that line's output echoed back through the ConPTY.
    for (let i = 0; i < 4; i++) {
      runs.echo!.push(
        await conptySession(
          ["sh", "-c", "echo hello; exec sh"],
          async (write, text) => {
            await until(() => text().includes("hello"), 5000);
            await until(() => /\$ $/.test(text()), 5000);
            write("echo hi\r");
            await until(() => /hi[\s\S]*\$ $/.test(text()), 5000);
            await Bun.sleep(500);
            write("exit\r");
            await Bun.sleep(500);
          },
          engine,
        ),
      );
    }

    const same = (xs: string[]) => xs.every((x) => x === xs[0]);
    for (const [name, group] of Object.entries(runs)) {
      const bytes = group.map((r) => sha(r.bytes));
      const cells = group.map((r) => sha(r.cells));
      const cursors = group.map((r) => r.cursor);
      say(
        `conpty-${name}-bytes-repeatable`,
        same(bytes)
          ? `identical — 4 sessions, the same ${group[0]!.bytes.length} bytes (sha ${bytes[0]})`
          : `differ — 4 sessions: ${group.map((r, i) => `${r.bytes.length}B/${bytes[i]}`).join(" ")}`,
      );
      say(
        `conpty-${name}-grid-repeatable`,
        same(cells) && same(cursors)
          ? `ok — 4 sessions, identical cells and cursor (${cursors[0]}, sha ${cells[0]})`
          : `fail — 4 sessions differ in cells ${cells.join(" ")} cursors ${cursors.join(" ")}`,
      );
    }

    // What one echo session emitted, and whether the byte-shaped assertion
    // daemon.test.ts used to make could ever match it.
    const one = runs.echo![0]!;
    say(
      "conpty-echo-stream",
      `${one.bytes.length} B: ${JSON.stringify(one.text.slice(0, 400))}`,
    );
    say(
      "conpty-echo-byte-assertion",
      /echo hi\r\n(.*\r\n)?hi\r\n/.test(one.text)
        ? "matches — the stream carries the echo the POSIX assertion expects"
        : "does not match — a byte-shaped assertion cannot hold on this stream",
    );
    say("conpty-echo-grid", `rows: ${JSON.stringify(one.rows)}`);
    say("conpty-static-grid", `rows: ${JSON.stringify(runs.static![0]!.rows)}`);
  } catch (e) {
    say("conpty-grid-repeatable", `fail — ${firstLine(e)}`);
  }
}

// --------------------------------------------------------------- sh -c
if (want("sh")) {
  try {
    const proc = Bun.spawn({
      cmd: ["sh", "-c", "echo sh-works"],
      stdout: "pipe",
    });
    const text = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    say(
      "sh-c",
      `ok — ${JSON.stringify(text)} (exit ${proc.exitCode}); sh resolves to ${Bun.which("sh")}`,
    );
  } catch (e) {
    say("sh-c", `fail — ${firstLine(e)}`);
  }
}

// -------------------------------------------------- the daemon, in process
// The launcher and the lock both stop before the daemon's socket is reached,
// so start the server in this process instead and ask what the layers above
// them can do: does the socket come up where the daemon would put it, does
// the protocol handshake complete, and does a session spawn and produce
// output. Nothing here is how werk runs; it is how to see past the first two
// failures without changing the proof of concept.
if (want("daemon-inproc")) {
  try {
    const { daemonPaths, ensureRuntimeDir } =
      await import("../../packages/werk-poc/src/daemon/paths.ts");
    const { startServer } =
      await import("../../packages/werk-poc/src/daemon/server.ts");
    const { connect } =
      await import("../../packages/werk-poc/src/client/index.ts");

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wp-probe-daemon-"));
    const paths = daemonPaths(dir, path.join(dir, "state"));
    ensureRuntimeDir(dir);
    fs.mkdirSync(paths.state, { recursive: true });

    let server: { shutdown: (why: string) => void } | undefined;
    try {
      server = await startServer(paths, () => {});
      say("daemon-listen", `ok — listening on ${paths.socket}`);
    } catch (e) {
      say("daemon-listen", `fail — ${firstLine(e)}`);
    }

    if (server) {
      try {
        const client = await connect({ socket: paths.socket });
        say("daemon-hello", "ok — the client handshake completed");
        try {
          say("daemon-ls", `ok — ${(await client.ls()).length} sessions`);
        } catch (e) {
          say("daemon-ls", `fail — ${firstLine(e)}`);
        }
        try {
          const r = await client.run({
            argv: ["cmd.exe", "/c", "echo hello-from-session"],
            cols: 80,
            rows: 24,
          });
          say("daemon-run", `ok — session ${JSON.stringify(r)}`);
        } catch (e) {
          say("daemon-run", `fail — ${firstLine(e)}`);
        }
        client.close();
      } catch (e) {
        say("daemon-hello", `fail — ${firstLine(e)}`);
      }
      try {
        server.shutdown("probe");
      } catch {}
    }
  } catch (e) {
    say("daemon-inproc", `fail — did not get that far: ${firstLine(e)}`);
  }
}

// ---------------------------------------------------------------- verdict
// The tally, as a `DETAIL:` line windows.sh lifts into the report, and the
// exit code. A probe that is known to fail on this platform is recorded, not
// gated; any other failing probe is a regression.
{
  const known = new Set(
    (process.env.PROBES_KNOWN_FAIL ?? "").split(/[\s,]+/).filter(Boolean),
  );
  const failed = verdicts.filter((v) => v.failed).map((v) => v.name);
  const unexpected = failed.filter((n) => !known.has(n));
  const list = (xs: string[]) => (xs.length ? `: ${xs.join(", ")}` : "");
  console.log(
    `DETAIL: ${verdicts.length} probe verdicts, ${failed.length} fail${list(failed)}` +
      (unexpected.length
        ? ` — not on the known-fail list${list(unexpected)}`
        : failed.length
          ? " — all on the known-fail list"
          : ""),
  );
  if (unexpected.length > 0) process.exitCode = 1;
}
