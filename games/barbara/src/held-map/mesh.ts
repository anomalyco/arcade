/**
 * A tiny mesh builder for the held props: position, normal, uv, tangent (the uv's u direction) and a packed
 * object/material id per vertex. Objects index the pass's per-object transforms; materials pick the shading.
 */

export const VERTEX_FLOATS = 12

export const MAT = {
  paper: 0, acrylic: 1, bezelTop: 2, floor: 3, glass: 4, needle: 5, metal: 6, glove: 7, torch: 8, lens: 9, cord: 10,
  sleeve: 11, bubble: 12, bezelSide: 13, plateEdge: 14, jewel: 15, dial: 16, hand: 17,
} as const

/** Objects with their own transform; the watch's hands turn on the left wrist (`watchFrame`). */
export const OBJ = { sheet: 0, compass: 1, bezel: 2, needle: 3, bubble: 4, left: 5, right: 6, hour: 7, minute: 8 } as const
export const OBJ_COUNT = 9

export type V3 = [number, number, number]

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const norm = (a: V3): V3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l] }
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s]
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

export class MeshBuilder {
  data: number[] = []

  get count() { return this.data.length / VERTEX_FLOATS }

  vertex(p: V3, n: V3, uv: [number, number], t: V3, obj: number, mat: number) {
    this.data.push(p[0], p[1], p[2], n[0], n[1], n[2], uv[0], uv[1], t[0], t[1], t[2], obj * 32 + mat)
  }

