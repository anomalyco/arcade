export type Rgb = [number, number, number]

/** Vertex: position (3), normal (3), color (3), material code (1). Material codes are stored as code / 4 in the color alpha. */
export const FLOATS_PER_VERT = 10
export const MAT = { lit: 0, facade: 1, emissive: 2, water: 3, flat: 4 } as const
export type Mat = (typeof MAT)[keyof typeof MAT]

export class Mesh {
  readonly v: number[] = []

  vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, c: Rgb, mat: Mat) {
    this.v.push(x, y, z, nx, ny, nz, c[0], c[1], c[2], mat / 4)
  }

  /** Quad from four corners in counter-clockwise order (as seen from the normal side). */
  quad(a: number[], b: number[], c: number[], d: number[], n: number[], col: Rgb, mat: Mat = MAT.lit) {
    for (const p of [a, b, c, a, c, d]) this.vert(p[0]!, p[1]!, p[2]!, n[0]!, n[1]!, n[2]!, col, mat)
  }

  box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, col: Rgb, mat: Mat = MAT.lit) {
    this.quad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [0, 1, 0], col, mat)
    this.quad([x0, y0, z1], [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [0, -1, 0], col, mat)
    this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1], col, mat)
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], col, mat)
    this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0], col, mat)
    this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0], col, mat)
  }

  /** Vertical prism or cone around (cx, cz). A top radius of 0 makes a pyramid-like cone. */
  prism(cx: number, cz: number, r0: number, r1: number, y0: number, y1: number, sides: number, col: Rgb, mat: Mat = MAT.lit, roof = true) {
    for (let i = 0; i < sides; i++) {
      const a0 = (i / sides) * Math.PI * 2
      const a1 = ((i + 1) / sides) * Math.PI * 2
      const p = (a: number, r: number, y: number) => [cx + Math.cos(a) * r, y, cz + Math.sin(a) * r]
      const am = (a0 + a1) / 2
      const n = [Math.cos(am), 0.4, Math.sin(am)]
      if (r1 <= 0.001) this.quad(p(a1, r0, y0), p(a0, r0, y0), [cx, y1, cz], [cx, y1, cz], [Math.cos(am), 0.9, Math.sin(am)], col, mat)
      else this.quad(p(a1, r0, y0), p(a0, r0, y0), p(a0, r1, y1), p(a1, r1, y1), n, col, mat)
      if (roof && r1 > 0.001) this.quad(p(a1, r1, y1), p(a0, r1, y1), [cx, y1, cz], [cx, y1, cz], [0, 1, 0], col, mat)
    }
  }

  /** Flat disc (top face only) with n-gon fan. */
  disc(cx: number, y: number, cz: number, r: number, sides: number, col: Rgb, mat: Mat = MAT.lit) {
    for (let i = 0; i < sides; i++) {
      const a0 = (i / sides) * Math.PI * 2
      const a1 = ((i + 1) / sides) * Math.PI * 2
      this.quad([cx, y, cz], [cx + Math.cos(a1) * r, y, cz + Math.sin(a1) * r], [cx + Math.cos(a0) * r, y, cz + Math.sin(a0) * r], [cx, y, cz], [0, 1, 0], col, mat)
    }
  }

  toArray(): Float32Array<ArrayBuffer> {
    return new Float32Array(this.v)
  }

  get count() {
    return this.v.length / FLOATS_PER_VERT
  }
}
