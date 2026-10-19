import { ACCESS_ROAD, COUNTY_ROAD, FENCE, PARKING_LOT, WORLD_HALF, accessRoadSamples, countyRoadSamples } from "../../world/layout"
import { heightAt } from "../../world/height"
import { Line } from "../../world/roads/util"
import { HA, HC, asphaltY, junctionFor } from "../../world/roads/surface"
import { LOT_Y, stall } from "../../world/compound/lot"

// The drive, derived from the road data the roads module builds from (layout centre lines, widths, the junction and
// the lot's stall grid); nothing is hand-placed. The car's rear axle follows a lane line:
//   - the county road's westbound lane (north half), from START_X east of the junction;
//   - a circular fillet, then clothoid-like after smoothing, onto the access road's northbound lane;
//   - the access road's northbound lane all the way up its centre line (which continues through the gate and up the
//     lot's centre aisle);
//   - a smooth S (cubic Hermite, curvature ≤ 1/MIN_R) from the aisle lane into the front-row stall nearest the aisle,
//     straight for the last few metres, nose to the wheel stop.
// The line is resampled every STEP m and smoothed (curvature ramps instead of steps). The body follows the rear axle
// (front swings wide through bends, as a real car's does), sits on the road surface under its four tyres (crowned
// asphalt, terrain, lot), and the speed profile is limited by lateral acceleration and the gate / lot / stall zones, then
// integrated with real acceleration and braking limits. `scripts/intro/route-check.ts` checks it against the road,
// the trees, the colliders and the terrain.

export const STEP = 0.25
/** Rear-axle lane offsets from the centre lines (m, + = right-hand side of travel). */
export const LANE = { access: 1.6, county: 1.75 }
/** The car's geometry (car_sedan_b): rear axle behind the centre, wheelbase, track, half width/length. */
export const CAR = { rear: 1.27, wheelbase: 2.73, track: 1.58, halfW: 1.0, halfL: 2.55 }
/** Start on the county road this far east of the junction (m). */
const START_X = 46
/** Fillet radius for the turn off the county road (the flare's kerb radius is 9 m at the asphalt edge). */
const TURN_R = 11
/** Tightest radius allowed for the parking S (rear axle). */
const MIN_R = 7.5
/** Straight run before the car stops in the stall (m of rear-axle travel). */
const STALL_STRAIGHT = 3.6
/** Smoothing kernel σ (m). */
const SMOOTH = 1.8

const STALL = stall(0, 1, 0)
/** Where the car ends up: front row (row 0) east side, the stall nearest the aisle; facing north, nose at the stop. */
export const PARKED = { x: STALL.x, z: STALL.z + 0.1, yaw: 0 }

export type RouteSample = {
  /** Car centre. */
  x: number
  z: number
  /** Heading as a model yaw (0 = north, positive turns left). */
  yaw: number
  /** Car root height (centre of the four tyre contacts) and the body's tilt from them. */
  y: number
  pitch: number
  roll: number
  speed: number
  /** Longitudinal acceleration (m/s², + speeding up). */
  accel: number
  /** Signed rear-axle path curvature (1/m, + turning left). */
  curvature: number
  /** Distance travelled (m). */
  s: number
}

type P = { x: number; z: number }

export const accessLine = () => new Line(accessRoadSamples(1))
export const countyLine = () => new Line(countyRoadSamples(-WORLD_HALF, WORLD_HALF, 1))

