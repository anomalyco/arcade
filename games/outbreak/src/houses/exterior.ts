import { MAT, type Mat, type Mesh, type Rgb } from "@arcade/kit/gpu/mesh"
import type { Rect } from "@arcade/kit/sim/geom"
import { Rng, seedOf } from "@arcade/kit/sim/rng"
import { boundaryEdges, OUTER_WALL, type PlanEdge } from "../../shared/houses/geometry"
import type { HouseStyle, RoofShape } from "../../shared/houses/style"
import type { Building, Town } from "../../shared/map"

/**
 * The outside of a styled home (AR-79), from `Building.style`: siding courses, trim and shutters on the ground-floor
 * walls, an upper storey, the roof (gable, cross gable, hip, gambrel, flat or shed), chimney, porch, garage door and
 * boarded windows, then what its condition did to it (derelict sag and holes, burnt shells, unfinished frames).
 *
 * Everything goes into the chunk's main mesh. What stands above the 2.8 m wall line, and every `MAT.roof` piece, is
 * routed into the building's roof chunk by the streamer (so it cuts away when you walk in); what clings to the walls
 * uses `MAT.wall` so the wall cut circle takes it with the wall.
 */

type V3 = [number, number, number]
const hex = (v: number): Rgb => [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]
const shade = (c: Rgb, k: number): Rgb => [Math.min(1, c[0] * k), Math.min(1, c[1] * k), Math.min(1, c[2] * k)]
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]

/** Ground-floor wall top, and the eave line of a two-storey home. */
export const WALL_TOP = 2.8
export const UPPER_TOP = 5.5
const SOOT = hex(0x141210)
const CHAR = hex(0x1e1b18)
const DARK_GAP = hex(0x17140f)
const IVY = [hex(0x26301e), hex(0x2c3622), hex(0x222a1a)]
const TIMBER = hex(0x6a5236)
const PLY = hex(0x8a7656)
const TARP = hex(0x3c5866)

/** A polygon fanned from its first point, wound so its normal faces `hint`. */
function poly(m: Mesh, pts: V3[], col: Rgb, mat: Mat, aux: number, hint: V3): void {
  if (pts.length < 3) return
  const [a, b, c] = pts as [V3, V3, V3]
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2]
  const wx = c[0] - a[0], wy = c[1] - a[1], wz = c[2] - a[2]
  const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx
  const p = nx * hint[0] + ny * hint[1] + nz * hint[2] < 0 ? [...pts].reverse() : pts
  for (let i = 1; i < p.length - 1; i++) m.facet(p[0]!, p[i]!, p[i + 1]!, col, mat, aux)
}

// --- façade frames ---------------------------------------------------------------------------------------------------

/** A wall's outer face: along x at z = `at` (axis "x") or along z at x = `at`, outside toward +`side`. */
type Face = { axis: "x" | "z"; at: number; side: 1 | -1 }
const P = (f: Face, u: number, y: number, d: number): V3 => (f.axis === "x" ? [u, y, f.at + f.side * d] : [f.at + f.side * d, y, u])
const outward = (f: Face): V3 => (f.axis === "x" ? [0, 0, f.side] : [f.side, 0, 0])

/** A quad on a face from u0..u1 and y0..y1, standing `d0` proud at the bottom and `d1` at the top. */
function faceQuad(m: Mesh, f: Face, u0: number, u1: number, y0: number, y1: number, d0: number, d1: number, col: Rgb, mat: Mat, aux = 0): void {
  poly(m, [P(f, u0, y0, d0), P(f, u1, y0, d0), P(f, u1, y1, d1), P(f, u0, y1, d1)], col, mat, aux, outward(f))
}

/** A box on a face, between `d0` and `d1` out from it. */
function faceBox(m: Mesh, f: Face, u0: number, u1: number, y0: number, y1: number, d0: number, d1: number, col: Rgb, mat: Mat, aux = 0): void {
  const a = f.at + f.side * d0, b = f.at + f.side * d1
  if (f.axis === "x") m.box(u0, y0, Math.min(a, b), u1, y1, Math.max(a, b), col, mat, aux)
  else m.box(Math.min(a, b), y0, u0, Math.max(a, b), y1, u1, col, mat, aux)
}

/** A board across an opening, tilted in the wall plane, `d` proud of the face. */
function plank(m: Mesh, f: Face, u0: number, u1: number, y: number, tilt: number, d: number, col: Rgb, mat: Mat, aux = 0): void {
  const uc = (u0 + u1) / 2, half = (u1 - u0) / 2, h = 0.065
  const c = Math.cos(tilt), s = Math.sin(tilt)
  const at = (du: number, dy: number, dd: number) => P(f, uc + du * c - dy * s, y + du * s + dy * c, dd)
  poly(m, [at(-half, -h, d + 0.045), at(half, -h, d + 0.045), at(half, h, d + 0.045), at(-half, h, d + 0.045)], col, mat, aux, outward(f))
  poly(m, [at(-half, h, d), at(half, h, d), at(half, h, d + 0.045), at(-half, h, d + 0.045)], shade(col, 1.12), mat, aux, [0, 1, 0])
}

type Piece = { f: Face; a0: number; a1: number; window: boolean; boarded: boolean }

/** The outside wall pieces of a building (walls and window bays on its boundary), each with its outer face. */
function facadePieces(b: Building, town: Town, edges: readonly PlanEdge[]): Piece[] {
  const out: Piece[] = []
  const near = (p: number, q: number) => Math.abs(p - q) < 2e-3
  for (const bar of town.barriers) {
    if (bar.kind === "fence" || bar.hidden) continue
    const [x0, z0, x1, z1] = bar.rect
    if (x0 < b.rect[0] - 0.05 || x1 > b.rect[2] + 0.05 || z0 < b.rect[1] - 0.05 || z1 > b.rect[3] + 0.05) continue
    for (const e of edges) {
      const onX = e.axis === "x" && (e.side > 0 ? near(z1, e.at) && near(z0, e.at - OUTER_WALL) : near(z0, e.at) && near(z1, e.at + OUTER_WALL)) && x0 >= e.a0 - 2e-3 && x1 <= e.a1 + 2e-3
      const onZ = e.axis === "z" && (e.side > 0 ? near(x1, e.at) && near(x0, e.at - OUTER_WALL) : near(x0, e.at) && near(x1, e.at + OUTER_WALL)) && z0 >= e.a0 - 2e-3 && z1 <= e.a1 + 2e-3
      if (!onX && !onZ) continue
      const window = bar.kind === "window"
      const boarded = window && town.windows.some((w) => w.boarded && w.buildingId === b.id && near(w.rect[0], x0) && near(w.rect[1], z0) && near(w.rect[2], x1) && near(w.rect[3], z1))
      out.push({ f: { axis: e.axis, at: e.at, side: e.side }, a0: onX ? x0 : z0, a1: onX ? x1 : z1, window, boarded })
      break
    }
  }
  return out
}

// --- siding ----------------------------------------------------------------------------------------------------------

