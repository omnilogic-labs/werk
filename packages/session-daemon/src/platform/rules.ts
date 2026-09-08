/**
 * Platform questions asked as pure functions that take the platform rather than
 * reading it. Both answers are then reachable wherever the tests happen to run,
 * which is the only way the Windows answer gets exercised on a Linux machine.
 */

/**
 * The portable limit on a Unix socket path is 103 bytes, and a path that exceeds
 * it fails at bind rather than at connect. Windows carries the endpoint on a
 * loopback port instead, so nothing there is measured.
 */
export function socketPathTooLong(
  socket: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform !== "win32" && Buffer.byteLength(socket) > 103;
}

/**
 * Whether a local endpoint's owner and mode leave it reachable by anyone else.
 * On Windows the same guarantee comes from the ACL applied when the directory is
 * created, and a stat carries neither a meaningful uid nor permission bits, so
 * there is nothing there to read.
 */
export function notPrivateToOwner(
  stat: { uid: number; mode: number },
  platform: NodeJS.Platform = process.platform,
  uid: number | undefined = process.getuid?.(),
): boolean {
  if (platform === "win32") return false;
  return stat.uid !== uid || (stat.mode & 0o077) !== 0;
}