/** Nearest-point projection onto a road Line through a coarse grid: arc length, signed offset (+ = Line's right). */
export class Projector {
  private grid = new Map<number, number[]>()
  constructor(readonly line: Line, private cell = 6) {
    line.pts.forEach((p, i) => {
      const k = this.key(Math.floor(p.x / cell), Math.floor(p.z / cell))
      const l = this.grid.get(k)
      if (l) l.push(i)
      else this.grid.set(k, [i])
    })
  }
  private key(i: number, j: number) {
    return (i + 4096) * 8192 + (j + 4096)
  }
  /** {s, u, d}: arc length and signed lateral offset of the nearest point; d = |u| (Infinity when far from the line). */
  project(x: number, z: number) {
    const pts = this.line.pts
    let best = Infinity
    let bi = -1
    const ci = Math.floor(x / this.cell)
    const cj = Math.floor(z / this.cell)
    for (let i = ci - 2; i <= ci + 2; i++)
      for (let j = cj - 2; j <= cj + 2; j++)
        for (const k of this.grid.get(this.key(i, j)) ?? []) {
          const p = pts[k]!
          const d = (p.x - x) ** 2 + (p.z - z) ** 2
          if (d < best) {
            best = d
            bi = k
          }
        }
    if (bi < 0) return { s: 0, u: 0, d: Infinity }
    // Refine on the two neighbouring segments.
    let out = { s: pts[bi]!.s, u: 0, d: Infinity }
    for (const a of [bi - 1, bi]) {
      const A = pts[a]
      const B = pts[a + 1]
      if (!A || !B) continue
      const ex = B.x - A.x
      const ez = B.z - A.z
      const L2 = ex * ex + ez * ez || 1
      const t = Math.max(0, Math.min(1, ((x - A.x) * ex + (z - A.z) * ez) / L2))
      const qx = A.x + ex * t
      const qz = A.z + ez * t
      const d = Math.hypot(x - qx, z - qz)
      if (d < out.d) {
        // Line.offset: +u along n = (-tz, tx).
        const L = Math.sqrt(L2)
        const u = ((x - qx) * -ez + (z - qz) * ex) / L
        out = { s: A.s + (B.s - A.s) * t, u, d }
      }
    }
    return out
  }
}

/** The road and lot surface the tyres roll on: crowned asphalt, the lot pad, else the terrain. */
export function createSurface() {
  const access = accessLine()
  const county = countyLine()
  const j = junctionFor(access, county)
  const pa = new Projector(access)
  const pc = new Projector(county)
  const accessCrown = (s: number) => {
    const t = Math.min(Math.max((s - j.sStart) / 12, 0), 1, (j.sEnd - s) / 14)
    return t * t * (3 - 2 * t)
  }
  const inLot = (x: number, z: number) => x >= PARKING_LOT.min[0] && x <= PARKING_LOT.max[0] && z >= PARKING_LOT.min[1] && z <= PARKING_LOT.max[1]
  const at = (x: number, z: number) => {
    if (inLot(x, z)) return LOT_Y
    const g = heightAt(x, z)
    const a = pa.project(x, z)
    if (a.d <= HA && a.s >= j.sStart && a.s <= j.sEnd) return g + asphaltY(a.u, HA, accessCrown(a.s))
    const c = pc.project(x, z)
    if (c.d <= HC) return g + asphaltY(c.u, HC, 1)
    // Junction flares and gravel shoulders: the asphalt's flat edge height on the terrain.
    if (c.d < HC + 10 && a.d < HA + 10) return g + 0.03
    return g
  }
  return { at, access, county, junction: j, pa, pc, inLot }
}

function lanePolyline(line: Line, u: number, s0: number, s1: number): P[] {
  const out: P[] = []
  const dir = s1 >= s0 ? 1 : -1
  for (let s = s0; dir > 0 ? s <= s1 : s >= s1; s += dir * STEP) {
    const [x, z] = line.offset(s, u)
    out.push({ x, z })
  }
  return out
}

/** Intersection of two polylines (first hit along `a`): indices and point. */
function intersect(a: P[], b: P[]) {
  for (let i = 0; i < a.length - 1; i++)
    for (let k = 0; k < b.length - 1; k++) {
      const p = a[i]!, p2 = a[i + 1]!, q = b[k]!, q2 = b[k + 1]!
      const rx = p2.x - p.x, rz = p2.z - p.z, sx = q2.x - q.x, sz = q2.z - q.z
      const den = rx * sz - rz * sx
      if (Math.abs(den) < 1e-9) continue
      const t = ((q.x - p.x) * sz - (q.z - p.z) * sx) / den
      const w = ((q.x - p.x) * rz - (q.z - p.z) * rx) / den
      if (t >= 0 && t <= 1 && w >= 0 && w <= 1) return { i, k, x: p.x + rx * t, z: p.z + rz * t }
    }
  return null
}

