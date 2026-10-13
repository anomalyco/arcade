import { type AtlasRegion, regionUv } from "./atlas"

export type Rgb = [number, number, number]

/** Vertex: position (3), normal (3), color (3), material code (1), atlas uv (2). */
export const FLOATS_PER_VERT = 12
/** Reserved effect material; 10–11 belong to the independently developed building/window styles. */
export const SMOKE_MATERIAL = 12
type MeshMaterial = Mat | typeof SMOKE_MATERIAL

/**
 * Material codes understood by the lit shader.
 * - lit: flat-shaded diffuse
 * - facade: lit wall that also gets procedural windows from the shader (legacy; prefer geometry windows)
 * - emissive: self-lit (lamps, lit windows, neon). Brightness = color * 2.2
 * - water: animated ripples
 * - flat: lit but not cut away by the camera cutaway (road paint)
 * - siren: police lightbar lamp (strobes red/blue from instance params)
 * - glass: dark glossy glass with a moonlight sheen
 * - decal: alpha-tested atlas texture multiplied by color, lit
 * - neon: alpha-tested atlas texture, emissive (signs, backlit billboards)
 * - window: self-lit pane, with optional room colour variation
 */
export const MAT = { lit: 0, facade: 1, emissive: 2, water: 3, flat: 4, siren: 5, glass: 6, decal: 7, neon: 8, window: 9 } as const
export type Mat = (typeof MAT)[keyof typeof MAT]

/** The atlas texel that is pure white; untextured geometry samples it. */
const WHITE_U = 2 / 2048
const WHITE_V = 2 / 2048

export class Mesh {
  readonly v: number[] = []

  vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, c: Rgb, mat: MeshMaterial, u = WHITE_U, w = WHITE_V) {
    this.v.push(x, y, z, nx, ny, nz, c[0], c[1], c[2], mat, u, w)
  }

  /** Quad from four corners in counter-clockwise order (as seen from the normal side). */
  quad(a: number[], b: number[], c: number[], d: number[], n: number[], col: Rgb, mat: Mat = MAT.lit) {
    // Window panes do not sample the atlas. Bake their stable room tint into the unused U channel.
    const u = mat === MAT.window ? (col[0] * 17 + col[1] * 41) % 1 : WHITE_U
    for (const p of [a, b, c, a, c, d]) this.vert(p[0]!, p[1]!, p[2]!, n[0]!, n[1]!, n[2]!, col, mat, u)
  }

  /** Triangle, counter-clockwise from the normal side. */
  tri(a: number[], b: number[], c: number[], n: number[], col: Rgb, mat: MeshMaterial = MAT.lit) {
    for (const p of [a, b, c]) this.vert(p[0]!, p[1]!, p[2]!, n[0]!, n[1]!, n[2]!, col, mat)
  }

  /** Triangle with its normal computed from the winding (flat shading for faceted shapes). */
  facet(a: number[], b: number[], c: number[], col: Rgb, mat: MeshMaterial = MAT.lit) {
    const ux = b[0]! - a[0]!, uy = b[1]! - a[1]!, uz = b[2]! - a[2]!
    const vx = c[0]! - a[0]!, vy = c[1]! - a[1]!, vz = c[2]! - a[2]!
    let nx = uy * vz - uz * vy
    let ny = uz * vx - ux * vz
    let nz = ux * vy - uy * vx
    const l = Math.hypot(nx, ny, nz) || 1
    nx /= l
    ny /= l
    nz /= l
    this.tri(a, b, c, [nx, ny, nz], col, mat)
  }

  /**
   * Textured quad mapped to an atlas region: a = bottom-left, b = bottom-right, c = top-right, d = top-left of the
   * image (counter-clockwise from the normal side). Use MAT.decal (lit) or MAT.neon (emissive); color tints the texture.
   */
  decal(a: number[], b: number[], c: number[], d: number[], n: number[], region: AtlasRegion, col: Rgb = [1, 1, 1], mat: Mat = MAT.decal) {
    const [u0, v0, u1, v1] = regionUv(region)
    const uv = [
      [u0, v1],
      [u1, v1],
      [u1, v0],
      [u0, v0],
    ]
    const pts = [a, b, c, d]
    for (const i of [0, 1, 2, 0, 2, 3]) {
      const p = pts[i]!
      this.vert(p[0]!, p[1]!, p[2]!, n[0]!, n[1]!, n[2]!, col, mat, uv[i]![0], uv[i]![1])
    }
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

  /** Appends another mesh (already in this mesh's space). */
  append(other: Mesh) {
    for (let i = 0; i < other.v.length; i++) this.v.push(other.v[i]!)
  }

  toArray(): Float32Array<ArrayBuffer> {
    return new Float32Array(this.v)
  }

  get count() {
    return this.v.length / FLOATS_PER_VERT
  }
}
