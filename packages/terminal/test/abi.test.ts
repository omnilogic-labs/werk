import { expect, test } from "bun:test";
import { Abi } from "../src/abi.ts";
import { terminalWasmBytes } from "../src/bun/index.ts";

test("ABI caches views and refreshes typed access after memory growth", async () => {
  const module = await WebAssembly.compile(await terminalWasmBytes());
  const abi = new Abi(await WebAssembly.instantiate(module, {}));
  const memory = abi.exports.memory as WebAssembly.Memory;
  abi.temporary(4, (p) => {
    const bytes = abi.bytes();
    const view = abi.view();
    expect(abi.bytes()).toBe(bytes);
    expect(abi.view()).toBe(view);
    abi.setU32(p, 0xfedcba98);
    expect(abi.u32(p)).toBe(0xfedcba98);
    expect(abi.u8(p)).toBe(0x98);
    expect(Array.from(bytes.subarray(p, p + 4))).toEqual([
      0x98, 0xba, 0xdc, 0xfe,
    ]);

    memory.grow(1);
    expect(abi.u32(p)).toBe(0xfedcba98);
    expect(abi.bytes()).not.toBe(bytes);
    expect(abi.view()).not.toBe(view);
    expect(abi.bytes().buffer).toBe(memory.buffer);
    expect(abi.view().buffer).toBe(memory.buffer);
    expect(abi.view()).toBe(abi.view());
    abi.setU32(p, 0x12345678);
    expect(abi.read(p, "u32")).toBe(0x12345678);
    expect(abi.u8(p)).toBe(0x78);

    // A zero-page grow also replaces a non-shared memory's buffer.
    const grownBytes = abi.bytes();
    memory.grow(0);
    expect(abi.u8(p)).toBe(0x78);
    expect(abi.bytes()).not.toBe(grownBytes);
    expect(abi.u32(p)).toBe(0x12345678);
  });
});
