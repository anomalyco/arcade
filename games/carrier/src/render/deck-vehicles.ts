// Deck vehicles for the carrier: jet, helicopter, tow tractor, cart and deck crew. Each is built at the origin of its
// own frame (ground at y = 0, nose toward +Z), so it can be instanced on its own. Also the small geometry helpers the
// carrier mesh shares: fans, lofts, faceted spheres and arbitrary yaw placement.
import { FLOATS_PER_VERT, MAT, type Mat, type Mesh, type Rgb } from "./mesh"

export type V3 = [number, number, number]

export const hex = (h: number): Rgb => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255]

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/** Triangle whose winding is flipped if needed so its normal points away from `inside`. */
export function facetOut(m: Mesh, a: V3, b: V3, c: V3, inside: V3, col: Rgb, mat: Mat = MAT.lit, aux = 0): void {
  const n = cross(sub(b, a), sub(c, a))
  if (Math.hypot(n[0], n[1], n[2]) < 1e-9) return
  const g: V3 = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3]
  if (dot(n, sub(g, inside)) < 0) m.facet(a, c, b, col, mat, aux)
  else m.facet(a, b, c, col, mat, aux)
}

/** Convex planar polygon as a triangle fan, facing away from `inside`. */
export function polyOut(m: Mesh, pts: V3[], inside: V3, col: Rgb, mat: Mat = MAT.lit, aux = 0): void {
  for (let i = 1; i + 1 < pts.length; i++) facetOut(m, pts[0]!, pts[i]!, pts[i + 1]!, inside, col, mat, aux)
}

/** Convex planar polygon facing a given direction (fan from the first point). */
export function polyFacing(m: Mesh, pts: V3[], normal: V3, col: Rgb, mat: Mat = MAT.lit, aux = 0): void {
  const c: V3 = [0, 0, 0]
  for (const p of pts) for (let k = 0; k < 3; k++) c[k]! += p[k]! / pts.length
  polyOut(m, pts, [c[0] - normal[0], c[1] - normal[1], c[2] - normal[2]], col, mat, aux)
}

const centroid = (ring: V3[]): V3 => {
  const c: V3 = [0, 0, 0]
  for (const p of ring) for (let k = 0; k < 3; k++) c[k]! += p[k]! / ring.length
  return c
}

/**
 * Skin between closed rings of equal point count (a fuselage, a mast). Faces point away from the local ring centre.
 * `color` may vary per segment (ring index, point index). Ends are capped unless disabled.
 */
export function loft(m: Mesh, rings: V3[][], color: Rgb | ((i: number, j: number) => Rgb), caps: [boolean, boolean] = [true, true], mat: Mat = MAT.lit): void {
  const col = typeof color === "function" ? color : () => color
  for (let i = 0; i + 1 < rings.length; i++) {
    const a = rings[i]!
    const b = rings[i + 1]!
    const ca = centroid(a)
    const cb = centroid(b)
    const inside: V3 = [(ca[0] + cb[0]) / 2, (ca[1] + cb[1]) / 2, (ca[2] + cb[2]) / 2]
    for (let j = 0; j < a.length; j++) {
      const k = (j + 1) % a.length
      facetOut(m, a[j]!, a[k]!, b[k]!, inside, col(i, j), mat)
      facetOut(m, a[j]!, b[k]!, b[j]!, inside, col(i, j), mat)
    }
  }
  const capRing = (r: V3[], other: V3[], i: number) => {
    const c = centroid(r)
    const o = centroid(other)
    const inside: V3 = [c[0] + (o[0] - c[0]) * 0.01, c[1] + (o[1] - c[1]) * 0.01, c[2] + (o[2] - c[2]) * 0.01]
    for (let j = 0; j < r.length; j++) facetOut(m, c, r[j]!, r[(j + 1) % r.length]!, inside, col(i, j), mat)
  }
  if (caps[0] && rings.length > 1) capRing(rings[0]!, rings[1]!, 0)
  if (caps[1] && rings.length > 1) capRing(rings[rings.length - 1]!, rings[rings.length - 2]!, rings.length - 2)
}

