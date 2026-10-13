// Minimal glTF 2.0 binary (.glb) reader for the ship viewer: no dependencies, defensive about hand-written files.
// Reads the container, the JSON, float POSITION/NORMAL accessors (with byteStride), u8/u16/u32 or absent indices,
// triangle lists/strips/fans, node TRS/matrix hierarchy and material baseColorFactor. Textures, skins, morph targets,
// sparse and quantized accessors are not supported and fail with a message naming the offending part.

export type Mat4d = Float64Array

export type GlbPrimitive = {
  /** Triangle soup in the node's local frame: 9 floats per triangle. */
  positions: Float32Array
  /** Per-corner normals matching `positions`, or null when the file has none. */
  normals: Float32Array | null
  /** Linear RGBA from pbrMetallicRoughness.baseColorFactor (white when absent). */
  color: [number, number, number, number]
  material: string
}

export type GlbNode = {
  name: string
  /** Names from the scene root down to this node, inclusive. */
  path: string[]
  /** Local transform (column-major) and the product of every ancestor's with it. */
  local: Mat4d
  world: Mat4d
  prims: GlbPrimitive[]
}

export type Glb = { generator: string; nodes: GlbNode[]; triangles: number }

type Json = {
  asset?: { generator?: string }
  scene?: number
  scenes?: { nodes?: number[] }[]
  nodes?: { name?: string; mesh?: number; children?: number[]; matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[] }[]
  meshes?: { name?: string; primitives?: { attributes?: Record<string, number>; indices?: number; material?: number; mode?: number }[] }[]
  materials?: { name?: string; pbrMetallicRoughness?: { baseColorFactor?: number[] } }[]
  accessors?: { bufferView?: number; byteOffset?: number; componentType?: number; normalized?: boolean; count?: number; type?: string; sparse?: unknown }[]
  bufferViews?: { buffer?: number; byteOffset?: number; byteLength?: number; byteStride?: number }[]
  buffers?: { byteLength?: number; uri?: string }[]
}

const GLB_MAGIC = 0x46546c67
const CHUNK_JSON = 0x4e4f534a
const CHUNK_BIN = 0x004e4942
const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }
const BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }

export function identity(): Mat4d {
  const m = new Float64Array(16)
  m[0] = m[5] = m[10] = m[15] = 1
  return m
}

export function multiply(a: Mat4d, b: Mat4d): Mat4d {
  const o = new Float64Array(16)
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r]! * b[c * 4]! + a[4 + r]! * b[c * 4 + 1]! + a[8 + r]! * b[c * 4 + 2]! + a[12 + r]! * b[c * 4 + 3]!
  return o
}

function fromTRS(t: number[] = [0, 0, 0], q: number[] = [0, 0, 0, 1], s: number[] = [1, 1, 1]): Mat4d {
  const [x, y, z, w] = [q[0] ?? 0, q[1] ?? 0, q[2] ?? 0, q[3] ?? 1]
  const [sx, sy, sz] = [s[0] ?? 1, s[1] ?? 1, s[2] ?? 1]
  const m = new Float64Array(16)
  m[0] = (1 - 2 * (y * y + z * z)) * sx
  m[1] = 2 * (x * y + z * w) * sx
  m[2] = 2 * (x * z - y * w) * sx
  m[4] = 2 * (x * y - z * w) * sy
  m[5] = (1 - 2 * (x * x + z * z)) * sy
  m[6] = 2 * (y * z + x * w) * sy
  m[8] = 2 * (x * z + y * w) * sz
  m[9] = 2 * (y * z - x * w) * sz
  m[10] = (1 - 2 * (x * x + y * y)) * sz
  m[12] = t[0] ?? 0
  m[13] = t[1] ?? 0
  m[14] = t[2] ?? 0
  m[15] = 1
  return m
}

const finite = (v: unknown, n: number): v is number[] => Array.isArray(v) && v.length === n && v.every((x) => typeof x === "number" && Number.isFinite(x))

