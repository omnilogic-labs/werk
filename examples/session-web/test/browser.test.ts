import { test, expect } from "bun:test";
import { chromium } from "playwright";
import { serveSessionDaemon, openLocalTransport } from "@werk/session-daemon";
import { loadTerminalEngine } from "@werk/terminal/bun";
import { connectSessionClient } from "@werk/session";
import { startWebBridge } from "../src/bridge.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const executablePath = process.env.CHROMIUM_PATH;
test("built browser paints DOM, reconnects, resizes and lazily swaps to beamterm", async () => {
  const root = await mkdtemp(join(tmpdir(), "werk-browser-"));
  const daemon = await serveSessionDaemon({
    runtimeDir: join(root, "run"),
    stateDir: join(root, "state"),
    engineFactory: await loadTerminalEngine(),
  });
  const client = await connectSessionClient({
    transport: await openLocalTransport(daemon.endpoint),
  });
  const bridge = await startWebBridge({
    endpoint: daemon.endpoint,
    assetsDir: join(import.meta.dir, "../dist"),
    port: 0,
  });
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: [
      "--no-sandbox",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
    ],
  });
  try {
    const page = await browser.newPage();
    const failures: string[] = [];
    const assets: string[] = [];
    page.on("pageerror", (error) => failures.push(error.message));
    page.on("request", (request) => assets.push(request.url()));
    const session = await client.create({
      argv: [
        "/bin/sh",
        "-c",
        "printf '\\033[31mRED-MARKER\\033[0m\\r\\n'; exec cat",
      ],
      size: { cols: 80, rows: 24 },
      name: "browser-check",
    });
    await page.goto(`http://127.0.0.1:${bridge.port}`);
    await page.waitForFunction(
      () => document.querySelectorAll("#sessions option").length === 1,
    );
    await page.click("#attach");
    await page.waitForFunction(() =>
      document.querySelector("#screen")?.textContent?.includes("RED-MARKER"),
    );
    expect(assets.some((url) => url.endsWith("terminal.wasm"))).toBe(true);
    expect(
      assets.some((url) => url.endsWith("beamterm_renderer_bg.wasm")),
    ).toBe(false);
    expect(await page.locator(".term-row").count()).toBe(24);
    const styled = await page
      .locator(".term-row")
      .first()
      .evaluate((row) => {
        const cell = row.querySelector("span")!;
        return {
          rowHeight: row.getBoundingClientRect().height,
          cellWidth: cell.getBoundingClientRect().width,
          color: getComputedStyle(cell).color,
        };
      });
    expect(styled.rowHeight).toBeGreaterThan(10);
    expect(styled.cellWidth).toBeGreaterThan(5);
    expect(styled.color).not.toBe("rgb(216, 222, 233)");
    const before = await page.locator(".term-row").allTextContents();
    await page.click("#detach");
    await page.click("#attach");
    await page.waitForFunction(() =>
      document.querySelector("#screen")?.textContent?.includes("RED-MARKER"),
    );
    expect(await page.locator(".term-row").allTextContents()).toEqual(before);
    await page.fill("#cols", "92");
    await page.fill("#rows", "28");
    await page.click("#resize");
    await page.waitForFunction(
      () => document.querySelectorAll(".term-row").length === 28,
    );
    expect((await client.get(session.id)).size).toEqual({ cols: 92, rows: 28 });
    const resized = await page.locator(".term-row").allTextContents();
    await page.reload();
    await page.waitForFunction(
      () => document.querySelectorAll("#sessions option").length === 1,
    );
    await page.click("#attach");
    await page.waitForFunction(
      () => document.querySelectorAll(".term-row").length === 28,
    );
    expect(await page.locator(".term-row").allTextContents()).toEqual(resized);
    await page.selectOption("#renderer", "beamterm");
    await page.waitForFunction(() => {
      const canvas = document.querySelector("canvas");
      return canvas && canvas.width > 100 && canvas.height > 100;
    });
    expect(
      assets.some((url) => url.endsWith("beamterm_renderer_bg.wasm")),
    ).toBe(true);
    const pixels = Array.from(await page.locator("canvas").screenshot());
    const redPixels = await page.evaluate(async (bytes) => {
      const bitmap = await createImageBitmap(
        new Blob([new Uint8Array(bytes)], { type: "image/png" }),
      );
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d")!;
      context.drawImage(bitmap, 0, 0);
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let red = 0;
      for (let i = 0; i < data.length; i += 4)
        if (
          data[i] > 80 &&
          data[i] > data[i + 1] * 1.4 &&
          data[i] > data[i + 2] * 1.4
        )
          red++;
      bitmap.close();
      return red;
    }, pixels);
    expect(redPixels).toBeGreaterThan(20);
    expect(failures).toEqual([]);
    await page.close();
    expect((await client.get(session.id)).state).toBe("running");
    expect(await client.readScreen(session.id)).toContain("RED-MARKER");
    await client.terminate(session.id, "force");
  } finally {
    await browser.close();
    bridge.stop();
    await client.close();
    await daemon.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