/** Extruded convex plan polygon (x, z) between y0 and y1. */
export function slab(m: Mesh, pts: [number, number][], y0: number, y1: number, col: Rgb, top: Rgb = col, mat: Mat = MAT.lit): void {
  loft(m, [pts.map(([x, z]): V3 => [x, y0, z]), pts.map(([x, z]): V3 => [x, y1, z])], col, [false, false], mat)
  const inside: V3 = [pts.reduce((s, p) => s + p[0], 0) / pts.length, (y0 + y1) / 2, pts.reduce((s, p) => s + p[1], 0) / pts.length]
  polyOut(m, pts.map(([x, z]): V3 => [x, y1, z]), inside, top, mat)
  polyOut(m, pts.map(([x, z]): V3 => [x, y0, z]), inside, col, mat)
}

/** Box between two arbitrary corner points, rotated: thin struts and beams. */
export function beam(m: Mesh, a: V3, b: V3, w: number, col: Rgb, mat: Mat = MAT.lit): void {
  const d = sub(b, a)
  const len = Math.hypot(d[0], d[1], d[2])
  if (len < 1e-6) return
  const f: V3 = [d[0] / len, d[1] / len, d[2] / len]
  let u = cross(f, Math.abs(f[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0])
  const ul = Math.hypot(...u)
  u = [u[0] / ul, u[1] / ul, u[2] / ul]
  const v = cross(f, u)
  const h = w / 2
  const ring = (p: V3): V3[] =>
    [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ].map(([s, t]): V3 => [p[0] + (u[0] * s! + v[0] * t!) * h, p[1] + (u[1] * s! + v[1] * t!) * h, p[2] + (u[2] * s! + v[2] * t!) * h])
  loft(m, [ring(a), ring(b)], col, [true, true], mat)
}

/** Faceted geodesic sphere (icosahedron, subdivided `level` times). `minY` drops faces entirely below it. */
export function geoSphere(m: Mesh, c: V3, r: number, col: Rgb, level = 1, minY = -Infinity, mat: Mat = MAT.lit): void {
  const t = (1 + Math.sqrt(5)) / 2
  let verts: V3[] = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ]
  let faces: [number, number, number][] = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ]
  const unit = (p: V3): V3 => {
    const l = Math.hypot(...p)
    return [p[0] / l, p[1] / l, p[2] / l]
  }
  verts = verts.map(unit)
  for (let s = 0; s < level; s++) {
    const cache = new Map<string, number>()
    const mid = (a: number, b: number) => {
      const key = a < b ? `${a},${b}` : `${b},${a}`
      const hit = cache.get(key)
      if (hit !== undefined) return hit
      const p = verts[a]!
      const q = verts[b]!
      verts.push(unit([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2]))
      cache.set(key, verts.length - 1)
      return verts.length - 1
    }
    const next: [number, number, number][] = []
    for (const [a, b, d] of faces) {
      const ab = mid(a, b)
      const bd = mid(b, d)
      const da = mid(d, a)
      next.push([a, ab, da], [b, bd, ab], [d, da, bd], [ab, bd, da])
    }
    faces = next
  }
  // Tilt slightly so the facets don't line up with the axes.
  const ry = 0.35
  const cy = Math.cos(ry)
  const sy = Math.sin(ry)
  const P = verts.map((p): V3 => [c[0] + (p[0] * cy + p[2] * sy) * r, c[1] + p[1] * r, c[2] + (-p[0] * sy + p[2] * cy) * r])
  for (const [a, b, d] of faces) {
    if (Math.max(P[a]![1], P[b]![1], P[d]![1]) < minY) continue
    facetOut(m, P[a]!, P[b]!, P[d]!, c, col, mat)
  }
}

