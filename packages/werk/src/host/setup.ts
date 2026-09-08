/**
 * Running a `[setup.<name>]` block: on a machine, and in a workspace.
 *
 * `config/setup.ts` is the vocabulary — what a block may say and how the layers
 * merge it. This is what does it: work out whether the block has already been
 * run where it is about to run, send whatever it copies, run its commands, and
 * write down that it happened.
 *
 * ## The machine holds the truth about the machine
 *
 * The authority is a stamp on the machine itself, at
 * `~/.local/share/werk/setup/<block>/stamp`, holding the fingerprint of the
 * block that wrote it. Nothing else can be authoritative: a second laptop that
 * has never touched this machine has to reach the same answer as the first, and
 * only the machine knows what has been done to it.
 *
 * A hint at `<stateDir>/hosts/<host>.setup.json` says what this client last saw
 * there, so the common case — nothing has changed — costs no round trip at all.
 * It is kept apart from `HostCache` in the same directory on purpose: that file
 * is thrown away whenever the client's build changes, and a werk upgrade must
 * not re-run somebody's setup.
 *
 * **Both files are caches.** Losing either costs a redundant read and never
 * correctness: a missing hint asks the machine, and a missing stamp runs the
 * block again. Neither is a record of what werk knows about a host, and neither
 * is meant to become one —
 * [question 25](../../../docs/open-questions.md#25-what-does-werk-store-about-a-host-once-it-has-been-to-one)
 * is open and this deliberately does not answer it.
 *
 * ## The fingerprint is computed here, in milliseconds
 *
 * sha256 over the commands in order, the resolved `to`, and the bytes of
 * whatever `copy` names, walked in sorted order. That is a local read of a
 * handful of small files, so werk can always say whether the block has changed
 * without asking anybody. The bounds — 2,000 files and 32 MB — are there so
 * that a `copy` pointed at the wrong directory is a refusal rather than a long
 * transfer.
 *
 * ## One machine seam, whichever machine it is
 *
 * A local host runs the same block, and there is no second code path for it.
 * `sshSetupMachine` builds `ssh -T host` argv; `localSetupMachine` builds
 * `sh -c` argv and hands the process its environment directly. Everything after
 * that — the fingerprint, the stamp, the transfer, the script — is the same
 * code either way.
 *
 * The commands themselves run under a **login shell**, for the reason
 * `session.ts` gives: on the machines werk is aimed at `claude` lives in
 * `~/.local/bin` and is on the login PATH and no other, and a setup script that
 * cannot find what it is meant to configure is worse than useless.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { setupFor, type SetupBlock } from "../config/setup.js";
import { ConfigError } from "../config/errors.js";
import { environmentFor } from "../environment.js";
import type { Host } from "../config/hosts.js";
import type { WerkContext } from "../runtime/context.js";
import type { ProgressReporter } from "../runtime/progress.js";
import {
  canPrompt,
  confirm,
  type PromptOptions,
} from "../runtime/interactive.js";
import { hashFile } from "./install.js";
import {
  requireConnection,
  requireSuccess,
  shellQuote,
  spawnRunner,
  sshExecArgv,
  EXEC_TIMEOUT_MS,
  type RemoteRunner,
  type RunOutcome,
} from "./ssh.js";
import { sendTree, TRANSFER_TIMEOUT_MS } from "./transfer.js";
import { HostError, type HostErrorCode } from "./types.js";

/** A mistaken path is a refusal rather than a long transfer. */
export const SETUP_MAX_FILES = 2000;
export const SETUP_MAX_BYTES = 32 * 1024 * 1024;
/** Long enough for a `bun install` on a cold machine over a slow link. */
export const SETUP_TIMEOUT_MS = 600_000;

/* ------------------------------------------------------------ the machine */

/**
 * The machine a setup runs on, as the two things running one needs: a shell
 * command over there, and a script under a login shell with variables set.
 *
 * `sshHost` is what a failure message names. For the machine werk is running
 * on it is the host block's own name, which is what somebody would type after
 * `--host`.
 */
