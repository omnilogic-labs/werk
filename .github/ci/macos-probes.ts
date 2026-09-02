// Direct probes of two macOS questions the werk proof of concept raised:
// whether anything short of a sysctl can move the 8 KiB unix-socket
// short-write threshold (findings/platforms.md, "Back-pressure"), and what
// signing state a fresh `bun build --compile` binary is in. Each probe prints
// one `PROBE <name>: <verdict>` line and never throws, so one run answers
// every question at once. Run from the repository root, after
// `bun run build` in packages/werk-poc for the codesign probe:
//
//   bun run .github/ci/macos-probes.ts [probe ...]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const probes = process.argv.slice(2);
const want = (name: string) => probes.length === 0 || probes.includes(name);

function say(name: string, verdict: string): void {
  console.log(`PROBE ${name}: ${verdict}`);
}

function firstLine(e: unknown): string {
  const s = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return s.split("\n")[0]!.trim();
}

async function sh(cmd: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return { code: proc.exitCode ?? -1, out: (out + err).trim() };
}

const CHUNK = 64 * 1024;
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wp-macos-probes-"));
let sockSeq = 0;
const sockPath = () => path.join(tmpRoot, `s${++sockSeq}.sock`);

console.log(
  `platform=${process.platform} arch=${process.arch} bun=${Bun.version} release=${os.release()} tmp=${tmpRoot}`,
);

// ---------------------------------------------------------------- sysctl
if (want("sysctl")) {
  const keys = [
    "net.local.stream.sendspace",
    "net.local.stream.recvspace",
    "kern.ipc.maxsockbuf",
    "hw.ncpu",
    "hw.optional.avx2_0",
  ];
  const parts: string[] = [];
  for (const k of keys) {
    const r = await sh(["sysctl", "-n", k]);
    parts.push(
      `${k}=${r.code === 0 ? r.out || "(absent)" : `(${r.out || `exit ${r.code}`})`}`,
    );
  }
  say("sysctl", parts.join(" "));
}

// ------------------------------------------------ short-write threshold
// A Bun.listen server whose accepted socket is written to in one
// synchronous burst. Nothing else runs on this event loop during the burst,
// so the client cannot read even when it is a Bun.connect socket with a data
// handler: the bytes the kernel accepts are exactly the in-flight capacity
// between the two sockets.

type ServerSock = {
  write: (b: Uint8Array) => number;
  end: () => void;
  fd?: unknown;
};
type Listener = { stop: (force?: boolean) => void; fd?: unknown };

function listenAndTakeOne(addr: string): {
  listener: Listener;
  accepted: Promise<ServerSock>;
} {
  let resolve!: (s: ServerSock) => void;
  const accepted = new Promise<ServerSock>((r) => (resolve = r));
  const listener: Listener = Bun.listen<undefined>({
    unix: addr,
    socket: {
      open(socket) {
        resolve(socket as unknown as ServerSock);
      },
      data() {},
      drain() {},
      error() {},
      close() {},
    },
  });
  return { listener, accepted };
}