/** Siding courses and weathering over one wall span (y0..y1) of a face. */
function clad(m: Mesh, f: Face, a0: number, a1: number, y0: number, y1: number, s: HouseStyle, col: Rgb, rng: Rng, mat: Mat, aux: number): void {
  if (a1 - a0 < 0.03 || y1 - y0 < 0.03) return
  const grime = (y: number) => 1 - s.wear * 0.28 * (1 - Math.min(1, Math.max(0, (y - 0.37) / 1.1)))
  const derelict = s.condition === "derelict"
  if (s.siding === "clapboard") {
    const step = 0.2
    for (let y = y0; y < y1 - 0.01; y += step) {
      const top = Math.min(y1, y + step)
      const gap = derelict && rng.next() < 0.08
      const c = gap ? DARK_GAP : shade(col, grime(y) * (0.97 + rng.next() * 0.06))
      faceQuad(m, f, a0, a1, y, top, 0.03, 0.006, c, mat, aux)
    }
  } else if (s.siding === "shingle") {
    const step = 0.28
    for (let y = y0, row = 0; y < y1 - 0.01; y += step, row++) {
      const top = Math.min(y1, y + step)
      let u = a0 - (row % 2 ? 0.17 : 0)
      while (u < a1) {
        const w = 0.22 + rng.next() * 0.34
        const u0 = Math.max(a0, u), u1 = Math.min(a1, u + w)
        if (u1 - u0 > 0.02) {
          const gap = derelict && rng.next() < 0.05
          faceQuad(m, f, u0, u1, y, top, 0.032, 0.006, gap ? DARK_GAP : shade(col, grime(y) * (0.9 + rng.next() * 0.16)), mat, aux)
        }
        u += w
      }
    }
  } else if (s.siding === "brick") {
    faceQuad(m, f, a0, a1, y0, y1, 0.012, 0.012, shade(col, grime(y0 + 0.6)), mat, aux)
    // Mortar courses every 0.3 m and a few re-pointed patches of other bricks.
    const mortar = shade(mix(col, hex(0x8a8478), 0.55), grime(y0))
    for (let y = y0 + 0.3; y < y1 - 0.05; y += 0.3) faceQuad(m, f, a0, a1, y, y + 0.014, 0.016, 0.016, mortar, mat, aux)
    for (let k = 0; k < Math.floor((a1 - a0) / 2.4); k++) {
      const u = a0 + rng.next() * Math.max(0, a1 - a0 - 0.6), y = y0 + rng.next() * Math.max(0, y1 - y0 - 0.4)
      faceQuad(m, f, u, Math.min(a1, u + 0.3 + rng.next() * 0.5), y, Math.min(y1, y + 0.15 + rng.next() * 0.3), 0.017, 0.017, shade(col, 0.82 + rng.next() * 0.3), mat, aux)
    }
  } else if (s.siding === "stucco") {
    faceQuad(m, f, a0, a1, y0, y1, 0.014, 0.014, shade(col, grime(y0 + 0.5)), mat, aux)
    // Splash band, rain stains and a crack.
    faceQuad(m, f, a0, a1, y0, Math.min(y1, y0 + 0.28), 0.018, 0.018, shade(col, 0.72), mat, aux)
    if (a1 - a0 > 1.2 && rng.next() < 0.6 + s.wear * 0.4) {
      const u = a0 + 0.2 + rng.next() * (a1 - a0 - 0.8)
      faceQuad(m, f, u, u + 0.35 + rng.next() * 0.5, Math.max(y0, y1 - 1.2 - rng.next()), y1, 0.018, 0.018, shade(col, 0.8), mat, aux)
    }
    if (a1 - a0 > 1 && rng.next() < 0.5) {
      const u = a0 + 0.3 + rng.next() * (a1 - a0 - 0.6), y = y0 + 0.4 + rng.next() * Math.max(0, y1 - y0 - 1.2)
      poly(m, [P(f, u, y, 0.02), P(f, u + 0.03, y, 0.02), P(f, u + 0.32, y + 0.7, 0.02), P(f, u + 0.29, y + 0.7, 0.02)], shade(col, 0.45), mat, aux, outward(f))
    }
  } else {
    // Ribbed metal: a sheet with standing ribs every 0.32 m and a darker stripe at window height.
    faceQuad(m, f, a0, a1, y0, y1, 0.01, 0.01, shade(col, grime(y0 + 0.4)), mat, aux)
    for (let u = a0 + 0.16; u < a1 - 0.02; u += 0.32) faceBox(m, f, u - 0.012, u + 0.012, y0, y1, 0.01, 0.03, shade(col, 1.06), mat, aux)
    if (y0 < 1.55 && y1 > 1.7) faceQuad(m, f, a0, a1, 1.55, 1.7, 0.032, 0.032, s.trim === 0xc8c4b8 ? hex(0x5a3f2e) : hex(s.trim), mat, aux)
  }
  // Rust and rain streaks from the top.
  const streaks = Math.floor((a1 - a0) * s.wear * 0.6)
  for (let k = 0; k < streaks; k++) {
    const u = a0 + rng.next() * Math.max(0.01, a1 - a0 - 0.1), w = 0.04 + rng.next() * 0.08
    faceQuad(m, f, u, u + w, Math.max(y0, y1 - 0.4 - rng.next() * 1.2), y1, 0.036, 0.036, shade(col, 0.62), mat, aux)
  }
}

// --- roofs -----------------------------------------------------------------------------------------------------------

/** A roof's local frame: u runs along the ridge, v across it. */
type Frame = (u: number, y: number, v: number) => V3
const alongXFrame: Frame = (u, y, v) => [u, y, v]
const alongZFrame: Frame = (u, y, v) => [v, y, u]
/** World direction of +u (`du`) and +v (`dv`) in a frame. */
const dir = (F: Frame, du: number, dv: number): V3 => {
  const a = F(du, 0, dv), o = F(0, 0, 0)
  return [a[0] - o[0], a[1] - o[1], a[2] - o[2]]
}

type RoofOpts = {
  frame: Frame
  /** Walls (u0w..u1w, v0w..v1w) and overhangs. */
  u0: number
  u1: number
  v0: number
  v1: number
  /** Eave base height (top of the walls). */
  H: number
  shape: RoofShape
  pitch: number
  roof: Rgb
  wall: Rgb
  trim: Rgb
  aux: number
  /** Gable end walls at u0 / u1 (false where the roof runs into another). */
  endU0: boolean
  endU1: boolean
  /** Extend the slopes back past u0 (a wing running into the main roof). */
  runIn?: number
  /** Strip state per 1 m slice along u: "hole" leaves rafters only, "frame" bare trusses. */
  slices?: (k: number) => "roof" | "hole" | "frame" | "tarp"
}

const OH = 0.38

/** Profile across v from eave to eave: [v, y] pairs, at overhang. */
function profile(o: RoofOpts): [number, number][] {
  const half = (o.v1 - o.v0) / 2, vm = (o.v0 + o.v1) / 2
  const k = o.pitch
  if (o.shape === "shed") {
    const rise = Math.min(1.6, (o.v1 - o.v0) * 0.16)
    const kk = rise / (o.v1 - o.v0)
    // High at the back (low v), low over the street.
    return [[o.v0 - OH, o.H + rise + OH * kk], [o.v1 + OH, o.H - OH * kk]]
  }
  if (o.shape === "gambrel") {
    const q = half * 0.34
    const knee = o.H + q * 2.2
    const ridge = knee + (half - q) * 0.42
    return [[o.v0 - OH * 0.4, o.H - OH * 0.4 * 2.2], [o.v0 + q, knee], [vm, ridge], [o.v1 - q, knee], [o.v1 + OH * 0.4, o.H - OH * 0.4 * 2.2]]
  }
  return [[o.v0 - OH, o.H - OH * k], [vm, o.H + half * k], [o.v1 + OH, o.H - OH * k]]
}

function profileAt(pr: readonly [number, number][], v: number): number {
  for (let i = 0; i < pr.length - 1; i++) {
    const [va, ya] = pr[i]!, [vb, yb] = pr[i + 1]!
    if (v >= va - 1e-6 && v <= vb + 1e-6) return ya + ((yb - ya) * (v - va)) / Math.max(1e-6, vb - va)
  }
  return pr[0]![1]
}

