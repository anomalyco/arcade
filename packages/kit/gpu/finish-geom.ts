/**
 * Chamfered primitives for the finishing pass: a one-segment chamfer on every edge between two drawn faces, with
 * normals blended halfway between the face and the edge so the highlight is soft, plus a thin band inset on each face
 * so edge wear has vertices to fade over. Every vertex carries its curvature (1 on the chamfer, 0.5 where a face meets
 * it, 0 past the band), which the finishing bake keeps instead of guessing.
 */

export type FinishVertex = { p: [number, number, number]; n: [number, number, number]; k: number; face: number }

/** Face order: +Y (top), −X, +X, +Z, −Z, −Y (bottom). */
const FACES: { n: [number, number, number]; u: number; v: number }[] = [
  { n: [0, 1, 0], u: 0, v: 2 }, { n: [-1, 0, 0], u: 2, v: 1 }, { n: [1, 0, 0], u: 2, v: 1 },
  { n: [0, 0, 1], u: 0, v: 1 }, { n: [0, 0, -1], u: 0, v: 1 }, { n: [0, -1, 0], u: 0, v: 2 },
]

/** Longest triangle edge (m) a finished box keeps (`splitLong`): its baked AO and exposure vary across big faces. */
export const FINISH_SPLIT = 1.3

/** The kit's automatic chamfer for a part: about 1.2% of its smallest side, between 2 and 12 mm. */
export function autoChamfer(w: number, h: number, d: number): number {
  return Math.max(0.002, Math.min(0.012, 0.012 * Math.min(w, h, d)))
}

const norm = (v: number[]): [number, number, number] => {
  const l = Math.hypot(v[0]!, v[1]!, v[2]!) || 1
  return [v[0]! / l, v[1]! / l, v[2]! / l]
}

/**
 * Triangles (counter-clockwise from outside) of an axis-aligned box with chamfer `r`. `faces` masks the drawn faces in
 * `FACES` order (bit i); edges are chamfered only between two drawn faces, so a box without a bottom stays square at
 * its foot. `band` is the width of the wear band inset on each face (0 for none).
 */
