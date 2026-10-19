// Signed-distance anatomy: primitives (round cones, ellipsoids, rounded boxes) combined with smooth union and smooth
// subtraction in insertion order, each tagged with the bone that owns it (for auto-skinning) and a material tag. Pure
// TypeScript with no three.js dependency, so it runs in Bun for offline baking and in the browser as a fallback.
//
// Evaluation is culled: a uniform grid of shape lists means a point only visits the few shapes whose (blend-expanded)
// bounds reach it. Far from every shape the field returns `FAR`, which is outside; only signs and values near the
// surface matter to the mesher.

import { noise3 } from "./noise"

export type V3 = [number, number, number]

export const FAR = 1

export const enum Op {
  Add = 0,
  Sub = 1,
  /** Smooth intersection: keeps only what is inside both. */
  Int = 2,
}

/** Material tags baked per vertex. */
export const enum Tag {
  Skin = 0,
  Bone = 1,
  Horn = 2,
  Tooth = 3,
}

export interface Shape {
  /** Distance from the primitive's surface (negative inside). */
  d(x: number, y: number, z: number): number
  bmin: V3
  bmax: V3
  op: Op
  /** Blend radius in metres (0 = hard). */
  k: number
  bone: number
  tag: number
  /** When set, the shape takes part in skinning but doesn't change the surface (a weight helper). */
  ghost?: boolean
  /** Main axis (unit), for fibre / grain direction. */
  axis?: V3
  /** 0..1: how fibrous the surface this shape makes is. */
  fibre?: number
  /** 0..1: how freely the surface hangs and sways (tendril tips = 1). */
  dangle?: number
}

export type ShapeOpts = { op?: Op; k?: number; bone?: number; tag?: number; ghost?: boolean; dangle?: number }

// ------------------------------------------------------------------------------------------------- math helpers

export const v3 = (x: number, y: number, z: number): V3 => [x, y, z]
export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
export const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s]
export const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
export const len = (a: V3) => Math.hypot(a[0], a[1], a[2])
export const norm = (a: V3): V3 => scale(a, 1 / (len(a) || 1))
export const lerp3 = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
export const madd = (a: V3, b: V3, s: number): V3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s]
export const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x)
export const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

/** Any unit vector perpendicular to `n`. */
export function perp(n: V3): V3 {
  const a: V3 = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]
  return norm(cross(n, a))
}

/** Rotate `v` about unit axis `k` by angle `a` (Rodrigues). */
export function rotate(v: V3, k: V3, a: number): V3 {
  const c = Math.cos(a)
  const s = Math.sin(a)
  const kv = cross(k, v)
  const kd = dot(k, v) * (1 - c)
  return [v[0] * c + kv[0] * s + k[0] * kd, v[1] * c + kv[1] * s + k[1] * kd, v[2] * c + kv[2] * s + k[2] * kd]
}

export function smin(a: number, b: number, k: number) {
  if (k <= 0) return a < b ? a : b
  const h = k - Math.abs(a - b)
  if (h <= 0) return a < b ? a : b
  const hh = h / k
  return (a < b ? a : b) - hh * hh * k * 0.25
}

export function smax(a: number, b: number, k: number) {
  return -smin(-a, -b, k)
}

// ------------------------------------------------------------------------------------------------- primitives

