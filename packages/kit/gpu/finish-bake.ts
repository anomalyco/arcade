/**
 * Per-vertex finishing data for code-built and imported meshes: ambient occlusion, signed curvature and sky exposure,
 * baked once on the CPU from the triangles themselves (`bakeFinish`), and packed into the two spare bytes the kit's
 * 24-byte (and 32-byte textured) vertex already has, so the vertex stride does not change:
 *
 * - byte 15 (normal.w, snorm8): bit 0 = finished, bits 1–3 = look index (0–7), bits 4–7 = curvature (signed 4-bit, −7..7).
 * - byte 19 (colour.a, unorm8): high nibble = ambient occlusion (0 occluded … 15 open), low nibble = sky exposure.
 *
 * Unfinished vertices keep byte 15 at 0, so the shader reads them as untouched (`wearDecodeWgsl`). Colour alpha stays
 * 255 in unfinished kit meshes, which decodes as "open and exposed" should a shader ever read it unflagged.
 */

export type FinishBake = {
  /** 0 fully occluded … 1 open, cosine-weighted over the hemisphere within `reach`. */
  ao: Float32Array
  /** −1 concave … +1 convex (a 90° edge is ±1). */
  curvature: Float32Array
  /** Share of the sky within 60° of straight up that the vertex sees (rain and drips reach it). */
  exposure: Float32Array
}

export type FinishBakeOptions = {
  /** Hemisphere rays per vertex for AO (default 24). */
  rays?: number
  /** AO ray length (m, default 0.6): nearby geometry occludes, the far room does not. */
  reach?: number
  /** Sky rays per vertex (default 16) and their length (m, default 4): eaves and sills shelter what is below. */
  skyRays?: number
  skyReach?: number
  /** Ground under the mesh: a height (m), a height function, or null for none. Rays that pass below it are blocked. */
  ground?: number | ((x: number, z: number) => number) | null
  /** Extra occluding triangles (xyz per corner, triangle list) that are not themselves baked, such as a room's walls. */
  occluders?: ArrayLike<number>
  /**
   * Strips narrower than this (m) count as edges: their corners carry the crease's curvature. A wide face's corners
   * get none, so a flat wall doesn't read as one big rounded edge when its four corners are interpolated across it.
   */
  edgeBand?: number
  /** Curvature already known per vertex (NaN = bake it), e.g. from a chamfered box builder. */
  curvatureHints?: ArrayLike<number>
}

type V3 = [number, number, number]

/** A uniform grid over triangles for short ray casts. */
class TriangleGrid {
  readonly cells = new Map<number, number[]>()
  readonly min: V3
  readonly size: number
  readonly dims: V3
  constructor(readonly tri: Float32Array, cellTarget: number) {
    const n = tri.length / 9
    const lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i < tri.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k]!, tri[i + k]!); hi[k] = Math.max(hi[k]!, tri[i + k]!) }
    if (!n) { lo.fill(0); hi.fill(1) }
    const extent = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2], 1e-3)
    this.size = Math.max(cellTarget, extent / 96)
    this.min = [lo[0] - this.size * 0.5, lo[1] - this.size * 0.5, lo[2] - this.size * 0.5]
    this.dims = [0, 1, 2].map(k => Math.max(1, Math.ceil((hi[k]! - this.min[k]!) / this.size) + 1)) as V3
    for (let t = 0; t < n; t++) {
      const o = t * 9
      const c0 = [0, 1, 2].map(k => Math.floor((Math.min(tri[o + k]!, tri[o + 3 + k]!, tri[o + 6 + k]!) - this.min[k]!) / this.size))
      const c1 = [0, 1, 2].map(k => Math.floor((Math.max(tri[o + k]!, tri[o + 3 + k]!, tri[o + 6 + k]!) - this.min[k]!) / this.size))
      for (let x = c0[0]!; x <= c1[0]!; x++) for (let y = c0[1]!; y <= c1[1]!; y++) for (let z = c0[2]!; z <= c1[2]!; z++) {
        const key = this.key(x, y, z)
        let list = this.cells.get(key)
        if (!list) this.cells.set(key, (list = []))
        list.push(t)
      }
    }
  }
  private key(x: number, y: number, z: number) { return (x * this.dims[1] + y) * this.dims[2] + z }

  /** Distance to the first triangle hit along `d` from `o` within `maxT`, or Infinity. Möller–Trumbore, two-sided. */
  cast(o: V3, d: V3, maxT: number, stamp: Int32Array, ray: number): number {
    const s = this.size
    let x = Math.floor((o[0] - this.min[0]) / s), y = Math.floor((o[1] - this.min[1]) / s), z = Math.floor((o[2] - this.min[2]) / s)
    const step = [Math.sign(d[0]), Math.sign(d[1]), Math.sign(d[2])]
    const next = (c: number, k: number) => (this.min[k]! + (c + (step[k]! > 0 ? 1 : 0)) * s - o[k]!) / (d[k]! || 1e-30)
    let tx = d[0] ? next(x, 0) : Infinity, ty = d[1] ? next(y, 1) : Infinity, tz = d[2] ? next(z, 2) : Infinity
    const dx = d[0] ? s / Math.abs(d[0]) : Infinity, dy = d[1] ? s / Math.abs(d[1]) : Infinity, dz = d[2] ? s / Math.abs(d[2]) : Infinity
    let best = Infinity, t0 = 0
    const tri = this.tri
    while (t0 <= maxT && t0 < best) {
      if (x >= 0 && y >= 0 && z >= 0 && x < this.dims[0] && y < this.dims[1] && z < this.dims[2]) {
        const list = this.cells.get(this.key(x, y, z))
        if (list) for (const t of list) {
          if (stamp[t] === ray) continue
          stamp[t] = ray
          const p = t * 9
          const e1x = tri[p + 3]! - tri[p]!, e1y = tri[p + 4]! - tri[p + 1]!, e1z = tri[p + 5]! - tri[p + 2]!
          const e2x = tri[p + 6]! - tri[p]!, e2y = tri[p + 7]! - tri[p + 1]!, e2z = tri[p + 8]! - tri[p + 2]!
          const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x
          const det = e1x * px + e1y * py + e1z * pz
          if (Math.abs(det) < 1e-12) continue
          const inv = 1 / det
          const sx = o[0] - tri[p]!, sy = o[1] - tri[p + 1]!, sz = o[2] - tri[p + 2]!
          const u = (sx * px + sy * py + sz * pz) * inv
          if (u < 0 || u > 1) continue
          const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x
          const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv
          if (v < 0 || u + v > 1) continue
          const hit = (e2x * qx + e2y * qy + e2z * qz) * inv
          if (hit > 1e-5 && hit < best && hit <= maxT) best = hit
        }
      }
      if (tx <= ty && tx <= tz) { t0 = tx; tx += dx; x += step[0]! }
      else if (ty <= tz) { t0 = ty; ty += dy; y += step[1]! }
      else { t0 = tz; tz += dz; z += step[2]! }
    }
    return best
  }
}

