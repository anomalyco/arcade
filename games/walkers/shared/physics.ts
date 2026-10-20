// A minimal deterministic 2D rigid-body sim: capsule bodies, revolute joints with angle limits and torque motors, and
// contacts against a static terrain polyline. Sequential impulses (Box2D Lite style) with Baumgarte stabilisation and
// warm-started joints, a fixed substep, y up, metres, kilograms, seconds. Bodies of one creature never collide with each
// other, only with the ground. Only IEEE-exact arithmetic and fmath are used, so a run is bit-identical on every engine.

import { sincos } from "./fmath"

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
  /** Half the capsule's core length along its local x axis. */
  hl: number
  r: number
  m: number
  invM: number
  invI: number
  /** Touched the ground during the last step. */
  contact: boolean
}

export type Joint = {
  a: number
  b: number
  lax: number
  lay: number
  lbx: number
  lby: number
  ref: number
  lower: number
  upper: number
  maxTorque: number
  /** Torque applied during the last step (N·m), for energy and drawing. */
  torque: number
  px: number
  py: number
  lowerImpulse: number
  upperImpulse: number
}

export type Terrain = {
  /** Polyline vertices, x non-decreasing (vertical runs make walls and steps). */
  xs: Float64Array
  ys: Float64Array
  x0: number
  /** Segment indices touching each 1 m column from x0. */
  cells: number[][]
  /** First and last segment index per column (segments are in x order, so a run of columns is one index range). */
  cellLo: Int32Array
  cellHi: Int32Array
  /** Vertices that stick out (wall and step corners), tested against capsule cores. */
  corners: number[]
}

export type PhysicsSettings = {
  gravity: number
  friction: number
  iterations: number
  /** Angular velocity damping per second (joint friction stand-in). */
  angularDamping: number
}

export const DEFAULT_PHYSICS: PhysicsSettings = { gravity: 9.81, friction: 0.9, iterations: 8, angularDamping: 0.6 }

const BAUMGARTE = 0.2
const SLOP = 0.005
const MAX_LIMIT_BIAS = 4

export function makeTerrain(points: readonly (readonly [number, number])[]): Terrain {
  const n = points.length
  const xs = new Float64Array(n)
  const ys = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    xs[i] = points[i]![0]
    ys[i] = points[i]![1]
  }
  const x0 = Math.floor(xs[0]!)
  const cols = Math.floor(xs[n - 1]!) - x0 + 1
  const cells: number[][] = Array.from({ length: cols }, () => [])
  for (let i = 0; i < n - 1; i++) {
    const lo = Math.floor(Math.min(xs[i]!, xs[i + 1]!)) - x0
    const hi = Math.floor(Math.max(xs[i]!, xs[i + 1]!)) - x0
    for (let c = Math.max(0, lo); c <= Math.min(cols - 1, hi); c++) cells[c]!.push(i)
  }
  const cellLo = new Int32Array(cols).fill(0)
  const cellHi = new Int32Array(cols).fill(-1)
  for (let c = 0; c < cols; c++) {
    const list = cells[c]!
    if (list.length) { cellLo[c] = list[0]!; cellHi[c] = list[list.length - 1]! }
  }
  // Empty columns would break a run; give them their neighbours' bounds.
  for (let c = 1; c < cols; c++) if (cellHi[c]! < 0) { cellLo[c] = cellHi[c - 1]!; cellHi[c] = cellHi[c - 1]! }
  const corners: number[] = []
  for (let i = 1; i < n - 1; i++) {
    const d1x = xs[i]! - xs[i - 1]!
    const d1y = ys[i]! - ys[i - 1]!
    const d2x = xs[i + 1]! - xs[i]!
    const d2y = ys[i + 1]! - ys[i]!
    if (d1x * d2y - d1y * d2x < -1e-9) corners.push(i)
  }
  return { xs, ys, x0, cells, cellLo, cellHi, corners }
}