export interface SetupMachine {
  /** The `[hosts.<name>]` this is. */
  readonly name: string;
  /** The ssh destination, or the block's name where the machine is this one. */
  readonly sshHost: string;
  readonly runner: RemoteRunner;
  /** The whole argv for one shell command, on a plain shell over there. */
  exec(command: string): string[];
  /** The argv and options for a script under a login shell with `env` set. */
  login(
    script: string,
    env: Readonly<Record<string, string>>,
  ): { argv: string[]; env?: Readonly<Record<string, string>> };
}

/** `K='v'; export K` for each name, so a login shell over there has them. */
function exports(env: Readonly<Record<string, string>>): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${shellQuote(value)}; export ${key}\n`)
    .join("");
}

/** A machine reached with ssh. The variables are written into the command. */
export function sshSetupMachine(
  name: string,
  sshHost: string,
  runner: RemoteRunner = spawnRunner(),
): SetupMachine {
  return {
    name,
    sshHost,
    runner,
    exec: (command) => sshExecArgv(sshHost, command),
    login: (script, env) => ({
      argv: sshExecArgv(sshHost, `${exports(env)}${script}`, { login: true }),
    }),
  };
}

/**
 * The machine werk is running on.
 *
 * The shell is spelled the way `loginCommand` spells it for the far side —
 * the account's own, falling back to `/bin/sh` — so the two answers cannot
 * drift. Nothing branches on which operating system this is: a machine with no
 * POSIX shell fails at the spawn, naming the shell it could not run, which is a
 * truer message than a platform check would give.
 */
export function localSetupMachine(
  name: string,
  runner: RemoteRunner = spawnRunner(),
  shell: string = process.env.SHELL || "/bin/sh",
): SetupMachine {
  return {
    name,
    sshHost: name,
    runner,
    exec: (command) => [shell, "-c", command],
    // The whole environment, not an overlay: `environmentFor` has already
    // decided what a session on this machine gets, and the process should get
    // exactly that rather than that plus whatever werk was started with.
    login: (script, env) => ({ argv: [shell, "-lc", script], env }),
  };
}

/** The machine a host block names, whichever kind of machine that is. */
export const setupMachineFor = (
  name: string,
  host: Host,
  runner?: RemoteRunner,
): SetupMachine =>
  host.kind === "ssh"
    ? sshSetupMachine(name, host.sshHost, runner)
    : localSetupMachine(name, runner);

/* -------------------------------------------------------- the fingerprint */

/** One thing under a `copy`, as the fingerprint counts it. */
export interface CopiedEntry {
  /** Where it sits under the copied root, `/` between segments. */
  readonly path: string;
  /** A symbolic link's target, verbatim. Absent for an ordinary file. */
  readonly link?: string;
  /** Whether the owner may execute it; tar carries the bit either way. */
  readonly executable: boolean;
  readonly bytes: number;
}

const refuse = (detail: string) => new ConfigError("SETUP_INVALID", detail);

/**
 * Whether a link points out of the tree being copied.
 *
 * Lexical rather than resolved, because that is what the far side will see: tar
 * carries the target verbatim and the machine receiving it resolves the link
 * against its own filesystem, so what matters is what the link says and not
 * what it happens to reach here.
 */
function escapes(root: string, from: string, target: string): boolean {
  const resolved = path.resolve(from, target);
  return resolved !== root && !resolved.startsWith(root + path.sep);
}

/**
 * Everything under a `copy`, in sorted order, refusing by name whatever cannot
 * be sent.
 *
 * A link out of the tree is named rather than dropped: a setup that silently
 * lost half of what somebody meant to send would leave a machine looking
 * configured, which is the failure the whole unknown-key rule exists to
 * prevent.
 */
export async function walkCopy(root: string): Promise<CopiedEntry[]> {
  const base = path.resolve(root);
  let top;
  try {
    top = await fs.stat(base);
  } catch {
    throw refuse(`copy names ${base}, and there is nothing there`);
  }
  if (!top.isDirectory())
    throw refuse(
      `copy names ${base}, which is not a directory. A block sends a ` +
        `directory's contents, so copy names the directory they are in.`,
    );

  const found: CopiedEntry[] = [];
  let bytes = 0;
  const walk = async (dir: string, under: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of [...entries].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const full = path.join(dir, entry.name);
      const relative = under === "" ? entry.name : `${under}/${entry.name}`;
      const info = await fs.lstat(full);
      if (info.isSymbolicLink()) {
        const target = await fs.readlink(full);
        if (escapes(base, dir, target))
          throw refuse(
            `${relative} under ${base} is a link to ${target}, which is ` +
              `outside what copy sends. Point it inside, or send the ` +
              `directory it reaches instead.`,
          );
        found.push({
          path: relative,
          link: target,
          executable: false,
          bytes: 0,
        });
      } else if (info.isDirectory()) {
        await walk(full, relative);
      } else if (info.isFile()) {
        found.push({
          path: relative,
          executable: (info.mode & 0o100) !== 0,
          bytes: info.size,
        });
        bytes += info.size;
      } else {
        throw refuse(
          `${relative} under ${base} is neither a file, a directory nor a ` +
            `link, so there is no sending it`,
        );
      }
      if (found.length > SETUP_MAX_FILES)
        throw refuse(
          `copy names ${base}, which holds more than ${SETUP_MAX_FILES} ` +
            `entries. A setup sends a small tree; this is probably not the ` +
            `directory that was meant.`,
        );
      if (bytes > SETUP_MAX_BYTES)
        throw refuse(
          `copy names ${base}, which holds more than ` +
            `${SETUP_MAX_BYTES / (1024 * 1024)} MB. A setup sends a small ` +
            `tree; this is probably not the directory that was meant.`,
        );
    }
  };
  await walk(base, "");
  return found;
}

