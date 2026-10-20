// A small deterministic 2D rigid-body sim (version 2).
//
// Bodies are capsules (a core segment with a radius) or boxes (slightly rounded). Static geometry is a set of one-sided
// segments (the floor polyline plus solid blocks such as ceilings and vents). Kinematic bodies follow a sine drive.
//
// Solver: sequential impulses with warm starting for joints *and* contacts (contacts are keyed by feature so their
// impulses carry across steps), speculative contacts, Coulomb friction with per-body coefficients, and split-impulse
// position correction (penetration and joint drift are fixed with pseudo-velocities that never feed back into real
// velocity, so nothing gains energy from being pushed apart). Joints have speculative angle limits and a PD-style
// velocity motor with a torque limit: the controller sets a target angle, the motor drives toward it at up to
// maxSpeed and never pushes harder than maxTorque. Passive "spring" joints use the same motor with a fixed target.
//
// Only IEEE-exact arithmetic and fmath are used, so a run is bit-identical on every engine.

import { sincos } from "./fmath"

export const SIM_VERSION = 2

export type Drive = { x0: number; y0: number; ax: number; ay: number; period: number; phase: number }

export type Body = {
  x: number
  y: number
  /** Unwrapped angle (radians), so joint angles are plain differences. */
  a: number
  vx: number
  vy: number
  w: number
  c: number
  s: number
  /** 0 capsule (core along local x, half-length hl, radius r), 1 box (half extents hx, hy, rounding r). */
  kind: 0 | 1
  hl: number
  r: number
  hx: number
  hy: number
  m: number
  invM: number
  invI: number
  friction: number
  /** Bodies sharing a group ≥ 0 never collide (one creature); -1 collides with everything. */
  group: number
  /** Kinematic bodies follow this and have infinite mass. */
  drive: Drive | null
  /** Touched anything during the last step. */
  contact: boolean
  /** Touched an upward-facing static surface (the floor) during the last step. */
  ground: boolean
  pvx: number
  pvy: number
  pw: number
}

export const enum JointMode {
  Free = 0,
  Motor = 1,
  Spring = 2,
}

export type Joint = {
  a: number
  /** -1 is the static world. */
  b: number
  lax: number
  lay: number
  lbx: number
  lby: number
  ref: number
  lower: number
  upper: number
  mode: JointMode
  maxTorque: number
  /** Motor gain: target angular speed per radian of error (1/s). */
  kp: number
  maxSpeed: number
  /** Target angle (relative, like lower/upper). */
  target: number
  /** Motor torque applied during the last step (N·m). */
  torque: number
  px: number
  py: number
  lowerImpulse: number
  upperImpulse: number
  motorImpulse: number
}

export type Statics = {
  ax: Float64Array
  ay: Float64Array
  bx: Float64Array
  by: Float64Array
  nx: Float64Array
  ny: Float64Array
  count: number
  /** Convex corners (x, y pairs), tested against moving shapes. */
  corners: Float64Array
  x0: number
  cols: number
  cellSegs: number[][]
  cellCorners: number[][]
  /** The floor polyline alone, for height queries. */
  floorX: Float64Array
  floorY: Float64Array
  floorCells: number[][]
}

export type PhysicsSettings = {
  gravity: number
  iterations: number
  positionIterations: number
  /** Angular velocity damping per second. */
  angularDamping: number
}

export const DEFAULT_PHYSICS: PhysicsSettings = { gravity: 9.81, iterations: 12, positionIterations: 4, angularDamping: 0.4 }

const MARGIN = 0.02
const SLOP = 0.004
const BETA = 0.25
const MAX_V = 40
const MAX_W = 60
const GROUND_FRICTION = 1

type Pt = [number, number]

