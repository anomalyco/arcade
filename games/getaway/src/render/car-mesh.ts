import { VEHICLES, type Vehicle } from "../../shared/config"
import { type AtlasRegion, regionAspect } from "./atlas"
import { MAT, type Mat, Mesh, type Rgb } from "./mesh"
import { HEADLIGHT, type LightStyle } from "./car-lights"

/**
 * Vehicle models: faceted low-poly bodies lofted from cross-sections (chamfered hull with real wheel arches, a
 * tapered greenhouse), with separate bumpers, lamps, mirrors, grilles and atlas lettering. Local space: +z forward,
 * +y up, +x is the car's left, origin on the ground under the body center.
 */

type V3 = [number, number, number]
type P2 = [number, number]

const TIRE: Rgb = [0.045, 0.045, 0.05]
const RIM: Rgb = [0.34, 0.35, 0.38]
const HUB: Rgb = [0.16, 0.16, 0.18]
const GLASS: Rgb = [0.05, 0.06, 0.085]
const HEAD: Rgb = HEADLIGHT
const TAIL: Rgb = [1.0, 0.07, 0.05]
const AMBER: Rgb = [1.0, 0.55, 0.12]
const CHROME: Rgb = [0.62, 0.64, 0.68]
const TRIM: Rgb = [0.07, 0.07, 0.08]
const WELL: Rgb = [0.02, 0.02, 0.025]
const PLATE: Rgb = [0.85, 0.86, 0.82]
const INK: Rgb = [0.03, 0.03, 0.035]
const WHITE: Rgb = [0.93, 0.94, 0.96]

/** Siren lamps use their own material; red is encoded by r > b. */
const SIREN_RED: Rgb = [1, 0.06, 0.05]
const SIREN_BLUE: Rgb = [0.12, 0.28, 1]

/** Car paint: the decal material over the atlas's white texel, i.e. lit diffuse plus a soft specular sheen. */
const PAINT: Mat = MAT.decal

export const MAT_SIREN = MAT.siren

/** Default roof unit numbers, per police vehicle. */
export const UNIT_NUMBERS: Record<string, number[]> = { cruiser: [208, 617, 324, 54], interceptor: [17, 22, 90, 8], swat: [3] }

// ---------------------------------------------------------------------------------------------------------------
// Geometry helpers

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const lerp = (a: number, b: number, t: number) => a + (b - a) * t

function centroid(pts: V3[]): V3 {
  const c: V3 = [0, 0, 0]
  for (const p of pts) {
    c[0] += p[0]
    c[1] += p[1]
    c[2] += p[2]
  }
  return [c[0] / pts.length, c[1] / pts.length, c[2] / pts.length]
}

/** Flat-shaded triangle whose winding is flipped as needed so its normal points away from `inside`. */
function tri(m: Mesh, a: V3, b: V3, c: V3, col: Rgb, mat: Mat, inside: V3) {
  const n = cross(sub(b, a), sub(c, a))
  if (Math.hypot(n[0], n[1], n[2]) < 1e-9) return
  if (dot(n, sub(centroid([a, b, c]), inside)) < 0) m.facet(a, c, b, col, mat)
  else m.facet(a, b, c, col, mat)
}

/** Convex polygon, fanned from its centroid. */
function poly(m: Mesh, pts: V3[], col: Rgb, mat: Mat, inside: V3) {
  if (pts.length === 3) return tri(m, pts[0]!, pts[1]!, pts[2]!, col, mat, inside)
  if (pts.length === 4) {
    tri(m, pts[0]!, pts[1]!, pts[2]!, col, mat, inside)
    tri(m, pts[0]!, pts[2]!, pts[3]!, col, mat, inside)
    return
  }
  const c = centroid(pts)
  for (let i = 0; i < pts.length; i++) tri(m, c, pts[i]!, pts[(i + 1) % pts.length]!, col, mat, inside)
}

type Paint = { col: Rgb; mat?: Mat }

/**
 * Lofts corresponding rings. `color(seg, edge)` paints the quad between ring seg and seg + 1 along ring edge
 * `edge`. Open rings (closed = false) have no edge from the last point back to the first.
 */
function loft(m: Mesh, rings: V3[][], closed: boolean, color: (seg: number, edge: number) => Paint | null, caps: { front?: Paint; back?: Paint } = {}) {
  const k = rings[0]!.length
  const edges = closed ? k : k - 1
  for (let s = 0; s < rings.length - 1; s++) {
    const r0 = rings[s]!
    const r1 = rings[s + 1]!
    const inside = centroid([...r0, ...r1])
    for (let e = 0; e < edges; e++) {
      const p = color(s, e)
      if (!p) continue
      const a = r0[e]!
      const b = r0[(e + 1) % k]!
      const c = r1[(e + 1) % k]!
      const d = r1[e]!
      tri(m, a, b, c, p.col, p.mat ?? PAINT, inside)
      tri(m, a, c, d, p.col, p.mat ?? PAINT, inside)
    }
  }
  const cap = (ring: V3[], next: V3[], p: Paint) => poly(m, ring, p.col, p.mat ?? PAINT, centroid(next))
  if (caps.front) cap(rings[0]!, rings[1]!, caps.front)
  if (caps.back) cap(rings[rings.length - 1]!, rings[rings.length - 2]!, caps.back)
}

/** Prism between two corresponding convex rings, capped at both ends. */
function prism(m: Mesh, r0: V3[], r1: V3[], col: Rgb, mat: Mat = PAINT, capCol: Rgb = col, capMat: Mat = mat) {
  const inside = centroid([...r0, ...r1])
  for (let i = 0; i < r0.length; i++) {
    const j = (i + 1) % r0.length
    poly(m, [r0[i]!, r0[j]!, r1[j]!, r1[i]!], col, mat, inside)
  }
  poly(m, r0, capCol, capMat, inside)
  poly(m, r1, capCol, capMat, inside)
}

/** Prism from a convex (z, y) profile spanning x0..x1. */
function extrudeX(m: Mesh, prof: P2[], x0: number, x1: number, col: Rgb, mat: Mat = PAINT, capCol: Rgb = col) {
  prism(m, prof.map(([z, y]) => [x0, y, z]), prof.map(([z, y]) => [x1, y, z]), col, mat, capCol)
}

/** Prism from a convex (x, y) profile spanning z0..z1. */
function extrudeZ(m: Mesh, prof: P2[], z0: number, z1: number, col: Rgb, mat: Mat = PAINT, capCol: Rgb = col, capMat: Mat = mat) {
  prism(m, prof.map(([x, y]) => [x, y, z0]), prof.map(([x, y]) => [x, y, z1]), col, mat, capCol, capMat)
}

/** Box with chamfered vertical edges seen from above (an octagonal footprint) and a chamfered top. */
function block(m: Mesh, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, col: Rgb, mat: Mat = PAINT, bevel = 0.04) {
  const b = Math.min(bevel, (x1 - x0) / 3, (z1 - z0) / 3, (y1 - y0) / 2)
  const ring = (y: number, i: number): V3[] => [
    [x0 + b + i, y, z0 + i],
    [x1 - b - i, y, z0 + i],
    [x1 - i, y, z0 + b + i],
    [x1 - i, y, z1 - b - i],
    [x1 - b - i, y, z1 - i],
    [x0 + b + i, y, z1 - i],
    [x0 + i, y, z1 - b - i],
    [x0 + i, y, z0 + b + i],
  ]
  const rings = [ring(y0, 0), ring(y1 - b, 0), ring(y1, b)]
  loft(m, rings, true, () => ({ col, mat }), { back: { col, mat } })
}