/** What a block comes to, and what it would send. */
export interface SetupPlan {
  /** Twelve hex characters of sha256, the way a build stamp is written. */
  readonly fingerprint: string;
  readonly entries: readonly CopiedEntry[];
}

/**
 * The fingerprint of a block: its commands in order, where they land, and the
 * bytes of everything it copies.
 *
 * Everything that decides what the machine ends up with goes in, and nothing
 * that does not. `rerunOnChange` is absent on purpose: it says what to do when
 * this value changes, so folding it in would make changing it look like a
 * change to the work.
 */
export async function fingerprintSetup(block: SetupBlock): Promise<SetupPlan> {
  const entries = block.copy === undefined ? [] : await walkCopy(block.copy);
  const hasher = new Bun.CryptoHasher("sha256");
  for (const command of block.run) hasher.update(`run\0${command}\0`);
  hasher.update(`to\0${block.to ?? ""}\0`);
  for (const entry of entries)
    hasher.update(
      entry.link === undefined
        ? `file\0${entry.path}\0${entry.executable ? "x" : "-"}\0` +
            `${await hashFile(path.join(block.copy!, entry.path))}\0`
        : `link\0${entry.path}\0${entry.link}\0`,
    );
  return { fingerprint: hasher.digest("hex").slice(0, 12), entries };
}

/* --------------------------------------------------- the stamp and the hint */

/**
 * Where a block's stamp lives on the machine it set up.
 *
 * Under the block's own name rather than the host's, because it is the machine
 * that was set up and two hosts pointing at one machine set it up once. Built
 * as a string rather than joined: this is a path over there, and over there is
 * POSIX.
 */
export const setupStampDir = (home: string, block: string): string =>
  `${home}/.local/share/werk/setup/${block}`;
export const setupStampFile = (home: string, block: string): string =>
  `${setupStampDir(home, block)}/stamp`;

/** What this client last saw on a machine. A cache; see the note at the top. */
export interface SetupHint {
  /** The `[hosts.<name>]` this is about. */
  readonly host: string;
  /** The ssh destination it had, so a re-pointed block is a miss. */
  readonly sshHost: string;
  /** The `[setup.<name>]` that ran. */
  readonly block: string;
  /** What the stamp said. */
  readonly fingerprint: string;
  readonly at: string;
}

