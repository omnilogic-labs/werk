// Direct probes of the platform primitives the werk proof of concept leans
// on, run under Bun on a Windows runner. Each probe prints one `PROBE <name>:
// <verdict>` line and never throws, so one run answers every question at
// once. Run from packages/werk-poc so the relative imports resolve:
//
//   bun run ../../.github/ci/windows-probes.ts

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const probes = process.argv.slice(2);
const want = (name: string) => probes.length === 0 || probes.includes(name);

function say(name: string, verdict: string): void {
  console.log(`PROBE ${name}: ${verdict}`);
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
    const { tryLock } =
      await import("../../packages/werk-poc/src/daemon/flock.ts");
    const p = path.join(os.tmpdir(), `wp-probe-${process.pid}.lock`);
    const lock = tryLock(p);
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
    say(
      name,
      `ok — listen and connect round-tripped ${JSON.stringify(echoed)}`,
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
  try {
    const proc = Bun.spawn({
      cmd: ["cmd.exe", "/c", "echo hello-from-pty"],
      // @ts-expect-error probing a POSIX-only option on Windows on purpose
      terminal: { columns: 80, rows: 24 },
    });
    await proc.exited;
    say("spawn-terminal", "ok — spawn with terminal accepted");
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
  try {
    const p = path.join(os.tmpdir(), `wp-probe-fd3-${process.pid}.txt`);
    const fd = fs.openSync(p, "w+");
    const proc = Bun.spawn({
      cmd: ["cmd.exe", "/c", "echo fd3"],
      stdio: ["ignore", "ignore", "ignore"],
      // @ts-expect-error extra fds are not in the public types
      extraFds: [fd],
    });
    await proc.exited;
    fs.closeSync(fd);
    say("spawn-extra-fd", `ok — exit ${proc.exitCode}`);
  } catch (e) {
    say("spawn-extra-fd", `fail — ${firstLine(e)}`);
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

// --------------------------------------------------------------- sh -c
if (want("sh")) {
  try {
    const proc = Bun.spawn({
      cmd: ["sh", "-c", "echo sh-works"],
      stdout: "pipe",
    });
    const text = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    say("sh-c", `ok — ${JSON.stringify(text)} (exit ${proc.exitCode})`);
  } catch (e) {
    say("sh-c", `fail — ${firstLine(e)}`);
  }
}
