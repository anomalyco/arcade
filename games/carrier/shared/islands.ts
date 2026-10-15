import { fbm, noise2, ridged, smoothstep as ss } from "./noise"
import { hash3, Rng } from "./rng"
import { makeSea } from "./sea"

/**
 * Procedural archipelago (look: concept/island-1..5). `makeArchipelago(seed)` scatters 10-22 islands of six kinds over a
 * 12 km square around the origin: one centrepiece (a volcano or a big jungle island) a few kilometres north of the
 * spawn, then jungle islands, cays, rock stack clusters, atolls and cliff islands. 600 m around (0, 0) stays open sea.
 *
 * Every island is a few "blobs". A blob is a star-shaped landmass in its own polar frame: a smooth harmonic coastline
 * C(θ), a coastal profile given as stops (distance inland → height: wet sand, beach, forest edge, or cliff strata), an
 * interior height over the normalised radius ρ (dome, hills, ridged cone with a crater, plateau), and a seaward reef
 * shelf that drops to the deep floor. The mesh builder lays its rings on the same stops, so beaches are continuous
 * bands and cliffs are stepped walls. Atolls add a "reef" blob (reef flat, passes and lagoon) under bent motu cays.
 * Overlapping blobs combine by max. A lazily built grid index (cached per archipelago) keeps sampling cheap.
 */

export type IslandKind = "cay" | "jungle" | "atoll" | "stacks" | "cliff" | "volcanic"
export type Island = { x: number; z: number; radius: number; peak: number; kind: IslandKind; seed: number }
export type Archipelago = { seed: number; islands: Island[]; bounds: [x0: number, z0: number, x1: number, z1: number] }

/** Height of the open sea floor. */
export const DEEP = -60
/** Half the side of the square the islands are scattered over. */
export const WORLD_HALF = 6000
/** Radius around (0, 0) that stays open, deep sea. */
export const SPAWN_CLEAR = 600

export type BlobKind = "cay" | "jungle" | "volcanic" | "cliff" | "stack" | "reef" | "bank"

const TAU = Math.PI * 2

// Math.atan2 and Math.hypot dominate sampling time in JavaScriptCore; these are plain arithmetic (deterministic
// everywhere). atan2: max error ~1e-5 rad, continuous across the ±π branch.
function atan2(y: number, x: number): number {
  const ax = Math.abs(x)
  const ay = Math.abs(y)
  const mx = ax > ay ? ax : ay
  if (mx === 0) return 0
  const a = (ax > ay ? ay : ax) / mx
  const s = a * a
  let r = ((((0.0208351 * s - 0.085133) * s + 0.180141) * s - 0.3302995) * s + 0.999866) * a
  if (ay > ax) r = 1.5707963267948966 - r
  if (x < 0) r = Math.PI - r
  return y < 0 ? -r : r
}

function hypot(a: number, b: number): number {
  return Math.sqrt(a * a + b * b)
}
const HARM = 6

/** A star-shaped piece of an island. Pure data derived from its Island; see the module comment. */
export type Blob = {
  index: number
  island: number
  kind: BlobKind
  seed: number
  /** World centre (for bent blobs, the point on the bend circle at angle t0). */
  x: number
  z: number
  cos: number
  sin: number
  /** Bent blobs (atoll motus) follow a circle of this radius around (bx, bz); 0 for rigid blobs. */
  bend: number
  bx: number
  bz: number
  t0: number
  /** Local anisotropic scale: polar coordinates live in (u / sx, v / sy). */
  sx: number
  sy: number
  /** Mean coast radius in scaled units. */
  R: number
  /** Coast harmonics k = 1..HARM. */
  amp: Float64Array
  phase: Float64Array
  /** cos and sin of the phases (filled on first use). */
  pc: Float64Array
  ps: Float64Array
  peak: number
  beach: number
  shelf: number
  shelfPh: number
  extent: number
  reach: number
  reach2: number
  /** Volcanic: ridge spokes (sorted angles) and signed amplitudes (+ ridge, - gully). */
  spokes: Float64Array
  spokeAmp: Float64Array
  /** Jungle: hills as [u, v, radius, amp] in scaled units. */
  hills: Float64Array
  /** Volcanic: dark sand / lava sector. Cliff: sandy cove. Angle and half width. */
  sector: number
  sectorW: number
  bands: number
  hPhase: number
  treeline: number
  crater: number
  /** Atoll reef: ring width, lagoon depth, pass angles. */
  ring: number
  lagoon: number
  passes: Float64Array
  /**
   * Reef outline (see shelfEdge): world angle the reef tongues trail toward (the swell's downwind side, set per
   * archipelago), tongue length (m) and a second tongue (world angle, length), a sector with almost no shelf
   * (angle in blob polar, half width), harmonic phases, and a reef pass (blob polar angle, < -9 for none).
   */
  wind: number
  /** Upper bound of shelfEdge over all angles (m). */
  edgeMax: number
  /** Per world-angle bin (BOUND_BINS around the centre): distance beyond which the blob is DEEP; empty = use reach. */
  bound: Float32Array
  tongue: number
  tongue2: number
  tongue2Len: number
  steep: number
  steepW: number
  ph2: number
  ph3: number
  pass: number
  /** Bank (shared reef flat / patch reef): half segment (hx, hz) from (x, z), half width, flat depth. */
  hx: number
  hz: number
  halfW: number
  flat: number
  /** Crescent bays: [angle, half width (rad), depth (fraction of R)] triplets. */
  coves: Float64Array
  /** Cliff and stack walls: column count and maximum inward offset (metres). */
  cols: number
  colJ: number
  n: Int32Array
}

