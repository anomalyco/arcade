/**
 * Minimal, zero-dependency typed WGSL struct, slot specialization, and module composition system.
 *
 * 1. `wgslStruct`: Computes exact WebGPU std140/uniform byte alignment and padding, emits a
 *    16-byte-aligned WGSL `struct Name { ... }`, and provides a type-checked `pack(values, out, floatOffset)`
 *    method that writes named TypeScript properties to their exact aligned float offsets.
 * 2. `wgslSnippet` & `resolveWgsl`: Composes named WGSL snippets and struct declarations in topological
 *    dependency order (`uses: [...]`), deduplicating shared definitions without string `.replace()` surgery.
 * 3. `wgslSlot`: Specializes compile-time shader variants so inactive branches can be stripped before
 *    GPU register allocation.
 */

export type WgslScalarType = "f32" | "i32" | "u32"
export type WgslVecType = "vec2f" | "vec2i" | "vec2u" | "vec3f" | "vec3i" | "vec3u" | "vec4f" | "vec4i" | "vec4u"
export type WgslMatType = "mat4x4f"
export type WgslArrayType = `array<vec4f, ${number}>`
export type WgslFieldType = WgslScalarType | WgslVecType | WgslMatType | WgslArrayType

export type JsValueForWgsl<T extends WgslFieldType> = T extends WgslScalarType
  ? number
  : T extends "vec2f" | "vec2i" | "vec2u"
    ? readonly [number, number] | Float32Array
    : T extends "vec3f" | "vec3i" | "vec3u"
      ? readonly [number, number, number] | Float32Array
      : T extends "vec4f" | "vec4i" | "vec4u"
        ? readonly [number, number, number, number] | Float32Array
        : T extends "mat4x4f" | WgslArrayType
          ? ArrayLike<number>
          : never

export interface WgslFieldLayout {
  readonly name: string
  readonly type: WgslFieldType
  readonly byteOffset: number
  readonly floatOffset: number
  readonly byteSize: number
  readonly byteAlign: number
  readonly comps: number
  readonly kind: "f" | "i" | "u"
}

export interface WgslStruct<Schema extends Record<string, WgslFieldType>> {
  readonly kind: "wgsl-struct"
  readonly name: string
  readonly schema: Schema
  readonly fields: readonly WgslFieldLayout[]
  readonly byteSize: number
  readonly floatCount: number
  readonly wgsl: string
  createBuffer(): Float32Array<ArrayBuffer>
  pack(
    values: { readonly [K in keyof Schema]: JsValueForWgsl<Schema[K]> },
    out?: Float32Array<ArrayBuffer>,
    floatOffset?: number,
  ): Float32Array<ArrayBuffer>
  offsetOf<K extends keyof Schema>(key: K): number
}

type TypeMetric = { align: number; size: number; comps: number; kind: "f" | "i" | "u" }

const BASE_TYPE_METRICS: Record<WgslScalarType | WgslVecType | WgslMatType, TypeMetric> = {
  f32: { align: 4, size: 4, comps: 1, kind: "f" },
  i32: { align: 4, size: 4, comps: 1, kind: "i" },
  u32: { align: 4, size: 4, comps: 1, kind: "u" },
  vec2f: { align: 8, size: 8, comps: 2, kind: "f" },
  vec2i: { align: 8, size: 8, comps: 2, kind: "i" },
  vec2u: { align: 8, size: 8, comps: 2, kind: "u" },
  vec3f: { align: 16, size: 12, comps: 3, kind: "f" },
  vec3i: { align: 16, size: 12, comps: 3, kind: "i" },
  vec3u: { align: 16, size: 12, comps: 3, kind: "u" },
  vec4f: { align: 16, size: 16, comps: 4, kind: "f" },
  vec4i: { align: 16, size: 16, comps: 4, kind: "i" },
  vec4u: { align: 16, size: 16, comps: 4, kind: "u" },
  mat4x4f: { align: 16, size: 64, comps: 16, kind: "f" },
}

function getTypeMetric(type: WgslFieldType, fieldName: string, structName: string): TypeMetric {
  if (type in BASE_TYPE_METRICS) {
    return BASE_TYPE_METRICS[type as keyof typeof BASE_TYPE_METRICS]
  }
  const m = /^array<vec4f,\s*(\d+)>$/.exec(type)
  if (m) {
    const count = Number(m[1])
    if (count > 0 && Number.isInteger(count)) {
      return { align: 16, size: count * 16, comps: count * 4, kind: "f" }
    }
  }
  throw new Error(`Unknown WGSL type "${String(type)}" for field "${fieldName}" in struct ${structName}`)
}

const alignUp = (offset: number, align: number): number => Math.ceil(offset / align) * align

/**
 * Defines a WGSL struct with automatic WebGPU std140/uniform alignment calculation
 * and a fast typed `pack()` method.
 */