/** Static geometry: the floor (a left-to-right polyline, solid below) and solid blocks (CCW polygons). */
export function makeStatics(floor: readonly Pt[], blocks: readonly (readonly Pt[])[] = []): Statics {
  const segs: number[][] = []
  const corners: number[] = []
  for (let i = 0; i < floor.length - 1; i++) {
    const [ax, ay] = floor[i]!, [bx, by] = floor[i + 1]!
    const dx = bx - ax, dy = by - ay
    const len = Math.sqrt(dx * dx + dy * dy)
    if (len < 1e-9) continue
    segs.push([ax, ay, bx, by, -dy / len, dx / len])
  }
  for (let i = 1; i < floor.length - 1; i++) {
    const d1x = floor[i]![0] - floor[i - 1]![0], d1y = floor[i]![1] - floor[i - 1]![1]
    const d2x = floor[i + 1]![0] - floor[i]![0], d2y = floor[i + 1]![1] - floor[i]![1]
    if (d1x * d2y - d1y * d2x < -1e-9) corners.push(floor[i]![0], floor[i]![1])
  }
  for (const poly of blocks) {
    const n = poly.length
    for (let i = 0; i < n; i++) {
      const [ax, ay] = poly[i]!, [bx, by] = poly[(i + 1) % n]!
      const dx = bx - ax, dy = by - ay
      const len = Math.sqrt(dx * dx + dy * dy)
      if (len < 1e-9) continue
      segs.push([ax, ay, bx, by, dy / len, -dx / len])
      corners.push(ax, ay)
    }
  }
  const count = segs.length
  const col = (k: number) => new Float64Array(segs.map((s) => s[k]!))
  let lo = Infinity, hi = -Infinity
  for (const s of segs) {
    lo = Math.min(lo, s[0]!, s[2]!)
    hi = Math.max(hi, s[0]!, s[2]!)
  }
  const x0 = Math.floor(lo) - 1
  const cols = Math.floor(hi) - x0 + 2
  const cellSegs: number[][] = Array.from({ length: cols }, () => [])
  const cellCorners: number[][] = Array.from({ length: cols }, () => [])
  segs.forEach((s, i) => {
    const a = Math.floor(Math.min(s[0]!, s[2]!)) - x0, b = Math.floor(Math.max(s[0]!, s[2]!)) - x0
    for (let c = a; c <= b; c++) cellSegs[c]!.push(i)
  })
  for (let i = 0; i < corners.length / 2; i++) cellCorners[Math.floor(corners[2 * i]!) - x0]!.push(i)
  const floorX = new Float64Array(floor.map((p) => p[0]))
  const floorY = new Float64Array(floor.map((p) => p[1]))
  const floorCells: number[][] = Array.from({ length: cols }, () => [])
  for (let i = 0; i < floor.length - 1; i++) {
    const a = Math.floor(Math.min(floorX[i]!, floorX[i + 1]!)) - x0, b = Math.floor(Math.max(floorX[i]!, floorX[i + 1]!)) - x0
    for (let c = Math.max(0, a); c <= Math.min(cols - 1, b); c++) floorCells[c]!.push(i)
  }
  return { ax: col(0), ay: col(1), bx: col(2), by: col(3), nx: col(4), ny: col(5), count, corners: new Float64Array(corners), x0, cols, cellSegs, cellCorners, floorX, floorY, floorCells }
}

/** Floor height under x (the highest point of the floor polyline there). */
export function groundHeight(t: Statics, x: number): number {
  const { floorX: xs, floorY: ys } = t
  const n = xs.length
  if (x <= xs[0]!) return ys[0]!
  if (x >= xs[n - 1]!) return ys[n - 1]!
  const cell = t.floorCells[Math.floor(x) - t.x0]
  let best = -Infinity
  if (cell) {
    for (const i of cell) {
      const ax = xs[i]!, bx = xs[i + 1]!
      if (x < ax || x > bx) continue
      const h = bx - ax < 1e-12 ? Math.max(ys[i]!, ys[i + 1]!) : ys[i]! + ((ys[i + 1]! - ys[i]!) * (x - ax)) / (bx - ax)
      if (h > best) best = h
    }
  }
  return best === -Infinity ? ys[0]! : best
}

function base(x: number, y: number, a: number, m: number, inertia: number, friction: number, group: number): Body {
  const sc: [number, number] = [0, 0]
  sincos(a, sc)
  return {
    x, y, a, vx: 0, vy: 0, w: 0, c: sc[1], s: sc[0], kind: 0, hl: 0, r: 0, hx: 0, hy: 0,
    m, invM: m > 0 ? 1 / m : 0, invI: m > 0 ? 1 / inertia : 0, friction, group, drive: null, contact: false, ground: false, pvx: 0, pvy: 0, pw: 0,
  }
}

export function makeCapsule(x: number, y: number, a: number, hl: number, r: number, m: number, friction = 0.8, group = 0): Body {
  const len = 2 * (hl + r)
  const b = base(x, y, a, m, (m * (len * len + 4 * r * r)) / 12, friction, group)
  b.hl = hl
  b.r = r
  return b
}

/** A box; mass 0 makes it immovable (use `drive` for a moving platform). */
export function makeBox(x: number, y: number, a: number, hx: number, hy: number, m: number, friction = 0.7, group = -1): Body {
  const b = base(x, y, a, m, (m * (4 * hx * hx + 4 * hy * hy)) / 12, friction, group)
  b.kind = 1
  b.hx = hx
  b.hy = hy
  b.r = 0.008
  return b
}

const GROUND: Body = makeBox(0, 0, 0, 0, 0, 0, GROUND_FRICTION, -2)

export type JointOptions = { lower: number; upper: number; mode?: JointMode; maxTorque?: number; kp?: number; maxSpeed?: number }

