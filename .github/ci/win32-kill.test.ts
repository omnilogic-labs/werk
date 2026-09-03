// The tail of `src/daemon/daemon.test.ts`'s kill test, narrowed. Under
// `bun run` the whole sequence takes a tenth of a second on both Windows
// runners; under `bun test` the request for a session that is already gone —
// the one whose reply is an `error` frame — never arrives, and the test dies
// of its five-second budget. This asks the same question three ways so the
// difference has somewhere to show up.
//
//   bun test .github/ci/win32-kill.test.ts
//
// Not part of any suite: a probe that happens to be written as a test,
// because the thing being measured is what `bun test` does differently.

import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  connect,
  type Client,
} from "../../packages/werk-poc/src/client/index.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wp-kt-"));
process.env.WP_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "wp-kt-st-"));
let client: Client;

const lap = (what: string, t0: number) =>
  console.log(`LAP ${what} ${(performance.now() - t0).toFixed(0)} ms`);

beforeAll(async () => {
  client = await connect({ dir });
});

afterAll(async () => {
  await client.shutdown().catch(() => {});
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Runs a session, kills it, and removes it; returns the id it left behind. */
async function spentSession(): Promise<string> {
  const t0 = performance.now();
  const { id } = await client.run({ argv: ["sleep", "30"] });
  lap("  spent: run", t0);
  const t1 = performance.now();
  await client.kill(id);
  lap("  spent: kill", t1);
  const t2 = performance.now();
  for (let i = 0; i < 200; i++) {
    const s = (await client.ls()).find((x) => x.id === id);
    if (s && s.status !== "running") break;
    await Bun.sleep(20);
  }
  lap("  spent: wait for exit", t2);
  const t3 = performance.now();
  await client.kill(id); // removes it
  lap("  spent: remove", t3);
  return id;
}

test("a request for a gone session, awaited with try/catch", async () => {
  const id = await spentSession();
  const t0 = performance.now();
  let message = "(resolved)";
  try {
    await client.kill(id);
  } catch (e) {
    message = (e as Error).message;
  }
  lap("try/catch kill", t0);
  console.log(`try/catch said ${JSON.stringify(message)}`);
  expect(message).toMatch(/no session/);
}, 20_000);

test("the same, through expect().rejects", async () => {
  const id = await spentSession();
  console.log(`spent session is ${id}; asking for it again`);
  const t0 = performance.now();
  await expect(client.kill(id)).rejects.toThrow(/no session/);
  lap("expect().rejects kill", t0);
}, 20_000);

test("expect().rejects on a promise that is already rejected", async () => {
  const t0 = performance.now();
  await expect(Promise.reject(new Error("no session nothing"))).rejects.toThrow(
    /no session/,
  );
  lap("expect().rejects on a settled promise", t0);
}, 20_000);

test("the same, on a session id that never existed", async () => {
  const t0 = performance.now();
  let message = "(resolved)";
  try {
    await client.kill("f0f0f0");
  } catch (e) {
    message = (e as Error).message;
  }
  lap("never-existed kill", t0);
  console.log(`never-existed said ${JSON.stringify(message)}`);
  expect(message).toMatch(/no session/);
}, 20_000);
