// The loader: instantiates upstream's freestanding `ghostty-vt-small.wasm`
// and marshals values in and out of its linear memory using the layout table
// from `ghostty_type_json()` (see layout.ts for the document's shape).
//
// No Bun APIs here. Callers hand in the bytes (bytes.ts does that on Bun)
// or an already-compiled WebAssembly.Module, so a browser can use this file
// as it is.
//
// Conventions the rest of the adapter relies on:
//
//   - Allocation is `ghostty_wasm_alloc(len)` / `ghostty_wasm_free(ptr, len)`
//     (wasm.h): no alignment argument, the result is aligned to
//     abi.max_alignment (16), and free needs the same length back. Buffers
//     the library allocates for us (`*_alloc` APIs) go back through
//     `ghostty_free(NULL, ptr, len)` instead; do not mix the two.
//   - Opaque handles come out of constructors through a slot from
//     `ghostty_wasm_alloc_opaque()`; `withOpaque()` wraps that.
//   - Every C function that takes a struct *by value* (GhosttyWriter,
//     GhosttyPoint, GhosttyFormatterTerminalOptions, ...) takes a *pointer*
//     to it under the wasm32 C ABI, so allocate the struct and pass its
//     address. 64-bit scalars (GhosttyCell, GhosttyRow) are i64 parameters
//     and cross as BigInt.
//   - Any call into the module may grow memory; never hold a typed array
//     across a call. `bytes()` and `view()` re-derive after growth.
//   - C function pointers are indices into the exported
//     `__indirect_function_table`. The module imports nothing, so a host
//     function gets in through `hostFunction()`: a one-function trampoline
//     module imports the JS function and exports it as a wasm function,
//     which the table accepts. (`WebAssembly.Function` does not exist on
//     Bun 1.3.14 / JSC, and `table.set` rejects a plain JS function.)

import { Layout, isScalarName, type FieldDesc } from "./layout.ts";

export type WasmFn = (...args: (number | bigint)[]) => number | bigint | void;

export class GhosttyError extends Error {
  constructor(
    readonly code: number,
    readonly result: string,
    what: string,
  ) {
    super(`${what}: ${result} (${code})`);
    this.name = "GhosttyError";
  }
}

export type GhosttySource = Uint8Array | ArrayBuffer | WebAssembly.Module;

/** The wasm value types a host function's signature may use. */
export type WasmValType = "i32" | "i64" | "f32" | "f64";

export interface WasmSignature {
  params: WasmValType[];
  results: WasmValType[];
}

/** A struct value as read from or written to memory: field name to value. */
export type StructValue = Record<string, unknown>;

export class GhosttyModule {
  readonly layout: Layout;
  readonly memory: WebAssembly.Memory;
  /** Raw exports. Argument and return types follow the C headers, mapped to number (or bigint for 64-bit). */
  readonly fn: Record<string, WasmFn>;
  readonly exportCount: number;
  readonly importCount: number;
  /** The module's `__indirect_function_table`; C function pointers are indices into it. */
  readonly table: WebAssembly.Table;

  private cachedBuffer: ArrayBufferLike | null = null;
  private cachedLength = 0;
  private cachedBytes: Uint8Array = new Uint8Array(0);
  private cachedView: DataView = new DataView(new ArrayBuffer(0));

  private constructor(
    module: WebAssembly.Module,
    instance: WebAssembly.Instance,
  ) {
    this.importCount = WebAssembly.Module.imports(module).length;
    this.exportCount = WebAssembly.Module.exports(module).length;
    const ex = instance.exports as Record<string, unknown>;
    const memory = ex["memory"];
    if (!(memory instanceof WebAssembly.Memory))
      throw new Error("wasm exports no memory");
    this.memory = memory;
    const table = ex["__indirect_function_table"];
    if (!(table instanceof WebAssembly.Table))
      throw new Error("wasm exports no __indirect_function_table");
    this.table = table;
    const fn: Record<string, WasmFn> = {};
    for (const [k, v] of Object.entries(ex))
      if (typeof v === "function") fn[k] = v as WasmFn;
    this.fn = fn;
    this.layout = Layout.parse(
      this.readCString(this.call("ghostty_type_json")),
    );
  }

