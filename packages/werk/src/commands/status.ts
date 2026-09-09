/**
 * What the things that are running are doing.
 *
 * `list` says what exists and whether its process is alive. That is as much as
 * werk can say without knowing anything about the program: a coding agent that
 * has been sitting on a question for twenty minutes and one that is halfway
 * through a build are both `running`. This command asks a mapper instead, and a
 * mapper knows where the program keeps its own account of itself.
 *
 * With no session it answers for everything the daemon holds, because that list
 * is the whole point: the core loop's third step is one look that says which of
 * them wants you. `--attention` cuts it down to those that do.
 *
 * ## Only this machine, for now
 *
 * The only `ReadAccess` that exists reads the filesystem of the machine werk is
 * running on, so `--host` is refused rather than answered wrongly. Two things
 * would fix it and nobody has picked one: a reader that does its reads over the
 * connection werk already has to that machine, or a mapper that runs in the
 * daemon over there and answers on the wire. See
 * [mappers](../../../../docs/product/mappers.md).
 */
import { Command, Option } from "@commander-js/extra-typings";
import type { SessionInfo } from "@werk/session";
import {
  localReadAccess,
  mapperFor,
  statusOf,
  type MapperSubject,
  type ProcessStatus,
  type ReadAccess,
} from "@werk/mapper";
import { workspaceAt } from "@werk/workspace";
import { withContext } from "./shared.js";
import { defineCommand } from "./define.js";
import { age } from "./list.js";
import {
  aliasesOf,
  resolveSession,
  sessionArgument,
} from "./session-argument.js";
import { result, section, tableResult } from "../runtime/output.js";
import { connectDaemon } from "../runtime/daemon.js";
import { reachHost, type HostPlace } from "../host/place.js";
import { hostFor } from "../config/hosts.js";
import { UsageError } from "../runtime/exit.js";
import type { WerkContext } from "../runtime/context.js";

/** One session, and whatever a mapper could say about it. */
export interface SessionStatus {
  readonly id: string;
  readonly name: string;
  readonly workspace?: string;
  /** What the daemon says. A mapper can only refine this, never contradict it. */
  readonly state: string;
  readonly command: string;
  /** Which mapper claimed the process, whether or not it could read anything. */
  readonly mapper?: string;
  /** The reading. Absent when no mapper claimed it, or none could read it. */
  readonly status?: ProcessStatus;
}

/** werk's side of the conversation, from the record the daemon keeps. */
export function subjectOf(info: SessionInfo): MapperSubject {
  return {
    id: info.id,
    argv: info.argv,
    cwd: info.cwd,
    ...(info.reportedCwd === undefined
      ? {}
      : { reportedCwd: info.reportedCwd }),
    ...(info.processTree.foreground === undefined
      ? {}
      : { foreground: info.processTree.foreground }),
    running: info.state === "starting" || info.state === "running",
    startedAt: info.createdAt,
    ...(info.lastOutputAt === undefined
      ? {}
      : { lastOutputAt: info.lastOutputAt }),
  };
}

/** The base name of a path under either separator; what to call the program. */
const program = (command: string): string =>
  command.split(/[\\/]/).pop() ?? command;

/** What goes in the `DOING` column when no mapper answered. */
function unmapped(info: SessionInfo, claimed: boolean): string {
  if (!claimed) return `no mapper for ${program(info.argv[0] ?? "it")}`;
  return "nothing to read";
}

function paint(ctx: WerkContext, status: SessionStatus): string {
  const activity = status.status?.activity;
  if (activity === undefined) return ctx.style.muted(status.state);
  if (activity === "waiting") return ctx.style.warning(activity);
  if (activity === "working") return ctx.style.success(activity);
  return ctx.style.muted(activity);
}

/** The one-line answer for a table row. */
const doing = (info: SessionInfo, status: SessionStatus): string =>
  status.status?.summary ?? unmapped(info, status.mapper !== undefined);

