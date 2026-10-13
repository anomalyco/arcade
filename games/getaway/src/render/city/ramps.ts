import type { Ramp } from "../../../shared/sim/city"
import { MAT, type Mesh, type Rgb } from "../mesh"

/** Two closed wedges share the exact simulation crest. Painted edge bands leave the steel deck readable. */
export function ramps(m: Mesh, list: readonly Ramp[]) {
  for (const r of list) {
    const fx = Math.sin(r.h), fz = Math.cos(r.h)
    const p = (x: number, y: number, z: number) => [r.x + x * fz + z * fx, y + 0.025, r.z - x * fx + z * fz]
    const w = r.width / 2, lo = -r.length / 2, mid = lo + r.length * r.peak, hi = r.length / 2
    const deck: Rgb = r.kind === "crest" ? [0.19, 0.2, 0.23] : [0.33, 0.34, 0.32]
    for (const [a, ay, b, by] of [[lo, 0, mid, r.height], [mid, r.height, hi, 0]]) {
      const q = [p(-w, ay!, a!), p(-w, by!, b!), p(w, by!, b!), p(w, ay!, a!)]
      m.facet(q[0]!, q[1]!, q[2]!, deck, MAT.flat)
      m.facet(q[0]!, q[2]!, q[3]!, deck, MAT.flat)
      for (const s of [-1, 1]) {
        const x = s * w
        if (s < 0) m.quad(p(x, 0, a!), p(x, 0, b!), p(x, by!, b!), p(x, ay!, a!), [-fz, 0, fx], [0.18, 0.19, 0.2])
        else m.quad(p(x, 0, b!), p(x, 0, a!), p(x, ay!, a!), p(x, by!, b!), [fz, 0, -fx], [0.18, 0.19, 0.2])
      }
      const count = Math.ceil((b! - a!) / 0.65)
      for (let i = 0; i < count; i++) {
        const t0 = i / count, t1 = (i + 1) / count
        const z0 = a! + (b! - a!) * t0, z1 = a! + (b! - a!) * t1
        const y0 = ay! + (by! - ay!) * t0 + 0.012, y1 = ay! + (by! - ay!) * t1 + 0.012
        const color: Rgb = i % 2 ? [0.12, 0.12, 0.12] : [0.95, 0.65, 0.12]
        for (const x of [-w, w - 0.3]) {
          m.facet(p(x, y0, z0), p(x, y1, z1), p(x + 0.3, y1, z1), color, MAT.flat)
          m.facet(p(x, y0, z0), p(x + 0.3, y1, z1), p(x + 0.3, y0, z0), color, MAT.flat)
        }
      }
    }
  }
}