/** Capsule with a different radius at each end (iq's exact round cone). */
export class RoundCone implements Shape {
  axis?: V3
  fibre?: number
  bmin: V3
  bmax: V3
  op: Op
  k: number
  bone: number
  tag: number
  ghost?: boolean
  dangle?: number
  private ax: number
  private ay: number
  private az: number
  private bax: number
  private bay: number
  private baz: number
  private l2: number
  private rr: number
  private a2: number
  private il2: number
  constructor(
    public a: V3,
    public b: V3,
    public ra: number,
    public rb: number,
    o: ShapeOpts = {},
  ) {
    this.op = o.op ?? Op.Add
    this.k = o.k ?? 0
    this.bone = o.bone ?? 0
    this.tag = o.tag ?? Tag.Skin
    this.ghost = o.ghost
    this.dangle = o.dangle
    // Keep the larger sphere from swallowing the smaller (the formula needs |ra - rb| < length).
    const L = len(sub(b, a))
    if (Math.abs(ra - rb) > L * 0.98) {
      if (ra > rb) this.rb = rb = ra - L * 0.98
      else this.ra = ra = rb - L * 0.98
    }
    this.ax = a[0]
    this.ay = a[1]
    this.az = a[2]
    this.bax = b[0] - a[0]
    this.bay = b[1] - a[1]
    this.baz = b[2] - a[2]
    this.l2 = Math.max(1e-12, this.bax * this.bax + this.bay * this.bay + this.baz * this.baz)
    this.rr = ra - rb
    this.a2 = this.l2 - this.rr * this.rr
    this.il2 = 1 / this.l2
    this.axis = norm(sub(b, a))
    this.fibre = 0.4
    const r = Math.max(ra, rb)
    this.bmin = [Math.min(a[0], b[0]) - r, Math.min(a[1], b[1]) - r, Math.min(a[2], b[2]) - r]
    this.bmax = [Math.max(a[0], b[0]) + r, Math.max(a[1], b[1]) + r, Math.max(a[2], b[2]) + r]
  }
  d(x: number, y: number, z: number) {
    const pax = x - this.ax
    const pay = y - this.ay
    const paz = z - this.az
    const l2 = this.l2
    const yy = pax * this.bax + pay * this.bay + paz * this.baz
    const zz = yy - l2
    const qx = pax * l2 - this.bax * yy
    const qy = pay * l2 - this.bay * yy
    const qz = paz * l2 - this.baz * yy
    const x2 = qx * qx + qy * qy + qz * qz
    const y2 = yy * yy * l2
    const z2 = zz * zz * l2
    const rr = this.rr
    const k = Math.sign(rr) * rr * rr * x2
    if (Math.sign(zz) * this.a2 * z2 > k) return Math.sqrt(x2 + z2) * this.il2 - this.rb
    if (Math.sign(yy) * this.a2 * y2 < k) return Math.sqrt(x2 + y2) * this.il2 - this.ra
    return (Math.sqrt(x2 * this.a2 * this.il2) + yy * rr) * this.il2 - this.ra
  }
}

/**
 * A round cone wrapped in raised fibres running along its axis, like dried sinew or wood grain: the angle around the
 * axis is warped by noise along the length, so the cords wander, split and merge instead of forming clean stripes.
 */
export class FiberCone extends RoundCone {
  private ux: V3
  private uy: V3
  private dirA: V3
  private L: number
  constructor(
    a: V3,
    b: V3,
    ra: number,
    rb: number,
    public amp: number,
    public count: number,
    public seed: number,
    o: ShapeOpts = {},
  ) {
    super(a, b, ra, rb, o)
    this.fibre = 1
    this.L = len(sub(b, a))
    this.dirA = norm(sub(b, a))
    this.ux = perp(this.dirA)
    this.uy = cross(this.dirA, this.ux)
    for (let i = 0; i < 3; i++) {
      this.bmin[i] -= amp
      this.bmax[i] += amp
    }
  }
  override d(x: number, y: number, z: number) {
    const base = super.d(x, y, z)
    if (base > this.amp * 3 || base < -0.03) return base
    const px = x - this.a[0]
    const py = y - this.a[1]
    const pz = z - this.a[2]
    const t = px * this.dirA[0] + py * this.dirA[1] + pz * this.dirA[2]
    const u = px * this.ux[0] + py * this.ux[1] + pz * this.ux[2]
    const v = px * this.uy[0] + py * this.uy[1] + pz * this.uy[2]
    const ang = Math.atan2(v, u)
    const warp = noise3(t * 7, Math.cos(ang) * 0.9 + this.seed, Math.sin(ang) * 0.9) * 2.2 + noise3(t * 23, ang * 0.5, this.seed) * 0.6
    const ph = ang * this.count + warp * 3
    const cord = Math.sqrt(Math.abs(Math.sin(ph * 0.5)))
    // Fade the fibres out at the rounded ends so the caps stay clean where cones join.
    const end = smoothstep(-0.01, 0.04, t) * smoothstep(this.L + 0.01, this.L - 0.04, t)
    return base - this.amp * (cord - 0.5) * end
  }
}

