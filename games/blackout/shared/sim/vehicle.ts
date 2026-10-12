import { type Rect, gridOf } from "../geom"
import type { VehicleKind } from "../maps/types"
import { CARS, type Contact, type Mass, type Rigid, STATIC, WALL, boxMass, collideShapes, orientedShape, rectShape, resolve, separate } from "./vehicle-collide"

export type { VehicleKind } from "../maps/types"

/**
 * Arcade car physics for drivable vehicles, ported from getaway's vehicle.ts and trimmed for a top-down shooter: a
 * bicycle-style model (heading turns at a yaw rate that follows the wheel, sideways speed damped by grip), a handbrake
 * that lets the tail out, and oriented-box collisions against walls and other vehicles. The server and the driver's
 * client prediction both run it. A heading h faces (cos h, sin h) on the plan; the right side is (-sin h, cos h).
 */

/**
 * A place aboard: (f, s) metres forward and to the right of the centre. `sink` lowers the drawn soldier into the
 * vehicle (negative raises them: the van's roof hatches), `armor` scales the damage they take, and `shoots` whether
 * they can fire from it (never the driver, seat 0).
 */
export type Seat = { f: number; s: number; sink: number; armor: number }

export type VehicleSpec = {
  label: string
  /** Body size in metres; the collision box is a little inside it. */
  length: number
  width: number
  mass: number
  /** Top speed forward and in reverse (m/s), throttle and brake (m/s²), the yaw rate at full lock (rad/s), grip (1/s). */
  maxSpeed: number
  reverse: number
  accel: number
  brake: number
  turn: number
  grip: number
  hp: number
  /** Seat 0 drives. */
  seats: readonly Seat[]
}

export const VEHICLES: Record<VehicleKind, VehicleSpec> = {
  jeep: {
    label: "JEEP",
    length: 3.9,
    width: 1.9,
    mass: 1500,
    maxSpeed: 15,
    reverse: 6,
    accel: 8,
    brake: 16,
    turn: 2.3,
    grip: 9,
    hp: 600,
    seats: [
      { f: 0.0, s: -0.42, sink: 0.5, armor: 0.5 },
      { f: 0.0, s: 0.42, sink: 0.42, armor: 0.75 },
      { f: -1.05, s: -0.45, sink: 0.32, armor: 0.75 },
      { f: -1.05, s: 0.45, sink: 0.32, armor: 0.75 },
    ],
  },
  van: {
    label: "VAN",
    length: 5.0,
    width: 2.1,
    mass: 2600,
    maxSpeed: 11.5,
    reverse: 5,
    accel: 5,
    brake: 12,
    turn: 1.7,
    grip: 8,
    hp: 1000,
    seats: [
      { f: 1.05, s: -0.48, sink: 0.55, armor: 0.3 },
      { f: 0.2, s: 0.48, sink: -0.95, armor: 0.6 },
      { f: -1.1, s: -0.48, sink: -0.95, armor: 0.6 },
      { f: -1.1, s: 0.48, sink: -0.95, armor: 0.6 },
    ],
  },
  scooter: {
    label: "SCOOTER",
    length: 1.8,
    width: 0.75,
    mass: 220,
    maxSpeed: 18,
    reverse: 3,
    accel: 10,
    brake: 18,
    turn: 3,
    grip: 11,
    hp: 180,
    seats: [
      { f: 0.0, s: 0, sink: 0.12, armor: 1 },
      { f: -0.55, s: 0, sink: 0.02, armor: 1 },
    ],
  },
}
export const VEHICLE_KINDS = Object.keys(VEHICLES) as VehicleKind[]

/** One tick of driving: throttle -1 (brake, then reverse) to 1, steer -1 (left) to 1 (right), handbrake held. */
export type Drive = { throttle: number; steer: number; handbrake: boolean }
export const PARKED: Drive = { throttle: 0, steer: 0, handbrake: true }

/** The driver's controls from their intent: W/S throttle and brake, A/D steer, Shift the handbrake. */
export function driveOf(i: { mx: number; my: number; sprint: boolean }): Drive {
  return { throttle: Math.max(-1, Math.min(1, -i.my)), steer: Math.max(-1, Math.min(1, i.mx)), handbrake: i.sprint }
}