function floodUntilShort(sock: ServerSock): {
  accepted: number;
  writes: number;
  lastReturn: number;
} {
  const chunk = new Uint8Array(CHUNK).fill(0x78);
  let accepted = 0;
  let writes = 0;
  for (;;) {
    const n = sock.write(chunk);
    writes++;
    if (n < 0) return { accepted, writes, lastReturn: n };
    accepted += n;
    if (n < CHUNK) return { accepted, writes, lastReturn: n };
    if (accepted > 64 * 1024 * 1024) return { accepted, writes, lastReturn: n }; // the client is reading after all
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number, what: string) {
  let t: ReturnType<typeof setTimeout>;
  const timer = new Promise<never>((_, rej) => {
    t = setTimeout(
      () => rej(new Error(`${what} timed out after ${ms} ms`)),
      ms,
    );
  });
  try {
    return await Promise.race([p, timer]);
  } finally {
    clearTimeout(t!);
  }
}

if (want("short-write-threshold")) {
  const addr = sockPath();
  let listener: { stop: (force?: boolean) => void } | undefined;
  try {
    const l = listenAndTakeOne(addr);
    listener = l.listener;
    let clientReads = 0;
    const client = await withTimeout(
      Bun.connect<undefined>({
        unix: addr,
        socket: {
          data(_s, chunk) {
            clientReads += chunk.length;
          },
          error() {},
          close() {},
        },
      }),
      5000,
      "connect",
    );
    const server = await withTimeout(l.accepted, 5000, "accept");
    const r = floodUntilShort(server);
    say(
      "short-write-threshold",
      `${r.accepted} B accepted before the first short write (${r.writes} writes of ${CHUNK} B, last returned ${r.lastReturn}; client had read ${clientReads} B at that point)`,
    );
    client.end();
    server.end();
  } catch (e) {
    say("short-write-threshold", `fail — ${firstLine(e)}`);
  } finally {
    try {
      listener?.stop(true);
    } catch {}
  }
}

// -------------------------------------------------------- bun:ffi sockets
// The client end built by hand through libSystem so its buffers can be set
// before connect(2). darwin's sockaddr_un is { u8 sun_len; u8 sun_family;
// char sun_path[104] }.

const AF_UNIX = 1;
const SOCK_STREAM = 1;
const SOL_SOCKET = 0xffff;
const SO_SNDBUF = 0x1001;
const SO_RCVBUF = 0x1002;
const SUN_PATH_LEN = 104;
const SOCKADDR_UN_LEN = 2 + SUN_PATH_LEN;

type Libc = {
  socket: (d: number, t: number, p: number) => number;
  setsockopt: (
    fd: number,
    level: number,
    name: number,
    val: unknown,
    len: number,
  ) => number;
  getsockopt: (
    fd: number,
    level: number,
    name: number,
    val: unknown,
    len: unknown,
  ) => number;
  connect: (fd: number, addr: unknown, len: number) => number;
  bind: (fd: number, addr: unknown, len: number) => number;
  listen: (fd: number, backlog: number) => number;
  close: (fd: number) => number;
  __error: () => unknown;
};

let ffi:
  | {
      libc: Libc;
      ptr: (b: ArrayBufferView) => unknown;
      readI32: (p: unknown, off?: number) => number;
    }
  | undefined;

async function loadLibc(): Promise<typeof ffi> {
  if (ffi) return ffi;
  const { dlopen, FFIType, ptr, read } = await import("bun:ffi");
  const lib = dlopen("libSystem.B.dylib", {
    socket: {
      args: [FFIType.i32, FFIType.i32, FFIType.i32],
      returns: FFIType.i32,
    },
    setsockopt: {
      args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.u32],
      returns: FFIType.i32,
    },
    getsockopt: {
      args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
    connect: {
      args: [FFIType.i32, FFIType.ptr, FFIType.u32],
      returns: FFIType.i32,
    },
    bind: {
      args: [FFIType.i32, FFIType.ptr, FFIType.u32],
      returns: FFIType.i32,
    },
    listen: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    close: { args: [FFIType.i32], returns: FFIType.i32 },
    __error: { args: [], returns: FFIType.ptr },
  });
  ffi = {
    libc: lib.symbols as unknown as Libc,
    ptr: (b) => ptr(b as unknown as Uint8Array),
    readI32: (p, off = 0) => read.i32(p as number, off),
  };
  return ffi;
}

function errno(): number {
  try {
    return ffi!.readI32(ffi!.libc.__error());
  } catch {
    return -1;
  }
}

function sockaddrUn(p: string): Uint8Array {
  const b = new Uint8Array(SOCKADDR_UN_LEN);
  const bytes = new TextEncoder().encode(p);
  if (bytes.length >= SUN_PATH_LEN) throw new Error(`path too long: ${p}`);
  b[0] = SOCKADDR_UN_LEN;
  b[1] = AF_UNIX;
  b.set(bytes, 2);
  return b;
}

function getBuf(fd: number, name: number): number {
  const val = new Int32Array(1);
  const len = new Uint32Array([4]);
  const rc = ffi!.libc.getsockopt(
    fd,
    SOL_SOCKET,
    name,
    ffi!.ptr(val),
    ffi!.ptr(len),
  );
  return rc === 0 ? val[0]! : -errno();
}

function setBuf(fd: number, name: number, bytes: number): string {
  const val = new Int32Array([bytes]);
  const rc = ffi!.libc.setsockopt(fd, SOL_SOCKET, name, ffi!.ptr(val), 4);
  return rc === 0 ? `ok` : `errno ${errno()}`;
}

/** Threshold with a hand-built client fd that nothing ever reads from. */
async function thresholdWithFfiClient(
  configure: (fd: number) => string,
): Promise<string> {
  const f = await loadLibc();
  const addr = sockPath();
  const l = listenAndTakeOne(addr);
  const fd = f.libc.socket(AF_UNIX, SOCK_STREAM, 0);
  try {
    if (fd < 0) return `socket() failed, errno ${errno()}`;
    const before = `rcvbuf=${getBuf(fd, SO_RCVBUF)} sndbuf=${getBuf(fd, SO_SNDBUF)}`;
    const conf = configure(fd);
    const after = `rcvbuf=${getBuf(fd, SO_RCVBUF)} sndbuf=${getBuf(fd, SO_SNDBUF)}`;
    const sa = sockaddrUn(addr);
    const rc = f.libc.connect(fd, f.ptr(sa), SOCKADDR_UN_LEN);
    if (rc !== 0) return `connect() failed, errno ${errno()} (${conf})`;
    const server = await withTimeout(l.accepted, 5000, "accept");
    const r = floodUntilShort(server);
    server.end();
    return `${r.accepted} B accepted before the first short write (client fd ${before} -> ${conf} -> ${after})`;
  } finally {
    if (fd >= 0) f.libc.close(fd);
    try {
      l.listener.stop(true);
    } catch {}
  }
}

if (want("ffi-client-rcvbuf")) {
  try {
    say("ffi-client-control", await thresholdWithFfiClient(() => "untouched"));
  } catch (e) {
    say("ffi-client-control", `fail — ${firstLine(e)}`);
  }
  try {
    say(
      "ffi-client-rcvbuf",
      await thresholdWithFfiClient(
        (fd) => `SO_RCVBUF=212992 ${setBuf(fd, SO_RCVBUF, 212992)}`,
      ),
    );
  } catch (e) {
    say("ffi-client-rcvbuf", `fail — ${firstLine(e)}`);
  }
  try {
    say(
      "ffi-client-both",
      await thresholdWithFfiClient(
        (fd) =>
          `SO_RCVBUF=212992 ${setBuf(fd, SO_RCVBUF, 212992)}, SO_SNDBUF=212992 ${setBuf(fd, SO_SNDBUF, 212992)}`,
      ),
    );
  } catch (e) {
    say("ffi-client-both", `fail — ${firstLine(e)}`);
  }

  // Does Bun adopt an already-connected descriptor? Connect by hand with a
  // raised SO_RCVBUF, hand the fd to Bun.connect, and see whether `open`
  // fires and a byte round-trips through the server's echo.
  const f = await loadLibc();
  const addr = sockPath();
  let listener: { stop: (force?: boolean) => void } | undefined;
  let fd = -1;
  try {
    listener = Bun.listen<undefined>({
      unix: addr,
      socket: {
        data(socket, chunk) {
          socket.write(chunk);
        },
        open() {},
        error() {},
        close() {},
      },
    });
    fd = f.libc.socket(AF_UNIX, SOCK_STREAM, 0);
    const set = setBuf(fd, SO_RCVBUF, 212992);
    const sa = sockaddrUn(addr);
    if (f.libc.connect(fd, f.ptr(sa), SOCKADDR_UN_LEN) !== 0)
      throw new Error(`connect() failed, errno ${errno()}`);
    const events: string[] = [];
    let echoed = "";
    let rcvAtOpen = -1;
    const opened = await withTimeout(
      new Promise<string>((resolve, reject) => {
        Bun.connect<undefined>({
          // @ts-expect-error `fd` is not in the typed options; probing it
          fd,
          socket: {
            open(socket) {
              events.push("open");
              rcvAtOpen = getBuf(fd, SO_RCVBUF);
              socket.write("ping");
            },
            data(socket, chunk) {
              echoed += new TextDecoder().decode(chunk);
              events.push(`data:${chunk.length}`);
              socket.end();
            },
            close() {
              events.push("close");
              resolve(events.join(","));
            },
            error(_s, e) {
              reject(e);
            },
            connectError(_s, e) {
              reject(e);
            },
          },
        }).catch(reject);
      }),
      5000,
      "Bun.connect({fd})",
    );
    say(
      "ffi-client-adopt-fd",
      `Bun.connect({fd}) ${echoed === "ping" ? "ok — accepted the connected fd and round-tripped" : "opened but did not round-trip"}: events ${opened}, echoed ${JSON.stringify(echoed)}; rcvbuf on that fd at open ${rcvAtOpen}, after close ${getBuf(fd, SO_RCVBUF)} (setsockopt ${set})`,
    );
  } catch (e) {
    say("ffi-client-adopt-fd", `fail — ${firstLine(e)}`);
  } finally {
    try {
      listener?.stop(true);
    } catch {}
  }
}

// ---------------------------------------------------- server-side options
if (want("ffi-server-sndbuf")) {
  const addr = sockPath();
  let listener: unknown;
  try {
    listener = Bun.listen<undefined>({
      unix: addr,
      socket: { data() {}, open() {}, error() {}, close() {} },
    });
    const l = listener as Record<string, unknown>;
    const own = Object.keys(l);
    const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(l));
    const fdLike = ["fd", "_fd", "handle", "_handle", "socket"]
      .map(
        (k) =>
          `${k}=${typeof l[k]}${l[k] === undefined ? "" : `(${String(l[k])})`}`,
      )
      .join(" ");
    say(
      "listener-shape",
      `${(l.constructor as { name?: string })?.name ?? "?"} own keys [${own.join(",")}] proto [${proto.join(",")}] ${fdLike}`,
    );
  } catch (e) {
    say("listener-shape", `fail — ${firstLine(e)}`);
  } finally {
    try {
      (listener as { stop: (f?: boolean) => void } | undefined)?.stop(true);
    } catch {}
  }

  // A listening socket built by hand with SO_SNDBUF raised, offered to
  // Bun.listen as `fd`.
  const f = await loadLibc();
  const addr2 = sockPath();
  let fd = -1;
  try {
    fd = f.libc.socket(AF_UNIX, SOCK_STREAM, 0);
    const set = `SO_SNDBUF ${setBuf(fd, SO_SNDBUF, 212992)}, SO_RCVBUF ${setBuf(fd, SO_RCVBUF, 212992)}`;
    const sa = sockaddrUn(addr2);
    if (f.libc.bind(fd, f.ptr(sa), SOCKADDR_UN_LEN) !== 0)
      throw new Error(`bind() failed, errno ${errno()}`);
    if (f.libc.listen(fd, 16) !== 0)
      throw new Error(`listen() failed, errno ${errno()}`);
    let verdict: string;
    let l: { stop: (f?: boolean) => void } | undefined;
    try {
      l = Bun.listen<undefined>({
        // @ts-expect-error `fd` is not in the typed options; probing it
        fd,
        socket: { data() {}, open() {}, error() {}, close() {} },
      });
      // If it did not throw, does it actually serve this socket?
      let accepted = false;
      try {
        await withTimeout(
          Bun.connect<undefined>({
            unix: addr2,
            socket: {
              open(s) {
                accepted = true;
                s.end();
              },
              data() {},
              error() {},
              close() {},
            },
          }),
          3000,
          "connect to ffi listener",
        );
      } catch {}
      verdict = `Bun.listen({fd}) returned ${(l as unknown as { constructor: { name: string } }).constructor?.name}; a connect to the hand-made socket ${accepted ? "was accepted" : "was not accepted"} (hand-made listener ${set})`;
    } catch (e) {
      verdict = `no path — Bun.listen({fd}) rejected: ${firstLine(e)} (hand-made listener ${set})`;
    } finally {
      try {
        l?.stop(true);
      } catch {}
    }
    say("ffi-server-sndbuf", verdict);
  } catch (e) {
    say("ffi-server-sndbuf", `fail — ${firstLine(e)}`);
  } finally {
    if (fd >= 0) f.libc.close(fd);
  }

  // The listener object does carry `fd`. Raise the buffers on it before the
  // first connect and see what the accepted socket inherits, with a plain
  // Bun.connect client and with a hand-built client whose SO_RCVBUF is
  // raised too. The answer is the number the daemon could reach without any
  // change to Bun.
  async function thresholdWithListenerFd(
    configureListener: (fd: number) => string,
    client: "bun" | "ffi-rcvbuf",
  ): Promise<string> {
    const addr = sockPath();
    const l = listenAndTakeOne(addr);
    let cfd = -1;
    let bunClient: { end: () => void } | undefined;
    try {
      const lfd = l.listener.fd;
      if (typeof lfd !== "number") return `listener.fd is ${typeof lfd}`;
      const before = `sndbuf=${getBuf(lfd, SO_SNDBUF)} rcvbuf=${getBuf(lfd, SO_RCVBUF)}`;
      const conf = configureListener(lfd);
      const after = `sndbuf=${getBuf(lfd, SO_SNDBUF)} rcvbuf=${getBuf(lfd, SO_RCVBUF)}`;
      let clientNote: string;
      if (client === "bun") {
        bunClient = await withTimeout(
          Bun.connect<undefined>({
            unix: addr,
            socket: { data() {}, error() {}, close() {} },
          }),
          5000,
          "connect",
        );
        clientNote = "Bun.connect client";
      } else {
        cfd = f.libc.socket(AF_UNIX, SOCK_STREAM, 0);
        const s = setBuf(cfd, SO_RCVBUF, 212992);
        const sa = sockaddrUn(addr);
        if (f.libc.connect(cfd, f.ptr(sa), SOCKADDR_UN_LEN) !== 0)
          return `connect() failed, errno ${errno()}`;
        clientNote = `ffi client SO_RCVBUF=212992 ${s}`;
      }
      const server = await withTimeout(l.accepted, 5000, "accept");
      const sfd = server.fd;
      const inherited =
        typeof sfd === "number"
          ? `accepted fd ${sfd} sndbuf=${getBuf(sfd, SO_SNDBUF)} rcvbuf=${getBuf(sfd, SO_RCVBUF)}`
          : `accepted socket fd is ${typeof sfd}`;
      const r = floodUntilShort(server);
      server.end();
      return `${r.accepted} B accepted before the first short write (listener fd ${lfd} ${before} -> ${conf} -> ${after}; ${inherited}; ${clientNote})`;
    } finally {
      if (cfd >= 0) f.libc.close(cfd);
      try {
        bunClient?.end();
      } catch {}
      try {
        l.listener.stop(true);
      } catch {}
    }
  }

  for (const [name, configure, client] of [
    [
      "listener-fd-sndbuf",
      (fd: number) => `SO_SNDBUF=212992 ${setBuf(fd, SO_SNDBUF, 212992)}`,
      "bun",
    ],
    [
      "listener-fd-both",
      (fd: number) =>
        `SO_SNDBUF=212992 ${setBuf(fd, SO_SNDBUF, 212992)}, SO_RCVBUF=212992 ${setBuf(fd, SO_RCVBUF, 212992)}`,
      "bun",
    ],
    [
      "listener-fd-both-client-rcvbuf",
      (fd: number) =>
        `SO_SNDBUF=212992 ${setBuf(fd, SO_SNDBUF, 212992)}, SO_RCVBUF=212992 ${setBuf(fd, SO_RCVBUF, 212992)}`,
      "ffi-rcvbuf",
    ],
  ] as const) {
    try {
      say(name, await thresholdWithListenerFd(configure, client));
    } catch (e) {
      say(name, `fail — ${firstLine(e)}`);
    }
  }

  // And after accept: if the accepted socket carries an fd of its own,
  // setsockopt on that, with the listener untouched.
  {
    const addr = sockPath();
    const l = listenAndTakeOne(addr);
    let bunClient: { end: () => void } | undefined;
    try {
      bunClient = await withTimeout(
        Bun.connect<undefined>({
          unix: addr,
          socket: { data() {}, error() {}, close() {} },
        }),
        5000,
        "connect",
      );
      const server = await withTimeout(l.accepted, 5000, "accept");
      const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(server));
      const sfd = server.fd;
      if (typeof sfd !== "number") {
        say(
          "setsockopt-after-accept",
          `no path — the accepted socket has no numeric fd (fd is ${typeof sfd}; proto [${proto.join(",")}])`,
        );
      } else {
        const set = `SO_SNDBUF=212992 ${setBuf(sfd, SO_SNDBUF, 212992)}, SO_RCVBUF=212992 ${setBuf(sfd, SO_RCVBUF, 212992)}`;
        const r = floodUntilShort(server);
        say(
          "setsockopt-after-accept",
          `${r.accepted} B accepted before the first short write (accepted fd ${sfd}: ${set} -> sndbuf=${getBuf(sfd, SO_SNDBUF)} rcvbuf=${getBuf(sfd, SO_RCVBUF)}; Bun.connect client; accepted-socket proto [${proto.join(",")}])`,
        );
      }
      server.end();
    } catch (e) {
      say("setsockopt-after-accept", `fail — ${firstLine(e)}`);
    } finally {
      try {
        bunClient?.end();
      } catch {}
      try {
        l.listener.stop(true);
      } catch {}
    }
  }
}

