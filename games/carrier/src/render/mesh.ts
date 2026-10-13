export type Rgb = readonly [number, number, number]

/** Vertex while building: position (3), normal (3), colour (3), material (1), aux (1). */
export const FLOATS_PER_VERT = 11
/** Packed GPU vertex: position f32x3, normal snorm8x4, colour unorm8x4, material and aux f16x2. */
export const VERT_BYTES = 24

/**
 * Materials the static lit shader understands (`lit.ts`). Vertex colour is albedo.
 * - lit: flat sun diffuse, sky ambient and distance fog
 * - glow: emissive; aux adds brightness
 * - foliage: lit like `lit`, single-sided-safe, and sways gently with `aux` as its phase
 */
export const MAT = { lit: 0, glow: 1, foliage: 2 } as const
export type Mat = (typeof MAT)[keyof typeof MAT]

const f16buf = new Float32Array(1)
const f16bits = new Uint32Array(f16buf.buffer)
function toHalf(v: number): number {
  f16buf[0] = v
  const x = f16bits[0]!
  const sign = (x >>> 16) & 0x8000
  let exp = ((x >>> 23) & 0xff) - 127 + 15
  const mant = x & 0x7fffff
  if (exp <= 0) return sign
  if (exp >= 31) return sign | 0x7c00
  // Round to nearest.
  let m = mant >> 13
  if (mant & 0x1000) {
    m++
    if (m === 0x400) {
      m = 0
      exp++
    }
  }
  return sign | (exp << 10) | m
}

const clampByte = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)))
const snorm = (v: number) => Math.max(-127, Math.min(127, Math.round(v * 127)))

/** Packs build-time vertices (FLOATS_PER_VERT each) into the GPU layout. */
export function packVerts(v: ArrayLike<number>, from = 0, to = v.length): ArrayBuffer {
  const n = (to - from) / FLOATS_PER_VERT
  const out = new ArrayBuffer(n * VERT_BYTES)
  const f = new Float32Array(out)
  const b = new Uint8Array(out)
  const i8 = new Int8Array(out)
  const h = new Uint16Array(out)
  for (let k = 0; k < n; k++) {
    const s = from + k * FLOATS_PER_VERT
    const o = k * VERT_BYTES
    f[o / 4] = v[s]!
    f[o / 4 + 1] = v[s + 1]!
    f[o / 4 + 2] = v[s + 2]!
    i8[o + 12] = snorm(v[s + 3]!)
    i8[o + 13] = snorm(v[s + 4]!)
    i8[o + 14] = snorm(v[s + 5]!)
    i8[o + 15] = 0
    b[o + 16] = clampByte(v[s + 6]!)
    b[o + 17] = clampByte(v[s + 7]!)
    b[o + 18] = clampByte(v[s + 8]!)
    b[o + 19] = 255
    h[(o + 20) / 2] = toHalf(v[s + 9]!)
    h[(o + 22) / 2] = toHalf(v[s + 10]!)
  }
  return out
}

export class Mesh {
  readonly v: number[] = []

  vert(p: readonly number[], n: readonly number[], c: Rgb, mat: Mat, aux = 0): void {
    this.v.push(p[0]!, p[1]!, p[2]!, n[0]!, n[1]!, n[2]!, c[0], c[1], c[2], mat, aux)
  }

  /** Quad from four corners, counter-clockwise seen from the normal side. */
  quad(a: number[], b: number[], c: number[], d: number[], n: number[], col: Rgb, mat: Mat = MAT.lit, aux = 0): void {
    for (const p of [a, b, c, a, c, d]) this.vert(p, n, col, mat, aux)
  }