/** Collision box half extents (length, width): the bodywork has rounded corners. */
export function halfOf(spec: VehicleSpec): [number, number] {
  return [spec.length * 0.48, spec.width * 0.48]
}

const masses = new Map<VehicleSpec, Mass>()
export function massOf(spec: VehicleSpec): Mass {
  let m = masses.get(spec)
  if (!m) masses.set(spec, (m = boxMass(spec.mass, spec.length, spec.width)))
  return m
}

export const speedOf = (b: { vx: number; vy: number }) => Math.hypot(b.vx, b.vy)

/** Forward speed (negative reversing). */
export const forwardSpeed = (b: { h: number; vx: number; vy: number }) => b.vx * Math.cos(b.h) + b.vy * Math.sin(b.h)

/** Sideways speed, for skids. */
export const lateralSpeed = (b: { h: number; vx: number; vy: number }) => -b.vx * Math.sin(b.h) + b.vy * Math.cos(b.h)

/** A point (f, s) forward and right of a vehicle's centre, on the plan. */
export function localToWorld(b: { x: number; y: number; h: number }, f: number, s: number): { x: number; y: number } {
  const c = Math.cos(b.h)
  const n = Math.sin(b.h)
  return { x: b.x + c * f - n * s, y: b.y + n * f + c * s }
}

export function seatPos(b: { x: number; y: number; h: number }, spec: VehicleSpec, seat: number): { x: number; y: number } {
  const s = spec.seats[seat] ?? spec.seats[0]!
  return localToWorld(b, s.f, s.s)
}

/**
 * Integrates one vehicle. The heading turns first at a yaw rate easing toward what the wheel asks for (less at a crawl
 * and at top speed, reversed when backing up), then the velocity is split into forward and sideways parts: the
 * throttle, brakes and drag act along, grip damps the sideways part. The handbrake drops grip at speed (the tail
 * steps out) and stops the vehicle when slow; an empty vehicle sits on it.
 */
export function stepCar(b: Rigid, d: Drive, spec: VehicleSpec, dt: number): void {
  let fx = Math.cos(b.h)
  let fy = Math.sin(b.h)
  let vf = b.vx * fx + b.vy * fy
  const absVf = Math.abs(vf)
  const dir = vf >= -0.5 ? 1 : -1
  const slide = d.handbrake && absVf > 4
  const speedFactor = Math.min(1, absVf / 4) * (1 - 0.35 * Math.min(1, absVf / spec.maxSpeed))
  const target = d.steer * spec.turn * speedFactor * dir * (slide ? 1.35 : 1)
  const rate = d.steer === 0 ? (slide ? 2.5 : 6) : 10
  b.w += (target - b.w) * Math.min(1, dt * rate)
  b.h += b.w * dt
  if (b.h > Math.PI) b.h -= Math.PI * 2
  else if (b.h < -Math.PI) b.h += Math.PI * 2
  fx = Math.cos(b.h)
  fy = Math.sin(b.h)
  const rx = -fy
  const ry = fx
  vf = b.vx * fx + b.vy * fy
  let vl = b.vx * rx + b.vy * ry
  let a = 0
  if (d.throttle > 0) {
    const x = Math.max(0, vf) / spec.maxSpeed
    a += spec.accel * d.throttle * Math.max(0, 1 - x * x) * (vf < 0 ? 1.8 : 1)
  } else if (d.throttle < 0) {
    if (vf > 0.5) a -= spec.brake * -d.throttle
    else a += spec.accel * 0.7 * d.throttle * Math.max(0, 1 + vf / spec.reverse)
  }
  a -= d.throttle !== 0 ? 0.03 * vf : Math.sign(vf) * Math.min(Math.abs(vf) * 4, 0.8 + 0.05 * Math.abs(vf))
  if (d.handbrake) {
    // Locked wheels: hard on the brakes along the car, but never past a stop.
    const stop = Math.min(Math.abs(vf) / dt, slide ? 5 : 12)
    a -= Math.sign(vf) * stop
  }
  let gripMul = slide ? 0.16 : 1
  if (absVf < 1.5) gripMul *= 2
  vl *= Math.exp(-spec.grip * gripMul * dt)
  vf += a * dt
  if (Math.abs(vf) < 0.05 && Math.abs(vl) < 0.05 && d.throttle === 0) {
    vf = 0
    vl = 0
    b.w *= 0.5
  }
  b.vx = fx * vf + rx * vl
  b.vy = fy * vf + ry * vl
  b.x += b.vx * dt
  b.y += b.vy * dt
}

