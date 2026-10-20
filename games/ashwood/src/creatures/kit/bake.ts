import { decimate, adjacency, taubin } from "./decimate"
import type { BoneDef, CreatureData } from "./format"
import { meshSdf } from "./mesher"
import { Tag, type SdfModel, type V3 } from "./sdf"

// Turns SDF parts into one skinned creature mesh: polygonise each part at its own resolution, Taubin-smooth, decimate
// to its triangle budget, then bake per-vertex data straight from the fields:
//   normals    SDF gradient (sharper than the decimated mesh could give)
//   ao         SDF ambient occlusion over every part (5 taps along the normal)
//   curvature  SDF Laplacian (convex ridges vs folds and cavities)
//   thinness   inward ray length to the far side (fingers, ears and webbing glow under backlight)
//   bone/horn  material tags blended from the owning shapes
//   weights    per-bone ownership: each shape belongs to a bone; nearby shapes vote with exp(-Δd/σ), top four kept,
//              then smoothed over the mesh so joints bend softly.

export class SkeletonBuilder {
  bones: BoneDef[] = []
  private byName = new Map<string, number>()
  add(name: string, parent: string | null, head: V3, tail?: V3): number {
    const p = parent === null ? -1 : this.get(parent)
    const i = this.bones.length
    this.bones.push({ name, parent: p, head: [...head], tail: [...(tail ?? [head[0], head[1] + 0.05, head[2]])] })
    this.byName.set(name, i)
    return i
  }
  get(name: string): number {
    const i = this.byName.get(name)
    if (i === undefined) throw new Error(`no bone ${name}`)
    return i
  }
  setTail(name: string, tail: V3) {
    this.bones[this.get(name)]!.tail = [...tail]
  }
}

export type PartSpec = {
  name: string
  model: SdfModel
  /** Voxel size in metres. */
  h: number
  /** Triangle budget after decimation. */
  budget: number
  smooth?: number
  /** Fixed bone for rigid parts; otherwise weights come from shape ownership. */
  rigidBone?: number
  /** Skin-weight falloff (metres). */
  sigma?: number
  /** Per-vertex paint: [dirt, blood, (unused)] in 0..1. */
  paint?: (p: V3, n: V3) => [number, number, number]
  /** Scale on thinness (0 disables translucency). */
  thin?: number
  /** Material slot at runtime (default 0). */
  material?: number
  /** Overrides the shapes' `dangle` (0 = pinned, 1 = swings freely) per vertex. */
  dangle?: (p: V3) => number
}

const u8 = (x: number) => Math.max(0, Math.min(255, Math.round(x * 255)))

