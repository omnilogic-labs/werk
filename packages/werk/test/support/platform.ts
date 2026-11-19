/**
 * What the suite asks of the platform it runs on, in one place.
 *
 * ## Windows runs the client
 *
 * On Windows werk is a client. The owner's ruling is that Windows does not need
 * a local daemon, a supervisor, a PTY or a session host, only the client: the
 * CLI's parsing, help, config, themes and output, the workspace and ssh code
 * that builds commands for another machine, and the session protocol. So a test
 * that starts, ensures or talks to a local daemon runs on Linux and macOS and
 * is skipped on Windows, and `daemonTest` is how a test says it is one of those.
 * A file whose every test is daemon-side, or that makes this machine the far
 * end of an ssh connection, is left out of the Windows lane by
 * `bun run test:client` instead; `docs/ci.md` lists them and says why.
 *
 * ## A short temporary root
 *
 * A Unix socket path is capped at 103 bytes and the daemon binds one inside the
 * runtime directory, so on Linux and macOS a sandbox lives directly under
 * `/tmp`. macOS's own temporary directory is a long `/var/folders/...` path
 * reached through a symbolic link, which is why `os.tmpdir()` is not used
 * there. Windows has no `/tmp` at all, and no daemon socket to keep short, so it
 * uses its own temporary directory.
 */
import { test } from "bun:test";
import { tmpdir } from "node:os";

/** Whether this run is a client-only one, which today means Windows. */
export const clientOnly = process.platform === "win32";

/** A test of daemon, supervisor, PTY or session-host behaviour. */
export const daemonTest = test.skipIf(clientOnly);

/**
 * A test that acts on the `local` host. A client-only platform has no such
 * host and refuses every command that would act on it, so these run on Linux
 * and macOS, and the refusal itself is what Windows tests instead.
 */
export const localHostTest = test.skipIf(clientOnly);

/** A test of what only a client-only platform does. */
export const clientOnlyTest = test.skipIf(!clientOnly);

/** Where a short-lived temporary directory goes. */
export const shortTempRoot = clientOnly ? tmpdir() : "/tmp";