/** A revolute joint at world point (x, y); b = -1 pins a to the world. Angles are relative to the pose at creation. */
export function makeJoint(bodies: readonly Body[], a: number, b: number, x: number, y: number, o: JointOptions): Joint {
  const A = bodies[a]!, B = b < 0 ? GROUND : bodies[b]!
  const ax = x - A.x, ay = y - A.y
  const bx = x - B.x, by = y - B.y
  return {
    a, b,
    lax: A.c * ax + A.s * ay, lay: -A.s * ax + A.c * ay,
    lbx: B.c * bx + B.s * by, lby: -B.s * bx + B.c * by,
    ref: B.a - A.a, lower: o.lower, upper: o.upper, mode: o.mode ?? JointMode.Free, maxTorque: o.maxTorque ?? 0, kp: o.kp ?? 10, maxSpeed: o.maxSpeed ?? 10,
    target: 0, torque: 0, px: 0, py: 0, lowerImpulse: 0, upperImpulse: 0, motorImpulse: 0,
  }
}

export function jointAngle(bodies: readonly Body[], j: Joint): number {
  const B = j.b < 0 ? GROUND : bodies[j.b]!
  return B.a - bodies[j.a]!.a - j.ref
}
export function jointSpeed(bodies: readonly Body[], j: Joint): number {
  const B = j.b < 0 ? GROUND : bodies[j.b]!
  return B.w - bodies[j.a]!.w
}

type Contact = {
  a: number
  b: number
  nx: number
  ny: number
  rax: number
  ray: number
  rbx: number
  rby: number
  sep: number
  mn: number
  mt: number
  mu: number
  pn: number
  pt: number
  ppn: number
  key: number
}

/** Closest-point query result: n is the shape's outward normal at q (pointing toward the query point). */
type Query = { sep: number; nx: number; ny: number; qx: number; qy: number; region: number }

export class World {
  readonly contacts: Contact[] = []
  time = 0
  private pool: Contact[] = []
  private warm = new Map<number, number>()
  private warmNext = new Map<number, number>()
  private sc: [number, number] = [0, 0]
  private q: Query = { sep: 0, nx: 0, ny: 0, qx: 0, qy: 0, region: 0 }
  private segStamp: Int32Array
  private cornerStamp: Int32Array
  private stamp = 0

  constructor(readonly bodies: Body[], readonly joints: Joint[], readonly statics: Statics, readonly settings: PhysicsSettings = DEFAULT_PHYSICS) {
    this.segStamp = new Int32Array(statics.count)
    this.cornerStamp = new Int32Array(statics.corners.length / 2)
  }

  private body(i: number): Body {
    return i < 0 ? GROUND : this.bodies[i]!
  }

  /** Advances one substep of dt. Joint targets are set by the caller beforehand. */
  step(dt: number): void {
    const { bodies, joints, settings } = this
    const g = settings.gravity
    const damp = 1 / (1 + dt * settings.angularDamping)
    for (const b of bodies) {
      if (b.invM === 0) continue
      b.vy -= g * dt
      b.w *= damp
    }
    this.driveKinematic(this.time, true)
    this.collide()
    const invDt = 1 / dt

    // Warm start.
    for (const j of joints) {
      const A = bodies[j.a]!, B = this.body(j.b)
      const rax = A.c * j.lax - A.s * j.lay, ray = A.s * j.lax + A.c * j.lay
      const rbx = B.c * j.lbx - B.s * j.lby, rby = B.s * j.lbx + B.c * j.lby
      const P = j.px, Q = j.py
      A.vx -= A.invM * P; A.vy -= A.invM * Q; A.w -= A.invI * (rax * Q - ray * P)
      B.vx += B.invM * P; B.vy += B.invM * Q; B.w += B.invI * (rbx * Q - rby * P)
      const L = j.lowerImpulse - j.upperImpulse + j.motorImpulse
      A.w -= A.invI * L
      B.w += B.invI * L
    }
    for (const c of this.contacts) {
      const A = this.body(c.a), B = this.body(c.b)
      const px = c.pn * c.nx - c.pt * c.ny, py = c.pn * c.ny + c.pt * c.nx
      A.vx += A.invM * px; A.vy += A.invM * py; A.w += A.invI * (c.rax * py - c.ray * px)
      B.vx -= B.invM * px; B.vy -= B.invM * py; B.w -= B.invI * (c.rbx * py - c.rby * px)
    }

    for (let it = 0; it < settings.iterations; it++) {
      for (const j of joints) this.solveJoint(j, dt, invDt)
      for (const c of this.contacts) this.solveContact(c, invDt)
    }
    for (let it = 0; it < settings.positionIterations; it++) {
      for (const j of joints) this.solveJointPosition(j, invDt)
      for (const c of this.contacts) this.solveContactPosition(c, invDt)
    }

    for (const j of joints) j.torque = j.motorImpulse * invDt
    const warm = this.warmNext
    warm.clear()
    for (const c of this.contacts) {
      warm.set(c.key * 2, c.pn)
      warm.set(c.key * 2 + 1, c.pt)
    }
    this.warmNext = this.warm
    this.warm = warm

    const sc = this.sc
    for (const b of bodies) {
      if (b.invM === 0) continue
      if (b.vx > MAX_V) b.vx = MAX_V; else if (b.vx < -MAX_V) b.vx = -MAX_V
      if (b.vy > MAX_V) b.vy = MAX_V; else if (b.vy < -MAX_V) b.vy = -MAX_V
      if (b.w > MAX_W) b.w = MAX_W; else if (b.w < -MAX_W) b.w = -MAX_W
      b.x += (b.vx + b.pvx) * dt
      b.y += (b.vy + b.pvy) * dt
      b.a += (b.w + b.pw) * dt
      b.pvx = 0; b.pvy = 0; b.pw = 0
      sincos(b.a, sc)
      b.s = sc[0]
      b.c = sc[1]
    }
    this.time += dt
    this.driveKinematic(this.time, false)
  }

