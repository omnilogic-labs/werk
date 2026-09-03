// The loopback TCP landing, as an experiment beside the socket rather than
// instead of it.
//
// The daemon's transport is the `AF_UNIX` socket in its runtime directory
// and nothing here changes that: this listener exists only when
// `WP_TCP_LISTEN` asks for it, and the socket is still the way in. Two
// questions need it. Win32-OpenSSH forwards no Unix socket and no named
// pipe on either side, so a Windows client of a remote daemon has nowhere
// to land a forward but a loopback TCP port; and
// `docs/proposals/01-cross-platform.md` §10 leaves open whether the Windows
// daemon's own socket should be `AF_UNIX` or loopback TCP, which is a
// question about numbers that only exist if both can be measured.
//
// A TCP port has no filesystem permissions, so what stands in for the
// socket's 0600 is a token: the daemon writes the port and a random token
// to `wp.tcp` in its runtime directory — which is already this user's alone
// on both POSIX (0700) and Windows (`%LOCALAPPDATA%`) — and a connection
// arriving over TCP has to name the token in its `hello` or be closed. The
// token is what a client copies to the machine it connects from; nothing
// here is a claim that a token in a file is the right design.

import fs from "node:fs";
import path from "node:path";

/** Where the port and token live, beside the socket. */
export const TOKEN_FILE = "wp.tcp";

export interface TcpToken {
  port: number;
  token: string;
}

/**
 * The port `WP_TCP_LISTEN` asks the daemon to listen on: `1` (or any
 * non-numeric truthy value) for an ephemeral one, a number for that port,
 * and null when the variable is absent or empty, which is the default.
 */
export function tcpListenPort(
  env: Record<string, string | undefined> = process.env,
): number | null {
  const raw = env.WP_TCP_LISTEN;
  if (raw === undefined || raw === "" || raw === "0") return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 1 && n < 65536 ? n : 0;
}

export function tokenPath(dir: string): string {
  return path.join(dir, TOKEN_FILE);
}

/** Writes `<port> <token>` beside the socket; returns the file's path. */
export function writeToken(dir: string, t: TcpToken): string {
  const file = tokenPath(dir);
  fs.writeFileSync(file, `${t.port} ${t.token}\n`, { mode: 0o600 });
  return file;
}

/** Reads a token file written by `writeToken`; throws if it says anything else. */
export function readToken(file: string): TcpToken {
  const [port, token] = fs.readFileSync(file, "utf8").trim().split(/\s+/);
  const n = Number(port);
  if (!Number.isInteger(n) || !token)
    throw new Error(`${file} is not a port and a token`);
  return { port: n, token };
}

/** A random token; hex, so it survives every quoting a shell might do to it. */
export function newToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

export type SocketTarget =
  | { kind: "unix"; path: string }
  | { kind: "tcp"; hostname: string; port: number };

/**
 * What a `--socket` string names. `tcp:<host>:<port>` is the loopback
 * landing — the local end of an `ssh -L` forward, say; anything else is a
 * filesystem path, which is what it has always been.
 */
export function parseSocketTarget(spec: string): SocketTarget {
  if (!spec.startsWith("tcp:")) return { kind: "unix", path: spec };
  const rest = spec.slice(4).replace(/^\/\//, "");
  const at = rest.lastIndexOf(":");
  const hostname = at > 0 ? rest.slice(0, at) : "127.0.0.1";
  const port = Number(at > 0 ? rest.slice(at + 1) : rest);
  if (!Number.isInteger(port) || port <= 0 || port >= 65536)
    throw new Error(`${spec} is not tcp:<host>:<port>`);
  return { kind: "tcp", hostname, port };
}

/** The token a client presents, from `WP_TOKEN` unless one is passed. */
export function clientToken(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  return env.WP_TOKEN || undefined;
}
