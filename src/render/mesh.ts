export type Rgb = readonly [number, number, number]

/** Vertex: position (3), normal (3), colour (3), material (1), aux (1). */
export const FLOATS_PER_VERT = 11

/**
 * Materials the scene shader understands.
 * - lit: diffuse, lit by map lights through the 2D shadow map
 * - floor: lit exactly by the visibility rule, with a procedural pattern; aux is the floor kind
 * - lamp: emissive tied to map light `aux`, dark when that light is out
 * - glow: constant emissive; aux scales it (LEDs, screens)
 * - wall: lit, and dithered away when it stands between the camera and you
 * - tape: floor tape, faintly self-lit
 * - glass: translucent, picks up nearby light
 * - city: the night city far below the windows
 * - accent: takes the instance's team colour
 */
export const MAT = { lit: 0, floor: 1, lamp: 2, glow: 3, wall: 4, tape: 5, glass: 6, city: 7, accent: 8 } as const
export type Mat = (typeof MAT)[keyof typeof MAT]

export class Mesh {
  readonly v: number[] = []

  vert(p: readonly number[], n: readonly number[], c: Rgb, mat: Mat, aux = 0): void {
    this.v.push(p[0]!, p[1]!, p[2]!, n[0]!, n[1]!, n[2]!, c[0], c[1], c[2], mat, aux)
  }

  /** Quad from four corners, counter-clockwise seen from the normal side. */
  quad(a: number[], b: number[], c: number[], d: number[], n: number[], col: Rgb, mat: Mat = MAT.lit, aux = 0): void {
    for (const p of [a, b, c, a, c, d]) this.vert(p, n, col, mat, aux)
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
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, col: Rgb, mat: Mat = MAT.lit, aux = 0, top?: Rgb, bottom = false): void {
    const t = top ?? col
    this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 1, 0], t, mat, aux)
    this.quad([x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0], [-1, 0, 0], col, mat, aux)
    this.quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], [1, 0, 0], col, mat, aux)
    this.quad([x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [x0, y0, z1], [0, 0, 1], col, mat, aux)
    this.quad([x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [0, 0, -1], col, mat, aux)
    if (bottom) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0], col, mat, aux)
  }

  /** Vertical n-gon prism around (cx, cz), radius r0 at y0 tapering to r1 at y1. */
  prism(cx: number, cz: number, r0: number, r1: number, y0: number, y1: number, sides: number, col: Rgb, mat: Mat = MAT.lit, aux = 0, cap = true): void {
    for (let i = 0; i < sides; i++) {
      const a0 = (i / sides) * Math.PI * 2
      const a1 = ((i + 1) / sides) * Math.PI * 2
      const am = (a0 + a1) / 2
      const p = (a: number, r: number, y: number) => [cx + Math.cos(a) * r, y, cz + Math.sin(a) * r]
      const slope = (r0 - r1) / Math.max(0.001, y1 - y0)
      const n = [Math.cos(am), slope, Math.sin(am)]
      const l = Math.hypot(n[0]!, n[1]!, n[2]!)
      this.quad(p(a0, r0, y0), p(a0, r1, y1), p(a1, r1, y1), p(a1, r0, y0), [n[0]! / l, n[1]! / l, n[2]! / l], col, mat, aux)
      if (cap && r1 > 0.001) this.quad([cx, y1, cz], p(a1, r1, y1), p(a0, r1, y1), [cx, y1, cz], [0, 1, 0], col, mat, aux)
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

  toArray(): Float32Array<ArrayBuffer> {
    return new Float32Array(this.v)
  }
}