  private driveKinematic(t: number, velocityOnly: boolean): void {
    const sc = this.sc
    for (const b of this.bodies) {
      const d = b.drive
      if (!d) continue
      const k = 6.283185307179586 / d.period
      sincos(k * t + d.phase, sc)
      b.vx = d.ax * k * sc[1]
      b.vy = d.ay * k * sc[1]
      if (!velocityOnly) {
        b.x = d.x0 + d.ax * sc[0]
        b.y = d.y0 + d.ay * sc[0]
      }
    }
  }

  private solveJoint(j: Joint, dt: number, invDt: number): void {
    const A = this.bodies[j.a]!, B = this.body(j.b)
    const iA = A.invI, iB = B.invI
    const iSum = iA + iB
    const axial = iSum > 0 ? 1 / iSum : 0
    const angle = B.a - A.a - j.ref
    if (j.mode !== JointMode.Free && j.maxTorque > 0) {
      let ws = j.kp * (j.target - angle)
      if (ws > j.maxSpeed) ws = j.maxSpeed
      else if (ws < -j.maxSpeed) ws = -j.maxSpeed
      const max = j.maxTorque * dt
      let imp = axial * (ws - (B.w - A.w))
      const next = Math.max(-max, Math.min(max, j.motorImpulse + imp))
      imp = next - j.motorImpulse
      j.motorImpulse = next
      A.w -= iA * imp
      B.w += iB * imp
    }
    {
      const C = angle - j.lower
      const bias = C > 0 ? C * invDt : 0
      let imp = -axial * (B.w - A.w + bias)
      const next = Math.max(j.lowerImpulse + imp, 0)
      imp = next - j.lowerImpulse
      j.lowerImpulse = next
      A.w -= iA * imp
      B.w += iB * imp
    }
    {
      const C = j.upper - angle
      const bias = C > 0 ? C * invDt : 0
      let imp = -axial * (A.w - B.w + bias)
      const next = Math.max(j.upperImpulse + imp, 0)
      imp = next - j.upperImpulse
      j.upperImpulse = next
      A.w += iA * imp
      B.w -= iB * imp
    }
    const rax = A.c * j.lax - A.s * j.lay, ray = A.s * j.lax + A.c * j.lay
    const rbx = B.c * j.lbx - B.s * j.lby, rby = B.s * j.lbx + B.c * j.lby
    const mA = A.invM, mB = B.invM
    const k11 = mA + mB + iA * ray * ray + iB * rby * rby
    const k12 = -iA * rax * ray - iB * rbx * rby
    const k22 = mA + mB + iA * rax * rax + iB * rbx * rbx
    const det = k11 * k22 - k12 * k12
    const inv = det !== 0 ? 1 / det : 0
    const vx = B.vx - B.w * rby - A.vx + A.w * ray
    const vy = B.vy + B.w * rbx - A.vy - A.w * rax
    const P = -inv * (k22 * vx - k12 * vy)
    const Q = -inv * (-k12 * vx + k11 * vy)
    j.px += P
    j.py += Q
    A.vx -= mA * P; A.vy -= mA * Q; A.w -= iA * (rax * Q - ray * P)
    B.vx += mB * P; B.vy += mB * Q; B.w += iB * (rbx * Q - rby * P)
  }