  static async load(source: GhosttySource): Promise<GhosttyModule> {
    // The cast is so the same line typechecks under Bun's types and the
    // DOM's, whose Uint8Array generics differ; the bytes are the same.
    const module =
      source instanceof WebAssembly.Module
        ? source
        : await WebAssembly.compile(
            source as ArrayBuffer | Uint8Array<ArrayBuffer>,
          );
    const instance = await WebAssembly.instantiate(module, {});
    return new GhosttyModule(module, instance);
  }

  // ---- calling -------------------------------------------------------------

  /** Call an export by name; throws if the export does not exist. */
  call(name: string, ...args: (number | bigint)[]): number {
    const f = this.fn[name];
    if (!f) throw new Error(`wasm has no export "${name}"`);
    const r = f(...args);
    return typeof r === "number" ? r : typeof r === "bigint" ? Number(r) : 0;
  }

  /** Call an export returning GhosttyResult and throw on anything but SUCCESS. */
  check(name: string, ...args: (number | bigint)[]): void {
    this.assertOk(this.call(name, ...args), name);
  }

  assertOk(code: number, what: string): void {
    if (code !== 0) throw new GhosttyError(code, this.resultName(code), what);
  }

  resultName(code: number): string {
    return (
      this.layout.enumName("GhosttyResult", code) ?? `UNKNOWN_RESULT_${code}`
    );
  }

  // ---- host functions ------------------------------------------------------

  /**
   * Put a JS function into the module's function table and return its index,
   * which is what C code sees as a function pointer of that signature. The
   * slot is never reclaimed; a terminal registers its callbacks once.
   */
  hostFunction(sig: WasmSignature, fn: (...args: number[]) => unknown): number {
    const mod = trampolineModule(sig);
    const inst = new WebAssembly.Instance(mod, { e: { f: fn } });
    const idx = this.table.grow(1);
    this.table.set(idx, inst.exports["f"] as (...a: unknown[]) => unknown);
    return idx;
  }

  // ---- memory views --------------------------------------------------------

  /** A Uint8Array over the whole of current linear memory. Re-derived after growth. */
  bytes(): Uint8Array {
    const buffer = this.memory.buffer;
    if (
      buffer !== this.cachedBuffer ||
      buffer.byteLength !== this.cachedLength
    ) {
      this.cachedBuffer = buffer;
      this.cachedLength = buffer.byteLength;
      this.cachedBytes = new Uint8Array(buffer);
      this.cachedView = new DataView(buffer);
    }
    return this.cachedBytes;
  }

  view(): DataView {
    this.bytes();
    return this.cachedView;
  }

  // ---- allocation ----------------------------------------------------------

  /** `ghostty_wasm_alloc(len)`; zero-filled. Free with `free(ptr, len)`. */
  alloc(len: number): number {
    if (len <= 0) throw new Error(`alloc(${len})`);
    const ptr = this.call("ghostty_wasm_alloc", len);
    if (ptr === 0)
      throw new GhosttyError(-1, "OUT_OF_MEMORY", `ghostty_wasm_alloc(${len})`);
    this.bytes().fill(0, ptr, ptr + len);
    return ptr;
  }

  free(ptr: number, len: number): void {
    if (ptr !== 0) this.call("ghostty_wasm_free", ptr, len);
  }

  /**
   * Allocate room for one value of a named type, zero-filled. A sized struct
   * (leading `size` field, GHOSTTY_INIT_SIZED) gets its size written.
   * Free with `freeType(ptr, type)`.
   */
  allocType(type: string): number {
    const ptr = this.alloc(this.sizeOf(type));
    if (this.layout.isSized(type))
      this.view().setUint32(ptr, this.sizeOf(type), true);
    return ptr;
  }