function renderOne(ctx: WerkContext, one: SessionStatus): string {
  const blocks: string[] = [];
  blocks.push(
    section(ctx, one.name || one.id.slice(0, 12), [
      ["id", one.id],
      ["state", one.state],
      ...(one.workspace ? [["workspace", one.workspace] as const] : []),
      ["command", one.command],
    ]),
  );
  const status = one.status;
  if (status === undefined) {
    blocks.push(
      section(ctx, "status", [
        [
          "mapper",
          one.mapper === undefined
            ? ctx.style.muted("none knows this program")
            : ctx.style.muted(`${one.mapper} found nothing to read`),
        ],
      ]),
    );
    return blocks.filter(Boolean).join("\n\n");
  }
  blocks.push(
    section(ctx, "status", [
      ["mapper", status.mapper],
      ["activity", paint(ctx, one)],
      ["doing", status.summary],
      ...(status.working ? [["working on", status.working] as const] : []),
      [
        "wants you",
        status.needsAttention
          ? ctx.style.warning("yes")
          : ctx.style.muted("no"),
      ],
      ...(status.observedAt === undefined
        ? []
        : ([["observed", `${age(status.observedAt)} ago`]] as const)),
    ]),
  );
  const facts = Object.entries(status.facts ?? {});
  if (facts.length)
    blocks.push(
      section(
        ctx,
        "what it read",
        facts.map(([key, value]) => [key, String(value)] as const),
      ),
    );
  return blocks.filter(Boolean).join("\n\n");
}

export function buildStatus(): Command {
  const status: Command = defineCommand({
    name: "status",
    summary: "Say what each session's process is actually doing",
    description:
      "Ask a mapper what the process in each session is doing: working, " +
      "waiting on you, or finished with nothing to go on with. A mapper reads " +
      "the program's own account of itself rather than the bytes on screen, " +
      "so it can tell a claude thinking from a claude waiting for an answer. " +
      "Sessions running a program no mapper knows are listed with what the " +
      "daemon knows and nothing more.",
    examples: [
      { run: "werk status" },
      { run: "werk status --attention", note: "only the ones that want you" },
      { run: "werk status fix-login" },
      { run: "werk status --json | jq '.[] | select(.status.needsAttention)'" },
    ],
    notes:
      "Mappers read the machine werk is running on, so --host is refused " +
      "rather than answered about the wrong filesystem.",
  });
  status
    .addArgument(sessionArgument())
    .addOption(
      new Option("--attention", "only sessions waiting on a person").default(
        false,
      ),
    )
    .action(
      withContext(async (ctx, opts: { attention: boolean }, given?: string) => {
        // Refused before the machine is reached rather than after: reaching an
        // ssh host installs werk over there and starts a daemon, and none of
        // that is work this command was ever going to use.
        const named = hostFor(ctx);
        if (named.host.kind === "ssh")
          throw new UsageError(
            `a mapper reads the machine werk is running on, so status cannot ` +
              `answer for ${named.name} yet`,
          );
        const place = await reachHost(ctx);
        const daemon = await connectDaemon(ctx, place.session);
        const { client } = daemon;
        try {
          const all = await client.list({});
          // Resolved once, and before the filter, so that naming a session
          // nothing answers to fails with that rather than with an empty table.
          const asked =
            given === undefined
              ? undefined
              : resolveSession(
                  aliasesOf(all, place.root, place.reference),
                  given,
                );
          const wanted =
            asked === undefined ? all : all.filter((s) => s.id === asked);
          const access = localReadAccess();
          // The mappers are asked at once. They only read, they hold nothing,
          // and one that throws is already reported as no reading, so nothing
          // here depends on the order they finish in.
          const read = await Promise.all(
            wanted.map(async (info) => ({
              info,
              one: await readOne(info, access, place),
            })),
          );
          const shown = opts.attention
            ? read.filter((each) => each.one.status?.needsAttention === true)
            : read;

          const only = shown[0];
          if (given !== undefined && only !== undefined)
            return result(only.one, (c) => renderOne(c, only.one));

          return tableResult(
            shown.map((each) => each.one),
            ["ID", "NAME", "WORKSPACE", "ACTIVITY", "DOING", "SINCE"],
            shown.map(({ info, one }) => [
              one.id.slice(0, 12),
              one.name,
              one.workspace ?? "",
              paint(ctx, one),
              doing(info, one),
              age(one.status?.observedAt ?? info.createdAt),
            ]),
            4,
          );
        } finally {
          await daemon.close();
          await place.close().catch(() => {});
        }
      }),
    );
  return status;
}

/** One session, asked about. */
async function readOne(
  info: SessionInfo,
  access: ReadAccess,
  place: HostPlace,
): Promise<SessionStatus> {
  const subject = subjectOf(info);
  const status = await statusOf(subject, access);
  const mapper = mapperFor(subject);
  const workspace = workspaceAt(place.root, info.cwd, place.reference)?.name;
  return {
    id: info.id,
    name: info.name,
    ...(workspace === undefined ? {} : { workspace }),
    state: info.state,
    command: info.argv.join(" "),
    ...(mapper === null ? {} : { mapper: mapper.id }),
    ...(status === null ? {} : { status }),
  };
}