  private solveJointPosition(j: Joint, invDt: number): void {
    const A = this.bodies[j.a]!, B = this.body(j.b)
    const iA = A.invI, iB = B.invI
    const iSum = iA + iB
    const axial = iSum > 0 ? 1 / iSum : 0
    const angle = B.a - A.a - j.ref
    if (angle < j.lower - SLOP) {
      const imp = -axial * (B.pw - A.pw + BETA * (angle - j.lower) * invDt)
      if (imp > 0) { A.pw -= iA * imp; B.pw += iB * imp }
    } else if (angle > j.upper + SLOP) {
      const imp = -axial * (A.pw - B.pw + BETA * (j.upper - angle) * invDt)
      if (imp > 0) { A.pw += iA * imp; B.pw -= iB * imp }
    }
    const rax = A.c * j.lax - A.s * j.lay, ray = A.s * j.lax + A.c * j.lay
    const rbx = B.c * j.lbx - B.s * j.lby, rby = B.s * j.lbx + B.c * j.lby
    const mA = A.invM, mB = B.invM
    const k11 = mA + mB + iA * ray * ray + iB * rby * rby
    const k12 = -iA * rax * ray - iB * rbx * rby
    const k22 = mA + mB + iA * rax * rax + iB * rbx * rbx
    const det = k11 * k22 - k12 * k12
    const inv = det !== 0 ? 1 / det : 0
    const cx = B.x + rbx - A.x - rax
    const cy = B.y + rby - A.y - ray
    const vx = B.pvx - B.pw * rby - A.pvx + A.pw * ray + BETA * invDt * cx
    const vy = B.pvy + B.pw * rbx - A.pvy - A.pw * rax + BETA * invDt * cy
    const P = -inv * (k22 * vx - k12 * vy)
    const Q = -inv * (-k12 * vx + k11 * vy)
    A.pvx -= mA * P; A.pvy -= mA * Q; A.pw -= iA * (rax * Q - ray * P)
    B.pvx += mB * P; B.pvy += mB * Q; B.pw += iB * (rbx * Q - rby * P)
  }

  private solveContact(c: Contact, invDt: number): void {
    const A = this.body(c.a), B = this.body(c.b)
    let vx = A.vx - A.w * c.ray - B.vx + B.w * c.rby
    let vy = A.vy + A.w * c.rax - B.vy - B.w * c.rbx
    const vn = vx * c.nx + vy * c.ny
    // Speculative: a gap may close this step but not overshoot.
    const target = c.sep > 0 ? -c.sep * invDt : 0
    let dpn = c.mn * (target - vn)
    const pn = Math.max(c.pn + dpn, 0)
    dpn = pn - c.pn
    c.pn = pn
    let px = dpn * c.nx, py = dpn * c.ny
    A.vx += A.invM * px; A.vy += A.invM * py; A.w += A.invI * (c.rax * py - c.ray * px)
    B.vx -= B.invM * px; B.vy -= B.invM * py; B.w -= B.invI * (c.rbx * py - c.rby * px)
    const tx = -c.ny, ty = c.nx
    vx = A.vx - A.w * c.ray - B.vx + B.w * c.rby
    vy = A.vy + A.w * c.rax - B.vy - B.w * c.rbx
    const vt = vx * tx + vy * ty
    let dpt = -c.mt * vt
    const maxF = c.mu * c.pn
    const pt = Math.max(-maxF, Math.min(c.pt + dpt, maxF))
    dpt = pt - c.pt
    c.pt = pt
    px = dpt * tx; py = dpt * ty
    A.vx += A.invM * px; A.vy += A.invM * py; A.w += A.invI * (c.rax * py - c.ray * px)
    B.vx -= B.invM * px; B.vy -= B.invM * py; B.w -= B.invI * (c.rbx * py - c.rby * px)
  }

  private solveContactPosition(c: Contact, invDt: number): void {
    if (c.sep >= -SLOP) return
    const A = this.body(c.a), B = this.body(c.b)
    const vx = A.pvx - A.pw * c.ray - B.pvx + B.pw * c.rby
    const vy = A.pvy + A.pw * c.rax - B.pvy - B.pw * c.rbx
    const vn = vx * c.nx + vy * c.ny
    let dp = c.mn * (BETA * (-c.sep - SLOP) * invDt - vn)
    const p = Math.max(c.ppn + dp, 0)
    dp = p - c.ppn
    c.ppn = p
    const px = dp * c.nx, py = dp * c.ny
    A.pvx += A.invM * px; A.pvy += A.invM * py; A.pw += A.invI * (c.rax * py - c.ray * px)
    B.pvx -= B.invM * px; B.pvy -= B.invM * py; B.pw -= B.invI * (c.rbx * py - c.rby * px)
  }

