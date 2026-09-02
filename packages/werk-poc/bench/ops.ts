// `wp bench ops`: the operational axis from the proposal, §6. Mostly a
// report generator: what a clean build needs on this machine, the platform
// matrix each engine can claim, whether each engine survives `bun build
// --compile` (by compiling four variants into dist/bench-ops/ and running
// each from an empty directory), the binary size per engine set, and the
// cold start of the compiled `wp ls` with a daemon up and of `wp __daemon`
// to readiness.
//
//   bun run bench/ops.ts [--json] [--quick] [--no-compile]
//
// `--quick` (the smoke test) compiles nothing and takes a few runs; it
// reports on whatever binaries an earlier full run left behind.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { connect } from "../src/client/index.ts";
import {
  alive,
  cpuModel,
  kernel,
  mib,
  ms,
  pct,
  sleep,
  table,
  waitFor,
} from "./_lib.ts";

const PKG = path.join(import.meta.dir, "..");
const OUT_DIR = path.join(PKG, "dist", "bench-ops");

export interface OpsOptions {
  json?: boolean;
  quick?: boolean;
  compile?: boolean;
  out?: (line: string) => void;
}

export interface Variant {
  name: string;
  engines: string[];
  binary: string;
  /** Bytes, or null when the binary is not there. */
  size: number | null;
  compileMs: number | null;
  /** Per engine: "ok" or the failure line, from running the binary in an empty directory. */
  loads: Record<string, string>;
}

export interface ColdStart {
  what: string;
  n: number;
  minMs: number;
  p50Ms: number;
  maxMs: number;
}

export interface OpsReport {
  bun: string;
  bunPath: string;
  kernel: string;
  cpu: string;
  toolchain: { tool: string; present: string; needed: string }[];
  platforms: { engine: string; platforms: string; note: string }[];
  variants: Variant[];
  coldStart: ColdStart[];
  tables: string;
}

// ----------------------------------------------------------- toolchain

function toolchain(): OpsReport["toolchain"] {
  const ffiPkg = JSON.parse(
    fs.readFileSync(
      path.join(PKG, "node_modules", "libghostty-vt", "package.json"),
      "utf8",
    ),
  ) as { scripts?: Record<string, string>; version: string };
  const installHooks = Object.keys(ffiPkg.scripts ?? {}).filter((k) =>
    /install/.test(k),
  );
  const has = (cmd: string) => Bun.which(cmd) ?? "absent";
  return [
    {
      tool: "bun",
      present: `${Bun.version} (${process.execPath})`,
      needed: "yes: install, test, build --compile",
    },
    {
      tool: "zig",
      present: has("zig"),
      needed: "no: libghostty arrives prebuilt (wasm vendored, ffi from npm)",
    },
    {
      tool: "cc / gcc",
      present: has("cc"),
      needed: "no: nothing here compiles C",
    },
    {
      tool: "node-gyp",
      present: has("node-gyp"),
      needed: `no: libghostty-vt ${ffiPkg.version} has ${installHooks.length ? installHooks.join(", ") : "no install script"}`,
    },
    {
      tool: "node / npm",
      present: has("node"),
      needed: "no: Bun installs and runs everything",
    },
    {
      tool: "docker",
      present: has("docker"),
      needed: "only for the M5 transport spike",
    },
  ];
}

function platforms(): OpsReport["platforms"] {
  let prebuilds: string[] = [];
  try {
    prebuilds = fs
      .readdirSync(path.join(PKG, "node_modules", "libghostty-vt", "prebuilds"))
      .sort();
  } catch {}
  return [
    {
      engine: "ghostty-wasm",
      platforms:
        "any `bun build --compile` target (linux, darwin, windows; x64, arm64; glibc, musl)",
      note: "one .wasm, no native code; measured on linux-x64-glibc only",
    },
    {
      engine: "ghostty-ffi",
      platforms:
        [...prebuilds, "win32-x64 (vendored)"].join(", ") ||
        "(prebuilds directory not found)",
      note: "the tarball's prebuilds, plus the win32-x64 build vendored in vendor/ghostty-vt-ffi/; no darwin-x64; Bun only (bun:ffi)",
    },
    {
      engine: "xterm-oracle",
      platforms: "any Bun target",
      note: "pure JS; measured on linux-x64-glibc only",
    },
    {
      engine: "Bun.Terminal (the PTY)",
      platforms:
        "linux, darwin per Bun's docs; a ConPTY on windows in practice",
      note: "M0 measured linux-x64 on 1.3.14 and 1.4.0, darwin-arm64 and win32-x64 on 1.3.14; a ConPTY on windows, at ~200x the latency",
    },
  ];
}

