import { test, expect } from "bun:test";
import { spawnPty, platformCapabilities } from "../src/platform/index.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireDaemonLock } from "../src/platform/lock.js";

async function until(check: () => boolean | Promise<boolean>, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await Bun.sleep(20);
  }
  throw new Error("Native condition timed out");
}
const environment = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  ),
);
function running(pid: number) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform !== "win32") {
    const result = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)], {
      stdout: "pipe",
    });
    return (
      result.exitCode === 0 &&
      !new TextDecoder().decode(result.stdout).trim().startsWith("Z")
    );
  }
  return true;
}

test("native PTY hosts input, resize, and process exit", async () => {
  let output = "";
  const child = spawnPty(
    [
      process.execPath,
      "-e",
      `console.log("NATIVE_READY");for await(const chunk of Bun.stdin.stream()){console.log("NATIVE_ECHO:"+new TextDecoder().decode(chunk).trim());process.exit(0);}`,
    ],
    process.cwd(),
    environment,
    { cols: 80, rows: 24 },
    (data) => {
      output += new TextDecoder().decode(data);
    },
  );
  try {
    expect(platformCapabilities.pty).toBe(true);
    await until(() => output.includes("NATIVE_READY"));
    child.resize({ cols: 97, rows: 29 });
    child.write(new TextEncoder().encode("input-marker\r"));
    await until(() => output.includes("NATIVE_ECHO:input-marker"));
    expect(await child.exited).toBe(0);
  } finally {
    child.close();
  }
});

test("kernel daemon ownership is exclusive and reusable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "werk-native-lock-"));
  const file = join(dir, "daemon.lock");
  const release = acquireDaemonLock(file);
  try {
    expect(() => acquireDaemonLock(file)).toThrow("already running");
  } finally {
    release();
  }
  acquireDaemonLock(file)();
  await rm(dir, { recursive: true, force: true });
});

test("force ends a live child and its detached descendant", async () => {
  let output = "",
    descendant = 0;
  const program = `const child=Bun.spawn([process.execPath,"-e","setInterval(()=>{},1000)"],{detached:true,stdio:["ignore","ignore","ignore"]});console.log("DESCENDANT="+child.pid);setInterval(()=>{},1000);`;
  const child = spawnPty(
    [process.execPath, "-e", program],
    process.cwd(),
    environment,
    { cols: 80, rows: 24 },
    (data) => {
      output += new TextDecoder().decode(data);
    },
  );
  try {
    await until(() => /DESCENDANT=\d+/.test(output));
    descendant = Number(output.match(/DESCENDANT=(\d+)/)![1]);
    expect(running(descendant)).toBe(true);
    const result = child.terminate("force");
    expect(result.delivery).toBe(
      process.platform === "win32" ? "job-object" : "process-tree-signal",
    );
    await child.exited;
    await until(() => !running(descendant));
  } finally {
    child.close();
    if (descendant && running(descendant)) process.kill(descendant, "SIGKILL");
  }
});

test.skipIf(process.platform === "win32")(
  "PTY interrupt reaches a shell's separate foreground job",
  async () => {
    let output = "",
      foreground = 0;
    const child = spawnPty(
      ["/bin/sh", "-i"],
      process.cwd(),
      environment,
      { cols: 80, rows: 24 },
      (data) => {
        output += new TextDecoder().decode(data);
      },
    );
    try {
      child.write(
        new TextEncoder().encode(
          "sh -c 'echo FOREGROUND=$$; exec sleep 1000'\n",
        ),
      );
      await until(() => /FOREGROUND=\d+/.test(output));
      foreground = Number(output.match(/FOREGROUND=(\d+)/)![1]);
      expect(running(foreground)).toBe(true);
      expect(child.terminate("interrupt").delivery).toBe("pty-control-c");
      await until(() => !running(foreground));
      expect(running(child.pid)).toBe(true);
    } finally {
      child.terminate("force");
      await child.exited;
      child.close();
      if (foreground && running(foreground))
        process.kill(foreground, "SIGKILL");
    }
  },
);

test.skipIf(process.platform !== "win32")(
  "Windows kernel job cleans descendants after abrupt owner death",
  async () => {
    const owner = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL("./fixtures/windows-owner.ts", import.meta.url)),
      ],
      { stdout: "pipe", stderr: "inherit" },
    );
    let output = "",
      descendant = 0;
    const reading = (async () => {
      for await (const bytes of owner.stdout) {
        output += new TextDecoder().decode(bytes);
      }
    })();
    try {
      await until(() => /OWNED_DESCENDANT=\d+/.test(output));
      descendant = Number(output.match(/OWNED_DESCENDANT=(\d+)/)![1]);
      expect(running(descendant)).toBe(true);
      owner.kill();
      await owner.exited;
      await until(() => !running(descendant));
    } finally {
      owner.kill();
      await reading;
      if (descendant && running(descendant))
        process.kill(descendant, "SIGKILL");
    }
  },
);

test.skipIf(process.platform !== "win32")(
  "Windows endpoint requires its per-start credential",
  async () => {
    const { serveSessionDaemon, openLocalTransport } =
      await import("../src/index.js");
    const { connectSessionClient } = await import("@werk/session");
    const { loadTerminalEngine } = await import("@werk/terminal");
    const dir = await mkdtemp(join(tmpdir(), "werk-native-auth-"));
    const daemon = await serveSessionDaemon({
      runtimeDir: join(dir, "run"),
      stateDir: join(dir, "state"),
      engineFactory: await loadTerminalEngine(),
    });
    try {
      expect(daemon.endpoint.kind).toBe("tcp");
      if (daemon.endpoint.kind !== "tcp")
        throw new Error("Expected TCP endpoint");
      await expect(
        connectSessionClient({
          transport: await openLocalTransport(daemon.endpoint),
          credential: "wrong",
          requestTimeoutMs: 1000,
        }),
      ).rejects.toThrow();
      const client = await connectSessionClient({
        transport: await openLocalTransport(daemon.endpoint),
        credential: daemon.endpoint.credential,
      });
      try {
        expect((await client.daemonInfo()).id).toBe(daemon.info.id);
      } finally {
        await client.close();
      }
    } finally {
      await daemon.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