function blank(): Blob {
  return {
    index: 0,
    island: 0,
    kind: "cay",
    seed: 0,
    x: 0,
    z: 0,
    cos: 1,
    sin: 0,
    bend: 0,
    bx: 0,
    bz: 0,
    t0: 0,
    sx: 1,
    sy: 1,
    R: 100,
    amp: new Float64Array(HARM),
    phase: new Float64Array(HARM),
    pc: new Float64Array(0),
    ps: new Float64Array(0),
    peak: 4,
    beach: 20,
    shelf: 150,
    shelfPh: 0,
    extent: 100,
    reach: 300,
    reach2: 90000,
    spokes: new Float64Array(0),
    spokeAmp: new Float64Array(0),
    hills: new Float64Array(0),
    sector: 0,
    sectorW: 0,
    bands: 0,
    hPhase: 0,
    treeline: 0,
    crater: 0,
    ring: 0,
    lagoon: 0,
    passes: new Float64Array(0),
    coves: new Float64Array(0),
    wind: 0,
    edgeMax: 0,
    bound: new Float32Array(0),
    tongue: 0,
    tongue2: 0,
    tongue2Len: 0,
    steep: 0,
    steepW: 0,
    ph2: 0,
    ph3: 0,
    pass: -10,
    hx: 0,
    hz: 0,
    halfW: 0,
    flat: 0,
    cols: 0,
    colJ: 0,
    n: new Int32Array(8),
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Polar frame

export type Polar = {
  /** Scaled local coordinates. */
  u: number
  v: number
  r: number
  th: number
  /** Coast radius (scaled units) and |∇F| at the coast, so distance inland d = (C - r) / G in metres. */
  C: number
  G: number
  d: number
}

export function newPolar(): Polar {
  return { u: 0, v: 0, r: 0, th: 0, C: 0, G: 1, d: 0 }
}

/** Coast radius and gradient factor at polar angle th; writes o.C and o.G. */
let shapeC = 0
let shapeCp = 0

/**
 * Normalised coast radius and its angular derivative at th (into shapeC, shapeCp): harmonics minus crescent coves.
 * cs, sn = cos th, sin th; the harmonics use the angle-addition recurrence instead of a cos/sin per term.
 */
function shape(b: Blob, th: number, cs: number, sn: number): void {
  if (b.pc.length === 0) {
    b.pc = Float64Array.from(b.phase, Math.cos)
    b.ps = Float64Array.from(b.phase, Math.sin)
  }
  let c = 1
  let cp = 0
  // cos(kθ), sin(kθ) for k = 1..HARM.
  let ck = cs
  let sk = sn
  for (let k = 0; k < HARM; k++) {
    const a = b.amp[k]!
    if (a !== 0) {
      const pc = b.pc[k]!
      const ps = b.ps[k]!
      c += a * (ck * pc - sk * ps)
      cp -= (k + 1) * a * (sk * pc + ck * ps)
    }
    const nc = ck * cs - sk * sn
    sk = sk * cs + ck * sn
    ck = nc
  }
  const V = b.coves
  for (let k = 0; k < V.length; k += 3) {
    let d = th - V[k]!
    d -= TAU * Math.round(d / TAU)
    const w = V[k + 1]!
    if (d <= -w || d >= w) continue
    const t = d / w
    const u = 1 - t * t
    // Round crescent bay, flattening smoothly into the headlands (the profile and its slope are continuous, so the
    // seaward distance field is too).
    c -= V[k + 2]! * u * u * (3 - 2 * u)
    cp += (V[k + 2]! * 12 * t * u * (1 - u)) / w
  }
  shapeC = c
  shapeCp = cp
}

/** 0..1: how deep inside a cove (bay) angle th is; 0 on headlands and straight coast. */
export function coveAt(b: Blob, th: number): number {
  const V = b.coves
  let m = 0
  for (let k = 0; k < V.length; k += 3) {
    let d = th - V[k]!
    d -= TAU * Math.round(d / TAU)
    const t = d / V[k + 1]!
    if (t > -1 && t < 1) m = Math.max(m, (1 - t * t) * (1 - t * t))
  }
  return m
}

export function coastAt(b: Blob, th: number, o: Polar): void {
  coastAtCS(b, th, Math.cos(th), Math.sin(th), o)
}

function coastAtCS(b: Blob, th: number, cs: number, sn: number, o: Polar): void {
  shape(b, th, cs, sn)
  const C = b.R * shapeC
  const Cp = b.R * shapeCp
  const du = (-Cp * sn) / C - cs
  const dv = (Cp * cs) / C - sn
  o.C = C
  o.G = hypot(du / b.sx, dv / b.sy)
}

export function blobPolar(b: Blob, x: number, z: number, o: Polar): Polar {
  let u: number
  let v: number
  if (b.bend > 0) {
    const dx = x - b.bx
    const dz = z - b.bz
    let a = atan2(dz, dx) - b.t0
    a -= TAU * Math.round(a / TAU)
    u = a * b.bend
    v = hypot(dx, dz) - b.bend
  } else {
    const dx = x - b.x
    const dz = z - b.z
    u = dx * b.cos + dz * b.sin
    v = -dx * b.sin + dz * b.cos
  }
  const up = u / b.sx
  const vp = v / b.sy
  o.u = up
  o.v = vp
  const r = Math.sqrt(up * up + vp * vp)
  o.r = r
  o.th = atan2(vp, up)
  const cs = r > 0 ? up / r : 1
  const sn = r > 0 ? vp / r : 0
  coastAtCS(b, o.th, cs, sn, o)
  // Seaward, use the gradient of r - C(θ) at the point itself (it tends to 1 far out) so distances stay true.
  // coastAt left C'(θ) in shapeCp.
  if (o.r > o.C) {
    const Cp = b.R * shapeCp
    o.G = hypot(((-Cp * sn) / o.r - cs) / b.sx, ((Cp * cs) / o.r - sn) / b.sy)
  }
  o.d = (o.C - o.r) / o.G
  return o
}

/** |∇(r - C(θ))| in metres at polar (th, r), scaled units. */
export function gradAt(b: Blob, th: number, r: number): number {
  const cs = Math.cos(th)
  const sn = Math.sin(th)
  shape(b, th, cs, sn)
  const Cp = b.R * shapeCp
  const du = (-Cp * sn) / r - cs
  const dv = (Cp * cs) / r - sn
  return hypot(du / b.sx, dv / b.sy)
}

/** Scaled radius at angle th that lies s metres seaward of the coast (inverse of blobPolar's distance). */
export function seawardRadius(b: Blob, th: number, s: number, o: Polar): number {
  coastAt(b, th, o)
  let r = o.C + s * o.G
  for (let i = 0; i < 4; i++) r = o.C + s * gradAt(b, th, r)
  return r
}

/** World position of scaled local coordinates (up, vp). */
export function blobWorld(b: Blob, up: number, vp: number, out: number[]): number[] {
  const u = up * b.sx
  const v = vp * b.sy
  if (b.bend > 0) {
    const a = b.t0 + u / b.bend
    const R = b.bend + v
    out[0] = b.bx + R * Math.cos(a)
    out[1] = b.bz + R * Math.sin(a)
  } else {
    out[0] = b.x + u * b.cos - v * b.sin
    out[1] = b.z + u * b.sin + v * b.cos
  }
  return out
}

function angDist(a: number, b: number): number {
  let d = a - b
  d -= TAU * Math.round(d / TAU)
  return Math.abs(d)
}

/** 0..1 weight of the blob's special sector (volcanic lava side, cliff cove) at angle th. */
export function sectorAt(b: Blob, th: number): number {
  if (b.sectorW <= 0) return 0
  return ss(b.sectorW, b.sectorW * 0.45, angDist(th, b.sector))
}

// ---------------------------------------------------------------------------------------------------------------------
// Profiles

/** Index of the first wall stop (cliff and stack strata), for colouring and column jitter. */
export const WALL_FROM = 2

/**
 * Coastal profile at angle th: distances inland D[k] (D[0] = 0 at the waterline) and heights H[k], piecewise linear.
 * The last stop is where the interior (ρ = 1) begins. Returns the number of stops.
 */
export function coastStops(b: Blob, th: number, D: Float64Array, H: Float64Array): number {
  D[0] = 0
  H[0] = 0
  switch (b.kind) {
    case "cay": {
      const B = b.beach * (0.85 + 0.3 * (0.5 + 0.5 * Math.cos(2 * th + b.hPhase)))
      D[1] = Math.min(4, B * 0.3)
      H[1] = 0.4
      D[2] = B
      H[2] = 1.5
      return 3
    }
    case "jungle":
    case "volcanic": {
      // A wide, nearly flat sand terrace (wider in the bays) up to the forest edge.
      const B = b.beach * (0.85 + 0.3 * (0.5 + 0.5 * Math.cos(3 * th + b.hPhase))) * (b.coves.length ? 0.75 + 0.6 * coveAt(b, th) : 1)
      D[1] = 5
      H[1] = 0.7
      D[2] = B
      H[2] = 2.4
      D[3] = B + 10
      H[3] = 6
      return 4
    }
    case "cliff":
    case "stack": {
      const cliff = b.kind === "cliff"
      const cove = cliff ? sectorAt(b, th) : 0
      const top = b.peak * (cliff ? 0.86 + 0.14 * Math.cos(th - b.hPhase) : 0.9 + 0.1 * Math.cos(th - b.hPhase))
      let d = cliff ? 3 + 50 * cove : 1.2
      let h = cliff ? 1.1 + 0.6 * cove : 1.3
      D[1] = d
      H[1] = h
      const n = b.bands
      // Stacks taper: their ledges eat about half the radius by the top.
      const ledge = cliff ? 3.2 + 2 * cove : Math.max(0.6, (0.42 * minRadius(b) - b.colJ) / n)
      const step = (top - h) / n
      let k = 2
      for (let i = 0; i < n; i++) {
        // Lower bands are taller, as in the concepts' strata.
        const frac = n === 1 ? 1 : (1.3 - (0.6 * i) / (n - 1)) / n
        const jit = columnJitter(b, th, i)
        d += 0.35
        h += (top - H[1]!) * frac * 0.96
        D[k] = d + jit
        H[k++] = h
        d += ledge
        h += (top - H[1]!) * frac * 0.04
        D[k] = d + jit
        H[k++] = h
      }
      H[k - 1] = top
      void step
      return k
    }
    case "reef":
    case "bank":
      return 1
  }
}

/** Number of wall columns around a cliff or stack blob (the mesh puts its vertices exactly on them). */
export function wallColumns(b: Blob): number {
  const perim = TAU * b.R * ((b.sx + b.sy) / 2)
  return b.kind === "stack" ? Math.max(6, Math.min(8, Math.round(perim / 14))) : Math.max(16, Math.round(perim / 14))
}

/** Inward offset of the wall at angle th: random per column, linear between columns, so faces read as vertical facets. */
function columnJitter(b: Blob, th: number, band: number): number {
  const N = b.cols
  const f = ((th + Math.PI) / TAU) * N
  const i0 = Math.floor(f)
  const t = f - i0
  const s = b.seed + band * 7919
  const a = hash3(((i0 % N) + N) % N, s, 0x7a3)
  const c = hash3((((i0 + 1) % N) + N) % N, s, 0x7a3)
  return (a + (c - a) * t) * b.colJ
}

/** Mean reef shelf width at blob polar angle th, before the world-space edge noise. */
export function shelfWidth(b: Blob, th: number): number {
  const f = 1 + 0.38 * Math.cos(2 * th + b.shelfPh) + 0.22 * Math.cos(3 * th + b.ph2) + 0.12 * Math.cos(5 * th + b.ph3)
  const steep = b.steepW > 0 ? 1 - 0.88 * ss(b.steepW, b.steepW * 0.4, angDist(th, b.steep)) : 1
  return Math.max(10, b.shelf * f * steep)
}

/**
 * Distance (m) from the waterline to the reef edge at (x, z), angle th: the mean width, long tongues trailing
 * downwind, lobes and scallops at a few scales, and spur-and-groove fingers along the edge. `s` is the point's own
 * distance from the waterline (the fingers are elongated across the edge).
 */
export function shelfEdge(b: Blob, th: number, x: number, z: number, s: number): number {
  let W = shelfWidth(b, th)
  const wa = atan2(z - b.z, x - b.x)
  if (b.tongue > 0) {
    const c = Math.cos(wa - b.wind)
    if (c > 0) W += b.tongue * Math.pow(c, 7)
  }
  if (b.tongue2Len > 0) {
    const c = Math.cos(wa - b.tongue2)
    if (c > 0) W += b.tongue2Len * Math.pow(c, 11)
  }
  const S = b.n
  // Lobes (a few hundred metres) and scallops (tens of metres), in world space so neighbours agree in style.
  W += W * 0.28 * noise2(S[2]! + 17, x / 260, z / 260) + 16 * noise2(S[2]! + 23, x / 75, z / 75)
  // Spur-and-groove: fingers ~25 m apart, stretched across the edge, only near it.
  // (They fade back out down the slope, so the deep contours stay smooth and the skip below is continuous.)
  if (s > W * 0.6 && s < W + 60) {
    const along = th * (Math.max(b.R, 40) + s)
    W += 13 * noise2(S[2]! + 31, along / 22, s / 140) * ss(W * 0.6, W * 0.95, s) * (1 - ss(W + 20, W + 60, s))
  }
  return Math.max(8, W)
}

/** 0..1 inside a reef pass at blob polar angle th (a narrow channel cut through the shelf). */
function passCut(b: Blob, th: number, x: number, z: number, s: number): number {
  if (b.pass < -9) return 0
  // A channel of roughly constant width (metres), wandering a little.
  const lateral = angDist(th, b.pass) * (b.R + s) + 8 * noise2(b.n[2]! + 41, x / 60, z / 60)
  return ss(26, 14, lateral)
}

/** Seaward profile at s metres from the waterline at (x, z): shallow reef shelf, a clear edge, then the drop to DEEP. */
export function seaHeight(b: Blob, s: number, th: number, x: number, z: number): number {
  // Atoll motus sit on the reef flat, which carries the shelf and the drop; theirs just dives under it.
  if (b.bend > 0) return -1.2 * ss(0, 14, s) - 58.8 * ss(14, 50, s)
  // Cheap bound first: most samples in a blob's reach are deep water past any possible edge.
  if (s > b.edgeMax + 185) return DEEP
  const W = shelfEdge(b, th, x, z, s)
  let h: number
  if (b.kind === "stack") {
    h = -2.2 * ss(0, 8, s) - 3 * ss(8, W, s) - 10.8 * ss(W - 6, W + 30, s) - 44 * ss(W + 15, W + 150, s)
  } else if (b.kind === "cliff") {
    h = -2.6 * ss(0, 9, s) - 3.2 * ss(8, W, s) - 10.2 * ss(W - 10, W + 40, s) - 44 * ss(W + 20, W + 170, s)
  } else {
    const n = Math.min(18, W * 0.3)
    h = -1.2 * ss(0, n, s) - 1.3 * ss(n * 0.8, W * 0.55, s) - 2 * ss(W * 0.5, W, s) - 11.5 * ss(W - 10, W + 40, s) - 44 * ss(W + 20, W + 180, s)
  }
  const p = passCut(b, th, x, z, s)
  if (p > 0 && s > 12) h = Math.min(h, h + (-9 - h) * p * ss(12, 30, s))
  return h
}

/** Ridge offset of a volcanic blob at angle th: piecewise linear between spokes. */
function ridgeAt(b: Blob, th: number): number {
  const S = b.spokes
  const n = S.length
  if (n === 0) return 0
  let t = th < 0 ? th + TAU : th
  let i = n - 1
  for (let k = 0; k < n; k++) {
    if (S[k]! > t) {
      i = k - 1
      break
    }
  }
  if (i < 0) i = n - 1
  const a0 = S[i]!
  let a1 = S[(i + 1) % n]!
  if (a1 <= a0) a1 += TAU
  if (t < a0) t += TAU
  const f = (t - a0) / (a1 - a0)
  return b.spokeAmp[i]! + (b.spokeAmp[(i + 1) % n]! - b.spokeAmp[i]!) * f
}

/** Normalised radius where a volcano's cone meets its lowlands. */
export const CONE = 0.84

/** Interior height at normalised radius rho (1 at the end of the coastal stops, 0 at the centre). */
export function interiorHeight(b: Blob, rho: number, th: number, up: number, vp: number, hRim: number): number {
  switch (b.kind) {
    case "cay":
      return hRim + (b.peak - hRim) * (1 - rho * rho)
    case "jungle": {
      const ramp = ss(1, 0.8, rho)
      let hill = 0.08 * (1 - rho)
      const H = b.hills
      for (let k = 0; k < H.length; k += 4) {
        const t = 1 - hypot(up - H[k]!, vp - H[k + 1]!) / H[k + 2]!
        // Rounded peak: steep flanks, round top; neighbouring peaks meet in a saddle.
        if (t > 0) hill = Math.max(hill, H[k + 3]! * t * t * (3 - 2 * t))
      }
      const tex = 0.1 * (ridged(b.n[3]!, up / (b.R * 0.35), vp / (b.R * 0.35), 2) - 0.45)
      return hRim + (b.peak - hRim) * Math.min(1, Math.max(0, hill + tex)) * ramp
    }
    case "volcanic": {
      // Jungle lowlands rising gently to the cone's foot at rho = CONE, then a straight ridged cone to the crater.
      const rc = b.crater
      const foot = b.peak * 0.08
      if (rho <= rc) return b.peak - b.peak * 0.07 * Math.pow(1 - rho / rc, 0.8)
      if (rho >= CONE) return hRim + (foot - hRim) * ss(1, CONE, rho)
      const q = (CONE - rho) / (CONE - rc)
      const rid = ridgeAt(b, th) * 0.12 * b.peak * Math.pow(Math.sin(Math.PI * Math.min(1, q * 1.05)), 0.8)
      // Concave profile, steepening toward the summit: the classic cone.
      return foot + (b.peak - foot) * Math.pow(q, 1.7) + rid
    }
    case "cliff": {
      // Blend from the rim (whose height varies around the island) to a common centre so the plateau has no seam.
      const t = 1 - rho
      return hRim + (b.peak * 0.9 - hRim) * t + b.peak * 0.1 * (1 - rho * rho) + b.peak * 0.06 * noise2(b.n[3]!, up / 90, vp / 90) * t
    }
    case "stack":
      // Rounded crown.
      return hRim + b.R * 0.35 * Math.sqrt(Math.max(0, 1 - rho * rho))
    case "reef":
    case "bank":
      return DEEP
  }
}

function reefHeight(b: Blob, x: number, z: number, o: Polar): number {
  blobPolar(b, x, z, o)
  const s = -o.d
  const pass = passAt(b, o.th)
  if (s >= 0) {
    // Irregular outer edge: lobes, scallops, spur-and-groove, and a reef tongue trailing downwind.
    const e = reefOuter(b, o.th, x, z, s)
    const h = -0.7 - 1.8 * ss(e, e + 25, s) - 11.5 * ss(e + 15, e + 70, s) - 46 * ss(e + 50, e + 220, s)
    return pass > 0 ? Math.min(h, h + (-6 - h) * pass) : h
  }
  const w = b.ring * (0.8 + 0.4 * (0.5 + 0.5 * Math.cos(2 * o.th + b.shelfPh)))
  const t = -s - w
  let h: number
  if (t <= 0) h = -0.75 + 0.25 * noise2(b.n[0]!, x / 45, z / 45)
  else h = -0.75 - (b.lagoon - 0.75) * ss(0, 80, t) + 1.8 * Math.max(0, fbm(b.n[1]!, x / 120, z / 120, 2)) * ss(30, 110, t)
  if (pass > 0 && t < 40) h = Math.min(h, h + (-4.5 - h) * pass)
  return h
}

/** Extra reef flat (m) beyond an atoll's rim at angle th: varies from none to long spurs. */
function reefOuter(b: Blob, th: number, x: number, z: number, s: number): number {
  const wa = atan2(z - b.z, x - b.x)
  let e = 70 * (0.5 + 0.5 * Math.cos(3 * th + b.ph2)) * (0.5 + 0.5 * Math.cos(2 * th + b.ph3)) + 45 * noise2(b.n[2]! + 17, x / 240, z / 240) + 16 * noise2(b.n[2]! + 23, x / 70, z / 70)
  const c = Math.cos(wa - b.wind)
  if (c > 0) e += b.tongue * Math.pow(c, 7)
  e += 10 * noise2(b.n[2]! + 31, (th * (b.R + s)) / 22, s / 140) * ss(e - 20, e, s)
  return Math.max(0, e)
}

/** Signed distance (m) from (x, z) to a bank's noisy outline (negative inside), and the position along it in [-1, 1]. */
let bankAlong = 0
function bankDist(b: Blob, x: number, z: number): number {
  const dx = x - b.x
  const dz = z - b.z
  const l2 = b.hx * b.hx + b.hz * b.hz
  const t = l2 > 0 ? Math.max(-1, Math.min(1, (dx * b.hx + dz * b.hz) / l2)) : 0
  bankAlong = t
  const d = hypot(dx - b.hx * t, dz - b.hz * t)
  const S = b.n
  // Width tapers to the ends and wanders; gaps open where a slow noise along the bank dips.
  let w = b.halfW * (0.55 + 0.45 * Math.sqrt(Math.max(0, 1 - t * t)))
  w *= 1 + 0.6 * noise2(S[2]! + 17, x / 170, z / 170)
  w += 16 * noise2(S[2]! + 23, x / 60, z / 60)
  // Gaps open and close over a long stretch so their edges stay as gentle as the bar's own.
  if (l2 > 0) w *= ss(-0.45, 0.15, noise2(S[2]! + 29, (t * Math.sqrt(l2)) / 260, 0.5))
  w = Math.max(0, w)
  // Where the bar pinches out (gaps), its crest sinks too, so no thin line is left on the seabed.
  return d - w + Math.max(0, 22 - w) * 1.6
}

/** Shared reef flats between neighbours and patch reefs in open water: shallow flat, a clear edge, the drop. */
function bankHeight(b: Blob, x: number, z: number): number {
  const dx = x - b.x
  const dz = z - b.z
  if (dx * dx + dz * dz >= b.reach2) return DEEP
  const e = bankDist(b, x, z)
  if (e > 180) return DEEP
  const flat = b.flat + (e < 0 ? 0.8 * noise2(b.n[0]!, x / 60, z / 60) : 0)
  return Math.min(-0.6, flat) - (11.5 + flat) * ss(-10, 35, e) - 46 * ss(25, 180, e)
}

function passAt(b: Blob, th: number): number {
  let p = 0
  for (let k = 0; k < b.passes.length; k++) p = Math.max(p, ss(32, 16, angDist(th, b.passes[k]!) * b.R))
  return p
}

const SD = new Float64Array(32)
const SH = new Float64Array(32)

/** Height of one blob at (x, z); DEEP outside its reach. */
export function blobHeight(b: Blob, x: number, z: number, o: Polar): number {
  const dx = x - b.x
  const dz = z - b.z
  if (dx * dx + dz * dz >= b.reach2) return DEEP
  if (b.kind === "reef") return reefHeight(b, x, z, o)
  if (b.kind === "bank") return bankHeight(b, x, z)
  if (b.bound.length) {
    let k = Math.floor(((atan2(dz, dx) + Math.PI) / TAU) * BOUND_BINS)
    if (k >= BOUND_BINS) k = 0
    const lim = b.bound[k]!
    if (dx * dx + dz * dz > lim * lim) return DEEP
  }
  blobPolar(b, x, z, o)
  if (o.d < 0) return seaHeight(b, -o.d, o.th, x, z)
  const n = coastStops(b, o.th, SD, SH)
  const din = SD[n - 1]!
  if (o.d < din) {
    let k = 1
    while (SD[k]! < o.d) k++
    const f = (o.d - SD[k - 1]!) / (SD[k]! - SD[k - 1]!)
    return SH[k - 1]! + (SH[k]! - SH[k - 1]!) * f
  }
  const rin = o.C - din * o.G
  const rho = Math.min(1, o.r / rin)
  return interiorHeight(b, rho, o.th, o.u, o.v, SH[n - 1]!)
}

// ---------------------------------------------------------------------------------------------------------------------
// Coral

/**
 * Coral clumps like the concepts: on a 44 m lattice, cells picked by a slow cluster noise hold a clump of 3-6 round
 * heads (5-10 m) packed around a centre, so they read as lobed, cauliflower-like patches. 0..1.
 */
// Memo of per-cell clump decisions and head offsets (pure function of cell and seed; skips recomputing noise and trig per texel).
const DOT_N = 4096
const dotKey = new Int32Array(DOT_N * 3).fill(0x7fffffff)
const dotVal = new Float64Array(DOT_N * 22)

/** Clump of cell (cx, cz): writes [present, px, pz, heads, hx0, hz0, r0, ...] into dotVal at slot*22; returns the offset. */
function dotCell(seed: number, cx: number, cz: number, cell: number): number {
  const slot = ((Math.imul(cx, 73856093) ^ Math.imul(cz, 19349663) ^ Math.imul(seed, 83492791)) >>> 0) % DOT_N
  const k = slot * 3
  const o = slot * 22
  if (dotKey[k] === cx && dotKey[k + 1] === cz && dotKey[k + 2] === seed) return o
  dotKey[k] = cx
  dotKey[k + 1] = cz
  dotKey[k + 2] = seed
  const cl = noise2(seed + 3, (cx * cell) / 230, (cz * cell) / 230) + 0.4 * noise2(seed + 4, (cx * cell) / 90, (cz * cell) / 90)
  const present = hash3(cx, cz, seed) > 0.95 * ss(-0.5, 0.15, cl) ? 0 : 1
  dotVal[o] = present
  if (!present) return o
  dotVal[o + 1] = (cx + 0.25 + 0.5 * hash3(cx, cz, seed + 1)) * cell
  dotVal[o + 2] = (cz + 0.25 + 0.5 * hash3(cx, cz, seed + 2)) * cell
  const heads = 3 + Math.floor(hash3(cx, cz, seed + 5) * 4)
  dotVal[o + 3] = heads
  const a0 = hash3(cx, cz, seed + 6) * TAU
  for (let h = 0; h < heads; h++) {
    const rad = 8 + 6 * hash3(cx * 7 + h, cz, seed + 7)
    const off = h === 0 ? 0 : 8 + 10 * hash3(cx, cz * 7 + h, seed + 8)
    const a = a0 + h * 2.4
    const ho = o + 4 + h * 3
    dotVal[ho] = Math.cos(a) * off
    dotVal[ho + 1] = Math.sin(a) * off
    dotVal[ho + 2] = rad
  }
  return o
}

function dots(seed: number, x: number, z: number): number {
  const cell = 64
  const gx = Math.floor(x / cell)
  const gz = Math.floor(z / cell)
  let m = 0
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const cx = gx + i
      const cz = gz + j
      const o = dotCell(seed, cx, cz, cell)
      if (dotVal[o] === 0) continue
      const dx0 = x - dotVal[o + 1]!
      const dz0 = z - dotVal[o + 2]!
      if (dx0 * dx0 + dz0 * dz0 > 46 * 46) continue
      const end = o + 4 + dotVal[o + 3]! * 3
      for (let ho = o + 4; ho < end; ho += 3) {
        const hdx = dx0 - dotVal[ho]!
        const hdz = dz0 - dotVal[ho + 1]!
        const rad = dotVal[ho + 2]!
        const d2 = hdx * hdx + hdz * hdz
        if (d2 < rad * rad) m = Math.max(m, ss(rad, rad - 2.5, Math.sqrt(d2)))
      }
    }
  }
  return m
}