/** Overlap left in place against walls, so a vehicle pressed into one keeps a steady contact. */
const WALL_SLOP = 0.002
const CAR_SLOP = 0.01
const near: number[] = []

/**
 * Pushes a vehicle's box out of the given rects and resolves the hits with friction and spin: glancing scrapes slide
 * along, head-on hits stop with a small bounce, a corner turns the vehicle. Returns the hardest impact speed.
 */
export function collideWalls(b: Rigid, spec: VehicleSpec, rects: readonly Rect[]): number {
  const [hl, hw] = halfOf(spec)
  const r = Math.hypot(hl, hw)
  const mass = massOf(spec)
  const grid = gridOf(rects)
  const list = grid ? grid.query(b.x - r, b.y - r, b.x + r, b.y + r, near) : null
  const n = list ? list.length : rects.length
  let impact = 0
  for (let k = 0; k < n; k++) {
    const rc = rects[list ? list[k]! : k]!
    if (b.x < rc[0] - r || b.x > rc[2] + r || b.y < rc[1] - r || b.y > rc[3] + r) continue
    const c = collideShapes(rectShape(rc), orientedShape(b.x, b.y, b.h, hl, hw))
    if (!c) continue
    const f = flip(c)
    const hit = resolve(b, mass, null, STATIC, f, WALL)
    separate(b, mass, null, STATIC, f, WALL_SLOP)
    impact = Math.max(impact, hit.impact)
  }
  return impact
}

const flip = (c: Contact): Contact => ({ ...c, nx: -c.nx, ny: -c.ny })

/** Substeps for one tick: no point of the vehicle (spinning corners included) moves more than a quarter of its width. */
function substeps(b: Rigid, spec: VehicleSpec, dt: number): number {
  const [hl, hw] = halfOf(spec)
  const travel = (speedOf(b) + spec.accel * dt + Math.abs(b.w) * hl) * dt
  return Math.max(1, Math.min(12, Math.ceil(travel / (Math.min(hl, hw) * 0.5))))
}

/** stepCar plus wall collisions in substeps, so a fast vehicle can't tunnel through a thin wall. Returns the hardest impact. */
export function driveStep(b: Rigid, d: Drive, spec: VehicleSpec, dt: number, solids: readonly Rect[]): number {
  const n = substeps(b, spec, dt)
  let impact = 0
  for (let i = 0; i < n; i++) {
    stepCar(b, d, spec, dt / n)
    impact = Math.max(impact, collideWalls(b, spec, solids))
  }
  return impact
}

/**
 * Vehicle against vehicle: oriented boxes, impulses with friction and spin, split by mass. The hit is resolved at first
 * touch: each body's position is corrected as if it had moved with its new velocity since then, so fast hits don't sink
 * in for a tick; leftover overlap is pushed apart by inverse mass. A `fixed` body doesn't move (a wreck, or another
 * vehicle in client prediction). Returns the impact speed, 0 when they don't touch.
 */