  /** A parametric surface over [0,1]², normals and tangents by finite differences. `flip` reverses winding. */
  grid(nu: number, nv: number, pos: (u: number, v: number) => V3, uv: (u: number, v: number) => [number, number], obj: number, mat: number, flip = false) {
    const P: V3[] = [], N: V3[] = [], T: V3[] = [], UV: [number, number][] = []
    const e = 1e-4
    for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
      const u = i / nu, v = j / nv
      const p = pos(u, v)
      const du = sub(pos(Math.min(1, u + e), v), pos(Math.max(0, u - e), v))
      const dv = sub(pos(u, Math.min(1, v + e)), pos(u, Math.max(0, v - e)))
      let c = cross(du, dv)
      if (Math.hypot(c[0], c[1], c[2]) < 1e-14) {
        const vv = v < 0.5 ? v + 2e-3 : v - 2e-3
        c = cross(sub(pos(Math.min(1, u + e), vv), pos(Math.max(0, u - e), vv)), sub(pos(u, vv + e), pos(u, vv - e)))
      }
      let n = norm(c)
      if (flip) n = scale(n, -1)
      P.push(p); N.push(n); T.push(norm(du)); UV.push(uv(u, v))
    }
    const idx = (i: number, j: number) => j * (nu + 1) + i
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
      const a = idx(i, j), b = idx(i + 1, j), c = idx(i + 1, j + 1), d = idx(i, j + 1)
      const tri = flip ? [a, c, b, a, d, c] : [a, b, c, a, c, d]
      for (const k of tri) this.vertex(P[k]!, N[k]!, UV[k]!, T[k]!, obj, mat)
    }
  }

  /** Surface of revolution about +y through `profile` ([radius, y] pairs), optionally transformed. */
  lathe(profile: [number, number][], seg: number, obj: number, mat: number, xf: (p: V3) => V3 = (p) => p, nxf: (n: V3) => V3 = (n) => n, uvOf?: (a: number, k: number) => [number, number]) {
    const n = profile.length - 1
    this.grid(seg, n, (u, v) => {
      const k = v * n, i = Math.min(n - 1, Math.floor(k)), f = k - i
      const r = profile[i]![0] + (profile[i + 1]![0] - profile[i]![0]) * f, y = profile[i]![1] + (profile[i + 1]![1] - profile[i]![1]) * f
      const a = u * Math.PI * 2
      return xf([Math.cos(a) * r, y, -Math.sin(a) * r])
    }, (u, v) => uvOf ? uvOf(u, v) : [u, v], obj, mat)
    void nxf
  }

  /** Ellipsoid: unit sphere scaled by `r`, rotated by `rot` (3 column vectors) and moved to `c`. */
  ellipsoid(c: V3, r: V3, rot: [V3, V3, V3], obj: number, mat: number, nu = 28, nv = 18) {
    const map = (p: V3): V3 => add(c, add(add(scale(rot[0], p[0] * r[0]), scale(rot[1], p[1] * r[1])), scale(rot[2], p[2] * r[2])))
    this.grid(nu, nv, (u, v) => {
      const th = u * Math.PI * 2, ph = v * Math.PI
      return map([Math.cos(th) * Math.sin(ph), -Math.cos(ph), -Math.sin(th) * Math.sin(ph)])
    }, (u, v) => [u, v], obj, mat)
  }

  /**
   * A tube along `path` with radii `radii`, parallel-transported rings, rounded end caps. uv.x runs round it; uv.y is
   * `along[i]` when given (fingers: joint index + share of the segment, for the leather's creases), else arc length.
   */
  tube(path: V3[], radii: number[], obj: number, mat: number, seg = 16, caps = true, along?: number[], squash?: { up: V3; k: number[] }) {
    const n = path.length
    const tang: V3[] = path.map((_, i) => norm(sub(path[Math.min(n - 1, i + 1)]!, path[Math.max(0, i - 1)]!)))
    let ref: V3 = Math.abs(tang[0]![1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]
    const frames: [V3, V3][] = []
    for (let i = 0; i < n; i++) {
      const t = tang[i]!
      let nx = norm(sub(ref, scale(t, dot(ref, t))))
      const bx = cross(t, nx)
      frames.push([nx, bx])
      ref = nx
      void bx
    }
    // Optional flattening along `squash.up` (a thumb pressed on paper): offsets scale by k, normals by 1/k.
    const flat = (i: number, d: V3, inv: boolean): V3 => {
      if (!squash) return d
      const k = squash.k[i]!, u = squash.up, s = dot(d, u)
      return add(d, scale(u, s * ((inv ? 1 / k : k) - 1)))
    }
    const ringAt = (i: number, a: number): V3 => {
      const [nx, bx] = frames[i]!
      return add(path[i]!, flat(i, add(scale(nx, Math.cos(a) * radii[i]!), scale(bx, Math.sin(a) * radii[i]!)), false))
    }
    const ringN = (i: number, a: number): V3 => {
      const [nx, bx] = frames[i]!
      return norm(flat(i, add(scale(nx, Math.cos(a)), scale(bx, Math.sin(a))), true))
    }
    let arc = 0
    const lens: number[] = [0]
    for (let i = 1; i < n; i++) { arc += Math.hypot(...sub(path[i]!, path[i - 1]!)); lens.push(arc) }
    if (along) for (let i = 0; i < n; i++) lens[i] = along[i]!
    for (let i = 0; i + 1 < n; i++) for (let s = 0; s < seg; s++) {
      const a0 = (s / seg) * Math.PI * 2, a1 = ((s + 1) / seg) * Math.PI * 2
      const q = [ringAt(i, a0), ringAt(i, a1), ringAt(i + 1, a1), ringAt(i + 1, a0)]
      const nn = [ringN(i, a0), ringN(i, a1), ringN(i + 1, a1), ringN(i + 1, a0)]
      const uv: [number, number][] = [[s / seg, lens[i]!], [(s + 1) / seg, lens[i]!], [(s + 1) / seg, lens[i + 1]!], [s / seg, lens[i + 1]!]]
      for (const k of [0, 2, 1, 0, 3, 2]) this.vertex(q[k]!, nn[k]!, uv[k]!, tang[k < 2 ? i : i + 1]!, obj, mat)
    }
    if (caps) {
      for (const end of [0, n - 1]) {
        const c = path[end]!, r = radii[end]!, t = scale(tang[end]!, end === 0 ? -1 : 1)
        const [nx, bx] = frames[end]!
        this.grid(seg, 6, (u, v) => {
          const a = u * Math.PI * 2, ph = v * Math.PI / 2
          const d = add(scale(add(scale(nx, Math.cos(a)), scale(bx, Math.sin(a))), Math.cos(ph)), scale(t, Math.sin(ph)))
          return add(c, flat(end, scale(d, r), false))
        }, (u) => [u, lens[end]!], obj, mat, end === 0)
      }
    }
  }

  /**
   * Superellipsoid (rounded box) with half extents `r`, squareness `e` (1 = ellipsoid, towards 0 = box), rotated by
   * `rot` and moved to `c`. uv.y is the constant `v` (no leather creases on palms).
   */
  superellipsoid(c: V3, r: V3, rot: [V3, V3, V3], e: number, obj: number, mat: number, v = 0.5, nu = 32, nv = 20) {
    const sp = (x: number, k: number) => Math.sign(x) * Math.abs(x) ** k
    const map = (p: V3): V3 => add(c, add(add(scale(rot[0], p[0] * r[0]), scale(rot[1], p[1] * r[1])), scale(rot[2], p[2] * r[2])))
    this.grid(nu, nv, (u, w) => {
      const th = u * Math.PI * 2, ph = w * Math.PI
      return map([sp(Math.cos(th), e) * sp(Math.sin(ph), e), -sp(Math.cos(ph), e), -sp(Math.sin(th), e) * sp(Math.sin(ph), e)])
    }, (u) => [u, v], obj, mat)
  }

  /** A flat polygon (convex, counter-clockwise seen from +n) as a fan. */
  fan(points: V3[], n: V3, uv: (p: V3) => [number, number], obj: number, mat: number, tangent: V3 = [1, 0, 0]) {
    for (let i = 1; i + 1 < points.length; i++) {
      for (const p of [points[0]!, points[i]!, points[i + 1]!]) this.vertex(p, n, uv(p), tangent, obj, mat)
    }
  }

  /** A quad strip side wall between two outlines (same length), normals outward from `centre` (plan). */
  wall(lower: V3[], upper: V3[], obj: number, mat: number, normalOf: (p: V3) => V3, uvOf: (i: number, top: boolean) => [number, number]) {
    for (let i = 0; i + 1 < lower.length; i++) {
      const q = [lower[i]!, lower[i + 1]!, upper[i + 1]!, upper[i]!]
      const uvs = [uvOf(i, false), uvOf(i + 1, false), uvOf(i + 1, true), uvOf(i, true)]
      const t = norm(sub(lower[i + 1]!, lower[i]!))
      for (const k of [0, 1, 2, 0, 2, 3]) this.vertex(q[k]!, normalOf(q[k]!), uvs[k]!, t, obj, mat)
    }
  }

  build(): Float32Array<ArrayBuffer> { return new Float32Array(this.data) }
}

export const v3 = { sub, cross, norm, add, scale, dot }
