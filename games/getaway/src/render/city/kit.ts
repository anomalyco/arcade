import type { AtlasRegion } from "../atlas"
import { MAT, type Mat, type Mesh, type Rgb } from "../mesh"

export type V3 = [number, number, number]

export const shade = (c: Rgb, k: number): Rgb => [c[0] * k, c[1] * k, c[2] * k]
export const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
export const jitter = (c: Rgb, rng: () => number, amt = 0.06): Rgb => {
  const k = 1 + (rng() - 0.5) * 2 * amt
  return [c[0] * k, c[1] * k, c[2] * k]
}

/**
 * Rectangle spanned from `o` by `right * w` and `up * h`, facing right x up (counter-clockwise from the front).
 */
export function panel(m: Mesh, o: V3, right: V3, up: V3, w: number, h: number, col: Rgb, mat: Mat = MAT.lit) {
  const n: V3 = [right[1] * up[2] - right[2] * up[1], right[2] * up[0] - right[0] * up[2], right[0] * up[1] - right[1] * up[0]]
  const b: V3 = [o[0] + right[0] * w, o[1] + right[1] * w, o[2] + right[2] * w]
  const c: V3 = [b[0] + up[0] * h, b[1] + up[1] * h, b[2] + up[2] * h]
  const d: V3 = [o[0] + up[0] * h, o[1] + up[1] * h, o[2] + up[2] * h]
  m.quad(o, b, c, d, n, col, mat)
}

/** Box faces to skip. */
export const SKIP = { top: 1, bottom: 2, nz: 4, pz: 8, nx: 16, px: 32 } as const

/** Axis-aligned box without the faces in `skip` (bottoms on the ground are never seen). */
export function slab(m: Mesh, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, col: Rgb, mat: Mat = MAT.lit, skip: number = SKIP.bottom, top?: Rgb) {
  if (!(skip & SKIP.top)) m.quad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [0, 1, 0], top ?? col, mat)
  if (!(skip & SKIP.bottom)) m.quad([x0, y0, z1], [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [0, -1, 0], col, mat)
  if (!(skip & SKIP.nz)) m.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1], col, mat)
  if (!(skip & SKIP.pz)) m.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], col, mat)
  if (!(skip & SKIP.nx)) m.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0], col, mat)
  if (!(skip & SKIP.px)) m.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0], col, mat)
}

/** Ground-level quad (top face only). */
export function ground(m: Mesh, x0: number, x1: number, z0: number, z1: number, y: number, col: Rgb, mat: Mat = MAT.lit) {
  m.quad([x0, y, z0], [x0, y, z1], [x1, y, z1], [x1, y, z0], [0, 1, 0], col, mat)
}

/**
 * A vertical wall plane: origin at its left end on the ground as seen from outside, `t` running right along the
 * wall, `n` pointing out. Local coordinates are (u along the wall, y up, d out of the wall).
 */
export class Wall {
  readonly t: V3
  readonly n: V3
  readonly back: V3
  constructor(
    readonly ox: number,
    readonly oz: number,
    nx: number,
    nz: number,
    readonly w: number,
  ) {
    this.n = [nx, 0, nz]
    this.t = [nz, 0, -nx]
    this.back = [-nx, 0, -nz]
  }

  /** The wall facing `n` of the rectangle x0..x1, z0..z1. */
  static of(x0: number, x1: number, z0: number, z1: number, side: 0 | 1 | 2 | 3) {
    if (side === 0) return new Wall(x1, z0, 0, -1, x1 - x0)
    if (side === 1) return new Wall(x0, z1, 0, 1, x1 - x0)
    if (side === 2) return new Wall(x0, z0, -1, 0, z1 - z0)
    return new Wall(x1, z1, 1, 0, z1 - z0)
  }

  p(u: number, y: number, d = 0): V3 {
    return [this.ox + this.t[0] * u + this.n[0] * d, y, this.oz + this.t[2] * u + this.n[2] * d]
  }

  /** Front-facing rectangle at depth d. */
  rect(m: Mesh, u0: number, u1: number, y0: number, y1: number, d: number, col: Rgb, mat: Mat = MAT.lit) {
    if (u1 - u0 <= 0.001 || y1 - y0 <= 0.001) return
    panel(m, this.p(u0, y0, d), this.t, [0, 1, 0], u1 - u0, y1 - y0, col, mat)
  }

  /** Textured rectangle at depth d (image upright, left to right along u). */
  decal(m: Mesh, u0: number, u1: number, y0: number, y1: number, d: number, region: AtlasRegion, col: Rgb, mat: Mat) {
    m.decal(this.p(u0, y0, d), this.p(u1, y0, d), this.p(u1, y1, d), this.p(u0, y1, d), this.n, region, col, mat)
  }

  /** The four inner faces of a rectangular hole recessed by r (jambs, sill and head). */
  reveal(m: Mesh, u0: number, u1: number, y0: number, y1: number, r: number, col: Rgb, sillCol: Rgb = col) {
    const up: V3 = [0, 1, 0]
    panel(m, this.p(u0, y0, 0), this.back, up, r, y1 - y0, shade(col, 0.92))
    panel(m, this.p(u1, y0, -r), this.n, up, r, y1 - y0, shade(col, 0.92))
    panel(m, this.p(u0, y0, 0), this.t, this.back, u1 - u0, r, sillCol)
    panel(m, this.p(u0, y1, -r), this.t, this.n, u1 - u0, r, shade(col, 0.7))
  }