/** Stamps one blob's seabed height and coral into grid arrays over its local bounding box, skipping open-ocean texels. */
export function stampBlobSeabed(
  b: Blob,
  x0: number,
  z0: number,
  texel: number,
  res: number,
  heights: Float32Array,
  land: Uint8Array,
  water: Uint8Array,
  coral: Uint8Array,
  o: Polar,
): void {
  const reach = b.reach
  const i0 = Math.max(0, Math.floor((b.x - reach - x0) / texel - 0.5) + 1)
  const i1 = Math.min(res - 1, Math.ceil((b.x + reach - x0) / texel - 0.5) - 1)
  const j0 = Math.max(0, Math.floor((b.z - reach - z0) / texel - 0.5) + 1)
  const j1 = Math.min(res - 1, Math.ceil((b.z + reach - z0) / texel - 0.5) - 1)
  const hasBound = b.bound.length > 0
  const isBank = b.kind === "bank"
  const isReef = b.kind === "reef"

  for (let j = j0; j <= j1; j++) {
    const z = z0 + (j + 0.5) * texel
    const dz = z - b.z
    const dz2 = dz * dz
    const maxDx2 = b.reach2 - dz2
    if (maxDx2 <= 0) continue
    const maxDx = Math.sqrt(maxDx2)
    const rowI0 = Math.max(i0, Math.floor((b.x - maxDx - x0) / texel - 0.5) + 1)
    const rowI1 = Math.min(i1, Math.ceil((b.x + maxDx - x0) / texel - 0.5) - 1)
    const rowOff = j * res

    for (let i = rowI0; i <= rowI1; i++) {
      const k = rowOff + i
      if (land[k] === 1) continue
      const x = x0 + (i + 0.5) * texel
      const dx = x - b.x
      const r2 = dx * dx + dz2
      if (r2 >= b.reach2) continue

      if (isBank) {
        const l2 = b.hx * b.hx + b.hz * b.hz
        const t = l2 > 0 ? Math.max(-1, Math.min(1, (dx * b.hx + dz * b.hz) / l2)) : 0
        const d = hypot(dx - b.hx * t, dz - b.hz * t)
        const wBase = b.halfW * (0.55 + 0.45 * Math.sqrt(Math.max(0, 1 - t * t)))
        if (d - (wBase * 1.6 + 16) > 180) continue
        const S = b.n
        let w = wBase * (1 + 0.6 * noise2(S[2]! + 17, x / 170, z / 170)) + 16 * noise2(S[2]! + 23, x / 60, z / 60)
        if (l2 > 0) w *= ss(-0.45, 0.15, noise2(S[2]! + 29, (t * Math.sqrt(l2)) / 260, 0.5))
        w = Math.max(0, w)
        const e = d - w + Math.max(0, 22 - w) * 1.6
        if (e <= 180) {
          const flat = b.flat + (e < 0 ? 0.8 * noise2(b.n[0]!, x / 60, z / 60) : 0)
          const h = Math.min(-0.6, flat) - (11.5 + flat) * ss(-10, 35, e) - 46 * ss(25, 180, e)
          if (h > heights[k]!) heights[k] = h
          if (e <= 0) {
            const cVal = Math.round(dots(b.n[5]!, x, z) * ss(0, 0.4, ss(-6, -30, e)) * 255)
            if (cVal > coral[k]!) coral[k] = cVal
          }
        }
        continue
      }

      if (isReef) {
        blobPolar(b, x, z, o)
        const s = -o.d
        let h: number
        if (s >= 0) {
          const wa = atan2(dz, dx)
          let e0 = 70 * (0.5 + 0.5 * Math.cos(3 * o.th + b.ph2)) * (0.5 + 0.5 * Math.cos(2 * o.th + b.ph3))
          const c = Math.cos(wa - b.wind)
          if (c > 0) e0 += b.tongue * Math.pow(c, 7)
          if (s > e0 + 291) continue
          let e = e0 + 45 * noise2(b.n[2]! + 17, x / 240, z / 240) + 16 * noise2(b.n[2]! + 23, x / 70, z / 70)
          e += 10 * noise2(b.n[2]! + 31, (o.th * (b.R + s)) / 22, s / 140) * ss(e - 20, e, s)
          e = Math.max(0, e)
          h = -0.7 - 1.8 * ss(e, e + 25, s) - 11.5 * ss(e + 15, e + 70, s) - 46 * ss(e + 50, e + 220, s)
          if (h > -6) {
            const pass = passAt(b, o.th)
            if (pass > 0) h = Math.min(h, h + (-6 - h) * pass)
          }
        } else {
          const w = b.ring * (0.8 + 0.4 * (0.5 + 0.5 * Math.cos(2 * o.th + b.shelfPh)))
          const t = -s - w
          if (t <= 0) h = -0.75 + 0.25 * noise2(b.n[0]!, x / 45, z / 45)
          else h = -0.75 - (b.lagoon - 0.75) * ss(0, 80, t) + 1.8 * Math.max(0, fbm(b.n[1]!, x / 120, z / 120, 2)) * ss(30, 110, t)
          if (t < 40 && h > -4.5) {
            const pass = passAt(b, o.th)
            if (pass > 0) h = Math.min(h, h + (-4.5 - h) * pass)
          }
          const zone = Math.max(ss(w + 15, w + 45, -s), 0.5 * ss(w * 0.2, w * 0.5, -s) * (1 - ss(w * 0.7, w, -s)))
          if (zone >= 0.2) {
            const cVal = Math.round(dots(b.n[5]!, x, z) * ss(0.2, 0.5, zone) * 255)
            if (cVal > coral[k]!) coral[k] = cVal
          }
        }
        if (h > heights[k]!) heights[k] = h
        continue
      }

      if (hasBound) {
        let bin = Math.floor(((atan2(dz, dx) + Math.PI) / TAU) * BOUND_BINS)
        if (bin >= BOUND_BINS) bin = 0
        const lim = b.bound[bin]!
        if (r2 > lim * lim) continue
      }

      if (b.bend > 0) {
        const rRing = hypot(x - b.bx, z - b.bz) - b.bend
        if (Math.abs(rRing) > b.R * 1.45 + 65) continue
      }

      blobPolar(b, x, z, o)
      if (o.d >= 0) {
        if (o.d > 0) {
          heights[k] = 1
          land[k] = 1
          water[k] = 0
        } else if (0 > heights[k]!) {
          heights[k] = 0
        }
        continue
      }

      const s = -o.d
      if (b.bend > 0) {
        if (s < 50) {
          const h = -1.2 * ss(0, 14, s) - 58.8 * ss(14, 50, s)
          if (h > heights[k]!) heights[k] = h
        }
        if (s < 42) {
          const W = shelfEdge(b, o.th, x, z, s)
          const inner = ss(W * 0.22, W * 0.45, s)
          const zone = inner * (1 - ss(W * 0.86, W * 1.0, s))
          if (zone >= 0.2) {
            const cVal = Math.round(dots(b.n[5]!, x, z) * ss(0.2, 0.5, zone) * 255)
            if (cVal > coral[k]!) coral[k] = cVal
          }
        }
        continue
      }

      if (s > b.edgeMax + 185) continue
      let W0 = shelfWidth(b, o.th)
      const wa = atan2(dz, dx)
      if (b.tongue > 0) {
        const c = Math.cos(wa - b.wind)
        if (c > 0) W0 += b.tongue * Math.pow(c, 7)
      }
      if (b.tongue2Len > 0) {
        const c = Math.cos(wa - b.tongue2)
        if (c > 0) W0 += b.tongue2Len * Math.pow(c, 11)
      }
      if (s > W0 * 1.28 + 209) continue

      const S = b.n
      let W = W0 + W0 * 0.28 * noise2(S[2]! + 17, x / 260, z / 260) + 16 * noise2(S[2]! + 23, x / 75, z / 75)
      if (s > W * 0.6 && s < W + 60) {
        const along = o.th * (Math.max(b.R, 40) + s)
        W += 13 * noise2(S[2]! + 31, along / 22, s / 140) * ss(W * 0.6, W * 0.95, s) * (1 - ss(W + 20, W + 60, s))
      }
      W = Math.max(8, W)

      let h: number
      if (b.kind === "stack") {
        h = -2.2 * ss(0, 8, s) - 3 * ss(8, W, s) - 10.8 * ss(W - 6, W + 30, s) - 44 * ss(W + 15, W + 150, s)
      } else if (b.kind === "cliff") {
        h = -2.6 * ss(0, 9, s) - 3.2 * ss(8, W, s) - 10.2 * ss(W - 10, W + 40, s) - 44 * ss(W + 20, W + 170, s)
      } else {
        const nw = Math.min(18, W * 0.3)
        h = -1.2 * ss(0, nw, s) - 1.3 * ss(nw * 0.8, W * 0.55, s) - 2 * ss(W * 0.5, W, s) - 11.5 * ss(W - 10, W + 40, s) - 44 * ss(W + 20, W + 180, s)
      }
      if (b.pass >= -9 && s > 12 && h > -9) {
        const p = passCut(b, o.th, x, z, s)
        if (p > 0) h = Math.min(h, h + (-9 - h) * p * ss(12, 30, s))
      }
      if (h > heights[k]!) heights[k] = h

      if (s < W) {
        const inner = b.kind === "cliff" || b.kind === "stack" ? ss(12, 30, s) : ss(W * 0.22, W * 0.45, s)
        const zone = inner * (1 - ss(W * 0.86, W * 1.0, s))
        if (zone >= 0.2) {
          const cVal = Math.round(dots(b.n[5]!, x, z) * ss(0.2, 0.5, zone) * 255)
          if (cVal > coral[k]!) coral[k] = cVal
        }
      }
    }
  }
}