// --------------------------------------------------------------- codesign
if (want("codesign")) {
  const poc = path.resolve(import.meta.dir, "../../packages/werk-poc");
  const wp = path.join(poc, "dist/wp");
  if (!fs.existsSync(wp)) {
    say(
      "codesign",
      `no binary — ${wp} does not exist (did the build step run?)`,
    );
  } else {
    const dvv = await sh(["codesign", "-dvv", wp]);
    const flags =
      dvv.out.split("\n").find((l) => l.startsWith("CodeDirectory")) ??
      dvv.out.split("\n")[0] ??
      "";
    const sig =
      dvv.out.split("\n").find((l) => /^(Signature|Authority)/.test(l)) ?? "";
    say(
      "codesign-dvv",
      `exit ${dvv.code}; ${flags}${sig ? `; ${sig}` : ""}${dvv.code !== 0 ? `; ${dvv.out.split("\n")[0]}` : ""}`,
    );
    const verify = await sh([
      "codesign",
      "--verify",
      "--strict",
      "--verbose=2",
      wp,
    ]);
    say(
      "codesign-verify",
      `exit ${verify.code}; ${verify.out.replace(/\n/g, " | ").slice(0, 300)}`,
    );
    const lax = await sh(["codesign", "--verify", "--verbose=2", wp]);
    say(
      "codesign-verify-lax",
      `exit ${lax.code}; ${lax.out.replace(/\n/g, " | ").slice(0, 300)}`,
    );
    const xattr = await sh(["xattr", "-l", wp]);
    say(
      "codesign-xattr",
      xattr.out ? xattr.out.replace(/\n/g, " | ") : "no extended attributes",
    );
    const spctl = await sh([
      "spctl",
      "--assess",
      "--type",
      "execute",
      "-vv",
      wp,
    ]);
    say(
      "codesign-spctl",
      `exit ${spctl.code}; ${spctl.out.replace(/\n/g, " | ").slice(0, 300)}`,
    );
    const runs = await sh([wp, "--help"]);
    say(
      "codesign-runs",
      `./dist/wp --help exit ${runs.code}, ${runs.out.split("\n").length} lines`,
    );

    // What an ad-hoc re-sign does to it: the cheapest thing a build could do
    // on the way out.
    const copy = path.join(tmpRoot, "wp-resigned");
    fs.copyFileSync(wp, copy);
    fs.chmodSync(copy, 0o755);
    const resign = await sh(["codesign", "--force", "--sign", "-", copy]);
    const reverify = await sh([
      "codesign",
      "--verify",
      "--strict",
      "--verbose=2",
      copy,
    ]);
    const redvv = await sh(["codesign", "-dvv", copy]);
    const reflags =
      redvv.out.split("\n").find((l) => l.startsWith("CodeDirectory")) ?? "";
    const reruns = await sh([copy, "--help"]);
    say(
      "codesign-adhoc-resign",
      `codesign --force --sign - exit ${resign.code}${resign.out ? ` (${resign.out.replace(/\n/g, " | ").slice(0, 120)})` : ""}; verify --strict exit ${reverify.code} ${reverify.out.replace(/\n/g, " | ").slice(0, 160)}; ${reflags}; --help exit ${reruns.code}`,
    );

    // Extract the ffi prebuild by asking the binary for its capabilities,
    // then look at the dylib it left under $TMPDIR.
    const caps = await sh([wp, "caps"]);
    const root = path.join(os.tmpdir(), "werk-poc-libghostty-vt-0.6.3");
    let dylibs: string[] = [];
    try {
      for (const plat of fs.readdirSync(root)) {
        const dir = path.join(root, plat);
        for (const name of fs.readdirSync(dir))
          if (name.endsWith(".dylib")) dylibs.push(path.join(dir, name));
      }
    } catch {}
    if (dylibs.length === 0) {
      say(
        "codesign-prebuild",
        `no extracted dylib under ${root} (wp caps exit ${caps.code}: ${caps.out.split("\n").slice(-1)[0]?.slice(0, 160)})`,
      );
    }
    for (const dylib of dylibs) {
      const d = await sh(["codesign", "-dvv", dylib]);
      const dflags =
        d.out.split("\n").find((l) => l.startsWith("CodeDirectory")) ??
        d.out.split("\n")[0] ??
        "";
      const dsig =
        d.out
          .split("\n")
          .find((l) => /^(Signature|Authority|TeamIdentifier)/.test(l)) ?? "";
      const v = await sh([
        "codesign",
        "--verify",
        "--strict",
        "--verbose=2",
        dylib,
      ]);
      const x = await sh(["xattr", "-l", dylib]);
      say(
        "codesign-prebuild",
        `${path.relative(root, dylib)}: -dvv exit ${d.code} ${dflags}${dsig ? `; ${dsig}` : ""}; verify exit ${v.code} ${v.out.replace(/\n/g, " | ").slice(0, 160)}; xattr ${x.out ? x.out.replace(/\n/g, " | ") : "none"}`,
      );
    }
  }
}