/** Ground height under x (the highest point of the polyline there). */
export function groundHeight(t: Terrain, x: number): number {
  const { xs, ys } = t
  const n = xs.length
  if (x <= xs[0]!) return ys[0]!
  if (x >= xs[n - 1]!) return ys[n - 1]!
  const cell = t.cells[Math.floor(x) - t.x0]
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

export function makeBody(x: number, y: number, a: number, hl: number, r: number, m: number): Body {
  // Solid capsule ≈ rod of length 2(hl + r) and thickness 2r.
  const len = 2 * (hl + r)
  const inertia = (m * (len * len + 4 * r * r)) / 12
  const sc: [number, number] = [0, 0]
  sincos(a, sc)
  return { x, y, a, vx: 0, vy: 0, w: 0, c: sc[1], s: sc[0], hl, r, m, invM: 1 / m, invI: 1 / inertia, contact: false }
}

/** A revolute joint at world point (x, y); limits are on angle(b) − angle(a) relative to the pose at creation. */
export function makeJoint(bodies: readonly Body[], a: number, b: number, x: number, y: number, lower: number, upper: number, maxTorque: number): Joint {
  const A = bodies[a]!, B = bodies[b]!
  const ax = x - A.x, ay = y - A.y
  const bx = x - B.x, by = y - B.y
  return {
    a, b,
    lax: A.c * ax + A.s * ay, lay: -A.s * ax + A.c * ay,
    lbx: B.c * bx + B.s * by, lby: -B.s * bx + B.c * by,
    ref: B.a - A.a, lower, upper, maxTorque, torque: 0,
    px: 0, py: 0, lowerImpulse: 0, upperImpulse: 0,
  }
}

export const jointAngle = (bodies: readonly Body[], j: Joint): number => bodies[j.b]!.a - bodies[j.a]!.a - j.ref
export const jointSpeed = (bodies: readonly Body[], j: Joint): number => bodies[j.b]!.w - bodies[j.a]!.w

type Contact = {
  body: number
  nx: number
  ny: number
  rx: number
  ry: number
  depth: number
  mn: number
  mt: number
  pn: number
  pt: number
}

export class World {
  readonly contacts: Contact[] = []
  private pool: Contact[] = []
  private sc: [number, number] = [0, 0]

  constructor(readonly bodies: Body[], readonly joints: Joint[], readonly terrain: Terrain, readonly settings: PhysicsSettings = DEFAULT_PHYSICS) {}

  /** Advances one substep of dt with each joint's motor at controls[i] ∈ [-1, 1] of its max torque. */
  step(dt: number, controls: ArrayLike<number>): void {
    const { bodies, joints, settings } = this
    const g = settings.gravity
    const damp = 1 / (1 + dt * settings.angularDamping)
    for (const b of bodies) {
      b.vy -= g * dt
      b.w *= damp
    }
    for (let i = 0; i < joints.length; i++) {
      const j = joints[i]!
      let u = controls[i] ?? 0
      if (u > 1) u = 1
      else if (u < -1) u = -1
      // u = u: NaN guard (a NaN control would poison the whole world).
      if (u !== u) u = 0
      const tau = u * j.maxTorque
      j.torque = tau
      const A = bodies[j.a]!, B = bodies[j.b]!
      A.w -= tau * A.invI * dt
      B.w += tau * B.invI * dt
    }

    this.collide()
    const invDt = 1 / dt

    // Joint prestep + warm start.
    for (const j of joints) {
      const A = bodies[j.a]!, B = bodies[j.b]!
      const rax = A.c * j.lax - A.s * j.lay, ray = A.s * j.lax + A.c * j.lay
      const rbx = B.c * j.lbx - B.s * j.lby, rby = B.s * j.lbx + B.c * j.lby
      const P = j.px, Q = j.py
      A.vx -= A.invM * P; A.vy -= A.invM * Q; A.w -= A.invI * (rax * Q - ray * P)
      B.vx += B.invM * P; B.vy += B.invM * Q; B.w += B.invI * (rbx * Q - rby * P)
      const L = j.lowerImpulse - j.upperImpulse
      A.w -= A.invI * L
      B.w += B.invI * L
    }

    const iterations = settings.iterations
    const mu = settings.friction
    for (let it = 0; it < iterations; it++) {
      for (const j of joints) this.solveJoint(j, invDt)
      for (const c of this.contacts) {
        const B = bodies[c.body]!
        const vx = B.vx - B.w * c.ry, vy = B.vy + B.w * c.rx
        const vn = vx * c.nx + vy * c.ny
        const bias = BAUMGARTE * invDt * Math.max(c.depth - SLOP, 0)
        let dpn = c.mn * (-vn + bias)
        const pn = Math.max(c.pn + dpn, 0)
        dpn = pn - c.pn
        c.pn = pn
        let px = dpn * c.nx, py = dpn * c.ny
        B.vx += B.invM * px; B.vy += B.invM * py; B.w += B.invI * (c.rx * py - c.ry * px)
        const tx = -c.ny, ty = c.nx
        const ux = B.vx - B.w * c.ry, uy = B.vy + B.w * c.rx
        const vt = ux * tx + uy * ty
        let dpt = c.mt * -vt
        const maxF = mu * c.pn
        const pt = Math.max(-maxF, Math.min(c.pt + dpt, maxF))
        dpt = pt - c.pt
        c.pt = pt
        px = dpt * tx; py = dpt * ty
        B.vx += B.invM * px; B.vy += B.invM * py; B.w += B.invI * (c.rx * py - c.ry * px)
      }
    }

    const sc = this.sc
    for (const b of bodies) {
      b.x += b.vx * dt
      b.y += b.vy * dt
      b.a += b.w * dt
      sincos(b.a, sc)
      b.s = sc[0]
      b.c = sc[1]
    }
  }

  private solveJoint(j: Joint, invDt: number): void {
    const A = this.bodies[j.a]!, B = this.bodies[j.b]!
    const iA = A.invI, iB = B.invI
    // Angle limits (speculative: the impulse also stops an approach that would cross the limit within this step).
    const axial = 1 / (iA + iB)
    const angle = B.a - A.a - j.ref
    {
      const C = angle - j.lower
      const bias = C > 0 ? C * invDt : Math.max(BAUMGARTE * C * invDt, -MAX_LIMIT_BIAS)
      const cdot = B.w - A.w
      let imp = -axial * (cdot + bias)
      const next = Math.max(j.lowerImpulse + imp, 0)
      imp = next - j.lowerImpulse
      j.lowerImpulse = next
      A.w -= iA * imp
      B.w += iB * imp
    }
    {
      const C = j.upper - angle
      const bias = C > 0 ? C * invDt : Math.max(BAUMGARTE * C * invDt, -MAX_LIMIT_BIAS)
      const cdot = A.w - B.w
      let imp = -axial * (cdot + bias)
      const next = Math.max(j.upperImpulse + imp, 0)
      imp = next - j.upperImpulse
      j.upperImpulse = next
      A.w += iA * imp
      B.w -= iB * imp
    }
    // Point constraint.
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
    const vx = B.vx - B.w * rby - A.vx + A.w * ray + BAUMGARTE * invDt * cx
    const vy = B.vy + B.w * rbx - A.vy - A.w * rax + BAUMGARTE * invDt * cy
    const P = -inv * (k22 * vx - k12 * vy)
    const Q = -inv * (-k12 * vx + k11 * vy)
    j.px += P
    j.py += Q
    A.vx -= mA * P; A.vy -= mA * Q; A.w -= iA * (rax * Q - ray * P)
    B.vx += mB * P; B.vy += mB * Q; B.w += iB * (rbx * Q - rby * P)
  }

  private addContact(body: number, nx: number, ny: number, px: number, py: number, depth: number): void {
    const B = this.bodies[body]!
    const c = this.pool.pop() ?? { body: 0, nx: 0, ny: 0, rx: 0, ry: 0, depth: 0, mn: 0, mt: 0, pn: 0, pt: 0 }
    const rx = px - B.x, ry = py - B.y
    const rn = rx * ny - ry * nx
    const rt = rx * nx + ry * ny // cross(r, t) with t = (-ny, nx)
    c.body = body
    c.nx = nx; c.ny = ny; c.rx = rx; c.ry = ry; c.depth = depth
    c.mn = 1 / (B.invM + B.invI * rn * rn)
    c.mt = 1 / (B.invM + B.invI * rt * rt)
    c.pn = 0; c.pt = 0
    this.contacts.push(c)
    B.contact = true
  }

  private collide(): void {
    for (const c of this.contacts) this.pool.push(c)
    this.contacts.length = 0
    const t = this.terrain
    const { xs, ys } = t
    const cols = t.cells.length
    for (let bi = 0; bi < this.bodies.length; bi++) {
      const B = this.bodies[bi]!
      B.contact = false
      const ex = B.c * B.hl, ey = B.s * B.hl
      const r = B.r
      // Each capsule end as a circle against nearby segments.
      for (let e = 0; e < 2; e++) {
        const cx = e === 0 ? B.x + ex : B.x - ex
        const cy = e === 0 ? B.y + ey : B.y - ey
        const col = Math.floor(cx) - t.x0
        const c0 = Math.max(0, col - 1), c1 = Math.min(cols - 1, col + 1)
        if (c0 > c1) continue
        const lo = t.cellLo[c0]!, hi = t.cellHi[c1]!
        for (let i = lo; i <= hi; i++) {
          const ax = xs[i]!, ay = ys[i]!
          const dx = xs[i + 1]! - ax, dy = ys[i + 1]! - ay
          const len2 = dx * dx + dy * dy
          if (len2 < 1e-12) continue
          let u = ((cx - ax) * dx + (cy - ay) * dy) / len2
          if (u < 0) u = 0
          else if (u > 1) u = 1
          const qx = ax + u * dx, qy = ay + u * dy
          const len = Math.sqrt(len2)
          const snx = -dy / len, sny = dx / len
          const ox = cx - qx, oy = cy - qy
          const side = ox * snx + oy * sny
          const d2 = ox * ox + oy * oy
          if (side < 0) {
            // Centre just below the surface: push out along the face normal. Deeper means it is past a wall
            // face under a top it stands on, which the top segment handles.
            if (u <= 0 || u >= 1 || -side > r) continue
            const depth = r - side
            this.addContact(bi, snx, sny, cx - snx * r, cy - sny * r, depth)
            continue
          }
          if (d2 >= r * r) continue
          const d = Math.sqrt(d2)
          let nx = snx, ny = sny
          if (d > 1e-9) { nx = ox / d; ny = oy / d }
          this.addContact(bi, nx, ny, cx - nx * r, cy - ny * r, r - d)
        }
      }
      // Terrain corners against the capsule core (a shin across the top of a wall).
      for (const k of t.corners) {
        const vx = xs[k]!, vy = ys[k]!
        const lx = vx - B.x, ly = vy - B.y
        if (lx * lx + ly * ly > (B.hl + r) * (B.hl + r)) continue
        const along = lx * B.c + ly * B.s
        if (along <= -B.hl || along >= B.hl) continue // the end circles handle it
        const qx = B.x + B.c * along, qy = B.y + B.s * along
        const ox = qx - vx, oy = qy - vy
        const d2 = ox * ox + oy * oy
        if (d2 >= r * r || d2 < 1e-18) continue
        const d = Math.sqrt(d2)
        const nx = ox / d, ny = oy / d
        this.addContact(bi, nx, ny, qx - nx * r, qy - ny * r, r - d)
      }
    }
  }
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