function blobCoral(b: Blob, x: number, z: number, o: Polar): number {
  const dx = x - b.x
  const dz = z - b.z
  if (dx * dx + dz * dz >= b.reach2) return 0
  if (b.kind === "bank") {
    const e = bankDist(b, x, z)
    if (e > 0) return 0
    return dots(b.n[5]!, x, z) * ss(0, 0.4, ss(-6, -30, e))
  }
  blobPolar(b, x, z, o)
  const s = -o.d
  let zone: number
  if (b.kind === "reef") {
    const w = b.ring * (0.8 + 0.4 * (0.5 + 0.5 * Math.cos(2 * o.th + b.shelfPh)))
    zone = s < 0 ? Math.max(ss(w + 15, w + 45, -s), 0.5 * ss(w * 0.2, w * 0.5, -s) * (1 - ss(w * 0.7, w, -s))) : 0
  } else {
    if (s <= 0) return 0
    const W = shelfEdge(b, o.th, x, z, s)
    // Clustered on the middle and outer shelf, thinning toward the beach.
    const inner = b.kind === "cliff" || b.kind === "stack" ? ss(12, 30, s) : ss(W * 0.22, W * 0.45, s)
    zone = inner * (1 - ss(W * 0.86, W * 1.0, s))
  }
  if (zone < 0.2) return 0
  return dots(b.n[5]!, x, z) * ss(0.2, 0.5, zone)
}