/**
 * Beside `HostCache` and never inside it. That file carries the client's build
 * and is discarded when the build changes; this one must survive an upgrade,
 * because upgrading werk is not a reason to run somebody's setup again.
 */
export const setupHintFile = (stateDir: string, host: string): string =>
  path.join(stateDir, "hosts", `${host}.setup.json`);

async function readHint(
  stateDir: string,
  host: string,
): Promise<SetupHint | null> {
  try {
    return JSON.parse(
      await fs.readFile(setupHintFile(stateDir, host), "utf8"),
    ) as SetupHint;
  } catch {
    return null;
  }
}

async function writeHint(stateDir: string, hint: SetupHint): Promise<void> {
  const file = setupHintFile(stateDir, hint.host);
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify(hint)}\n`, { mode: 0o600 });
  } catch {
    // A hint that cannot be written costs a round trip next time and nothing
    // else, so it is not worth failing a command over.
  }
}

/**
 * `$HOME` and the stamp, in one round trip.
 *
 * Both in one because they are wanted together and the round trip is the whole
 * cost: werk cannot know a path on a machine it has not looked at, and asking
 * twice would make the cheap case twice as expensive as it needs to be.
 *
 * The block's name is written into the script unquoted, which is safe because
 * `isBlockName` allows letters, digits, dots, dashes and underscores and
 * nothing else.
 */
export async function readMachineSetup(
  machine: SetupMachine,
  block: string,
): Promise<{ home: string; stamp: string | null }> {
  const outcome = await machine.runner.run(
    machine.exec(
      `printf '%s\\n' "$HOME"; ` +
        `s="$HOME/.local/share/werk/setup/${block}/stamp"; ` +
        `if [ -f "$s" ]; then cat "$s"; fi`,
    ),
    { timeoutMs: EXEC_TIMEOUT_MS },
  );
  requireSuccess(
    machine.sshHost,
    outcome,
    `asking ${machine.name} what setup it has`,
    "HOST_SETUP_FAILED",
  );
  const [home = "", ...rest] = outcome.stdout.replaceAll("\r", "").split("\n");
  if (home.trim() === "")
    throw new HostError(
      "HOST_SETUP_FAILED",
      machine.sshHost,
      `${machine.name} did not say where its home directory is, so werk does ` +
        `not know where a setup would go.`,
      outcome.stderr,
    );
  const stamp = rest.join("\n").trim();
  return { home: home.trim(), stamp: stamp === "" ? null : stamp };
}

/* ------------------------------------------------------------- running one */

/** What a run of a setup came to. */
export type SetupOutcome =
  /** Nothing named a block, so there was nothing to do. */
  | { readonly state: "none" }
  /** The machine already has this exact block. */
  | {
      readonly state: "current";
      readonly block: string;
      readonly fingerprint: string;
      /** Whether the machine had to be asked, or the hint answered. */
      readonly asked: boolean;
    }
  | {
      readonly state: "ran";
      readonly block: string;
      readonly fingerprint: string;
      readonly commands: number;
      /** How many entries `copy` sent, when it sent any. */
      readonly copied?: number;
    }
  /** Left alone, with the reason a person would need to act on it. */
  | {
      readonly state: "skipped";
      readonly block: string;
      readonly fingerprint: string;
      readonly why: string;
    };

/**
 * The far side's own output, on stderr, always.
 *
 * stderr for the reason everything werk says about itself goes there: `--json`
 * is one value on stdout and a `bun install` writing into it would break every
 * caller parsing it. It is written as it arrives rather than at the end, so a
 * slow command looks like a slow command instead of a hang.
 */
const watching = (ctx: WerkContext) => (chunk: string) => ctx.writeError(chunk);

/** The failing command's number, as the script's own trap reported it. */
const MARKER = /^werk-setup: command (\d+) failed/m;
/** How much of the far side's output a failure repeats. */
const DETAIL_LINES = 3;

/**
 * The end of what the far side said, for a failure to carry.
 *
 * Only the end, because all of it has already been written to stderr as it
 * arrived: repeating a whole `bun install` inside the failure would say the same
 * thing twice and bury the sentence that matters. The trap's own line goes,
 * because the message it feeds already names the command.
 */
function tail(outcome: RunOutcome): string {
  return (outcome.stderr || outcome.stdout)
    .replaceAll("\r", "")
    .split("\n")
    .filter((line) => line.trim() !== "" && !MARKER.test(line))
    .slice(-DETAIL_LINES)
    .join("\n");
}

/**
 * The script one setup invocation runs.
 *
 * `set -e` stops at the first command that fails, which is what makes the stamp
 * at the end a claim that every command succeeded. The trap is how werk finds
 * out *which* command that was: with everything in one invocation there is no
 * exit status per command to read, and a person told only that "the setup
 * failed" has to go and run each line by hand.
 */
export function setupScript(options: {
  readonly cwd: string;
  readonly run: readonly string[];
  /** Written last, when the run has one. A workspace setup has none. */
  readonly stamp?: { readonly dir: string; readonly file: string };
  readonly fingerprint: string;
}): string {
  const lines = [
    "set -e",
    `cd ${shellQuote(options.cwd)}`,
    "werk_step=0",
    `trap 'werk_status=$?; [ "$werk_status" -eq 0 ] || printf ` +
      `"werk-setup: command %s failed (exit %s)\\n" "$werk_step" ` +
      `"$werk_status" >&2' EXIT`,
  ];
  options.run.forEach((command, index) => {
    lines.push(`werk_step=${index + 1}`, command);
  });
  if (options.stamp !== undefined)
    lines.push(
      `mkdir -p ${shellQuote(options.stamp.dir)}`,
      `printf '%s\\n' ${shellQuote(options.fingerprint)} > ` +
        shellQuote(options.stamp.file),
    );
  return `${lines.join("\n")}\n`;
}

