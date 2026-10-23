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
  /** A fixed sky exposure instead of sky rays, e.g. 0 indoors when the roof isn't part of what is baked. */
  exposure?: number
  /** Corners closer than this (m) that face the same way share one set of rays (default 2 cm; a chamfer's edge). */
  merge?: number
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
  /**
   * Convex part per vertex (a box, a cylinder; negative = none): rays skip their own part's triangles, which can't
   * occlude them, so a chamfered box's own 90-odd triangles cost nothing.
   */
  parts?: ArrayLike<number>
}

type V3 = [number, number, number]

/** A bounding-volume hierarchy over triangles for short ray casts (median splits, up to four triangles a leaf). */
class TriangleBvh {
  /** Per triangle (in leaf order): its first corner, then its two edges from it. */
  readonly edges: Float64Array
  /** Original index of each leaf-ordered triangle (for the per-triangle stamps and parts). */
  readonly order: Int32Array
  /** Per node: min xyz, max xyz. */
  readonly box: Float64Array
  /** Per node: first child (inner) or first triangle (leaf), and triangle count (0 = inner). */
  readonly first: Int32Array
  readonly count: Int32Array
  nodes = 0
  constructor(tri: Float32Array) {
    const n = tri.length / 9
    const lo = new Float64Array(n * 3), hi = new Float64Array(n * 3), mid = new Float64Array(n * 3)
    for (let t = 0; t < n; t++) for (let k = 0; k < 3; k++) {
      const a = tri[t * 9 + k]!, b = tri[t * 9 + 3 + k]!, c = tri[t * 9 + 6 + k]!
      lo[t * 3 + k] = Math.min(a, b, c); hi[t * 3 + k] = Math.max(a, b, c); mid[t * 3 + k] = (a + b + c) / 3
    }
    const idx = new Int32Array(n).map((_, i) => i)
    const cap = Math.max(1, 2 * n)
    this.box = new Float64Array(cap * 6); this.first = new Int32Array(cap); this.count = new Int32Array(cap)
    const build = (node: number, from: number, to: number) => {
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity
      let c0 = [Infinity, Infinity, Infinity], c1 = [-Infinity, -Infinity, -Infinity]
      for (let i = from; i < to; i++) {
        const t = idx[i]! * 3
        x0 = Math.min(x0, lo[t]!); y0 = Math.min(y0, lo[t + 1]!); z0 = Math.min(z0, lo[t + 2]!)
        x1 = Math.max(x1, hi[t]!); y1 = Math.max(y1, hi[t + 1]!); z1 = Math.max(z1, hi[t + 2]!)
        for (let k = 0; k < 3; k++) { c0[k] = Math.min(c0[k]!, mid[t + k]!); c1[k] = Math.max(c1[k]!, mid[t + k]!) }
      }
      this.box.set([x0, y0, z0, x1, y1, z1], node * 6)
      const axis = c1[0]! - c0[0]! >= c1[1]! - c0[1]! && c1[0]! - c0[0]! >= c1[2]! - c0[2]! ? 0 : c1[1]! - c0[1]! >= c1[2]! - c0[2]! ? 1 : 2
      if (to - from <= 4 || c1[axis]! - c0[axis]! < 1e-9) { this.first[node] = from; this.count[node] = to - from; return }
      // Split at the centroid bounds' middle (falls back to the median when one side would be empty).
      const split = (c0[axis]! + c1[axis]!) / 2
      let m = from
      for (let i = from; i < to; i++) if (mid[idx[i]! * 3 + axis]! < split) { const tmp = idx[i]!; idx[i] = idx[m]!; idx[m] = tmp; m++ }
      if (m === from || m === to) {
        const part = Array.from(idx.subarray(from, to)).sort((a, b) => mid[a * 3 + axis]! - mid[b * 3 + axis]!)
        idx.set(part, from)
        m = (from + to) >> 1
      }
      const left = this.nodes; this.nodes += 2
      this.first[node] = left; this.count[node] = 0
      build(left, from, m); build(left + 1, m, to)
    }
    this.nodes = 1
    if (n) build(0, 0, n)
    else { this.box.set([0, 0, 0, -1, -1, -1]); this.count[0] = 0; this.first[0] = 0 }
    this.order = idx
    this.edges = new Float64Array(n * 9)
    for (let i = 0; i < n; i++) {
      const p = idx[i]! * 9, q = i * 9
      for (let k = 0; k < 3; k++) {
        this.edges[q + k] = tri[p + k]!
        this.edges[q + 3 + k] = tri[p + 3 + k]! - tri[p + k]!
        this.edges[q + 6 + k] = tri[p + 6 + k]! - tri[p + k]!
      }
    }
  }

  private readonly stack = new Int32Array(128)