// ---------------------------------------------------------------------------------------------------------------------
// Islands → blobs

function harmonics(b: Blob, rng: Rng, scale: number): void {
  const base = [0.02, 0.09, 0.07, 0.045, 0.03, 0.02]
  for (let k = 0; k < HARM; k++) {
    b.amp[k] = base[k]! * scale * rng.range(0.3, 1)
    b.phase[k] = rng.range(0, TAU)
  }
}

/**
 * Reef outline parameters, from the blob's seed on their own stream (so they don't shift the shapes): tongues trailing
 * downwind (the direction is set per archipelago in buildIndex), an occasional second tongue, a steep side with almost
 * no shelf, and passes through jungle bays.
 */
function reefShape(b: Blob): void {
  const r = new Rng(b.seed ^ 0x3c6ef372)
  b.ph2 = r.range(0, TAU)
  b.ph3 = r.range(0, TAU)
  const big = b.kind === "jungle" || b.kind === "volcanic" || b.kind === "reef"
  b.tongue = b.kind === "stack" || b.bend > 0 ? 0 : (big ? r.range(0.6, 1.2) : r.range(0.5, 1.1)) * (b.kind === "reef" ? 200 : b.shelf)
  if (r.next() < 0.45 && b.kind !== "reef" && b.bend === 0) {
    b.tongue2 = r.range(0, TAU)
    b.tongue2Len = r.range(0.5, 1.2) * b.shelf
  }
  if (b.kind === "jungle" || b.kind === "volcanic" || b.kind === "cliff") {
    b.steep = r.range(0, TAU)
    b.steepW = b.kind === "cliff" ? r.range(1, 1.8) : r.range(0.5, 1.1)
  }
  // Jungle bays: a pass through the reef in front of the main bay.
  if (b.kind === "jungle" && b.coves.length && r.next() < 0.7) b.pass = b.coves[0]!
  else if ((b.kind === "cay" || b.kind === "volcanic") && b.bend === 0 && r.next() < 0.25) b.pass = r.range(0, TAU)
}

/** Adds n crescent bays spaced around the coast; the headlands are where neighbouring bays meet. */
function addCoves(b: Blob, rng: Rng, n: number, depth: [number, number]): void {
  const v: number[] = []
  const a0 = rng.range(0, TAU)
  for (let k = 0; k < n; k++) {
    const a = a0 + ((k + rng.range(-0.18, 0.18)) / n) * TAU
    const w = (TAU / n) * rng.range(0.42, 0.52)
    v.push(a - TAU * Math.floor(a / TAU), w, rng.range(depth[0], depth[1]))
  }
  b.coves = Float64Array.from(v)
}

function finish(b: Blob, drop: number): Blob {
  let maxC = 0
  let minC = Infinity
  const o = newPolar()
  for (let i = 0; i < 64; i++) {
    coastAt(b, (i / 64) * TAU, o)
    maxC = Math.max(maxC, o.C)
    minC = Math.min(minC, o.C)
  }
  b.extent = maxC * Math.max(b.sx, b.sy)
  reefShape(b)
  let wMax = 0
  for (let i = 0; i < 64; i++) wMax = Math.max(wMax, shelfWidth(b, (i / 64) * TAU))
  b.edgeMax = (wMax + Math.max(b.tongue, b.tongue2Len)) * 1.3 + 29
  const shelf = b.kind === "reef" ? b.tongue + 80 : b.bend > 0 ? 0 : b.edgeMax
  // Seaward distances are measured in the scaled frame, which shrinks world distances by up to max(sx, sy).
  b.reach = b.extent + (shelf + drop) * Math.max(1, b.sx, b.sy) + 10
  b.reach2 = b.reach * b.reach
  return b
}

function seeds(b: Blob, rng: Rng): void {
  for (let i = 0; i < b.n.length; i++) b.n[i] = rng.seed() | 0
}

function rigid(b: Blob, x: number, z: number, rot: number, aspect: number): void {
  b.x = x
  b.z = z
  b.cos = Math.cos(rot)
  b.sin = Math.sin(rot)
  b.sx = Math.sqrt(aspect)
  b.sy = 1 / Math.sqrt(aspect)
}

/** Scaled-unit radius such that the beach and coastal stops fit inside the narrowest part. */
function minRadius(b: Blob): number {
  let s = 0
  for (let k = 0; k < HARM; k++) s += b.amp[k]!
  let cv = 0
  for (let k = 2; k < b.coves.length; k += 3) cv = Math.max(cv, b.coves[k]!)
  s += cv
  return b.R * (1 - s) * Math.min(b.sx, b.sy)
}

function cayBlob(rng: Rng, x: number, z: number, radius: number, peak: number): Blob {
  const b = blank()
  b.kind = "cay"
  b.seed = rng.seed()
  rigid(b, x, z, rng.range(0, Math.PI), rng.range(1, 1.7))
  b.R = radius
  harmonics(b, rng, 0.8)
  b.peak = peak
  b.beach = Math.min(rng.range(16, 26), minRadius(b) * 0.42)
  b.shelf = rng.range(95, 150) * Math.min(1.3, 0.75 + radius / 300)
  b.shelfPh = rng.range(0, TAU)
  b.hPhase = rng.range(0, TAU)
  seeds(b, rng)
  return finish(b, 190)
}