/** What one run of a block needs, whichever of the two kinds of run it is. */
interface RunOne {
  readonly ctx: WerkContext;
  readonly machine: SetupMachine;
  readonly block: SetupBlock;
  readonly name: string;
  readonly plan: SetupPlan;
  /** Where the commands run, and what `to` is relative to. */
  readonly base: string;
  readonly stamp?: { readonly dir: string; readonly file: string };
  readonly env: Readonly<Record<string, string>>;
  readonly code: HostErrorCode;
  /** A sentence appended to a failure, for a caller that has one to add. */
  readonly leaves?: string;
  readonly progress?: ProgressReporter;
}

/** Send what the block copies, run its commands, and stamp it afterwards. */
async function perform(one: RunOne): Promise<SetupOutcome> {
  const { ctx, machine, block, plan } = one;
  if (block.copy !== undefined && block.to !== undefined) {
    const to = `${one.base}/${block.to}`;
    one.progress?.say(`sending ${block.copy} to ${machine.name}`);
    await sendTree(
      {
        sshHost: machine.sshHost,
        runner: machine.runner,
        exec: machine.exec,
        // `sendTree` never reaches for rsync, so there is nothing to say here.
        rsync: false,
        prepare: `mkdir -p ${shellQuote(to)}`,
        // No `finish`. What says this setup happened is the stamp, and that is
        // written after the commands have run, which is later than any finish
        // could be.
        what: `sending ${block.copy} to ${machine.name}`,
        code: one.code,
        timeoutMs: TRANSFER_TIMEOUT_MS,
      },
      block.copy,
      to,
    );
  }

  one.progress?.say(`running the ${one.name} setup on ${machine.name}`);
  const script = setupScript({
    cwd: one.base,
    run: block.run,
    ...(one.stamp === undefined ? {} : { stamp: one.stamp }),
    fingerprint: plan.fingerprint,
  });
  const { argv, env } = machine.login(script, one.env);
  const outcome = await machine.runner.run(argv, {
    timeoutMs: SETUP_TIMEOUT_MS,
    onOutput: watching(ctx),
    ...(env === undefined ? {} : { env }),
  });
  requireSetupSuccess(one, outcome);
  return {
    state: "ran",
    block: one.name,
    fingerprint: plan.fingerprint,
    commands: block.run.length,
    ...(plan.entries.length === 0 ? {} : { copied: plan.entries.length }),
  };
}