// ------------------------------------------------------------- compile

const VARIANTS: { name: string; engines: string[] }[] = [
  { name: "empty", engines: [] },
  { name: "wasm", engines: ["ghostty-wasm"] },
  { name: "wasm+ffi", engines: ["ghostty-wasm", "ghostty-ffi"] },
  {
    name: "wasm+ffi+oracle",
    engines: ["ghostty-wasm", "ghostty-ffi", "xterm-oracle"],
  },
];

/** A tiny program that loads the named engines through the registry and prints one line per engine. */
function entrySource(engines: string[]): string {
  const imports = engines
    .map((id) => `import "../../../src/engine/${id}/bun.ts";`)
    .join("\n");
  return `${imports}
import { getEngine } from "../../../src/engine/registry.ts";
const ids = ${JSON.stringify(engines)};
if (ids.length === 0) console.log("empty: ok");
for (const id of ids) {
  try {
    const e = await getEngine(id);
    const t = e.create({ cols: 10, rows: 2, scrollback: 10 });
    t.write(new TextEncoder().encode("ok"));
    const flush = (t as { flush?: () => Promise<void> }).flush;
    if (flush) await flush.call(t);
    console.log(id + ": " + (t.plainText().startsWith("ok") ? "ok" : "FAILED wrong text"));
    t.dispose();
  } catch (e) {
    console.log(id + ": FAILED " + (e as Error).constructor.name + ": " + (e as Error).message);
  }
}
`;
}

