/**
 * The `.prop` mesh file written by `scripts/props/blender-cleanup.py`. Little-endian:
 *
 *   "PROP"  u16 version (1)  u16 lodCount
 *   f32×6   bounds min xyz, max xyz (metres, game space: +Y up, front +Z, pivot on the floor)
 *   per LOD: u32 vertexCount, u32 indexCount, u32 indexBytes (2 or 4)
 *   per LOD: vertices (14 bytes each), then indices, the index data padded to a multiple of 4 bytes
 *
 * A vertex is u16×3 position quantised over the bounds, i8×3 normal, u8 kit material id, u8×3 sRGB base colour sampled
 * from the generated texture, u8 baked ambient occlusion (255 = open).
 */

export const PROP_MAGIC = 0x504f5250 // "PROP" read as a little-endian u32
export const PROP_VERSION = 1
export const PROP_VERTEX_BYTES = 14

export type PropLod = {
  /** Metres, xyz per vertex. */
  positions: Float32Array
  /** Unit normals, xyz per vertex. */
  normals: Float32Array
  /** sRGB bytes, rgb per vertex. */
  colors: Uint8Array
  /** Ambient occlusion per vertex, 0 closed to 255 open. */
  ao: Uint8Array
  /** Kit material id per vertex (`MAT` in `gpu/mesh`). */
  mats: Uint8Array
  indices: Uint16Array | Uint32Array
}

export type PropAsset = { min: readonly [number, number, number]; max: readonly [number, number, number]; lods: PropLod[] }

export function decodeProp(buffer: ArrayBuffer): PropAsset {
  const view = new DataView(buffer)
  if (view.getUint32(0, true) !== PROP_MAGIC) throw new Error("not a .prop file")
  const version = view.getUint16(4, true)
  if (version !== PROP_VERSION) throw new Error(`unsupported .prop version ${version}`)
  const lodCount = view.getUint16(6, true)
  const min = [view.getFloat32(8, true), view.getFloat32(12, true), view.getFloat32(16, true)] as const
  const max = [view.getFloat32(20, true), view.getFloat32(24, true), view.getFloat32(28, true)] as const
  const heads: [number, number, number][] = []
  let off = 32
  for (let i = 0; i < lodCount; i++, off += 12) heads.push([view.getUint32(off, true), view.getUint32(off + 4, true), view.getUint32(off + 8, true)])
  const span = [max[0] - min[0], max[1] - min[1], max[2] - min[2]]
  const lods: PropLod[] = []
  for (const [vertexCount, indexCount, indexBytes] of heads) {
    const positions = new Float32Array(vertexCount * 3)
    const normals = new Float32Array(vertexCount * 3)
    const colors = new Uint8Array(vertexCount * 3)
    const ao = new Uint8Array(vertexCount)
    const mats = new Uint8Array(vertexCount)
    for (let v = 0; v < vertexCount; v++, off += PROP_VERTEX_BYTES) {
      for (let k = 0; k < 3; k++) {
        positions[v * 3 + k] = min[k]! + (view.getUint16(off + k * 2, true) / 65535) * span[k]!
        normals[v * 3 + k] = view.getInt8(off + 6 + k) / 127
        colors[v * 3 + k] = view.getUint8(off + 10 + k)
      }
      mats[v] = view.getUint8(off + 9)
      ao[v] = view.getUint8(off + 13)
    }
    const indices = indexBytes === 4 ? new Uint32Array(indexCount) : new Uint16Array(indexCount)
    for (let i = 0; i < indexCount; i++, off += indexBytes) indices[i] = indexBytes === 4 ? view.getUint32(off, true) : view.getUint16(off, true)
    off += indexPad(indexCount * indexBytes)
    lods.push({ positions, normals, colors, ao, mats, indices })
  }
  return { min, max, lods }
}

/** Inverse of `decodeProp`, for tests and tools (the pipeline writes files from Blender's Python). */
export function encodeProp(asset: PropAsset): ArrayBuffer {
  const { min, max, lods } = asset
  let size = 32 + lods.length * 12
  for (const l of lods) {
    const n = l.positions.length / 3
    size += n * PROP_VERTEX_BYTES
    size += (l.indices.length * (n > 65535 ? 4 : 2) + 3) & ~3
  }
  const buf = new ArrayBuffer(size)
  const view = new DataView(buf)
  view.setUint32(0, PROP_MAGIC, true)
  view.setUint16(4, PROP_VERSION, true)
  view.setUint16(6, lods.length, true)
  for (let k = 0; k < 3; k++) {
    view.setFloat32(8 + k * 4, min[k]!, true)
    view.setFloat32(20 + k * 4, max[k]!, true)
  }
  let off = 32
  for (const l of lods) {
    const n = l.positions.length / 3
    view.setUint32(off, n, true)
    view.setUint32(off + 4, l.indices.length, true)
    view.setUint32(off + 8, n > 65535 ? 4 : 2, true)
    off += 12
  }
  const span = [max[0] - min[0], max[1] - min[1], max[2] - min[2]]
  for (const l of lods) {
    const n = l.positions.length / 3
    for (let v = 0; v < n; v++, off += PROP_VERTEX_BYTES) {
      for (let k = 0; k < 3; k++) {
        const t = span[k]! > 0 ? (l.positions[v * 3 + k]! - min[k]!) / span[k]! : 0
        view.setUint16(off + k * 2, Math.round(Math.max(0, Math.min(1, t)) * 65535), true)
        view.setInt8(off + 6 + k, Math.round(Math.max(-1, Math.min(1, l.normals[v * 3 + k]!)) * 127))
        view.setUint8(off + 10 + k, l.colors[v * 3 + k]!)
      }
      view.setUint8(off + 9, l.mats[v]!)
      view.setUint8(off + 13, l.ao[v]!)
    }
    const wide = n > 65535
    for (let i = 0; i < l.indices.length; i++, off += wide ? 4 : 2) {
      if (wide) view.setUint32(off, l.indices[i]!, true)
      else view.setUint16(off, l.indices[i]!, true)
    }
    off += indexPad(l.indices.length * (wide ? 4 : 2))
  }
  return buf
}

/** Index data is padded to a whole number of 4-byte words (by its own length, not the file offset). */
const indexPad = (bytes: number): number => (4 - (bytes % 4)) % 4

export const propTriangles = (lod: PropLod): number => lod.indices.length / 3