  freeType(ptr: number, type: string): void {
    this.free(ptr, this.sizeOf(type));
  }

  /** Copy bytes into a fresh allocation. Free with `free(ptr, data.length)`. */
  allocBytes(data: Uint8Array): number {
    const ptr = this.alloc(data.byteLength);
    this.bytes().set(data, ptr);
    return ptr;
  }

  /** Free a buffer the library allocated for us (`*_alloc` APIs): `ghostty_free(NULL, ptr, len)`. */
  libFree(ptr: number, len: number): void {
    if (ptr !== 0) this.call("ghostty_free", 0, ptr, len);
  }

  /**
   * Run a constructor that fills an opaque out-parameter slot. `body` gets
   * the slot's address and returns the GhosttyResult; the handle is taken
   * out and the slot freed regardless.
   */
  withOpaque(what: string, body: (slot: number) => number): number {
    const slot = this.call("ghostty_wasm_alloc_opaque");
    if (slot === 0)
      throw new GhosttyError(-1, "OUT_OF_MEMORY", "ghostty_wasm_alloc_opaque");
    try {
      const code = body(slot);
      const handle = this.call("ghostty_wasm_take_opaque", slot);
      this.assertOk(code, what);
      if (handle === 0) throw new Error(`${what}: success but NULL handle`);
      return handle;
    } finally {
      this.call("ghostty_wasm_free_opaque", slot);
    }
  }

  /** Run `body` with a temporary allocation of `type` (or `n` bytes), freeing it afterwards. */
  withTemp<T>(typeOrLen: string | number, body: (ptr: number) => T): T {
    const len =
      typeof typeOrLen === "number" ? typeOrLen : this.sizeOf(typeOrLen);
    const ptr =
      typeof typeOrLen === "number"
        ? this.alloc(len)
        : this.allocType(typeOrLen);
    try {
      return body(ptr);
    } finally {
      this.free(ptr, len);
    }
  }

  // ---- layout lookups ------------------------------------------------------

  sizeOf(type: string): number {
    return this.layout.sizeOf(type);
  }

  alignOf(type: string): number {
    return this.layout.alignOf(type);
  }

  enumValue(type: string, member: string): number {
    return this.layout.enumValue(type, member);
  }

  enumName(type: string, value: number): string | undefined {
    return this.layout.enumName(type, value);
  }

  // ---- reading -------------------------------------------------------------

  readCString(ptr: number): string {
    const b = this.bytes();
    let end = ptr;
    while (b[end] !== 0) end++;
    return new TextDecoder().decode(b.subarray(ptr, end));
  }

  /** A copy of `len` bytes at `ptr`; safe to keep across calls. */
  readBytes(ptr: number, len: number): Uint8Array {
    return this.bytes().slice(ptr, ptr + len);
  }

  writeBytes(ptr: number, data: Uint8Array): void {
    this.bytes().set(data, ptr);
  }

  /** Read a GhosttyString {ptr, len} at `ptr` and decode it as UTF-8. */
  readString(ptr: number): string {
    const s = this.readStruct(ptr, "GhosttyString") as {
      ptr: number;
      len: number;
    };
    return new TextDecoder().decode(
      this.bytes().subarray(s.ptr, s.ptr + s.len),
    );
  }

  readScalar(ptr: number, type: string): number | bigint | boolean {
    const v = this.view();
    switch (type) {
      case "u8":
        return v.getUint8(ptr);
      case "i8":
        return v.getInt8(ptr);
      case "u16":
        return v.getUint16(ptr, true);
      case "i16":
        return v.getInt16(ptr, true);
      case "u32":
      case "pointer":
        return v.getUint32(ptr, true);
      case "i32":
        return v.getInt32(ptr, true);
      case "u64":
        return v.getBigUint64(ptr, true);
      case "i64":
        return v.getBigInt64(ptr, true);
      case "f32":
        return v.getFloat32(ptr, true);
      case "f64":
        return v.getFloat64(ptr, true);
      case "bool":
        return v.getUint8(ptr) !== 0;
    }
    throw new Error(`not a scalar: ${type}`);
  }