export function bakeCreature(bones: BoneDef[], parts: PartSpec[], log: (s: string) => void = () => {}): CreatureData {
  const occ = (x: number, y: number, z: number) => {
    let d = Infinity
    for (const p of parts) d = Math.min(d, p.model.eval(x, y, z))
    return d
  }
  const P: number[] = []
  const N: number[] = []
  const I: number[] = []
  const SI: number[] = []
  const SW: number[] = []
  const A: number[] = []
  const Bt: number[] = []
  const F: number[] = []
  const ranges: CreatureData["parts"] = []
  for (const part of parts) {
    let t = performance.now()
    const raw = meshSdf(part.model, part.h)
    log(`${part.name}: surface nets ${raw.indices.length / 3} tris in ${((performance.now() - t) / 1000).toFixed(1)} s`)
    t = performance.now()
    if (part.smooth !== 0) taubin(raw, part.smooth ?? 2)
    const mesh = decimate(raw, part.budget)
    log(`${part.name}: decimated to ${mesh.indices.length / 3} in ${((performance.now() - t) / 1000).toFixed(1)} s`)
    t = performance.now()
    const base = P.length / 3
    const nv = mesh.positions.length / 3
    const weights: Map<number, number>[] = []
    const m = part.model
    for (let v = 0; v < nv; v++) {
      const x = mesh.positions[v * 3]!
      const y = mesh.positions[v * 3 + 1]!
      const z = mesh.positions[v * 3 + 2]!
      const n = m.normal(x, y, z, Math.max(0.0015, part.h * 0.9))
      P.push(x, y, z)
      N.push(n[0], n[1], n[2])
      // AO from every part.
      let ao = 0
      let w = 1
      for (let i = 1; i <= 5; i++) {
        const s = 0.012 * i * i * 0.6
        const d = occ(x + n[0] * s, y + n[1] * s, z + n[2] * s)
        ao += w * Math.max(0, s - d)
        w *= 0.6
      }
      ao = Math.max(0, 1 - ao * 9)
      // Laplacian curvature at fold scale.
      // Two scales: folds (8 mm) and fibre grooves (3 mm).
      const d0 = m.eval(x, y, z)
      const lapAt = (e: number) => (m.eval(x + e, y, z) + m.eval(x - e, y, z) + m.eval(x, y + e, z) + m.eval(x, y - e, z) + m.eval(x, y, z + e) + m.eval(x, y, z - e) - 6 * d0) / (e * e)
      const curv = Math.max(0, Math.min(1, 0.5 + lapAt(0.009) / 170 + lapAt(0.004) / 1800))
      // Thickness: sphere-trace inward to the far side.
      let th = 0.004
      for (let it = 0; it < 24 && th < 0.2; it++) {
        const d = m.eval(x - n[0] * th, y - n[1] * th, z - n[2] * th)
        if (d > 0) break
        th += Math.max(-d, 0.003)
      }
      const thin = (part.thin ?? 1) * Math.max(0, Math.min(1, 1 - (th - 0.012) / 0.035))
      // Tags and bone weights from shape ownership.
      const near = m.nearShapes(x, y, z, 0.08)
      let dmin = Infinity
      const ds = near.map((s) => {
        const d = s.d(x, y, z)
        if (d < dmin) dmin = d
        return d
      })
      const sigma = part.sigma ?? 0.018
      const tagW = [0, 0, 0, 0]
      let dg = 0
      let dgW = 0
      const bw = new Map<number, number>()
      // Fibre direction: the axes of the closest shapes, sign-aligned and blended.
      let fx = 0
      let fy = 0
      let fz = 0
      let fa = 0
      let fw = 0
      near.forEach((s, i) => {
        if (!s.axis || s.ghost) return
        const wt = Math.exp(-(ds[i]! - dmin) / 0.006)
        if (wt < 0.02) return
        let [ax, ay, az] = s.axis
        if (fw > 0 && ax * fx + ay * fy + az * fz < 0) [ax, ay, az] = [-ax, -ay, -az]
        fx += ax * wt
        fy += ay * wt
        fz += az * wt
        fa += (s.fibre ?? 0) * wt
        fw += wt
      })
      {
        // Project onto the surface tangent plane.
        const dn = fx * n[0] + fy * n[1] + fz * n[2]
        fx -= dn * n[0]
        fy -= dn * n[1]
        fz -= dn * n[2]
        const fl = Math.hypot(fx, fy, fz) || 1
        F.push(u8(fx / fl * 0.5 + 0.5), u8(fy / fl * 0.5 + 0.5), u8(fz / fl * 0.5 + 0.5), u8(fw > 0 ? fa / fw : 0))
      }
      near.forEach((s, i) => {
        const wt = Math.exp(-(ds[i]! - dmin) / sigma)
        if (wt < 0.01) return
        if (!s.ghost) {
          const tw = Math.exp(-(ds[i]! - dmin) / 0.004)
          tagW[s.tag] = Math.max(tagW[s.tag]!, tw)
          dgW += tw
          dg += tw * (s.dangle ?? 0)
        }
        bw.set(s.bone, Math.max(bw.get(s.bone) ?? 0, wt))
      })
      if (part.rigidBone !== undefined) weights.push(new Map([[part.rigidBone, 1]]))
      else weights.push(bw.size ? bw : new Map([[0, 1]]))
      const ts = tagW[0]! + tagW[1]! + tagW[2]! + tagW[3]! || 1
      const bone = (tagW[Tag.Bone]! + tagW[Tag.Tooth]!) / ts
      const horn = (tagW[Tag.Horn]! + tagW[Tag.Tooth]! * 0.25) / ts
      A.push(u8(ao), u8(curv), u8(bone), u8(horn))
      const paint = part.paint ? part.paint([x, y, z], n) : [0, 0, 0]
      // Teeth stay ivory: only a little of the mouth's blood on them.
      const toothW = tagW[Tag.Tooth]! / ts
      paint[1] = paint[1]! * (1 - 0.8 * toothW)
      Bt.push(u8(paint[0]!), u8(paint[1]!), u8(part.dangle ? part.dangle([x, y, z]) : dgW > 0 ? dg / dgW : 0), u8(thin))
    }
    // Smooth weights over the mesh (2 passes) so joints bend softly.
    if (part.rigidBone === undefined) {
      const adj = adjacency(nv, mesh.indices)
      for (let pass = 0; pass < 2; pass++) {
        const next: Map<number, number>[] = []
        for (let v = 0; v < nv; v++) {
          const acc = new Map<number, number>()
          const addW = (src: Map<number, number>, f: number) => {
            let s = 0
            for (const w of src.values()) s += w
            for (const [b, w] of src) acc.set(b, (acc.get(b) ?? 0) + (w / s) * f)
          }
          addW(weights[v]!, 1)
          const s = adj.start[v]!
          const e = adj.start[v + 1]!
          for (let k = s; k < e; k++) addW(weights[adj.list[k]!]!, 1 / (e - s))
          next.push(acc)
        }
        for (let v = 0; v < nv; v++) weights[v] = next[v]!
      }
    }
    for (const wmap of weights) {
      const top = [...wmap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
      let s = 0
      for (const [, w] of top) s += w
      // Quantise to bytes that sum to exactly 255.
      const q = top.map(([, w]) => Math.round((w / s) * 255))
      const diff = 255 - q.reduce((a, b) => a + b, 0)
      q[0]! += diff
      for (let k = 0; k < 4; k++) {
        SI.push(top[k]?.[0] ?? 0)
        SW.push(q[k] ?? 0)
      }
    }
    const start = I.length
    for (let k = 0; k < mesh.indices.length; k++) I.push(mesh.indices[k]! + base)
    ranges.push({ name: part.name, start, count: mesh.indices.length, material: part.material ?? 0 })
    log(`${part.name}: baked ${nv} vertices in ${((performance.now() - t) / 1000).toFixed(1)} s`)
  }
  return {
    bones,
    parts: ranges,
    positions: Float32Array.from(P),
    normals: Float32Array.from(N),
    indices: Uint32Array.from(I),
    skinIndex: Uint16Array.from(SI),
    skinWeight: Uint8Array.from(SW),
    attrA: Uint8Array.from(A),
    attrB: Uint8Array.from(Bt),
    fiber: Uint8Array.from(F),
  }
}
