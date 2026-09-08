// Start a CI run at GitHub from a machine, without pushing anything.
//
// GitHub can only run a ref it already has, so this refuses a branch that is
// absent from `origin` or whose tip there is not the commit in hand, and says
// what to push. It never pushes.

import { spawnSync } from "node:child_process";

const WORKFLOW = "session-libraries.yml";

export const LANES = [
  "all",
  "linux",
  "macos",
  "windows",
  "musl",
  "browser",
  "soak",
] as const;

export type Lane = (typeof LANES)[number];

export type Options = {
  lanes: Lane;
  ref?: string;
  soakSeconds?: string;
  dryRun: boolean;
  watch: boolean;
  help: boolean;
};

export class UsageError extends Error {}

export const usage = `Start a CI run at GitHub for a branch it already has.

  bun scripts/ci-run.ts [lane] [options]

Lanes:
  all       every lane except soak (the default)
  linux     the native matrix, ubuntu-latest only
  macos     the native matrix, macos-15-intel only
  windows   the native matrix, windows-latest only
  musl      the Alpine container lane
  browser   the Playwright lane
  soak      the self-hosted long run, and nothing else

Options:
  --ref <branch>        branch to run against (default: the current branch)
  --soak-seconds <n>    duration for the soak lane
  --dry-run             print the commands and exit, touching neither git nor gh
  --no-watch            dispatch and print the run URL without waiting for it
  -h, --help            this text

Exit status: 0 the run passed, 1 it failed, 2 a usage mistake or a ref that
is not on origin. Re-run only the failed jobs of a finished run with
\`gh run rerun --failed <run-id>\`.`;

export function parseArgs(argv: string[]): Options {
  const options: Options = {
    lanes: "all",
    dryRun: false,
    watch: true,
    help: false,
  };
  let lanesSeen = false;
  for (let i = 0; i < argv.length; i += 1) {
    const argument = argv[i]!;
    if (argument === "-h" || argument === "--help") options.help = true;
    else if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--no-watch") options.watch = false;
    else if (argument === "--ref" || argument === "--soak-seconds") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-"))
        throw new UsageError(`${argument} needs a value`);
      if (argument === "--ref") options.ref = value;
      else options.soakSeconds = value;
      i += 1;
    } else if (argument.startsWith("-")) {
      throw new UsageError(`Unknown option ${argument}`);
    } else if (lanesSeen) {
      throw new UsageError(`Unexpected argument ${argument}`);
    } else {
      if (!(LANES as readonly string[]).includes(argument))
        throw new UsageError(
          `Unknown lane ${argument}. Valid lanes: ${LANES.join(", ")}`,
        );
      options.lanes = argument as Lane;
      lanesSeen = true;
    }
  }
  return options;
}

export function dispatchCommand(options: Options, ref: string): string[] {
  const command = [
    "gh",
    "workflow",
    "run",
    WORKFLOW,
    "--ref",
    ref,
    "-f",
    `lanes=${options.lanes}`,
  ];
  if (options.soakSeconds !== undefined)
    command.push("-f", `soak_seconds=${options.soakSeconds}`);
  return command;
}

export type PushedState = "absent" | "stale" | "in-sync";

/** What GitHub would run, compared with the commit in hand. */
export function pushedState(local: string, remote: string | null): PushedState {
  if (remote === null || remote === "") return "absent";
  return remote === local ? "in-sync" : "stale";
}

export function notPushedMessage(state: PushedState, ref: string): string {
  const push = `git push origin ${ref}`;
  return state === "absent"
    ? `origin has no branch ${ref}. GitHub can only run a ref it holds, so push it first:\n  ${push}`
    : `origin's ${ref} is not the commit in hand, so a run there would test something else. Push first:\n  ${push}`;
}

function run(command: string[], capture: boolean): string {
  const result = spawnSync(command[0]!, command.slice(1), {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    timeout: capture ? 60_000 : undefined,
  });
  if (result.error)
    throw new Error(`${command[0]} failed: ${result.error.message}`);
  if (capture && result.status !== 0)
    throw new Error(
      `${command.join(" ")} exited ${result.status}: ${(result.stderr ?? "").trim()}`,
    );
  return capture ? (result.stdout ?? "").trim() : "";
}

export function remoteSha(output: string): string | null {
  const line = output.split("\n").find((candidate) => candidate.trim() !== "");
  return line === undefined ? null : (line.split(/\s+/)[0] ?? null);
}

async function main(): Promise<number> {
  let options: Options;
  try {
    options = parseArgs(Bun.argv.slice(2));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(error.message);
    console.error(`\n${usage}`);
    return 2;
  }
  if (options.help) {
    console.log(usage);
    return 0;
  }

  const ref = options.ref ?? run(["git", "branch", "--show-current"], true);
  if (ref === "") {
    console.error("No branch checked out and no --ref given.");
    return 2;
  }
  const dispatch = dispatchCommand(options, ref);

  if (options.dryRun) {
    console.log(dispatch.join(" "));
    if (options.watch) console.log(`gh run watch <run-id> --exit-status`);
    return 0;
  }

  const local = run(["git", "rev-parse", "HEAD"], true);
  const state = pushedState(
    local,
    remoteSha(run(["git", "ls-remote", "--heads", "origin", ref], true)),
  );
  if (state !== "in-sync") {
    console.error(notPushedMessage(state, ref));
    return 2;
  }

  const before = new Date().toISOString();
  run(dispatch, false);

  let id: number | undefined;
  let url = "";
  for (let attempt = 0; attempt < 20 && id === undefined; attempt += 1) {
    await Bun.sleep(2000);
    const listed = JSON.parse(
      run(
        [
          "gh",
          "run",
          "list",
          "--workflow",
          WORKFLOW,
          "--branch",
          ref,
          "--event",
          "workflow_dispatch",
          "--limit",
          "5",
          "--json",
          "databaseId,createdAt,url",
        ],
        true,
      ) || "[]",
    ) as { databaseId: number; createdAt: string; url: string }[];
    const fresh = listed.find((candidate) => candidate.createdAt >= before);
    if (fresh !== undefined) {
      id = fresh.databaseId;
      url = fresh.url;
    }
  }
  if (id === undefined) {
    console.error(
      "Dispatched, but no run appeared. Look for it with `gh run list`.",
    );
    return 1;
  }
  console.log(url);
  if (!options.watch) return 0;

  const watched = spawnSync(
    "gh",
    ["run", "watch", String(id), "--exit-status"],
    {
      stdio: "inherit",
    },
  );
  return watched.status === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(await main());