/** Circular fillet of radius R joining polyline `a` (in) to `b` (out) at their crossing. */
function fillet(a: P[], b: P[], R: number): P[] {
  const hit = intersect(a, b)
  if (!hit) throw new Error("intro route: lanes don't cross")
  const dirAt = (pl: P[], i: number) => {
    const p = pl[Math.max(0, i - 8)]!
    const q = pl[Math.min(pl.length - 1, i + 8)]!
    const l = Math.hypot(q.x - p.x, q.z - p.z) || 1
    return { x: (q.x - p.x) / l, z: (q.z - p.z) / l }
  }
  const da = dirAt(a, hit.i)
  const db = dirAt(b, hit.k)
  const theta = Math.acos(Math.max(-1, Math.min(1, da.x * db.x + da.z * db.z)))
  const trim = R * Math.tan(theta / 2)
  const ia = hit.i - Math.round(trim / STEP)
  const ib = hit.k + 1 + Math.round(trim / STEP)
  const A = a[ia]!
  const B = b[ib]!
  const bis = { x: db.x - da.x, z: db.z - da.z }
  const bl = Math.hypot(bis.x, bis.z) || 1
  const c = { x: hit.x + (bis.x / bl) * (R / Math.cos(theta / 2)), z: hit.z + (bis.z / bl) * (R / Math.cos(theta / 2)) }
  let a0 = Math.atan2(A.z - c.z, A.x - c.x)
  let a1 = Math.atan2(B.z - c.z, B.x - c.x)
  while (a1 - a0 > Math.PI) a1 -= Math.PI * 2
  while (a1 - a0 < -Math.PI) a1 += Math.PI * 2
  const n = Math.max(2, Math.ceil((Math.abs(a1 - a0) * R) / STEP))
  const arc: P[] = []
  for (let k = 1; k < n; k++) {
    const t = a0 + ((a1 - a0) * k) / n
    arc.push({ x: c.x + Math.cos(t) * R, z: c.z + Math.sin(t) * R })
  }
  return [...a.slice(0, ia + 1), ...arc, ...b.slice(ib)]
}

/** The rear-axle centre line from the start on the county road to the stall. */
export function axleLine(): P[] {
  const access = accessLine()
  const county = countyLine()
  // County westbound: the Line runs east, so the north (right-hand, westbound) side is -u; travel is decreasing s.
  let sStart = 0
  for (const p of county.pts) if (p.x <= START_X) sStart = p.s
  const sx0 = county.pts.find((p) => p.x >= -20)!.s
  const west = lanePolyline(county, -LANE.county, sStart, sx0)
  // Access northbound: the Line runs north, +u is east (right-hand). Its centre line runs on up the lot aisle.
  const north = lanePolyline(access, LANE.access, 0, access.length)
  let line = fillet(west, north, TURN_R)
  // Into the stall: leave the aisle lane at zA, arrive on the stall's centre line at zB heading north.
  const endZ = PARKED.z + CAR.rear
  const zB = endZ + STALL_STRAIGHT
  const last = line[line.length - 1]!
  const dx = PARKED.x - last.x
  // Cubic Hermite (both ends heading north): peak curvature 6·dx/L², so L = √(6·dx·MIN_R).
  const L = Math.sqrt(6 * Math.abs(dx) * MIN_R)
  const zA = zB + L
  const cut = line.findIndex((p) => p.z <= zA)
  line = line.slice(0, cut)
  const x0 = line[line.length - 1]!.x
  const n = Math.ceil(L / STEP)
  for (let k = 1; k <= n; k++) {
    const t = k / n
    const h = t * t * (3 - 2 * t)
    line.push({ x: x0 + (PARKED.x - x0) * h, z: zA - L * t })
  }
  for (let z = zB - STEP; z >= endZ - 1e-6; z -= STEP) line.push({ x: PARKED.x, z })
  line.push({ x: PARKED.x, z: endZ })
  return smooth(resample(line, STEP), SMOOTH / STEP)
}