/**
 * A failure that names the machine, the command and what the far side said.
 *
 * ssh's own 255 goes through `requireConnection` first, so a machine that
 * stopped answering stays `HOST_UNREACHABLE` rather than being reported as a
 * setup that refused. Which command failed comes from the script's own trap:
 * one invocation has one exit status, and a person told only that "the setup
 * failed" has to go and run each line by hand to find out which.
 */
function requireSetupSuccess(one: RunOne, outcome: RunOutcome): void {
  const what = `running the ${one.name} setup on ${one.machine.name}`;
  if (outcome.timedOut)
    throw new HostError(
      one.code,
      one.machine.sshHost,
      `${what} did not finish in ${SETUP_TIMEOUT_MS / 60_000} minutes, so ` +
        `werk stopped it. Whatever it had already done is still done.`,
      outcome.stderr || outcome.stdout,
    );
  requireConnection(one.machine.sshHost, outcome, what);
  if (outcome.code === 0) return;
  const step = MARKER.exec(outcome.stderr);
  const which = step === null ? undefined : one.block.run[Number(step[1]) - 1];
  throw new HostError(
    one.code,
    one.machine.sshHost,
    `${what} failed` +
      (which === undefined ? "" : ` at \`${which}\``) +
      "." +
      (one.leaves === undefined ? "" : ` ${one.leaves}`),
    tail(outcome),
  );
}

/* ---------------------------------------------------------- the host setup */

export interface HostSetupOptions {
  readonly ctx: WerkContext;
  /** The `[hosts.<name>]` block's name. */
  readonly name: string;
  readonly host: Host;
  /** Run it whatever the stamp says. */
  readonly force?: boolean;
  readonly runner?: RemoteRunner;
  readonly progress?: ProgressReporter;
  /** The streams a question is asked on; the real ones by default. */
  readonly prompt?: PromptOptions;
}

/**
 * Set the machine a host block names up, if it is not set up already.
 *
 * | Stamp | `rerunOnChange` | What happens |
 * | --- | --- | --- |
 * | absent | either | Run. This is the first time werk has set this machine up. |
 * | equal | either | Nothing, and no round trip where the hint says so. |
 * | different | `true` | Run. |
 * | different | otherwise | Ask, and skip with a note where nobody can answer. |
 *
 * The last row is a statement rather than a refusal on purpose. A changed
 * `copy` failing an unattended `werk create` would make editing a config file
 * a way to break a machine's automation, and werk already prefers a statement
 * where a prompt would break `--json`: the uncommitted-file count `create`
 * reports is the same call.
 */
