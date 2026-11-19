import { test, expect } from "bun:test";
import { spawnPty, platformCapabilities } from "../src/platform/index.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  const result = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)], {
    stdout: "pipe",
  });
  return (
    result.exitCode === 0 &&
    !new TextDecoder().decode(result.stdout).trim().startsWith("Z")
  );
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
    expect(result.delivery).toBe("process-tree-signal");
    await child.exited;
    await until(() => !running(descendant));
  } finally {
    child.close();
    if (descendant && running(descendant)) process.kill(descendant, "SIGKILL");
  }
});

test("PTY interrupt reaches a shell's separate foreground job", async () => {
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
      new TextEncoder().encode("sh -c 'echo FOREGROUND=$$; exec sleep 1000'\n"),
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
    if (foreground && running(foreground)) process.kill(foreground, "SIGKILL");
  }
});