  writeScalar(ptr: number, type: string, value: unknown): void {
    const v = this.view();
    switch (type) {
      case "u8":
        return v.setUint8(ptr, num(value));
      case "i8":
        return v.setInt8(ptr, num(value));
      case "u16":
        return v.setUint16(ptr, num(value), true);
      case "i16":
        return v.setInt16(ptr, num(value), true);
      case "u32":
      case "pointer":
        return v.setUint32(ptr, num(value), true);
      case "i32":
        return v.setInt32(ptr, num(value), true);
      case "u64":
        return v.setBigUint64(ptr, BigInt(value as number | bigint), true);
      case "i64":
        return v.setBigInt64(ptr, BigInt(value as number | bigint), true);
      case "f32":
        return v.setFloat32(ptr, num(value), true);
      case "f64":
        return v.setFloat64(ptr, num(value), true);
      case "bool":
        return v.setUint8(ptr, value ? 1 : 0);
    }
    throw new Error(`not a scalar: ${type}`);
  }

  /**
   * Read a value of any named type at `ptr`: scalars and aliases as
   * number/bigint/boolean, enums as their number, structs as objects, unions
   * as an object of every arm, opaques as the pointer value.
   */
  read(ptr: number, type: string): unknown {
    if (isScalarName(type)) return this.readScalar(ptr, type);
    const t = this.layout.type(type);
    switch (t.kind) {
      case "alias":
        return this.read(ptr, t.type);
      case "enum":
        return this.readScalar(ptr, t.underlying);
      case "packed":
        return this.readScalar(ptr, t.underlying);
      case "opaque":
        return this.readScalar(ptr, "pointer");
      case "struct":
      case "union":
        return this.readStruct(ptr, type);
    }
  }

  readStruct(ptr: number, type: string): StructValue {
    const t = this.layout.struct(type);
    const out: StructValue = {};
    for (const [name, f] of Object.entries(t.fields))
      out[name] = this.readFieldDesc(ptr, t, f);
    return out;
  }

  readField(ptr: number, type: string, field: string): unknown {
    return this.readFieldDesc(
      ptr,
      this.layout.struct(type),
      this.layout.field(type, field),
    );
  }

  private readFieldDesc(
    base: number,
    parent: { fields: Record<string, FieldDesc> },
    f: FieldDesc,
  ): unknown {
    const at = base + f.offset;
    if (f.type === "pointer") return this.readScalar(at, "pointer");
    if (f.type === "array") {
      const elem = f.elem ?? "u8";
      const stride = this.sizeOf(elem);
      const n = f.count ?? 0;
      const out: unknown[] = [];
      for (let i = 0; i < n; i++) out.push(this.read(at + i * stride, elem));
      return out;
    }
    if (f.tag && f.arms) {
      // A tagged union: read the discriminant, then only the live arm.
      const tagField = parent.fields[f.tag];
      if (!tagField) throw new Error(`tag field "${f.tag}" missing`);
      const tagValue = this.read(
        base + tagField.offset,
        tagField.type,
      ) as number;
      const tagName = this.layout.enumName(tagField.type, tagValue);
      const arm = tagName !== undefined ? f.arms[tagName] : undefined;
      if (!arm) return null;
      const union = this.layout.struct(f.type);
      const armField = union.fields[arm];
      if (!armField) throw new Error(`union ${f.type} has no arm "${arm}"`);
      return this.readFieldDesc(at, union, armField);
    }
    return this.read(at, f.type);
  }

  // ---- writing -------------------------------------------------------------

