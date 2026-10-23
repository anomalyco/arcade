import { autoChamfer, chamferBox, chamferCylinder, type FinishVertex } from "./finish-geom"

export type Rgb = readonly [number, number, number]

/** sRGB hex (0xRRGGBB) to a 0..1 triple. */
export const hex = (h: number): Rgb => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255]

/** Vertex while building: position (3), normal (3), colour (3), material (1), aux (1). */
export const FLOATS_PER_VERT = 11
/** Packed GPU vertex: position f32x3, normal snorm8x4, colour unorm8x4, material and aux f16x2. */
export const VERT_BYTES = 24

/**
 * Materials the scene shader understands.
 * - lit: diffuse, lit by nearby lights through the shadow map
 * - floor: lit, with a procedural pattern; aux is the floor kind
 * - lamp: emissive fixture tied to map light `aux`, dims and flickers with it
 * - glow: constant emissive; aux scales it (LEDs, screens)
 * - wall: lit, and dithered away when it stands between the camera and you
 * - tape: floor tape
 * - glass: translucent, picks up nearby light
 * - city: the night city far below the windows
 * - accent: takes the instance's team colour
 * - actor: soldiers; lit like props but with a cool rim so silhouettes read in the dark
 * - cloth: matte actor material multiplied by the instance's team tint (wizard robes and hats)
 * - cap: the top of a wall, lit by the night sky and a rim light so the plan reads in the dark
 * - shiny: lit, glossy (screens off, metal, whiteboards)
 * - haze: additive light cone under a fixture; aux is its map light
 * - mote: a speck of dust drifting in a light; normal holds its quad corner and phase, aux its map light
 * - retro: retroreflective sheeting (a sign, a reflector): lit as paint, plus a narrow return towards a light near the
 *   eye (a torch you hold); aux is its gain over paint on that axis (the forest batch caps it at RETRO_MAX). Other
 *   scenes light it as plain paint.
 */
export const MAT = { lit: 0, floor: 1, lamp: 2, glow: 3, wall: 4, tape: 5, glass: 6, city: 7, accent: 8, cap: 9, shiny: 10, haze: 11, actor: 12, mote: 13, cloth: 14, chitin: 15, retro: 16, ground: 20, roof: 21, foliage: 22, brick: 23, timber: 24 } as const
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

/**
 * Packs build-time vertices (FLOATS_PER_VERT each) into the GPU layout. Byte 15 (normal.w) and byte 19 (colour.a)
 * are the finishing pass's (`finish-bake.ts`); `finish` supplies them, two per vertex, else they stay 0 and 255.
 */
export function packVerts(v: ArrayLike<number>, from = 0, to = v.length, finish?: Uint8Array | null): ArrayBuffer {
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
    i8[o + 15] = finish ? (finish[k * 2]! << 24) >> 24 : 0
    b[o + 16] = clampByte(v[s + 6]!)
    b[o + 17] = clampByte(v[s + 7]!)
    b[o + 18] = clampByte(v[s + 8]!)
    b[o + 19] = finish ? finish[k * 2 + 1]! : 255
    h[(o + 20) / 2] = toHalf(v[s + 9]!)
    h[(o + 22) / 2] = toHalf(v[s + 10]!)
  }
  return out
}

export type MeshOptions = {
  /**
   * One-segment chamfer on every `box` and `cylinder` edge: metres, or "auto" (about 1.2% of the part's smallest side,
   * 2–12 mm, `autoChamfer`). 0 (the default) draws today's square boxes.
   */
  chamfer?: number | "auto"
  /** Width of the wear band inset on each chamfered face (m), so edge wear has vertices to fade over. */
  wearBand?: number
}