  /**
   * Distance to the first triangle hit along `d` from `o` within `maxT`, or Infinity. Möller–Trumbore, two-sided.
   * `any` returns at the first hit found (a visibility test), not necessarily the nearest. Triangles whose `part` is
   * `self` are skipped.
   */
  cast(o: V3, d: V3, maxT: number, any = false, part: Int32Array | null = null, self = -2): number {
    const e = this.edges, box = this.box, first = this.first, count = this.count, order = this.order, stack = this.stack
    const ox = o[0], oy = o[1], oz = o[2], ddx = d[0], ddy = d[1], ddz = d[2]
    const ix = 1 / ddx, iy = 1 / ddy, iz = 1 / ddz
    let best = maxT, found = false, sp = 0
    stack[sp++] = 0
    while (sp > 0) {
      const node = stack[--sp]!, b = node * 6
      let ta = (box[b]! - ox) * ix, tb = (box[b + 3]! - ox) * ix
      let tmin = Math.min(ta, tb), tmax = Math.max(ta, tb)
      ta = (box[b + 1]! - oy) * iy; tb = (box[b + 4]! - oy) * iy
      tmin = Math.max(tmin, Math.min(ta, tb)); tmax = Math.min(tmax, Math.max(ta, tb))
      ta = (box[b + 2]! - oz) * iz; tb = (box[b + 5]! - oz) * iz
      tmin = Math.max(tmin, Math.min(ta, tb)); tmax = Math.min(tmax, Math.max(ta, tb))
      if (!(tmax >= Math.max(tmin, 0) && tmin <= best)) continue
      const c = count[node]!
      if (c === 0) { stack[sp++] = first[node]! + 1; stack[sp++] = first[node]!; continue }
      for (let i = first[node]!, end = i + c; i < end; i++) {
        if (part !== null && part[order[i]!] === self) continue
        const p = i * 9
        const e1x = e[p + 3]!, e1y = e[p + 4]!, e1z = e[p + 5]!
        const e2x = e[p + 6]!, e2y = e[p + 7]!, e2z = e[p + 8]!
        const px = ddy * e2z - ddz * e2y, py = ddz * e2x - ddx * e2z, pz = ddx * e2y - ddy * e2x
        const det = e1x * px + e1y * py + e1z * pz
        if (det > -1e-12 && det < 1e-12) continue
        const inv = 1 / det
        const sx = ox - e[p]!, sy = oy - e[p + 1]!, sz = oz - e[p + 2]!
        const u = (sx * px + sy * py + sz * pz) * inv
        if (u < 0 || u > 1) continue
        const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x
        const v = (ddx * qx + ddy * qy + ddz * qz) * inv
        if (v < 0 || u + v > 1) continue
        const hit = (e2x * qx + e2y * qy + e2z * qz) * inv
        if (hit > 1e-5 && hit <= best) { best = hit; found = true; if (any) return hit }
      }
    }
    return found ? best : Infinity
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
  const grid = new TriangleBvh(tri)
  const part = opts.parts ? new Int32Array(tri.length / 9).fill(-1) : null
  if (part) for (let t = 0; t < count / 3; t++) { const k = opts.parts![t * 3]; part[t] = k !== undefined && k >= 0 ? k : -1 }

  const hemi = spiral(rays, true)
  const sky = spiral(skyRays, false, Math.PI / 3)
  const ao = new Float32Array(count), exposure = new Float32Array(count), curvature = new Float32Array(count)
  // Triangle lists repeat every corner several times, and a chamfer's corners sit millimetres from its faces': cast once
  // per cell of `merge` facing the same way.
  const merge = opts.merge ?? 0.02
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
    const ax = Math.abs(n[0]) >= Math.abs(n[1]) && Math.abs(n[0]) >= Math.abs(n[2]) ? (n[0] > 0 ? 0 : 1) : Math.abs(n[1]) >= Math.abs(n[2]) ? (n[1] > 0 ? 2 : 3) : n[2] > 0 ? 4 : 5
    const pk = opts.parts?.[i]
    const self = pk !== undefined && pk >= 0 ? pk : -2
    const corner = `${Math.round(p[0] / merge)},${Math.round(p[1] / merge)},${Math.round(p[2] / merge)},${ax},${self}`
    const prior = seenAt.get(corner)
    if (prior !== undefined) { ao[i] = ao[prior]!; exposure[i] = exposure[prior]!; continue }
    seenAt.set(corner, i)
    // Start a hair off the surface (and a hair in from a corner, along the normal) so the vertex's own faces miss.
    const o: V3 = [p[0] + n[0] * 2e-3, p[1] + n[1] * 2e-3, p[2] + n[2] * 2e-3]
    const [t, b] = frame(n)
    let open = 0
    for (const h of hemi) {
      const d: V3 = [t[0] * h[0] + b[0] * h[1] + n[0] * h[2], t[1] * h[0] + b[1] * h[1] + n[1] * h[2], t[2] * h[0] + b[2] * h[1] + n[2] * h[2]]
      let hit = grid.cast(o, d, reach, false, part, self)
      if (below(o, d, reach)) hit = Math.min(hit, reach * 0.5)
      // Near hits occlude fully, hits at the end of reach hardly at all.
      open += hit === Infinity ? 1 : Math.min(1, hit / reach) ** 0.75
    }
    ao[i] = open / rays
    if (opts.exposure !== undefined) { exposure[i] = opts.exposure; continue }
    let seen = 0, possible = 0
    for (const s of sky) {
      const d: V3 = [s[0], s[2], s[1]]
      possible++
      if (d[0] * n[0] + d[1] * n[1] + d[2] * n[2] <= 0.02) continue
      if (grid.cast(o, d, skyReach, true, part, self) === Infinity) seen++
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