export function chamferBox(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, r: number, band: number, faces = 0b011111): FinishVertex[] {
  const lo = [x0, y0, z0], hi = [x1, y1, z1]
  const half = [(x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2]
  r = Math.max(0, Math.min(r, half[0]! * 0.45, half[1]! * 0.45, half[2]! * 0.45))
  const has = (f: number) => ((faces >> f) & 1) === 1
  // The face across axis `a` on side `s` (−1 / +1).
  const faceOf = (a: number, s: number) => (a === 1 ? (s > 0 ? 0 : 5) : a === 0 ? (s > 0 ? 2 : 1) : s > 0 ? 3 : 4)
  const out: FinishVertex[] = []
  const tri = (a: FinishVertex, b: FinishVertex, c: FinishVertex) => {
    // Orient by the average normal so callers don't track winding.
    const e1 = [b.p[0] - a.p[0], b.p[1] - a.p[1], b.p[2] - a.p[2]], e2 = [c.p[0] - a.p[0], c.p[1] - a.p[1], c.p[2] - a.p[2]]
    const cr = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!]
    const nn = [a.n[0] + b.n[0] + c.n[0], a.n[1] + b.n[1] + c.n[1], a.n[2] + b.n[2] + c.n[2]]
    if (cr[0]! * nn[0]! + cr[1]! * nn[1]! + cr[2]! * nn[2]! < 0) out.push(a, c, b)
    else out.push(a, b, c)
  }
  const quad = (a: FinishVertex, b: FinishVertex, c: FinishVertex, d: FinishVertex) => { tri(a, b, c); tri(a, c, d) }
  const V = (p: number[], n: number[], k: number, face: number): FinishVertex => ({ p: [p[0]!, p[1]!, p[2]!], n: norm(n), k, face })

  for (let f = 0; f < 6; f++) {
    if (!has(f)) continue
    const F = FACES[f]!
    const a = F.n.findIndex(v => v !== 0), s = F.n[a]!
    const plane = s > 0 ? hi[a]! : lo[a]!
    // Inset on each side of the face: r toward a drawn neighbour, 0 toward an open side.
    const ins = (axis: number, side: number) => (has(faceOf(axis, side)) ? r : 0)
    const u0 = lo[F.u]! + ins(F.u, -1), u1 = hi[F.u]! - ins(F.u, 1)
    const v0 = lo[F.v]! + ins(F.v, -1), v1 = hi[F.v]! - ins(F.v, 1)
    const at = (u: number, v: number) => { const p = [0, 0, 0]; p[a] = plane; p[F.u] = u; p[F.v] = v; return p }
    // Corners touching a chamfer carry half its curvature; an open side carries none.
    const kU0 = ins(F.u, -1) > 0 ? 0.5 : 0, kU1 = ins(F.u, 1) > 0 ? 0.5 : 0
    const kV0 = ins(F.v, -1) > 0 ? 0.5 : 0, kV1 = ins(F.v, 1) > 0 ? 0.5 : 0
    const bw = Math.min(band, (u1 - u0) / 3, (v1 - v0) / 3)
    if (bw > r * 0.5 && r > 0) {
      const iu0 = u0 + (kU0 ? bw : 0), iu1 = u1 - (kU1 ? bw : 0), iv0 = v0 + (kV0 ? bw : 0), iv1 = v1 - (kV1 ? bw : 0)
      const o = (u: number, v: number) => V(at(u, v), F.n, Math.max(u === u0 ? kU0 : u === u1 ? kU1 : 0, v === v0 ? kV0 : v === v1 ? kV1 : 0), f)
      const i = (u: number, v: number) => V(at(u, v), F.n, 0, f)
      quad(i(iu0, iv0), i(iu1, iv0), i(iu1, iv1), i(iu0, iv1))
      quad(o(u0, v0), o(u1, v0), i(iu1, iv0), i(iu0, iv0))
      quad(o(u1, v0), o(u1, v1), i(iu1, iv1), i(iu1, iv0))
      quad(o(u1, v1), o(u0, v1), i(iu0, iv1), i(iu1, iv1))
      quad(o(u0, v1), o(u0, v0), i(iu0, iv0), i(iu0, iv1))
    } else {
      const k = r > 0 ? 0.5 : 0
      quad(V(at(u0, v0), F.n, k, f), V(at(u1, v0), F.n, k, f), V(at(u1, v1), F.n, k, f), V(at(u0, v1), F.n, k, f))
    }
  }
  if (r <= 0) return out

  // Edge strips: for each pair of drawn faces on perpendicular axes, a strip along the third axis.
  for (let a = 0; a < 3; a++) for (let b = a + 1; b < 3; b++) for (const sa of [-1, 1]) for (const sb of [-1, 1]) {
    const fa = faceOf(a, sa), fb = faceOf(b, sb)
    if (!has(fa) || !has(fb)) continue
    const c = 3 - a - b
    const ca = sa > 0 ? hi[a]! : lo[a]!, cb = sb > 0 ? hi[b]! : lo[b]!
    const c0 = lo[c]! + (has(faceOf(c, -1)) ? r : 0), c1 = hi[c]! - (has(faceOf(c, 1)) ? r : 0)
    const na = [0, 0, 0], nb = [0, 0, 0], ne = [0, 0, 0]
    na[a] = sa; nb[b] = sb; ne[a] = sa; ne[b] = sb
    const nE = norm(ne)
    const blend = (n: number[]) => [(n[0]! + nE[0]) / 2, (n[1]! + nE[1]) / 2, (n[2]! + nE[2]) / 2]
    // On face a's side the point sits at a = plane, b pulled in by r; on face b's side the reverse.
    const pa = (cv: number) => { const p = [0, 0, 0]; p[a] = ca; p[b] = cb - sb * r; p[c] = cv; return p }
    const pb = (cv: number) => { const p = [0, 0, 0]; p[a] = ca - sa * r; p[b] = cb; p[c] = cv; return p }
    const face = a === 1 ? fa : b === 1 ? fb : fa
    quad(V(pa(c0), blend(na), 1, face), V(pa(c1), blend(na), 1, face), V(pb(c1), blend(nb), 1, face), V(pb(c0), blend(nb), 1, face))
  }
  // Corner triangles where three drawn faces meet.
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    if (!has(faceOf(0, sx)) || !has(faceOf(1, sy)) || !has(faceOf(2, sz))) continue
    const cx = sx > 0 ? x1 : x0, cy = sy > 0 ? y1 : y0, cz = sz > 0 ? z1 : z0
    const nC = norm([sx, sy, sz])
    const face = faceOf(1, sy)
    tri(V([cx, cy - sy * r, cz - sz * r], [nC[0] + sx, nC[1], nC[2]], 1, face), V([cx - sx * r, cy, cz - sz * r], [nC[0], nC[1] + sy, nC[2]], 1, face), V([cx - sx * r, cy - sy * r, cz], [nC[0], nC[1], nC[2] + sz], 1, face))
  }
  return out
}