/** Oriented ellipsoid (iq's bound approximation). `axes` are the unit local X/Y/Z axes in world space. */
export class Ellipsoid implements Shape {
  axis?: V3
  fibre?: number
  bmin: V3
  bmax: V3
  op: Op
  k: number
  bone: number
  tag: number
  ghost?: boolean
  dangle?: number
  private m: number[]
  constructor(
    public c: V3,
    public r: V3,
    axes: [V3, V3, V3] = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    o: ShapeOpts = {},
  ) {
    this.op = o.op ?? Op.Add
    this.k = o.k ?? 0
    this.bone = o.bone ?? 0
    this.tag = o.tag ?? Tag.Skin
    this.ghost = o.ghost
    this.dangle = o.dangle
    this.m = [...axes[0], ...axes[1], ...axes[2]]
    const li = r[0] >= r[1] && r[0] >= r[2] ? 0 : r[1] >= r[2] ? 1 : 2
    this.axis = axes[li]
    this.fibre = 0.3
    const ext: V3 = [0, 0, 0]
    for (let i = 0; i < 3; i++) for (let a = 0; a < 3; a++) ext[i] += Math.abs(axes[a]![i]!) * r[a]!
    this.bmin = sub(c, ext)
    this.bmax = add(c, ext)
  }
  d(x: number, y: number, z: number) {
    const m = this.m
    const px = x - this.c[0]
    const py = y - this.c[1]
    const pz = z - this.c[2]
    const lx = (px * m[0]! + py * m[1]! + pz * m[2]!) / this.r[0]
    const ly = (px * m[3]! + py * m[4]! + pz * m[5]!) / this.r[1]
    const lz = (px * m[6]! + py * m[7]! + pz * m[8]!) / this.r[2]
    const k0 = Math.sqrt(lx * lx + ly * ly + lz * lz)
    const k1 = Math.sqrt((lx * lx) / (this.r[0] * this.r[0]) + (ly * ly) / (this.r[1] * this.r[1]) + (lz * lz) / (this.r[2] * this.r[2]))
    if (k1 < 1e-9) return -Math.min(this.r[0], this.r[1], this.r[2])
    return (k0 * (k0 - 1)) / k1
  }
}

/** Oriented rounded box: half extents `h`, corner radius `rad`. */
export class RoundBox implements Shape {
  bmin: V3
  bmax: V3
  op: Op
  k: number
  bone: number
  tag: number
  ghost?: boolean
  dangle?: number
  private m: number[]
  constructor(
    public c: V3,
    public h: V3,
    public rad: number,
    axes: [V3, V3, V3] = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    o: ShapeOpts = {},
  ) {
    this.op = o.op ?? Op.Add
    this.k = o.k ?? 0
    this.bone = o.bone ?? 0
    this.tag = o.tag ?? Tag.Skin
    this.ghost = o.ghost
    this.dangle = o.dangle
    this.m = [...axes[0], ...axes[1], ...axes[2]]
    const ext: V3 = [0, 0, 0]
    for (let i = 0; i < 3; i++) for (let a = 0; a < 3; a++) ext[i] += Math.abs(axes[a]![i]!) * (h[a]! + rad)
    this.bmin = sub(c, ext)
    this.bmax = add(c, ext)
  }
  d(x: number, y: number, z: number) {
    const m = this.m
    const px = x - this.c[0]
    const py = y - this.c[1]
    const pz = z - this.c[2]
    const qx = Math.abs(px * m[0]! + py * m[1]! + pz * m[2]!) - this.h[0]
    const qy = Math.abs(px * m[3]! + py * m[4]! + pz * m[5]!) - this.h[1]
    const qz = Math.abs(px * m[6]! + py * m[7]! + pz * m[8]!) - this.h[2]
    const ox = Math.max(qx, 0)
    const oy = Math.max(qy, 0)
    const oz = Math.max(qz, 0)
    return Math.sqrt(ox * ox + oy * oy + oz * oz) + Math.min(Math.max(qx, qy, qz), 0) - this.rad
  }
}