function jungleBlob(rng: Rng, x: number, z: number, radius: number, peak: number): Blob {
  const b = blank()
  b.kind = "jungle"
  b.seed = rng.seed()
  rigid(b, x, z, rng.range(0, Math.PI), rng.range(1.3, 1.7))
  b.R = radius
  harmonics(b, rng, 1.1)
  // Crescent bays with sand, rocky headlands between them (island-2).
  addCoves(b, rng, radius > 220 ? 4 + rng.int(2) : 3 + rng.int(2), [0.14, 0.22])
  // One deep main bay on a long side (local +v): the crescent of island-2, seen broadside.
  b.coves[0] = Math.PI / 2 + rng.range(-0.25, 0.25)
  b.coves[2] = rng.range(0.42, 0.5)
  b.coves[1] = rng.range(0.62, 0.72)
  // Keep the other bays clear of it.
  for (let k = 3; k < b.coves.length; k += 3) if (angDist(b.coves[k]!, b.coves[0]!) < 1.3) b.coves[k + 2] = 0
  b.peak = peak
  b.beach = Math.min(rng.range(40, 52) * Math.min(1.3, 0.6 + radius / 500), minRadius(b) * 0.5)
  b.shelf = rng.range(130, 200) * Math.min(1.3, 0.8 + radius / 900)
  b.shelfPh = rng.range(0, TAU)
  b.hPhase = rng.range(0, TAU)
  // Two or three distinct rounded peaks along the long axis with saddles between them, plus a lower shoulder.
  const n = radius > 260 ? 2 + rng.int(2) : radius > 110 ? 2 : 1
  const hills: number[] = []
  const a0 = rng.range(-0.4, 0.4)
  for (let k = 0; k < n; k++) {
    const side = n === 1 ? 0 : (k / (n - 1)) * 2 - 1
    const d = side * rng.range(0.42, 0.52)
    const a = a0 + rng.range(-0.35, 0.35)
    hills.push(Math.cos(a) * d * radius, Math.sin(a) * d * radius * 0.55, radius * rng.range(0.42, 0.52), k === 0 ? 1 : rng.range(0.8, 0.95))
  }
  const sa = rng.range(0, TAU)
  hills.push(Math.cos(sa) * radius * 0.45, Math.sin(sa) * radius * 0.45, radius * 0.35, rng.range(0.4, 0.55))
  b.hills = Float64Array.from(hills)
  seeds(b, rng)
  return finish(b, 190)
}

function volcanicBlob(rng: Rng, x: number, z: number, radius: number, peak: number): Blob {
  const b = blank()
  b.kind = "volcanic"
  b.seed = rng.seed()
  rigid(b, x, z, rng.range(0, Math.PI), rng.range(1.15, 1.45))
  b.R = radius
  harmonics(b, rng, 1)
  addCoves(b, rng, 4 + rng.int(3), [0.06, 0.12])
  b.peak = peak
  b.beach = Math.min(rng.range(32, 44), minRadius(b) * 0.2)
  b.shelf = rng.range(140, 210)
  b.shelfPh = rng.range(0, TAU)
  b.hPhase = rng.range(0, TAU)
  const m = 10 + rng.int(5)
  const spokes: number[] = []
  const amps: number[] = []
  const off = rng.range(0, TAU)
  for (let k = 0; k < m; k++) {
    let a = off + ((k + rng.range(-0.3, 0.3)) / m) * TAU
    a -= TAU * Math.floor(a / TAU)
    spokes.push(a)
  }
  const order = spokes.map((a, i) => [a, i] as const).sort((p, q) => p[0] - q[0])
  b.spokes = Float64Array.from(order.map((p) => p[0]))
  for (let k = 0; k < m; k++) amps.push(k % 2 === 0 ? rng.range(0.55, 1.1) : -rng.range(0.45, 0.95))
  b.spokeAmp = Float64Array.from(amps)
  b.crater = rng.range(0.055, 0.075)
  b.treeline = rng.range(0.2, 0.26)
  b.sector = rng.range(0, TAU)
  b.sectorW = rng.range(0.38, 0.52)
  seeds(b, rng)
  return finish(b, 190)
}

function cliffBlob(rng: Rng, x: number, z: number, radius: number, peak: number): Blob {
  const b = blank()
  b.kind = "cliff"
  b.seed = rng.seed()
  rigid(b, x, z, rng.range(0, Math.PI), rng.range(1.1, 1.6))
  b.R = radius
  harmonics(b, rng, 1.35)
  b.peak = peak
  b.bands = 2 + rng.int(2)
  b.shelf = rng.range(70, 120)
  b.shelfPh = rng.range(0, TAU)
  b.hPhase = rng.range(0, TAU)
  b.sector = rng.range(0, TAU)
  b.sectorW = rng.range(0.3, 0.42)
  b.cols = wallColumns(b)
  b.colJ = 7
  seeds(b, rng)
  return finish(b, 180)
}

function stackBlob(rng: Rng, x: number, z: number, radius: number, peak: number): Blob {
  const b = blank()
  b.kind = "stack"
  b.seed = rng.seed()
  rigid(b, x, z, rng.range(0, Math.PI), rng.range(1, 1.5))
  b.R = radius
  harmonics(b, rng, 0.9)
  b.peak = peak
  b.bands = 3 + rng.int(2)
  b.shelf = rng.range(40, 60)
  b.shelfPh = rng.range(0, TAU)
  b.hPhase = rng.range(0, TAU)
  b.cols = wallColumns(b)
  b.colJ = radius * 0.3
  seeds(b, rng)
  return finish(b, 180)
}

/** Wind (plan angle the reef tongues trail toward) of an archipelago seed: the sea's wind, downwind of the swell. */
export function reefWind(seed: number): number {
  const w = makeSea(seed).wind
  return Math.atan2(w[1], w[0])
}

/** Builds the blobs of one island. Deterministic from the island's fields and the archipelago's reef wind. */
export function islandBlobs(island: Island, wind = 0): Blob[] {
  const rng = new Rng(island.seed ^ 0x5bd1e995)
  const { x, z, radius: R, peak } = island
  const out: Blob[] = []
  switch (island.kind) {
    case "cay":
      out.push(cayBlob(rng, x, z, R, peak))
      break
    case "jungle":
      out.push(jungleBlob(rng, x, z, R, peak))
      break
    case "volcanic": {
      out.push(volcanicBlob(rng, x, z, R, peak))
      // Lower jungle lobes on a flank, like the centrepiece in concept/island-5.
      const lobes = R > 450 ? 1 + rng.int(2) : 0
      const a0 = rng.range(0, TAU)
      for (let k = 0; k < lobes; k++) {
        const a = a0 + k * rng.range(0.9, 1.6)
        const d = R * rng.range(0.72, 0.92)
        out.push(jungleBlob(rng, x + Math.cos(a) * d, z + Math.sin(a) * d, R * rng.range(0.32, 0.45), Math.max(45, peak * rng.range(0.2, 0.32))))
      }
      break
    }
    case "cliff": {
      // Stepped blocks: the tall massif plus 2-4 lower blocks butting against it at clearly different heights, each
      // with its own wall and grassy top, so the silhouette steps (island-4).
      const main = cliffBlob(rng, x, z, R, peak)
      out.push(main)
      const blocks = 2 + rng.int(3)
      const a0 = rng.range(0, TAU)
      for (let k = 0; k < blocks; k++) {
        const a = a0 + (k / blocks) * TAU + rng.range(-0.5, 0.5)
        const br = R * rng.range(0.4, 0.55)
        // Centre near the massif's edge, so most of the block stands proud of it as a lower step.
        const d = R * rng.range(0.85, 1.05)
        const blk = cliffBlob(rng, x + Math.cos(a) * d, z + Math.sin(a) * d, br, peak * (k % 2 === 0 ? rng.range(0.38, 0.5) : rng.range(0.58, 0.7)))
        blk.sectorW = 0
        out.push(blk)
      }
      const stacks = 1 + rng.int(3)
      for (let k = 0; k < stacks; k++) {
        const a = rng.range(0, TAU)
        const d = R * 1.12 + rng.range(20, 60)
        out.push(stackBlob(rng, x + Math.cos(a) * d, z + Math.sin(a) * d, rng.range(15, 24), peak * rng.range(0.32, 0.5)))
      }
      break
    }
    case "stacks": {
      const n = 5 + rng.int(4)
      const placed: [number, number, number][] = []
      for (let k = 0; k < n * 6 && placed.length < n; k++) {
        const r = rng.range(12, 22) * (placed.length === 0 ? 1.3 : 1)
        const a = rng.range(0, TAU)
        const d = placed.length === 0 ? 0 : rng.range(0.2, 1) * R
        const px = x + Math.cos(a) * d
        const pz = z + Math.sin(a) * d
        if (placed.some(([qx, qz, qr]) => hypot(px - qx, pz - qz) < (qr + r) * 1.2)) continue
        placed.push([px, pz, r])
        const h = Math.min(peak, peak * (0.6 + 0.4 * (r / 28)) * rng.range(0.85, 1.1))
        out.push(stackBlob(rng, px, pz, r, Math.max(24, h)))
      }
      if (rng.next() < 0.5) {
        const a = rng.range(0, TAU)
        out.push(cayBlob(rng, x + Math.cos(a) * R * 0.3, z + Math.sin(a) * R * 0.3, rng.range(22, 34), rng.range(2.2, 3)))
      }
      break
    }
    case "atoll": {
      const reef = blank()
      reef.kind = "reef"
      reef.seed = rng.seed()
      rigid(reef, x, z, rng.range(0, Math.PI), rng.range(1, 1.25))
      reef.R = R
      harmonics(reef, rng, 1.1)
      reef.ring = rng.range(60, 95)
      reef.lagoon = rng.range(3.5, 5.5)
      reef.shelfPh = rng.range(0, TAU)
      reef.passes = Float64Array.from(Array.from({ length: 1 + rng.int(2) }, () => rng.range(0, TAU)))
      seeds(reef, rng)
      finish(reef, 330)
      out.push(reef)
      // Islets: two or three long ones and many tiny ones, spread around the reef flat.
      const long = 2 + rng.int(2)
      const tiny = 9 + rng.int(8)
      const o = newPolar()
      const taken: [number, number][] = []
      const a0 = rng.range(0, TAU)
      for (let k = 0, placedN = 0; k < long + tiny * 3 && placedN < long + tiny; k++) {
        const isLong = k < long
        let th = isLong ? a0 + (k / long) * TAU + rng.range(-0.4, 0.4) : rng.range(0, TAU)
        coastAt(reef, th, o)
        const lu = Math.cos(th) * o.C * reef.sx
        const lv = Math.sin(th) * o.C * reef.sy
        const wx = x + lu * reef.cos - lv * reef.sin
        const wz = z + lu * reef.sin + lv * reef.cos
        const ringR = hypot(wx - x, wz - z) - reef.ring * 0.5
        const t0 = atan2(wz - z, wx - x)
        const half = isLong ? rng.range(30, 44) : rng.range(12, 24)
        const len = isLong ? ringR * rng.range(0.28, 0.45) : half * rng.range(1, 2)
        const span = len / ringR + 0.06
        if (taken.some(([c, w]) => angDist(t0, c) < (w + span) / 2)) continue
        taken.push([t0, span])
        placedN++
        th = t0
        const m = blank()
        m.kind = "cay"
        m.seed = rng.seed()
        m.bend = ringR
        m.bx = x
        m.bz = z
        m.t0 = t0
        m.x = x + Math.cos(t0) * ringR
        m.z = z + Math.sin(t0) * ringR
        m.sx = Math.max(1, len / half)
        m.sy = 1
        m.R = half
        harmonics(m, rng, isLong ? 1.2 : 0.7)
        m.amp[0] = 0
        m.peak = isLong ? rng.range(2.6, Math.max(2.7, peak)) : rng.range(2, 2.8)
        m.beach = Math.min(rng.range(10, 16), minRadius(m) * 0.42)
        m.shelf = 0
        m.shelfPh = rng.range(0, TAU)
        m.hPhase = rng.range(0, TAU)
        seeds(m, rng)
        out.push(finish(m, 52))
      }
      break
    }
  }
  for (const b of out) {
    b.wind = wind
    directionalBound(b)
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------------------
// Index

type Index = {
  blobs: Blob[]
  cell: number
  x0: number
  z0: number
  nx: number
  nz: number
  start: Int32Array
  items: Int32Array
}

const CELL = 200
const indexes = new WeakMap<Archipelago, Index>()

function buildIndex(arch: Archipelago): Index {
  const blobs: Blob[] = []
  // Reef tongues trail toward the swell's downwind side, the same way across the whole archipelago.
  const wind = reefWind(arch.seed)
  arch.islands.forEach((island, ii) => {
    for (const b of islandBlobs(island, wind)) {
      b.index = blobs.length
      b.island = ii
      blobs.push(b)
    }
  })
  for (const b of reefBanks(arch)) {
    b.index = blobs.length
    b.island = -1
    b.wind = wind
    blobs.push(b)
  }
  const [x0, z0, x1, z1] = arch.bounds
  const nx = Math.max(1, Math.ceil((x1 - x0) / CELL))
  const nz = Math.max(1, Math.ceil((z1 - z0) / CELL))
  const lists: number[][] = Array.from({ length: nx * nz }, () => [])
  for (const b of blobs) {
    const i0 = Math.max(0, Math.floor((b.x - b.reach - x0) / CELL))
    const i1 = Math.min(nx - 1, Math.floor((b.x + b.reach - x0) / CELL))
    const j0 = Math.max(0, Math.floor((b.z - b.reach - z0) / CELL))
    const j1 = Math.min(nz - 1, Math.floor((b.z + b.reach - z0) / CELL))
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const cx = Math.min(Math.max(b.x, x0 + i * CELL), x0 + (i + 1) * CELL)
        const cz = Math.min(Math.max(b.z, z0 + j * CELL), z0 + (j + 1) * CELL)
        if ((cx - b.x) ** 2 + (cz - b.z) ** 2 < b.reach2) lists[j * nx + i]!.push(b.index)
      }
    }
  }
  const start = new Int32Array(nx * nz + 1)
  for (let c = 0; c < lists.length; c++) start[c + 1] = start[c]! + lists[c]!.length
  const items = new Int32Array(start[nx * nz]!)
  for (let c = 0; c < lists.length; c++) items.set(lists[c]!, start[c]!)
  return { blobs, cell: CELL, x0, z0, nx, nz, start, items }
}

