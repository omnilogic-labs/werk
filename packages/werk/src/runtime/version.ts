/**
 * What this werk is, in one string.
 *
 * The identity werk is currently trying is the package version, the git short
 * SHA it was built from, and a `-dirty` marker when the tree had uncommitted
 * changes: `0.0.0-a1b2c3d`, or `0.0.0-a1b2c3d-dirty`. `build.ts` derives it and
 * defines it into the compiled binary; nothing generated is committed.
 *
 * What it is for: a client that ships a werk binary to a machine wants to ask
 * "is the binary over there the one I would send?". Answering that needs one
 * identity rather than two. So the same string is what `werk --version` prints,
 * what the CLI hands `serveSessionDaemon`, and therefore what
 * `daemonInfo().version` answers with. Treat the comparison as a hint rather
 * than a guarantee — nothing here is signed, and nothing stops two trees with
 * the same SHA differing in what was never committed.
 */
import pkg from "../../package.json";

declare const WERK_BUILD: string;

/**
 * How a build is named, given what git said. Separate from reading it so
 * `build.ts` and a test can both call it.
 *
 * No SHA at all — git missing, or a source tree that is not a checkout — is
 * `-unknown` rather than a blank or an invented id, because the point of the
 * string is to compare unequal when it cannot say.
 */
export function formatBuildIdentity(
  version: string,
  sha: string | undefined,
  dirty: boolean,
): string {
  if (!sha) return `${version}-unknown`;
  return `${version}-${sha}${dirty ? "-dirty" : ""}`;
}

/**
 * What an interpreted run reports.
 *
 * `bun packages/werk/src/main.ts` was never built, so it has no build id. It
 * could read git itself, but that would name a working tree rather than an
 * artefact anybody could be sent, and a client comparing identities would be
 * told two things are the same when only one of them exists. Saying `-source`
 * is the honest answer: it compares unequal to every build, which is what a
 * working tree is.
 */
export const SOURCE_IDENTITY = `${pkg.version}-source`;

/**
 * The identity of the werk that is running. Read through a `typeof` guard for
 * the same reason `runtime/daemon.ts` reads `WERK_COMPILED` that way: the
 * define exists only on the compiled side, and an interpreted run must report
 * something honest rather than crash on a free variable.
 */
export function werkVersion(): string {
  return typeof WERK_BUILD === "undefined" ? SOURCE_IDENTITY : WERK_BUILD;
}
