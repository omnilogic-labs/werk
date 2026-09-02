import { describe, expect, test } from "bun:test";
import { GHOSTTY_COMMIT, ghosttyWasmBytes, ghosttyWasmPath } from "./bytes.ts";
import { GhosttyError, GhosttyModule } from "./loader.ts";

const g = await GhosttyModule.load(await ghosttyWasmBytes());

describe("artifact", () => {
  test("the import path is the pinned commit's directory", async () => {
    const pin = JSON.parse(
      await Bun.file(
        import.meta.dir + "/../../../vendor/ghostty-vt/PIN",
      ).text(),
    );
    expect(pin.commit).toBe(GHOSTTY_COMMIT);
    expect(ghosttyWasmPath).toContain(GHOSTTY_COMMIT);
  });

  test("pinned size and sha256", async () => {
    const pin = JSON.parse(
      await Bun.file(
        import.meta.dir + "/../../../vendor/ghostty-vt/PIN",
      ).text(),
    );
    const bytes = new Uint8Array(await ghosttyWasmBytes());
    expect(bytes.byteLength).toBe(pin.artifacts["ghostty-vt-small.wasm"].size);
    const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    expect(digest).toBe(pin.artifacts["ghostty-vt-small.wasm"].sha256);
  });

  test("zero imports, the exports the proposal counted", () => {
    expect(g.importCount).toBe(0);
    expect(g.exportCount).toBe(189);
    expect(Object.keys(g.fn).length).toBe(187); // plus memory and the indirect function table
  });
});

describe("type json", () => {
  test("parses and describes the wasm32 ABI", () => {
    expect(g.layout.schema).toBe(1);
    expect(g.layout.abi).toEqual({
      target: "wasm32",
      os: "freestanding",
      environment: "none",
      pointer_size: 4,
      usize_size: 4,
      max_alignment: 16,
      endian: "little",
    });
    expect(Object.keys(g.layout.types).length).toBe(159);
  });

  test("sizes and offsets match the headers", () => {
    // types.h: GhosttyString { const uint8_t* ptr; size_t len; }
    expect(g.sizeOf("GhosttyString")).toBe(8);
    expect(g.layout.field("GhosttyString", "len").offset).toBe(4);
    // formatter.h: size, emit, unwrap, trim, extra (24), selection pointer
    expect(g.sizeOf("GhosttyFormatterTerminalOptions")).toBe(40);
    expect(
      g.layout.field("GhosttyFormatterTerminalOptions", "selection").offset,
    ).toBe(36);
    expect(g.sizeOf("GhosttyFormatterScreenExtra")).toBe(12);
    // style.h: sized struct with three 16-byte tagged colours then eight bools and an int
    expect(g.sizeOf("GhosttyStyle")).toBe(72);
    expect(g.layout.field("GhosttyStyle", "underline").offset).toBe(64);
    // screen.h: GhosttyCell is a packed uint64_t
    expect(g.layout.type("GhosttyCell").kind).toBe("packed");
    expect(g.sizeOf("GhosttyCell")).toBe(8);
    expect(g.sizeOf("GhosttyRow")).toBe(8);
    expect(g.sizeOf("GhosttyTerminal")).toBe(4); // an opaque handle is a pointer
  });

  test("enums carry the header's values", () => {
    expect(g.enumValue("GhosttyResult", "SUCCESS")).toBe(0);
    expect(g.enumValue("GhosttyResult", "OUT_OF_SPACE")).toBe(-3);
    expect(g.enumValue("GhosttyResult", "GHOSTTY_REJECTED")).toBe(-7);
    expect(g.enumName("GhosttyResult", -2)).toBe("INVALID_VALUE");
    expect(g.enumValue("GhosttyTerminalOption", "SCROLLBACK_MAX_LINES")).toBe(
      28,
    );
    expect(g.enumValue("GhosttyFormatterFormat", "VT")).toBe(1);
  });

  test("sized structs are recognised", () => {
    expect(g.layout.isSized("GhosttyStyle")).toBe(true);
    expect(g.layout.isSized("GhosttyFormatterTerminalOptions")).toBe(true);
    expect(g.layout.isSized("GhosttyString")).toBe(false);
  });
});

