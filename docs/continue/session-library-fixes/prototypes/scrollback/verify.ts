// Post-reboot verification: one live WASM instance at a time, <=10 MB, <=30k lines.
import { loadTerminalEngine } from "/home/mike/Development/omnilogic-labs/werk/packages/terminal/src/bun/index.ts";
const f = await loadTerminalEngine();
const enc = new TextEncoder();
const abi = (t: any) => ({ a: t.a as any, h: t.h as number });
function get(t: any, key: string): number | "NO_VALUE" {
  const { a, h } = abi(t);
  return a.temporary(8, (p: number) => {
    const code = a.call(
      "ghostty_terminal_get",
      h,
      a.enum("GhosttyTerminalData", key),
      p,
    );
    if (code === a.enum("GhosttyResult", "NO_VALUE")) return "NO_VALUE";
    if (code !== 0) throw new Error(`get ${key}: ${code}`);
    return a.read(p, key === "CURSOR_AT_PROMPT" ? "bool" : "u32");
  });
}
function set(t: any, key: string, value: number | null) {
  const { a, h } = abi(t);
  if (value === null) {
    a.check("ghostty_terminal_set", h, a.enum("GhosttyTerminalOption", key), 0);
    return;
  }
  a.temporary(4, (p: number) => {
    a.write(p, "u32", value);
    a.check("ghostty_terminal_set", h, a.enum("GhosttyTerminalOption", key), p);
  });
}
const memMB = (t: any) =>
  (abi(t).a.exports.memory.buffer.byteLength / 1048576).toFixed(1);