export class Mesh {
  readonly v: number[] = []
  chamfer: number | "auto"
  wearBand: number
  /** Curvature per vertex index written by the chamfered builders (sparse; holes are baked by `finish`). */
  readonly curvatureHints: number[] = []
  /** Finish look index per vertex index, from `finishPart` (sparse; untagged vertices stay unfinished). */
  readonly finishLooks: number[] = []
  /** Bytes 15 and 19 per vertex from `finish`; `pack` uses them while they cover every vertex. */
  finishBytes: Uint8Array | null = null

  constructor(opts: MeshOptions = {}) {
    this.chamfer = opts.chamfer ?? 0
    this.wearBand = opts.wearBand ?? 0.03
  }

  /**
   * Tags everything `build` emits with a finish look (an index into `FINISH_LOOKS`), optionally with chamfered edges
   * while it runs; `finishTagged` (`finish.ts`) bakes the tagged vertices before packing.
   */
  finishPart(look: number, build: () => void, chamfer: number | "auto" = this.chamfer): void {
    const prior = this.chamfer, first = this.count
    this.chamfer = chamfer
    try { build() } finally { this.chamfer = prior }
    for (let i = first; i < this.count; i++) this.finishLooks[i] = look
  }

  /** Appends `src`'s triangle starting at float `at`, with its finishing tags. */
  copyTriangle(src: Mesh, at: number): void {
    const from = at / FLOATS_PER_VERT, to = this.count
    for (let k = at; k < at + FLOATS_PER_VERT * 3; k++) this.v.push(src.v[k]!)
    for (let j = 0; j < 3; j++) {
      const look = src.finishLooks[from + j], hint = src.curvatureHints[from + j]
      if (look !== undefined) this.finishLooks[to + j] = look
      if (hint !== undefined) this.curvatureHints[to + j] = hint
    }
  }

  private chamferFor(w: number, h: number, d: number): number {
    if (this.chamfer === "auto") return autoChamfer(w, h, d)
    return Math.max(0, this.chamfer)
  }

  private emitFinished(tris: readonly FinishVertex[], col: (face: number) => Rgb, mat: (face: number) => Mat, aux: number): void {
    for (const t of tris) {
      const c = col(t.face)
      this.curvatureHints[this.v.length / FLOATS_PER_VERT] = t.k
      this.v.push(t.p[0], t.p[1], t.p[2], t.n[0], t.n[1], t.n[2], c[0], c[1], c[2], mat(t.face), aux)
    }
  }

  vert(p: readonly number[], n: readonly number[], c: Rgb, mat: Mat, aux = 0): void {
    this.v.push(p[0]!, p[1]!, p[2]!, n[0]!, n[1]!, n[2]!, c[0], c[1], c[2], mat, aux)
  }

  /** Quad from four corners, counter-clockwise seen from the normal side. */
  quad(a: number[], b: number[], c: number[], d: number[], n: number[], col: Rgb, mat: Mat = MAT.lit, aux = 0): void {
    const nx = n[0]!, ny = n[1]!, nz = n[2]!
    const cr = col[0], cg = col[1], cb = col[2]
    this.v.push(
      a[0]!, a[1]!, a[2]!, nx, ny, nz, cr, cg, cb, mat, aux,
      b[0]!, b[1]!, b[2]!, nx, ny, nz, cr, cg, cb, mat, aux,
      c[0]!, c[1]!, c[2]!, nx, ny, nz, cr, cg, cb, mat, aux,
      a[0]!, a[1]!, a[2]!, nx, ny, nz, cr, cg, cb, mat, aux,
      c[0]!, c[1]!, c[2]!, nx, ny, nz, cr, cg, cb, mat, aux,
      d[0]!, d[1]!, d[2]!, nx, ny, nz, cr, cg, cb, mat, aux,
    )
  }

