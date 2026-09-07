/**
 * What is running, as a table for a person and as records for anything else.
 *
 * This command is the one that changed direction: it used to print a single line
 * of JSON unconditionally. A person now gets columns, and `--json` gives back the
 * records that scripts and agents were relying on.
 */
import {
  Command,
  InvalidArgumentError,
  Option,
} from "@commander-js/extra-typings";
import type { SessionInfo, SessionState } from "@werk/session";
import { withContext } from "./shared.js";
import { defineCommand } from "./define.js";
import { tableResult } from "../runtime/output.js";
import { connectDaemon } from "../runtime/daemon.js";
import { completes } from "../completion/hooks.js";
import { labelCandidates } from "../completion/candidates.js";

const STATES: SessionState[] = [
  "starting",
  "running",
  "exited",
  "failed",
  "lost",
];

/** `KEY=VALUE`, repeatable, collected into the record the daemon filters on. */
export function collectLabel(value: string, previous: Record<string, string>) {
  const at = value.indexOf("=");
  // Commander's own error class, so the flag and the value it could not read
  // are named alongside this sentence and the usage follows; anything else
  // thrown from an option parser escapes the parse unexplained.
  if (at < 1) throw new InvalidArgumentError("--label takes KEY=VALUE");
  return { ...previous, [value.slice(0, at)]: value.slice(at + 1) };
}
/** Coarse enough to read at a glance; the exact times are in `--json`. */
export function age(from: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - from) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}
export function stateText(
  info: SessionInfo,
  colour: (s: string, state: SessionState) => string,
) {
  return colour(info.state, info.state);
}
export function buildList(): Command {
  return defineCommand({
    name: "list",
    aliases: ["ls"],
    summary: "List sessions",
    description:
      "Show the sessions this daemon holds, running or finished, as a table " +
      "for a person and as records for anything else.",
    examples: [
      { run: "werk list" },
      { run: "werk list --state running" },
      { run: "werk list --label project=werk" },
      { run: "werk list --json | jq '.[].id'" },
    ],
    notes:
      "A finished session stays listed until it is removed, so its outcome is\nstill readable.",
  })
    .addOption(
      completes(
        new Option("--label <KEY=VALUE>", "only sessions carrying this label")
          .argParser(collectLabel)
          .default({}),
        labelCandidates,
      ),
    )
    .addOption(
      new Option("--state <STATE>", "only sessions in this state").choices(
        STATES,
      ),
    )
    .action(
      withContext(
        async (
          ctx,
          opts: { label: Record<string, string>; state?: string },
        ) => {
          const client = await connectDaemon(ctx);
          try {
            const sessions = await client.list({
              labels: opts.label,
              states: opts.state ? [opts.state as SessionState] : undefined,
            });
            const paint = (text: string, state: SessionState) =>
              state === "running"
                ? ctx.colour.green(text)
                : state === "failed" || state === "lost"
                  ? ctx.colour.red(text)
                  : ctx.colour.dim(text);
            return tableResult(
              sessions,
              ["ID", "NAME", "STATE", "AGE", "COMMAND"],
              sessions.map((s) => [
                s.id.slice(0, 12),
                s.name,
                stateText(s, paint),
                age(s.createdAt),
                s.argv.join(" "),
              ]),
              4,
            );
          } finally {
            await client.close();
          }
        },
      ),
    );
}
