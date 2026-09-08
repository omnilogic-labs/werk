/**
 * The directory a repository's workspaces sit in, as a readable leaf and a
 * digest.
 *
 * Both makers lay their workspaces out the same way — `<root>/<slot>/<name>` —
 * so the shape of a slot lives here rather than in either of them. The leaf is
 * there so a person browsing the root can tell what they are looking at; the
 * digest is there because that leaf is not unique, and two checkouts of the same
 * project would otherwise want the same directory for their `fix-login`
 * workspaces.
 *
 * What is digested is the caller's to choose, and the two makers choose
 * differently on purpose. A worktree on this machine can digest the checkout's
 * absolute path, because that path is the repository as far as this machine is
 * concerned. A workspace on another machine cannot: a path here says nothing
 * about where anything should land there, and moving the checkout would strand
 * every workspace already made from it. See `ssh.ts` for what it digests
 * instead.
 */
import { createHash } from "node:crypto";

/** Characters a directory leaf carries everywhere werk runs, Windows included. */
const unsafe = /[^A-Za-z0-9._-]/g;

export function repositorySlotFor(leaf: string, identity: string): string {
  const digest = createHash("sha256")
    .update(identity)
    .digest("hex")
    .slice(0, 8);
  const safe = leaf.replace(unsafe, "-");
  return `${safe === "" ? "repository" : safe}-${digest}`;
}