function resample(pts: P[], step: number): P[] {
  const out: P[] = [pts[0]!]
  let carry = 0
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!
    const b = pts[i]!
    const L = Math.hypot(b.x - a.x, b.z - a.z)
    let d = step - carry
    while (d <= L) {
      out.push({ x: a.x + ((b.x - a.x) * d) / L, z: a.z + ((b.z - a.z) * d) / L })
      d += step
    }
    carry = L - (d - step)
  }
  const end = pts[pts.length - 1]!
  if (Math.hypot(end.x - out[out.length - 1]!.x, end.z - out[out.length - 1]!.z) > 1e-3) out.push(end)
  return out
}

/** Gaussian smoothing (σ in samples); the ends are held (shrinking window) so the start and stall stay put. */
function smooth(pts: P[], sigma: number): P[] {
  const r = Math.ceil(sigma * 3)
  const w = Array.from({ length: r * 2 + 1 }, (_, k) => Math.exp(-((k - r) ** 2) / (2 * sigma * sigma)))
  return pts.map((_, i) => {
    const rr = Math.min(r, i, pts.length - 1 - i)
    let x = 0, z = 0, sw = 0
    for (let k = -rr; k <= rr; k++) {
      const q = pts[i + k]!
      const wk = w[k + r]!
      x += q.x * wk
      z += q.z * wk
      sw += wk
    }
    return { x: x / sw, z: z / sw }
  })
}

/** Speed limit by place: the approach to the gate, the lot, the stall. */
function zoneLimit(p: P, sLeft: number) {
  const gate = FENCE.max[1]
  let v = 13.5
  if (p.z < gate + 80) v = Math.min(v, 11.5)
  if (p.z < gate + 45) v = Math.min(v, 5.4 + Math.max(0, (p.z - gate - 13) / 32) * 6.1)
  if (p.z < gate + 13) v = Math.min(v, 5.4)
  if (p.z < PARKING_LOT.max[1]) v = Math.min(v, 5.2)
  if (sLeft < 16) v = Math.min(v, 1.1 + sLeft * 0.26)
  return Math.max(0.6, v)
}

export type Route = ReturnType<typeof buildRoute>

