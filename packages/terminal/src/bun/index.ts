import asset from "../../assets/terminal.wasm" with { type: "file" };
export async function terminalWasmBytes(): Promise<Uint8Array> {
  return new Uint8Array(await Bun.file(asset).arrayBuffer());
}
export async function loadTerminalEngine() {
  // Imported here rather than at the top so that a caller who only wants a
  // colour read does not load the engine to get one.
  const { createTerminalEngine } = await import("../engine.js");
  return createTerminalEngine(await terminalWasmBytes());
}
export async function loadTerminalColours() {
  const { createColourReader } = await import("../colour.js");
  return createColourReader(await terminalWasmBytes());
}
