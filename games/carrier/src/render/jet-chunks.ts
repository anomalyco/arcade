// A jet model (plane-glb.ts) cut into the pieces it breaks into when it is destroyed: nose, forward and centre
// fuselage, the engine section, inner and outer wing panels, both fins, both stabilisers and the canopy (plus the bay
// doors on a jet that has them). The body is one GLB mesh, so it is split by where each triangle's centroid lies,
// relative to the model's own span and length; the stabilisers, canopy and doors are already separate pieces.
// Each chunk's vertices are re-centred on its own middle (`centre`, model space), so it can tumble about it.
import { FLOATS_PER_VERT } from "./mesh"
import type { PlaneModel, PlanePiece } from "./plane-glb"

type V3 = [number, number, number]

export type ChunkPart = "nose" | "front" | "core" | "aft" | "wingL" | "wingR" | "tipL" | "tipR" | "finL" | "finR" | "stabL" | "stabR" | "canopy" | "doorL" | "doorR"

export type JetChunk = {
  part: ChunkPart
  /** Build vertices (FLOATS_PER_VERT each) relative to `centre`. */
  verts: number[]
  /** Middle of the chunk in model space (origin at the belly, like the model). */
  centre: V3
  /** Half extents of its box (m): collision radius and how it falls. */
  half: V3
  /** Roughly how heavy (m³ of box), for drag and spin. */
  bulk: number
}

/** Which part a body triangle with centroid (x, y, z) belongs to. */
function partOf(x: number, y: number, z: number, span: number, z0: number, z1: number): ChunkPart {
  const len = z1 - z0
  const ax = Math.abs(x)
  const fuselage = span * 0.27
  if (y > 2.15 && z < z0 + len * 0.45 && ax > 0.35 && ax < span * 0.55) return x > 0 ? "finL" : "finR"
  if (ax > fuselage) {
    if (ax > span * 0.6) return x > 0 ? "tipL" : "tipR"
    return x > 0 ? "wingL" : "wingR"
  }
  if (z > z1 - len * 0.2) return "nose"
  if (z > z1 - len * 0.42) return "front"
  if (z < z0 + len * 0.3) return "aft"
  return "core"
}

/** Splits `model` into its break-up chunks. */
export function jetChunks(model: PlaneModel): JetChunk[] {
  const F = FLOATS_PER_VERT
  const body = model.body
  let span = 0
  let z0 = Infinity
  let z1 = -Infinity
  for (let i = 0; i < body.length; i += F) {
    span = Math.max(span, Math.abs(body[i]!))
    z0 = Math.min(z0, body[i + 2]!)
    z1 = Math.max(z1, body[i + 2]!)
  }
  const raw = new Map<ChunkPart, number[]>()
  const add = (part: ChunkPart, src: ArrayLike<number>, from: number, count: number, dx = 0, dy = 0, dz = 0) => {
    let out = raw.get(part)
    if (!out) raw.set(part, (out = []))
    for (let k = 0; k < count; k++) {
      const s = from + k * F
      out.push(src[s]! + dx, src[s + 1]! + dy, src[s + 2]! + dz)
      for (let j = 3; j < F; j++) out.push(src[s + j]!)
    }
  }
  for (let i = 0; i + 3 * F <= body.length; i += 3 * F) {
    const cx = (body[i]! + body[i + F]! + body[i + 2 * F]!) / 3
    const cy = (body[i + 1]! + body[i + F + 1]! + body[i + 2 * F + 1]!) / 3
    const cz = (body[i + 2]! + body[i + F + 2]! + body[i + 2 * F + 2]!) / 3
    add(partOf(cx, cy, cz, span, z0, z1), body, i, 3)
  }
  add("canopy", model.canopy, 0, model.canopy.length / F)
  const piece = (part: ChunkPart, p: PlanePiece | null) => {
    if (p) add(part, p.verts, 0, p.verts.length / F, p.pivot[0], p.pivot[1], p.pivot[2])
  }
  piece("stabL", model.stabL)
  piece("stabR", model.stabR)
  piece("doorL", model.doorL)
  piece("doorR", model.doorR)
  const chunks: JetChunk[] = []
  for (const [part, v] of raw) {
    if (v.length < 3 * F) continue
    const lo: V3 = [Infinity, Infinity, Infinity]
    const hi: V3 = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i < v.length; i += F)
      for (let a = 0; a < 3; a++) {
        lo[a] = Math.min(lo[a]!, v[i + a]!)
        hi[a] = Math.max(hi[a]!, v[i + a]!)
      }
    const centre: V3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2]
    for (let i = 0; i < v.length; i += F) for (let a = 0; a < 3; a++) v[i + a] = v[i + a]! - centre[a]!
    const half: V3 = [(hi[0] - lo[0]) / 2, (hi[1] - lo[1]) / 2, (hi[2] - lo[2]) / 2]
    chunks.push({ part, verts: v, centre, half, bulk: Math.max(0.05, 8 * half[0] * half[1] * half[2]) })
  }
  return chunks
}
