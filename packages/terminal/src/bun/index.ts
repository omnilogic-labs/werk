import asset from "../../assets/terminal.wasm" with { type: "file" };
import { createTerminalEngine } from "../engine.js";
export async function terminalWasmBytes(): Promise<Uint8Array> {
  return new Uint8Array(await Bun.file(asset).arrayBuffer());
}
export async function loadTerminalEngine() {
  return createTerminalEngine(await terminalWasmBytes());
}