/** Octagonal wheel on the axis x, outer face toward `side`. */
function wheel(m: Mesh, side: number, xOuter: number, z: number, r: number, w: number, rim: Rgb = RIM) {
  const oct = (rr: number, x: number): V3[] =>
    Array.from({ length: 8 }, (_, i) => {
      const a = ((i + 0.5) / 8) * Math.PI * 2
      return [x, r + Math.sin(a) * rr, z + Math.cos(a) * rr]
    })
  const xo = side * xOuter
  const xi = side * (xOuter - w)
  prism(m, oct(r * 0.93, xo), oct(r * 0.93, xi), TIRE, MAT.lit)
  // Sidewall chamfer, rim and hub.
  prism(m, oct(r * 0.93, xo), oct(r * 0.78, xo + side * 0.025), TIRE, MAT.lit)
  prism(m, oct(r * 0.62, xo + side * 0.02), oct(r * 0.56, xo + side * 0.035), rim, PAINT)
  prism(m, oct(r * 0.2, xo + side * 0.035), oct(r * 0.16, xo + side * 0.05), HUB, MAT.lit)
}

// ---------------------------------------------------------------------------------------------------------------
// Decals

/** Lettering on a body side at |x|, reading front to back on both sides. */
function sideDecal(m: Mesh, side: number, x: number, z0: number, z1: number, y0: number, y1: number, region: AtlasRegion, col: Rgb) {
  const zf = Math.max(z0, z1)
  const zb = Math.min(z0, z1)
  if (side > 0) m.decal([x, y0, zf], [x, y0, zb], [x, y1, zb], [x, y1, zf], [1, 0, 0], region, col)
  else m.decal([-x, y0, zb], [-x, y0, zf], [-x, y1, zf], [-x, y1, zb], [-1, 0, 0], region, col)
}

/** Lettering fitted into a box on a body side, keeping the region's aspect. */
function sideText(m: Mesh, x: number, zc: number, yc: number, maxLen: number, maxH: number, region: AtlasRegion, col: Rgb) {
  const asp = regionAspect(region)
  const len = Math.min(maxLen, maxH * asp)
  const h = len / asp
  for (const s of [-1, 1]) sideDecal(m, s, x, zc - len / 2, zc + len / 2, yc - h / 2, yc + h / 2, region, col)
}

/** Lettering on a flat, upward-facing surface; its top points toward +z (readable from behind). */
function topDecal(m: Mesh, y: number, xc: number, zc: number, w: number, h: number, region: AtlasRegion, col: Rgb) {
  const x0 = xc + w / 2
  const x1 = xc - w / 2
  const z0 = zc - h / 2
  const z1 = zc + h / 2
  m.decal([x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1], [0, 1, 0], region, col)
}

/** Lettering on a flat surface facing +z (the front of a vehicle). */
function frontDecal(m: Mesh, z: number, xc: number, yc: number, w: number, h: number, region: AtlasRegion, col: Rgb) {
  m.decal([xc + w / 2, yc - h / 2, z], [xc - w / 2, yc - h / 2, z], [xc - w / 2, yc + h / 2, z], [xc + w / 2, yc + h / 2, z], [0, 0, 1], region, col)
}

/** Big roof unit number. */
function roofNumber(m: Mesh, unit: number, y: number, zc: number, maxW: number, maxH: number, col: Rgb) {
  const digits = String(unit)
  const asp = regionAspect("num0") * 0.92
  let h = maxH
  let dw = h * asp
  if (dw * digits.length > maxW) {
    dw = maxW / digits.length
    h = dw / asp
  }
  const total = dw * digits.length
  ;[...digits].forEach((d, i) => topDecal(m, y, total / 2 - (i + 0.5) * dw, zc, dw / 0.92, h, `num${d}` as AtlasRegion, col))
}

// ---------------------------------------------------------------------------------------------------------------
// Car bodies

/** Hull cross-section key: half width, bottom, belt crease and top heights at z. */
type HullKey = { z: number; w: number; b: number; s: number; t: number; crown?: number }

/** Greenhouse cross-section: base half width and height, roof half width and height. Collapsed when yt <= yb. */
type CabKey = { z: number; wb: number; yb: number; wt: number; yt: number }

type Body = {
  hull: HullKey[]
  cab: CabKey[]
  axles: number[]
  wheelR: number
  wheelW: number
  archR: number
  /** Extra hull stations so paint boundaries fall on section edges. */
  cuts?: number[]
}

/** Hull bands: 0 rocker, 1 side, 2 shoulder, 3 top edge, 4 top center. */
type HullPaint = (band: number, z: number) => Paint
/** Greenhouse bands: 0 side window, 1 pillar / drip rail, 2 roof or windshield. `seg` counts front to back. */
type CabPaint = (band: number, seg: number, segs: number, z: number) => Paint

function interpKey(keys: HullKey[], z: number): HullKey {
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i]!
    const b = keys[i + 1]!
    if (z <= a.z + 1e-6 && z >= b.z - 1e-6) {
      const t = a.z === b.z ? 0 : (a.z - z) / (a.z - b.z)
      return { z, w: lerp(a.w, b.w, t), b: lerp(a.b, b.b, t), s: lerp(a.s, b.s, t), t: lerp(a.t, b.t, t), crown: lerp(a.crown ?? 0.015, b.crown ?? 0.015, t) }
    }
  }
  return { ...keys[z > keys[0]!.z ? 0 : keys.length - 1]!, z }
}

function hullRing(k: HullKey): V3[] {
  const rk = Math.min(0.13, (k.s - k.b) * 0.4)
  const sh = Math.min(0.12, k.w * 0.13)
  const half: P2[] = [
    [k.w - 0.06, k.b],
    [k.w, k.b + rk],
    [k.w, k.s],
    [k.w - sh, k.t - 0.025],
    [k.w * 0.42, k.t],
    [0, k.t + (k.crown ?? 0.015)],
  ]
  const right = half.map(([x, y]): V3 => [x, y, k.z])
  const left = half
    .slice(0, -1)
    .reverse()
    .map(([x, y]): V3 => [-x, y, k.z])
  return [...right, ...left]
}

function hullStations(body: Body): HullKey[] {
  const zs = new Set<number>(body.hull.map((k) => k.z))
  for (const c of body.cuts ?? []) zs.add(c)
  const R = body.archR
  for (const a of body.axles) for (const f of [-1, -0.8, -0.5, -0.2, 0.2, 0.5, 0.8, 1]) zs.add(a + f * R)
  const front = body.hull[0]!.z
  const back = body.hull[body.hull.length - 1]!.z
  return [...zs]
    .filter((z) => z <= front && z >= back)
    .sort((a, b) => b - a)
    .map((z) => {
      const k = interpKey(body.hull, z)
      for (const a of body.axles) {
        const dz = Math.abs(z - a)
        if (dz <= R + 1e-6) k.b = Math.max(k.b, body.wheelR + Math.sqrt(Math.max(0, R * R - dz * dz)))
      }
      return k
    })
}