/** Deterministic directions: a Fibonacci spiral over the unit hemisphere around +Z, cosine-weighted when `cosine`. */
function spiral(n: number, cosine: boolean, maxPolar = Math.PI / 2): V3[] {
  const out: V3[] = []
  const golden = Math.PI * (3 - Math.sqrt(5))
  const cMin = Math.cos(maxPolar)
  for (let i = 0; i < n; i++) {
    const f = (i + 0.5) / n
    // Cosine-weighted: sin²θ uniform in [0, 1). Uniform over the cap: cosθ uniform in [cMin, 1].
    const ct = cosine ? Math.sqrt(1 - f) : 1 - f * (1 - cMin)
    const st = Math.sqrt(Math.max(0, 1 - ct * ct))
    const a = i * golden
    out.push([Math.cos(a) * st, Math.sin(a) * st, ct])
  }
  return out
}

function frame(n: V3): [V3, V3] {
  const a: V3 = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]
  const t: V3 = [a[1] * n[2] - a[2] * n[1], a[2] * n[0] - a[0] * n[2], a[0] * n[1] - a[1] * n[0]]
  const l = Math.hypot(...t) || 1
  t[0] /= l; t[1] /= l; t[2] /= l
  const b: V3 = [n[1] * t[2] - n[2] * t[1], n[2] * t[0] - n[0] * t[2], n[0] * t[1] - n[1] * t[0]]
  return [t, b]
}

/**
 * Bakes AO, curvature and sky exposure for a triangle list (`pos`, `nrm`: xyz per vertex, three vertices per triangle).
 * Deterministic: the same mesh always bakes the same bytes.
 */