/** A pitched roof extruded along u from its profile, with gable end walls, fascia, rakes and ridge cap. */
function pitched(m: Mesh, o: RoofOpts, rng: Rng): { ridge: number; pr: [number, number][] } {
  const pr = profile(o)
  const F = o.frame
  const uA = o.u0 - (o.runIn ?? (o.endU0 ? OH * 0.8 : 0)), uB = o.u1 + (o.endU1 ? OH * 0.8 : 0)
  const n = Math.max(1, Math.round((uB - uA) / 1.0))
  for (let k = 0; k < n; k++) {
    const s0 = uA + ((uB - uA) * k) / n, s1 = uA + ((uB - uA) * (k + 1)) / n
    const state = o.slices ? o.slices(k) : "roof"
    for (let i = 0; i < pr.length - 1; i++) {
      const [va, ya] = pr[i]!, [vb, yb] = pr[i + 1]!
      if (state === "roof" || state === "tarp") {
        poly(m, [F(s0, ya, va), F(s1, ya, va), F(s1, yb, vb), F(s0, yb, vb)], state === "tarp" ? TARP : shade(o.roof, 0.96 + rng.next() * 0.08), MAT.roof, o.aux, [0, 1, 0])
        if (state === "tarp") {
          // Weights and a sag in the sheet.
          const vm = (va + vb) / 2, ym = (ya + yb) / 2
          poly(m, [F(s0 + 0.1, ym + 0.01, vm - 0.2), F(s1 - 0.1, ym + 0.01, vm - 0.2), F(s1 - 0.1, ym + 0.02, vm + 0.2), F(s0 + 0.1, ym + 0.02, vm + 0.2)], shade(TARP, 0.8), MAT.roof, o.aux, [0, 1, 0])
        }
      }
      if (state !== "roof") {
        // Rafters across the slice (charred or raw), every 0.6 m.
        const col = state === "hole" ? CHAR : PLY
        for (let u = s0 + 0.15; u < s1; u += 0.6) {
          const broken = state === "hole" && rng.next() < 0.35 ? 0.4 + rng.next() * 0.4 : 1
          const vb2 = va + (vb - va) * broken, yb2 = ya + (yb - ya) * broken
          poly(m, [F(u - 0.04, ya, va), F(u + 0.04, ya, va), F(u + 0.04, yb2, vb2), F(u - 0.04, yb2, vb2)], col, MAT.roof, o.aux, [0, 1, 0])
          poly(m, [F(u - 0.04, ya - 0.14, va), F(u - 0.04, ya, va), F(u - 0.04, yb2, vb2), F(u - 0.04, yb2 - 0.14, vb2)], shade(col, 0.7), MAT.roof, o.aux, dir(F, -1, 0))
        }
      }
    }
  }
  const ridge = Math.max(...pr.map(([, y]) => y))
  const walls: [number, boolean][] = [[o.u0, o.endU0], [o.u1, o.endU1]]
  for (const [u, on] of walls) {
    if (!on) continue
    const pts: V3[] = [F(u, o.H, o.v0)]
    const yA = profileAt(pr, o.v0)
    if (yA > o.H + 0.01) pts.push(F(u, yA, o.v0))
    for (const [v, y] of pr) if (v > o.v0 + 1e-3 && v < o.v1 - 1e-3) pts.push(F(u, y, v))
    const yB = profileAt(pr, o.v1)
    if (yB > o.H + 0.01) pts.push(F(u, yB, o.v1))
    pts.push(F(u, o.H, o.v1))
    const out = u === o.u0 ? -1 : 1
    const hint = dir(F, out, 0)
    if (o.slices && o.slices(0) === "frame") continue
    poly(m, pts, o.wall, MAT.lit, o.aux, hint)
    // Rake boards along the gable edge.
    for (let i = 0; i < pr.length - 1; i++) {
      const [va, ya] = pr[i]!, [vb, yb] = pr[i + 1]!
      const uu = u + out * (OH * 0.8 - 0.02)
      poly(m, [F(uu, ya - 0.16, va), F(uu, ya + 0.02, va), F(uu, yb + 0.02, vb), F(uu, yb - 0.16, vb)], o.trim, MAT.lit, o.aux, hint)
    }
  }
  // Fascia along both eaves and a ridge cap.
  const [vf, yf] = pr[0]!, [vl, yl] = pr[pr.length - 1]!
  for (const [v, y, sgn] of [[vf, yf, -1], [vl, yl, 1]] as const) {
    poly(m, [F(uA, y - 0.18, v), F(uB, y - 0.18, v), F(uB, y + 0.01, v), F(uA, y + 0.01, v)], o.trim, MAT.lit, o.aux, dir(F, 0, sgn))
  }
  if (o.shape !== "shed" && (!o.slices || o.slices(0) !== "frame")) {
    const vm = (o.v0 + o.v1) / 2
    const ry = profileAt(pr, vm)
    poly(m, [F(uA, ry + 0.04, vm - 0.13), F(uB, ry + 0.04, vm - 0.13), F(uB, ry + 0.06, vm + 0.13), F(uA, ry + 0.06, vm + 0.13)], shade(o.roof, 1.25), MAT.roof, o.aux, [0, 1, 0])
  }
  return { ridge, pr }
}

/** A hip roof over a rect: four slopes to a ridge (or a point), with fascia. */
function hip(m: Mesh, r: Rect, H: number, pitch: number, roof: Rgb, trim: Rgb, aux: number): number {
  const x0 = r[0] - OH, z0 = r[1] - OH, x1 = r[2] + OH, z1 = r[3] + OH
  const yE = H - OH * pitch
  const alongX = x1 - x0 >= z1 - z0
  const half = (alongX ? z1 - z0 : x1 - x0) / 2
  const ridge = yE + half * pitch
  const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2
  const up: V3 = [0, 1, 0]
  if (alongX) {
    const ra = Math.min(mx, x0 + half), rb = Math.max(mx, x1 - half)
    poly(m, [[x0, yE, z1], [x1, yE, z1], [rb, ridge, mz], [ra, ridge, mz]], roof, MAT.roof, aux, up)
    poly(m, [[x1, yE, z0], [x0, yE, z0], [ra, ridge, mz], [rb, ridge, mz]], shade(roof, 0.95), MAT.roof, aux, up)
    poly(m, [[x0, yE, z0], [x0, yE, z1], [ra, ridge, mz]], shade(roof, 0.9), MAT.roof, aux, up)
    poly(m, [[x1, yE, z1], [x1, yE, z0], [rb, ridge, mz]], shade(roof, 0.9), MAT.roof, aux, up)
    if (rb > ra) poly(m, [[ra, ridge + 0.04, mz - 0.12], [rb, ridge + 0.04, mz - 0.12], [rb, ridge + 0.06, mz + 0.12], [ra, ridge + 0.06, mz + 0.12]], shade(roof, 1.25), MAT.roof, aux, up)
  } else {
    const ra = Math.min(mz, z0 + half), rb = Math.max(mz, z1 - half)
    poly(m, [[x1, yE, z0], [x1, yE, z1], [mx, ridge, rb], [mx, ridge, ra]], roof, MAT.roof, aux, up)
    poly(m, [[x0, yE, z1], [x0, yE, z0], [mx, ridge, ra], [mx, ridge, rb]], shade(roof, 0.95), MAT.roof, aux, up)
    poly(m, [[x0, yE, z1], [x1, yE, z1], [mx, ridge, rb]], shade(roof, 0.9), MAT.roof, aux, up)
    poly(m, [[x1, yE, z0], [x0, yE, z0], [mx, ridge, ra]], shade(roof, 0.9), MAT.roof, aux, up)
  }
  for (const [a, b] of [[[x0, z1], [x1, z1]], [[x1, z0], [x0, z0]], [[x0, z0], [x0, z1]], [[x1, z1], [x1, z0]]] as const) {
    const n: V3 = a[1] === b[1] ? [0, 0, a[1] === z1 ? 1 : -1] : [a[0] === x1 ? 1 : -1, 0, 0]
    poly(m, [[a[0], yE - 0.18, a[1]], [b[0], yE - 0.18, b[1]], [b[0], yE + 0.01, b[1]], [a[0], yE + 0.01, a[1]]], trim, MAT.lit, aux, n)
  }
  return ridge
}