  /** A block standing proud of the wall by `d` (front, top, bottom and both ends). */
  ledge(m: Mesh, u0: number, u1: number, y0: number, y1: number, d: number, col: Rgb, mat: Mat = MAT.lit, top: Rgb = col) {
    const up: V3 = [0, 1, 0]
    this.rect(m, u0, u1, y0, y1, d, col, mat)
    panel(m, this.p(u0, y1, d), this.t, this.back, u1 - u0, d, top, mat)
    panel(m, this.p(u0, y0, 0), this.t, this.n, u1 - u0, d, shade(col, 0.6), mat)
    panel(m, this.p(u0, y0, 0), this.n, up, d, y1 - y0, shade(col, 0.85), mat)
    panel(m, this.p(u1, y0, d), this.back, up, d, y1 - y0, shade(col, 0.85), mat)
  }

  /** A sloped awning from the wall at y0 out to depth d, dropping by `drop`, with a front valance. */
  awning(m: Mesh, u0: number, u1: number, y0: number, d: number, drop: number, col: Rgb) {
    const a = this.p(u0, y0, 0)
    const b = this.p(u1, y0, 0)
    const c = this.p(u1, y0 - drop, d)
    const e = this.p(u0, y0 - drop, d)
    m.facet(e, c, b, col)
    m.facet(e, b, a, col)
    this.rect(m, u0, u1, y0 - drop - 0.45, y0 - drop, d, shade(col, 0.85))
    // Underside, so it reads from below as a dark band.
    m.facet(a, b, c, shade(col, 0.4))
    m.facet(a, c, e, shade(col, 0.4))
  }
}

/** Faceted low-poly cone tier: `sides` facets with jittered rim radius and a slightly offset apex. */
export function facetCone(m: Mesh, cx: number, cz: number, r: number, y0: number, y1: number, sides: number, col: Rgb, rng: () => number, rot = 0) {
  const rim: V3[] = []
  for (let i = 0; i < sides; i++) {
    const a = rot + (i / sides) * Math.PI * 2
    const rr = r * (0.82 + rng() * 0.3)
    rim.push([cx + Math.cos(a) * rr, y0 + (rng() - 0.5) * r * 0.25, cz + Math.sin(a) * rr])
  }
  const apex: V3 = [cx + (rng() - 0.5) * r * 0.2, y1, cz + (rng() - 0.5) * r * 0.2]
  const base: V3 = [cx, y0 + r * 0.15, cz]
  for (let i = 0; i < sides; i++) {
    const a = rim[i]!
    const b = rim[(i + 1) % sides]!
    const k = 0.86 + rng() * 0.28
    m.facet(b, a, apex, shade(col, k))
    m.facet(a, b, base, shade(col, 0.45))
  }
}

/** Upright faceted prism (cylinder) with a top cap. */
export function cylinder(m: Mesh, cx: number, cz: number, r: number, y0: number, y1: number, sides: number, col: Rgb, mat: Mat = MAT.lit, cap: Rgb = col) {
  for (let i = 0; i < sides; i++) {
    const a0 = (i / sides) * Math.PI * 2
    const a1 = ((i + 1) / sides) * Math.PI * 2
    const p0: V3 = [cx + Math.cos(a0) * r, y0, cz + Math.sin(a0) * r]
    const p1: V3 = [cx + Math.cos(a1) * r, y0, cz + Math.sin(a1) * r]
    const q0: V3 = [p0[0], y1, p0[2]]
    const q1: V3 = [p1[0], y1, p1[2]]
    m.facet(p1, p0, q0, col, mat)
    m.facet(p1, q0, q1, col, mat)
    m.facet(q1, q0, [cx, y1, cz], cap, mat)
  }
}

/** A thin straight beam between two points with a square section (for trusses, rails, arms). */
export function beam(m: Mesh, a: V3, b: V3, s: number, col: Rgb, mat: Mat = MAT.lit) {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2]
  const len = Math.hypot(dx, dy, dz)
  const f: V3 = [dx / len, dy / len, dz / len]
  const ref: V3 = Math.abs(f[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0]
  let ux = f[1] * ref[2] - f[2] * ref[1], uy = f[2] * ref[0] - f[0] * ref[2], uz = f[0] * ref[1] - f[1] * ref[0]
  const ul = Math.hypot(ux, uy, uz)
  ux /= ul
  uy /= ul
  uz /= ul
  const vx = f[1] * uz - f[2] * uy, vy = f[2] * ux - f[0] * uz, vz = f[0] * uy - f[1] * ux
  const h = s / 2
  const corner = (p: V3, i: number): V3 => {
    const su = i === 0 || i === 3 ? -h : h
    const sv = i < 2 ? -h : h
    return [p[0] + ux * su + vx * sv, p[1] + uy * su + vy * sv, p[2] + uz * su + vz * sv]
  }
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4
    const a0 = corner(a, i), a1 = corner(a, j), b0 = corner(b, i), b1 = corner(b, j)
    m.facet(a0, a1, b1, col, mat)
    m.facet(a0, b1, b0, col, mat)
  }
}
