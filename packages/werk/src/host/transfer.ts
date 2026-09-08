/**
 * Putting bytes on a machine that is not this one.
 *
 * Two things need this and they want the same two round trips: the 92 MB werk
 * binary in `install.ts`, and whatever a person's setup asks werk to copy. The
 * mechanics are the same either way — make room, move the bytes, then write
 * something that says it worked — so they live here once rather than being
 * written twice with the second copy drifting.
 *
 * ## `prepare` and `finish` belong to the caller
 *
 * What "make room" and "say it worked" mean differ per caller: one writes a
 * version stamp beside a binary it just chmodded, another writes a manifest of
 * what it placed. So this file owns the transfer and the caller owns both ends
 * of it, as shell it hands over.
 *
 * **`finish` runs last, after the bytes are in place.** That is the property
 * the whole thing rests on: an interrupted transfer leaves whatever `finish`
 * would have written absent, so the next run can tell that it has to send
 * again. A caller that writes its stamp in `prepare` has broken it.
 *
 * ## tar always, rsync only where it pays
 *
 * `tar -czf -` piped into `tar -xzf -` over one ssh needs nothing on the far
 * machine beyond POSIX and a shell, and one round trip does the whole job.
 * rsync earns its place against a rebuilt binary that differs from the last one
 * in a fraction of its bytes, and earns nothing against a handful of small
 * files, which is why {@link sendTree} does not offer it.
 *
 * rsync runs `rsync --server` over a *non-login* ssh, so a machine with rsync
 * on the login PATH and not on the other one exists. A failed rsync therefore
 * falls back to tar rather than raising.
 */
import path from "node:path";
import {
  requireSuccess,
  shellQuote,
  sshExecArgv,
  SSH_COMMON_OPTIONS,
  type RemoteRunner,
} from "./ssh.js";
import type { HostErrorCode } from "./types.js";

/** Long enough for a large file over a slow link. */
export const TRANSFER_TIMEOUT_MS = 300_000;

export interface SendOptions {
  readonly sshHost: string;
  readonly runner: RemoteRunner;
  /** Whether the machine has rsync, as the probe found. */
  readonly rsync: boolean;
  /** Shell run on the far side before anything is written. */
  readonly prepare: string;
  /** Shell run on the far side last. See the note above: it must be last. */
  readonly finish: string;
  /** What this is doing, for a failure message: "sending werk to beast". */
  readonly what: string;
  /** The code a far-side failure carries. */
  readonly code?: HostErrorCode;
  readonly timeoutMs?: number;
  /** rsync's `--chmod`, which the tar path leaves to `finish`. */
  readonly rsyncChmod?: string;
}

/** How the bytes got there, for a caller that reports what it did. */
export type SentBy = "rsync" | "tar";

/**
 * One local file, landing at `to` on the far side.
 *
 * `to` is an absolute path over there. Its directory is created by `prepare`,
 * which the caller writes, because only the caller knows what else has to be
 * cleared out of the way first.
 */
export async function sendFile(
  options: SendOptions,
  file: string,
  to: string,
): Promise<SentBy> {
  if (options.rsync && (await rsyncTo(options, file, to))) return "rsync";

  const { sshHost, runner } = options;
  const dir = path.posix.dirname(to);
  const name = path.basename(file);
  // tar carries the file under its own name, so a build sitting under a
  // different one is moved into place afterwards.
  const rename =
    name === path.posix.basename(to)
      ? ""
      : ` && mv -f ${shellQuote(`${dir}/${name}`)} ${shellQuote(to)}`;
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
      `${options.prepare} && tar -xzf - -C ${shellQuote(dir)}${rename} && ${options.finish}`,
    ),
    {
      stdin: tar.stdout,
      timeoutMs: options.timeoutMs ?? TRANSFER_TIMEOUT_MS,
    },
  );
  tar.kill();
  requireSuccess(sshHost, outcome, options.what, options.code);
  return "tar";
}

/**
 * The contents of a local directory, landing under `to` on the far side.
 *
 * tar only. See the note above on why rsync is not offered here.
 */
export async function sendTree(
  options: SendOptions,
  dir: string,
  to: string,
): Promise<SentBy> {
  const { sshHost, runner } = options;
  // `-C dir .` carries the contents rather than the directory, so the far side
  // gets `<to>/<entry>` and not `<to>/<basename of dir>/<entry>`.
  const tar = runner.start(["tar", "-czf", "-", "-C", dir, "."]);
  const outcome = await runner.run(
    sshExecArgv(
      sshHost,
      `${options.prepare} && tar -xzf - -C ${shellQuote(to)} && ${options.finish}`,
    ),
    {
      stdin: tar.stdout,
      timeoutMs: options.timeoutMs ?? TRANSFER_TIMEOUT_MS,
    },
  );
  tar.kill();
  requireSuccess(sshHost, outcome, options.what, options.code);
  return "tar";
}

/** Returns false where rsync could not do it, so the caller can use tar. */
async function rsyncTo(
  options: SendOptions,
  file: string,
  to: string,
): Promise<boolean> {
  const { sshHost, runner } = options;
  requireSuccess(
    sshHost,
    await runner.run(sshExecArgv(sshHost, options.prepare)),
    options.what,
    options.code,
  );
  const copied = await runner.run(
    [
      "rsync",
      "--times",
      ...(options.rsyncChmod === undefined
        ? []
        : [`--chmod=${options.rsyncChmod}`]),
      "-e",
      // rsync splits this on whitespace itself, and none of the options
      // contains any, so no quoting is involved.
      ["ssh", ...SSH_COMMON_OPTIONS].join(" "),
      file,
      `${sshHost}:${to}`,
    ],
    { timeoutMs: options.timeoutMs ?? TRANSFER_TIMEOUT_MS },
  );
  if (copied.code !== 0) return false;
  requireSuccess(
    sshHost,
    await runner.run(sshExecArgv(sshHost, options.finish)),
    options.what,
    options.code,
  );
  return true;
}