/** A flat roof: deck, parapet and coping, with a vent box or water tank. */
function flat(m: Mesh, r: Rect, H: number, roof: Rgb, wall: Rgb, aux: number, rng: Rng, tank: boolean): void {
  const [x0, z0, x1, z1] = r
  m.box(x0 + 0.2, H, z0 + 0.2, x1 - 0.2, H + 0.12, z1 - 0.2, shade(roof, 0.8), MAT.roof, aux)
  const top = H + 0.55, cope = hex(0x7a766c)
  m.box(x0 - 0.05, H, z0 - 0.05, x1 + 0.05, top, z0 + 0.22, wall, MAT.roof, aux, cope)
  m.box(x0 - 0.05, H, z1 - 0.22, x1 + 0.05, top, z1 + 0.05, wall, MAT.roof, aux, cope)
  m.box(x0 - 0.05, H, z0 + 0.22, x0 + 0.22, top, z1 - 0.22, wall, MAT.roof, aux, cope)
  m.box(x1 - 0.22, H, z0 + 0.22, x1 + 0.05, top, z1 - 0.22, wall, MAT.roof, aux, cope)
  const cx = x0 + (x1 - x0) * (0.3 + rng.next() * 0.4), cz = z0 + (z1 - z0) * (0.3 + rng.next() * 0.3)
  if (tank) {
    for (const [dx, dz] of [[-0.55, -0.55], [0.55, -0.55], [-0.55, 0.55], [0.55, 0.55]]) m.box(cx + dx - 0.05, H + 0.12, cz + dz - 0.05, cx + dx + 0.05, H + 1.2, cz + dz + 0.05, hex(0x3a3630), MAT.roof, aux)
    m.prism(cx, cz, 0.8, 0.8, H + 1.2, H + 2.5, 10, hex(0x4e4234), MAT.roof, aux)
    m.prism(cx, cz, 0.85, 0.05, H + 2.5, H + 2.95, 10, hex(0x3a3028), MAT.roof, aux)
  } else {
    m.box(cx - 0.8, H + 0.12, cz - 0.6, cx + 0.8, H + 0.85, cz + 0.6, hex(0x585c60), MAT.roof, aux, hex(0x686c70))
  }
  m.prism(x1 - 1.2, z0 + 1.1, 0.12, 0.12, H + 0.12, H + 0.9, 6, hex(0x46484a), MAT.roof, aux)
}

// --- the house -------------------------------------------------------------------------------------------------------

type Mass = { rect: Rect; wing: boolean }

/** The house's roof masses: one block, or a main block and the garage wing standing forward of it. */
function masses(s: HouseStyle): Mass[] {
  const rects = s.rooms.map((r) => r.rect)
  const bb = (rs: readonly Rect[]): Rect => [Math.min(...rs.map((r) => r[0])), Math.min(...rs.map((r) => r[1])), Math.max(...rs.map((r) => r[2])), Math.max(...rs.map((r) => r[3]))]
  const all = bb(rects)
  const area = rects.reduce((a, r) => a + (r[2] - r[0]) * (r[3] - r[1]), 0)
  if (Math.abs(area - (all[2] - all[0]) * (all[3] - all[1])) < 0.05) return [{ rect: all, wing: false }]
  const main = s.rooms.filter((r) => r.type !== "garage").map((r) => r.rect)
  const wings = s.rooms.filter((r) => r.type === "garage").map((r) => ({ rect: r.rect, wing: true }))
  return [{ rect: bb(main), wing: false }, ...wings]
}

/** Where the porches stand in front of each front door (also keeps yard plants off them). */
export function porchRects(b: Building, town: Town): Rect[] {
  const s = b.style
  if (!s) return []
  const out: Rect[] = []
  const edges = boundaryEdges(s.rooms.map((r) => r.rect))
  for (const d of town.doors) {
    if (!d.id.startsWith(`${b.id}-front`)) continue
    const at = d.rect[3], cx = (d.rect[0] + d.rect[2]) / 2
    const e = edges.find((q) => q.axis === "x" && q.side > 0 && Math.abs(q.at - at) < 1e-3 && cx >= q.a0 && cx <= q.a1)
    const a0 = e?.a0 ?? b.rect[0], a1 = e?.a1 ?? b.rect[2]
    switch (s.porch) {
      case "shed":
        out.push([Math.max(a0, cx - 3.6), at, Math.min(a1, cx + 3.6), at + 2.0])
        break
      case "wrap": {
        out.push([a0 - 0.1, at, a1 + 0.1, at + 2.0])
        const east = (seedOf(b.id) & 1) === 1
        const depth = Math.min(b.rect[3] - b.rect[1], 6) * 0.65
        out.push(east ? [a1, at - depth, a1 + 2.0, at] : [a0 - 2.0, at - depth, a0, at])
        break
      }
      case "gable":
        out.push([cx - 1.75, at, cx + 1.75, at + 2.1])
        break
      case "deck":
        out.push([cx - 1.5, at, cx + 1.5, at + 1.9])
        break
      case "awning":
        out.push([Math.max(a0, cx - 3.4), at, Math.min(a1, cx + 3.4), at + 1.3])
        break
      default:
        out.push([cx - 1.0, at, cx + 1.0, at + 1.45])
    }
  }
  return out
}

export type StyledHouseOutput = {
  /** Overgrowth around a derelict or burnt home: [x, z, height, radius, seed]. */
  plants: [number, number, number, number, number][]
}

/**
 * The outside of a styled home into `m` (the chunk's main mesh, roofs tagged `aux = id`), porch decks, steps and
 * scaffolds into `low` (never cut).
 */