  /**
   * Write a value of any named type. Enums accept a member name or number;
   * bools accept anything truthy; structs take a partial object (missing
   * fields are left as they are, so allocType's zero-fill and size stand).
   */
  write(ptr: number, type: string, value: unknown): void {
    if (isScalarName(type)) return this.writeScalar(ptr, type, value);
    const t = this.layout.type(type);
    switch (t.kind) {
      case "alias":
        return this.write(ptr, t.type, value);
      case "enum":
        return this.writeScalar(
          ptr,
          t.underlying,
          typeof value === "string"
            ? this.layout.enumValue(type, value)
            : value,
        );
      case "packed":
        return this.writeScalar(ptr, t.underlying, value);
      case "opaque":
        return this.writeScalar(ptr, "pointer", value);
      case "struct":
      case "union":
        return this.writeStruct(ptr, type, value as StructValue);
    }
  }

  writeStruct(ptr: number, type: string, value: StructValue): void {
    const t = this.layout.struct(type);
    for (const [name, v] of Object.entries(value)) {
      const f = t.fields[name];
      if (!f) throw new Error(`"${type}" has no field "${name}"`);
      this.writeFieldDesc(ptr, t, f, v);
    }
  }

  writeField(ptr: number, type: string, field: string, value: unknown): void {
    this.writeFieldDesc(
      ptr,
      this.layout.struct(type),
      this.layout.field(type, field),
      value,
    );
  }

  private writeFieldDesc(
    base: number,
    parent: { fields: Record<string, FieldDesc> },
    f: FieldDesc,
    value: unknown,
  ): void {
    const at = base + f.offset;
    if (f.type === "pointer") return this.writeScalar(at, "pointer", value);
    if (f.type === "array") {
      const elem = f.elem ?? "u8";
      const stride = this.sizeOf(elem);
      (value as unknown[]).forEach((v, i) =>
        this.write(at + i * stride, elem, v),
      );
      return;
    }
    if (f.tag && f.arms) {
      const tagField = parent.fields[f.tag];
      if (!tagField) throw new Error(`tag field "${f.tag}" missing`);
      const tagValue = this.read(
        base + tagField.offset,
        tagField.type,
      ) as number;
      const tagName = this.layout.enumName(tagField.type, tagValue);
      const arm = tagName !== undefined ? f.arms[tagName] : undefined;
      if (!arm) return;
      const union = this.layout.struct(f.type);
      const armField = union.fields[arm];
      if (!armField) throw new Error(`union ${f.type} has no arm "${arm}"`);
      return this.writeFieldDesc(at, union, armField, value);
    }
    this.write(at, f.type, value);
  }
}

const VALTYPE: Record<WasmValType, number> = {
  i32: 0x7f,
  i64: 0x7e,
  f32: 0x7d,
  f64: 0x7c,
};

const trampolines = new Map<string, WebAssembly.Module>();

/**
 * A minimal wasm module with one imported function `e.f` of `sig`, exported
 * as `f`. Compiled once per signature; a few dozen bytes each.
 */
function trampolineModule(sig: WasmSignature): WebAssembly.Module {
  const key = `${sig.params.join(",")}->${sig.results.join(",")}`;
  let mod = trampolines.get(key);
  if (mod) return mod;
  const type = [
    1, // one type
    0x60, // func
    sig.params.length,
    ...sig.params.map((p) => VALTYPE[p]),
    sig.results.length,
    ...sig.results.map((r) => VALTYPE[r]),
  ];
  const imports = [1, 1, 0x65, 1, 0x66, 0x00, 0]; // "e" "f" func type 0
  const exports = [1, 1, 0x66, 0x00, 0]; // "f" func 0
  const bytes = new Uint8Array([
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00,
    0x01,
    type.length,
    ...type,
    0x02,
    imports.length,
    ...imports,
    0x07,
    exports.length,
    ...exports,
  ]);
  mod = new WebAssembly.Module(bytes);
  trampolines.set(key, mod);
  return mod;
}

function num(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "boolean") return v ? 1 : 0;
  throw new Error(`expected a number, got ${typeof v}`);
}
