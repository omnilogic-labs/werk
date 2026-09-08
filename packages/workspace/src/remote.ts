/**
 * Running something on a machine that is not this one, as one injectable
 * function.
 *
 * This package knows nothing about ssh, and is meant to keep knowing nothing:
 * it imports `node:*` and nothing else, so a browser-side or a
 * differently-transported caller can use the same maker. Everything that
 * actually reaches a machine — the ssh binary, its flags, a control master, a
 * connection pool, a container exec — is built by whoever constructs the maker
 * and handed in here.
 *
 * The shape is deliberately `GitRunner`'s: a call that resolves for anything the
 * far end decided, and rejects only when the call could not be made at all. That
 * symmetry is what lets one file classify a local git refusal and a remote
 * script's refusal with the same reasoning.
 */
import type { GitResult } from "./git.js";

/**
 * Run a script on the far machine. Deliberately the shape of `GitRunner`.
 *
 * `script` is a POSIX shell script, run as one unit. A rejection means the
 * machine could not be reached or the transport itself broke, which the caller
 * reads as `HOST_UNREACHABLE`; a resolved non-zero result means the script ran
 * and said no, which the caller reads from the exit code.
 */
export type RemoteRunner = (
  script: string,
  options?: { readonly timeoutMs?: number },
) => Promise<GitResult>;