export function emitStyledHouse(m: Mesh, low: Mesh, b: Building, id: number, town: Town): StyledHouseOutput {
  const s = b.style!
  const rng = new Rng((seedOf(b.id) ^ Math.imul(town.houseSeed + 1, 0x9e3779b1)) >>> 0)
  const wall = hex(b.color), trim = hex(s.trim), roof = hex(s.roofColor)
  const rects = s.rooms.map((r) => r.rect)
  const edges = boundaryEdges(rects)
  const pieces = facadePieces(b, town, edges)
  const burnt = s.condition === "burnt", derelict = s.condition === "derelict", frame = s.condition === "construction"
  const plants: StyledHouseOutput["plants"] = []

  // Ground-floor siding, around the window bays.
  for (const p of pieces) {
    if (p.window) {
      clad(m, p.f, p.a0, p.a1, 0.37, 0.84, s, wall, rng, MAT.wall, 20)
      clad(m, p.f, p.a0, p.a1, 2.16, 2.78, s, wall, rng, MAT.wall, 20)
    } else clad(m, p.f, p.a0, p.a1, 0.37, 2.78, s, wall, rng, MAT.wall, 20)
    if (frame) {
      // Sheathing seams every 1.22 m.
      for (let u = Math.ceil(p.a0 / 1.22) * 1.22; u < p.a1; u += 1.22) faceQuad(m, p.f, u - 0.01, u + 0.01, 0.37, 2.78, 0.04, 0.04, shade(wall, 0.7), MAT.wall, 20)
    }
  }

  // Corner boards, or quoins on brick.
  const topOfWalls = s.storeys === 2 && !frame ? UPPER_TOP : WALL_TOP
  for (const e of edges) {
    const f: Face = { axis: e.axis, at: e.at, side: e.side }
    for (const [u, dir] of [[e.a0, 1], [e.a1, -1]] as const) {
      const ua = dir > 0 ? u : u - 0.14, ub = dir > 0 ? u + 0.14 : u
      if (s.siding === "brick") {
        for (let y = 0.37, k = 0; y < WALL_TOP - 0.1; y += 0.3, k++) {
          const w = k % 2 ? 0.2 : 0.34
          faceBox(m, f, dir > 0 ? u : u - w, dir > 0 ? u + w : u, y + 0.01, Math.min(WALL_TOP - 0.02, y + 0.28), 0, 0.03, shade(wall, 1.12), MAT.wall, 20)
        }
      } else if (s.siding !== "stucco") {
        faceBox(m, f, ua, ub, 0.37, WALL_TOP - 0.02, 0, 0.045, trim, MAT.wall, 20)
        if (topOfWalls > WALL_TOP) faceBox(m, f, ua, ub, WALL_TOP, topOfWalls, 0, 0.045, trim, MAT.lit, id)
      }
    }
  }

  // Shutters, boards and soot around the window bays; door surrounds.
  const shutterCol = s.shutters ? (s.trim === 0xc8c4b8 ? hex(rng.pick([0x2e3a2c, 0x3a2422, 0x26323a, 0x3a3a34])) : trim) : trim
  for (const p of pieces) {
    if (!p.window) continue
    const w = p.a1 - p.a0
    if (s.shutters && w > 0.7 && w < 1.5 && !burnt) {
      for (const [u0, u1] of [[p.a0 - 0.42, p.a0 - 0.06], [p.a1 + 0.06, p.a1 + 0.42]] as const) {
        if (derelict && rng.next() < 0.3) continue
        faceBox(m, p.f, u0, u1, 0.88, 2.12, 0.01, 0.045, shutterCol, MAT.wall, 20)
        for (let y = 1.0; y < 2.05; y += 0.18) faceQuad(m, p.f, u0 + 0.04, u1 - 0.04, y, y + 0.05, 0.05, 0.05, shade(shutterCol, 0.7), MAT.wall, 20)
      }
    }
    if (p.boarded) {
      const weathered = derelict || rng.next() < 0.5
      const col = weathered ? TIMBER : hex(0x8e6f48)
      const ys = [1.02, 1.42, 1.86]
      for (const y of ys) plank(m, p.f, p.a0 - 0.12, p.a1 + 0.12, y + (rng.next() - 0.5) * 0.06, (rng.next() - 0.5) * 0.16, 0.02, col, MAT.wall, 20)
      // From inside too.
      const inner: Face = { ...p.f, side: (p.f.side * -1) as 1 | -1, at: p.f.at - p.f.side * OUTER_WALL }
      for (const y of [1.2, 1.7]) plank(m, inner, p.a0 - 0.1, p.a1 + 0.1, y, (rng.next() - 0.5) * 0.1, 0.01, col, MAT.wall, 20)
    }
    if (burnt) poly(m, [P(p.f, p.a0 - 0.2, 2.16, 0.05), P(p.f, p.a1 + 0.2, 2.16, 0.05), P(p.f, p.a1 + 0.05, 2.76, 0.05), P(p.f, (p.a0 + p.a1) / 2, 2.6, 0.05), P(p.f, p.a0 - 0.05, 2.76, 0.05)], SOOT, MAT.wall, 20, outward(p.f))
  }
  for (const d of town.doors) {
    if (!d.id.startsWith(`${b.id}-front`) && d.id !== `${b.id}-back`) continue
    const front = d.id !== `${b.id}-back`
    const f: Face = { axis: "x", at: front ? d.rect[3] : d.rect[1], side: front ? 1 : -1 }
    if (!burnt) {
      faceBox(m, f, d.rect[0] - 0.14, d.rect[0], 0.13, 2.28, 0, 0.05, trim, MAT.wall, 20)
      faceBox(m, f, d.rect[2], d.rect[2] + 0.14, 0.13, 2.28, 0, 0.05, trim, MAT.wall, 20)
      faceBox(m, f, d.rect[0] - 0.2, d.rect[2] + 0.2, 2.18, 2.34, 0, 0.07, trim, MAT.wall, 20)
    } else poly(m, [P(f, d.rect[0] - 0.3, 2.1, 0.05), P(f, d.rect[2] + 0.3, 2.1, 0.05), P(f, d.rect[2], 2.76, 0.05), P(f, d.rect[0], 2.76, 0.05)], SOOT, MAT.wall, 20, outward(f))
    if (front && !burnt) {
      // Porch-light bracket under the lamp `planHouse` puts 0.55 m out.
      m.box(d.rect[0] + 0.67, 2.36, d.rect[3], d.rect[0] + 0.73, 2.42, d.rect[3] + 0.35, hex(0x2a2826), MAT.wall, 20)
    }
    if (!front) {
      // A concrete back step.
      low.box(d.rect[0] - 0.1, 0, d.rect[1] - 0.9, d.rect[2] + 0.1, 0.12, d.rect[1], hex(0x67635b), MAT.lit)
    }
  }

  // Burnt walls: a soot band along the top of every wall.
  if (burnt) for (const p of pieces) faceQuad(m, p.f, p.a0, p.a1, 2.2 + rng.next() * 0.2, 2.78, 0.045, 0.045, mix(SOOT, wall, 0.25), MAT.wall, 20)

  // Ivy up a derelict or burnt home's walls, and weeds round its foundation.
  if (derelict || burnt) {
    const walls = pieces.filter((p) => !p.window && p.a1 - p.a0 > 0.8)
    for (let k = 0; k < Math.min(walls.length, derelict ? 4 : 2); k++) {
      const p = walls[Math.floor(rng.next() * walls.length)]!
      let u = p.a0 + rng.next() * Math.max(0, p.a1 - p.a0 - 0.8), w = 0.5 + rng.next() * 0.6
      const top = 1.2 + rng.next() * 1.5
      for (let y = 0.2; y < top; y += 0.22) {
        const c = IVY[Math.floor(rng.next() * IVY.length)]!
        faceQuad(m, p.f, Math.max(p.a0, u), Math.min(p.a1, u + w), y, y + 0.26, 0.05, 0.05, c, MAT.wall, 20)
        u += (rng.next() - 0.5) * 0.3
        w = Math.max(0.15, w * (0.85 + rng.next() * 0.2))
      }
    }
    for (const e of edges) {
      const n = Math.floor((e.a1 - e.a0) / 2.6)
      for (let k = 0; k < n; k++) {
        if (rng.next() < 0.35) continue
        const u = e.a0 + (e.a1 - e.a0) * rng.next(), d = 0.4 + rng.next() * 0.5
        const [px, pz] = e.axis === "x" ? [u, e.at + e.side * d] : [e.at + e.side * d, u]
        plants.push([px, pz, Math.round((0.6 + rng.next() * 1.0) * 10) / 10, Math.round((0.45 + rng.next() * 0.35) * 20) / 20, Math.floor(rng.next() * 1e6)])
      }
    }
  }

  // Upper storey.
  const ms = masses(s)
  const main = ms.find((q) => !q.wing)!
  const two = s.storeys === 2
  if (two) {
    const H = UPPER_TOP
    const upperRng = new Rng(rng.next() * 1e9)
    for (const e of edges) {
      const f: Face = { axis: e.axis, at: e.at, side: e.side }
      if (frame) {
        // Bare studs, plates and the floor deck's edge.
        for (let u = e.a0 + 0.05; u < e.a1; u += 0.4) faceBox(m, f, u, u + 0.05, WALL_TOP, H - 0.1, -OUTER_WALL + 0.06, -0.06, PLY, MAT.lit, id)
        faceBox(m, f, e.a0, e.a1, H - 0.1, H, -OUTER_WALL + 0.04, -0.04, PLY, MAT.lit, id)
        faceBox(m, f, e.a0, e.a1, WALL_TOP, WALL_TOP + 0.24, -OUTER_WALL, 0.02, shade(PLY, 0.85), MAT.lit, id)
        continue
      }
      // Jagged where a burnt upper floor fell in.
      const segs = burnt ? Math.max(1, Math.round((e.a1 - e.a0) / 1.1)) : 1
      for (let k = 0; k < segs; k++) {
        const u0 = e.a0 + ((e.a1 - e.a0) * k) / segs, u1 = e.a0 + ((e.a1 - e.a0) * (k + 1)) / segs
        const top = burnt ? WALL_TOP + 0.3 + upperRng.next() * (H - WALL_TOP - 0.3) : H
        faceBox(m, f, u0, u1, WALL_TOP, top, -OUTER_WALL, 0, burnt ? mix(wall, SOOT, 0.55) : wall, MAT.lit, id)
        if (!burnt && s.siding !== "brick" && s.siding !== "stucco") {
          for (let y = WALL_TOP + 0.18; y < top - 0.05; y += s.siding === "shingle" ? 0.28 : 0.2) faceQuad(m, f, u0, u1, y, Math.min(top, y + (s.siding === "shingle" ? 0.28 : 0.2)), 0.03, 0.006, shade(wall, 0.96 + upperRng.next() * 0.06), MAT.lit, id)
        } else if (!burnt && s.siding === "brick") {
          for (let y = WALL_TOP + 0.3; y < top - 0.05; y += 0.3) faceQuad(m, f, u0, u1, y, y + 0.014, 0.006, 0.006, shade(mix(wall, hex(0x8a8478), 0.55), 1), MAT.lit, id)
        }
      }
      // Belt course between the floors.
      faceBox(m, f, e.a0 - 0.04, e.a1 + 0.04, WALL_TOP + 0.01, WALL_TOP + 0.16, 0, 0.06, trim, MAT.lit, id)
      // Upper windows over the ground floor's, and over the front door.
      const spots: [number, number][] = []
      for (const p of pieces) if (p.window && p.f.axis === e.axis && p.f.side === e.side && Math.abs(p.f.at - e.at) < 1e-3) spots.push([(p.a0 + p.a1) / 2, Math.min(1.15, p.a1 - p.a0)])
      if (e.axis === "x" && e.side > 0) for (const d of town.doors) if (d.id.startsWith(`${b.id}-front`) && Math.abs(d.rect[3] - e.at) < 1e-3) spots.push([(d.rect[0] + d.rect[2]) / 2, 1.0])
      if (s.form === "apartment" || s.form === "corner_store") for (let u = e.a0 + 1.4; u < e.a1 - 1.0; u += 2.4) spots.push([u, 1.1])
      spots.sort((p, q) => p[0] - q[0])
      const kept: [number, number][] = []
      for (const sp of spots) if (sp[1] > 0.6 && !kept.some((k) => Math.abs(k[0] - sp[0]) < 1.4) && sp[0] - sp[1] / 2 > e.a0 + 0.3 && sp[0] + sp[1] / 2 < e.a1 - 0.3) kept.push(sp)
      for (const [uc, w] of kept) {
        const u0 = uc - w / 2, u1 = uc + w / 2, y0 = WALL_TOP + 0.85, y1 = WALL_TOP + 2.05
        if (burnt) {
          faceQuad(m, f, u0, u1, y0, Math.min(y1, H - 0.3), 0.01, 0.01, hex(0x080706), MAT.lit, id)
          continue
        }
        faceBox(m, f, u0 - 0.08, u1 + 0.08, y0 - 0.08, y1 + 0.1, 0, 0.04, trim, MAT.lit, id)
        const lit = upperRng.next() < 0.18 && !derelict
        faceQuad(m, f, u0, u1, y0, y1, 0.045, 0.045, lit ? hex(0x6a5030) : hex(0x161a1e), MAT.lit, id)
        faceBox(m, f, uc - 0.02, uc + 0.02, y0, y1, 0.045, 0.06, trim, MAT.lit, id)
        faceBox(m, f, u0, u1, (y0 + y1) / 2 - 0.02, (y0 + y1) / 2 + 0.02, 0.045, 0.06, trim, MAT.lit, id)
        faceBox(m, f, u0 - 0.1, u1 + 0.1, y0 - 0.12, y0 - 0.04, 0, 0.09, trim, MAT.lit, id)
        if (s.shutters) for (const [a, c] of [[u0 - 0.44, u0 - 0.08], [u1 + 0.08, u1 + 0.44]] as const) faceBox(m, f, a, c, y0, y1, 0.01, 0.045, shutterCol, MAT.lit, id)
        if (derelict && upperRng.next() < 0.6) for (const y of [y0 + 0.3, y0 + 0.8]) plank(m, f, u0 - 0.1, u1 + 0.1, y, (upperRng.next() - 0.5) * 0.2, 0.05, TIMBER, MAT.lit, id)
      }
    }
  }

  // Roofs.
  let chimneyAt: V3 | null = null
  for (const mass of ms) {
    const r = mass.rect
    const H = !mass.wing && two ? UPPER_TOP : WALL_TOP
    const shape: RoofShape = mass.wing ? "gable" : burnt || frame ? (s.roof === "hip" || s.roof === "cross" ? "gable" : s.roof === "flat" ? "flat" : s.roof) : s.roof
    const pitch = s.form === "shotgun" ? 0.85 : s.form === "ranch" ? 0.42 : s.form === "farmhouse" ? 0.8 : 0.62
    const start = m.v.length
    if (shape === "flat") {
      flat(m, r, H, roof, wall, id, rng, s.form === "apartment" && rng.next() < 0.5)
      if (!mass.wing) chimneyAt = null
      continue
    }
    if (shape === "hip") {
      const ridge = hip(m, r, H, pitch, roof, trim, id)
      if (!mass.wing && s.chimney > 0) chimneyAt = [r[0] + (r[2] - r[0]) * s.chimney, ridge, (r[1] + r[3]) / 2 - 0.4]
      if (derelict) sag(m, start, r, H, ridge)
      continue
    }
    // Wings and shotguns gable toward the street; others run their ridge along the longer side (sheds always along x).
    const alongX = mass.wing ? false : shape === "shed" ? true : r[2] - r[0] >= r[3] - r[1]
    const slicesFor = (): RoofOpts["slices"] => {
      if (burnt) {
        const st = Array.from({ length: 40 }, () => (rng.next() < 0.45 ? "hole" : "roof") as "hole" | "roof")
        return (k) => st[k]!
      }
      if (frame) {
        const done = rng.next() * 0.5
        return (k) => (k / 12 < done ? "roof" : k / 12 < done + 0.3 ? "tarp" : "frame")
      }
      return undefined
    }
    const o: RoofOpts = {
      frame: alongX ? alongXFrame : alongZFrame,
      u0: alongX ? r[0] : r[1],
      u1: alongX ? r[2] : r[3],
      v0: alongX ? r[1] : r[0],
      v1: alongX ? r[3] : r[2],
      H,
      shape,
      pitch,
      roof,
      wall: burnt ? mix(wall, SOOT, 0.5) : wall,
      trim,
      aux: id,
      endU0: !mass.wing,
      endU1: true,
      runIn: mass.wing ? 1.6 : undefined,
      slices: slicesFor(),
    }
    const { ridge, pr } = pitched(m, o, rng)
    if (shape === "cross" && alongX && !mass.wing) {
      // A front-facing gable over part of the street side.
      const g = Math.min(4.6, (r[2] - r[0]) * 0.42)
      const left = rng.next() < 0.5
      const ga = left ? r[0] + 0.6 : r[2] - 0.6 - g
      pitched(m, { ...o, frame: alongZFrame, u0: (r[1] + r[3]) / 2, u1: r[3], v0: ga, v1: ga + g, shape: "gable", endU0: false, endU1: true, runIn: 0 }, rng)
    }
    if (!mass.wing && s.chimney > 0) {
      const u = o.u0 + (o.u1 - o.u0) * s.chimney
      const vm = (o.v0 + o.v1) / 2 - 0.4
      const top = shape === "shed" ? profileAt(pr, vm) : ridge
      chimneyAt = alongX ? [u, top, vm] : [vm, top, u]
    }
    if (derelict) sag(m, start, r, H, ridge)
    // Missing shingles on a derelict roof.
    if (derelict && shape !== "shed") {
      for (let k = 0; k < 5; k++) {
        const u = o.u0 + 0.5 + rng.next() * Math.max(0, o.u1 - o.u0 - 1.6), w = 0.5 + rng.next() * 0.9
        const v = o.v0 + 0.3 + rng.next() * Math.max(0, (o.v1 - o.v0) / 2 - 1.0)
        const side = rng.next() < 0.5 ? 1 : -1
        const vA = side > 0 ? v : o.v1 - (v - o.v0), vB = vA + 0.5 + rng.next() * 0.5
        const F = o.frame
        const yA = profileAt(pr, vA) + 0.03, yB = profileAt(pr, vB) + 0.03
        poly(m, [F(u, yA, vA), F(u + w, yA, vA), F(u + w, yB, vB), F(u, yB, vB)], DARK_GAP, MAT.roof, id, [0, 1, 0])
      }
    }
  }
  if (chimneyAt) {
    const [cx, top, cz] = chimneyAt
    const brick = hex(rng.pick([0x684536, 0x5c4034, 0x6e5040]))
    m.box(cx - 0.42, WALL_TOP + 0.02, cz - 0.32, cx + 0.42, top + 0.7, cz + 0.32, burnt ? mix(brick, SOOT, 0.5) : brick, MAT.brick, id)
    m.box(cx - 0.5, top + 0.7, cz - 0.4, cx + 0.5, top + 0.82, cz + 0.4, hex(0x55524c), MAT.roof, id)
    m.box(cx - 0.12, top + 0.82, cz - 0.12, cx + 0.12, top + 1.0, cz + 0.12, hex(0x3a3a38), MAT.roof, id)
  }

  // Porch.
  if (!burnt) emitPorch(m, low, b, id, town, s, wall, trim, roof, rng)
  else {
    // A burnt porch: charred deck and a post or two left leaning.
    for (const r of porchRects(b, town)) {
      low.box(r[0], 0, r[1], r[2], 0.12, r[3], CHAR, MAT.lit)
      if (r[3] - r[1] > 1.6) low.yawBox(r[0] + 0.3, r[3] - 0.25, 0.14, 0.14, 0.1, 1.4 + rng.next(), 0.3, CHAR, MAT.lit)
    }
  }

  // Garage doors on the garage rooms' street walls.
  for (const room of s.rooms) {
    if (room.type !== "garage") continue
    const e = edges.find((q) => q.axis === "x" && q.side > 0 && Math.abs(q.at - room.rect[3]) < 1e-3 && q.a0 <= room.rect[0] + 1e-3 && q.a1 >= room.rect[2] - 1e-3)
    if (!e) continue
    const f: Face = { axis: "x", at: e.at, side: 1 }
    const cx = (room.rect[0] + room.rect[2]) / 2, w = Math.min(2.7, room.rect[2] - room.rect[0] - 1.0)
    const panel = burnt ? CHAR : derelict ? hex(0x8c887a) : hex(rng.pick([0xc0bcae, 0xa8a496, 0x8a6e52]))
    faceBox(m, f, cx - w / 2 - 0.12, cx + w / 2 + 0.12, 0.13, 2.3, 0, 0.05, trim, MAT.wall, 20)
    faceBox(m, f, cx - w / 2, cx + w / 2, 0.15, 2.18, 0.03, 0.07, panel, MAT.wall, 20)
    for (let y = 0.65; y < 2.1; y += 0.5) faceQuad(m, f, cx - w / 2 + 0.05, cx + w / 2 - 0.05, y, y + 0.03, 0.075, 0.075, shade(panel, 0.72), MAT.wall, 20)
    if (derelict) faceQuad(m, f, cx - w / 2 + 0.1, cx - w / 2 + 0.9, 0.15, 0.55, 0.08, 0.08, DARK_GAP, MAT.wall, 20)
    // Concrete apron out to the street side.
    low.quad([cx - w / 2 - 0.3, 0.04, e.at + 3.2], [cx + w / 2 + 0.3, 0.04, e.at + 3.2], [cx + w / 2 + 0.3, 0.04, e.at], [cx - w / 2 - 0.3, 0.04, e.at], [0, 1, 0], hex(0x75716a), MAT.ground, 2)
  }

  // Scaffold along the street face of a house going up.
  if (frame) {
    const e = edges.filter((q) => q.axis === "x" && q.side > 0).sort((p, q) => q.a1 - q.a0 - (p.a1 - p.a0))[0]
    if (e) {
      const doors = town.doors.filter((d) => d.id.startsWith(`${b.id}-front`))
      const pole = hex(0x5a5c5e), board = hex(0x7a6448)
      const z0 = e.at + 0.35, z1 = e.at + 1.15, top = two ? UPPER_TOP - 0.4 : 3.2
      const clear = (u: number) => !doors.some((d) => u > d.rect[0] - 0.4 && u < d.rect[2] + 0.4)
      for (let u = e.a0 + 0.2; u <= e.a1 - 0.1; u += 2.0) {
        if (!clear(u)) continue
        for (const z of [z0, z1]) low.box(u - 0.03, 0, z - 0.03, u + 0.03, top, z + 0.03, pole, MAT.shiny)
        low.box(u - 0.03, 1.4, z0, u + 0.03, 1.45, z1, pole, MAT.shiny)
      }
      for (const y of two ? [1.45, 3.0] : [1.45]) {
        let u = e.a0
        while (u < e.a1) {
          const u1 = Math.min(e.a1, u + 2.0)
          if (clear((u + u1) / 2)) low.box(u, y, z0 - 0.05, u1, y + 0.05, z1 + 0.05, board, MAT.timber)
          u = u1
        }
      }
    }
  }
  return { plants }
}

