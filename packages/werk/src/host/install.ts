/**
 * Getting a werk onto a machine, and not doing it again.
 *
 * The binary is about 92 MB. That is fine to send once and pointless to send
 * twice, which is the whole reason for the stamp.
 *
 * ## The layout
 *
 * `~/.local/share/werk/bin/<target>-<stamp>/werk`, with a `stamp` file beside
 * it. The version is in the path rather than in a single `bin/werk`, so two
 * clients of different versions reaching the same machine coexist instead of
 * overwriting each other between one command and the next. Nothing prunes old
 * ones yet; that probably wants doing and nobody has worked out when.
 *
 * ## The match is exact
 *
 * The stamp has to equal this client's identity, character for character. Not
 * semver, not "close enough": there is no stable protocol version for the two
 * sides to claim compatibility against, so the only honest question is whether
 * the binary over there is the one this client would send. `werkVersion()`
 * answers exactly that.
 *
 * ## Ship on mismatch, which is neither "always" nor "once"
 *
 * Shipping every time wastes 92 MB on every command. Shipping only when the
 * directory is missing leaves a half-transferred binary looking installed
 * forever. So the decision is read off the stamp — different, missing, or a
 * binary that is not executable — and the stamp is written **last**, after the
 * binary is in place and executable. An interrupted transfer therefore leaves
 * no stamp, and the next run ships again.
 *
 * ## Where the binary comes from
 *
 * A compiled werk sending to a machine of its own shape sends itself, which is
 * the case that matters for a released binary: it has no bun and no source, so
 * it has nothing else to send. A werk being run interpreted — `bun
 * packages/werk/src/main.ts`, which is how everybody working on werk runs it —
 * builds one on demand. Refusing that outright would make the remote path
 * undevelopable, which is a strange thing for the remote path to be.
 *
 * An interpreted client's identity is `0.0.0-source` for every working tree,
 * which would make the stamp match after the source had changed and leave a
 * stale binary on the far side. So the stamp for a build-on-demand carries the
 * hash of the binary that was actually produced. A tree that has not changed
 * hashes the same and sends nothing; one that has changed sends.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  requireConnection,
  requireSuccess,
  shellQuote,
  sshExecArgv,
  SSH_COMMON_OPTIONS,
  type RemoteRunner,
} from "./ssh.js";
import { HostError, type RemoteFacts } from "./types.js";
import type { HostTarget } from "./target.js";
import { SOURCE_IDENTITY, werkVersion } from "../runtime/version.js";

/** A transfer of about 92 MB over a link werk knows nothing about. */
export const TRANSFER_TIMEOUT_MS = 300_000;

/** Where a werk of one identity lives on a machine. */
export interface RemoteLayout {
  readonly dir: string;
  readonly binary: string;
  readonly stampFile: string;
}
export function remoteLayout(
  home: string,
  target: string,
  stamp: string,
): RemoteLayout {
  const dir = `${home}/.local/share/werk/bin/${target}-${stamp}`;
  return { dir, binary: `${dir}/werk`, stampFile: `${dir}/stamp` };
}

/**
 * The bun target this werk was compiled for, when it was compiled at all.
 *
 * The only platform branch in this directory, and it is here because "which
 * binary am I" has no other way of being asked. Both arguments are defaulted so
 * the mapping is exercised for every platform from a test on any of them.
 *
 * A werk built on a musl distribution reports `linux` and `x64` exactly as a
 * glibc one does, so this would claim a glibc target for it and send it to a
 * glibc machine. Nobody has hit that; the manual target override in `target.ts`
 * is the way out if anybody does.
 */
const LOCAL_TARGETS: Readonly<Record<string, string>> = {
  "linux-x64": "bun-linux-x64",
  "linux-arm64": "bun-linux-arm64",
};
export function localTarget(
  platform: string = process.platform,
  arch: string = process.arch,
): string | undefined {
  return LOCAL_TARGETS[`${platform}-${arch}`];
}

/** Long enough to tell one build from another, short enough to read. */
export async function hashFile(file: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  const stream = Bun.file(file).stream();
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>)
    hasher.update(chunk);
  return hasher.digest("hex").slice(0, 12);
}