function writeAll(t: any, data: Uint8Array) {
  const t0 = performance.now();
  for (let o = 0; o < data.length; o += 65536)
    t.write(data.subarray(o, o + 65536));
  return performance.now() - t0;
}
function randomLines(n: number) {
  const parts: string[] = [];
  for (let i = 1; i <= n; i++) {
    let s = "";
    for (let j = 0; j < 8; j++)
      s += Math.floor(Math.random() * 4294967296)
        .toString(16)
        .padStart(8, "0");
    parts.push(`${i} ${s}\r\n`);
  }
  return enc.encode(parts.join(""));
}
const data = randomLines(30000);
console.log(
  `30k random lines: ${data.length} bytes (${(data.length / 30000).toFixed(1)} B/line)`,
);
console.log(
  "setting | pages | write ms | MB/s | totalRows | snapshot KB | encode ms | restore ms | restored rows | restored limit | wasm live MB | wasm restored MB",
);
for (const [label, bytes] of [
  ["default (10,000)", undefined],
  ["1 MB", 1_000_000],
  ["1.5 MiB", 1_572_864],
  ["2 MB", 2_000_000],
  ["5 MB", 5_000_000],
  ["10 MB", 10_000_000],
] as [string, number | undefined][]) {
  const t: any = await f.create({ cols: 120, rows: 40 });
  if (bytes !== undefined) set(t, "SCROLLBACK_MAX_BYTES", bytes);
  const w = writeAll(t, data);
  const rows = t.viewport().totalRows;
  const t1 = performance.now();
  const s = t.snapshot();
  const e = performance.now() - t1;
  const live = memMB(t);
  t.dispose();
  const t2 = performance.now();
  const r: any = await f.restore(s);
  const rm = performance.now() - t2;
  console.log(
    [
      label,
      Math.max(2, Math.floor((bytes ?? 10000) / 458752)),
      w.toFixed(0),
      (data.length / 1048576 / (w / 1000)).toFixed(0),
      rows,
      (s.bytes.length / 1024).toFixed(0),
      e.toFixed(1),
      rm.toFixed(1),
      r.viewport().totalRows,
      get(r, "SCROLLBACK_MAX_BYTES"),
      live,
      memMB(r),
    ].join(" | "),
  );
  r.dispose();
}
{
  // set after output, then lower
  const t: any = await f.create({ cols: 120, rows: 40 });
  writeAll(t, data);
  const before = t.viewport().totalRows;
  set(t, "SCROLLBACK_MAX_BYTES", 10_000_000);
  const afterRaise = t.viewport().totalRows;
  writeAll(t, data);
  const afterMore = t.viewport().totalRows;
  set(t, "SCROLLBACK_MAX_BYTES", 1_000_000);
  const afterLower = t.viewport().totalRows;
  console.log(
    `set after output: default ${before} -> raise to 10 MB ${afterRaise} -> +30k lines ${afterMore} -> lower to 1 MB ${afterLower}; wasm stays ${memMB(t)} MB`,
  );
  t.dispose();
}
{
  // restore then lower on receiver; restore then write without setting
  const t: any = await f.create({ cols: 120, rows: 40 });
  set(t, "SCROLLBACK_MAX_BYTES", 10_000_000);
  writeAll(t, data);
  const s = t.snapshot();
  t.dispose();
  const r: any = await f.restore(s);
  const rows0 = r.viewport().totalRows;
  set(r, "SCROLLBACK_MAX_BYTES", 2_000_000);
  const rows1 = r.viewport().totalRows;
  writeAll(r, data.subarray(0, 8000));
  const rows2 = r.viewport().totalRows;
  r.dispose();
  const r2: any = await f.restore(s);
  writeAll(r2, data.subarray(0, 150000));
  const rows3 = r2.viewport().totalRows;
  const lim = get(r2, "SCROLLBACK_MAX_BYTES");
  r2.dispose();
  console.log(
    `restore 10 MB snapshot (${rows0} rows) then set 2 MB on receiver -> ${rows1}; +100 lines -> ${rows2}. Restore then write 2k lines without setting -> ${rows3} rows, limit ${lim}`,
  );
}
{
  // styled worst case at 10 MB
  const t: any = await f.create({ cols: 120, rows: 40 });
  set(t, "SCROLLBACK_MAX_BYTES", 10_000_000);
  const parts: string[] = [];
  for (let i = 0; i < 12000; i++) {
    let s = "";
    for (let j = 0; j < 30; j++)
      s += `\x1b[${31 + (j % 7)};${j % 2 ? 1 : 4}m${(i + j).toString(36).padStart(4, "z")}`;
    parts.push(s + "\x1b[0m\r\n");
  }
  const styled = enc.encode(parts.join(""));
  const w = writeAll(t, styled);
  const rows = t.viewport().totalRows;
  const t1 = performance.now();
  const s = t.snapshot();
  const e = performance.now() - t1;
  const live = memMB(t);
  t.dispose();
  const t2 = performance.now();
  const r = await f.restore(s);
  const rm = performance.now() - t2;
  r.dispose();
  console.log(
    `styled full 120-col rows at 10 MB: ${rows} rows, write ${w.toFixed(0)} ms for ${(styled.length / 1048576).toFixed(1)} MB, snapshot ${(s.bytes.length / 1024).toFixed(0)} KB (${(s.bytes.length / rows).toFixed(0)} B/row), encode ${e.toFixed(1)} ms, restore ${rm.toFixed(1)} ms, wasm live ${live} MB`,
  );
  const t3 = performance.now();
  const json = JSON.stringify({
    info: { id: "x" },
    snapshot: { ...s, bytes: Buffer.from(s.bytes).toString("base64") },
  });
  const j = performance.now() - t3;
  const t4 = performance.now();
  const back = Buffer.from(JSON.parse(json).snapshot.bytes, "base64");
  const p = performance.now() - t4;
  console.log(
    `checkpoint JSON for it: ${(Buffer.byteLength(json) / 1048576).toFixed(2)} MB, stringify+base64 ${j.toFixed(1)} ms, parse+decode ${p.toFixed(1)} ms (${back.length} B)`,
  );
}
{
  const t0 = performance.now();
  const c = await f.create({ cols: 120, rows: 40 });
  console.log(
    `create() baseline ${(performance.now() - t0).toFixed(1)} ms, wasm ${memMB(c)} MB`,
  );
  c.dispose();
}
{
  // CURSOR_AT_PROMPT
  const t: any = await f.create({ cols: 80, rows: 10 });
  const out: string[] = [];
  const step = (label: string, s: string) => {
    const eff = t.write(enc.encode(s));
    out.push(
      `${label}=${get(t, "CURSOR_AT_PROMPT")}${eff.length ? `(${eff.map((e: any) => e.kind).join(",")})` : ""}`,
    );
  };
  step("fresh", "");
  step("133;A", "\x1b]133;A\x07$ ");
  step("133;B", "\x1b]133;B\x07");
  step("echo", "ls\r\n");
  step("133;C", "\x1b]133;C\x07");
  step("output", "f1\r\nf2\r\n");
  step("133;D", "\x1b]133;D;0\x07");
  step("133;A", "\x1b]133;A\x07$ ");
  step("alt-on", "\x1b[?1049h");
  step("alt-off", "\x1b[?1049l");
  step("OSC9;4", "\x1b]9;4;1;50\x07");
  const s = t.snapshot();
  t.dispose();
  const r: any = await f.restore(s);
  out.push(`restored=${get(r, "CURSOR_AT_PROMPT")}`);
  r.dispose();
  console.log("CURSOR_AT_PROMPT: " + out.join(" "));
}