  /** Quad with its normal from the winding of a, b, c. */
  quadAuto(a: number[], b: number[], c: number[], d: number[], col: Rgb, mat: Mat = MAT.lit, aux = 0): void {
    const ux = b[0]! - a[0]!, uy = b[1]! - a[1]!, uz = b[2]! - a[2]!
    const wx = c[0]! - a[0]!, wy = c[1]! - a[1]!, wz = c[2]! - a[2]!
    const rx = uy * wz - uz * wy, ry = uz * wx - ux * wz, rz = ux * wy - uy * wx
    const invL = 1 / (Math.hypot(rx, ry, rz) || 1)
    const nx = rx * invL, ny = ry * invL, nz = rz * invL
    const cr = col[0], cg = col[1], cb = col[2]
    this.v.push(
      a[0]!, a[1]!, a[2]!, nx, ny, nz, cr, cg, cb, mat, aux,
      b[0]!, b[1]!, b[2]!, nx, ny, nz, cr, cg, cb, mat, aux,
      c[0]!, c[1]!, c[2]!, nx, ny, nz, cr, cg, cb, mat, aux,
      a[0]!, a[1]!, a[2]!, nx, ny, nz, cr, cg, cb, mat, aux,
      c[0]!, c[1]!, c[2]!, nx, ny, nz, cr, cg, cb, mat, aux,
      d[0]!, d[1]!, d[2]!, nx, ny, nz, cr, cg, cb, mat, aux,
    )
  }

  /** Triangle with a normal from its winding. */
  facet(a: number[], b: number[], c: number[], col: Rgb, mat: Mat = MAT.lit, aux = 0): void {
    const ux = b[0]! - a[0]!, uy = b[1]! - a[1]!, uz = b[2]! - a[2]!
    const wx = c[0]! - a[0]!, wy = c[1]! - a[1]!, wz = c[2]! - a[2]!
    const rx = uy * wz - uz * wy, ry = uz * wx - ux * wz, rz = ux * wy - uy * wx
    const invL = 1 / (Math.hypot(rx, ry, rz) || 1)
    const nx = rx * invL, ny = ry * invL, nz = rz * invL
    const cr = col[0], cg = col[1], cb = col[2]
    this.v.push(
      a[0]!, a[1]!, a[2]!, nx, ny, nz, cr, cg, cb, mat, aux,
      b[0]!, b[1]!, b[2]!, nx, ny, nz, cr, cg, cb, mat, aux,
      c[0]!, c[1]!, c[2]!, nx, ny, nz, cr, cg, cb, mat, aux,
    )
  }