describe("marshalling", () => {
  test("alloc / write / read / free round-trips scalars", () => {
    const p = g.alloc(16);
    g.write(p, "u32", 0xdeadbeef);
    g.write(p + 4, "i32", -5);
    g.write(p + 8, "u64", 1n << 40n);
    expect(g.read(p, "u32")).toBe(0xdeadbeef);
    expect(g.read(p + 4, "i32")).toBe(-5);
    expect(g.read(p + 8, "u64")).toBe(1n << 40n);
    g.free(p, 16);
  });

  test("allocType zero-fills and sets the size field", () => {
    const p = g.allocType("GhosttyStyle");
    const st = g.readStruct(p, "GhosttyStyle");
    expect(st["size"]).toBe(72);
    expect(st["bold"]).toBe(false);
    expect(st["fg_color"]).toEqual({ tag: 0, value: null });
    g.freeType(p, "GhosttyStyle");
  });

  test("structs and tagged unions write and read back", () => {
    const p = g.allocType("GhosttyStyle");
    g.writeStruct(p, "GhosttyStyle", { bold: true, underline: 3 });
    g.writeField(p, "GhosttyStyle", "fg_color", { tag: "RGB" });
    g.writeField(p, "GhosttyStyle", "fg_color", {
      value: { r: 1, g: 2, b: 3 },
    });
    g.writeField(p, "GhosttyStyle", "bg_color", { tag: "PALETTE" });
    g.writeField(p, "GhosttyStyle", "bg_color", { value: 200 });
    const st = g.readStruct(p, "GhosttyStyle");
    expect(st["bold"]).toBe(true);
    expect(st["underline"]).toBe(3);
    expect(st["fg_color"]).toEqual({ tag: 2, value: { r: 1, g: 2, b: 3 } });
    expect(st["bg_color"]).toEqual({ tag: 1, value: 200 });
    expect(g.call("ghostty_style_is_default", p)).toBe(0);
    g.call("ghostty_style_default", p);
    expect(g.call("ghostty_style_is_default", p)).toBe(1);
    g.freeType(p, "GhosttyStyle");
  });

  test("enum fields accept member names", () => {
    const p = g.allocType("GhosttyFormatterTerminalOptions");
    g.writeStruct(p, "GhosttyFormatterTerminalOptions", { emit: "HTML" });
    expect(g.readField(p, "GhosttyFormatterTerminalOptions", "emit")).toBe(2);
    g.freeType(p, "GhosttyFormatterTerminalOptions");
  });

  test("arrays inside structs", () => {
    const p = g.allocType("GhosttyRenderStateColors");
    const f = g.layout.field("GhosttyRenderStateColors", "palette");
    expect(f.count).toBe(256);
    g.write(p + f.offset + 3 * 3, "GhosttyColorRgb", { r: 9, g: 8, b: 7 });
    const palette = g.readField(
      p,
      "GhosttyRenderStateColors",
      "palette",
    ) as unknown[];
    expect(palette.length).toBe(256);
    expect(palette[3]).toEqual({ r: 9, g: 8, b: 7 });
    g.freeType(p, "GhosttyRenderStateColors");
  });

  test("the compiled cell decoder agrees with the descriptor walk", () => {
    const decode = g.layout.packedDecoder("GhosttyCell");
    let seed = 0x9e3779b9;
    const next = () => {
      // xorshift32, so the same values every run
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return seed >>> 0;
    };
    for (let i = 0; i < 2000; i++) {
      const lo = next();
      const hi = next() & 0xffff; // GhosttyCell uses the low 48 bits
      const value = (BigInt(hi) << 32n) | BigInt(lo);
      expect(decode(lo, hi)).toEqual(
        g.layout.decodePacked("GhosttyCell", value),
      );
    }
    expect(decode(0, 0)).toEqual({
      content_tag: 0,
      content: { codepoint: 0 },
      style_id: 0,
      wide: 0,
      protected: false,
      hyperlink: false,
      semantic_content: 0,
    });
  });

  test("packed GhosttyCell decodes by descriptor", () => {
    // content_tag bits 0-1 = 0 (codepoint), codepoint bits 2-22, style_id bits 26-41, wide bits 42-43
    const value =
      (BigInt("A".codePointAt(0)!) << 2n) | (7n << 26n) | (1n << 42n);
    const d = g.layout.decodePacked("GhosttyCell", value) as Record<
      string,
      unknown
    >;
    expect(d["content_tag"]).toBe(0);
    expect(d["content"]).toEqual({ codepoint: 65 });
    expect(d["style_id"]).toBe(7);
    expect(d["wide"]).toBe(1);
    // ...and agrees with the C accessor
    const out = g.alloc(4);
    g.check(
      "ghostty_cell_get",
      value,
      g.enumValue("GhosttyCellData", "CODEPOINT"),
      out,
    );
    expect(g.read(out, "u32")).toBe(65);
    g.check(
      "ghostty_cell_get",
      value,
      g.enumValue("GhosttyCellData", "STYLE_ID"),
      out,
    );
    expect(g.read(out, "u16")).toBe(7);
    g.free(out, 4);
  });

  test("errors carry the GhosttyResult name", () => {
    const out = g.alloc(4);
    let err: unknown;
    try {
      g.check("ghostty_cell_get", 0n, 999, out);
    } catch (e) {
      err = e;
    }
    g.free(out, 4);
    expect(err).toBeInstanceOf(GhosttyError);
    expect((err as GhosttyError).result).toBe("INVALID_VALUE");
    expect((err as GhosttyError).code).toBe(-2);
  });

  test("memory growth does not invalidate reads", () => {
    const before = g.memory.buffer.byteLength;
    const p = g.alloc(64);
    g.write(p, "u32", 0x12345678);
    // Force growth: allocate more than the current memory holds.
    const big = g.alloc(before + 1024 * 1024);
    expect(g.memory.buffer.byteLength).toBeGreaterThan(before);
    expect(g.read(p, "u32")).toBe(0x12345678);
    g.write(big, "u8", 1);
    expect(g.read(big, "u8")).toBe(1);
    g.free(big, before + 1024 * 1024);
    g.free(p, 64);
  });

  test("opaque handles come through withOpaque", () => {
    const term = g.withOpaque("ghostty_terminal_new", (slot) =>
      g.call("ghostty_terminal_new", 0, slot, 10, 2),
    );
    expect(term).not.toBe(0);
    const out = g.alloc(2);
    g.check(
      "ghostty_terminal_get",
      term,
      g.enumValue("GhosttyTerminalData", "COLS"),
      out,
    );
    expect(g.read(out, "u16")).toBe(10);
    g.free(out, 2);
    g.call("ghostty_terminal_free", term);
  });

  test("a failing constructor throws with the result name", () => {
    expect(() =>
      g.withOpaque("ghostty_terminal_new", (slot) =>
        g.call("ghostty_terminal_new", 0, slot, 0, 0),
      ),
    ).toThrow(/INVALID_VALUE/);
  });
});