  /** Contact between a (owner of the point) and b (owner of the surface); n points from b to a. */
  private addContact(a: number, b: number, nx: number, ny: number, px: number, py: number, sep: number, key: number): void {
    const A = this.body(a), B = this.body(b)
    if (A.invM === 0 && B.invM === 0) return
    const c = this.pool.pop() ?? { a: 0, b: 0, nx: 0, ny: 0, rax: 0, ray: 0, rbx: 0, rby: 0, sep: 0, mn: 0, mt: 0, mu: 0, pn: 0, pt: 0, ppn: 0, key: 0 }
    const rax = px - A.x, ray = py - A.y, rbx = px - B.x, rby = py - B.y
    const ran = rax * ny - ray * nx, rbn = rbx * ny - rby * nx
    const rat = rax * nx + ray * ny, rbt = rbx * nx + rby * ny
    c.a = a; c.b = b; c.nx = nx; c.ny = ny; c.rax = rax; c.ray = ray; c.rbx = rbx; c.rby = rby; c.sep = sep
    c.mn = 1 / (A.invM + B.invM + A.invI * ran * ran + B.invI * rbn * rbn)
    c.mt = 1 / (A.invM + B.invM + A.invI * rat * rat + B.invI * rbt * rbt)
    c.mu = Math.sqrt(A.friction * B.friction)
    c.key = key
    c.pn = this.warm.get(key * 2) ?? 0
    c.pt = this.warm.get(key * 2 + 1) ?? 0
    c.ppn = 0
    this.contacts.push(c)
    if (sep < MARGIN * 0.5) {
      A.contact = true
      B.contact = true
      if (b < 0 && ny > 0.5) A.ground = true
    }
  }

  /** Closest point of body B's surface to (px, py); result in this.q. */
  private pointVsBody(B: Body, px: number, py: number): Query {
    const q = this.q
    const dx = px - B.x, dy = py - B.y
    if (B.kind === 0) {
      let u = dx * B.c + dy * B.s
      q.region = 0
      if (u > B.hl) { u = B.hl; q.region = 1 } else if (u < -B.hl) { u = -B.hl; q.region = 2 }
      const cx = B.x + B.c * u, cy = B.y + B.s * u
      const ox = px - cx, oy = py - cy
      const d = Math.sqrt(ox * ox + oy * oy)
      if (d > 1e-9) { q.nx = ox / d; q.ny = oy / d } else { q.nx = -B.s; q.ny = B.c }
      q.sep = d - B.r
      q.qx = cx + q.nx * B.r
      q.qy = cy + q.ny * B.r
      return q
    }
    const lx = B.c * dx + B.s * dy, ly = -B.s * dx + B.c * dy
    let nlx: number, nly: number, sx: number, sy: number, sep: number
    if (lx > -B.hx && lx < B.hx && ly > -B.hy && ly < B.hy) {
      const ex = B.hx - Math.abs(lx), ey = B.hy - Math.abs(ly)
      if (ex < ey) { nlx = lx >= 0 ? 1 : -1; nly = 0; sx = nlx * B.hx; sy = ly; sep = -ex; q.region = lx >= 0 ? 3 : 4 }
      else { nlx = 0; nly = ly >= 0 ? 1 : -1; sx = lx; sy = nly * B.hy; sep = -ey; q.region = ly >= 0 ? 5 : 6 }
    } else {
      sx = Math.max(-B.hx, Math.min(B.hx, lx))
      sy = Math.max(-B.hy, Math.min(B.hy, ly))
      const ox = lx - sx, oy = ly - sy
      const d = Math.sqrt(ox * ox + oy * oy)
      nlx = ox / d; nly = oy / d
      sep = d
      q.region = 7 + (sx === B.hx ? 1 : sx === -B.hx ? 2 : 0) + 3 * (sy === B.hy ? 1 : sy === -B.hy ? 2 : 0)
    }
    q.nx = B.c * nlx - B.s * nly
    q.ny = B.s * nlx + B.c * nly
    q.sep = sep - B.r
    const wx = B.x + B.c * sx - B.s * sy, wy = B.y + B.s * sx + B.c * sy
    q.qx = wx + q.nx * B.r
    q.qy = wy + q.ny * B.r
    return q
  }

  /** World positions of a body's contact vertices (capsule ends, box corners) and their radius. */
  private vertex(B: Body, k: number, out: [number, number]): [number, number] {
    if (B.kind === 0) {
      const sgn = k === 0 ? 1 : -1
      out[0] = B.x + sgn * B.c * B.hl
      out[1] = B.y + sgn * B.s * B.hl
    } else {
      const lx = k === 0 || k === 3 ? -B.hx : B.hx
      const ly = k < 2 ? -B.hy : B.hy
      out[0] = B.x + B.c * lx - B.s * ly
      out[1] = B.y + B.s * lx + B.c * ly
    }
    return out
  }

