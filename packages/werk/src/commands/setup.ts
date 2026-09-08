/**
 * Setting a machine up, without making anything on it.
 *
 * `werk create` runs a host's setup on its way to a session, which is where it
 * usually happens and where nobody has to think about it. This is the same job
 * asked for on its own: after editing a `[setup.<name>]` block, before handing
 * a machine to somebody else, or to find out what werk thinks the machine
 * already has.
 *
 * It reaches the machine and nothing else. No daemon is started, no binary is
 * sent and no workspace is made, so a machine with a setup that only installs
 * tools never has to pay for the 92 MB transfer to get them.
 */
import type { Command } from "@commander-js/extra-typings";
import { defineCommand } from "./define.js";
import { withContext } from "./shared.js";
import { result } from "../runtime/output.js";
import { createProgress } from "../runtime/progress.js";
import { hostFor } from "../config/hosts.js";
import {
  describeSetup,
  runHostSetup,
  type SetupOutcome,
} from "../host/setup.js";

/** The machine that was set up, and what that came to. */
export interface SetupRecord {
  /** The `[hosts.<name>]` block acted on. */
  readonly host: string;
  readonly setup: SetupOutcome;
}

export function buildSetup(): Command {
  return defineCommand({
    name: "setup",
    summary: "Run a machine's setup block without making a workspace",
    description:
      "Runs the [setup.<name>] block the host points at: sends whatever it " +
      "copies, then runs its commands there under a login shell. The machine " +
      "keeps a stamp of what was last run on it, so a second run does " +
      "nothing and says so. --host names the machine, and defaultHost " +
      "answers when the flag is absent. --force runs the block whatever the " +
      "stamp says. Nothing else is put on the machine: no daemon is started " +
      "and no workspace is made.",
    examples: [
      {
        run: "werk setup --host beast",
        note: "set beast up, if it is not already",
      },
      {
        run: "werk setup --host beast --force",
        note: "run it again, whatever the machine says it has",
      },
      { run: "werk setup", note: "the host defaultHost names" },
    ],
    notes:
      "What a setup block may say is in `werk config list`, under `setup.<name>`.",
  })
    .option("--force", "run the block whatever the machine's stamp says")
    .action(
      withContext(async (ctx, opts: { force?: boolean }) => {
        const { name, host } = hostFor(ctx);
        const progress = createProgress(ctx, name);
        try {
          const setup = await runHostSetup({
            ctx,
            name,
            host,
            ...(opts.force === true ? { force: true } : {}),
            progress,
          });
          progress.stop();
          return result<SetupRecord>({ host: name, setup }, (c) =>
            c.style.muted(describeSetup(setup, name)),
          );
        } finally {
          progress.stop();
        }
      }),
    );
}