/** Lofted hull with wheel arches, a dark wheel-well liner, and wheels. */
function hull(m: Mesh, body: Body, paint: HullPaint, nose: Paint, tail: Paint) {
  const st = hullStations(body)
  const rings = st.map(hullRing)
  loft(m, rings, false, (seg, e) => paint(e < 5 ? e : 9 - e, (st[seg]!.z + st[seg + 1]!.z) / 2), { front: nose, back: tail })
  // Wheel-well liner: whatever the arches reveal is dark.
  const minS = Math.min(...st.map((k) => k.s))
  const wmin = Math.min(...st.map((k) => k.w))
  for (const a of body.axles) {
    const x = wmin - 0.07
    m.box(-x, x, 0.12, minS - 0.04, a - body.archR, a + body.archR, WELL)
  }
  const hw = Math.max(...st.map((k) => k.w))
  for (const a of body.axles) for (const s of [-1, 1]) wheel(m, s, hw - 0.03, a, body.wheelR, body.wheelW)
}

function cabRing(k: CabKey): V3[] {
  const half: P2[] =
    k.yt <= k.yb + 1e-6
      ? [
          [k.wb, k.yb],
          [k.wb - 0.06, k.yb],
          [k.wb - 0.11, k.yb],
          [0, k.yb],
        ]
      : [
          [k.wb, k.yb],
          [k.wt + 0.045, k.yt - 0.055],
          [k.wt, k.yt],
          [0, k.yt],
        ]
  const right = half.map(([x, y]): V3 => [x, y, k.z])
  const left = half
    .slice(0, -1)
    .reverse()
    .map(([x, y]): V3 => [-x, y, k.z])
  return [...right, ...left]
}

function cab(m: Mesh, keys: CabKey[], paint: CabPaint, back?: Paint) {
  const rings = keys.map(cabRing)
  const segs = keys.length - 1
  loft(m, rings, false, (seg, e) => paint(e < 3 ? e : 5 - e, seg, segs, (keys[seg]!.z + keys[seg + 1]!.z) / 2), back ? { back } : {})
}

/** Hull top height at z (centerline), for seating parts on the body. */
function topAt(body: Body, z: number) {
  return interpKey(body.hull, z).t
}

function frontFascia(m: Mesh, body: Body, opts: { bumper: Rgb; grille: Rgb; lampW?: number; lampY?: number; lampH?: number; pushBar?: boolean; grilleH?: number }, lights: LightStyle) {
  const k = body.hull[0]!
  const z = k.z
  const w = k.w
  const ly = opts.lampY ?? k.s - 0.12
  const lh = opts.lampH ?? 0.1
  const lw = opts.lampW ?? 0.36
  // Headlights wrap the corner: a front lens plus a sliver on the side chamfer.
  for (const s of [-1, 1]) {
    const xo = s * (w - 0.04)
    const xi = s * (w - 0.04 - lw)
    if (lights) {
      const x0 = Math.min(xi, xo), x1 = Math.max(xi, xo)
      block(m, x0 - 0.035, x1 + 0.035, ly - lh / 2 - 0.025, ly + lh / 2 + 0.035, z - 0.045, z + 0.032, TRIM, PAINT, 0.015)
      // A bevelled lens has a top edge, so it remains shaped at the gameplay angle.
      block(m, x0 + 0.015, x1 - 0.015, ly - lh / 2 + 0.008, ly + lh / 2 + 0.008, z + 0.032, z + 0.048, lights === 2 ? [0.82, 0.94, 1] : HEAD, MAT.emissive, 0.008)
    }
    poly(m, [[xi, ly - lh / 2, z + 0.012], [xo, ly - lh / 2, z + 0.012], [xo, ly + lh / 2, z + 0.012], [xi + s * 0.04, ly + lh / 2, z + 0.012]], HEAD, MAT.emissive, [0, ly, 0])
    poly(m, [[xi - s * 0.04, ly - lh / 2 - 0.03, z + 0.008], [xi, ly - lh / 2 - 0.03, z + 0.008], [xi, ly - lh / 2 - 0.005, z + 0.008], [xi - s * 0.04, ly - lh / 2 - 0.005, z + 0.008]], AMBER, MAT.emissive, [0, ly, 0])
  }
  // Grille between the lamps.
  const gx = w - 0.04 - lw - 0.05
  const gh = opts.grilleH ?? 0.16
  poly(m, [[-gx, ly - gh, z + 0.01], [gx, ly - gh, z + 0.01], [gx * 0.92, ly + lh / 2, z + 0.01], [-gx * 0.92, ly + lh / 2, z + 0.01]], opts.grille, MAT.lit, [0, ly, 0])
  for (const yy of [ly - gh * 0.6, ly - gh * 0.2]) m.box(-gx * 0.9, gx * 0.9, yy - 0.012, yy + 0.012, z + 0.01, z + 0.02, opts.bumper === CHROME ? CHROME : [0.18, 0.18, 0.2])
  // Bumper: chamfered bar across the nose.
  const bw = w + 0.03
  const by = k.b - 0.06
  extrudeX(m, [[z - 0.2, by], [z + 0.04, by], [z + 0.08, by + 0.06], [z + 0.08, by + 0.16], [z + 0.03, by + 0.22], [z - 0.2, by + 0.22]], -bw, bw, opts.bumper)
  if (opts.pushBar) {
    for (const s of [-1, 1]) m.box(s * 0.42 - 0.04, s * 0.42 + 0.04, by + 0.04, ly + 0.08, z + 0.08, z + 0.17, TRIM, MAT.lit)
    extrudeX(m, [[z + 0.1, ly - 0.02], [z + 0.2, ly - 0.02], [z + 0.2, ly + 0.05], [z + 0.1, ly + 0.05]], -0.5, 0.5, TRIM, MAT.lit)
    extrudeX(m, [[z + 0.1, by + 0.12], [z + 0.22, by + 0.12], [z + 0.22, by + 0.2], [z + 0.1, by + 0.2]], -0.62, 0.62, TRIM, MAT.lit)
  }
}

function rearFascia(m: Mesh, body: Body, opts: { bumper: Rgb; lampW?: number; lampY?: number; lampH?: number; bar?: boolean }, lights: LightStyle) {
  const k = body.hull[body.hull.length - 1]!
  const z = k.z
  const w = k.w
  const ly = opts.lampY ?? k.s - 0.08
  const lh = opts.lampH ?? 0.11
  const lw = opts.lampW ?? 0.36
  for (const s of [-1, 1]) {
    const xo = s * (w - 0.03)
    const xi = s * (w - 0.03 - lw)
    if (lights) {
      const x0 = Math.min(xi, xo), x1 = Math.max(xi, xo)
      block(m, x0 - 0.025, x1 + 0.025, ly - lh / 2 - 0.02, ly + lh / 2 + 0.03, z - 0.04, z + 0.035, TRIM, PAINT, 0.012)
      block(m, x0 + 0.01, x1 - 0.01, ly - lh / 2 + 0.005, ly + lh / 2 + 0.01, z - 0.055, z - 0.04, TAIL, MAT.emissive, 0.006)
    }
    poly(m, [[xi, ly - lh / 2, z - 0.012], [xo, ly - lh / 2, z - 0.012], [xo, ly + lh / 2, z - 0.012], [xi, ly + lh / 2, z - 0.012]], TAIL, MAT.emissive, [0, ly, 0])
  }
  // A light bar between the tail lamps.
  if (lights === 2) {
    block(m, -w + 0.03, w - 0.03, ly - 0.065, ly + 0.065, z - 0.045, z + 0.015, TRIM, PAINT, 0.01)
    block(m, -w + 0.055, w - 0.055, ly - 0.023, ly + 0.028, z - 0.065, z - 0.045, TAIL, MAT.emissive, 0.006)
  }
  if (opts.bar) poly(m, [[-(w - 0.03 - lw), ly - 0.02, z - 0.01], [w - 0.03 - lw, ly - 0.02, z - 0.01], [w - 0.03 - lw, ly + 0.02, z - 0.01], [-(w - 0.03 - lw), ly + 0.02, z - 0.01]], [0.6, 0.04, 0.03], MAT.emissive, [0, ly, 0])
  const bw = w + 0.03
  const by = k.b - 0.06
  extrudeX(m, [[z + 0.2, by], [z - 0.03, by], [z - 0.07, by + 0.06], [z - 0.07, by + 0.16], [z - 0.02, by + 0.22], [z + 0.2, by + 0.22]], -bw, bw, opts.bumper)
  // Plate.
  m.decal([0.17, by + 0.07, z - 0.075], [-0.17, by + 0.07, z - 0.075], [-0.17, by + 0.17, z - 0.075], [0.17, by + 0.17, z - 0.075], [0, 0, -1], "white", PLATE, MAT.lit)
}