export function bakeFinish(pos: ArrayLike<number>, nrm: ArrayLike<number>, opts: FinishBakeOptions = {}): FinishBake {
  const count = Math.floor(pos.length / 3)
  const rays = opts.rays ?? 24, reach = opts.reach ?? 0.6
  const skyRays = opts.skyRays ?? 16, skyReach = opts.skyReach ?? 4
  const band = opts.edgeBand ?? 0.06
  const ground = opts.ground === undefined ? null : opts.ground
  const groundAt = typeof ground === "number" ? () => ground : ground
  const extra = opts.occluders ? opts.occluders.length : 0
  const tri = new Float32Array(count * 3 + extra)
  for (let i = 0; i < count * 3; i++) tri[i] = pos[i]!
  for (let i = 0; i < extra; i++) tri[count * 3 + i] = opts.occluders![i]!
  const grid = new TriangleGrid(tri, Math.max(reach / 2, 0.05))
  const stamp = new Int32Array(tri.length / 9).fill(-1)
  let ray = 0

  const hemi = spiral(rays, true)
  const sky = spiral(skyRays, false, Math.PI / 3)
  const ao = new Float32Array(count), exposure = new Float32Array(count), curvature = new Float32Array(count)
  // Triangle lists repeat every corner several times with the same normal: cast once per distinct corner.
  const seenAt = new Map<string, number>()
  const below = (p: V3, d: V3, t: number) => {
    if (!groundAt) return false
    for (const f of [0.35, 0.7, 1]) {
      const x = p[0] + d[0] * t * f, y = p[1] + d[1] * t * f, z = p[2] + d[2] * t * f
      if (y < groundAt(x, z) - 1e-3) return true
    }
    return false
  }
  for (let i = 0; i < count; i++) {
    const p: V3 = [pos[i * 3]!, pos[i * 3 + 1]!, pos[i * 3 + 2]!]
    const n: V3 = [nrm[i * 3]!, nrm[i * 3 + 1]!, nrm[i * 3 + 2]!]
    const nl = Math.hypot(...n) || 1
    n[0] /= nl; n[1] /= nl; n[2] /= nl
    const corner = `${Math.round(p[0] * 1e4)},${Math.round(p[1] * 1e4)},${Math.round(p[2] * 1e4)},${Math.round(n[0] * 64)},${Math.round(n[1] * 64)},${Math.round(n[2] * 64)}`
    const prior = seenAt.get(corner)
    if (prior !== undefined) { ao[i] = ao[prior]!; exposure[i] = exposure[prior]!; continue }
    seenAt.set(corner, i)
    // Start a hair off the surface (and a hair in from a corner, along the normal) so the vertex's own faces miss.
    const o: V3 = [p[0] + n[0] * 2e-3, p[1] + n[1] * 2e-3, p[2] + n[2] * 2e-3]
    const [t, b] = frame(n)
    let open = 0
    for (const h of hemi) {
      const d: V3 = [t[0] * h[0] + b[0] * h[1] + n[0] * h[2], t[1] * h[0] + b[1] * h[1] + n[1] * h[2], t[2] * h[0] + b[2] * h[1] + n[2] * h[2]]
      let hit = grid.cast(o, d, reach, stamp, ray++)
      if (below(o, d, reach)) hit = Math.min(hit, reach * 0.5)
      // Near hits occlude fully, hits at the end of reach hardly at all.
      open += hit === Infinity ? 1 : Math.min(1, hit / reach) ** 0.75
    }
    ao[i] = open / rays
    let seen = 0, possible = 0
    for (const s of sky) {
      const d: V3 = [s[0], s[2], s[1]]
      possible++
      if (d[0] * n[0] + d[1] * n[1] + d[2] * n[2] <= 0.02) continue
      if (grid.cast(o, d, skyReach, stamp, ray++) === Infinity) seen++
    }
    exposure[i] = possible ? seen / possible : 1
  }

  // Curvature: weld corners by position, then average the signed dihedral angle of the creased edges at each corner.
  const key = (i: number) => `${Math.round(pos[i * 3]! * 2e4)},${Math.round(pos[i * 3 + 1]! * 2e4)},${Math.round(pos[i * 3 + 2]! * 2e4)}`
  const ids = new Int32Array(count)
  const weld = new Map<string, number>()
  for (let i = 0; i < count; i++) {
    const k = key(i)
    let id = weld.get(k)
    if (id === undefined) weld.set(k, (id = weld.size))
    ids[i] = id
  }
  const faceN: V3[] = [], faceMinH: number[] = []
  for (let f = 0; f < count / 3; f++) {
    const a = f * 9
    const e1: V3 = [pos[a + 3]! - pos[a]!, pos[a + 4]! - pos[a + 1]!, pos[a + 5]! - pos[a + 2]!]
    const e2: V3 = [pos[a + 6]! - pos[a]!, pos[a + 7]! - pos[a + 1]!, pos[a + 8]! - pos[a + 2]!]
    const c: V3 = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]
    const area2 = Math.hypot(...c) || 1e-12
    faceN.push([c[0] / area2, c[1] / area2, c[2] / area2])
    // Smallest altitude: twice the area over the longest edge.
    const e3: V3 = [pos[a + 6]! - pos[a + 3]!, pos[a + 7]! - pos[a + 4]!, pos[a + 8]! - pos[a + 5]!]
    faceMinH.push(area2 / Math.max(Math.hypot(...e1), Math.hypot(...e2), Math.hypot(...e3), 1e-9))
  }
  const edges = new Map<string, number[]>()
  for (let f = 0; f < count / 3; f++) for (let e = 0; e < 3; e++) {
    const a = ids[f * 3 + e]!, b = ids[f * 3 + ((e + 1) % 3)]!
    if (a === b) continue
    const k = a < b ? `${a}:${b}` : `${b}:${a}`
    let list = edges.get(k)
    if (!list) edges.set(k, (list = []))
    list.push(f)
  }
  const sum = new Float32Array(weld.size), creases = new Float32Array(weld.size)
  for (const [k, faces] of edges) {
    if (faces.length < 2) continue
    const [a, b] = k.split(":").map(Number) as [number, number]
    // A position can be shared by several faces on each side (split vertices); compare the first pair of distinct normals.
    const f1 = faces[0]!
    let f2 = -1
    for (const f of faces.slice(1)) if (faceN[f]![0] * faceN[f1]![0] + faceN[f]![1] * faceN[f1]![1] + faceN[f]![2] * faceN[f1]![2] < 0.9962) { f2 = f; break }
    if (f2 < 0) continue
    const n1 = faceN[f1]!, n2 = faceN[f2]!
    const angle = Math.acos(Math.max(-1, Math.min(1, n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2])))
    // Convex when the second face's far corner lies behind the first face's plane.
    let far = -1
    for (let c = 0; c < 3; c++) { const id = ids[f2 * 3 + c]!; if (id !== a && id !== b) far = f2 * 3 + c }
    if (far < 0) continue
    const o = f1 * 3
    const side = (pos[far * 3]! - pos[o * 3]!) * n1[0] + (pos[far * 3 + 1]! - pos[o * 3 + 1]!) * n1[1] + (pos[far * 3 + 2]! - pos[o * 3 + 2]!) * n1[2]
    const signed = (side < 0 ? 1 : -1) * Math.min(1, angle / (Math.PI / 2))
    for (const id of [a, b]) { sum[id] = sum[id]! + signed; creases[id] = creases[id]! + 1 }
  }
  for (let i = 0; i < count; i++) {
    const hint = opts.curvatureHints?.[i]
    if (hint !== undefined && !Number.isNaN(hint)) { curvature[i] = hint; continue }
    const id = ids[i]!
    const c = creases[id]! ? sum[id]! / creases[id]! : 0
    // Wide faces carry no edge: their corners are interpolated across the whole face.
    const h = faceMinH[Math.floor(i / 3)]!
    curvature[i] = c * Math.max(0, Math.min(1, (band * 2 - h) / band))
  }
  return { ao, curvature, exposure }
}