/**
 * Triangles of a vertical cylinder around (cx, cz), radius `rad` from y0 to y1, smooth-shaded, with a one-segment
 * chamfer `r` round the top rim (and the bottom rim when `bottom`), and a wear band on the side and caps.
 */
export function chamferCylinder(cx: number, cz: number, rad: number, y0: number, y1: number, sides: number, r: number, band: number, opts: { top?: boolean; bottom?: boolean; phase?: number } = {}): FinishVertex[] {
  const top = opts.top ?? true, bottom = opts.bottom ?? false, phase = opts.phase ?? 0
  r = Math.max(0, Math.min(r, rad * 0.45, (y1 - y0) * 0.3))
  const out: FinishVertex[] = []
  const ring = (i: number) => { const a = (i / sides) * Math.PI * 2 + phase; return [Math.cos(a), Math.sin(a)] as const }
  const V = (p: number[], n: number[], k: number, face: number): FinishVertex => ({ p: [p[0]!, p[1]!, p[2]!], n: norm(n), k, face })
  // Profile from the bottom centre round to the top centre: (radius, y, normal xz scale, normal y, curvature, face).
  type P = [number, number, number, number, number, number]
  const prof: P[] = []
  const bw = Math.min(band, (y1 - y0) / 4, rad / 3)
  const yb = y0 + (bottom ? r : 0), yt = y1 - (top ? r : 0)
  const s = Math.SQRT1_2
  if (bottom) {
    prof.push([0, y0, 0, -1, 0, 5])
    if (bw > 0) prof.push([rad - r - bw, y0, 0, -1, 0, 5])
    prof.push([rad - r, y0, 0, -1, 0.5, 5])
    if (r > 0) { prof.push([rad - r, y0, s * 0.5, -0.5 - s * 0.5, 1, 1]); prof.push([rad, yb, 0.5 + s * 0.5, -s * 0.5, 1, 1]) }
  }
  prof.push([rad, yb, 1, 0, bottom && r > 0 ? 0.5 : 0, 1])
  if (bottom && bw > 0) prof.push([rad, yb + bw, 1, 0, 0, 1])
  if (top && bw > 0 && r > 0) prof.push([rad, yt - bw, 1, 0, 0, 1])
  prof.push([rad, yt, 1, 0, top && r > 0 ? 0.5 : 0, 1])
  if (top) {
    if (r > 0) { prof.push([rad, yt, 0.5 + s * 0.5, s * 0.5, 1, 0]); prof.push([rad - r, y1, s * 0.5, 0.5 + s * 0.5, 1, 0]) }
    prof.push([rad - r, y1, 0, 1, r > 0 ? 0.5 : 0, 0])
    if (bw > 0 && r > 0) prof.push([rad - r - bw, y1, 0, 1, 0, 0])
    prof.push([0, y1, 0, 1, 0, 0])
  }
  for (let i = 0; i < sides; i++) {
    const [ca, sa] = ring(i), [cb, sb] = ring(i + 1)
    for (let j = 0; j + 1 < prof.length; j++) {
      const p = prof[j]!, q = prof[j + 1]!
      // Skip the zero-length steps between duplicated profile points (where the normal changes).
      if (Math.abs(p[0] - q[0]) < 1e-9 && Math.abs(p[1] - q[1]) < 1e-9) continue
      const v = (pp: P, c: number, sn: number) => V([cx + c * pp[0], pp[1], cz + sn * pp[0]], [c * pp[2], pp[3], sn * pp[2]], pp[4], pp[5])
      const a = v(p, ca, sa), b = v(p, cb, sb), c = v(q, cb, sb), d = v(q, ca, sa)
      // Outward winding: the profile climbs, the ring turns counter-clockwise seen from above (−z to +x).
      if (p[0] < 1e-9) out.push(a, c, d)
      else if (q[0] < 1e-9) out.push(a, b, c)
      else out.push(a, c, b, a, d, c)
    }
  }
  // Fix winding against normals (the profile may run either way at the caps).
  for (let t = 0; t < out.length; t += 3) {
    const a = out[t]!, b = out[t + 1]!, c = out[t + 2]!
    const e1 = [b.p[0] - a.p[0], b.p[1] - a.p[1], b.p[2] - a.p[2]], e2 = [c.p[0] - a.p[0], c.p[1] - a.p[1], c.p[2] - a.p[2]]
    const cr = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!]
    const nn = [a.n[0] + b.n[0] + c.n[0], a.n[1] + b.n[1] + c.n[1], a.n[2] + b.n[2] + c.n[2]]
    if (cr[0]! * nn[0]! + cr[1]! * nn[1]! + cr[2]! * nn[2]! < 0) { out[t + 1] = c; out[t + 2] = b }
  }
  return out
}

