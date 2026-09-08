/**
 * One way of writing down which workspace is meant, at three levels of
 * verbosity.
 *
 * A workspace has a name, sits somewhere on disk, and will eventually sit on a
 * machine that is not this one. Every place that names a workspace wants a
 * different amount of that, and until now each place spelled out whatever it
 * happened to have. The levels are here so those places choose an amount rather
 * than a spelling.
 *
 * The grammar is `name[@host][:directory]`. It is unambiguous because a
 * workspace name carries no `@`, no `:` and no `/` (see `WORKSPACE_NAME` in
 * `local.ts`), so the first `:` after the name and host ends the prefix and
 * everything after it is the path. A Windows path survives, because the colon
 * after a drive letter can never be the first one.
 *
 * The host component is absent while werk makes workspaces only on the machine
 * it is running on. Nothing here invents a host identity: there is no host in
 * the model to read one from, and what a host is even called is
 * [question 1](../../../docs/product-specification.md#1-what-do-we-call-a-machine-and-what-do-we-call-the-thing-that-makes-machines).
 * What an absent host should mean, and whether a reference should always name
 * one, is
 * [question 24](../../../docs/product-specification.md#24-what-is-the-host-component-of-a-workspace-reference).
 */

/**
 * How much of a reference to write.
 *
 * - `name` is the workspace name alone: `fix-login`.
 * - `path` adds where it is: `fix-login:/state/workspaces/werk-a3f2b1c9/fix-login`.
 * - `full` adds which machine it is on: `fix-login@somehost:/path`.
 *
 * `full` and `path` are the same string while there is no host, which is the
 * only case that exists today.
 */
export type WorkspaceReferenceLevel = "name" | "path" | "full";

/**
 * The levels, widest first. `fitWorkspaceReference` walks this order, so it is
 * also the order in which detail is given up when there is not room for it.
 */
export const WORKSPACE_REFERENCE_LEVELS: readonly WorkspaceReferenceLevel[] = [
  "full",
  "path",
  "name",
];

/**
 * What a reference is made of.
 *
 * Deliberately not a `Workspace`: the places that need to write a reference
 * mostly do not have one. A session knows the directory it was started in and
 * nothing else, so a reference is the parts a reference needs and no more.
 */
export interface WorkspaceReference {
  readonly name: string;
  /** Absolute path to the working directory. */
  readonly directory: string;
  /**
   * Which machine it is on. Absent everywhere today, because nothing in the
   * model supplies one.
   */
  readonly host?: string;
}

/** The reference for a workspace that exists. */
export function workspaceReference(workspace: {
  readonly name: string;
  readonly directory: string;
  readonly host?: string;
}): WorkspaceReference {
  return workspace.host === undefined
    ? { name: workspace.name, directory: workspace.directory }
    : {
        name: workspace.name,
        directory: workspace.directory,
        host: workspace.host,
      };
}

/** A reference written out at one level. */
export function formatWorkspaceReference(
  reference: WorkspaceReference,
  level: WorkspaceReferenceLevel,
): string {
  const host =
    level === "full" && reference.host !== undefined
      ? `@${reference.host}`
      : "";
  const directory = level === "name" ? "" : `:${reference.directory}`;
  return `${reference.name}${host}${directory}`;
}

/**
 * The most detailed level that fits the columns available, or `undefined` when
 * even the name does not.
 *
 * This is the whole reason the levels are data rather than three call sites
 * choosing between two strings. A one row chrome and "several levels of
 * verbosity" are the same problem, so the caller says how much room it has and
 * gets back the most it can show.
 */
export function fitWorkspaceReference(
  reference: WorkspaceReference,
  columns: number,
): string | undefined {
  for (const level of WORKSPACE_REFERENCE_LEVELS) {
    const text = formatWorkspaceReference(reference, level);
    if (text.length <= columns) return text;
  }
  return undefined;
}