export interface InstallOptions {
  readonly sshHost: string;
  readonly runner: RemoteRunner;
  readonly facts: RemoteFacts;
  readonly target: HostTarget;
  /** werk's local state directory; a build on demand is cached under it. */
  readonly stateDir: string;
  /** Absolute path of the entry module, for a build on demand. */
  readonly entry: string;
  /** What this client is. Defaults to `werkVersion()`; a test supplies one. */
  readonly build?: string;
  /** True where this werk is the compiled binary rather than bun plus source. */
  readonly compiled: boolean;
  /** `bun` interpreting, or werk itself compiled. */
  readonly execPath: string;
}

export interface Installed {
  /** Absolute path of the werk binary on the far machine. */
  readonly binary: string;
  /** What the far side is now stamped with. */
  readonly stamp: string;
  readonly shipped: boolean;
  /** Why it was or was not sent, in one clause, for a log or a report. */
  readonly reason: string;
}

/** What the machine says is installed for this identity, or null. */
export async function readStamp(
  options: Pick<InstallOptions, "sshHost" | "runner">,
  layout: RemoteLayout,
): Promise<string | null> {
  const { sshHost, runner } = options;
  const outcome = await runner.run(
    sshExecArgv(
      sshHost,
      `d=${shellQuote(layout.dir)}; ` +
        `if [ -x "$d/werk" ] && [ -f "$d/stamp" ]; then cat "$d/stamp"; fi`,
    ),
  );
  requireConnection(sshHost, outcome, `checking what ${sshHost} already has`);
  const stamp = outcome.stdout.replaceAll("\r", "").trim();
  return stamp === "" ? null : stamp;
}

/** Compile the CLI here, for a machine that is not here. */
async function buildForTarget(
  options: InstallOptions,
  outfile: string,
  identity: string,
): Promise<void> {
  await fs.mkdir(path.dirname(outfile), { recursive: true });
  // The flags mirror `packages/werk/build.ts`, plus the target. If that file
  // grows a flag this one has to grow it too: a binary built here and one built
  // by `bun run build` should differ only in which machine they run on.
  const outcome = await options.runner.run(
    [
      options.execPath,
      "build",
      "--compile",
      `--target=${options.target.target}`,
      options.entry,
      "--define",
      "WERK_COMPILED=true",
      "--define",
      `WERK_BUILD=${JSON.stringify(identity)}`,
      "--no-compile-autoload-dotenv",
      "--outfile",
      outfile,
    ],
    { timeoutMs: TRANSFER_TIMEOUT_MS },
  );
  if (outcome.code !== 0)
    throw new HostError(
      "HOST_BOOTSTRAP_FAILED",
      options.sshHost,
      `werk could not build a binary for ${options.target.target}. This werk ` +
        `is running from source, so it has to compile one before it can send ` +
        `it; if that is not what you want, run \`bun run build\` and use the ` +
        `binary.`,
      outcome.stderr || outcome.stdout,
    );
}

/**
 * The binary to send, and the stamp it will be recorded under.
 *
 * A compiled client that cannot send itself — because the far machine is a
 * different shape — has nothing to fall back on: it holds no source and no bun,
 * so there is nothing here to compile from.
 */
async function localBinary(
  options: InstallOptions,
  identity: string,
): Promise<{ file: string; stamp: string }> {
  if (options.compiled) {
    if (localTarget() === options.target.target)
      return { file: options.execPath, stamp: identity };
    throw new HostError(
      "HOST_BOOTSTRAP_FAILED",
      options.sshHost,
      `${options.sshHost} needs a ${options.target.target} build and this ` +
        `werk is not one. A compiled werk can only send itself, so reaching ` +
        `that machine needs a werk built for it — run one from a checkout, or ` +
        `install a matching build there yourself.`,
    );
  }
  const file = path.join(
    options.stateDir,
    "bin",
    `${options.target.target}-${identity}`,
    "werk",
  );
  await buildForTarget(options, file, identity);
  const stamp =
    identity === SOURCE_IDENTITY
      ? `${identity}-${await hashFile(file)}`
      : identity;
  return { file, stamp };
}

