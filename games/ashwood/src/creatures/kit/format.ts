// Creature mesh container (.bin): a small JSON header (bones, counts) followed by typed arrays. Shared by the offline
// baker (Bun) and the runtime loader, with no three.js dependency.
//
// Layout: "CRT2" | u32 header length | header JSON (UTF-8, padded to 4 bytes) | arrays in ARRAYS order, each 4-aligned.

export type BoneDef = { name: string; parent: number; head: [number, number, number]; tail: [number, number, number] }

export type CreatureData = {
  bones: BoneDef[]
  positions: Float32Array
  normals: Float32Array
  indices: Uint32Array
  /** 4 bone indices per vertex. */
  skinIndex: Uint16Array
  /** 4 weights per vertex, 0..255. */
  skinWeight: Uint8Array
  /** ao, curvature (0.5 = flat), bone, horn. */
  attrA: Uint8Array
  /** dirt, blood, dangle (how freely it sways), thinness. */
  attrB: Uint8Array
  /** Fibre / grain direction in the bind pose (xyz encoded 0..255 as d * 0.5 + 0.5) and fibre amount (w). */
  fiber: Uint8Array
  /** Index ranges of the baked parts; `material` picks the runtime material (default 0). */
  parts: { name: string; start: number; count: number; material?: number }[]
  /** Bake version (the generator's `BAKE_VERSION`); 0 for files baked before versions existed. */
  version?: number
}

const ARRAYS = ["positions", "normals", "indices", "skinIndex", "skinWeight", "attrA", "attrB", "fiber"] as const
type ArrayKey = (typeof ARRAYS)[number]
const CTORS: Record<ArrayKey, Float32ArrayConstructor | Uint32ArrayConstructor | Uint16ArrayConstructor | Uint8ArrayConstructor> = {
  positions: Float32Array,
  normals: Float32Array,
  indices: Uint32Array,
  skinIndex: Uint16Array,
  skinWeight: Uint8Array,
  attrA: Uint8Array,
  attrB: Uint8Array,
  fiber: Uint8Array,
}

export function encodeCreature(d: CreatureData): Uint8Array {
  const lengths = Object.fromEntries(ARRAYS.map((k) => [k, d[k].length]))
  let json = new TextEncoder().encode(JSON.stringify({ bones: d.bones, parts: d.parts, lengths, version: d.version ?? 0 }))
  const pad = (n: number) => (n + 3) & ~3
  let total = 8 + pad(json.length)
  for (const k of ARRAYS) total += pad(d[k].byteLength)
  const out = new Uint8Array(total)
  out.set([67, 82, 84, 50])
  new DataView(out.buffer).setUint32(4, json.length, true)
  out.set(json, 8)
  let o = 8 + pad(json.length)
  for (const k of ARRAYS) {
    out.set(new Uint8Array(d[k].buffer, d[k].byteOffset, d[k].byteLength), o)
    o += pad(d[k].byteLength)
  }
  json = new Uint8Array(0)
  return out
}

export function decodeCreature(buf: ArrayBuffer): CreatureData {
  const u8 = new Uint8Array(buf)
  if (u8[0] !== 67 || u8[1] !== 82 || u8[2] !== 84 || u8[3] !== 50) throw new Error("not a creature file")
  const jl = new DataView(buf).getUint32(4, true)
  const head = JSON.parse(new TextDecoder().decode(u8.subarray(8, 8 + jl))) as { bones: BoneDef[]; parts: CreatureData["parts"]; lengths: Record<ArrayKey, number>; version?: number }
  const pad = (n: number) => (n + 3) & ~3
  let o = 8 + pad(jl)
  const arrays = {} as Record<ArrayKey, Float32Array | Uint32Array | Uint16Array | Uint8Array>
  for (const k of ARRAYS) {
    const C = CTORS[k]
    const n = head.lengths[k]
    arrays[k] = new C(buf, o, n)
    o += pad(n * C.BYTES_PER_ELEMENT)
  }
  const out = { bones: head.bones, parts: head.parts, version: head.version ?? 0, ...(arrays as Pick<CreatureData, ArrayKey>) }
  // Sanity: consistent per-vertex arrays and in-range indices (a truncated or mid-write file fails here, not on the GPU).
  const nv = out.positions.length / 3
  if (out.normals.length !== nv * 3 || out.skinIndex.length !== nv * 4 || out.attrA.length !== nv * 4 || out.indices.length % 3) throw new Error("creature file inconsistent")
  for (let i = 0; i < out.indices.length; i += 997) if (out.indices[i]! >= nv) throw new Error("creature file: index out of range")
  return out
}

