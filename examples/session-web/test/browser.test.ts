import { test, expect } from "bun:test";
import { chromium } from "playwright";
import { serveSessionDaemon, openLocalTransport } from "@werk/session-daemon";
import { loadTerminalEngine } from "@werk/terminal/bun";
import { connectSessionClient } from "@werk/session";
import { flavours, roles, type FlavourName } from "@werk/palette";
import { mkdtemp, rm, cp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const executablePath = process.env.CHROMIUM_PATH;
// `getComputedStyle` reports colour as `rgb(r, g, b)`; the palette carries hex.
// Every colour this file expects is read out of `@werk/palette` and converted
// here rather than typed as a literal, because a literal cannot notice the
// palette moving underneath it and this lane is the only place it would show.
//
// Which flavour to read is the page's business, not this file's: it picks one
// from the reader's own appearance preference and records it on the root
// element. So the expectations are looked up under whichever flavour the page
// says it chose, and pinning one here would be the same mistake as pinning a
// colour, one level up.
const rgb = (hex: string): string => {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255})`;
};
test("built browser paints DOM, reconnects, resizes and lazily swaps to beamterm", async () => {
  const root = await mkdtemp(join(tmpdir(), "werk-browser-"));
  // Reproduce the package file allowlists outside the checkout. In particular,
  // neither the bridge nor its runtime dependencies can resolve source files.
  const assetsDir = join(root, "web");
  await cp(join(import.meta.dir, "../dist"), assetsDir, { recursive: true });
  for (const name of ["session", "session-daemon", "terminal"]) {
    const source = join(import.meta.dir, "../../../packages", name);
    const target = join(root, "node_modules/@werk", name);
    await mkdir(target, { recursive: true });
    const manifest = await Bun.file(join(source, "package.json")).json();
    for (const entry of ["package.json", ...manifest.files])
      await cp(join(source, entry), join(target, entry), { recursive: true });
  }
  const { startWebBridge } = await import(join(assetsDir, "bridge.js"));
  for (const asset of [
    "terminal.LICENSE",
    "terminal.PROVENANCE.md",
    "LICENSE.beamterm",
    "beamterm.PROVENANCE.md",
    "LICENSE.wterm-dom",
  ])
    expect(await Bun.file(join(assetsDir, asset)).exists()).toBe(true);
  const daemon = await serveSessionDaemon({
    runtimeDir: join(root, "run"),
    stateDir: join(root, "state"),
    version: "test",
    engineFactory: await loadTerminalEngine(),
  });
  const client = await connectSessionClient({
    transport: await openLocalTransport(daemon.endpoint),
  });
  let bridge = await startWebBridge({
    endpoint: daemon.endpoint,
    assetsDir,
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
    // Every wait below has to give up well before the test's own timeout, or a
    // wait that never settles is reported as something else entirely.
    // Playwright's default ceiling is 30 seconds and this test's is 30 seconds
    // too, so a stalled wait loses the race to the test timeout. Bun's timeout
    // prints nothing for that attempt, leaves the `finally` below unrun, and
    // kills the browser under the abandoned wait; the wait then rejects with
    // "Target page, context or browser has been closed" against whichever
    // attempt `--retry` is running by then. The reader gets a silent
    // thirty-second gap and an error naming a line that attempt never reached.
    // A ceiling a third of the way down keeps a stalled wait a failure of that
    // wait, at that line, inside the attempt that caused it. Nothing here takes
    // more than a second on a runner, so the headroom is about tenfold.
    page.setDefaultTimeout(10_000);
    const failures: string[] = [];
    const assets: string[] = [];
    page.on("pageerror", (error) => failures.push(error.message));
    page.on("request", (request) => assets.push(request.url()));
    const session = await client.create({
      argv: [
        process.execPath,
        "-e",
        `process.stdin.setRawMode(true); process.stdout.write("\\x1b[31mRED-MARKER\\x1b[0m\\r\\n\\x1b[?1h\\x1b[?2004h"); process.stdin.on("data", bytes => process.stdout.write("HEX:" + bytes.toString("hex") + "\\r\\n"));`,
      ],
      size: { cols: 80, rows: 24 },
      name: "browser-check",
    });
    await page.goto(`http://127.0.0.1:${bridge.port}`);
    await page.waitForFunction(
      () => document.querySelectorAll("#sessions option").length === 1,
    );
    // What the page decided to wear. Every colour expected below is looked up
    // under this rather than under a flavour this file picked, so the page
    // remains free to choose and the assertions still say what a reader sees.
    const flavour = (await page.evaluate(
      () => document.documentElement.dataset.werkFlavour,
    )) as FlavourName | undefined;
    expect(flavour, "the page records the flavour it chose").toBeDefined();
    const theme = roles(flavour);
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
    // The marker carries SGR 31, so the replica paints it slot 1 of the flavour
    // the page chose. Asserting the colour it *is* rather than one it is not:
    // an assertion that only rules a colour out keeps passing when the palette
    // moves under it, and says nothing about what the reader actually sees.
    expect(styled.color).toBe(rgb(theme.terminal.ansi[1]!));
    await page.locator("#screen").press("ArrowUp");
    await page.waitForFunction(() =>
      document.querySelector("#screen")?.textContent?.includes("HEX:1b4f41"),
    );
    await page.locator("#screen").evaluate((screen) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", "paste-test");
      screen.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData, bubbles: true }),
      );
    });
    await page.waitForFunction(() =>
      document
        .querySelector("#screen")
        ?.textContent?.includes(
          "HEX:1b5b3230307e70617374652d746573741b5b3230317e",
        ),
    );
    // The preview strip is a text frame per session, not a replica: it paints
    // colour without a second engine and takes no size from the terminal.
    await page.waitForFunction(() =>
      document
        .querySelector("#tiles .tile-screen")
        ?.textContent?.includes("RED-MARKER"),
    );
    await page.waitForFunction(() =>
      document
        .querySelector("#tiles .tile-screen")
        ?.textContent?.includes("HEX:"),
    );
    // The preview strip decodes SGR itself, so the marker's SGR 31 becomes
    // slot 1 of the same flavour the replica used. The two are the page's one
    // theme read twice; they were once two different palettes side by side.
    // `page.evaluate` does not close over this scope, so the expected colour is
    // passed in as an argument.
    expect(
      await page.evaluate(
        (expected) =>
          [...document.querySelectorAll("#tiles .tile-screen span")].some(
            (span) => getComputedStyle(span).color === expected,
          ),
        rgb(theme.terminal.ansi[1]!),
      ),
    ).toBe(true);
    expect(await page.locator("#tiles .tile").count()).toBe(1);
    const attachments = (await client.get(session.id)).attachments;
    expect(
      attachments.filter((a) => a.representation === "preview"),
    ).toHaveLength(1);
    expect(attachments.filter((a) => a.holdsSize)).toHaveLength(1);
    expect(
      attachments.find((a) => a.representation === "preview")!.holdsSize,
    ).toBe(false);
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
    const port = bridge.port;
    bridge.stop();
    await page.waitForFunction(() =>
      document
        .querySelector("#status")
        ?.textContent?.includes("Connection closed"),
    );
    expect((await client.get(session.id)).state).toBe("running");
    bridge = await startWebBridge({
      endpoint: daemon.endpoint,
      assetsDir,
      port,
    });
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
    // A renderer swap must not resize or alter the authoritative terminal.
    expect((await client.get(session.id)).size).toEqual({ cols: 92, rows: 28 });
    await page.selectOption("#renderer", "dom");
    await page.waitForFunction(
      () => document.querySelectorAll(".term-row").length === 28,
    );
    expect(await page.locator(".term-row").allTextContents()).toEqual(resized);
    // The page picks its flavour from the reader's own appearance preference, so
    // the other one has to be walked too. An assertion that only ever sees the
    // default cannot tell a flavour that follows the preference from a flavour
    // that is fixed, which is the failure this file already had once.
    const other = flavours[flavour!].dark ? "light" : "dark";
    await page.emulateMedia({ colorScheme: other });
    await page.reload();
    await page.waitForFunction(
      () => document.documentElement.dataset.werkFlavour !== undefined,
    );
    const swapped = (await page.evaluate(
      () => document.documentElement.dataset.werkFlavour,
    )) as FlavourName;
    expect(swapped).not.toBe(flavour);
    expect(flavours[swapped].dark).toBe(other === "dark");
    // And the tiles, which paint without attaching, repaint in it.
    await page.waitForFunction(() =>
      document
        .querySelector("#tiles .tile-screen")
        ?.textContent?.includes("HEX:"),
    );
    expect(
      await page.evaluate(
        (expected) =>
          [...document.querySelectorAll("#tiles .tile-screen span")].some(
            (span) => getComputedStyle(span).color === expected,
          ),
        rgb(roles(swapped).terminal.ansi[1]!),
      ),
    ).toBe(true);
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
