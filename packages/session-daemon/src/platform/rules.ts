/**
 * Platform questions asked as pure functions, so a test can put any value to
 * them wherever it happens to run.
 */

/**
 * The portable limit on a Unix socket path is 103 bytes, and a path that exceeds
 * it fails at bind rather than at connect.
 */
export function socketPathTooLong(socket: string): boolean {
  return Buffer.byteLength(socket) > 103;
}

/** Whether a local endpoint's owner and mode leave it reachable by anyone else. */
export function notPrivateToOwner(
  stat: { uid: number; mode: number },
  uid: number | undefined = process.getuid?.(),
): boolean {
  return stat.uid !== uid || (stat.mode & 0o077) !== 0;
}