  /** Quad with its normal from the winding of a, b, c. */
  quadAuto(a: number[], b: number[], c: number[], d: number[], col: Rgb, mat: Mat = MAT.lit, aux = 0): void {
    const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!]
    const w = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!]
    const n = [u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!]
    const l = Math.hypot(n[0]!, n[1]!, n[2]!) || 1
    this.quad(a, b, c, d, [n[0]! / l, n[1]! / l, n[2]! / l], col, mat, aux)
  }

  /** Triangle with a normal from its winding. */
  facet(a: number[], b: number[], c: number[], col: Rgb, mat: Mat = MAT.lit, aux = 0): void {
    const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!]
    const w = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!]
    const n = [u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!]
    const l = Math.hypot(n[0]!, n[1]!, n[2]!) || 1
    for (const p of [a, b, c]) this.vert(p, [n[0]! / l, n[1]! / l, n[2]! / l], col, mat, aux)
  }

  /** Axis-aligned box. `top` overrides the colour of the upper face. */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, col: Rgb, mat: Mat = MAT.lit, aux = 0, top?: Rgb, bottom = false, topMat: Mat = mat): void {
    const t = top ?? col
    this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 1, 0], t, topMat, aux)
    this.quad([x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0], [-1, 0, 0], col, mat, aux)
    this.quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], [1, 0, 0], col, mat, aux)
    this.quad([x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [x0, y0, z1], [0, 0, 1], col, mat, aux)
    this.quad([x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [0, 0, -1], col, mat, aux)
    if (bottom) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0], col, mat, aux)
  }

  /**
   * Box whose top edges are chamfered by `b`: sides up to y1 - b, then four sloped strips up to an inset top face.
   * The strips catch the rim light, which is what makes low-poly edges read.
   */
  bevelBox(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, b: number, col: Rgb, top: Rgb, mat: Mat = MAT.lit, topMat: Mat = mat, edge: Rgb = top): void {
    const bb = Math.min(b, (x1 - x0) / 2.2, (z1 - z0) / 2.2, (y1 - y0) / 2)
    const ys = y1 - bb
    this.quad([x0, y0, z1], [x0, ys, z1], [x0, ys, z0], [x0, y0, z0], [-1, 0, 0], col, mat)
    this.quad([x1, y0, z0], [x1, ys, z0], [x1, ys, z1], [x1, y0, z1], [1, 0, 0], col, mat)
    this.quad([x1, y0, z1], [x1, ys, z1], [x0, ys, z1], [x0, y0, z1], [0, 0, 1], col, mat)
    this.quad([x0, y0, z0], [x0, ys, z0], [x1, ys, z0], [x1, y0, z0], [0, 0, -1], col, mat)
    const ix0 = x0 + bb
    const ix1 = x1 - bb
    const iz0 = z0 + bb
    const iz1 = z1 - bb
    const s = Math.SQRT1_2
    this.quad([x0, ys, z1], [x1, ys, z1], [ix1, y1, iz1], [ix0, y1, iz1], [0, s, s], edge, topMat)
    this.quad([x1, ys, z0], [x0, ys, z0], [ix0, y1, iz0], [ix1, y1, iz0], [0, s, -s], edge, topMat)
    this.quad([x0, ys, z0], [x0, ys, z1], [ix0, y1, iz1], [ix0, y1, iz0], [-s, s, 0], edge, topMat)
    this.quad([x1, ys, z1], [x1, ys, z0], [ix1, y1, iz0], [ix1, y1, iz1], [s, s, 0], edge, topMat)
    this.quad([ix0, y1, iz1], [ix1, y1, iz1], [ix1, y1, iz0], [ix0, y1, iz0], [0, 1, 0], top, topMat)
  }

  /** Vertical n-gon prism around (cx, cz), radius r0 at y0 tapering to r1 at y1. */
  prism(cx: number, cz: number, r0: number, r1: number, y0: number, y1: number, sides: number, col: Rgb, mat: Mat = MAT.lit, aux = 0, cap = true, phase = 0): void {
    for (let i = 0; i < sides; i++) {
      const a0 = (i / sides) * Math.PI * 2 + phase
      const a1 = ((i + 1) / sides) * Math.PI * 2 + phase
      const am = (a0 + a1) / 2
      const p = (a: number, r: number, y: number) => [cx + Math.cos(a) * r, y, cz + Math.sin(a) * r]
      const slope = (r0 - r1) / Math.max(0.001, y1 - y0)
      const n = [Math.cos(am), slope, Math.sin(am)]
      const l = Math.hypot(n[0]!, n[1]!, n[2]!)
      this.quad(p(a0, r0, y0), p(a0, r1, y1), p(a1, r1, y1), p(a1, r0, y0), [n[0]! / l, n[1]! / l, n[2]! / l], col, mat, aux)
      if (cap && r1 > 0.001) this.quad([cx, y1, cz], p(a1, r1, y1), p(a0, r1, y1), [cx, y1, cz], [0, 1, 0], col, mat, aux)
    }
  }

  /** A box rotated by `yaw` around Y about its own centre; for clutter that should not sit on the grid. */
  yawBox(cx: number, cz: number, w: number, d: number, y0: number, y1: number, yaw: number, col: Rgb, mat: Mat = MAT.lit, aux = 0, top?: Rgb): void {
    const from = this.length
    this.box(-w / 2, y0, -d / 2, w / 2, y1, d / 2, col, mat, aux, top)
    const c = Math.cos(yaw)
    const s = Math.sin(yaw)
    for (let i = from; i < this.v.length; i += FLOATS_PER_VERT) {
      const x = this.v[i]!
      const z = this.v[i + 2]!
      this.v[i] = x * c - z * s + cx
      this.v[i + 2] = x * s + z * c + cz
      const nx = this.v[i + 3]!
      const nz = this.v[i + 5]!
      this.v[i + 3] = nx * c - nz * s
      this.v[i + 5] = nx * s + nz * c
    }
  }

  /** Applies a transform to every vertex added since `from`: rotate by quarter turns around Y, then translate. */
  place(from: number, rot: number, tx: number, ty: number, tz: number): void {
    const c = Math.round(Math.cos((rot * Math.PI) / 2))
    const s = Math.round(Math.sin((rot * Math.PI) / 2))
    for (let i = from; i < this.v.length; i += FLOATS_PER_VERT) {
      const x = this.v[i]!
      const z = this.v[i + 2]!
      this.v[i] = x * c - z * s + tx
      this.v[i + 1]! += ty
      this.v[i + 2] = x * s + z * c + tz
      const nx = this.v[i + 3]!
      const nz = this.v[i + 5]!
      this.v[i + 3] = nx * c - nz * s
      this.v[i + 5] = nx * s + nz * c
    }
  }

  get length(): number {
    return this.v.length
  }

  get count(): number {
    return this.v.length / FLOATS_PER_VERT
  }

  pack(): ArrayBuffer {
    return packVerts(this.v)
  }
}