export function parseGlb(buf: ArrayBuffer): Glb {
  if (buf.byteLength < 20) throw new Error("glb: file too short")
  const dv = new DataView(buf)
  if (dv.getUint32(0, true) !== GLB_MAGIC) throw new Error("glb: bad magic (not a binary glTF)")
  if (dv.getUint32(4, true) !== 2) throw new Error(`glb: version ${dv.getUint32(4, true)}, expected 2`)
  const total = Math.min(dv.getUint32(8, true), buf.byteLength)
  let json: Json | null = null
  let bin: Uint8Array | null = null
  for (let off = 12; off + 8 <= total; ) {
    const len = dv.getUint32(off, true)
    const type = dv.getUint32(off + 4, true)
    const start = off + 8
    if (start + len > total) throw new Error("glb: chunk runs past the end of the file")
    if (type === CHUNK_JSON && !json) json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, start, len))) as Json
    else if (type === CHUNK_BIN && !bin) bin = new Uint8Array(buf, start, len)
    off = start + len + ((4 - (len % 4)) % 4)
  }
  if (!json) throw new Error("glb: no JSON chunk")
  const j = json

  const view = (index: number, what: string): { bytes: Uint8Array; stride: number } => {
    const bv = j.bufferViews?.[index]
    if (!bv) throw new Error(`glb: ${what} uses missing bufferView ${index}`)
    if ((bv.buffer ?? 0) !== 0 || j.buffers?.[bv.buffer ?? 0]?.uri) throw new Error(`glb: ${what} uses an external buffer`)
    if (!bin) throw new Error("glb: no BIN chunk")
    const off = bv.byteOffset ?? 0
    const len = bv.byteLength ?? 0
    if (off + len > bin.byteLength) throw new Error(`glb: bufferView ${index} runs past the BIN chunk`)
    return { bytes: new Uint8Array(bin.buffer, bin.byteOffset + off, len), stride: bv.byteStride ?? 0 }
  }

  /** Reads an accessor as numbers, `comps` per element. */
  const read = (index: number, what: string, want?: string): { data: Float64Array; comps: number; count: number } => {
    const a = j.accessors?.[index]
    if (!a) throw new Error(`glb: ${what} uses missing accessor ${index}`)
    if (a.sparse) throw new Error(`glb: ${what} is a sparse accessor`)
    const comps = COMPONENTS[a.type ?? ""]
    const size = BYTES[a.componentType ?? 0]
    if (!comps || !size) throw new Error(`glb: ${what} has unsupported type ${a.type}/${a.componentType}`)
    if (want && a.type !== want) throw new Error(`glb: ${what} is ${a.type}, expected ${want}`)
    const count = a.count ?? 0
    const data = new Float64Array(count * comps)
    if (a.bufferView === undefined) return { data, comps, count }
    const { bytes, stride } = view(a.bufferView, what)
    const step = stride || comps * size
    const base = a.byteOffset ?? 0
    if (count && base + (count - 1) * step + comps * size > bytes.byteLength) throw new Error(`glb: ${what} runs past its bufferView`)
    const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const ct = a.componentType!
    for (let i = 0; i < count; i++)
      for (let c = 0; c < comps; c++) {
        const o = base + i * step + c * size
        data[i * comps + c] =
          ct === 5126 ? d.getFloat32(o, true) : ct === 5125 ? d.getUint32(o, true) : ct === 5123 ? d.getUint16(o, true) : ct === 5122 ? d.getInt16(o, true) : ct === 5121 ? d.getUint8(o) : d.getInt8(o)
      }
    return { data, comps, count }
  }

  /** Corner order of the triangles for a primitive mode, as indices into the vertex arrays. */
  const corners = (mode: number, idx: ArrayLike<number>, what: string): number[] => {
    const out: number[] = []
    const n = idx.length
    if (mode === 4) for (let i = 0; i + 2 < n; i += 3) out.push(idx[i]!, idx[i + 1]!, idx[i + 2]!)
    else if (mode === 5) for (let i = 0; i + 2 < n; i++) i % 2 ? out.push(idx[i + 1]!, idx[i]!, idx[i + 2]!) : out.push(idx[i]!, idx[i + 1]!, idx[i + 2]!)
    else if (mode === 6) for (let i = 1; i + 1 < n; i++) out.push(idx[0]!, idx[i]!, idx[i + 1]!)
    else throw new Error(`glb: ${what} has primitive mode ${mode} (only triangles are supported)`)
    return out
  }

  const meshCache = new Map<number, GlbPrimitive[]>()
  const primitives = (meshIndex: number): GlbPrimitive[] => {
    const cached = meshCache.get(meshIndex)
    if (cached) return cached
    const mesh = j.meshes?.[meshIndex]
    if (!mesh) throw new Error(`glb: missing mesh ${meshIndex}`)
    const out: GlbPrimitive[] = []
    ;(mesh.primitives ?? []).forEach((p, pi) => {
      const what = `mesh "${mesh.name ?? meshIndex}" primitive ${pi}`
      const posIndex = p.attributes?.POSITION
      if (posIndex === undefined) throw new Error(`glb: ${what} has no POSITION`)
      const pos = read(posIndex, `${what} POSITION`, "VEC3")
      const nrmIndex = p.attributes?.NORMAL
      const nrm = nrmIndex === undefined ? null : read(nrmIndex, `${what} NORMAL`, "VEC3")
      if (nrm && nrm.count !== pos.count) throw new Error(`glb: ${what} NORMAL count differs from POSITION`)
      const idx = p.indices === undefined ? Array.from({ length: pos.count }, (_, i) => i) : read(p.indices, `${what} indices`, "SCALAR").data
      const tri = corners(p.mode ?? 4, idx, what)
      const positions = new Float32Array(tri.length * 3)
      const normals = nrm ? new Float32Array(tri.length * 3) : null
      tri.forEach((v, k) => {
        if (v >= pos.count) throw new Error(`glb: ${what} index ${v} out of range`)
        for (let c = 0; c < 3; c++) {
          positions[k * 3 + c] = pos.data[v * 3 + c]!
          if (normals) normals[k * 3 + c] = nrm!.data[v * 3 + c]!
        }
      })
      const mat = p.material === undefined ? undefined : j.materials?.[p.material]
      const f = mat?.pbrMetallicRoughness?.baseColorFactor
      const color: [number, number, number, number] = finite(f, 4) ? [f[0]!, f[1]!, f[2]!, f[3]!] : [1, 1, 1, 1]
      out.push({ positions, normals, color, material: mat?.name ?? `material ${p.material ?? "default"}` })
    })
    meshCache.set(meshIndex, out)
    return out
  }

  const nodes: GlbNode[] = []
  const visiting = new Set<number>()
  const visit = (index: number, parent: Mat4d, path: string[]) => {
    const n = j.nodes?.[index]
    if (!n) throw new Error(`glb: missing node ${index}`)
    if (visiting.has(index)) throw new Error(`glb: node ${index} is its own ancestor`)
    visiting.add(index)
    const local = finite(n.matrix, 16) ? Float64Array.from(n.matrix) : fromTRS(n.translation, n.rotation, n.scale)
    const world = multiply(parent, local)
    const name = n.name ?? `node ${index}`
    const here = [...path, name]
    if (n.mesh !== undefined) nodes.push({ name, path: here, local, world, prims: primitives(n.mesh) })
    for (const c of n.children ?? []) visit(c, world, here)
    visiting.delete(index)
  }
  const sceneRoots = j.scenes?.[j.scene ?? 0]?.nodes
  const roots =
    sceneRoots ??
    (() => {
      const children = new Set((j.nodes ?? []).flatMap((n) => n.children ?? []))
      return (j.nodes ?? []).map((_, i) => i).filter((i) => !children.has(i))
    })()
  for (const r of roots) visit(r, identity(), [])
  const triangles = nodes.reduce((s, n) => s + n.prims.reduce((t, p) => t + p.positions.length / 9, 0), 0)
  return { generator: j.asset?.generator ?? "", nodes, triangles }
}