export function wgslStruct<Schema extends Record<string, WgslFieldType>>(
  name: string,
  schema: Schema,
): WgslStruct<Schema> {
  const fields: WgslFieldLayout[] = []
  const offsetMap = new Map<string, number>()
  let byteOffset = 0
  const maxAlign = 16 // Uniform buffers require 16-byte struct alignment

  for (const [key, type] of Object.entries(schema)) {
    const m = getTypeMetric(type, key, name)
    byteOffset = alignUp(byteOffset, m.align)
    const layout: WgslFieldLayout = {
      name: key,
      type,
      byteOffset,
      floatOffset: byteOffset >>> 2,
      byteSize: m.size,
      byteAlign: m.align,
      comps: m.comps,
      kind: m.kind,
    }
    fields.push(layout)
    offsetMap.set(key, layout.floatOffset)
    byteOffset += m.size
  }

  const totalBytes = alignUp(byteOffset, maxAlign)
  const trailingPadBytes = totalBytes - byteOffset
  const lines: string[] = [`struct ${name} {`]
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]!
    const attrs: string[] = []
    if (i === 0 && f.byteAlign < 16) attrs.push("@align(16)")
    if (i === fields.length - 1 && trailingPadBytes > 0) attrs.push(`@size(${f.byteSize + trailingPadBytes})`)
    const prefix = attrs.length > 0 ? `${attrs.join(" ")} ` : ""
    lines.push(`  ${prefix}${f.name}: ${f.type},`)
  }
  lines.push(`}`)
  const wgsl = lines.join("\n")
  const floatCount = totalBytes >>> 2

  return {
    kind: "wgsl-struct",
    name,
    schema,
    fields,
    byteSize: totalBytes,
    floatCount,
    wgsl,
    createBuffer() {
      return new Float32Array(floatCount)
    },
    offsetOf(key) {
      return offsetMap.get(key as string)!
    },
    pack(values, out = new Float32Array(floatCount), floatOffset = 0) {
      let i32View: Int32Array | null = null
      let u32View: Uint32Array | null = null
      for (let i = 0; i < fields.length; i++) {
        const f = fields[i]!
        const v = (values as Record<string, unknown>)[f.name]
        const dst = floatOffset + f.floatOffset
        if (f.comps === 1) {
          const num = v as number
          if (f.kind === "f") out[dst] = num
          else if (f.kind === "i") {
            i32View ??= new Int32Array(out.buffer, out.byteOffset, out.length)
            i32View[dst] = num | 0
          } else {
            u32View ??= new Uint32Array(out.buffer, out.byteOffset, out.length)
            u32View[dst] = num >>> 0
          }
        } else {
          const arr = v as ArrayLike<number>
          const len = Math.min(f.comps, arr.length)
          if (f.kind === "f") {
            for (let c = 0; c < len; c++) out[dst + c] = arr[c]!
            for (let c = len; c < f.comps; c++) out[dst + c] = 0
          } else if (f.kind === "i") {
            i32View ??= new Int32Array(out.buffer, out.byteOffset, out.length)
            for (let c = 0; c < len; c++) i32View[dst + c] = arr[c]! | 0
            for (let c = len; c < f.comps; c++) i32View[dst + c] = 0
          } else {
            u32View ??= new Uint32Array(out.buffer, out.byteOffset, out.length)
            for (let c = 0; c < len; c++) u32View[dst + c] = arr[c]! >>> 0
            for (let c = len; c < f.comps; c++) u32View[dst + c] = 0
          }
        }
      }
      return out
    },
  }
}

export interface WgslSlot<T extends number | boolean | string> {
  readonly kind: "wgsl-slot"
  readonly name: string
  readonly defaultValue: T
}

export function wgslSlot<T extends number | boolean | string>(name: string, defaultValue: T): WgslSlot<T> {
  return { kind: "wgsl-slot", name, defaultValue }
}

export type WgslDependency = WgslStruct<Record<string, WgslFieldType>> | WgslSnippet

export interface WgslSnippet {
  readonly kind: "wgsl-snippet"
  readonly id: string
  readonly uses: readonly WgslDependency[]
  readonly render: (ctx: WgslResolveContext) => string
}

export interface WgslResolveContext {
  get<T extends number | boolean | string>(slot: WgslSlot<T>): T
}

export function wgslSnippet(
  id: string,
  render: string | ((ctx: WgslResolveContext) => string),
  uses: readonly WgslDependency[] = [],
): WgslSnippet {
  return {
    kind: "wgsl-snippet",
    id,
    uses,
    render: typeof render === "function" ? render : () => render,
  }
}

export type SlotPair<T extends number | boolean | string = number | boolean | string> = readonly [WgslSlot<T>, T]

/**
 * Resolves a root WGSL snippet and all transitive `uses` dependencies in topological order,
 * applying any slot overrides for compile-time specialization.
 */
export function resolveWgsl(root: WgslSnippet, slotOverrides: readonly SlotPair<any>[] = []): string {
  const slotMap = new Map<WgslSlot<any>, any>()
  for (const [slot, val] of slotOverrides) {
    slotMap.set(slot, val)
  }
  const ctx: WgslResolveContext = {
    get<T extends number | boolean | string>(slot: WgslSlot<T>): T {
      return (slotMap.has(slot) ? slotMap.get(slot) : slot.defaultValue) as T
    },
  }

  const visited = new Set<string>()
  const chunks: string[] = []

  const visit = (dep: WgslDependency): void => {
    const key = dep.kind === "wgsl-struct" ? `struct:${dep.name}` : `snippet:${dep.id}`
    if (visited.has(key)) return
    visited.add(key)
    if (dep.kind === "wgsl-struct") {
      chunks.push(dep.wgsl)
    } else {
      for (const child of dep.uses) visit(child)
      const code = dep.render(ctx).trim()
      if (code) chunks.push(code)
    }
  }

  visit(root)
  return chunks.join("\n\n")
}