export function collideCars(a: Rigid, sa: VehicleSpec, b: Rigid, sb: VehicleSpec, dt: number, fixedA = false, fixedB = false): number {
  if (fixedA && fixedB) return 0
  const [la, wa] = halfOf(sa)
  const [lb, wb] = halfOf(sb)
  const reach = Math.hypot(la, wa) + Math.hypot(lb, wb)
  const dx = b.x - a.x
  const dy = b.y - a.y
  if (dx * dx + dy * dy >= reach * reach) return 0
  const c = collideShapes(orientedShape(a.x, a.y, a.h, la, wa), orientedShape(b.x, b.y, b.h, lb, wb))
  if (!c) return 0
  const ma = fixedA ? STATIC : massOf(sa)
  const mb = fixedB ? STATIC : massOf(sb)
  const closing = (a.vx - b.vx) * c.nx + (a.vy - b.vy) * c.ny
  const back = closing > 0.5 ? Math.min(dt, c.depth / closing) : 0
  const a0 = { vx: a.vx, vy: a.vy, w: a.w }
  const b0 = { vx: b.vx, vy: b.vy, w: b.w }
  const hit = fixedA ? resolve(b, mb, null, STATIC, flip(c), CARS) : resolve(a, ma, fixedB ? null : b, mb, c, CARS)
  for (const [body, v0, fixed] of [
    [a, a0, fixedA],
    [b, b0, fixedB],
  ] as const) {
    if (fixed) continue
    body.x += (body.vx - v0.vx) * back
    body.y += (body.vy - v0.vy) * back
    body.h += (body.w - v0.w) * back
  }
  const left = collideShapes(orientedShape(a.x, a.y, a.h, la, wa), orientedShape(b.x, b.y, b.h, lb, wb))
  if (left) {
    if (fixedA) separate(b, mb, null, STATIC, flip(left), CAR_SLOP)
    else separate(a, ma, fixedB ? null : b, mb, left, CAR_SLOP)
  }
  return hit.impact
}

/** A box on the plan: centre, heading, half length and half width. */
export type Box = { x: number; y: number; h: number; hl: number; hw: number }

export function boxOf(b: { x: number; y: number; h: number }, spec: VehicleSpec): Box {
  const [hl, hw] = halfOf(spec)
  return { x: b.x, y: b.y, h: b.h, hl, hw }
}

/** Distance from a point to a box's outline, 0 inside. */
export function distToBox(x: number, y: number, k: Box): number {
  const c = Math.cos(k.h)
  const s = Math.sin(k.h)
  const dx = x - k.x
  const dy = y - k.y
  const f = dx * c + dy * s
  const r = -dx * s + dy * c
  return Math.hypot(Math.max(0, Math.abs(f) - k.hl), Math.max(0, Math.abs(r) - k.hw))
}

/** Pushes a circle out of a box. Returns whether they overlapped. */
export function pushOutBox(p: { x: number; y: number }, radius: number, k: Box): boolean {
  const c = Math.cos(k.h)
  const s = Math.sin(k.h)
  const dx = p.x - k.x
  const dy = p.y - k.y
  let f = dx * c + dy * s
  let r = -dx * s + dy * c
  if (Math.abs(f) >= k.hl + radius || Math.abs(r) >= k.hw + radius) return false
  const cf = Math.max(-k.hl, Math.min(k.hl, f))
  const cr = Math.max(-k.hw, Math.min(k.hw, r))
  const ef = f - cf
  const er = r - cr
  const d2 = ef * ef + er * er
  if (d2 >= radius * radius) return false
  if (d2 > 1e-12) {
    const d = Math.sqrt(d2)
    f = cf + (ef / d) * radius
    r = cr + (er / d) * radius
  } else if (k.hl - Math.abs(f) < k.hw - Math.abs(r)) f = Math.sign(f || 1) * (k.hl + radius)
  else r = Math.sign(r || 1) * (k.hw + radius)
  p.x = k.x + f * c - r * s
  p.y = k.y + f * s + r * c
  return true
}

/** Where a ray enters and leaves a box, or null when it misses within maxT. An origin inside enters at 0. */
export function rayBox(ox: number, oy: number, dx: number, dy: number, k: Box, maxT: number): [number, number] | null {
  const c = Math.cos(k.h)
  const s = Math.sin(k.h)
  const px = ox - k.x
  const py = oy - k.y
  const lo = [px * c + py * s, -px * s + py * c]
  const ld = [dx * c + dy * s, -dx * s + dy * c]
  const ext = [k.hl, k.hw]
  let t0 = 0
  let t1 = maxT
  for (let i = 0; i < 2; i++) {
    if (Math.abs(ld[i]!) < 1e-9) {
      if (Math.abs(lo[i]!) > ext[i]!) return null
      continue
    }
    let a = (-ext[i]! - lo[i]!) / ld[i]!
    let b = (ext[i]! - lo[i]!) / ld[i]!
    if (a > b) [a, b] = [b, a]
    t0 = Math.max(t0, a)
    t1 = Math.min(t1, b)
    if (t0 > t1) return null
  }
  return [t0, t1]
}