function mirrors(m: Mesh, z: number, x: number, y: number, col: Rgb) {
  for (const s of [-1, 1]) {
    const x0 = s * x
    const x1 = s * (x + 0.17)
    extrudeZ(m, [[Math.min(x0, x1), y], [Math.max(x0, x1), y], [Math.max(x0, x1), y + 0.1], [Math.min(x0, x1), y + 0.1]], z - 0.08, z + 0.02, col)
  }
}

/** Roof lightbar: a dark base with red (local -x) and blue (+x) lamp housings. */
function lightbar(m: Mesh, y: number, zc: number, hw: number, d = 0.3, h = 0.15) {
  extrudeX(m, [[zc - d / 2, y], [zc + d / 2, y], [zc + d / 2 - 0.02, y + 0.05], [zc - d / 2 + 0.02, y + 0.05]], -hw, hw, TRIM, MAT.lit)
  for (const s of [-1, 1]) {
    const prof: P2[] = [[zc - d / 2 + 0.015, y + 0.04], [zc + d / 2 - 0.015, y + 0.04], [zc + d / 2 - 0.05, y + 0.04 + h], [zc - d / 2 + 0.05, y + 0.04 + h]]
    const x0 = s < 0 ? -hw + 0.015 : 0.09
    const x1 = s < 0 ? -0.09 : hw - 0.015
    extrudeX(m, prof, x0, x1, s < 0 ? SIREN_RED : SIREN_BLUE, MAT.siren)
  }
  extrudeX(m, [[zc - d / 2 + 0.04, y + 0.04], [zc + d / 2 - 0.04, y + 0.04], [zc + d / 2 - 0.06, y + 0.04 + h * 0.8], [zc - d / 2 + 0.06, y + 0.04 + h * 0.8]], -0.09, 0.09, [0.85, 0.88, 0.95], MAT.emissive)
}

/** Thin dark panel seam on both body sides. */
function seam(m: Mesh, x: number, z: number, y0: number, y1: number) {
  for (const s of [-1, 1]) {
    const xx = s * (x + 0.004)
    poly(m, [[xx, y0, z - 0.012], [xx, y0, z + 0.012], [xx, y1, z + 0.012], [xx, y1, z - 0.012]], INK, MAT.lit, [0, (y0 + y1) / 2, z])
  }
}