/** A derelict roof sags in the middle of its run. */
function sag(m: Mesh, from: number, r: Rect, H: number, ridge: number): void {
  const alongX = r[2] - r[0] >= r[3] - r[1]
  const a0 = alongX ? r[0] : r[1], a1 = alongX ? r[2] : r[3]
  for (let i = from; i < m.v.length; i += 11) {
    const y = m.v[i + 1]!
    if (y <= H) continue
    const u = alongX ? m.v[i]! : m.v[i + 2]!
    const t = Math.max(0, Math.min(1, (u - a0) / Math.max(0.01, a1 - a0)))
    const lift = Math.max(0, Math.min(1, (y - H) / Math.max(0.1, ridge - H)))
    m.v[i + 1] = y - 0.32 * Math.sin(Math.PI * t) * lift
  }
}

/** The porch by style: stoop, door hood, gabled porch, shed porch, wraparound, trailer deck, or shop awning. */
function emitPorch(m: Mesh, low: Mesh, b: Building, id: number, town: Town, s: HouseStyle, wall: Rgb, trim: Rgb, roof: Rgb, rng: Rng): void {
  const deck = hex(rng.pick([0x5e4a34, 0x544636, 0x66523a])), concrete = hex(0x6e6a62), post = trim
  const derelict = s.condition === "derelict"
  const rects = porchRects(b, town)
  const doors = town.doors.filter((d) => d.id.startsWith(`${b.id}-front`))
  doors.forEach((d, i) => {
    const r = rects[i]
    if (!r) return
    const at = d.rect[3], cx = (d.rect[0] + d.rect[2]) / 2
    const steps = (x0: number, x1: number, z: number) => low.box(x0, 0, z, x1, 0.07, z + 0.36, s.porch === "stoop" || s.porch === "hood" || s.porch === "awning" ? concrete : deck, MAT.lit)
    const posts = (x0: number, x1: number, z: number, h: number) => {
      const n = Math.max(1, Math.round((x1 - x0) / 2.3))
      for (let k = 0; k <= n; k++) {
        const x = x0 + ((x1 - x0) * k) / n
        if (derelict && k > 0 && k < n && rng.next() < 0.3) continue
        low.box(x - 0.07, 0.15, z - 0.14, x + 0.07, h, z, post, MAT.lit)
      }
    }
    const rail = (x0: number, x1: number, z: number) => {
      if (x1 - x0 < 0.4) return
      low.box(x0, 0.86, z - 0.1, x1, 0.92, z - 0.04, post, MAT.lit)
      for (let x = x0 + 0.15; x < x1 - 0.05; x += 0.3) low.box(x - 0.02, 0.15, z - 0.09, x + 0.02, 0.86, z - 0.05, shade(post, 0.9), MAT.lit)
    }
    switch (s.porch) {
      case "none":
        low.box(cx - 0.8, 0, at, cx + 0.8, 0.1, at + 0.7, concrete, MAT.lit)
        return
      case "stoop":
      case "hood": {
        low.box(r[0], 0, r[1], r[2], 0.13, r[3] - 0.36, concrete, MAT.lit)
        steps(r[0] + 0.2, r[2] - 0.2, r[3] - 0.36)
        if (s.porch === "hood") {
          const x0 = cx - 0.95, x1 = cx + 0.95, z1 = at + 0.95, y0 = 2.32, y1 = 2.66
          poly(m, [[x0, y0, at], [x0, y0, z1], [cx, y1, z1], [cx, y1, at]], roof, MAT.roof, id, [0, 1, 0])
          poly(m, [[x1, y0, z1], [x1, y0, at], [cx, y1, at], [cx, y1, z1]], roof, MAT.roof, id, [0, 1, 0])
          poly(m, [[x0 + 0.05, y0, z1 - 0.02], [x1 - 0.05, y0, z1 - 0.02], [cx, y1 - 0.03, z1 - 0.02]], wall, MAT.roof, id, [0, 0, 1])
          for (const x of [x0 + 0.1, x1 - 0.1]) m.box(x - 0.04, 2.0, at, x + 0.04, y0, at + 0.5, trim, MAT.wall, 20)
        }
        return
      }
      case "gable": {
        low.box(r[0], 0, r[1], r[2], 0.16, r[3] - 0.36, deck, MAT.timber)
        steps(cx - 0.7, cx + 0.7, r[3] - 0.36)
        const zf = r[3] - 0.4, y0 = 2.3, y1 = 2.3 + (r[2] - r[0]) * 0.28
        posts(r[0] + 0.12, r[2] - 0.12, zf, y0)
        rail(r[0] + 0.15, cx - 0.75, zf)
        rail(cx + 0.75, r[2] - 0.15, zf)
        const x0 = r[0] - 0.15, x1 = r[2] + 0.15, z1 = zf + 0.3
        poly(m, [[x0, y0, at], [x0, y0, z1], [cx, y1, z1], [cx, y1, at]], roof, MAT.roof, id, [0, 1, 0])
        poly(m, [[x1, y0, z1], [x1, y0, at], [cx, y1, at], [cx, y1, z1]], roof, MAT.roof, id, [0, 1, 0])
        poly(m, [[r[0], y0, zf + 0.05], [r[2], y0, zf + 0.05], [cx, y1 - 0.06, zf + 0.05]], wall, MAT.roof, id, [0, 0, 1])
        m.box(r[0], y0 - 0.2, zf - 0.14, r[2], y0, zf + 0.04, trim, MAT.roof, id)
        return
      }
      case "shed":
      case "wrap": {
        const zf = at + 1.9
        low.box(r[0], 0, at, r[2], 0.16, zf, deck, MAT.timber)
        steps(cx - 0.7, cx + 0.7, zf)
        posts(r[0] + 0.1, r[2] - 0.1, zf, 2.22)
        rail(r[0] + 0.15, cx - 0.75, zf)
        rail(cx + 0.75, r[2] - 0.15, zf)
        const roofAt = (x0: number, x1: number, z0: number, z1: number, dir: "s" | "e" | "w") => {
          const hi = 2.52, lo = 2.2
          if (dir === "s") poly(m, [[x0, hi, z0], [x1, hi, z0], [x1, lo, z1], [x0, lo, z1]], roof, MAT.roof, id, [0, 1, 0])
          else if (dir === "e") poly(m, [[x0, hi, z0], [x0, hi, z1], [x1, lo, z1], [x1, lo, z0]], roof, MAT.roof, id, [0, 1, 0])
          else poly(m, [[x1, hi, z0], [x1, hi, z1], [x0, lo, z1], [x0, lo, z0]], roof, MAT.roof, id, [0, 1, 0])
        }
        roofAt(r[0] - 0.2, r[2] + 0.2, at, zf + 0.25, "s")
        m.box(r[0] - 0.2, 2.06, zf - 0.14, r[2] + 0.2, 2.22, zf, trim, MAT.roof, id)
        const side = s.porch === "wrap" && i === 0 ? rects[1] : undefined
        if (side) {
          const east = side[0] >= r[2] - 0.2
          low.box(side[0], 0, side[1], side[2], 0.16, side[3], deck, MAT.timber)
          const xf = east ? side[2] : side[0]
          for (let z = side[1] + 0.1; z <= side[3]; z += 2.1) low.box(xf - 0.07, 0.15, z, xf + 0.07, 2.22, z + 0.14, post, MAT.lit)
          for (let z = side[1] + 0.15; z < side[3] - 0.1; z += 0.3) low.box(xf - 0.02, 0.15, z - 0.02, xf + 0.02, 0.86, z + 0.02, shade(post, 0.9), MAT.lit)
          low.box(xf - 0.04, 0.86, side[1], xf + 0.04, 0.92, side[3], post, MAT.lit)
          roofAt(east ? side[0] : side[0] - 0.25, east ? side[2] + 0.25 : side[2], side[1] - 0.2, side[3], east ? "e" : "w")
        }
        return
      }
      case "deck": {
        low.box(r[0], 0, r[1], r[2], 0.2, r[3] - 0.4, deck, MAT.timber)
        steps(cx - 0.6, cx + 0.6, r[3] - 0.4)
        for (const x of [r[0] + 0.05, r[2] - 0.05]) {
          for (let z = r[1] + 0.15; z < r[3] - 0.5; z += 0.3) low.box(x - 0.02, 0.2, z - 0.02, x + 0.02, 0.95, z + 0.02, shade(deck, 0.9), MAT.lit)
          low.box(x - 0.04, 0.95, r[1], x + 0.04, 1.0, r[3] - 0.4, deck, MAT.lit)
        }
        // A tin awning over the door.
        poly(m, [[cx - 1.1, 2.35, at], [cx + 1.1, 2.35, at], [cx + 1.1, 2.15, at + 1.1], [cx - 1.1, 2.15, at + 1.1]], hex(0x8e9290), MAT.roof, id, [0, 1, 0])
        return
      }
      case "awning": {
        low.box(r[0], 0, r[1], r[2], 0.1, r[3], concrete, MAT.lit)
        const a = hex(rng.pick([0x6e2c26, 0x2e4a3a, 0x2c3a52])), bone = hex(0xa89c84)
        const n = Math.max(2, Math.round((r[2] - r[0]) / 0.55))
        for (let k = 0; k < n; k++) {
          const x0 = r[0] + ((r[2] - r[0]) * k) / n, x1 = r[0] + ((r[2] - r[0]) * (k + 1)) / n
          const c = derelict && rng.next() < 0.2 ? null : k % 2 ? bone : a
          if (!c) continue
          poly(m, [[x0, 2.62, at], [x1, 2.62, at], [x1, 2.12, at + 1.25], [x0, 2.12, at + 1.25]], c, MAT.roof, id, [0, 1, 0])
          poly(m, [[x0, 2.12, at + 1.25], [x1, 2.12, at + 1.25], [x1, 1.9, at + 1.25], [x0, 1.9, at + 1.25]], shade(c, 0.85), MAT.roof, id, [0, 0, 1])
        }
        return
      }
    }
  })
}