/** Wrap any distance function (for one-off shapes such as grooved antler segments). */
export class CustomShape implements Shape {
  dangle?: number
  axis?: V3
  fibre?: number
  op: Op
  k: number
  bone: number
  tag: number
  ghost?: boolean
  constructor(
    public fn: (x: number, y: number, z: number) => number,
    public bmin: V3,
    public bmax: V3,
    o: ShapeOpts & { axis?: V3; fibre?: number } = {},
  ) {
    this.axis = o.axis
    this.fibre = o.fibre
    this.op = o.op ?? Op.Add
    this.k = o.k ?? 0
    this.bone = o.bone ?? 0
    this.tag = o.tag ?? Tag.Skin
    this.ghost = o.ghost
    this.dangle = o.dangle
  }
  d(x: number, y: number, z: number) {
    return this.fn(x, y, z)
  }
}

// ------------------------------------------------------------------------------------------------- model

export type Detail = (x: number, y: number, z: number, d: number) => number

/** A culled, ordered list of shapes plus an optional surface detail (displacement) applied near the surface. */
export class SdfModel {
  shapes: Shape[] = []
  /** Displacement added after the shapes, only evaluated within `detailBand` of the surface. */
  detail: Detail | null = null
  detailBand = 0.02
  /** Extra reach for culling (largest displacement plus a safety margin). */
  margin = 0.01
  private cell = 0.08
  private grid: Map<number, Int32Array> | null = null
  private gmin: V3 = [0, 0, 0]
  private gdim: V3 = [0, 0, 0]

  add(s: Shape) {
    this.shapes.push(s)
    this.grid = null
    return s
  }

  bounds(): { min: V3; max: V3 } {
    const min: V3 = [Infinity, Infinity, Infinity]
    const max: V3 = [-Infinity, -Infinity, -Infinity]
    for (const s of this.shapes) {
      if (s.op !== Op.Add || s.ghost) continue
      for (let i = 0; i < 3; i++) {
        min[i] = Math.min(min[i]!, s.bmin[i]! - s.k)
        max[i] = Math.max(max[i]!, s.bmax[i]! + s.k)
      }
    }
    return { min, max }
  }

  /** Shapes whose expanded bounds touch the box [lo, hi]. Ghosts are excluded. */
  listFor(lo: V3, hi: V3, reach = 0): Int32Array {
    const out: number[] = []
    const m = this.margin + reach
    for (let i = 0; i < this.shapes.length; i++) {
      const s = this.shapes[i]!
      if (s.ghost) continue
      const e = s.k + m
      if (s.bmin[0] - e > hi[0] || s.bmax[0] + e < lo[0]) continue
      if (s.bmin[1] - e > hi[1] || s.bmax[1] + e < lo[1]) continue
      if (s.bmin[2] - e > hi[2] || s.bmax[2] + e < lo[2]) continue
      out.push(i)
    }
    return Int32Array.from(out)
  }

