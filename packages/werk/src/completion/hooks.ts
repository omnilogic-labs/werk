/**
 * Where a parameter says how to complete itself.
 *
 * Commander describes the shape of the tree — which commands exist, which flags
 * they take, what the positionals are called — but it has no notion of a value
 * provider, and none of the JS completion libraries can await one anyway. So the
 * providers hang off the real `Argument` and `Option` objects in a `WeakMap`.
 *
 * Keying on the object rather than on a name is what stops this becoming a second
 * tree that drifts from the first: a provider can only be registered against a
 * parameter that actually exists, and it disappears with it.
 */
import type { Argument, Option } from "@commander-js/extra-typings";
import type { Host } from "../config/hosts.js";

export interface CompletionContext {
  runtimeDir: string;
  stateDir: string;
  /**
   * The hosts in force, when the layers answered in time. Absent is a
   * completion that fell back to the flags alone, not a machine with no hosts.
   */
  hosts?: Readonly<Record<string, Host>>;
  /**
   * Where workspaces go on the machine this line would act on, when the
   * configuration says. `placeFromConfig` settles it without reaching anything,
   * so an ssh host that has not written its `workspaceRoot` down leaves it
   * absent rather than making a TAB ssh for it.
   */
  root?: string;
  /**
   * The machine those paths are on, absent for this one. It decides the path
   * grammar `workspaceAt` reads them with, so it travels with `root` or not at
   * all.
   */
  reference?: string;
}
export type CandidateProvider = (
  partial: string,
  ctx: CompletionContext,
) => Promise<readonly Candidate[]> | readonly Candidate[];
export interface Candidate {
  value: string;
  description?: string;
}

const providers = new WeakMap<object, CandidateProvider>();

/** Attach a provider to a parameter and hand the parameter back for chaining. */
export function completes<T extends Argument | Option>(
  parameter: T,
  provider: CandidateProvider,
): T {
  providers.set(parameter, provider);
  return parameter;
}
export function providerFor(
  parameter: object | undefined,
): CandidateProvider | undefined {
  return parameter ? providers.get(parameter) : undefined;
}
