import type { Rect } from "../geom"

/**
 * 2D oriented-box contacts and rigid-body impulses on the floor plan (x, y), ported from getaway's collide.ts. A heading
 * h faces (cos h, sin h) and the angular velocity w is dh/dt, so a point at offset r from the centre moves at
 * v + w * (-r.y, r.x).
 */

/** A box with centre (x, y), unit axis a = (ax, ay) of half extent ea, and axis b = (ay, -ax) of half extent eb. */
export type Shape = { x: number; y: number; ax: number; ay: number; ea: number; eb: number }

export type Point = { x: number; y: number; depth: number }

/** Normal (nx, ny) points from the first shape to the second; depth is the minimum translation distance. */
export type Contact = { nx: number; ny: number; depth: number; points: Point[] }

/** Anything with a pose and a velocity. */
export type Rigid = { x: number; y: number; h: number; vx: number; vy: number; w: number }

export type Mass = { invM: number; invI: number }

export const STATIC: Mass = { invM: 0, invI: 0 }

/** Scales the uniform-box moment of inertia: real vehicles carry their mass nearer the middle. */
const INERTIA = 0.8

export function boxMass(mass: number, length: number, width: number): Mass {
  return { invM: 1 / mass, invI: 12 / (mass * INERTIA * (length * length + width * width)) }
}

export function orientedShape(x: number, y: number, h: number, hl: number, hw: number): Shape {
  return { x, y, ax: Math.cos(h), ay: Math.sin(h), ea: hl, eb: hw }
}

export function rectShape(r: Rect): Shape {
  return { x: (r[0] + r[2]) / 2, y: (r[1] + r[3]) / 2, ax: 1, ay: 0, ea: (r[2] - r[0]) / 2, eb: (r[3] - r[1]) / 2 }
}

/** Half extent of a shape projected on a unit axis. */
function reach(s: Shape, nx: number, ny: number): number {
  return s.ea * Math.abs(s.ax * nx + s.ay * ny) + s.eb * Math.abs(s.ay * nx - s.ax * ny)
}

/**
 * Separating-axis test between two boxes with a clipped contact manifold (one or two points), Box2D style: the face
 * of least penetration is the reference face, the most anti-parallel face of the other box is clipped against its
 * sides, and the clipped points still behind the reference face are the contacts.
 */
