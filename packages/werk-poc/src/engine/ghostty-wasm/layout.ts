// The ABI description libghostty-vt publishes about itself, parsed into a
// table the loader can marshal through. Pure TypeScript with no WebAssembly
// dependency so a browser can use it unchanged.
//
// `ghostty_type_json()` returns a NUL-terminated JSON document. On the pinned
// build it is 43,503 bytes and looks like this:
//
//   {
//     "schema": 1,
//     "abi": { "target": "wasm32", "os": "freestanding", "environment": "none",
//              "pointer_size": 4, "usize_size": 4, "max_alignment": 16,
//              "endian": "little" },
//     "library_version": "0.1.0-dev", "commit": null, "dirty": null,
//     "types": { "<GhosttyName>": <type>, ... }        // 159 on the pinned build
//   }
//
// Every type carries `kind`, `size` and `align`. The kinds seen:
//
//   struct  fields: { name: { offset, size, type, ...} }   56 on the pinned build
//   union   same shape as struct, offsets all 0             5
//   enum    underlying ("i32"), prefix ("GHOSTTY_..."),    71
//           values: { NAME: number }  — NAME is the C constant minus the prefix
//   packed  underlying ("u64"), bits: { name: { lsb, width, type } }   1 (GhosttyCell)
//           a bit may instead be a tagged union: { lsb, width, kind: "union",
//           tag: "<sibling bit>", arms: { ENUM_NAME: { kind: "packed", width, bits } } }
//   alias   type: a scalar name (GhosttyRow = u64, GhosttyStyleId = u16, ...)   6
//   opaque  a handle; size 4 (a pointer) on wasm32                            20
//
// A struct field's `type` is either a scalar ("u8" "u16" "u32" "u64" "i8"
// "i32" "f32" "f64" "bool"), "pointer" (with `elem`: a type name, "opaque",
// "function" or a scalar; plus `const` and sometimes `nullable`), "array"
// (with `elem` and `count`), or the name of another type. A field whose type
// is a union may carry `tag` (the sibling field holding the discriminant)
// and `arms` mapping each enum value name to the union member that is live
// for it, or to null when nothing is.
//
// Enums whose values are used as C-side option/data keys (GhosttyTerminalData,
// GhosttyRenderStateRowCellsData, ...) are here too, so the loader never
// needs a hand-transcribed constant.

export type ScalarName =
  | "u8"
  | "u16"
  | "u32"
  | "u64"
  | "i8"
  | "i16"
  | "i32"
  | "i64"
  | "f32"
  | "f64"
  | "bool"
  | "pointer";

export const SCALAR_SIZE: Record<ScalarName, number> = {
  u8: 1,
  u16: 2,
  u32: 4,
  u64: 8,
  i8: 1,
  i16: 2,
  i32: 4,
  i64: 8,
  f32: 4,
  f64: 8,
  bool: 1,
  pointer: 4,
};

export function isScalarName(s: string): s is ScalarName {
  return s in SCALAR_SIZE;
}

export interface FieldDesc {
  offset: number;
  size: number;
  type: string;
  elem?: string;
  const?: boolean;
  nullable?: boolean;
  count?: number;
  tag?: string;
  arms?: Record<string, string | null>;
}

export interface BitDesc {
  lsb: number;
  width: number;
  type?: string;
  kind?: "union" | "packed";
  tag?: string;
  arms?: Record<
    string,
    { kind: "packed"; width: number; bits: Record<string, BitDesc> }
  >;
  bits?: Record<string, BitDesc>;
}

export interface StructType {
  kind: "struct" | "union";
  size: number;
  align: number;
  fields: Record<string, FieldDesc>;
}
export interface EnumType {
  kind: "enum";
  size: number;
  align: number;
  underlying: string;
  prefix: string;
  values: Record<string, number>;
}
export interface PackedType {
  kind: "packed";
  size: number;
  align: number;
  underlying: string;
  bits: Record<string, BitDesc>;
}
export interface AliasType {
  kind: "alias";
  size: number;
  align: number;
  type: string;
}
export interface OpaqueType {
  kind: "opaque";
  size: number;
  align: number;
}
export type TypeDesc =
  StructType | EnumType | PackedType | AliasType | OpaqueType;

export interface Abi {
  target: string;
  os: string;
  environment: string;
  pointer_size: number;
  usize_size: number;
  max_alignment: number;
  endian: "little" | "big";
}

export interface TypeJson {
  schema: number;
  abi: Abi;
  library_version: string;
  commit: string | null;
  dirty: boolean | null;
  types: Record<string, TypeDesc>;
}

/** The parsed table plus the lookups the loader needs. */
export class Layout {
  readonly schema: number;
  readonly abi: Abi;
  readonly libraryVersion: string;
  readonly types: Record<string, TypeDesc>;

