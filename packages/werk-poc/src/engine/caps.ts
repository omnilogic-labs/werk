// The capability matrix as output of the program: one column per engine,
// one row per seam method, read off each engine's `caps`. `wp caps` prints
// it; findings quote it.

import type { CapabilityName, VtEngine } from "./types.ts";

export const CAPABILITY_NAMES: readonly CapabilityName[] = [
  "write",
  "resize",
  "plainText",
  "styledCells",
  "emitVt",
  "encodeState",
  "decodeState",
  "renderConsumer",
  "effects",
  "encodeKey",
  "encodeMouse",
];

/** A markdown table: capabilities down, engines across, "yes" or "no" in each cell. */
export function capabilityMatrix(engines: VtEngine[]): string {
  const head = ["Capability", ...engines.map((e) => `\`${e.id}\``)];
  const rows = CAPABILITY_NAMES.map((name) => [
    `\`${name}\``,
    ...engines.map((e) => (e.caps[name] ? "yes" : "no")),
  ]);
  const widths = head.map((_, i) =>
    Math.max(...[head, ...rows].map((r) => r[i]!.length)),
  );
  const line = (r: string[]) =>
    `| ${r.map((c, i) => c.padEnd(widths[i]!)).join(" | ")} |`;
  return [
    line(head),
    `| ${widths.map((w) => "-".repeat(w)).join(" | ")} |`,
    ...rows.map(line),
  ].join("\n");
}