  private extent(B: Body): number {
    return B.kind === 0 ? B.hl + B.r : Math.sqrt(B.hx * B.hx + B.hy * B.hy) + B.r
  }

  private collide(): void {
    for (const c of this.contacts) this.pool.push(c)
    this.contacts.length = 0
    const { bodies, statics: t } = this
    const v: [number, number] = [0, 0]
    for (const b of bodies) {
      b.contact = false
      b.ground = false
    }
    for (let bi = 0; bi < bodies.length; bi++) {
      const B = bodies[bi]!
      if (B.invM === 0) continue
      const ext = this.extent(B) + MARGIN
      const c0 = Math.max(0, Math.floor(B.x - ext) - t.x0), c1 = Math.min(t.cols - 1, Math.floor(B.x + ext) - t.x0)
      this.stamp++
      const nv = B.kind === 0 ? 2 : 4
      for (let col = c0; col <= c1; col++) {
        for (const k of t.cellSegs[col]!) {
          if (this.segStamp[k] === this.stamp) continue
          this.segStamp[k] = this.stamp
          for (let vi = 0; vi < nv; vi++) {
            this.vertex(B, vi, v)
            this.vertexVsStatic(bi, vi, v[0], v[1], B.r, k)
          }
        }
        for (const k of t.cellCorners[col]!) {
          if (this.cornerStamp[k] === this.stamp) continue
          this.cornerStamp[k] = this.stamp
          const cx = t.corners[2 * k]!, cy = t.corners[2 * k + 1]!
          const ddx = cx - B.x, ddy = cy - B.y
          if (ddx * ddx + ddy * ddy > ext * ext) continue
          const q = this.pointVsBody(B, cx, cy)
          if (q.sep > MARGIN || (B.kind === 0 && q.region !== 0)) continue
          // The static corner pushes the body along -n.
          this.addContact(bi, -1, -q.nx, -q.ny, q.qx, q.qy, q.sep, this.key(-1, bi, k, q.region))
        }
      }
    }
    for (let i = 0; i < bodies.length; i++) {
      const A = bodies[i]!
      for (let j = i + 1; j < bodies.length; j++) {
        const B = bodies[j]!
        if (A.group >= 0 && A.group === B.group) continue
        if (A.invM === 0 && B.invM === 0) continue
        const reach = this.extent(A) + this.extent(B) + MARGIN
        const dx = B.x - A.x, dy = B.y - A.y
        if (dx * dx + dy * dy > reach * reach) continue
        this.vertsVsBody(i, j, v)
        this.vertsVsBody(j, i, v)
      }
    }
  }

  private vertsVsBody(i: number, j: number, v: [number, number]): void {
    const A = this.bodies[i]!, B = this.bodies[j]!
    const nv = A.kind === 0 ? 2 : 4
    for (let vi = 0; vi < nv; vi++) {
      this.vertex(A, vi, v)
      const q = this.pointVsBody(B, v[0], v[1])
      const sep = q.sep - A.r
      if (sep > MARGIN) continue
      this.addContact(i, j, q.nx, q.ny, q.qx, q.qy, sep, this.key(i, j, vi, q.region))
    }
  }

  private vertexVsStatic(bi: number, vi: number, px: number, py: number, r: number, k: number): void {
    const t = this.statics
    const ax = t.ax[k]!, ay = t.ay[k]!
    const dx = t.bx[k]! - ax, dy = t.by[k]! - ay
    const len2 = dx * dx + dy * dy
    let u = ((px - ax) * dx + (py - ay) * dy) / len2
    if (u < 0) u = 0
    else if (u > 1) u = 1
    const qx = ax + u * dx, qy = ay + u * dy
    const snx = t.nx[k]!, sny = t.ny[k]!
    const ox = px - qx, oy = py - qy
    const side = ox * snx + oy * sny
    if (side < 0) {
      // Just below the face: push out along its normal. Deeper means past a wall face under a top it stands on.
      if (u <= 0 || u >= 1 || -side > r) return
      this.addContact(bi, -1, snx, sny, px - snx * r, py - sny * r, side - r, this.key(bi, -1, vi, k))
      return
    }
    const d2 = ox * ox + oy * oy
    if (d2 > (r + MARGIN) * (r + MARGIN)) return
    const d = Math.sqrt(d2)
    let nx = snx, ny = sny
    if (d > 1e-9) { nx = ox / d; ny = oy / d }
    this.addContact(bi, -1, nx, ny, px - nx * r, py - ny * r, d - r, this.key(bi, -1, vi, k))
  }

  private key(a: number, b: number, va: number, eb: number): number {
    return (((a + 1) * 65 + (b + 1)) * 4096 + va) * 4096 + eb
  }