function bankBlob(r: Rng, x: number, z: number, hx: number, hz: number, halfW: number, flat: number): Blob {
  const b = blank()
  b.kind = "bank"
  b.seed = r.seed()
  b.x = x
  b.z = z
  b.hx = hx
  b.hz = hz
  b.halfW = halfW
  b.flat = flat
  b.R = halfW
  b.extent = 0
  seeds(b, r)
  b.reach = hypot(hx, hz) + halfW * 1.6 + 40 + 190
  b.reach2 = b.reach * b.reach
  return b
}

/**
 * Reef flats shared by close neighbours (a shallow bar between their coasts, broken by gaps) and scattered patch
 * reefs and shoals in open water near the islands. Derived from the islands, so the Archipelago stays as is.
 */
export function reefBanks(arch: Archipelago): Blob[] {
  const r = new Rng(arch.seed ^ 0x27d4eb2f)
  const wind = reefWind(arch.seed)
  const fps = arch.islands.map((i) => footprint(i, wind))
  const out: Blob[] = []
  const ok = (x: number, z: number, reach: number) =>
    hypot(x, z) > SPAWN_CLEAR + reach && Math.abs(x) + reach < WORLD_HALF && Math.abs(z) + reach < WORLD_HALF
  for (let i = 0; i < fps.length; i++) {
    for (let j = i + 1; j < fps.length; j++) {
      const p = fps[i]!
      const q = fps[j]!
      const dx = q.x - p.x
      const dz = q.z - p.z
      const d = hypot(dx, dz)
      const gap = d - p.extent - q.extent
      if (gap > 750 || r.next() > 0.7) continue
      const ux = dx / d
      const uz = dz / d
      // From just off one coast to just off the other, bowed a little sideways.
      const a = p.extent * 0.8
      const c = d - q.extent * 0.8
      const mid = (a + c) / 2 + r.range(-0.1, 0.1) * gap
      const bow = r.range(-0.25, 0.25) * gap
      const x = p.x + ux * mid - uz * bow
      const z = p.z + uz * mid + ux * bow
      const half = (c - a) / 2
      const b = bankBlob(r, x, z, ux * half, uz * half, r.range(70, 140), r.range(-4.2, -2.4))
      if (ok(x, z, b.reach)) out.push(b)
    }
  }
  // Patch reefs and shoals around each island, clear of other land.
  for (const p of fps) {
    const n = r.int(4)
    for (let k = 0; k < n; k++) {
      const a = r.range(0, TAU)
      const dist = p.extent + p.shelf + r.range(80, 520)
      const x = p.x + Math.cos(a) * dist
      const z = p.z + Math.sin(a) * dist
      if (fps.some((q) => hypot(x - q.x, z - q.z) < q.extent + 120)) continue
      const len = r.next() < 0.5 ? r.range(20, 140) : 0
      const ang = r.range(0, TAU)
      const b = bankBlob(r, x, z, Math.cos(ang) * len, Math.sin(ang) * len, r.range(25, 85), r.range(-6, -1.6))
      if (ok(x, z, b.reach)) out.push(b)
    }
  }
  return out
}

const BOUND_BINS = 96

/**
 * Directional reach of a blob: for each world-angle bin, the farthest distance from its centre where it can be above
 * DEEP (coast + widest possible shelf edge there + the drop), with margin and the neighbouring bins folded in.
 */
function directionalBound(b: Blob): void {
  if (b.bend > 0 || b.kind === "reef" || b.kind === "bank") return
  const raw = new Float32Array(BOUND_BINS)
  const o = newPolar()
  const w = [0, 0]
  const M = 720
  for (let i = 0; i < M; i++) {
    const th = (i / M) * TAU - Math.PI
    coastAt(b, th, o)
    blobWorld(b, o.C * Math.cos(th), o.C * Math.sin(th), w)
    const px = w[0]! - b.x
    const pz = w[1]! - b.z
    const wa = atan2(pz, px)
    let W = shelfWidth(b, th) * 1.3 + 16 + 13
    // Tongues are added along world angle wa; take their max over a band to be safe.
    W += b.tongue * Math.pow(Math.max(0, Math.cos(Math.max(0, angDist(wa, b.wind) - 0.6))), 7) * 1.3
    if (b.tongue2Len > 0) W += b.tongue2Len * Math.pow(Math.max(0, Math.cos(Math.max(0, angDist(wa, b.tongue2) - 0.6))), 11) * 1.3
    const dist = hypot(px, pz) + (W + 190) * Math.max(1, b.sx, b.sy) * 1.2 + 40
    const k = Math.min(BOUND_BINS - 1, Math.floor(((wa + Math.PI) / TAU) * BOUND_BINS))
    raw[k] = Math.max(raw[k]!, dist)
  }
  const out = new Float32Array(BOUND_BINS)
  for (let k = 0; k < BOUND_BINS; k++) {
    let m = 0
    for (let j = -3; j <= 3; j++) m = Math.max(m, raw[(k + j + BOUND_BINS) % BOUND_BINS]!)
    out[k] = m + 20
  }
  b.bound = out
  let m = 0
  for (let k = 0; k < BOUND_BINS; k++) m = Math.max(m, out[k]!)
  b.reach = Math.min(b.reach, m)
  b.reach2 = b.reach * b.reach
}

function indexOf(arch: Archipelago): Index {
  let idx = indexes.get(arch)
  if (!idx) {
    idx = buildIndex(arch)
    indexes.set(arch, idx)
  }
  return idx
}

/** All blobs of the archipelago (index = position), for the mesh builder and the preview. */
export function archBlobs(arch: Archipelago): readonly Blob[] {
  return indexOf(arch).blobs
}

export type Probe = { h: number; owner: number }

const polar = newPolar()