// ------------------------------------------------------ responsible process
if (want("responsible-process")) {
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  try {
    proc = Bun.spawn(["sleep", "30"], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
    proc.unref();
    const pid = proc.pid;
    const plain = await sh(["launchctl", "procinfo", String(pid)]);
    const sudo = await sh(["sudo", "-n", "launchctl", "procinfo", String(pid)]);
    const pick = (r: { code: number; out: string }) => {
      const lines = r.out
        .split("\n")
        .filter((l) => /responsible/i.test(l))
        .map((l) => l.trim());
      return lines.length
        ? lines.join(" | ")
        : `no 'responsible' line (exit ${r.code}, ${r.out.split("\n").length} lines: ${r.out.split("\n")[0]?.slice(0, 120)})`;
    };
    say(
      "responsible-process",
      `detached child pid ${pid} (our pid ${process.pid}); launchctl: ${pick(plain)}; sudo launchctl: ${pick(sudo)}`,
    );
  } catch (e) {
    say("responsible-process", `fail — ${firstLine(e)}`);
  } finally {
    try {
      proc?.kill();
    } catch {}
  }
}

// ---------------------------------------- spontaneous exit on detached children
// oven-sh/bun#40289: `exited` resolving on macOS before a detached child has
// actually exited. Fifty detached `sleep 2`s; anything resolved well before
// the two seconds are up is the bug.
async function detachedExitProbe(
  name: string,
  extra: Record<string, unknown>,
): Promise<void> {
  const N = 50;
  const procs: ReturnType<typeof Bun.spawn>[] = [];
  try {
    const t0 = performance.now();
    const early: string[] = [];
    for (let i = 0; i < N; i++) {
      const p = Bun.spawn(["sleep", "2"], {
        detached: true,
        stdio: ["ignore", "ignore", "ignore"],
        ...extra,
      } as Parameters<typeof Bun.spawn>[1]);
      procs.push(p);
      p.exited.then((code) => {
        const at = performance.now() - t0;
        if (at < 1500)
          early.push(
            `pid ${p.pid} at ${at.toFixed(0)} ms code ${code} sig ${p.signalCode}`,
          );
      });
    }
    await Bun.sleep(1500);
    const at1500 = early.length;
    const rest = await withTimeout(
      Promise.all(procs.map((p) => p.exited)),
      10000,
      "all children exiting",
    );
    const nonZero = rest.filter((c) => c !== 0).length;
    say(
      name,
      `${at1500} of ${N} exited promises resolved before 1.5 s (spawned in ${(performance.now() - t0).toFixed(0)} ms total wait); ${nonZero} non-zero exits${early.length ? `; early: ${early.slice(0, 3).join("; ")}` : ""}`,
    );
  } catch (e) {
    say(name, `fail — ${firstLine(e)}`);
  } finally {
    for (const p of procs) {
      try {
        p.kill();
      } catch {}
    }
  }
}

if (want("bun-terminal-detached-exit")) {
  await detachedExitProbe("bun-detached-exit", {});
  await detachedExitProbe("bun-terminal-detached-exit", {
    terminal: { cols: 80, rows: 24, data() {}, exit() {} },
  });
}

try {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
} catch {}
process.exit(0);