  /** Distance along a unit ray to the first static surface or body (bodies of skipGroup ignored), up to maxD. */
  raycast(ox: number, oy: number, dx: number, dy: number, maxD: number, skipGroup = -99): number {
    const t = this.statics
    let best = maxD
    const ex = ox + dx * maxD
    const c0 = Math.max(0, Math.floor(Math.min(ox, ex)) - t.x0), c1 = Math.min(t.cols - 1, Math.floor(Math.max(ox, ex)) - t.x0)
    this.stamp++
    for (let col = c0; col <= c1; col++) {
      for (const k of t.cellSegs[col]!) {
        if (this.segStamp[k] === this.stamp) continue
        this.segStamp[k] = this.stamp
        const d = raySegment(ox, oy, dx, dy, t.ax[k]!, t.ay[k]!, t.bx[k]!, t.by[k]!)
        if (d < best) best = d
      }
    }
    for (const b of this.bodies) {
      if (b.kind !== 1 || b.group === skipGroup) continue
      const d = rayBox(ox, oy, dx, dy, b)
      if (d < best) best = d
    }
    return best
  }
}

/** Distance along a unit ray (o, d) to segment ab, or Infinity. */
export function raySegment(ox: number, oy: number, dx: number, dy: number, ax: number, ay: number, bx: number, by: number): number {
  const ex = bx - ax, ey = by - ay
  const den = dx * ey - dy * ex
  if (den > -1e-12 && den < 1e-12) return Infinity
  const wx = ax - ox, wy = ay - oy
  const t = (wx * ey - wy * ex) / den
  const u = (wx * dy - wy * dx) / den
  return t >= 0 && u >= 0 && u <= 1 ? t : Infinity
}

function rayBox(ox: number, oy: number, dx: number, dy: number, b: Body): number {
  const rx = ox - b.x, ry = oy - b.y
  const lx = b.c * rx + b.s * ry, ly = -b.s * rx + b.c * ry
  const ldx = b.c * dx + b.s * dy, ldy = -b.s * dx + b.c * dy
  let tmin = 0, tmax = Infinity
  for (let axis = 0; axis < 2; axis++) {
    const o = axis ? ly : lx, d = axis ? ldy : ldx, h = axis ? b.hy : b.hx
    if (d > -1e-12 && d < 1e-12) {
      if (o < -h || o > h) return Infinity
      continue
    }
    let t1 = (-h - o) / d, t2 = (h - o) / d
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp }
    if (t1 > tmin) tmin = t1
    if (t2 < tmax) tmax = t2
    if (tmin > tmax) return Infinity
  }
  return tmin
}

/** Squared distance between segments p1q1 and p2q2. */
export function segSegDist2(p1x: number, p1y: number, q1x: number, q1y: number, p2x: number, p2y: number, q2x: number, q2y: number): number {
  const d1x = q1x - p1x, d1y = q1y - p1y, d2x = q2x - p2x, d2y = q2y - p2y
  const rx = p1x - p2x, ry = p1y - p2y
  const a = d1x * d1x + d1y * d1y, e = d2x * d2x + d2y * d2y, f = d2x * rx + d2y * ry
  let s: number, t: number
  if (a <= 1e-12 && e <= 1e-12) return rx * rx + ry * ry
  if (a <= 1e-12) {
    s = 0
    t = Math.max(0, Math.min(1, f / e))
  } else {
    const c = d1x * rx + d1y * ry
    if (e <= 1e-12) {
      t = 0
      s = Math.max(0, Math.min(1, -c / a))
    } else {
      const b = d1x * d2x + d1y * d2y
      const den = a * e - b * b
      s = den > 1e-12 ? Math.max(0, Math.min(1, (b * f - c * e) / den)) : 0
      t = (b * s + f) / e
      if (t < 0) { t = 0; s = Math.max(0, Math.min(1, -c / a)) }
      else if (t > 1) { t = 1; s = Math.max(0, Math.min(1, (b - c) / a)) }
    }
  }
  const cx = p1x + d1x * s - (p2x + d2x * t), cy = p1y + d1y * s - (p2y + d2y * t)
  return cx * cx + cy * cy
}

/** FNV-style hash of every body's state, for determinism checks. */
export function worldHash(bodies: readonly Body[]): string {
  const buf = new Float64Array(bodies.length * 6)
  bodies.forEach((b, i) => buf.set([b.x, b.y, b.a, b.vx, b.vy, b.w], i * 6))
  const bytes = new Uint8Array(buf.buffer)
  let h = 0x811c9dc5
  for (const v of bytes) h = Math.imul(h ^ v, 0x01000193) >>> 0
  return h.toString(16).padStart(8, "0")
}