/** Rotates everything added since `from` by `yaw` about Y (local +Z turns toward (sin yaw, 0, cos yaw)), then moves it. */
export function placeYaw(m: Mesh, from: number, yaw: number, tx: number, ty: number, tz: number): void {
  const c = Math.cos(yaw)
  const s = Math.sin(yaw)
  for (let i = from; i < m.v.length; i += FLOATS_PER_VERT) {
    const x = m.v[i]!
    const z = m.v[i + 2]!
    m.v[i] = x * c + z * s + tx
    m.v[i + 1]! += ty
    m.v[i + 2] = -x * s + z * c + tz
    const nx = m.v[i + 3]!
    const nz = m.v[i + 5]!
    m.v[i + 3] = nx * c + nz * s
    m.v[i + 5] = -nx * s + nz * c
  }
}

/**
 * Mirrors everything added since `from` (a whole number of triangles) across the plane x = 0: negates x and the
 * normal's x, and swaps two vertices of each triangle so the winding stays counter-clockwise from the outside. Only
 * for geometry without lettering; text must be rebuilt in place, not mirrored.
 */
export function mirrorX(m: Mesh, from: number): void {
  const F = FLOATS_PER_VERT
  for (let i = from; i < m.v.length; i += F) {
    m.v[i] = -m.v[i]!
    m.v[i + 3] = -m.v[i + 3]!
  }
  for (let t = from; t + 3 * F <= m.v.length; t += 3 * F) {
    for (let k = 0; k < F; k++) {
      const a = t + F + k
      const b = t + 2 * F + k
      const tmp = m.v[a]!
      m.v[a] = m.v[b]!
      m.v[b] = tmp
    }
  }
}

/** Rotates everything added since `from` about the X axis through (0, py, pz): pitch > 0 lifts +Z up. */
export function pitchAbout(m: Mesh, from: number, pitch: number, py: number, pz: number): void {
  const c = Math.cos(pitch)
  const s = Math.sin(pitch)
  for (let i = from; i < m.v.length; i += FLOATS_PER_VERT) {
    const y = m.v[i + 1]! - py
    const z = m.v[i + 2]! - pz
    m.v[i + 1] = y * c + z * s + py
    m.v[i + 2] = -y * s + z * c + pz
    const ny = m.v[i + 4]!
    const nz = m.v[i + 5]!
    m.v[i + 4] = ny * c + nz * s
    m.v[i + 5] = -ny * s + nz * c
  }
}

