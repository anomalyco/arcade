/**
 * Minimal, zero-dependency typed WGSL struct, slot specialization, and module composition system.
 *
 * Solves the three real pains of raw template-string WGSL in Arcade:
 * 1. Struct layout bugs & magic `u0.x..u15.w` swizzles: `wgslStruct` computes exact WebGPU alignment/padding,
 *    emits readable WGSL `struct Name { field: type, ... }`, and generates a type-checked `pack(data, out)`
 *    that writes named TypeScript properties to their exact aligned float offsets.
 * 2. Fragile `.replace()` string surgery: `wgslModule` & `wgslFn` compose named snippets and hooks with
 *    automatic dependency deduplication (`uses: [...]`).
 * 3. Uber-shader VGPR register spills: `wgslSlot` specializes compile-time branches (`Noir` vs `Painterly`)
 *    or WGSL `override` constants so inactive branches are stripped before Metal register allocation.
 */

export type WgslScalarType = "f32" | "i32" | "u32"
export type WgslVecType = "vec2f" | "vec2i" | "vec2u" | "vec3f" | "vec3i" | "vec3u" | "vec4f" | "vec4i" | "vec4u"
export type WgslMatType = "mat4x4f"
export type WgslFieldType = WgslScalarType | WgslVecType | WgslMatType

export type JsValueForWgsl<T extends WgslFieldType> = T extends WgslScalarType
  ? number
  : T extends "vec2f" | "vec2i" | "vec2u"
    ? readonly [number, number]
    : T extends "vec3f" | "vec3i" | "vec3u"
      ? readonly [number, number, number]
      : T extends "vec4f" | "vec4i" | "vec4u"
        ? readonly [number, number, number, number]
        : T extends "mat4x4f"
          ? Float32Array | readonly number[]
          : never

export interface WgslFieldLayout {
  readonly name: string
  readonly type: WgslFieldType
  readonly byteOffset: number
  readonly floatOffset: number
  readonly byteSize: number
  readonly byteAlign: number
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

const TYPE_METRICS: Record<WgslFieldType, { align: number; size: number; comps: number; kind: "f" | "i" | "u" }> = {
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

const alignUp = (offset: number, align: number): number => Math.ceil(offset / align) * align

/**
 * Defines a WGSL struct with automatic WebGPU std140/uniform alignment calculation,
 * explicit pad insertion where required for uniform buffers, and a fast typed `pack()` method.
 */
export function wgslStruct<Schema extends Record<string, WgslFieldType>>(
  name: string,
  schema: Schema,
): WgslStruct<Schema> {
  const fields: WgslFieldLayout[] = []
  const offsetMap = new Map<string, number>()
  const lines: string[] = [`struct ${name} {`]
  let byteOffset = 0
  let maxAlign = 16 // Uniform buffers require 16-byte struct alignment

  for (const [key, type] of Object.entries(schema)) {
    const m = TYPE_METRICS[type]
    if (!m) throw new Error(`Unknown WGSL type "${String(type)}" for field "${key}" in struct ${name}`)
    const aligned = alignUp(byteOffset, m.align)
    byteOffset = aligned
    maxAlign = Math.max(maxAlign, m.align)
    const layout: WgslFieldLayout = {
      name: key,
      type,
      byteOffset,
      floatOffset: byteOffset >>> 2,
      byteSize: m.size,
      byteAlign: m.align,
    }
    fields.push(layout)
    offsetMap.set(key, layout.floatOffset)
    lines.push(`  ${key}: ${type},`)
    byteOffset += m.size
  }

  const totalBytes = alignUp(byteOffset, maxAlign)
  const trailingPadFloats = (totalBytes - byteOffset) >>> 2
  for (let p = 0; p < trailingPadFloats; p++) {
    lines.push(`  _pad_tail_${p}: f32,`)
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
      const i32View = new Int32Array(out.buffer, out.byteOffset, out.length)
      const u32View = new Uint32Array(out.buffer, out.byteOffset, out.length)
      for (let i = 0; i < fields.length; i++) {
        const f = fields[i]!
        const m = TYPE_METRICS[f.type]
        const v = (values as Record<string, unknown>)[f.name]
        const dst = floatOffset + f.floatOffset
        if (m.comps === 1) {
          const num = v as number
          if (m.kind === "f") out[dst] = num
          else if (m.kind === "i") i32View[dst] = num | 0
          else u32View[dst] = num >>> 0
        } else {
          const arr = v as readonly number[]
          if (m.kind === "f") {
            for (let c = 0; c < m.comps; c++) out[dst + c] = arr[c]!
          } else if (m.kind === "i") {
            for (let c = 0; c < m.comps; c++) i32View[dst + c] = arr[c]! | 0
          } else {
            for (let c = 0; c < m.comps; c++) u32View[dst + c] = arr[c]! >>> 0
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