function compile(entry: string, out: string): number {
  const t0 = performance.now();
  const build = Bun.spawnSync(
    ["bun", "build", "--compile", entry, "--outfile", out],
    {
      cwd: PKG,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (build.exitCode !== 0) throw new Error(build.stderr.toString());
  return performance.now() - t0;
}

function runFromEmptyDir(
  binary: string,
  args: string[] = [],
): { stdout: string; exitCode: number } {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "wp-ops-empty-"));
  try {
    const run = Bun.spawnSync([binary, ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: "/nonexistent", TMPDIR: cwd, HOME: cwd },
    });
    return {
      stdout: run.stdout.toString() + run.stderr.toString(),
      exitCode: run.exitCode,
    };
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function variants(
  doCompile: boolean,
  log: (l: string) => void,
): Promise<Variant[]> {
  fs.mkdirSync(path.join(OUT_DIR, "entries"), { recursive: true });
  const out: Variant[] = [];
  for (const v of VARIANTS) {
    const entry = path.join(
      OUT_DIR,
      "entries",
      `${v.name.replace(/\+/g, "-")}.ts`,
    );
    const binary = path.join(OUT_DIR, v.name.replace(/\+/g, "-"));
    let compileMs: number | null = null;
    if (doCompile) {
      fs.writeFileSync(entry, entrySource(v.engines));
      log(`compiling ${v.name} …`);
      compileMs = compile(entry, binary);
    }
    const loads: Record<string, string> = {};
    let size: number | null = null;
    if (fs.existsSync(binary)) {
      size = fs.statSync(binary).size;
      const run = runFromEmptyDir(binary);
      for (const id of v.engines) {
        const m = new RegExp(`^${id}: (.*)$`, "m").exec(run.stdout);
        loads[id] = m ? m[1]! : `no output (exit ${run.exitCode})`;
      }
      if (v.engines.length === 0)
        loads["(none)"] = /empty: ok/.test(run.stdout)
          ? "ok"
          : `exit ${run.exitCode}`;
    }
    out.push({
      name: v.name,
      engines: v.engines,
      binary,
      size,
      compileMs,
      loads,
    });
  }
  // The real thing too: `wp` itself, with its web bundle.
  const wp = path.join(OUT_DIR, "wp");
  let wpCompileMs: number | null = null;
  if (doCompile) {
    log("compiling wp (build:web first) …");
    const web = Bun.spawnSync(["bun", "run", "build:web"], {
      cwd: PKG,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (web.exitCode !== 0) throw new Error(web.stderr.toString());
    wpCompileMs = compile(path.join(PKG, "src", "cli", "main.ts"), wp);
  }
  const wpLoads: Record<string, string> = {};
  if (fs.existsSync(wp)) {
    const run = runFromEmptyDir(wp, ["caps"]);
    for (const id of ["ghostty-wasm", "ghostty-ffi", "xterm-oracle"])
      wpLoads[id] = new RegExp(`did not load: (.*)`)
        .exec(run.stdout)?.[1]
        ?.includes(id)
        ? "FAILED"
        : new RegExp(`\\b${id}\\b`).test(run.stdout)
          ? "ok (in `wp caps`)"
          : `not in output (exit ${run.exitCode})`;
  }
  out.push({
    name: "wp (all three + web bundle)",
    engines: ["ghostty-wasm", "ghostty-ffi", "xterm-oracle"],
    binary: wp,
    size: fs.existsSync(wp) ? fs.statSync(wp).size : null,
    compileMs: wpCompileMs,
    loads: wpLoads,
  });
  return out;
}

// ----------------------------------------------------------- cold start

function timeRuns(
  n: number,
  run: () => void,
): { minMs: number; p50Ms: number; maxMs: number } {
  const xs: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    run();
    xs.push(performance.now() - t0);
  }
  return {
    minMs: Math.min(...xs),
    p50Ms: pct(xs, 0.5),
    maxMs: Math.max(...xs),
  };
}

/** Spawns `wp __daemon` the way the launcher does and times the ready token on fd 3. */
async function daemonToReady(
  argv: string[],
  dir: string,
  stateDir: string,
): Promise<number> {
  const t0 = performance.now();
  const proc = Bun.spawn(
    [...argv, "__daemon", `--dir=${dir}`, "--ready-fd=3"],
    {
      detached: true,
      cwd: "/",
      env: { ...process.env, WP_STATE_DIR: stateDir } as Record<string, string>,
      stdio: ["ignore", "ignore", "ignore", "pipe"],
    },
  );
  proc.unref();
  // Readiness is a successful hello over the socket, not the pipe: the pipe
  // read stalls under `bun test` (findings/m2.md), and the launcher itself
  // treats the socket as the authority. Poll a fresh connection until one
  // completes its hello, and time to there.
  let c: Awaited<ReturnType<typeof connect>> | null = null;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    c = await connect({ dir, autostart: false, timeoutMs: 1000 }).catch(
      () => null,
    );
    if (c) break;
    await sleep(2);
  }
  const elapsed = performance.now() - t0;
  if (!c) {
    try {
      process.kill(proc.pid, "SIGKILL");
    } catch {}
    throw new Error(
      `daemon did not answer on ${path.join(dir, "wp.sock")} within 10 s`,
    );
  }
  const pid = c.daemon.pid;
  await c.shutdown();
  c.close();
  if (!(await waitFor(() => !alive(pid), 5000))) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  return elapsed;
}

async function coldStart(
  wp: string | null,
  quick: boolean,
  log: (l: string) => void,
): Promise<ColdStart[]> {
  const out: ColdStart[] = [];
  const nLs = quick ? 3 : 20;
  const nDaemon = quick ? 2 : 10;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wp-ops-cold-"));
  const stateDir = path.join(root, "state");
  const interpreted = [
    process.execPath,
    "run",
    path.join(PKG, "src", "cli", "main.ts"),
  ];
  try {
    const targets: [string, string[]][] = [];
    if (wp) targets.push(["compiled wp", [wp]]);
    targets.push(["interpreted (bun run src/cli/main.ts)", interpreted]);
    for (const [label, argv] of targets) {
      // Process start alone: --help touches no daemon and no engine.
      const help = timeRuns(nLs, () => {
        Bun.spawnSync([...argv, "--help"], { stdout: "pipe", stderr: "pipe" });
      });
      out.push({
        what: `${label}: wp --help (no daemon, no engine)`,
        n: nLs,
        ...help,
      });

      // `wp __daemon` to readiness, fresh runtime dir each time.
      const readyMs: number[] = [];
      for (let i = 0; i < nDaemon; i++) {
        const dir = path.join(root, `run-${label.replace(/\W+/g, "-")}-${i}`);
        readyMs.push(await daemonToReady(argv, dir, stateDir));
      }
      out.push({
        what: `${label}: wp __daemon to ready`,
        n: nDaemon,
        minMs: Math.min(...readyMs),
        p50Ms: pct(readyMs, 0.5),
        maxMs: Math.max(...readyMs),
      });

      // `wp ls` with a daemon already up.
      const dir = path.join(root, `run-${label.replace(/\W+/g, "-")}-ls`);
      process.env.WP_STATE_DIR = stateDir;
      const client = await connect({ dir, autostart: true });
      const pid = client.daemon.pid;
      const sock = path.join(dir, "wp.sock");
      try {
        Bun.spawnSync([...argv, "ls", "--socket", sock], {
          stdout: "pipe",
          stderr: "pipe",
        }); // warm
        const ls = timeRuns(nLs, () => {
          const r = Bun.spawnSync([...argv, "ls", "--socket", sock], {
            stdout: "pipe",
            stderr: "pipe",
          });
          if (r.exitCode !== 0)
            throw new Error(`wp ls failed: ${r.stderr.toString()}`);
        });
        out.push({ what: `${label}: wp ls, daemon up`, n: nLs, ...ls });
      } finally {
        await client.shutdown();
        client.close();
        await waitFor(() => !alive(pid), 5000);
      }
      log(`cold start measured: ${label}`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  return out;
}

// ------------------------------------------------------------------ run

export async function runOps(opts: OpsOptions = {}): Promise<OpsReport> {
  const out = opts.out ?? ((l: string) => console.log(l));
  const quick = opts.quick ?? false;
  const doCompile = opts.compile ?? !quick;
  const lines: string[] = [];
  const emit = (l: string) => {
    lines.push(l);
    if (!opts.json) out(l);
  };
  const log = (l: string) => {
    if (!opts.json) console.error(`ops: ${l}`);
  };

  const report: OpsReport = {
    bun: Bun.version,
    bunPath: process.execPath,
    kernel: kernel(),
    cpu: cpuModel(),
    toolchain: toolchain(),
    platforms: platforms(),
    variants: [],
    coldStart: [],
    tables: "",
  };
  emit(
    `wp bench ops — Bun ${report.bun}, kernel ${report.kernel}, ${report.cpu}${quick ? " (quick)" : ""}`,
  );

  emit("\n## What a clean build needs on this machine\n");
  emit(
    table(
      ["Tool", "Present", "Needed"],
      report.toolchain.map((t) => [t.tool, t.present, t.needed]),
    ),
  );

  emit("\n## Platform matrix\n");
  emit(
    table(
      ["Engine", "Platforms", "Note"],
      report.platforms.map((p) => [p.engine, p.platforms, p.note]),
    ),
  );

  emit(
    `\n## \`bun build --compile\`: survival and size (binaries in ${path.relative(PKG, OUT_DIR)}/)\n`,
  );
  report.variants = await variants(doCompile, log);
  const empty = report.variants.find((v) => v.name === "empty")?.size ?? null;
  emit(
    table(
      [
        "Variant",
        "Size",
        "Δ over empty",
        "Compile",
        "Engines load from an empty directory",
      ],
      report.variants.map((v) => [
        v.name,
        v.size == null ? "not built" : mib(v.size),
        v.size == null || empty == null ? "-" : mib(v.size - empty, 2),
        v.compileMs == null ? "-" : ms(v.compileMs, 0),
        Object.keys(v.loads).length === 0
          ? "-"
          : Object.entries(v.loads)
              .map(([k, s]) => `${k}: ${s}`)
              .join("; "),
      ]),
    ),
  );

  emit("\n## Cold start (ms)\n");
  const wp =
    report.variants.find((v) => v.name.startsWith("wp"))?.binary ?? null;
  report.coldStart = await coldStart(
    wp && fs.existsSync(wp) ? wp : null,
    quick,
    log,
  );
  emit(
    table(
      ["What", "n", "min", "p50", "max"],
      report.coldStart.map((c) => [
        c.what,
        String(c.n),
        ms(c.minMs, 1),
        ms(c.p50Ms, 1),
        ms(c.maxMs, 1),
      ]),
    ),
  );

  report.tables = lines.join("\n");
  if (opts.json) out(JSON.stringify(report, null, 2));
  return report;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  await runOps({
    json: args.includes("--json"),
    quick: args.includes("--quick"),
    compile: args.includes("--no-compile") ? false : undefined,
  });
  process.exit(0);
}
