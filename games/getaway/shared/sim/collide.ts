import type { Vehicle } from "../config"
import type { Box } from "./city"

/**
 * 2D oriented-box contacts and rigid-body impulses on the ground plane (x, z). Headings follow vehicle.ts: forward is
 * (sin h, cos h), and the angular velocity is the yaw rate dh/dt, so a point at offset r from the center moves at
 * v + w * (r.z, -r.x).
 */

/** A box with center (x, z), unit axis a = (ax, az) of half extent ea, and axis b = (az, -ax) of half extent eb. */
export type Shape = { x: number; z: number; ax: number; az: number; ea: number; eb: number }

export type Point = { x: number; z: number; depth: number }

/** Normal (nx, nz) points from the first shape to the second; depth is the minimum translation distance. */
export type Contact = { nx: number; nz: number; depth: number; points: Point[] }

/** Anything with a pose and a velocity: a Body, or a scratch copy of one. */
export type Rigid = { x: number; z: number; h: number; vx: number; vz: number; yaw: number }

/** Collision box as a fraction of the drawn length and width (the bodywork has rounded corners). */
const INSET = 0.48
/** Scales the uniform-box moment of inertia; real cars carry their mass nearer the middle, so they spin a little easier. */
const INERTIA = 0.8

export function carHalf(v: Vehicle): [number, number] {
  return [v.length * INSET, v.width * INSET]
}

export function carShape(b: { x: number; z: number; h: number }, v: Vehicle): Shape {
  const [hl, hw] = carHalf(v)
  return { x: b.x, z: b.z, ax: Math.sin(b.h), az: Math.cos(b.h), ea: hl, eb: hw }
}

export function boxShape(box: Box): Shape {
  return { x: (box.x0 + box.x1) / 2, z: (box.z0 + box.z1) / 2, ax: 0, az: 1, ea: (box.z1 - box.z0) / 2, eb: (box.x1 - box.x0) / 2 }
}

export type Mass = { invM: number; invI: number }

export const STATIC: Mass = { invM: 0, invI: 0 }

export function carMass(v: Vehicle): Mass {
  return { invM: 1 / v.mass, invI: 12 / (v.mass * INERTIA * (v.length * v.length + v.width * v.width)) }
}

/** Half extent of a shape projected on a unit axis. */
function reach(s: Shape, nx: number, nz: number) {
  return s.ea * Math.abs(s.ax * nx + s.az * nz) + s.eb * Math.abs(s.az * nx - s.ax * nz)
}

/** Signed distance between two shapes along their best separating axis: positive is a gap, negative an overlap. */
export function shapeGap(a: Shape, b: Shape): number {
  const dx = b.x - a.x
  const dz = b.z - a.z
  let gap = -Infinity
  for (const s of [a, b])
    for (const [nx, nz] of [
      [s.ax, s.az],
      [s.az, -s.ax],
    ] as const)
      gap = Math.max(gap, Math.abs(dx * nx + dz * nz) - reach(a, nx, nz) - reach(b, nx, nz))
  return gap
}

/**
 * Separating-axis test between two boxes with a clipped contact manifold (one or two points), Box2D style: the face
 * of least penetration is the reference face, the most anti-parallel face of the other box is clipped against its
 * sides, and the clipped points still behind the reference face are the contacts.
 */