/**
 * Send it, and stamp it afterwards.
 *
 * `tar -cz | ssh 'tar -xz'` is the default because it assumes nothing about the
 * far machine beyond POSIX and a shell, and one round trip does the whole job
 * including the stamp. `rsync` is used where the probe found one, for its
 * delta: a rebuilt binary usually differs from the last one in a fraction of
 * its bytes. rsync runs `rsync --server` over a *non-login* ssh, so a machine
 * with rsync on the login PATH and not on the other one exists; that is why a
 * failed rsync falls back rather than raising.
 */
async function send(
  options: InstallOptions,
  layout: RemoteLayout,
  file: string,
  stamp: string,
): Promise<string> {
  const { sshHost, runner } = options;
  const quotedDir = shellQuote(layout.dir);
  const finish =
    `chmod 755 ${shellQuote(layout.binary)} && ` +
    // Last, so that an interrupted transfer never looks installed.
    `printf '%s\\n' ${shellQuote(stamp)} > ${shellQuote(layout.stampFile)}`;
  const prepare = `mkdir -p ${quotedDir} && rm -f ${shellQuote(layout.stampFile)}`;

  if (options.facts.rsync) {
    const rsynced = await rsyncTo(options, layout, file, prepare, finish);
    if (rsynced) return "sent with rsync";
  }

  const name = path.basename(file);
  const rename =
    name === "werk"
      ? ""
      : ` && mv -f ${shellQuote(`${layout.dir}/${name}`)} ${shellQuote(layout.binary)}`;
  const tar = runner.start([
    "tar",
    "-czf",
    "-",
    "-C",
    path.dirname(file),
    name,
  ]);
  const outcome = await runner.run(
    sshExecArgv(
      sshHost,
      `${prepare} && tar -xzf - -C ${quotedDir}${rename} && ${finish}`,
    ),
    { stdin: tar.stdout, timeoutMs: TRANSFER_TIMEOUT_MS },
  );
  tar.kill();
  requireSuccess(sshHost, outcome, `sending werk to ${sshHost}`);
  return "sent with tar";
}

/** Returns false where rsync could not do it, so the caller can use tar. */
async function rsyncTo(
  options: InstallOptions,
  layout: RemoteLayout,
  file: string,
  prepare: string,
  finish: string,
): Promise<boolean> {
  const { sshHost, runner } = options;
  requireSuccess(
    sshHost,
    await runner.run(sshExecArgv(sshHost, prepare)),
    `making room for werk on ${sshHost}`,
  );
  const copied = await runner.run(
    [
      "rsync",
      "--times",
      "--chmod=F755",
      "-e",
      // rsync splits this on whitespace itself, and none of the options
      // contains any, so no quoting is involved.
      ["ssh", ...SSH_COMMON_OPTIONS].join(" "),
      file,
      `${sshHost}:${layout.binary}`,
    ],
    { timeoutMs: TRANSFER_TIMEOUT_MS },
  );
  if (copied.code !== 0) return false;
  requireSuccess(
    sshHost,
    await runner.run(sshExecArgv(sshHost, finish)),
    `stamping werk on ${sshHost}`,
  );
  return true;
}

/** Make sure the machine has this werk, and say what that took. */
export async function ensureRemoteWerk(
  options: InstallOptions,
): Promise<Installed> {
  const identity = options.build ?? werkVersion();
  // A build on demand has to happen before the stamp is known, because the
  // stamp for an interpreted client is derived from the binary's contents.
  // A compiled one already knows its identity and can ask the machine first.
  const built =
    identity === SOURCE_IDENTITY
      ? await localBinary(options, identity)
      : undefined;
  const stamp = built?.stamp ?? identity;
  const layout = remoteLayout(options.facts.home, options.target.target, stamp);
  const found = await readStamp(options, layout);
  if (found === stamp)
    return {
      binary: layout.binary,
      stamp,
      shipped: false,
      reason: `${options.sshHost} already has ${stamp}`,
    };
  const source = built ?? (await localBinary(options, identity));
  const how = await send(options, layout, source.file, source.stamp);
  return {
    binary: layout.binary,
    stamp,
    shipped: true,
    reason:
      found === null
        ? `${options.sshHost} had no ${stamp}, ${how}`
        : `${options.sshHost} had ${found}, ${how}`,
  };
}