export function collideShapes(a: Shape, b: Shape): Contact | null {
  const dx = b.x - a.x
  const dy = b.y - a.y
  let best = Infinity
  let nx = 0
  let ny = 0
  let refB = false
  let refK = 0
  for (let o = 0; o < 2; o++) {
    const s = o === 0 ? a : b
    for (let k = 0; k < 2; k++) {
      const ux = k === 0 ? s.ax : s.ay
      const uy = k === 0 ? s.ay : -s.ax
      const d = dx * ux + dy * uy
      const overlap = reach(a, ux, uy) + reach(b, ux, uy) - Math.abs(d)
      if (overlap <= 0) return null
      // Prefer the first box's faces unless the second's are clearly better, so the manifold doesn't flicker.
      if (o === 0 ? overlap < best : overlap < best * 0.95 - 0.002) {
        best = overlap
        const sign = d >= 0 ? 1 : -1
        nx = ux * sign
        ny = uy * sign
        refB = o === 1
        refK = k
      }
    }
  }
  const ref = refB ? b : a
  const inc = refB ? a : b
  const rnx = refB ? -nx : nx
  const rny = refB ? -ny : ny
  const refE = refK === 0 ? ref.ea : ref.eb
  const tx = refK === 0 ? ref.ay : ref.ax
  const ty = refK === 0 ? -ref.ax : ref.ay
  const refT = refK === 0 ? ref.eb : ref.ea
  const da = inc.ax * rnx + inc.ay * rny
  const db = inc.ay * rnx - inc.ax * rny
  let fnx: number, fny: number, fe: number, ftx: number, fty: number, ft: number
  if (Math.abs(da) >= Math.abs(db)) {
    const s = da > 0 ? -1 : 1
    fnx = inc.ax * s
    fny = inc.ay * s
    fe = inc.ea
    ftx = inc.ay
    fty = -inc.ax
    ft = inc.eb
  } else {
    const s = db > 0 ? -1 : 1
    fnx = inc.ay * s
    fny = -inc.ax * s
    fe = inc.eb
    ftx = inc.ax
    fty = inc.ay
    ft = inc.ea
  }
  const cx = inc.x + fnx * fe
  const cy = inc.y + fny * fe
  let p1x = cx + ftx * ft
  let p1y = cy + fty * ft
  let p2x = cx - ftx * ft
  let p2y = cy - fty * ft
  for (const side of [1, -1]) {
    const ux = tx * side
    const uy = ty * side
    const lim = refT + ref.x * ux + ref.y * uy
    const d1 = p1x * ux + p1y * uy - lim
    const d2 = p2x * ux + p2y * uy - lim
    if (d1 > 0 && d2 > 0) {
      p1x = p2x = (p1x + p2x) / 2
      p1y = p2y = (p1y + p2y) / 2
      break
    }
    if (d1 > 0) {
      const t = d1 / (d1 - d2)
      p1x += (p2x - p1x) * t
      p1y += (p2y - p1y) * t
    } else if (d2 > 0) {
      const t = d2 / (d2 - d1)
      p2x += (p1x - p2x) * t
      p2y += (p1y - p2y) * t
    }
  }
  const face = refE + ref.x * rnx + ref.y * rny
  const points: Point[] = []
  for (const [px, py] of [
    [p1x, p1y],
    [p2x, p2y],
  ] as const) {
    const sep = px * rnx + py * rny - face
    if (sep < 0) points.push({ x: px - (rnx * sep) / 2, y: py - (rny * sep) / 2, depth: -sep })
  }
  if (points.length === 2 && Math.abs(points[0]!.x - points[1]!.x) + Math.abs(points[0]!.y - points[1]!.y) < 1e-6) points.pop()
  if (!points.length) points.push({ x: (p1x + p2x) / 2, y: (p1y + p2y) / 2, depth: best })
  return { nx, ny, depth: best, points }
}

/** What one resolved contact did: approach speed at the contact and where it was. */
export type Hit = { impact: number; x: number; y: number }

export type Response = { restitution: number; friction: number }

export const WALL: Response = { restitution: 0.25, friction: 0.2 }
export const CARS: Response = { restitution: 0.25, friction: 0.35 }

/** Below this approach speed contacts don't bounce, so a vehicle pressed against something rests instead of buzzing. */
const BOUNCE_MIN = 1.5
const ITERATIONS = 6

/** r x u, the lever arm of a push along u at offset r. */
const cross = (rx: number, ry: number, ux: number, uy: number) => rx * uy - ry * ux

/**
 * Sequential impulses at the contact points with friction and spin, for two rigid bodies (b may be null or have
 * STATIC mass, in which case its velocity is never touched). Positions are left alone.
 */
