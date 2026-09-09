/**
 * The machine a command acts on, resolved once and shared by everything in the
 * invocation that needs it.
 *
 * Every command that reaches a daemon needs the same four answers: which host
 * block was named, whether reaching it means ssh, the live connection to it,
 * and where workspaces go over there. Resolving those separately would probe
 * the machine once per answer, so they are resolved together, here, and the
 * `HostSession` is the one thing an invocation holds and gives back.
 *
 * ## What this deliberately does not do
 *
 * It reaches **one** machine. There is no fleet: `werk list` with no `--host`
 * shows this machine and `werk list --host beast` shows that one, and neither
 * shows both. Nothing records that a workspace exists, so a workspace with no
 * running session is invisible from every machine including its own. Whether
 * werk should keep such a record is
 * [question 19](../../../docs/open-questions.md#19-where-does-the-record-of-a-workspace-live).
 */
import {
  createLocalWorktreeMaker,
  createSshWorkspaceMaker,
  WorkspaceError,
  type RemoteRunner as WorkspaceRunner,
  type WorkspaceErrorCode,
  type WorkspaceMaker,
} from "@werk/workspace";
import {
  hostFor,
  workspaceRootFor,
  type Host,
  type SshHost,
} from "../config/hosts.js";
import type { WerkContext } from "../runtime/context.js";
import { askWorkspaceRoot } from "./ssh-probe.js";
import {
  openHostSession,
  type HostSession,
  type HostSessionOptions,
} from "./session.js";
import { sshGitConfig, sshPushUrl, SSH_CONNECTION_FAILED } from "./ssh.js";
import { HostError, type HostErrorCode } from "./types.js";

/**
 * A machine, reached.
 *
 * `session` is absent for the machine werk is running on, which is also what
 * says "here" to everything downstream: there is nothing to close, nothing to
 * stamp on a workspace reference, and no round trip to make.
 */
export interface HostPlace {
  /** The name of the `[hosts.<name>]` block. */
  readonly name: string;
  readonly host: Host;
  /** The live connection, when the machine is not this one. */
  readonly session?: HostSession;
  /** Where workspaces go on it, absolute on whichever machine it names. */
  readonly root: string;
  /**
   * The host to stamp on a workspace reference, so `full` reads
   * `name@host:/path`. Absent for this machine, which keeps the lean recorded
   * in question 24 — that an absent host reads as "here" — intact.
   */
  readonly reference?: string;
  /** Let go of the connection. Safe to call more than once. */
  close(): Promise<void>;
}

/**
 * A machine, named but not reached.
 *
 * `root` is absent where {@link HostPlace}'s is mandatory: the machine has not
 * been asked, so an ssh host that has not written its `workspaceRoot` down has
 * no answer yet.
 */
export interface ConfiguredPlace {
  readonly name: string;
  readonly host: Host;
  readonly root?: string;
  readonly reference?: string;
}

/**
 * Resolve which machine, open it if it is not this one, and find out where
 * workspaces go on it.
 *
 * The session is opened before the root is asked for on purpose:
 * `openHostSession` starts reaching the machine as soon as it is made, so the
 * probe below overlaps the install and the daemon start rather than following
 * them.
 */
export interface ReachOptions {
  /** A host name that did not come from `--host`; `hostFor`'s second answer. */
  readonly requested?: string;
  /**
   * How a machine is opened. Injected so a test can drive the ssh half of this
   * file against a scripted session and open no connection at all.
   */
  readonly open?: (options: HostSessionOptions) => HostSession;
}

/**
 * Where a command would act, worked out from the configuration alone.
 *
 * {@link reachHost} answers the same question by opening the machine, which is
 * more than tab completion may spend: a TAB must not ssh anywhere and must not
 * start anything. This answers from the blocks in force instead, so it costs
 * nothing and can be wrong only in the one way the configuration is silent
 * about — an ssh host that has not said where its workspaces go has no root
 * here, because werk cannot know a path on a machine it has not looked at.
 *
 * The `reference` is settled either way, because which machine a name refers to
 * is a question the configuration answers on its own. A caller with a reference
 * and no root knows the paths it has are not readable from here, which is the
 * honest answer rather than the local root under another machine's name.
 *
 * Nothing here throws. An unreadable or unknown host is no answer at all, since
 * the callers are completion providers, and a shell blocked on a TAB is owed a
 * short empty reply rather than a diagnosis.
 */
export function placeFromConfig(ctx: WerkContext): ConfiguredPlace | undefined {
  let resolved;
  try {
    resolved = hostFor(ctx);
  } catch {
    return undefined;
  }
  const { name, host } = resolved;
  const root = workspaceRootFor(name, host, ctx.stateDir);
  return {
    name,
    host,
    ...(root === undefined ? {} : { root }),
    ...(host.kind === "ssh" ? { reference: name } : {}),
  };
}