export function collideShapes(a: Shape, b: Shape): Contact | null {
  const dx = b.x - a.x
  const dz = b.z - a.z
  let best = Infinity
  let nx = 0
  let nz = 0
  let refB = false
  let refK = 0
  for (let o = 0; o < 2; o++) {
    const s = o === 0 ? a : b
    for (let k = 0; k < 2; k++) {
      const ux = k === 0 ? s.ax : s.az
      const uz = k === 0 ? s.az : -s.ax
      const d = dx * ux + dz * uz
      const overlap = reach(a, ux, uz) + reach(b, ux, uz) - Math.abs(d)
      if (overlap <= 0) return null
      // Prefer the first box's faces unless the second's are clearly better, so the manifold doesn't flicker.
      if (o === 0 ? overlap < best : overlap < best * 0.95 - 0.002) {
        best = overlap
        const sign = d >= 0 ? 1 : -1
        nx = ux * sign
        nz = uz * sign
        refB = o === 1
        refK = k
      }
    }
  }
  const ref = refB ? b : a
  const inc = refB ? a : b
  // Reference normal points out of the reference box toward the incident one.
  const rnx = refB ? -nx : nx
  const rnz = refB ? -nz : nz
  const refE = refK === 0 ? ref.ea : ref.eb
  const tx = refK === 0 ? ref.az : ref.ax
  const tz = refK === 0 ? -ref.ax : ref.az
  const refT = refK === 0 ? ref.eb : ref.ea
  // Incident face: the face of the other box whose outward normal is most against the reference normal.
  const da = inc.ax * rnx + inc.az * rnz
  const db = inc.az * rnx - inc.ax * rnz
  let fnx: number, fnz: number, fe: number, ftx: number, ftz: number, ft: number
  if (Math.abs(da) >= Math.abs(db)) {
    const s = da > 0 ? -1 : 1
    fnx = inc.ax * s
    fnz = inc.az * s
    fe = inc.ea
    ftx = inc.az
    ftz = -inc.ax
    ft = inc.eb
  } else {
    const s = db > 0 ? -1 : 1
    fnx = inc.az * s
    fnz = -inc.ax * s
    fe = inc.eb
    ftx = inc.ax
    ftz = inc.az
    ft = inc.ea
  }
  const cx = inc.x + fnx * fe
  const cz = inc.z + fnz * fe
  let p1x = cx + ftx * ft
  let p1z = cz + ftz * ft
  let p2x = cx - ftx * ft
  let p2z = cz - ftz * ft
  // Clip the incident edge to the reference face's sides.
  for (const side of [1, -1]) {
    const ux = tx * side
    const uz = tz * side
    const lim = refT + ref.x * ux + ref.z * uz
    const d1 = p1x * ux + p1z * uz - lim
    const d2 = p2x * ux + p2z * uz - lim
    if (d1 > 0 && d2 > 0) {
      p1x = p2x = (p1x + p2x) / 2
      p1z = p2z = (p1z + p2z) / 2
      break
    }
    if (d1 > 0) {
      const t = d1 / (d1 - d2)
      p1x += (p2x - p1x) * t
      p1z += (p2z - p1z) * t
    } else if (d2 > 0) {
      const t = d2 / (d2 - d1)
      p2x += (p1x - p2x) * t
      p2z += (p1z - p2z) * t
    }
  }
  const face = refE + ref.x * rnx + ref.z * rnz
  const points: Point[] = []
  for (const [px, pz] of [
    [p1x, p1z],
    [p2x, p2z],
  ] as const) {
    const sep = px * rnx + pz * rnz - face
    if (sep < 0) points.push({ x: px - (rnx * sep) / 2, z: pz - (rnz * sep) / 2, depth: -sep })
  }
  if (points.length === 2 && Math.abs(points[0]!.x - points[1]!.x) + Math.abs(points[0]!.z - points[1]!.z) < 1e-6) points.pop()
  if (!points.length) points.push({ x: (p1x + p2x) / 2, z: (p1z + p2z) / 2, depth: best })
  return { nx, nz, depth: best, points }
}

/** What one resolved contact did: approach speed at the contact, where it was, and how hard each side was hit. */
export type Hit = { impact: number; x: number; z: number; nx: number; nz: number; dvA: number; dwA: number; dvB: number; dwB: number }

export type Response = { restitution: number; friction: number }

export const WALL: Response = { restitution: 0.25, friction: 0.2 }
export const CARS: Response = { restitution: 0.25, friction: 0.35 }

/** Below this approach speed contacts don't bounce, so a car pressed against something rests instead of buzzing. */
const BOUNCE_MIN = 1.5
const ITERATIONS = 6

/**
 * Sequential impulses at the contact points with friction and spin, for two rigid bodies (b may be static with STATIC
 * mass, in which case its velocity is never touched). Positions are left alone.
 */