export async function runHostSetup(
  options: HostSetupOptions,
): Promise<SetupOutcome> {
  const { ctx, name, host } = options;
  if (host.setup === undefined) return { state: "none" };
  const block = setupFor(host.setup, ctx.setups, {
    by: `[hosts.${name}]`,
    ...(ctx.hostOrigin[name] === undefined
      ? {}
      : { from: ctx.hostOrigin[name] }),
  });
  const machine = setupMachineFor(name, host, options.runner);
  const plan = await fingerprintSetup(block);

  if (options.force !== true) {
    const hint = await readHint(ctx.stateDir, name);
    if (
      hint !== null &&
      hint.sshHost === machine.sshHost &&
      hint.block === host.setup &&
      hint.fingerprint === plan.fingerprint
    )
      return {
        state: "current",
        block: host.setup,
        fingerprint: plan.fingerprint,
        asked: false,
      };
  }

  const seen = await readMachineSetup(machine, host.setup);
  const remember = () =>
    writeHint(ctx.stateDir, {
      host: name,
      sshHost: machine.sshHost,
      block: host.setup!,
      fingerprint: plan.fingerprint,
      at: new Date().toISOString(),
    });

  if (options.force !== true && seen.stamp === plan.fingerprint) {
    await remember();
    return {
      state: "current",
      block: host.setup,
      fingerprint: plan.fingerprint,
      asked: true,
    };
  }

  if (
    options.force !== true &&
    seen.stamp !== null &&
    block.rerunOnChange !== true
  ) {
    const question = `The setup for ${name} has changed since werk last ran it. Run it again?`;
    if (!ctx.yes && (ctx.json || !canPrompt(ctx))) {
      // Not under `--json`: the record carries a `skipped` state and a `why`,
      // which is the same statement in the register that caller reads.
      if (!ctx.json)
        ctx.writeError(
          `${question} werk left it alone: the block is not marked ` +
            `rerunOnChange and there is no terminal to ask in. Pass --yes to ` +
            `run it, or \`werk setup --host ${name} --force\`.\n`,
        );
      return {
        state: "skipped",
        block: host.setup,
        fingerprint: plan.fingerprint,
        why: "it changed, nothing could answer whether to run it again",
      };
    }
    options.progress?.stop();
    if (!(await confirm(ctx, question, options.prompt ?? {})))
      return {
        state: "skipped",
        block: host.setup,
        fingerprint: plan.fingerprint,
        why: "it changed and the answer was no",
      };
  }

  const outcome = await perform({
    ctx,
    machine,
    block,
    name: host.setup,
    plan,
    base: seen.home,
    stamp: {
      dir: setupStampDir(seen.home, host.setup),
      file: setupStampFile(seen.home, host.setup),
    },
    env: environmentFor(host, host.kind !== "ssh"),
    code: "HOST_SETUP_FAILED",
    ...(options.progress === undefined ? {} : { progress: options.progress }),
  });
  await remember();
  return outcome;
}

/* ----------------------------------------------------- the workspace setup */

/** What a repository has been trusted to run, and under which fingerprint. */
export interface RepositoryTrust {
  /** The repository's `werk.repo-id`. */
  readonly repository: string;
  readonly block: string;
  readonly fingerprint: string;
  readonly at: string;
}

/**
 * Where trust is recorded: werk's own state directory, keyed by repository.
 *
 * Not in the repository's git configuration. `werk.repo-id` is the only thing
 * werk writes into a person's git config and that is worth keeping true, and a
 * decision about whether to run a branch's code is not something to hand to
 * whoever can push to the branch.
 */
export const trustFile = (stateDir: string, repository: string): string =>
  path.join(stateDir, "trust", `${repository}.json`);

async function readTrust(
  stateDir: string,
  repository: string,
): Promise<RepositoryTrust | null> {
  try {
    return JSON.parse(
      await fs.readFile(trustFile(stateDir, repository), "utf8"),
    ) as RepositoryTrust;
  } catch {
    return null;
  }
}