export function resolve(a: Rigid, ma: Mass, b: Rigid | null, mb: Mass, c: Contact, res: Response): Hit {
  const { nx, ny } = c
  const tx = ny
  const ty = -nx
  const bx = b?.x ?? 0
  const by = b?.y ?? 0
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
  let hy = 0
  const vel = (i: number) => {
    const [rax, ray] = ra[i]!
    const [rbx, rby] = rb[i]!
    const vax = a.vx - a.w * ray
    const vay = a.vy + a.w * rax
    const vbx = b ? b.vx - b.w * rby : 0
    const vby = b ? b.vy + b.w * rbx : 0
    return [vbx - vax, vby - vay] as const
  }
  for (let i = 0; i < n; i++) {
    const p = c.points[i]!
    ra.push([p.x - a.x, p.y - a.y])
    rb.push([p.x - bx, p.y - by])
    const an = cross(ra[i]![0], ra[i]![1], nx, ny)
    const bn = cross(rb[i]![0], rb[i]![1], nx, ny)
    const at = cross(ra[i]![0], ra[i]![1], tx, ty)
    const bt = cross(rb[i]![0], rb[i]![1], tx, ty)
    kn.push(ma.invM + mb.invM + ma.invI * an * an + mb.invI * bn * bn)
    kt.push(ma.invM + mb.invM + ma.invI * at * at + mb.invI * bt * bt)
    const [rvx, rvy] = vel(i)
    const vn = rvx * nx + rvy * ny
    bias.push(vn < -BOUNCE_MIN ? -res.restitution * vn : 0)
    accN.push(0)
    accT.push(0)
    if (-vn > impact) impact = -vn
    hx += p.x / n
    hy += p.y / n
  }
  const apply = (i: number, px: number, py: number) => {
    const [rax, ray] = ra[i]!
    const [rbx, rby] = rb[i]!
    a.vx -= px * ma.invM
    a.vy -= py * ma.invM
    a.w -= ma.invI * cross(rax, ray, px, py)
    if (b && (mb.invM > 0 || mb.invI > 0)) {
      b.vx += px * mb.invM
      b.vy += py * mb.invM
      b.w += mb.invI * cross(rbx, rby, px, py)
    }
  }
  const vn = (i: number) => {
    const [rvx, rvy] = vel(i)
    return rvx * nx + rvy * ny
  }
  const setN = (i: number, next: number) => {
    const dn = next - accN[i]!
    accN[i] = next
    apply(i, nx * dn, ny * dn)
  }
  let k12 = 0
  if (n === 2) {
    const a1 = cross(ra[0]![0], ra[0]![1], nx, ny)
    const a2 = cross(ra[1]![0], ra[1]![1], nx, ny)
    const b1 = cross(rb[0]![0], rb[0]![1], nx, ny)
    const b2 = cross(rb[1]![0], rb[1]![1], nx, ny)
    k12 = ma.invM + mb.invM + ma.invI * a1 * a2 + mb.invI * b1 * b2
  }
  /** Both normal impulses at once (Box2D's block solver), so a flush face contact gets an even push. */
  const blockSolve = () => {
    const k11 = kn[0]!
    const k22 = kn[1]!
    const x1 = accN[0]!
    const x2 = accN[1]!
    const r1 = k11 * x1 + k12 * x2 + bias[0]! - vn(0)
    const r2 = k12 * x1 + k22 * x2 + bias[1]! - vn(1)
    const det = k11 * k22 - k12 * k12
    const ok = (y1: number, y2: number) => {
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
  for (let it = 0; it < ITERATIONS; it++) {
    if (n === 2) blockSolve()
    else setN(0, Math.max(0, accN[0]! - (vn(0) - bias[0]!) / kn[0]!))
    for (let i = 0; i < n; i++) {
      const [rvx, rvy] = vel(i)
      const vt = rvx * tx + rvy * ty
      const lim = res.friction * accN[i]!
      const nt = Math.max(-lim, Math.min(lim, accT[i]! - vt / kt[i]!))
      const d = nt - accT[i]!
      accT[i] = nt
      apply(i, tx * d, ty * d)
    }
  }
  return { impact, x: hx, y: hy }
}

/** Pushes two bodies apart along the contact normal, split by inverse mass, leaving `slop` of overlap. */
export function separate(a: Rigid, ma: Mass, b: Rigid | null, mb: Mass, c: Contact, slop: number): void {
  const push = c.depth - slop
  const total = ma.invM + mb.invM
  if (push <= 0 || total <= 0) return
  const ka = (push * ma.invM) / total
  a.x -= c.nx * ka
  a.y -= c.ny * ka
  if (b && mb.invM > 0) {
    const kb = (push * mb.invM) / total
    b.x += c.nx * kb
    b.y += c.ny * kb
  }
}