/**
 * Splits triangles longer than `max` (m) by halving their longest edge until none is: baked vertex AO and exposure
 * need vertices across a big face, or its four corners' values are interpolated over all of it. Every edge longer
 * than `max` ends up halved until it isn't, whichever triangle it belongs to, so shared edges split alike and no
 * T-junctions open.
 */
export function splitLong(tris: readonly FinishVertex[], max: number): FinishVertex[] {
  const out: FinishVertex[] = []
  const mid = (a: FinishVertex, b: FinishVertex): FinishVertex => ({
    p: [(a.p[0] + b.p[0]) / 2, (a.p[1] + b.p[1]) / 2, (a.p[2] + b.p[2]) / 2],
    n: norm([a.n[0] + b.n[0], a.n[1] + b.n[1], a.n[2] + b.n[2]]),
    k: (a.k + b.k) / 2,
    face: a.face,
  })
  const d2 = (a: FinishVertex, b: FinishVertex) => (a.p[0] - b.p[0]) ** 2 + (a.p[1] - b.p[1]) ** 2 + (a.p[2] - b.p[2]) ** 2
  const split = (a: FinishVertex, b: FinishVertex, c: FinishVertex) => {
    const ab = d2(a, b), bc = d2(b, c), ca = d2(c, a), m2 = max * max
    if (ab <= m2 && bc <= m2 && ca <= m2) { out.push(a, b, c); return }
    if (ab >= bc && ab >= ca) { const m = mid(a, b); split(a, m, c); split(m, b, c) }
    else if (bc >= ca) { const m = mid(b, c); split(b, m, a); split(m, c, a) }
    else { const m = mid(c, a); split(c, m, b); split(m, a, b) }
  }
  for (let t = 0; t + 2 < tris.length; t += 3) split(tris[t]!, tris[t + 1]!, tris[t + 2]!)
  return out
}
