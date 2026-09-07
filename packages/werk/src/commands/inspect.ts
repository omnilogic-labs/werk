/**
 * Where werk keeps things, and whether the daemon is well.
 *
 * Both commands are read-only and neither starts a daemon: they answer from the
 * files on disk plus whatever a daemon that is already listening says about
 * itself. `doctor` is `info` with the checks that cost something — a lock probe,
 * a free-space call, a terminfo lookup — and the tail of the log.
 *
 * The JSON is `inspectSessionDaemon`'s own record, unchanged, because CI and
 * bug reports read fields out of it.
 */
import { Command } from "@commander-js/extra-typings";
import { inspectSessionDaemon } from "@werk/session-daemon";
import type { DaemonInfo } from "@werk/session";
import { withContext } from "./shared.js";
import { result } from "../runtime/output.js";
import type { WerkContext } from "../runtime/context.js";

export interface Inspection {
  version: string;
  paths: Record<string, string>;
  lockMechanism: string;
  recorded: { pid?: number; bootId?: string };
  daemon: unknown;
  connection?: unknown;
  checks?: Record<string, unknown>;
  log?: { tail: string[]; lastError: string | null };
}
/** `label  value`, with the labels of one section lined up under each other. */
function section(
  ctx: WerkContext,
  title: string,
  rows: readonly (readonly [string, string])[],
): string {
  if (!rows.length) return "";
  const width = Math.max(...rows.map(([label]) => label.length));
  const body = rows.map(
    ([label, value]) => `  ${ctx.colour.dim(label.padEnd(width))}  ${value}`,
  );
  return [ctx.colour.bold(title), ...body].join("\n");
}
/** Strings stay as they are; anything else is shown as the JSON it is. */
function value(raw: unknown): string {
  return typeof raw === "string" ? raw : (JSON.stringify(raw) ?? "null");
}
function daemonRows(daemon: DaemonInfo): (readonly [string, string])[] {
  return [
    ["id", daemon.id],
    ["version", daemon.version],
    ["protocol", String(daemon.protocolVersion)],
    [
      "engine",
      `${daemon.engine.buildId} (snapshot format ${daemon.engine.snapshotFormatVersion})`,
    ],
    ["termination", daemon.capabilities.termination.join(", ")],
    ["scrollback", `${daemon.capabilities.scrollbackMaxBytes} bytes at most`],
  ];
}
export function renderInspection(report: Inspection, ctx: WerkContext): string {
  const blocks: string[] = [];
  blocks.push(
    section(ctx, `werk ${report.version}`, [
      ["lock", report.lockMechanism],
      [
        "recorded",
        report.recorded.pid === undefined
          ? "no daemon recorded"
          : `pid ${report.recorded.pid}${report.recorded.bootId ? ` · boot ${report.recorded.bootId}` : ""}`,
      ],
    ]),
  );
  blocks.push(
    section(
      ctx,
      "paths",
      Object.entries(report.paths).map(([key, path]) => [key, path] as const),
    ),
  );
  // A daemon that did not answer is the interesting case, so say why rather
  // than leaving the section out.
  const why = report.connection ?? report.checks?.connection;
  blocks.push(
    report.daemon
      ? section(ctx, "daemon", daemonRows(report.daemon as DaemonInfo))
      : section(ctx, "daemon", [
          [
            "connection",
            ctx.colour.red(
              why === undefined ? "no daemon answered" : value(why),
            ),
          ],
        ]),
  );
  if (report.checks)
    blocks.push(
      section(
        ctx,
        "checks",
        Object.entries(report.checks).map(
          ([key, raw]) => [key, value(raw)] as const,
        ),
      ),
    );
  if (report.log) {
    if (report.log.lastError)
      blocks.push(
        `${ctx.colour.bold("last error")}\n  ${ctx.colour.red(report.log.lastError)}`,
      );
    blocks.push(
      [
        ctx.colour.bold("log"),
        ...(report.log.tail.length
          ? report.log.tail.map((line) => `  ${line}`)
          : [ctx.colour.dim("  the log is empty")]),
      ].join("\n"),
    );
  }
  return blocks.filter(Boolean).join("\n\n");
}
async function inspect(ctx: WerkContext, doctor: boolean) {
  const report = await inspectSessionDaemon({
    runtimeDir: ctx.runtimeDir,
    stateDir: ctx.stateDir,
    doctor,
  });
  return result(report, (c) => renderInspection(report as Inspection, c));
}
export function buildInfo(): Command {
  return new Command("info")
    .description("Print the resolved paths and what the daemon reports")
    .addHelpText(
      "after",
      `
Examples:
  $ werk info
  $ werk info --json | jq -r .lockMechanism

Read-only: it reports a daemon that is listening and never starts one.`,
    )
    .action(withContext((ctx) => inspect(ctx, false)));
}
export function buildDoctor(): Command {
  return new Command("doctor")
    .description("Check the local daemon's health and show the log tail")
    .addHelpText(
      "after",
      `
Examples:
  $ werk doctor
  $ werk doctor --json > report.json

Read-only: it takes no lock it does not immediately release.`,
    )
    .action(withContext((ctx) => inspect(ctx, true)));
}