export async function reachHost(
  ctx: WerkContext,
  options: ReachOptions = {},
): Promise<HostPlace> {
  const { name, host } = hostFor(ctx, options.requested);
  if (host.kind !== "ssh") {
    const root = workspaceRootFor(name, host, ctx.stateDir);
    // A local host always has an answer: the block's own `workspaceRoot`, or
    // `<stateDir>/workspaces`, which is where `werk create` has always put
    // them. The assertion is what `workspaceRootFor` promises for `local`.
    return { name, host, root: root!, close: async () => {} };
  }
  const session = (options.open ?? openHostSession)({
    name,
    host,
    runtimeDir: ctx.runtimeDir,
    stateDir: ctx.stateDir,
    entry: ctx.entry,
  });
  try {
    return {
      name,
      host,
      session,
      root: await sshWorkspaceRoot(name, host, session, ctx.stateDir),
      reference: name,
      close: () => session.close(),
    };
  } catch (error) {
    await session.close().catch(() => {});
    throw error;
  }
}

/**
 * Where workspaces go on a machine reached over ssh.
 *
 * The block answers when it carries a `workspaceRoot`. Otherwise the machine
 * is asked, because werk cannot know a path on a computer it has not looked at
 * — the answer depends on that machine's `$HOME` and its `$XDG_STATE_HOME` —
 * and a guess would be wrong on exactly the machines that are set up unusually.
 * One round trip, once per invocation.
 */
async function sshWorkspaceRoot(
  name: string,
  host: SshHost,
  session: HostSession,
  stateDir: string,
): Promise<string> {
  const configured = workspaceRootFor(name, host, stateDir);
  if (configured !== undefined) return configured;
  const asked = await askWorkspaceRoot(session);
  if (asked !== undefined) return asked;
  throw new HostError(
    "HOST_BOOTSTRAP_FAILED",
    host.sshHost,
    `${name} did not say where workspaces go on it: its shell answered ` +
      `nothing for \`\${XDG_STATE_HOME:-$HOME/.local/state}/werk/workspaces\`. ` +
      `Put a workspaceRoot in [hosts.${name}] to settle it.`,
  );
}

/** The maker for the kind of place this is: a worktree here, or one over there. */
export function workspaceMakerFor(place: HostPlace): WorkspaceMaker {
  if (place.host.kind !== "ssh" || place.session === undefined)
    return createLocalWorktreeMaker({ root: place.root });
  const sshHost = place.host.sshHost;
  return createSshWorkspaceMaker({
    host: place.name,
    root: place.root,
    remote: remoteRunnerFor(place.session),
    // Built here, so `@werk/workspace` keeps importing `node:*` and nothing
    // else and never learns what ssh is.
    pushUrl: sshPushUrl(sshHost),
    pushConfig: sshGitConfig(),
  });
}

/**
 * Long enough for `git init --bare` and a `git worktree add` of a large
 * repository over a slow link. The maker sets its own, shorter, budget for the
 * rollback it runs after something has already failed.
 */
const REMOTE_SCRIPT_TIMEOUT_MS = 120_000;

/** How a `HostErrorCode` reads to the package that has its own failure table. */
const AS_WORKSPACE: Record<HostErrorCode, WorkspaceErrorCode> = {
  HOST_UNREACHABLE: "HOST_UNREACHABLE",
  HOST_AUTH_FAILED: "HOST_AUTH_DENIED",
  HOST_UNSUPPORTED: "HOST_UNSUPPORTED",
  HOST_BOOTSTRAP_FAILED: "HOST_BOOTSTRAP_FAILED",
  // The daemon is beside the point when a script is what was being run: what
  // the caller saw is that the machine did not answer.
  HOST_DAEMON_MISSING: "HOST_UNREACHABLE",
  // A setup runs either side of the maker and never through it, so neither of
  // these can reach this table. They are here because the table is total, and
  // "werk could not get the machine ready" is the nearest thing the maker's own
  // vocabulary has if one ever does.
  HOST_SETUP_FAILED: "HOST_BOOTSTRAP_FAILED",
  WORKSPACE_SETUP_FAILED: "HOST_BOOTSTRAP_FAILED",
};

/**
 * The `RemoteRunner` `@werk/workspace` asks for, over the probe seam.
 *
 * The two vocabularies are converted here rather than either side learning the
 * other's. A `HostError` is translated instead of being swallowed, because ssh
 * spends 255 on every one of its failures and this is the only place that still
 * knows whether the key was refused or the machine was asleep — the maker's own
 * classifier cannot tell them apart and would call both unreachable.
 */
export function remoteRunnerFor(session: HostSession): WorkspaceRunner {
  return async (script, options) => {
    try {
      const answer = await session.run(["sh", "-c", script], {
        timeoutMs: options?.timeoutMs ?? REMOTE_SCRIPT_TIMEOUT_MS,
      });
      return {
        // Nothing ran at all is ssh's own status for it, which is what the
        // maker reads as a machine that could not be reached.
        exitCode: answer.code ?? SSH_CONNECTION_FAILED,
        stdout: answer.stdout,
        stderr: answer.stderr,
      };
    } catch (error) {
      if (error instanceof HostError)
        // The message alone: a `HostError` has already folded its detail into
        // it, and passing it again would say the same thing twice.
        throw new WorkspaceError(AS_WORKSPACE[error.code], error.message);
      throw error;
    }
  };
}
