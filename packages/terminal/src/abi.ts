// Small marshal layer for the self-describing, pinned upstream C ABI.
type Description = {
  kind: string;
  size: number;
  type?: string;
  underlying?: string;
  values?: Record<string, number>;
  fields?: Record<
    string,
    {
      offset: number;
      type: string;
      tag?: string;
      arms?: Record<string, string>;
    }
  >;
};
export class Abi {
  readonly exports: WebAssembly.Exports;
  readonly types: Record<string, Description>;
  private buffer?: ArrayBuffer;
  private cachedBytes?: Uint8Array;
  private cachedView?: DataView;
  constructor(instance: WebAssembly.Instance) {
    this.exports = instance.exports;
    const p = this.call("ghostty_type_json");
    let q = p;
    while (this.bytes()[q]) q++;
    this.types = JSON.parse(
      new TextDecoder().decode(this.bytes().slice(p, q)),
    ).types;
  }
  bytes() {
    const buffer = (this.exports.memory as WebAssembly.Memory).buffer;
    // WASM growth replaces the buffer and detaches the old views.
    if (buffer !== this.buffer) {
      this.buffer = buffer;
      this.cachedBytes = new Uint8Array(buffer);
      this.cachedView = new DataView(buffer);
    }
    return this.cachedBytes!;
  }
  view() {
    this.bytes();
    return this.cachedView!;
  }
  u32(p: number): number {
    return this.view().getUint32(p, true);
  }
  u8(p: number): number {
    return this.view().getUint8(p);
  }
  setU32(p: number, value: number): void {
    this.view().setUint32(p, value, true);
  }
  call(name: string, ...args: (number | bigint)[]): number {
    return Number((this.exports[name] as Function)(...args) ?? 0);
  }
  check(name: string, ...args: (number | bigint)[]) {
    const code = this.call(name, ...args);
    if (code !== 0) throw new Error(`${name}: ${code}`);
  }
  enum(type: string, key: string) {
    const value = this.types[type]?.values?.[key];
    if (value === undefined) throw new Error(`Unknown ABI enum ${type}.${key}`);
    return value;
  }
  alloc(n: number) {
    const p = this.call("ghostty_wasm_alloc", Math.max(n, 1));
    if (!p) throw new Error("WASM allocation failed");
    this.bytes().fill(0, p, p + Math.max(n, 1));
    return p;
  }
  free(p: number, n: number) {
    this.call("ghostty_wasm_free", p, Math.max(n, 1));
  }
  temporary<T>(n: number, fn: (p: number) => T): T {
    const p = this.alloc(n);
    try {
      return fn(p);
    } finally {
      this.free(p, n);
    }
  }
  object<T>(type: string, fn: (p: number) => T): T {
    return this.temporary(this.types[type]!.size, (p) => {
      this.write(p, type, {});
      return fn(p);
    });
  }
  handle(name: string, ...args: number[]): number {
    return this.temporary(4, (p) => {
      this.check(name, 0, p, ...args);
      return this.view().getUint32(p, true);
    });
  }
  read(p: number, type: string): any {
    const t = this.types[type];
    if (t?.kind === "enum") return this.read(p, t.underlying!);
    if (t?.kind === "alias") return this.read(p, t.type!);
    if (t?.fields) {
      const r: Record<string, unknown> = {};
      for (const [k, f] of Object.entries(t.fields)) {
        let ft = f.type,
          at = p + f.offset;
        if (f.tag && f.arms) {
          const tag = t.fields[f.tag]!;
          const n = this.read(p + tag.offset, tag.type);
          const name = Object.entries(this.types[tag.type]!.values!).find(
            ([, v]) => v === n,
          )?.[0];
          const arm = this.types[ft]!.fields?.[f.arms[name!]!];
          if (!arm) {
            r[k] = null;
            continue;
          }
          at += arm.offset;
          ft = arm.type;
        }
        r[k] = this.read(at, ft);
      }
      return r;
    }
    const v = this.view();
    switch (type) {
      case "bool":
        return !!v.getUint8(p);
      case "u8":
        return v.getUint8(p);
      case "u16":
        return v.getUint16(p, true);
      case "i32":
        return v.getInt32(p, true);
      case "u64":
        return v.getBigUint64(p, true);
      default:
        return v.getUint32(p, true);
    }
  }
  write(p: number, type: string, value: any): void {
    const t = this.types[type];
    if (t?.kind === "enum")
      return this.write(
        p,
        t.underlying!,
        typeof value === "string" ? this.enum(type, value) : value,
      );
    if (t?.fields) {
      if (t.fields.size) this.view().setUint32(p, t.size, true);
      for (const [k, v] of Object.entries(value)) {
        const f = t.fields[k]!;
        let at = p + f.offset,
          ft = f.type;
        if (f.tag && f.arms) {
          const tag = t.fields[f.tag]!;
          const n = this.read(p + tag.offset, tag.type);
          const name = Object.entries(this.types[tag.type]!.values!).find(
            ([, x]) => x === n,
          )?.[0];
          const arm = this.types[ft]!.fields![f.arms[name!]!]!;
          at += arm.offset;
          ft = arm.type;
        }
        this.write(at, ft, v);
      }
      return;
    }
    if (type === "bool" || type === "u8")
      this.view().setUint8(p, Number(value));
    else if (type === "u16") this.view().setUint16(p, Number(value), true);
    else this.view().setUint32(p, Number(value), true);
  }
  hook(arity: number, callback: (...args: number[]) => void): number {
    const type = [1, 96, arity, ...Array(arity).fill(127), 0],
      imp = [1, 1, 101, 1, 102, 0, 0],
      exp = [1, 1, 102, 0, 0];
    const m = new WebAssembly.Module(
      new Uint8Array([
        0,
        97,
        115,
        109,
        1,
        0,
        0,
        0,
        1,
        type.length,
        ...type,
        2,
        imp.length,
        ...imp,
        7,
        exp.length,
        ...exp,
      ]),
    );
    const f = new WebAssembly.Instance(m, { e: { f: callback } }).exports.f;
    const table = this.exports.__indirect_function_table as WebAssembly.Table;
    const slot = table.grow(1);
    table.set(slot, f);
    return slot;
  }
}