  /** Axis-aligned box. `top` overrides the colour of the upper face. */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, col: Rgb, mat: Mat = MAT.lit, aux = 0, top?: Rgb, bottom = false, topMat: Mat = mat): void {
    const r = this.chamfer ? this.chamferFor(x1 - x0, y1 - y0, z1 - z0) : 0
    if (r > 0) {
      const tc = top ?? col
      this.emitFinished(chamferBox(x0, y0, z0, x1, y1, z1, r, this.wearBand, bottom ? 0b111111 : 0b011111), f => (f === 0 ? tc : col), f => (f === 0 ? topMat : mat), aux)
      return
    }
    const t = top ?? col
    const tr = t[0], tg = t[1], tb = t[2]
    const cr = col[0], cg = col[1], cb = col[2]
    this.v.push(
      // Top (+Y)
      x0, y1, z1, 0, 1, 0, tr, tg, tb, topMat, aux,
      x1, y1, z1, 0, 1, 0, tr, tg, tb, topMat, aux,
      x1, y1, z0, 0, 1, 0, tr, tg, tb, topMat, aux,
      x0, y1, z1, 0, 1, 0, tr, tg, tb, topMat, aux,
      x1, y1, z0, 0, 1, 0, tr, tg, tb, topMat, aux,
      x0, y1, z0, 0, 1, 0, tr, tg, tb, topMat, aux,
      // Left (-X)
      x0, y0, z1, -1, 0, 0, cr, cg, cb, mat, aux,
      x0, y1, z1, -1, 0, 0, cr, cg, cb, mat, aux,
      x0, y1, z0, -1, 0, 0, cr, cg, cb, mat, aux,
      x0, y0, z1, -1, 0, 0, cr, cg, cb, mat, aux,
      x0, y1, z0, -1, 0, 0, cr, cg, cb, mat, aux,
      x0, y0, z0, -1, 0, 0, cr, cg, cb, mat, aux,
      // Right (+X)
      x1, y0, z0, 1, 0, 0, cr, cg, cb, mat, aux,
      x1, y1, z0, 1, 0, 0, cr, cg, cb, mat, aux,
      x1, y1, z1, 1, 0, 0, cr, cg, cb, mat, aux,
      x1, y0, z0, 1, 0, 0, cr, cg, cb, mat, aux,
      x1, y1, z1, 1, 0, 0, cr, cg, cb, mat, aux,
      x1, y0, z1, 1, 0, 0, cr, cg, cb, mat, aux,
      // Front (+Z)
      x1, y0, z1, 0, 0, 1, cr, cg, cb, mat, aux,
      x1, y1, z1, 0, 0, 1, cr, cg, cb, mat, aux,
      x0, y1, z1, 0, 0, 1, cr, cg, cb, mat, aux,
      x1, y0, z1, 0, 0, 1, cr, cg, cb, mat, aux,
      x0, y1, z1, 0, 0, 1, cr, cg, cb, mat, aux,
      x0, y0, z1, 0, 0, 1, cr, cg, cb, mat, aux,
      // Back (-Z)
      x0, y0, z0, 0, 0, -1, cr, cg, cb, mat, aux,
      x0, y1, z0, 0, 0, -1, cr, cg, cb, mat, aux,
      x1, y1, z0, 0, 0, -1, cr, cg, cb, mat, aux,
      x0, y0, z0, 0, 0, -1, cr, cg, cb, mat, aux,
      x1, y1, z0, 0, 0, -1, cr, cg, cb, mat, aux,
      x1, y0, z0, 0, 0, -1, cr, cg, cb, mat, aux,
    )
    if (bottom) {
      this.v.push(
        x0, y0, z0, 0, -1, 0, cr, cg, cb, mat, aux,
        x1, y0, z0, 0, -1, 0, cr, cg, cb, mat, aux,
        x1, y0, z1, 0, -1, 0, cr, cg, cb, mat, aux,
        x0, y0, z0, 0, -1, 0, cr, cg, cb, mat, aux,
        x1, y0, z1, 0, -1, 0, cr, cg, cb, mat, aux,
        x0, y0, z1, 0, -1, 0, cr, cg, cb, mat, aux,
      )
    }
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
    // Curvature for the finishing bake: the sloped strips are the edge; the wide faces carry none (no band to fade over).
    const first = this.count - 54
    for (let i = 0; i < 54; i++) this.curvatureHints[first + i] = i >= 24 && i < 48 ? 1 : 0
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

  /**
   * Smooth vertical cylinder around (cx, cz), radius `r` from y0 to y1, capped on top (and below when `bottom`). With
   * the mesh's chamfer set, its rims get a one-segment chamfer and a wear band.
   */
  cylinder(cx: number, cz: number, r: number, y0: number, y1: number, sides: number, col: Rgb, mat: Mat = MAT.lit, aux = 0, opts: { top?: boolean; bottom?: boolean; phase?: number; topColor?: Rgb } = {}): void {
    const c = this.chamfer ? this.chamferFor(r * 2, y1 - y0, r * 2) : 0
    const tc = opts.topColor ?? col
    this.emitFinished(chamferCylinder(cx, cz, r, y0, y1, sides, c, c > 0 ? this.wearBand : 0, opts), f => (f === 0 ? tc : col), () => mat, aux)
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
    const f = this.finishBytes
    return packVerts(this.v, 0, this.v.length, f && f.length === this.count * 2 ? f : null)
  }
}
