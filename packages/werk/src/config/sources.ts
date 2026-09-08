/**
 * Configuration that does not come from this machine.
 *
 * A portal is expected to supply some of a client's configuration once that
 * client registers with it, but which settings it takes over, what happens to
 * settings the client already had, how a person sees what has been taken over,
 * and whether anything stays theirs to change are all unresolved — that is open
 * question 12 of `docs/open-questions.md`, which says it is the least worked out
 * part of the whole specification.
 *
 * So this is a seam, not a design. It fixes only two things: the shape an answer
 * would have, and where it would sit in the precedence order — above werk's
 * built-in defaults and below anything the person typed or wrote in a file.
 * Nothing implements it, and `werk config sources` reports it as unconfigured.
 */
import type { WerkConfig } from "./schema.js";

/** How a config file names a fragment this source would supply. */
export const REMOTE_PREFIX = "werk-remote:";

export interface ConfigSource {
  readonly name: string;
  /** False until something has been registered; `config sources` says so. */
  readonly configured: boolean;
  /** The whole layer this source contributes, or null when it has none. */
  load(): Promise<Partial<WerkConfig> | null>;
  /** One named fragment, for a file that extends `werk-remote:<id>`. */
  get(id: string): Promise<Partial<WerkConfig> | null>;
}

/**
 * The source werk runs with today. It answers nothing to everything, which is
 * what makes the remote layer invisible until there is something behind it.
 */
export const unconfiguredSource: ConfigSource = {
  name: "remote",
  configured: false,
  async load() {
    return null;
  },
  async get() {
    return null;
  },
};