  /** Field value using a pre-culled shape list. */
  evalList(list: Int32Array, x: number, y: number, z: number): number {
    let d = FAR
    const shapes = this.shapes
    for (let i = 0; i < list.length; i++) {
      const s = shapes[list[i]!]!
      const op = s.op
      if (op === Op.Add) {
        // Skip exact evaluation when the shape's box is further than the blend reach.
        const e = s.k
        const bx = Math.max(s.bmin[0] - x, 0, x - s.bmax[0])
        const by = Math.max(s.bmin[1] - y, 0, y - s.bmax[1])
        const bz = Math.max(s.bmin[2] - z, 0, z - s.bmax[2])
        const lb = Math.sqrt(bx * bx + by * by + bz * bz)
        if (lb - e > d) continue
        d = smin(d, s.d(x, y, z), s.k)
      } else if (op === Op.Sub) {
        const bx = Math.max(s.bmin[0] - x, 0, x - s.bmax[0])
        const by = Math.max(s.bmin[1] - y, 0, y - s.bmax[1])
        const bz = Math.max(s.bmin[2] - z, 0, z - s.bmax[2])
        if (bx + by + bz > s.k + 1e-4) continue
        d = smax(d, -s.d(x, y, z), s.k)
      } else {
        d = smax(d, s.d(x, y, z), s.k)
      }
    }
    if (this.detail && d < this.detailBand && d > -this.detailBand) d = this.detail(x, y, z, d)
    return d
  }

  private buildGrid() {
    const { min, max } = this.bounds()
    const c = this.cell
    const pad = 0.15
    this.gmin = [min[0] - pad, min[1] - pad, min[2] - pad]
    this.gdim = [Math.ceil((max[0] - min[0] + 2 * pad) / c), Math.ceil((max[1] - min[1] + 2 * pad) / c), Math.ceil((max[2] - min[2] + 2 * pad) / c)]
    this.grid = new Map()
  }

  private cellList(ix: number, iy: number, iz: number): Int32Array {
    const key = ix + this.gdim[0] * (iy + this.gdim[1] * iz)
    let l = this.grid!.get(key)
    if (!l) {
      const c = this.cell
      const lo: V3 = [this.gmin[0] + ix * c, this.gmin[1] + iy * c, this.gmin[2] + iz * c]
      // Reach 0.1 m so off-surface samples (AO, thickness probes) still see their neighbours.
      l = this.listFor(lo, [lo[0] + c, lo[1] + c, lo[2] + c], 0.1)
      this.grid!.set(key, l)
    }
    return l
  }

  /** Field value anywhere (grid-culled). */
  eval(x: number, y: number, z: number): number {
    if (!this.grid) this.buildGrid()
    const c = this.cell
    const ix = Math.floor((x - this.gmin[0]) / c)
    const iy = Math.floor((y - this.gmin[1]) / c)
    const iz = Math.floor((z - this.gmin[2]) / c)
    if (ix < 0 || iy < 0 || iz < 0 || ix >= this.gdim[0] || iy >= this.gdim[1] || iz >= this.gdim[2]) return FAR
    return this.evalList(this.cellList(ix, iy, iz), x, y, z)
  }

  /** Unit gradient by central differences. */
  normal(x: number, y: number, z: number, e = 0.0012): V3 {
    const nx = this.eval(x + e, y, z) - this.eval(x - e, y, z)
    const ny = this.eval(x, y + e, z) - this.eval(x, y - e, z)
    const nz = this.eval(x, y, z + e) - this.eval(x, y, z - e)
    const l = Math.hypot(nx, ny, nz) || 1
    return [nx / l, ny / l, nz / l]
  }

  /** Candidate shapes (including ghosts) near a point, for skinning and tag queries. */
  nearShapes(x: number, y: number, z: number, reach: number): Shape[] {
    const out: Shape[] = []
    for (const s of this.shapes) {
      if (s.op !== Op.Add) continue
      const e = reach
      if (x < s.bmin[0] - e || x > s.bmax[0] + e || y < s.bmin[1] - e || y > s.bmax[1] + e || z < s.bmin[2] - e || z > s.bmax[2] + e) continue
      out.push(s)
    }
    return out
  }
}
