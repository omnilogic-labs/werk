// Runs every M0 probe under one or more Bun binaries, interpreted and
// compiled, and prints a summary table. Usage:
//
//   bun run spikes/m0/run-all.ts [--bun /path/to/bun]... [--only 03] [--timeout 120000]
//
// With no --bun, uses the Bun running this script plus the user-local 1.4
// install at ~/.cache/werk-poc/bun-1.4/bin/bun if it exists.

import { readdirSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const here = dirname(import.meta.path);
const pkg = join(here, "..", "..");
const args = process.argv.slice(2);
const buns: string[] = [];
let only = "";
let timeoutMs = 120_000;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--bun") buns.push(args[++i]!);
  else if (args[i] === "--only") only = args[++i]!;
  else if (args[i] === "--timeout") timeoutMs = Number(args[++i]);
}
if (buns.length === 0) {
  buns.push(process.execPath);
  const b14 = join(homedir(), ".cache", "werk-poc", "bun-1.4", "bin", "bun");
  if (existsSync(b14)) buns.push(b14);
}

const probes = readdirSync(here)
  .filter((f) => /^\d\d-.*\.ts$/.test(f) && f.startsWith(only))
  .sort();

interface Cell {
  status: string;
  summary: string;
  ms: number;
  log: string;
}
type Mode = "interpreted" | "compiled";

async function runCmd(
  cmd: string[],
  logPath: string,
): Promise<{ code: number | null; stdout: string; ms: number; hung: boolean }> {
  const t0 = Date.now();
  const proc = Bun.spawn(cmd, {
    cwd: pkg,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  let hung = false;
  const timer = setTimeout(() => {
    hung = true;
    proc.kill("SIGKILL");
  }, timeoutMs);
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  clearTimeout(timer);
  writeFileSync(
    logPath,
    `$ ${cmd.join(" ")}\n--- stdout\n${stdout}\n--- stderr\n${stderr}\n--- exit ${code}${hung ? " (killed: timeout)" : ""}\n`,
  );
  return { code, stdout, ms: Date.now() - t0, hung };
}

function parse(r: Awaited<ReturnType<typeof runCmd>>, logPath: string): Cell {
  const line = r.stdout.split("\n").find((l) => l.startsWith("RESULT "));
  if (r.hung)
    return {
      status: "hung",
      summary: `no result within ${timeoutMs} ms`,
      ms: r.ms,
      log: logPath,
    };
  if (!line)
    return {
      status: "crash",
      summary: `exit ${r.code}, no RESULT line`,
      ms: r.ms,
      log: logPath,
    };
  const j = JSON.parse(line.slice(7));
  return { status: j.status, summary: j.summary, ms: r.ms, log: logPath };
}

const results: Record<string, Record<string, Cell>> = {};
const columns: string[] = [];
const versions: Record<string, string> = {};

for (const bun of buns) {
  const version = Bun.spawnSync([bun, "--version"]).stdout.toString().trim();
  versions[bun] = version;
  const outDir = join(pkg, "dist", "m0", version);
  mkdirSync(outDir, { recursive: true });
  for (const mode of ["interpreted", "compiled"] as Mode[]) {
    const col = `${version} ${mode}`;
    columns.push(col);
    for (const probe of probes) {
      const name = probe.replace(/\.ts$/, "");
      const logPath = join(outDir, `${name}.${mode}.log`);
      process.stderr.write(`[${col}] ${name} ... `);
      let cell: Cell;
      if (mode === "interpreted") {
        cell = parse(
          await runCmd([bun, "run", join(here, probe)], logPath),
          logPath,
        );
      } else {
        const bin = join(outDir, name);
        const build = Bun.spawnSync(
          [bun, "build", "--compile", join(here, probe), "--outfile", bin],
          { cwd: pkg },
        );
        if (build.exitCode !== 0) {
          writeFileSync(logPath, build.stderr.toString());
          cell = {
            status: "build-failed",
            summary: build.stderr.toString().split("\n").slice(-3).join(" "),
            ms: 0,
            log: logPath,
          };
        } else {
          cell = parse(await runCmd([bin], logPath), logPath);
        }
      }
      process.stderr.write(`${cell.status} (${cell.ms} ms)\n`);
      (results[name] ??= {})[col] = cell;
    }
  }
}

writeFileSync(
  join(pkg, "dist", "m0", "results.json"),
  JSON.stringify({ versions, columns, results }, null, 2),
);

const header = ["probe", ...columns];
const rows = probes.map((p) => {
  const name = p.replace(/\.ts$/, "");
  return [name, ...columns.map((c) => results[name]?.[c]?.status ?? "-")];
});
const widths = header.map((h, i) =>
  Math.max(h.length, ...rows.map((r) => r[i]!.length)),
);
const fmt = (r: string[]) =>
  "| " + r.map((c, i) => c.padEnd(widths[i]!)).join(" | ") + " |";
console.log("\n" + fmt(header));
console.log("|" + widths.map((w) => "-".repeat(w + 2)).join("|") + "|");
for (const r of rows) console.log(fmt(r));
console.log("\nsummaries:");
for (const p of probes) {
  const name = p.replace(/\.ts$/, "");
  for (const c of columns)
    console.log(`  ${name} [${c}]: ${results[name]?.[c]?.summary}`);
}
console.log(`\nlogs and binaries under ${join(pkg, "dist", "m0")}`);