/** Rotates everything added since `from` about the Z axis through (px, py, *): roll > 0 lifts +X up. */
export function rollAbout(m: Mesh, from: number, roll: number, px: number, py: number): void {
  const c = Math.cos(roll)
  const s = Math.sin(roll)
  for (let i = from; i < m.v.length; i += FLOATS_PER_VERT) {
    const x = m.v[i]! - px
    const y = m.v[i + 1]! - py
    m.v[i] = x * c - y * s + px
    m.v[i + 1] = x * s + y * c + py
    const nx = m.v[i + 3]!
    const ny = m.v[i + 4]!
    m.v[i + 3] = nx * c - ny * s
    m.v[i + 4] = nx * s + ny * c
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Palette (sampled from the concepts, sRGB albedo)

export const VPAL = {
  jet: hex(0xa9b0bd),
  jetDark: hex(0x8a92a0),
  jetEdge: hex(0xc4cad4),
  canopy: hex(0x1f2a3c),
  nozzle: hex(0x3a3e46),
  tyre: hex(0x1e2024),
  heli: hex(0x949ca8),
  heliDark: hex(0x6e7682),
  rotor: hex(0x3a3f47),
  yellow: hex(0xecbc2a),
  yellowDark: hex(0xb88c18),
  black: hex(0x24262b),
  cartGrille: hex(0x6d5a1e),
  trousers: hex(0x232a38),
  skin: hex(0xd9a27a),
  helmet: hex(0xeeeeee),
  vestYellow: hex(0xf2c418),
  vestRed: hex(0xd2282a),
  vestGreen: hex(0x2fa040),
  windowDark: hex(0x1c2636),
} as const

// ---------------------------------------------------------------------------------------------------------------------
// Vehicles

/** Hexagonal fuselage ring at station z: half-width w, bottom yb, widest at ym, top yt. */
function hexRing(z: number, w: number, yb: number, ym: number, yt: number, xo = 0): V3[] {
  return [
    [xo - w * 0.55, yb, z],
    [xo + w * 0.55, yb, z],
    [xo + w, ym, z],
    [xo + w * 0.6, yt, z],
    [xo - w * 0.6, yt, z],
    [xo - w, ym, z],
  ]
}

function wheel(m: Mesh, x: number, z: number, r: number, w: number, col: Rgb): void {
  m.box(x - w / 2, 0, z - r, x + w / 2, r * 2, z + r, col)
}

/** Stealthy single-seat fighter, ~18 m long, 15 m span, light grey with a dark canopy. Nose toward +Z. */
export function buildJet(m: Mesh, body: Rgb = VPAL.jet): void {
  const dark = VPAL.jetDark
  // Gear and wheels first (under everything).
  for (const [x, z] of [
    [0, 5.6],
    [-1.9, -1.6],
    [1.9, -1.6],
  ] as const) {
    m.box(x - 0.12, 0.6, z - 0.12, x + 0.12, 1.7, z + 0.12, VPAL.tyre)
    wheel(m, x, z, 0.42, 0.36, VPAL.tyre)
  }
  // Fuselage.
  loft(
    m,
    [
      hexRing(9.2, 0.04, 2.25, 2.3, 2.36),
      hexRing(7.2, 0.62, 1.95, 2.3, 2.75),
      hexRing(4.6, 1.25, 1.6, 2.35, 3.15),
      hexRing(1.5, 1.95, 1.5, 2.4, 3.2),
      hexRing(-3.0, 2.05, 1.55, 2.4, 3.05),
      hexRing(-6.6, 1.55, 1.7, 2.35, 2.9),
      hexRing(-8.3, 1.05, 1.85, 2.35, 2.75),
    ],
    (i, j) => (j === 3 || j === 4 ? VPAL.jetEdge : j <= 1 ? dark : body),
  )
  // Engine nozzle.
  loft(m, [hexRing(-8.3, 0.75, 1.95, 2.35, 2.7), hexRing(-9.0, 0.7, 2.0, 2.35, 2.66)], VPAL.nozzle)
  // Canopy.
  loft(m, [hexRing(6.4, 0.08, 2.8, 2.85, 2.9), hexRing(5.2, 0.55, 2.9, 3.2, 3.6), hexRing(3.4, 0.6, 3.05, 3.3, 3.75), hexRing(1.8, 0.3, 3.15, 3.25, 3.35)], VPAL.canopy)
  // Intakes: dark mouths on the flanks.
  for (const s of [-1, 1]) {
    const x0 = s * 1.25
    const x1 = s * 2.05
    polyOut(m, [[x0, 1.85, 4.2], [x1, 1.95, 3.2], [x1, 2.8, 3.2], [x0, 2.9, 4.2]], [0, 2.4, 2], VPAL.canopy)
  }
  // Wings: thin swept trapezoids, slightly drooped tips catch light differently from the root.
  for (const s of [-1, 1]) {
    const wing: [number, number][] = [
      [s * 1.7, 2.4],
      [s * 7.6, -3.1],
      [s * 7.6, -4.6],
      [s * 1.7, -5.6],
    ]
    slab(m, wing, 2.12, 2.36, body, body)
    // Horizontal stabilisers.
    const tail: [number, number][] = [
      [s * 1.4, -5.8],
      [s * 4.4, -7.7],
      [s * 4.4, -8.7],
      [s * 1.4, -8.9],
    ]
    slab(m, tail, 2.14, 2.32, body, body)
    // Twin canted fins.
    const from = m.length
    polyOut(m, [[0, 0, -4.4], [0, 0, -8.2], [0, 3.0, -8.6], [0, 3.0, -6.8]], [-s, 0, -6.5], dark)
    polyOut(m, [[0, 0, -4.4], [0, 0, -8.2], [0, 3.0, -8.6], [0, 3.0, -6.8]], [s, 0, -6.5], body)
    rollAbout(m, from, s * 0.38, 0, 0)
    for (let i = from; i < m.v.length; i += FLOATS_PER_VERT) {
      m.v[i]! += s * 1.45
      m.v[i + 1]! += 2.9
    }
  }
}

/** Utility helicopter, ~16 m with the rotor, grey. Nose toward +Z. */
export function buildHelicopter(m: Mesh): void {
  const body = VPAL.heli
  const dark = VPAL.heliDark
  // Wheels.
  for (const [x, z] of [
    [-1.5, -1.2],
    [1.5, -1.2],
    [0, 4.4],
  ] as const) {
    m.box(x - 0.1, 0.5, z - 0.1, x + 0.1, 1.0, z + 0.1, VPAL.tyre)
    wheel(m, x, z, 0.36, 0.3, VPAL.tyre)
  }
  // Fuselage: cabin and nose.
  loft(
    m,
    [
      hexRing(6.4, 0.35, 1.5, 1.9, 2.3),
      hexRing(5.6, 1.0, 1.0, 1.9, 2.9),
      hexRing(4.2, 1.45, 0.85, 2.0, 3.35),
      hexRing(-1.6, 1.5, 0.85, 2.0, 3.45),
      hexRing(-3.4, 0.95, 1.6, 2.4, 3.2),
    ],
    (i, j) => (i <= 1 && j >= 2 ? VPAL.windowDark : j <= 1 ? dark : body),
  )
  // Cabin side windows.
  for (const s of [-1, 1]) {
    polyOut(m, [[s * 1.47, 2.2, 3.6], [s * 1.47, 2.2, 1.0], [s * 1.47, 3.0, 1.0], [s * 1.47, 3.0, 3.6]], [0, 2.2, 2.3], VPAL.windowDark)
    m.box(s > 0 ? 1.45 : -2.1, 1.0, -1.4, s > 0 ? 2.1 : -1.45, 1.6, 1.6, dark)
  }
  // Tail boom, fin and tail rotor.
  loft(m, [hexRing(-3.4, 0.6, 2.2, 2.6, 3.1), hexRing(-9.6, 0.24, 2.75, 2.95, 3.15)], body)
  polyOut(m, [[0, 2.8, -8.9], [0, 2.8, -10.2], [0, 5.0, -10.6], [0, 5.0, -9.6]], [-1, 3.6, -9.6], dark)
  polyOut(m, [[0, 2.8, -8.9], [0, 2.8, -10.2], [0, 5.0, -10.6], [0, 5.0, -9.6]], [1, 3.6, -9.6], dark)
  m.box(0.08, 3.0, -10.15, 0.18, 5.2, -9.95, VPAL.rotor)
  m.box(0.08, 4.0, -11.1, 0.18, 4.2, -9.0, VPAL.rotor)
  // Engine housing and rotor.
  m.bevelBox(-0.95, 3.3, -1.8, 0.95, 4.15, 2.6, 0.25, body, VPAL.jetEdge)
  m.prism(0, 0.4, 0.3, 0.26, 4.15, 4.75, 6, VPAL.rotor)
  m.prism(0, 0.4, 0.5, 0.4, 4.7, 4.95, 6, VPAL.rotor)
  for (let k = 0; k < 4; k++) {
    const a = Math.PI / 4 + (k * Math.PI) / 2 + 0.2
    const from = m.length
    m.box(0.3, 4.78, -0.26, 7.6, 4.88, 0.26, VPAL.rotor)
    placeYaw(m, from, a, 0, 0, 0)
    for (let i = from; i < m.v.length; i += FLOATS_PER_VERT) m.v[i + 2]! += 0.4
  }
}

/** Yellow aircraft tow tractor, ~4.4 m x 2.7 m. Front toward +Z. */
export function buildTractor(m: Mesh): void {
  const y = VPAL.yellow
  for (const [x, z] of [
    [-1.2, 1.3],
    [1.2, 1.3],
    [-1.2, -1.3],
    [1.2, -1.3],
  ] as const)
    wheel(m, x, z, 0.5, 0.55, VPAL.tyre)
  m.bevelBox(-1.35, 0.45, -2.2, 1.35, 1.35, 2.2, 0.18, y, y)
  // Raised rear block and seat.
  m.bevelBox(-1.3, 1.35, -2.15, 1.3, 2.05, -0.6, 0.15, y, y)
  m.box(-0.55, 1.35, -0.4, 0.55, 1.75, 0.5, VPAL.black)
  // Sloped nose and dark grille.
  m.box(-1.1, 0.7, 2.2, 1.1, 1.15, 2.35, VPAL.black)
  m.box(-0.2, 0.55, 2.35, 0.2, 0.75, 2.9, VPAL.black)
  // Light bar.
  m.box(-0.9, 2.05, -1.6, 0.9, 2.25, -1.3, VPAL.black)
  m.box(-0.25, 2.25, -1.55, 0.25, 2.4, -1.35, hex(0xff8a1a), MAT.glow, 0.6)
}

/** Small yellow deck cart (power or air cart), ~3 m x 2 m. Front toward +Z. */
export function buildCart(m: Mesh): void {
  for (const [x, z] of [
    [-0.85, 0.9],
    [0.85, 0.9],
    [-0.85, -0.9],
    [0.85, -0.9],
  ] as const)
    wheel(m, x, z, 0.3, 0.3, VPAL.tyre)
  m.bevelBox(-1.0, 0.35, -1.5, 1.0, 2.0, 1.5, 0.12, VPAL.yellow, VPAL.yellow)
  // Grille panels on the sides and a dark top hatch.
  for (const s of [-1, 1]) m.box(s > 0 ? 0.98 : -1.03, 0.75, -1.1, s > 0 ? 1.03 : -0.98, 1.65, 0.6, VPAL.cartGrille)
  m.box(-0.6, 2.0, -0.9, 0.6, 2.08, 0.4, VPAL.yellowDark)
  m.box(-0.12, 0.45, 1.5, 0.12, 0.6, 2.3, VPAL.black)
}

/** Deck crew member in a coloured vest and white helmet, ~2.2 m (slightly oversized so they read from afar). Faces +Z. */
export function buildCrew(m: Mesh, vest: Rgb): void {
  // Legs.
  m.box(-0.32, 0, -0.18, -0.04, 1.0, 0.18, VPAL.trousers)
  m.box(0.04, 0, -0.18, 0.32, 1.0, 0.18, VPAL.trousers)
  // Torso (vest) and arms.
  m.bevelBox(-0.4, 0.95, -0.24, 0.4, 1.72, 0.24, 0.06, vest, vest)
  m.box(-0.56, 1.0, -0.13, -0.4, 1.65, 0.13, vest)
  m.box(0.4, 1.0, -0.13, 0.56, 1.65, 0.13, vest)
  m.box(-0.55, 0.85, -0.11, -0.41, 1.0, 0.11, VPAL.skin)
  m.box(0.41, 0.85, -0.11, 0.55, 1.0, 0.11, VPAL.skin)
  // Head and helmet.
  m.box(-0.17, 1.72, -0.17, 0.17, 1.98, 0.17, VPAL.skin)
  m.bevelBox(-0.21, 1.94, -0.22, 0.21, 2.22, 0.21, 0.07, VPAL.helmet, VPAL.helmet)
}

export const VEST: Record<"crew-yellow" | "crew-red" | "crew-green", Rgb> = {
  "crew-yellow": VPAL.vestYellow,
  "crew-red": VPAL.vestRed,
  "crew-green": VPAL.vestGreen,
}