/** Terrain height and the index of the blob that wins at (x, z) (-1 in the open sea). */
export function terrainProbe(arch: Archipelago, x: number, z: number, out: Probe): Probe {
  const idx = indexOf(arch)
  out.h = DEEP
  out.owner = -1
  const i = Math.floor((x - idx.x0) / idx.cell)
  const j = Math.floor((z - idx.z0) / idx.cell)
  if (i < 0 || j < 0 || i >= idx.nx || j >= idx.nz) return out
  const c = j * idx.nx + i
  for (let k = idx.start[c]!; k < idx.start[c + 1]!; k++) {
    const b = idx.blobs[idx.items[k]!]!
    const h = blobHeight(b, x, z, polar)
    if (h > out.h) {
      out.h = h
      out.owner = b.index
    }
  }
  return out
}

const scratch: Probe = { h: 0, owner: -1 }

/** Terrain height in metres at (x, z): positive above sea level, negative on the seabed (deep sea ≈ -60). Deterministic. */
export function terrainHeight(arch: Archipelago, x: number, z: number): number {
  return terrainProbe(arch, x, z, scratch).h
}

/** Coral cover of the seabed at (x, z): 0 = sand, 1 = coral. Only on reef shelves and in lagoons. */
export function coralAt(arch: Archipelago, x: number, z: number): number {
  const idx = indexOf(arch)
  const i = Math.floor((x - idx.x0) / idx.cell)
  const j = Math.floor((z - idx.z0) / idx.cell)
  if (i < 0 || j < 0 || i >= idx.nx || j >= idx.nz) return 0
  const c = j * idx.nx + i
  let m = 0
  for (let k = idx.start[c]!; k < idx.start[c + 1]!; k++) m = Math.max(m, blobCoral(idx.blobs[idx.items[k]!]!, x, z, polar))
  return m
}

// ---------------------------------------------------------------------------------------------------------------------
// Archipelago

type Spec = { kind: IslandKind; radius: number; peak: number }

function spec(kind: IslandKind, rng: Rng, big = false): Spec {
  const t = rng.next()
  switch (kind) {
    case "volcanic":
      return big ? { kind, radius: rng.range(540, 620), peak: rng.range(520, 565) } : { kind, radius: rng.range(360, 460), peak: rng.range(260, 330) }
    case "jungle":
      return big ? { kind, radius: rng.range(380, 460), peak: rng.range(190, 240) } : { kind, radius: 160 + 170 * t * t, peak: 95 + 90 * t + rng.range(0, 20) }
    case "cay":
      return { kind, radius: 70 + 90 * t * t, peak: rng.range(3, 5) }
    case "stacks":
      return { kind, radius: rng.range(100, 160), peak: rng.range(65, 100) }
    case "cliff":
      return { kind, radius: rng.range(120, 200), peak: rng.range(80, 130) }
    case "atoll":
      return { kind, radius: rng.range(330, 560), peak: rng.range(2.6, 4) }
  }
}

const FILL: [IslandKind, number][] = [
  ["cay", 0.4],
  ["stacks", 0.17],
  ["jungle", 0.17],
  ["cliff", 0.1],
  ["atoll", 0.09],
  ["volcanic", 0.07],
]

function pickKind(rng: Rng): IslandKind {
  let t = rng.next()
  for (const [k, w] of FILL) {
    t -= w
    if (t < 0) return k
  }
  return "cay"
}

type Footprint = { x: number; z: number; extent: number; reach: number; shelf: number }

function footprint(island: Island, wind: number): Footprint {
  let extent = 0
  let reach = 0
  let shelf = 0
  for (const b of islandBlobs(island, wind)) {
    const d = hypot(b.x - island.x, b.z - island.z)
    extent = Math.max(extent, d + b.extent)
    reach = Math.max(reach, d + b.reach)
    shelf = Math.max(shelf, b.kind === "reef" ? 240 : b.shelf * 1.35)
  }
  return { x: island.x, z: island.z, extent, reach, shelf }
}

/** Land and shelf extent of an island around its centre (for spacing and tests); `seed` is the archipelago's. */
export function islandFootprint(island: Island, seed = 0): { extent: number; reach: number } {
  const f = footprint(island, reefWind(seed))
  return { extent: f.extent, reach: f.reach }
}

/** Fewest and most islands per world. */
export const MIN_ISLANDS = 24
export const MAX_ISLANDS = 36
/** Coast-to-coast gaps between neighbours in a group (metres); skewed toward the low end. */
const GAP: [number, number] = [300, 1200]

const archipelagos = new Map<number, Archipelago>()
const ARCHIPELAGO_CACHE = 6

/**
 * `makeArchipelago(seed)`, shared between callers: rooms and tests that ask for the same seed get the same instance
 * (and its terrain index) while it stays among the last `ARCHIPELAGO_CACHE` seeds used. Treat the result as read-only.
 */
export function archipelagoFor(seed: number): Archipelago {
  let arch = archipelagos.get(seed)
  if (arch) archipelagos.delete(seed)
  else {
    arch = makeArchipelago(seed)
    if (archipelagos.size >= ARCHIPELAGO_CACHE) archipelagos.delete(archipelagos.keys().next().value!)
  }
  archipelagos.set(seed, arch)
  return arch
}

/**
 * Islands come in groups. Group 0 surrounds the centrepiece (2.3-3.3 km north of the spawn) and spills toward the
 * spawn, so the default view looks over cays and stacks at the big island, its neighbour, an atoll and a cliff island
 * (island-5). Three to five more groups sit further out, some near the edge of the world, for silhouettes on the
 * horizon. Each new island is placed next to a random member of its group, 300-1200 m of open water from it, so reef
 * shelves of neighbours nearly touch.
 */
export function makeArchipelago(seed: number): Archipelago {
  const rng = new Rng(seed ^ 0x9e3779b9)
  const wind = reefWind(seed)
  const count = MIN_ISLANDS + rng.int(MAX_ISLANDS - MIN_ISLANDS + 1)
  const centre: IslandKind = rng.next() < 0.7 ? "volcanic" : "jungle"
  // Group 0: the centrepiece, a big neighbour, a stack cluster, cays, an atoll and a cliff island.
  const specs: { s: Spec; group: number }[] = [{ s: spec(centre, rng, true), group: 0 }]
  const g0: IslandKind[] = [centre === "volcanic" ? "jungle" : "volcanic", "stacks", "cay", "cay", "cay", "atoll", "cliff", "cay", "stacks"]
  for (const k of g0) specs.push({ s: spec(k, rng, k === "jungle"), group: 0 })
  const groups = 3 + rng.int(3)
  let g = 1
  while (specs.length < count) {
    specs.push({ s: spec(pickKind(rng), rng), group: g })
    g = g >= groups ? 1 : g + 1
  }

  const islands: Island[] = []
  const placed: Footprint[] = []
  const members: number[][] = Array.from({ length: groups + 1 }, () => [])
  const centres: [number, number][] = []
  const fits = (fp: Footprint) => {
    if (fp.x - fp.reach < -WORLD_HALF || fp.x + fp.reach > WORLD_HALF || fp.z - fp.reach < -WORLD_HALF || fp.z + fp.reach > WORLD_HALF) return false
    if (hypot(fp.x, fp.z) < SPAWN_CLEAR + fp.reach) return false
    return !placed.some((q) => hypot(fp.x - q.x, fp.z - q.z) < fp.extent + q.extent + GAP[0])
  }
  specs.forEach(({ s, group }, si) => {
    let { radius, peak } = s
    const islandSeed = rng.seed()
    for (let shrink = 0; shrink < 5; shrink++) {
      // The island's footprint at the origin: the same for every attempt at this size.
      const fp0 = footprint({ x: 0, z: 0, radius: Math.round(radius), peak: Math.round(peak * 10) / 10, kind: s.kind, seed: islandSeed }, wind)
      for (let attempt = 0; attempt < 160; attempt++) {
        const island: Island = { x: 0, z: 0, radius: Math.round(radius), peak: Math.round(peak * 10) / 10, kind: s.kind, seed: islandSeed }
        let x: number
        let z: number
        const mine = members[group]!
        if (si === 0) {
          const a = -Math.PI / 2 + rng.range(-0.7, 0.7)
          const d = Math.max(SPAWN_CLEAR + fp0.reach + 150, rng.range(2300, 3300))
          x = Math.cos(a) * d
          z = Math.sin(a) * d
        } else if (mine.length === 0 || attempt > 120) {
          // Seed a new group away from the others. Group 1 sits beyond the centrepiece (silhouettes on the horizon of
          // the default view); the rest anywhere, some far out.
          const far = group % 2 === 0
          const c = islands[0]!
          const a = group === 1 ? atan2(c.z, c.x) + rng.range(-0.5, 0.5) : rng.range(0, TAU)
          const d = group === 1 ? hypot(c.x, c.z) + rng.range(2000, 2800) : far ? rng.range(4300, 5400) : rng.range(2200, 4200)
          x = Math.cos(a) * d
          z = Math.sin(a) * d
          if (attempt <= 120 && centres.some(([cx, cz]) => hypot(x - cx, z - cz) < 2600)) continue
        } else {
          // Next to a random member of the group; group 0 leans toward the spawn so the view from it is full.
          const q = placed[mine[rng.int(mine.length)]!]!
          let a = rng.range(0, TAU)
          if (group === 0 && rng.next() < 0.6) a = atan2(-q.z, -q.x) + rng.range(-1.3, 1.3)
          const t = rng.next()
          const d = q.extent + fp0.extent + GAP[0] + (GAP[1] - GAP[0]) * t * t * t * t
          x = q.x + Math.cos(a) * d
          z = q.z + Math.sin(a) * d
        }
        island.x = Math.round(x)
        island.z = Math.round(z)
        const fp = footprint(island, wind)
        if (!fits(fp)) continue
        if (mine.length === 0) centres.push([island.x, island.z])
        mine.push(placed.length)
        islands.push(island)
        placed.push(fp)
        return
      }
      radius *= 0.82
      if (s.kind !== "cay" && s.kind !== "atoll") peak *= 0.88
    }
  })
  return { seed, islands, bounds: [-WORLD_HALF, -WORLD_HALF, WORLD_HALF, WORLD_HALF] }
}