/** Byte 15 of a finished vertex: finished flag, look index (0–7) and 4-bit signed curvature. */
export function finishByte15(curvature: number, look: number): number {
  const c = Math.max(-7, Math.min(7, Math.round(curvature * 7)))
  const b = ((c & 15) << 4) | ((look & 7) << 1) | 1
  return b > 127 ? b - 256 : b
}

/** Byte 19 of a finished vertex: AO in the high nibble, sky exposure in the low. */
export function finishByte19(ao: number, exposure: number): number {
  const q = (v: number) => Math.max(0, Math.min(15, Math.round(v * 15)))
  return (q(ao) << 4) | q(exposure)
}

/** Decodes the two bytes (as the shader does): null for an unfinished vertex. */
export function decodeFinish(b15: number, b19: number): { look: number; curvature: number; ao: number; exposure: number } | null {
  const u = b15 & 255
  if (!(u & 1)) return null
  const c = (u >> 4) & 15
  return { look: (u >> 1) & 7, curvature: (c > 7 ? c - 16 : c) / 7, ao: ((b19 >> 4) & 15) / 15, exposure: (b19 & 15) / 15 }
}

/**
 * Writes a bake into packed vertices in place (`stride` 24 for `packVerts`, 32 for textured vertices), for vertices
 * `first`..`first + bake.ao.length`.
 */
export function writeFinish(buf: ArrayBuffer, stride: number, bake: FinishBake, look: number, first = 0): void {
  const i8 = new Int8Array(buf), u8 = new Uint8Array(buf)
  for (let i = 0; i < bake.ao.length; i++) {
    const o = (first + i) * stride
    i8[o + 15] = finishByte15(bake.curvature[i]!, look)
    u8[o + 19] = finishByte19(bake.ao[i]!, bake.exposure[i]!)
  }
}

/** Positions and normals of packed vertices (24- or 32-byte stride) for `bakeFinish`. */
export function readPacked(buf: ArrayBuffer, stride: number, first = 0, count = buf.byteLength / stride - first): { pos: Float32Array; nrm: Float32Array } {
  const view = new DataView(buf)
  const pos = new Float32Array(count * 3), nrm = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    const o = (first + i) * stride
    for (let k = 0; k < 3; k++) {
      pos[i * 3 + k] = view.getFloat32(o + k * 4, true)
      nrm[i * 3 + k] = view.getInt8(o + 12 + k) / 127
    }
  }
  return { pos, nrm }
}
