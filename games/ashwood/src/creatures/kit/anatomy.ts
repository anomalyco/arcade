import { SkeletonBuilder } from "./bake"
import { rng } from "./noise"
import { Ellipsoid, FiberCone, Op, RoundCone, SdfModel, Tag, type Shape, add, cross, len, lerp3, madd, norm, perp, scale, sub, type ShapeOpts, type V3 } from "./sdf"

// Sculpting vocabulary on top of the SDF primitives: bones and the anatomy they own are authored together, so every
// shape knows its bone (auto-skinning) and its material tag. Shared by every creature.

export class Anatomy {
  model = new SdfModel()
  skel = new SkeletonBuilder()
  r: () => number
  /** Multiplier on fibre and cord radii (bulk). */
  thick = 1
  constructor(seed = 1) {
    this.r = rng(seed)
  }

  bone(name: string, parent: string | null, head: V3, tail?: V3) {
    return this.skel.add(name, parent, head, tail)
  }
  b(name: string) {
    return this.skel.get(name)
  }

  cap(a: V3, b: V3, ra: number, rb: number, bone: string, o: Omit<ShapeOpts, "bone"> = {}) {
    return this.model.add(new RoundCone(a, b, ra, rb, { k: 0.02, ...o, bone: this.b(bone) }))
  }

  /** Sinew: a round cone wrapped in wandering raised cords. */
  fiber(a: V3, b: V3, ra: number, rb: number, bone: string, o: Omit<ShapeOpts, "bone"> & { amp?: number; count?: number } = {}) {
    ra *= this.thick
    rb *= this.thick
    const amp = o.amp ?? 0.0025
    const count = o.count ?? Math.max(5, Math.round(((ra + rb) / 2) * 260))
    return this.model.add(new FiberCone(a, b, ra, rb, amp, count, this.r() * 100, { k: 0.02, ...o, bone: this.b(bone) }))
  }

  ell(c: V3, r: V3, bone: string, o: Omit<ShapeOpts, "bone"> & { axes?: [V3, V3, V3] } = {}) {
    return this.model.add(new Ellipsoid(c, r, o.axes, { k: 0.02, ...o, bone: this.b(bone) }))
  }

  /** Ellipsoid stretched between two points; `w` across, `d` depth (towards `up`). */
  ellAlong(a: V3, b: V3, w: number, d: number, bone: string, o: Omit<ShapeOpts, "bone"> & { up?: V3; ext?: number } = {}) {
    const ax = norm(sub(b, a))
    const upHint = o.up ?? [0, 0, 1]
    let side = cross(ax, upHint)
    if (len(side) < 1e-4) side = perp(ax)
    side = norm(side)
    const up = norm(cross(side, ax))
    const c = lerp3(a, b, 0.5)
    return this.ell(c, [w, (len(sub(b, a)) / 2) * (o.ext ?? 1), d], bone, { ...o, axes: [side, ax, up] })
  }

  /**
   * Twisted cords wrapping a limb segment from a to b: `n` tendons spiralling around the axis at radius `r` (end radii
   * ra/rb), each wandering a little and thinning in the middle, so the limb reads as a bundle of dried sinew.
   */
  cords(a: V3, b: V3, ra: number, rb: number, n: number, thick: number, bone: string, o: { twist?: number; segs?: number; k?: number; bone2?: string } = {}) {
    ra *= this.thick
    rb *= this.thick
    thick *= this.thick
    const ax = norm(sub(b, a))
    const u = perp(ax)
    const v = cross(ax, u)
    const L = len(sub(b, a))
    const segs = o.segs ?? Math.max(4, Math.round(L / 0.07))
    const twist = o.twist ?? 1.2
    for (let c = 0; c < n; c++) {
      const a0 = (c / n) * Math.PI * 2 + this.r() * 0.6
      const tw = twist * (0.7 + this.r() * 0.6) * (this.r() < 0.3 ? -1 : 1)
      const th = thick * (0.7 + this.r() * 0.6)
      let prev: V3 | null = null
      let prevR = 0
      for (let k = 0; k <= segs; k++) {
        const t = k / segs
        const ang = a0 + tw * t + Math.sin(t * 7 + c) * 0.15
        const rad = (ra + (rb - ra) * t) * (0.92 + 0.12 * Math.sin(t * 9 + c * 2))
        const p = madd(madd(madd(a, ax, L * t), u, Math.cos(ang) * rad), v, Math.sin(ang) * rad)
        const tr = th * (0.75 + 0.35 * Math.sin(Math.PI * t) * (this.r() * 0.5 + 0.75))
        const bn = o.bone2 && t > 0.6 ? o.bone2 : bone
        if (prev) this.model.add(new RoundCone(prev, p, prevR, tr, { k: o.k ?? 0.01, bone: this.b(bn) }))
        prev = p
        prevR = tr
      }
    }
  }

  /** A gnarled knot of bone and gristle, like a burl on a branch: overlapping lumps around a joint. */
  knot(c: V3, r: number, bone: string, o: { k?: number; lumps?: number; tag?: number; stretch?: V3 } = {}) {
    const n = o.lumps ?? 6
    this.ell(c, [r * 0.85, r * 0.9, r * 0.85], bone, { k: o.k ?? 0.02, tag: o.tag })
    for (let i = 0; i < n; i++) {
      const dir = norm([this.r() * 2 - 1, this.r() * 2 - 1, this.r() * 2 - 1])
      const off = madd(c, dir, r * (0.45 + this.r() * 0.35))
      const s = r * (0.35 + this.r() * 0.3)
      const ax = norm([this.r() * 2 - 1, this.r() * 2 - 1, this.r() * 2 - 1])
      const side = perp(ax)
      this.ell(off, [s * (0.7 + this.r() * 0.6), s, s * (0.6 + this.r() * 0.5)], bone, {
        k: (o.k ?? 0.02) * 0.7,
        tag: o.tag,
        axes: [side, ax, cross(ax, side)],
      })
    }
  }

  /** Carve. */
  hole(s: Shape) {
    s.op = Op.Sub
    return s
  }

  /** First surface hit along a ray through the current model (to rest shapes on the skin). */
  march(o: V3, dir: V3, max = 1): V3 | null {
    const d = norm(dir)
    let t = 0
    for (let i = 0; i < 200 && t < max; i++) {
      const p = madd(o, d, t)
      const v = this.model.eval(p[0], p[1], p[2])
      if (v < 0.0005) return p
      t += Math.max(v * 0.8, 0.001)
    }
    return null
  }

  /** Re-build the culling grid after adding shapes (march uses it). */
  touch() {
    this.model.add(new Ellipsoid([0, -50, 0], [0.001, 0.001, 0.001], undefined, { ghost: true }))
  }
}

export { Tag, add, cross, len, lerp3, madd, norm, perp, scale, sub }
export type { V3 }