function handles(m: Mesh, x: number, zs: number[], y: number, col: Rgb) {
  for (const z of zs)
    for (const s of [-1, 1]) {
      const xx = s * (x + 0.012)
      poly(m, [[xx, y - 0.02, z - 0.1], [xx, y - 0.02, z + 0.04], [xx, y + 0.02, z + 0.04], [xx, y + 0.02, z - 0.1]], col, MAT.lit, [0, y, z])
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Vehicles

/** Windows: the glass material for the steep side glass, a darker lit tint for the shallow wind- and rear screens. */
const glass: Paint = { col: GLASS, mat: MAT.glass }
const screen: Paint = { col: [0.035, 0.045, 0.075], mat: PAINT }

/** Sedan greenhouse paint: glass windows with body-colored pillars, roof, and an optional B-pillar segment. */
function sedanCab(pillar: Rgb, roof: Rgb, bSeg = -1): CabPaint {
  return (band, seg, segs) => {
    if (band === 0) return seg === bSeg ? { col: pillar } : glass
    if (band === 1) return { col: pillar }
    return seg === 0 || seg === segs - 1 ? screen : { col: roof }
  }
}

/** Police two-tone: white doors and roof, black nose, fenders and tail (LAPD style). */
function policeHull(white: Rgb, black: Rgb, doorF: number, doorR: number): HullPaint {
  return (band, z) => ({ col: z < doorF && z > doorR && band < 4 ? white : black })
}

function cruiser(m: Mesh, v: Vehicle, unit: number, lights: LightStyle) {
  const zf = v.length / 2
  const zr = -zf
  const hw = v.width / 2
  const white = v.paint
  const black = v.accent
  const doorF = 0.98
  const doorR = -1.2
  const body: Body = {
    hull: [
      { z: zf, w: hw - 0.15, b: 0.36, s: 0.68, t: 0.79 },
      { z: zf - 0.14, w: hw - 0.05, b: 0.3, s: 0.77, t: 0.87 },
      { z: zf - 0.55, w: hw, b: 0.28, s: 0.82, t: 0.93 },
      { z: 0.98, w: hw, b: 0.28, s: 0.86, t: 0.98 },
      { z: -1.65, w: hw, b: 0.28, s: 0.88, t: 1.02 },
      { z: zr + 0.38, w: hw - 0.01, b: 0.29, s: 0.86, t: 1.0 },
      { z: zr + 0.1, w: hw - 0.05, b: 0.32, s: 0.8, t: 0.94 },
      { z: zr, w: hw - 0.14, b: 0.38, s: 0.73, t: 0.86 },
    ],
    cab: [
      { z: 1.0, wb: hw - 0.13, yb: 0.95, wt: 0, yt: 0 },
      { z: 0.24, wb: hw - 0.11, yb: 0.95, wt: hw - 0.4, yt: 1.5 },
      { z: -0.36, wb: hw - 0.11, yb: 0.96, wt: hw - 0.4, yt: 1.5 },
      { z: -0.47, wb: hw - 0.11, yb: 0.96, wt: hw - 0.4, yt: 1.5 },
      { z: -1.08, wb: hw - 0.11, yb: 0.97, wt: hw - 0.41, yt: 1.48 },
      { z: -1.72, wb: hw - 0.13, yb: 0.98, wt: 0, yt: 0 },
    ],
    axles: [1.5, -1.5],
    wheelR: 0.36,
    wheelW: 0.26,
    archR: 0.46,
    cuts: [doorF, doorR, -0.42],
  }
  hull(m, body, policeHull(white, black, doorF, doorR), { col: black }, { col: black })
  cab(m, body.cab, sedanCab(white, white, 2))
  frontFascia(m, body, { bumper: TRIM, grille: INK, pushBar: true }, lights)
  rearFascia(m, body, { bumper: TRIM }, lights)
  mirrors(m, 0.85, hw - 0.12, 0.98, black)
  seam(m, hw, doorF - 0.02, 0.36, 0.95)
  handles(m, hw, [0.55, -0.62], 0.84, TRIM)
  sideText(m, hw + 0.006, -0.11, 0.6, 2.05, 0.46, "policeBlock", INK)
  lightbar(m, 1.5, 0.02, 0.56)
  roofNumber(m, unit, 1.506, -0.66, 2 * (hw - 0.45), 0.6, INK)
  // Trunk-lid lip and a spotlight by the A-pillar.
  m.box(-0.08, 0.08, 1.05, 1.12, 0.62, 0.74, CHROME)
}

function interceptor(m: Mesh, v: Vehicle, unit: number, lights: LightStyle) {
  const zf = v.length / 2
  const zr = -zf
  const hw = v.width / 2
  const white = v.paint
  const black = v.accent
  const doorF = 0.78
  const doorR = -1.3
  const body: Body = {
    hull: [
      { z: zf, w: hw - 0.14, b: 0.34, s: 0.62, t: 0.74 },
      { z: zf - 0.15, w: hw - 0.04, b: 0.28, s: 0.74, t: 0.84 },
      { z: zf - 0.8, w: hw, b: 0.27, s: 0.82, t: 0.92, crown: 0.035 },
      { z: 0.78, w: hw, b: 0.27, s: 0.86, t: 0.96 },
      { z: -1.75, w: hw, b: 0.27, s: 0.88, t: 1.0 },
      { z: zr + 0.3, w: hw - 0.01, b: 0.28, s: 0.86, t: 1.0 },
      { z: zr + 0.08, w: hw - 0.05, b: 0.3, s: 0.8, t: 0.95 },
      { z: zr, w: hw - 0.13, b: 0.36, s: 0.72, t: 0.88 },
    ],
    cab: [
      { z: 0.8, wb: hw - 0.13, yb: 0.93, wt: 0, yt: 0 },
      { z: 0.16, wb: hw - 0.11, yb: 0.93, wt: hw - 0.42, yt: 1.42 },
      { z: -0.5, wb: hw - 0.11, yb: 0.94, wt: hw - 0.42, yt: 1.42 },
      { z: -0.6, wb: hw - 0.11, yb: 0.94, wt: hw - 0.42, yt: 1.42 },
      { z: -1.12, wb: hw - 0.11, yb: 0.96, wt: hw - 0.44, yt: 1.39 },
      { z: -1.9, wb: hw - 0.13, yb: 0.98, wt: 0, yt: 0 },
    ],
    axles: [1.55, -1.55],
    wheelR: 0.37,
    wheelW: 0.28,
    archR: 0.47,
    cuts: [doorF, doorR, -0.55],
  }
  hull(m, body, policeHull(white, black, doorF, doorR), { col: black }, { col: black })
  cab(m, body.cab, sedanCab(white, white, 2))
  frontFascia(m, body, { bumper: TRIM, grille: INK, pushBar: true, lampW: 0.4, lampH: 0.08 }, lights)
  rearFascia(m, body, { bumper: TRIM, lampW: 0.42, lampH: 0.08, bar: true }, lights)
  mirrors(m, 0.66, hw - 0.12, 0.96, black)
  seam(m, hw, doorF - 0.02, 0.36, 0.95)
  handles(m, hw, [0.35, -0.72], 0.84, TRIM)
  sideText(m, hw + 0.006, -0.26, 0.6, 2.0, 0.46, "policeBlock", INK)
  lightbar(m, 1.42, -0.05, 0.54, 0.26, 0.12)
  roofNumber(m, unit, 1.426, -0.72, 2 * (hw - 0.47), 0.55, INK)
  // Hood power bulge and decklid spoiler.
  extrudeZ(m, [[-0.3, 0.9], [0.3, 0.9], [0.22, 0.97], [-0.22, 0.97]], 1.0, 2.0, black)
  extrudeX(m, [[zr + 0.1, 1.0], [zr + 0.32, 1.0], [zr + 0.3, 1.04], [zr + 0.06, 1.08]], -hw + 0.08, hw - 0.08, black)
}

function muscle(m: Mesh, v: Vehicle, lights: LightStyle) {
  const zf = v.length / 2
  const zr = -zf
  const hw = v.width / 2
  const red = v.paint
  const trim = v.accent
  const body: Body = {
    hull: [
      { z: zf, w: hw - 0.12, b: 0.34, s: 0.62, t: 0.72 },
      { z: zf - 0.15, w: hw - 0.03, b: 0.28, s: 0.72, t: 0.82 },
      { z: zf - 0.8, w: hw, b: 0.27, s: 0.8, t: 0.9, crown: 0.05 },
      { z: 0.55, w: hw, b: 0.27, s: 0.84, t: 0.94, crown: 0.04 },
      { z: -1.5, w: hw, b: 0.27, s: 0.86, t: 0.96 },
      { z: zr + 0.3, w: hw - 0.01, b: 0.28, s: 0.86, t: 0.98 },
      { z: zr + 0.08, w: hw - 0.05, b: 0.3, s: 0.82, t: 0.96 },
      { z: zr, w: hw - 0.12, b: 0.36, s: 0.74, t: 0.9 },
    ],
    cab: [
      { z: 0.6, wb: hw - 0.13, yb: 0.91, wt: 0, yt: 0 },
      { z: -0.18, wb: hw - 0.12, yb: 0.92, wt: hw - 0.42, yt: 1.3 },
      { z: -0.98, wb: hw - 0.12, yb: 0.93, wt: hw - 0.45, yt: 1.28 },
      { z: -1.95, wb: hw - 0.14, yb: 0.95, wt: 0, yt: 0 },
    ],
    axles: [1.48, -1.45],
    wheelR: 0.37,
    wheelW: 0.3,
    archR: 0.47,
  }
  hull(m, body, () => ({ col: red }), { col: red }, { col: red })
  cab(m, body.cab, sedanCab(red, red))
  frontFascia(m, body, { bumper: red, grille: INK, lampW: 0.32, lampH: 0.08, grilleH: 0.18 }, lights)
  rearFascia(m, body, { bumper: red, lampW: 0.36, lampH: 0.1 }, lights)
  mirrors(m, 0.45, hw - 0.12, 0.93, red)
  seam(m, hw, 0.52, 0.36, 0.9)
  handles(m, hw, [-0.45], 0.8, TRIM)
  // Hood vents, rocker trim, ducktail spoiler and twin exhausts.
  const hy0 = topAt(body, 0.7) + 0.02
  const hy1 = topAt(body, 1.5) + 0.03
  prism(m, [[-0.34, hy0 - 0.03, 0.7], [0.34, hy0 - 0.03, 0.7], [0.27, hy0 + 0.09, 0.7], [-0.27, hy0 + 0.09, 0.7]], [[-0.3, hy1 - 0.04, 1.5], [0.3, hy1 - 0.04, 1.5], [0.24, hy1 + 0.07, 1.5], [-0.24, hy1 + 0.07, 1.5]], red)
  poly(m, [[-0.22, hy1 - 0.01, 1.505], [0.22, hy1 - 0.01, 1.505], [0.2, hy1 + 0.055, 1.505], [-0.2, hy1 + 0.055, 1.505]], INK, MAT.lit, [0, hy1, 1.0])
  extrudeX(m, [[zr + 0.04, 0.9], [zr + 0.34, 0.95], [zr + 0.3, 1.0], [zr + 0.02, 1.04]], -hw + 0.1, hw - 0.1, red)
  for (const s of [-1, 1]) {
    const x = s * (hw + 0.002)
    poly(m, [[x, 0.33, 1.0], [x, 0.33, -1.0], [x, 0.4, -1.0], [x, 0.4, 1.0]], trim, MAT.lit, [0, 0.4, 0])
    m.box(s * 0.45 - 0.06, s * 0.45 + 0.06, 0.26, 0.34, zr - 0.12, zr + 0.1, CHROME)
  }
}

function compact(m: Mesh, v: Vehicle, lights: LightStyle) {
  const zf = v.length / 2
  const zr = -zf
  const hw = v.width / 2
  const paint = v.paint
  const trim = v.accent
  const body: Body = {
    hull: [
      { z: zf, w: hw - 0.12, b: 0.36, s: 0.64, t: 0.76 },
      { z: zf - 0.14, w: hw - 0.04, b: 0.3, s: 0.72, t: 0.84 },
      { z: zf - 0.5, w: hw, b: 0.28, s: 0.8, t: 0.9 },
      { z: 0.95, w: hw, b: 0.28, s: 0.84, t: 0.94 },
      { z: zr + 0.35, w: hw, b: 0.28, s: 0.86, t: 0.96 },
      { z: zr + 0.08, w: hw - 0.04, b: 0.31, s: 0.83, t: 0.95 },
      { z: zr, w: hw - 0.1, b: 0.36, s: 0.78, t: 0.92 },
    ],
    cab: [
      { z: 0.98, wb: hw - 0.12, yb: 0.91, wt: 0, yt: 0 },
      { z: 0.22, wb: hw - 0.1, yb: 0.92, wt: hw - 0.34, yt: 1.52 },
      { z: -0.36, wb: hw - 0.1, yb: 0.93, wt: hw - 0.34, yt: 1.52 },
      { z: -0.46, wb: hw - 0.1, yb: 0.93, wt: hw - 0.34, yt: 1.52 },
      { z: -1.42, wb: hw - 0.1, yb: 0.94, wt: hw - 0.35, yt: 1.49 },
      { z: zr + 0.12, wb: hw - 0.12, yb: 0.95, wt: 0, yt: 0 },
    ],
    axles: [1.22, -1.22],
    wheelR: 0.33,
    wheelW: 0.24,
    archR: 0.42,
  }
  hull(m, body, (band) => ({ col: band === 0 ? trim : paint }), { col: paint }, { col: paint })
  cab(m, body.cab, (band, seg, segs) => {
    if (band === 0) return seg === 2 ? { col: trim } : glass
    if (band === 1) return { col: seg === 0 || seg === segs - 1 ? trim : paint }
    return seg === 0 || seg === segs - 1 ? screen : { col: paint }
  })
  frontFascia(m, body, { bumper: trim, grille: INK, lampW: 0.3, lampH: 0.1, grilleH: 0.12 }, lights)
  rearFascia(m, body, { bumper: trim, lampW: 0.2, lampH: 0.18, lampY: 0.8 }, lights)
  mirrors(m, 0.82, hw - 0.1, 0.94, paint)
  seam(m, hw, -0.41, 0.36, 0.92)
  handles(m, hw, [0.45, -0.6], 0.8, trim)
  // Roof rails.
  for (const s of [-1, 1]) m.box(s * (hw - 0.3) - 0.03, s * (hw - 0.3) + 0.03, 1.52, 1.57, -1.3, 0.1, trim)
}

function van(m: Mesh, v: Vehicle, lights: LightStyle) {
  const zf = v.length / 2
  const zr = -zf
  const hw = v.width / 2
  const paint = v.paint
  const trim = v.accent
  const body: Body = {
    hull: [
      { z: zf, w: hw - 0.12, b: 0.36, s: 0.7, t: 0.84 },
      { z: zf - 0.14, w: hw - 0.04, b: 0.3, s: 0.8, t: 0.96 },
      { z: zf - 0.6, w: hw, b: 0.3, s: 0.92, t: 1.06 },
      { z: zr + 0.1, w: hw, b: 0.3, s: 0.96, t: 1.08 },
      { z: zr, w: hw - 0.03, b: 0.34, s: 0.94, t: 1.06 },
    ],
    cab: [
      { z: zf - 0.62, wb: hw - 0.06, yb: 1.03, wt: 0, yt: 0 },
      { z: zf - 1.45, wb: hw - 0.04, yb: 1.03, wt: hw - 0.12, yt: 2.2 },
      { z: zf - 2.15, wb: hw - 0.04, yb: 1.04, wt: hw - 0.12, yt: 2.2 },
      { z: zr + 0.05, wb: hw - 0.04, yb: 1.04, wt: hw - 0.12, yt: 2.2 },
    ],
    axles: [zf - 0.92, zr + 1.0],
    wheelR: 0.38,
    wheelW: 0.28,
    archR: 0.48,
  }
  hull(m, body, (band) => ({ col: band === 0 ? trim : paint }), { col: paint }, { col: paint })
  cab(
    m,
    body.cab,
    (band, seg) => {
      if (band === 0) return seg === 1 ? glass : { col: paint }
      if (band === 1) return { col: paint }
      return seg === 0 ? glass : { col: paint }
    },
    { col: paint },
  )
  frontFascia(m, body, { bumper: trim, grille: INK, lampW: 0.32, lampH: 0.14, grilleH: 0.18 }, lights)
  rearFascia(m, body, { bumper: trim, lampW: 0.14, lampH: 0.42, lampY: 1.0 }, lights)
  mirrors(m, zf - 0.75, hw - 0.04, 1.3, trim)
  // Sliding door, rear doors and a roof rack.
  seam(m, hw, zf - 2.2, 0.36, 2.1)
  seam(m, hw, zf - 1.5, 0.36, 2.1)
  seam(m, hw, zr + 1.6, 0.36, 2.1)
  m.box(-0.01, 0.01, 0.4, 2.1, zr - 0.012, zr + 0.01, INK)
  for (const z of [-1.8, -0.6, 0.5]) m.box(-hw + 0.15, hw - 0.15, 2.2, 2.26, z - 0.05, z + 0.05, trim)
  for (const s of [-1, 1]) m.box(s * (hw - 0.18) - 0.03, s * (hw - 0.18) + 0.03, 2.24, 2.3, -2.0, 0.7, trim)
  // Side trim stripe.
  for (const s of [-1, 1]) {
    const x = s * (hw + 0.004)
    poly(m, [[x, 0.98, zf - 0.6], [x, 0.98, zr + 0.1], [x, 1.06, zr + 0.1], [x, 1.06, zf - 0.6]], trim, MAT.lit, [0, 1, 0])
  }
}

function swat(m: Mesh, v: Vehicle, unit: number, lights: LightStyle) {
  const zf = v.length / 2
  const zr = -zf
  const hw = v.width / 2
  const paint = v.paint
  const body: Body = {
    hull: [
      { z: zf, w: hw - 0.12, b: 0.46, s: 0.92, t: 1.08 },
      { z: zf - 0.16, w: hw - 0.04, b: 0.4, s: 1.06, t: 1.22 },
      { z: zf - 1.2, w: hw, b: 0.4, s: 1.14, t: 1.32 },
      { z: zr + 0.1, w: hw, b: 0.4, s: 1.16, t: 1.32 },
      { z: zr, w: hw - 0.04, b: 0.44, s: 1.12, t: 1.28 },
    ],
    cab: [
      { z: zf - 1.25, wb: hw - 0.06, yb: 1.28, wt: 0, yt: 0 },
      { z: zf - 1.85, wb: hw - 0.05, yb: 1.28, wt: hw - 0.16, yt: 2.5 },
      { z: zf - 2.55, wb: hw - 0.05, yb: 1.28, wt: hw - 0.16, yt: 2.5 },
      { z: zr + 0.06, wb: hw - 0.05, yb: 1.28, wt: hw - 0.16, yt: 2.5 },
    ],
    axles: [zf - 1.0, zr + 1.05],
    wheelR: 0.48,
    wheelW: 0.34,
    archR: 0.57,
  }
  hull(m, body, () => ({ col: paint }), { col: paint }, { col: paint })
  cab(
    m,
    body.cab,
    (band, seg) => {
      if (band === 0) return { col: paint }
      if (band === 1) return { col: paint }
      return seg === 0 ? glass : { col: paint }
    },
    { col: paint },
  )
  // Armored slit windows on the cab doors and the box.
  for (const s of [-1, 1]) {
    const x = s * (hw - 0.03)
    poly(m, [[x, 1.55, zf - 1.9], [x, 1.55, zf - 2.5], [x, 1.98, zf - 2.5], [x, 1.98, zf - 1.9]], GLASS, MAT.glass, [0, 1.7, zf - 2.2])
    for (const z of [-0.6, -1.6]) poly(m, [[x, 1.75, z + 0.3], [x, 1.75, z - 0.3], [x, 1.95, z - 0.3], [x, 1.95, z + 0.3]], GLASS, MAT.glass, [0, 1.85, z])
  }
  frontFascia(m, body, { bumper: TRIM, grille: INK, pushBar: true, lampW: 0.3, lampH: 0.12, grilleH: 0.24 }, lights)
  rearFascia(m, body, { bumper: TRIM, lampW: 0.18, lampH: 0.24, lampY: 1.0 }, lights)
  mirrors(m, zf - 1.35, hw - 0.04, 1.6, TRIM)
  seam(m, hw - 0.04, zf - 2.6, 0.5, 2.4)
  seam(m, hw, zf - 1.25, 0.5, 1.2)
  m.box(-0.01, 0.01, 0.5, 2.4, zr - 0.012, zr + 0.01, INK)
  // Side steps, roof hatch, lightbar and lettering.
  for (const s of [-1, 1]) m.box(s * hw - 0.12, s * hw + 0.12, 0.42, 0.5, -1.6, 0.9, TRIM)
  block(m, -0.35, 0.35, 2.5, 2.58, -2.65, -2.25, [0.09, 0.1, 0.12])
  lightbar(m, 2.5, 0, hw - 0.25, 0.32, 0.17)
  topDecal(m, 2.506, 0, -0.95, 1.7, 0.5, "swat", WHITE)
  topDecal(m, 2.506, 0, -1.75, 0.6, 0.45, `num${unit % 10}` as AtlasRegion, WHITE)
  sideText(m, hw + 0.006, -0.8, 1.5, 2.6, 0.42, "policeBlock", WHITE)
  frontDecal(m, zf + 0.012, 0, 0.73, 0.75, 0.16, "policeBlock", WHITE)
}

function bike(m: Mesh, v: Vehicle) {
  const zf = v.length / 2
  const zr = -zf
  const paint = v.paint
  const accent = v.accent
  const r = 0.33
  for (const z of [zf - 0.38, zr + 0.38]) wheel(m, 1, 0.07, z, r, 0.14, HUB)
  // Fork, swingarm, engine and exhaust.
  extrudeX(m, [[zf - 0.42, 0.3], [zf - 0.34, 0.3], [zf - 0.6, 1.05], [zf - 0.68, 1.05]], -0.09, 0.09, CHROME)
  extrudeX(m, [[zr + 0.34, 0.3], [zr + 0.42, 0.26], [0.0, 0.5], [-0.05, 0.58]], -0.1, 0.1, TRIM)
  block(m, -0.17, 0.17, 0.3, 0.72, -0.35, 0.35, [0.18, 0.18, 0.2], MAT.lit, 0.05)
  m.box(0.14, 0.24, 0.32, 0.42, -1.05, -0.1, CHROME)
  // Tank, seat, tail and front fairing.
  block(m, -0.2, 0.2, 0.72, 0.98, -0.05, 0.6, paint, PAINT, 0.08)
  block(m, -0.17, 0.17, 0.78, 0.9, -0.75, -0.05, TRIM, MAT.lit, 0.05)
  extrudeX(m, [[-1.15, 0.84], [-0.7, 0.78], [-0.7, 0.96], [-1.1, 0.98]], -0.13, 0.13, paint)
  extrudeX(m, [[0.55, 0.72], [0.98, 0.78], [1.02, 1.0], [0.75, 1.18], [0.55, 1.0]], -0.24, 0.24, paint)
  m.box(-0.4, 0.4, 1.06, 1.1, 0.68, 0.72, CHROME)
  frontDecal(m, 1.03, 0, 0.9, 0.16, 0.08, "white", HEAD)
  m.box(-0.08, 0.08, 0.86, 0.95, 1.0, 1.04, HEAD, MAT.emissive)
  m.box(-0.1, 0.1, 0.86, 0.94, -1.19, -1.13, TAIL, MAT.emissive)
  // Rider leaning into the bars: legs, torso, arms and helmet.
  const jacket: Rgb = [0.1, 0.1, 0.12]
  for (const s of [-1, 1]) {
    extrudeZ(m, [[s * 0.12, 0.85], [s * 0.26, 0.85], [s * 0.26, 1.0], [s * 0.12, 1.0]], -0.45, 0.15, [0.08, 0.08, 0.1])
    m.box(s * 0.18 - 0.07, s * 0.18 + 0.07, 0.4, 0.95, 0.1, 0.25, [0.08, 0.08, 0.1])
    extrudeX(m, [[0.05, 1.42], [0.14, 1.42], [0.72, 1.1], [0.66, 1.03]], s > 0 ? 0.2 : -0.28, s > 0 ? 0.28 : -0.2, jacket)
  }
  prism(
    m,
    [[-0.22, 0.95, -0.42], [0.22, 0.95, -0.42], [0.22, 1.05, -0.2], [-0.22, 1.05, -0.2]],
    [[-0.26, 1.35, 0.05], [0.26, 1.35, 0.05], [0.24, 1.5, 0.22], [-0.24, 1.5, 0.22]],
    jacket,
    MAT.lit,
  )
  block(m, -0.14, 0.14, 1.48, 1.76, 0.2, 0.5, accent, PAINT, 0.07)
  m.box(-0.11, 0.11, 1.56, 1.66, 0.48, 0.52, GLASS, MAT.glass)
}

/** The model for one vehicle; police vehicles carry a roof unit number. */
export function buildCar(v: Vehicle, unit = UNIT_NUMBERS[v.id]?.[0] ?? 0, lights: LightStyle = 0): Mesh {
  const m = new Mesh()
  switch (v.id) {
    case "cruiser":
      cruiser(m, v, unit, lights)
      break
    case "interceptor":
      interceptor(m, v, unit, lights)
      break
    case "swat":
      swat(m, v, unit, lights)
      break
    case "muscle":
      muscle(m, v, lights)
      break
    case "compact":
      compact(m, v, lights)
      break
    case "van":
      van(m, v, lights)
      break
    case "bike":
      bike(m, v)
      break
    default:
      cruiser(m, v, unit, lights)
  }
  return m
}

/** Every roof-number variant of a vehicle (one for civilian models). */
export function buildCarVariants(v: Vehicle, lights: LightStyle = 0): Mesh[] {
  const units = UNIT_NUMBERS[v.id]
  return units ? units.map((u) => buildCar(v, u, lights)) : [buildCar(v, 0, lights)]
}

// ---------------------------------------------------------------------------------------------------------------
// Helicopter

/**
 * Police helicopter in local space (the scene scales it by 1.2): dark navy upper body, white belly and tail,
 * "POLICE" on the flanks, skids, and a spotlight under the nose at about (0, 0.35, 2.0). The rotor hub sits at
 * y ≈ 2.58; the tail rotor is a separate instance near (0.25, 1.92, -6.6).
 */
export function buildHeli(): Mesh {
  const m = new Mesh()
  const navy: Rgb = [0.07, 0.085, 0.13]
  const white: Rgb = [0.86, 0.87, 0.9]
  const n = 8
  // Rings: z, half width, half height, center y.
  const keys: [number, number, number, number][] = [
    [2.55, 0.18, 0.2, 0.95],
    [2.3, 0.6, 0.55, 1.05],
    [1.7, 0.95, 0.88, 1.25],
    [0.95, 1.05, 1.0, 1.35],
    [-0.75, 1.05, 1.0, 1.4],
    [-1.6, 0.85, 0.82, 1.5],
    [-2.4, 0.38, 0.38, 1.7],
    [-6.35, 0.15, 0.17, 1.9],
  ]
  const rings = keys.map(([z, w, h, cy]) =>
    Array.from({ length: n }, (_, i): V3 => {
      const a = ((i - 0.5) / n) * Math.PI * 2
      const y = cy + Math.sin(a) * h
      return [Math.cos(a) * w, Math.max(y, cy - h * 0.82), z]
    }),
  )
  // Edges: 0 side, 1 upper side, 2 top, 3 upper side (left), 4 side (left), 5..7 lower and belly.
  loft(
    m,
    rings,
    true,
    (seg, e) => {
      const upper = e >= 1 && e <= 3
      const side = e === 0 || e === 4
      // Nose: windscreen over a white chin. Cabin: navy flanks under side windows, white belly band.
      if (seg <= 1) return upper || (side && seg === 1) ? screen : { col: white }
      if (seg <= 3 && (e === 1 || e === 3)) return glass
      if (seg <= 4) return { col: e === 2 || side || upper ? navy : white }
      return { col: white }
    },
    { front: { col: navy }, back: { col: navy } },
  )
  // Flank lettering.
  sideText(m, Math.cos(Math.PI / 8) * 1.05 + 0.008, 0.0, 1.36, 1.7, 0.4, "policeBlock", WHITE)
  // Engine cowling, mast, exhaust.
  block(m, -0.55, 0.55, 2.2, 2.5, -1.7, 0.5, navy, PAINT, 0.12)
  m.box(-0.1, 0.1, 2.5, 2.6, -0.1, 0.1, TRIM, MAT.lit)
  m.box(-0.4, 0.4, 2.25, 2.4, -2.1, -1.7, TRIM, MAT.lit)
  // Tail fin, stabilizer and nav lights.
  extrudeX(m, [[-6.0, 1.75], [-6.55, 1.75], [-6.75, 3.0], [-6.45, 3.0]], -0.06, 0.06, white)
  extrudeX(m, [[-6.3, 2.5], [-6.62, 2.5], [-6.75, 3.0], [-6.45, 3.0]], -0.065, 0.065, navy)
  extrudeX(m, [[-6.1, 1.85], [-6.6, 1.85], [-6.65, 1.2], [-6.4, 1.2]], -0.05, 0.05, navy)
  extrudeX(m, [[-5.1, 1.84], [-5.6, 1.84], [-5.6, 1.92], [-5.1, 1.92]], -0.95, 0.95, white)
  for (const s of [-1, 1]) {
    extrudeX(m, [[-5.1, 1.78], [-5.6, 1.78], [-5.6, 2.25], [-5.2, 2.25]], s * 0.95 - 0.04, s * 0.95 + 0.04, navy)
    m.box(s * 0.98 - 0.05, s * 0.98 + 0.05, 2.15, 2.27, -5.45, -5.35, TAIL, MAT.emissive)
  }
  m.box(-0.06, 0.06, 3.0, 3.1, -6.65, -6.53, TAIL, MAT.emissive)
  m.box(-0.08, 0.08, 0.45, 0.55, -1.4, -1.2, TAIL, MAT.emissive)
  // Skids and struts.
  for (const s of [-1, 1]) {
    const x = s * 1.0
    extrudeZ(m, [[x - 0.06, 0.02], [x + 0.06, 0.02], [x + 0.06, 0.12], [x - 0.06, 0.12]], -1.7, 1.5, TRIM, MAT.lit)
    extrudeZ(m, [[x - 0.06, 0.02], [x + 0.06, 0.02], [x + 0.06, 0.12], [x - 0.06, 0.12]], 1.5, 1.85, TRIM, MAT.lit)
    m.box(x - 0.06, x + 0.06, 0.12, 0.32, 1.75, 1.9, TRIM, MAT.lit)
    for (const z of [-0.9, 0.9]) extrudeX(m, [[z - 0.06, 0.1], [z + 0.06, 0.1], [z + 0.06, 0.62], [z - 0.06, 0.62]], s > 0 ? 0.55 : -1.03, s > 0 ? 1.03 : -0.55, TRIM, MAT.lit)
  }
  // Spotlight pod under the nose.
  block(m, -0.18, 0.18, 0.2, 0.46, 1.8, 2.15, TRIM, MAT.lit, 0.05)
  m.box(-0.13, 0.13, 0.2, 0.42, 2.15, 2.19, HEAD, MAT.emissive)
  m.box(-0.12, 0.12, 0.18, 0.21, 1.86, 2.12, HEAD, MAT.emissive)
  return m
}

/** Four-bladed main rotor, 12 m across, spinning about y. Also used, scaled, as the tail rotor. */
export function buildRotor(): Mesh {
  const m = new Mesh()
  const col: Rgb = [0.1, 0.1, 0.11]
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2
    const c = Math.cos(a)
    const s = Math.sin(a)
    const p = (along: number, side: number, y: number): V3 => [c * along - s * side, y, s * along + c * side]
    const r0 = [p(0.3, -0.16, 0), p(0.3, 0.16, 0.04), p(0.3, 0.16, 0), p(0.3, -0.16, -0.01)]
    const r1 = [p(6, -0.14, -0.06), p(6, 0.14, -0.03), p(6, 0.14, -0.06), p(6, -0.14, -0.07)]
    prism(m, r0, r1, col, MAT.lit)
  }
  block(m, -0.3, 0.3, -0.06, 0.12, -0.3, 0.3, [0.2, 0.2, 0.22], MAT.lit, 0.08)
  return m
}

export const CAR_MODELS = VEHICLES.map((v) => v.id)
