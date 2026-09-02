// Socket buffer sizes for the daemon's listening socket. XNU gives a unix
// stream socket 8 KiB each way (`net.local.stream.sendspace`) against
// Linux's 208 KiB, and it is the sender's SO_SNDBUF on the accepted socket
// that bounds how much the daemon can write before a short write — so a
// slow client on macOS trips the queue bound after about 8 KB where Linux
// manages about 218 KB. Accepted sockets inherit the listener's buffers,
// and `Bun.listen` exposes the listener's fd, so one setsockopt(2) before
// the first accept is enough. Best effort: a failure is logged, not fatal.

import { dlopen, FFIType, ptr } from "bun:ffi";

const SOL_SOCKET = 0xffff;
const SO_SNDBUF = 0x1001;
const SO_RCVBUF = 0x1002;

/** Linux's default `net.core.wmem_default`, the figure the finding compares against. */
const DEFAULT_DARWIN_BYTES = 212992;

/**
 * How many bytes to ask for, or null to leave the kernel default alone.
 * `WP_SNDBUF=0` in the daemon's environment switches it off; any other
 * value overrides the size. Only macOS has a default; elsewhere the kernel's
 * own figure is already large enough.
 */
export function configuredSocketBuffer(): number | null {
  const raw = process.env.WP_SNDBUF;
  if (raw !== undefined && raw !== "") {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
  }
  return process.platform === "darwin" ? DEFAULT_DARWIN_BYTES : null;
}

let libc:
  | {
      symbols: {
        setsockopt: (
          fd: number,
          level: number,
          name: number,
          val: number,
          len: number,
        ) => number;
        getsockopt: (
          fd: number,
          level: number,
          name: number,
          val: number,
          len: number,
        ) => number;
      };
    }
  | undefined;

function loadLibc() {
  if (libc) return libc;
  const candidates =
    process.platform === "darwin"
      ? ["libSystem.B.dylib", "libc.dylib"]
      : ["libc.so.6", "libc.so"];
  let last: unknown;
  for (const name of candidates) {
    try {
      libc = dlopen(name, {
        setsockopt: {
          args: [
            FFIType.i32,
            FFIType.i32,
            FFIType.i32,
            FFIType.ptr,
            FFIType.u32,
          ],
          returns: FFIType.i32,
        },
        getsockopt: {
          args: [
            FFIType.i32,
            FFIType.i32,
            FFIType.i32,
            FFIType.ptr,
            FFIType.ptr,
          ],
          returns: FFIType.i32,
        },
      });
      return libc;
    } catch (e) {
      last = e;
    }
  }
  throw new Error(`cannot dlopen libc for setsockopt: ${String(last)}`);
}

function getBuf(fd: number, name: number): number {
  const val = new Int32Array(1);
  const len = new Uint32Array([4]);
  const rc = loadLibc().symbols.getsockopt(
    fd,
    SOL_SOCKET,
    name,
    ptr(val),
    ptr(len),
  );
  return rc === 0 ? val[0]! : -1;
}

/**
 * Sets SO_SNDBUF and SO_RCVBUF on `fd` to `bytes`. Returns a one-line
 * account of what the kernel reports afterwards; throws when a call fails.
 */
export function setSocketBuffers(fd: number, bytes: number): string {
  const lib = loadLibc();
  const val = new Int32Array([bytes]);
  for (const [label, name] of [
    ["SO_SNDBUF", SO_SNDBUF],
    ["SO_RCVBUF", SO_RCVBUF],
  ] as const) {
    if (lib.symbols.setsockopt(fd, SOL_SOCKET, name, ptr(val), 4) !== 0)
      throw new Error(`setsockopt(${label}, ${bytes}) failed`);
  }
  return `sndbuf=${getBuf(fd, SO_SNDBUF)} rcvbuf=${getBuf(fd, SO_RCVBUF)}`;
}