  constructor(doc: TypeJson) {
    if (doc.schema !== 1) {
      throw new Error(
        `ghostty_type_json schema ${doc.schema} is not the 1 this loader reads`,
      );
    }
    if (
      doc.abi.pointer_size !== 4 ||
      doc.abi.usize_size !== 4 ||
      doc.abi.endian !== "little"
    ) {
      throw new Error(`unexpected ABI: ${JSON.stringify(doc.abi)}`);
    }
    this.schema = doc.schema;
    this.abi = doc.abi;
    this.libraryVersion = doc.library_version;
    this.types = doc.types;
  }

  static parse(json: string): Layout {
    return new Layout(JSON.parse(json) as TypeJson);
  }

  has(name: string): boolean {
    return name in this.types;
  }

  type(name: string): TypeDesc {
    const t = this.types[name];
    if (!t) throw new Error(`ghostty_type_json has no type "${name}"`);
    return t;
  }

  /** Follow aliases to the underlying type name (a scalar or another kind). */
  resolve(name: string): string {
    let n = name;
    for (let i = 0; i < 8; i++) {
      const t = this.types[n];
      if (t?.kind === "alias") n = t.type;
      else return n;
    }
    throw new Error(`alias chain too deep at "${name}"`);
  }

  sizeOf(name: string): number {
    if (isScalarName(name)) return SCALAR_SIZE[name];
    return this.type(name).size;
  }

  alignOf(name: string): number {
    if (isScalarName(name)) return SCALAR_SIZE[name];
    return this.type(name).align;
  }

  struct(name: string): StructType {
    const t = this.type(name);
    if (t.kind !== "struct" && t.kind !== "union") {
      throw new Error(`"${name}" is a ${t.kind}, not a struct or union`);
    }
    return t;
  }

  field(typeName: string, field: string): FieldDesc {
    const f = this.struct(typeName).fields[field];
    if (!f) throw new Error(`"${typeName}" has no field "${field}"`);
    return f;
  }

  enum(name: string): EnumType {
    const t = this.type(name);
    if (t.kind !== "enum")
      throw new Error(`"${name}" is a ${t.kind}, not an enum`);
    return t;
  }

  /** `enumValue("GhosttyResult", "OUT_OF_SPACE")` is -3. Accepts the prefixed C name too. */
  enumValue(typeName: string, member: string): number {
    const e = this.enum(typeName);
    const key = member.startsWith(e.prefix)
      ? member.slice(e.prefix.length)
      : member;
    const v = e.values[key];
    if (v === undefined)
      throw new Error(`enum ${typeName} has no member "${member}"`);
    return v;
  }

  /** The un-prefixed member name for a value, or undefined if none matches. */
  enumName(typeName: string, value: number): string | undefined {
    for (const [k, v] of Object.entries(this.enum(typeName).values)) {
      if (v === value && !k.endsWith("MAX_VALUE")) return k;
    }
    return undefined;
  }

  packed(name: string): PackedType {
    const t = this.type(name);
    if (t.kind !== "packed")
      throw new Error(`"${name}" is a ${t.kind}, not packed`);
    return t;
  }

  /**
   * Whether a struct follows the GHOSTTY_INIT_SIZED convention: a leading
   * `size` field that must hold sizeof(struct) before the C side reads it.
   */
  isSized(name: string): boolean {
    const t = this.types[name];
    if (!t || t.kind !== "struct") return false;
    const size = t.fields["size"];
    return size !== undefined && size.offset === 0 && size.type === "u32";
  }

  /** Decode a packed integer (GhosttyCell) into its named bits. */
  decodePacked(name: string, value: bigint): Record<string, unknown> {
    const t = this.packed(name);
    return decodeBits(t.bits, value, this);
  }
}

function extractBits(value: bigint, lsb: number, width: number): number {
  return Number((value >> BigInt(lsb)) & ((1n << BigInt(width)) - 1n));
}

function decodeBits(
  bits: Record<string, BitDesc>,
  value: bigint,
  layout: Layout,
) {
  const out: Record<string, unknown> = {};
  for (const [name, b] of Object.entries(bits)) {
    if (b.kind === "union" && b.tag && b.arms) {
      const tagBit = bits[b.tag];
      const tagValue = tagBit
        ? extractBits(value, tagBit.lsb, tagBit.width)
        : 0;
      const tagName = tagBit?.type
        ? layout.enumName(tagBit.type, tagValue)
        : undefined;
      const arm = tagName ? b.arms[tagName] : undefined;
      out[name] = arm
        ? decodeBits(arm.bits, value >> BigInt(b.lsb), layout)
        : null;
      continue;
    }
    const raw = extractBits(value, b.lsb, b.width);
    out[name] = b.type === "bool" ? raw !== 0 : raw;
  }
  return out;
}