export function buildRoute() {
  const surface = createSurface()
  const pts = axleLine()
  const n = pts.length
  const s = new Float64Array(n)
  for (let i = 1; i < n; i++) s[i] = s[i - 1]! + Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.z - pts[i - 1]!.z)
  const length = s[n - 1]!
  // Heading of the axle path (unwrapped) and curvature (+ left) from heading change over ±1 m.
  const head = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 2)]!
    const b = pts[Math.min(n - 1, i + 2)]!
    head[i] = Math.atan2(-(b.x - a.x), -(b.z - a.z))
  }
  for (let i = 1; i < n; i++) {
    while (head[i]! - head[i - 1]! > Math.PI) head[i]! -= Math.PI * 2
    while (head[i]! - head[i - 1]! < -Math.PI) head[i]! += Math.PI * 2
  }
  const curv = new Float64Array(n)
  const W = 4
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - W)
    const b = Math.min(n - 1, i + W)
    curv[i] = (head[b]! - head[a]!) / Math.max(1e-3, s[b]! - s[a]!)
  }
  // Body pose per sample: centre ahead of the axle, tilt from the surface under the four tyres.
  const cx = new Float64Array(n), cz = new Float64Array(n), cy = new Float64Array(n), pitch = new Float64Array(n), roll = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const p = pts[i]!
    const yaw = head[i]!
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw)
    // Right-hand side of the car (+X in model space).
    const rx = Math.cos(yaw), rz = -Math.sin(yaw)
    const h = (along: number, side: number) => surface.at(p.x + fx * along + rx * side, p.z + fz * along + rz * side)
    const t = CAR.track / 2
    const rl = h(0, -t), rr = h(0, t), fl = h(CAR.wheelbase, -t), fr = h(CAR.wheelbase, t)
    cx[i] = p.x + fx * CAR.rear
    cz[i] = p.z + fz * CAR.rear
    pitch[i] = Math.atan(((fl + fr) / 2 - (rl + rr) / 2) / CAR.wheelbase)
    roll[i] = Math.atan(((fr + rr) / 2 - (fl + rl) / 2) / CAR.track)
    // The root sits at the centre's ground point on the tilted plane through the contacts.
    const rear = (rl + rr) / 2
    cy[i] = rear + ((fl + fr) / 2 - rear) * (CAR.rear / CAR.wheelbase)
  }
  // Speed: lateral 2.2 m/s² and zone limits, then forward (accel) and backward (braking) passes.
  const LAT = 2.2
  const ACC = 1.5
  const BRAKE = 1.6
  const V0 = 7.5
  const v = new Float64Array(n)
  for (let i = 0; i < n; i++) v[i] = Math.min(zoneLimit(pts[i]!, length - s[i]!), Math.sqrt(LAT / Math.max(Math.abs(curv[i]!), 1e-4)))
  v[0] = Math.min(v[0]!, V0)
  for (let i = 1; i < n; i++) v[i] = Math.min(v[i]!, Math.sqrt(v[i - 1]! ** 2 + 2 * ACC * (s[i]! - s[i - 1]!)))
  v[n - 1] = 0
  for (let i = n - 2; i >= 0; i--) v[i] = Math.min(v[i]!, Math.sqrt(v[i + 1]! ** 2 + 2 * BRAKE * (s[i + 1]! - s[i]!)))
  const t = new Float64Array(n)
  for (let i = 1; i < n; i++) t[i] = t[i - 1]! + (s[i]! - s[i - 1]!) / Math.max(0.35, (v[i]! + v[i - 1]!) / 2)
  const duration = t[n - 1]!

  const find = (arr: Float64Array, value: number) => {
    let lo = 0
    let hi = n - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (arr[mid]! <= value) lo = mid
      else hi = mid
    }
    return lo
  }
  const fill = (i: number, j: number, u: number, out: RouteSample) => {
    const L = (a: Float64Array) => a[i]! + (a[j]! - a[i]!) * u
    out.x = L(cx)
    out.z = L(cz)
    out.y = L(cy)
    out.yaw = L(head)
    out.pitch = L(pitch)
    out.roll = L(roll)
    out.curvature = L(curv)
    return out
  }
  /** Car state `time` seconds into the drive (clamped to the parked pose at the end). */
  const sample = (time: number, out: RouteSample): RouteSample => {
    const tt = Math.min(Math.max(time, 0), duration)
    const i = find(t, tt)
    const j = Math.min(n - 1, i + 1)
    const dt = t[j]! - t[i]!
    const tau = tt - t[i]!
    const a = dt > 1e-6 ? (v[j]! - v[i]!) / dt : 0
    const ds = Math.min(s[j]! - s[i]!, v[i]! * tau + 0.5 * a * tau * tau)
    const u = s[j]! - s[i]! > 1e-6 ? ds / (s[j]! - s[i]!) : 0
    fill(i, j, u, out)
    out.speed = time >= duration ? 0 : v[i]! + a * tau
    out.accel = time >= duration ? 0 : a
    out.s = s[i]! + ds
    return out
  }
  /** Car pose at `d` metres of axle travel (checks, traces). */
  const at = (d: number, out: RouteSample): RouteSample => {
    const dd = Math.min(Math.max(d, 0), length)
    const i = find(s, dd)
    const j = Math.min(n - 1, i + 1)
    const u = s[j]! - s[i]! > 1e-6 ? (dd - s[i]!) / (s[j]! - s[i]!) : 0
    fill(i, j, u, out)
    out.speed = v[i]! + (v[j]! - v[i]!) * u
    out.accel = 0
    out.s = dd
    return out
  }
  const groundAt = (x: number, z: number) => surface.at(x, z)
  return { duration, length, sample, at, groundAt, surface, axle: pts, laneWidth: ACCESS_ROAD.width, countyWidth: COUNTY_ROAD.width }
}