export function resolve(a: Rigid, ma: Mass, b: Rigid | null, mb: Mass, c: Contact, res: Response): Hit {
  const { nx, nz } = c
  const tx = nz
  const tz = -nx
  const bx = b?.x ?? 0
  const bz = b?.z ?? 0
  const n = c.points.length
  const ra: [number, number][] = []
  const rb: [number, number][] = []
  const kn: number[] = []
  const kt: number[] = []
  const bias: number[] = []
  const accN: number[] = []
  const accT: number[] = []
  let impact = 0
  let hx = 0
  let hz = 0
  const vel = (i: number) => {
    const [rax, raz] = ra[i]!
    const [rbx, rbz] = rb[i]!
    const vax = a.vx + a.yaw * raz
    const vaz = a.vz - a.yaw * rax
    const vbx = b ? b.vx + b.yaw * rbz : 0
    const vbz = b ? b.vz - b.yaw * rbx : 0
    return [vbx - vax, vbz - vaz] as const
  }
  for (let i = 0; i < n; i++) {
    const p = c.points[i]!
    ra.push([p.x - a.x, p.z - a.z])
    rb.push([p.x - bx, p.z - bz])
    // perp(r) = (r.z, -r.x); the impulse's lever arm along a direction u is perp(r) . u.
    const an = ra[i]![1] * nx - ra[i]![0] * nz
    const bn = rb[i]![1] * nx - rb[i]![0] * nz
    const at = ra[i]![1] * tx - ra[i]![0] * tz
    const bt = rb[i]![1] * tx - rb[i]![0] * tz
    kn.push(ma.invM + mb.invM + ma.invI * an * an + mb.invI * bn * bn)
    kt.push(ma.invM + mb.invM + ma.invI * at * at + mb.invI * bt * bt)
    const [rvx, rvz] = vel(i)
    const vn = rvx * nx + rvz * nz
    bias.push(vn < -BOUNCE_MIN ? -res.restitution * vn : 0)
    accN.push(0)
    accT.push(0)
    if (-vn > impact) impact = -vn
    hx += p.x / n
    hz += p.z / n
  }
  const v0x = a.vx
  const v0z = a.vz
  const w0 = a.yaw
  const u0x = b?.vx ?? 0
  const u0z = b?.vz ?? 0
  const q0 = b?.yaw ?? 0
  const apply = (i: number, px: number, pz: number) => {
    const [rax, raz] = ra[i]!
    const [rbx, rbz] = rb[i]!
    a.vx -= px * ma.invM
    a.vz -= pz * ma.invM
    a.yaw -= ma.invI * (px * raz - pz * rax)
    if (b && (mb.invM > 0 || mb.invI > 0)) {
      b.vx += px * mb.invM
      b.vz += pz * mb.invM
      b.yaw += mb.invI * (px * rbz - pz * rbx)
    }
  }
  const vn = (i: number) => {
    const [rvx, rvz] = vel(i)
    return rvx * nx + rvz * nz
  }
  const setN = (i: number, next: number) => {
    const dn = next - accN[i]!
    accN[i] = next
    apply(i, nx * dn, nz * dn)
  }
  // Coupling between the two points' normal impulses, for the block solve.
  let k12 = 0
  if (n === 2) {
    const [a1, a2] = [ra[0]!, ra[1]!].map(([x, z]) => z * nx - x * nz) as [number, number]
    const [b1, b2] = [rb[0]!, rb[1]!].map(([x, z]) => z * nx - x * nz) as [number, number]
    k12 = ma.invM + mb.invM + ma.invI * a1 * a2 + mb.invI * b1 * b2
  }
  for (let it = 0; it < ITERATIONS; it++) {
    if (n === 2) blockSolve()
    else setN(0, Math.max(0, accN[0]! - (vn(0) - bias[0]!) / kn[0]!))
    for (let i = 0; i < n; i++) {
      const [rvx, rvz] = vel(i)
      const vt = rvx * tx + rvz * tz
      const lim = res.friction * accN[i]!
      const nt = Math.max(-lim, Math.min(lim, accT[i]! - vt / kt[i]!))
      const dt = nt - accT[i]!
      accT[i] = nt
      apply(i, tx * dt, tz * dt)
    }
  }

  /**
   * Both normal impulses at once (Box2D's block solver): a flush face contact gets an even push, where one point at a
   * time would leave a small spin behind every step and make a car resting against a wall creep and twitch.
   */
  function blockSolve() {
    const k11 = kn[0]!
    const k22 = kn[1]!
    const x1 = accN[0]!
    const x2 = accN[1]!
    // Target: each point's normal velocity reaches its bias. r = K x_old + bias - v.
    const r1 = k11 * x1 + k12 * x2 + bias[0]! - vn(0)
    const r2 = k12 * x1 + k22 * x2 + bias[1]! - vn(1)
    const det = k11 * k22 - k12 * k12
    const ok = (y1: number, y2: number) => {
      // Resulting normal velocity minus bias at each point must be >= 0 wherever the impulse is 0.
      const w1 = k11 * y1 + k12 * y2 - r1
      const w2 = k12 * y1 + k22 * y2 - r2
      return y1 >= 0 && y2 >= 0 && (y1 > 0 || w1 >= -1e-9) && (y2 > 0 || w2 >= -1e-9)
    }
    const tries: [number, number][] = []
    if (Math.abs(det) > 1e-9 * k11 * k22) tries.push([(k22 * r1 - k12 * r2) / det, (k11 * r2 - k12 * r1) / det])
    tries.push([r1 / k11, 0], [0, r2 / k22], [0, 0])
    for (const [y1, y2] of tries)
      if (ok(y1, y2)) {
        setN(0, y1)
        setN(1, y2)
        return
      }
    setN(0, Math.max(0, accN[0]! - (vn(0) - bias[0]!) / k11))
    setN(1, Math.max(0, accN[1]! - (vn(1) - bias[1]!) / k22))
  }
  return {
    impact,
    x: hx,
    z: hz,
    nx,
    nz,
    dvA: Math.hypot(a.vx - v0x, a.vz - v0z),
    dwA: Math.abs(a.yaw - w0),
    dvB: b ? Math.hypot(b.vx - u0x, b.vz - u0z) : 0,
    dwB: b ? Math.abs(b.yaw - q0) : 0,
  }
}

/** Pushes two bodies apart along the contact normal, split by inverse mass, leaving `slop` of overlap. */
export function separate(a: Rigid, ma: Mass, b: Rigid | null, mb: Mass, c: Contact, slop: number) {
  const push = c.depth - slop
  const total = ma.invM + mb.invM
  if (push <= 0 || total <= 0) return
  const ka = (push * ma.invM) / total
  a.x -= c.nx * ka
  a.z -= c.nz * ka
  if (b && mb.invM > 0) {
    const kb = (push * mb.invM) / total
    b.x += c.nx * kb
    b.z += c.nz * kb
  }
}