async function writeTrust(
  stateDir: string,
  trust: RepositoryTrust,
): Promise<void> {
  const file = trustFile(stateDir, trust.repository);
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify(trust)}\n`, { mode: 0o600 });
  } catch {
    // Losing this costs the question being asked again, which is the safe
    // direction, so it is not worth failing a command over.
  }
}

export interface WorkspaceSetupOptions {
  readonly ctx: WerkContext;
  /** The `[hosts.<name>]` the workspace is on. */
  readonly name: string;
  readonly host: Host;
  /** The workspace directory, on whichever machine holds it. */
  readonly directory: string;
  /** What the repository is called, for the question. */
  readonly repository: string;
  /** The repository's `werk.repo-id`, which is what trust is keyed by. */
  readonly identity: string;
  readonly runner?: RemoteRunner;
  readonly progress?: ProgressReporter;
  readonly prompt?: PromptOptions;
}

/**
 * Run the `workspaceSetup` block in a workspace that has just been made.
 *
 * There is no stamp. A workspace is new, so it has never been set up, and the
 * question the stamp answers does not arise. What does arise is trust: a
 * `workspaceSetup` usually lives in the repository's own `.werk/config.toml`,
 * so checking out a colleague's branch would otherwise run their code as you,
 * automatically, before anybody had read it.
 *
 * So werk asks once per repository and records the fingerprint it was told yes
 * about, and asks again when that changes. `--yes` answers it. With no terminal
 * and no `--yes` the setup is skipped with a note rather than run, because the
 * safe direction here is the one that does nothing.
 */
export async function runWorkspaceSetup(
  options: WorkspaceSetupOptions,
): Promise<SetupOutcome> {
  const { ctx, name, host } = options;
  if (ctx.workspaceSetup === undefined) return { state: "none" };
  const block = setupFor(ctx.workspaceSetup, ctx.setups, {
    by: "workspaceSetup",
    ...(ctx.workspaceSetupFrom === undefined
      ? {}
      : { from: ctx.workspaceSetupFrom }),
  });
  const plan = await fingerprintSetup(block);
  const trusted = await readTrust(ctx.stateDir, options.identity);
  const already =
    trusted !== null &&
    trusted.block === ctx.workspaceSetup &&
    trusted.fingerprint === plan.fingerprint;

  if (!already) {
    const answer = await askToTrust(options, block.run);
    if (!answer)
      return {
        state: "skipped",
        block: ctx.workspaceSetup,
        fingerprint: plan.fingerprint,
        why: ctx.yes
          ? "the answer was no"
          : "nothing could answer whether to trust it",
      };
    await writeTrust(ctx.stateDir, {
      repository: options.identity,
      block: ctx.workspaceSetup,
      fingerprint: plan.fingerprint,
      at: new Date().toISOString(),
    });
  }

  return await perform({
    ctx,
    machine: setupMachineFor(name, host, options.runner),
    block,
    name: ctx.workspaceSetup,
    plan,
    // `to` is relative to the workspace here, and not to a home directory: a
    // block that a repository carries is describing that repository.
    base: options.directory,
    env: environmentFor(host, host.kind !== "ssh"),
    code: "WORKSPACE_SETUP_FAILED",
    // The branch was pushed and the worktree checked out before this ran, so
    // there is real work behind it. Destroying that to tidy up after a failed
    // `bun install` would lose more than it saved.
    leaves:
      `The workspace is still there, at ${options.directory} on ` +
      `${name}. werk left it alone rather than taking back a branch that ` +
      `already exists.`,
    ...(options.progress === undefined ? {} : { progress: options.progress }),
  });
}

/** The one question a repository's own setup asks, and its two silent answers. */
async function askToTrust(
  options: WorkspaceSetupOptions,
  run: readonly string[],
): Promise<boolean> {
  const { ctx } = options;
  if (ctx.yes) return true;
  const question =
    `${options.repository} wants to run its own setup before the session ` +
    `starts:\n\n${run.map((command) => `    ${command}`).join("\n")}\n\nRun it?`;
  if (ctx.json || !canPrompt(ctx)) {
    // Not under `--json`, where the record's `skipped` state says it instead.
    if (!ctx.json)
      ctx.writeError(
        `${options.repository} carries a workspaceSetup and werk has not been ` +
          `told to trust it. There is no terminal to ask in, so the workspace ` +
          `was left alone; pass --yes to run it.\n`,
      );
    return false;
  }
  options.progress?.stop();
  return await confirm(ctx, question, options.prompt ?? {});
}

/* -------------------------------------------------------------- the report */

/** What a person reads: one line, saying what happened and what it was. */
export function describeSetup(outcome: SetupOutcome, where: string): string {
  switch (outcome.state) {
    case "none":
      return `${where} has no setup block`;
    case "current":
      return (
        `${where} already has ${outcome.block} ${outcome.fingerprint}` +
        (outcome.asked ? "" : ", as werk last saw it")
      );
    case "ran":
      return (
        `ran ${outcome.block} ${outcome.fingerprint} on ${where}: ` +
        `${outcome.commands} ${outcome.commands === 1 ? "command" : "commands"}` +
        (outcome.copied === undefined ? "" : `, ${outcome.copied} sent`)
      );
    case "skipped":
      return `left ${outcome.block} alone on ${where}: ${outcome.why}`;
  }
}
