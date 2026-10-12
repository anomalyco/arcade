import { FLAT_ACCEL, FLAT_GRIP, FLAT_SPEED, type Vehicle } from "../config"
import type { Box } from "./city"
import { type Contact, CARS, type Mass, STATIC, WALL, boxShape, carHalf, carMass, carShape, collideShapes, resolve, separate } from "./collide"

export type Input = {
  throttle: number
  brake: number
  steer: number
  handbrake: boolean
  boost: boolean
  /** Gadget slot pressed (Q = 0, E = 1). The world fires once per press: a value that repeats across inputs is ignored until it goes back to null. */
  gadget?: 0 | 1 | null
  /** Engine key (H) held. Each press toggles the engine; like gadgets, a value repeated across inputs does nothing. */
  engine?: boolean
}

export const NO_INPUT: Input = { throttle: 0, brake: 0, steer: 0, handbrake: false, boost: false }

export type Body = {
  x: number
  z: number
  h: number
  vx: number
  vz: number
  yaw: number
  boostFuel: number
  hp: number
  stun: number
  /** Drift state 0..1. The handbrake sets it to 1; throttle while sliding keeps it alive, so the angle holds. */
  drift?: number
  /** Seconds left spinning on an oil slick (almost no grip, no steering). */
  slip?: number
  /** Popped tires as a bit mask: 1 front left, 2 front right, 4 rear left, 8 rear right. They stay flat until repaired. */
  wheels?: number
  /** Engine switched off: no throttle, reverse or boost; the car coasts, brakes and steers as it rolls. */
  engineOff?: boolean
  /** Seconds left cranking after a restart, before the throttle answers. */
  crank?: number
  /** Seconds left knocked loose by a hit from another car: less grip and steering, and the yaw from the hit carries on. */
  spin?: number
}

/** Driving tunables. Speeds in m/s, rates per second. */
export const DRIVE = {
  boostSpeed: 1.3,
  boostAccel: 1.6,
  boostDrain: 3.5,
  boostRefill: 12,
  handbrakeGrip: 0.2,
  driftGrip: 0.3,
  driftYaw: 1.5,
  powerOversteer: 0.8,
  driftHold: 0.25,
  driftExit: 3.5,
  driftMomentum: 0.5,
  recoverAngle: 1.0,
  recoverGain: 6,
  reverseMax: 14,
  /** Flat tires: steering kept per flat front tire, grip kept per flat rear tire (on top of FLAT_GRIP). */
  flatSteer: 0.8,
  flatRearGrip: 0.88,
  /** Yaw rate (rad/s) the car pulls toward its flat side, per tire of left-right imbalance, at speed. */
  flatPull: 0.1,
  /** Wobble: yaw rate (rad/s) per flat tire, and how fast it cycles with distance (rad per meter). */
  flatWobble: 0.12,
  flatWobbleFreq: 0.35,
  oilGrip: 0.05,
  crank: 0.8,
  /** An engine-off car slower than this is dark: invisible to radar and the helicopter. */
  darkSpeed: 1.5,
  /** Knocked loose: at this many seconds left the car has lost its full share of control; never more than spinMax. */
  spinFull: 0.35,
  spinMax: 1.2,
  /** While knocked loose: share of grip, steering and yaw recovery lost. */
  spinGrip: 0.75,
  spinSteer: 0.7,
  spinYaw: 0.9,
}

/** A hit from another car that changes a body's velocity by more than this stuns it. */
export const RAM_STUN_DV = 9

export function newBody(x: number, z: number, h: number): Body {
  return { x, z, h, vx: 0, vz: 0, yaw: 0, boostFuel: 1, hp: 1, stun: 0, drift: 0, slip: 0, wheels: 0, engineOff: false, crank: 0, spin: 0 }
}

/** Tires in Body.wheels order. */
export const WHEEL_NAMES = ["FL", "FR", "RL", "RR"] as const

/** How many tires a wheel mask has popped. */
export function flatCount(wheels = 0) {
  return (wheels & 1) + ((wheels >> 1) & 1) + ((wheels >> 2) & 1) + ((wheels >> 3) & 1)
}

/** Switches the engine off, or starts it again (the throttle answers after DRIVE.crank seconds). */
export function toggleEngine(b: Body) {
  b.engineOff = !b.engineOff
  b.crank = b.engineOff ? 0 : DRIVE.crank
}

export function isDark(b: Body) {
  return !!b.engineOff && speedOf(b) < DRIVE.darkSpeed
}

export function forward(h: number): [number, number] {
  return [Math.sin(h), Math.cos(h)]
}

export function speedOf(b: Body) {
  return Math.hypot(b.vx, b.vz)
}

const STUNNED: Input = { throttle: 0, brake: 0.6, steer: 0, handbrake: false, boost: false }

/**
 * Integrates one car. Heading changes first, then the world velocity is re-split into forward and sideways parts and the
 * sideways part is damped by grip. Drifting lowers grip and adds yaw; holding throttle with counter-steer keeps the slide.
 */
export function stepBody(b: Body, input: Input, spec: Vehicle, dt: number) {
  if (b.stun > 0) {
    b.stun = Math.max(0, b.stun - dt)
    input = STUNNED
  }
  const slip = b.slip ?? 0
  if (slip > 0) b.slip = Math.max(0, slip - dt)
  const wheels = b.wheels ?? 0
  const flats = flatCount(wheels)
  const fronts = (wheels & 1) + ((wheels >> 1) & 1)
  const rears = flats - fronts
  const spin = b.spin ?? 0
  if (spin > 0) b.spin = Math.max(0, spin - dt)
  const loose = Math.min(1, spin / DRIVE.spinFull)
  const crank = b.crank ?? 0
  if (crank > 0) b.crank = Math.max(0, crank - dt)
  const dead = !!b.engineOff || crank > 0
  if (dead && (input.throttle > 0 || input.boost)) input = { ...input, throttle: Math.min(0, input.throttle), boost: false }
  const boosting = input.boost && b.boostFuel > 0 && b.stun <= 0
  if (boosting) b.boostFuel = Math.max(0, b.boostFuel - dt / DRIVE.boostDrain)
  else b.boostFuel = Math.min(1, b.boostFuel + dt / DRIVE.boostRefill)

  let [fx, fz] = forward(b.h)
  let vf = b.vx * fx + b.vz * fz
  let vl = b.vx * fz - b.vz * fx
  const absVf = Math.abs(vf)
  const speed = Math.hypot(vf, vl)
  const beta = speed > 1 ? Math.atan2(Math.abs(vl), Math.max(0.1, absVf)) : 0
  const dir = vf >= -0.5 ? 1 : -1
  const vmax = spec.maxSpeed * (boosting ? DRIVE.boostSpeed : 1) * FLAT_SPEED[flats]!

  let drift = b.drift ?? 0
  if (input.handbrake && absVf > 7) drift = 1
  else if (drift > 0) {
    const hold = input.throttle > 0.2 && beta > 0.14 && speed > 9
    drift = Math.max(0, drift - dt * (hold ? DRIVE.driftHold : DRIVE.driftExit))
  }
  b.drift = drift

  const speedFactor = Math.min(1, absVf / 8) * (1 - 0.32 * Math.min(1, absVf / spec.maxSpeed))
  let target = input.steer * spec.turn * speedFactor * dir * (1 + (DRIVE.driftYaw - 1) * drift)
  // Power oversteer: on throttle the tail keeps swinging the way it is already sliding; counter-steer balances it.
  if (drift > 0 && input.throttle > 0) target -= Math.sign(vl) * Math.min(1, Math.abs(vl) / 5) * spec.turn * DRIVE.powerOversteer * drift * input.throttle
  let rate = input.steer === 0 ? (drift > 0 ? 3 : 6) : drift > 0 ? 7 : 10
  if (flats > 0) {
    // Flat fronts don't answer the wheel as well. A one-sided flat drags the car toward it, and the flapping rubber
    // wobbles it (rear flats more), growing with speed.
    target *= DRIVE.flatSteer ** fronts
    const lean = ((wheels >> 1) & 1) + ((wheels >> 3) & 1) - (wheels & 1) - ((wheels >> 2) & 1)
    const wobble = DRIVE.flatWobble * (0.6 * fronts + rears) * Math.sin(DRIVE.flatWobbleFreq * (b.x + b.z))
    target += dir * Math.min(1, absVf / 15) * (lean * DRIVE.flatPull + wobble)
  }
  if (loose > 0) {
    target *= 1 - DRIVE.spinSteer * loose
    rate *= 1 - DRIVE.spinYaw * loose
  }
  if (slip > 0) {
    target = b.yaw
    rate = 0
  }
  b.yaw += (target - b.yaw) * Math.min(1, dt * rate)
  b.h += b.yaw * dt
  ;[fx, fz] = forward(b.h)
  const rx = fz
  const rz = -fx
  vf = b.vx * fx + b.vz * fz
  vl = b.vx * rx + b.vz * rz

  let a = 0
  if (input.throttle > 0) {
    const x = Math.max(0, vf) / vmax
    a += spec.accel * FLAT_ACCEL[flats]! * input.throttle * (boosting ? DRIVE.boostAccel : 1) * Math.max(0, 1 - x * x) * (vf < 0 ? 1.4 : 1)
  }
  if (input.throttle < 0) {
    if (vf > 0.5) a -= spec.brake * -input.throttle
    else if (!dead) a += spec.accel * FLAT_ACCEL[flats]! * 0.6 * input.throttle * Math.max(0, 1 + vf / (DRIVE.reverseMax * FLAT_SPEED[flats]!))
  }
  if (input.brake > 0 && vf > 0.5) a -= spec.brake * input.brake
  if (input.handbrake && absVf > 0.5) a -= 5 * Math.sign(vf)
  a -= input.throttle !== 0 && !dead ? 0.02 * vf : Math.sign(vf) * Math.min(Math.abs(vf) * 4, 0.6 + 0.04 * Math.abs(vf))
  if (vf > vmax) a -= (vf - vmax) * 0.8
  if (drift > 0) a -= 0.15 * Math.abs(vl) * Math.sign(vf)

  let gripMul = 1
  if (drift > 0) gripMul = 1 + ((input.handbrake ? DRIVE.handbrakeGrip : DRIVE.driftGrip) - 1) * Math.min(1, drift * 2.5)
  // Assist: past ~60 degrees of slide the tires bite back, so overcooked drifts straighten out instead of spinning.
  if (beta > DRIVE.recoverAngle) gripMul *= 1 + DRIVE.recoverGain * (beta - DRIVE.recoverAngle)
  if (flats > 0) gripMul *= FLAT_GRIP[flats]! * DRIVE.flatRearGrip ** rears
  if (absVf < 1.5) gripMul *= 2
  // Knocked loose: the tires skid, so the grip assists above don't apply either.
  if (loose > 0) gripMul += (1 - DRIVE.spinGrip - gripMul) * loose
  if (slip > 0) gripMul = DRIVE.oilGrip
  const lat0 = vl
  vl *= Math.exp(-spec.grip * gripMul * dt)
  // Some of the scrubbed sideways speed carries into forward speed, so a held slide keeps its pace.
  if (drift > 0 && input.throttle > 0 && vf > 0) vf += Math.abs(lat0 - vl) * DRIVE.driftMomentum * drift
  vf += a * dt
  if (b.stun > 0) vf *= Math.exp(-2 * dt)
  if (input.brake > 0.5 && input.throttle === 0 && Math.abs(vf) < 2.5 && Math.abs(vl) < 2.5) {
    vf = 0
    vl = 0
  }
  if (Math.abs(vf) < 0.05 && Math.abs(vl) < 0.05 && (input.throttle === 0 || dead)) {
    vf = 0
    vl = 0
  }
  b.vx = fx * vf + rx * vl
  b.vz = fz * vf + rz * vl
  b.x += b.vx * dt
  b.z += b.vz * dt
}

export function lateralSpeed(b: Body) {
  const [fx, fz] = forward(b.h)
  return Math.abs(b.vx * -fz + b.vz * fx)
}

/** Strongest contact of a step, for effects: approach speed, contact point and normal (pointing into the car). */
export type Impact = { impact: number; x: number; z: number; nx: number; nz: number }

/** Overlap left in place against walls, so a car pressed into one keeps a steady contact instead of buzzing in and out. */
const WALL_SLOP = 0.002

/**
 * Pushes a car's oriented box out of axis-aligned boxes and resolves the hit with friction and spin: glancing scrapes
 * slide along, head-on hits stop with a small bounce, an off-center corner turns the car. Returns the impact speed (0 if
 * no contact) and fills `out` with the strongest contact.
 */
export function collideBoxes(b: Body, spec: Vehicle, boxes: Box[], out?: Impact): number {
  const [hl, hw] = carHalf(spec)
  const r = Math.hypot(hl, hw)
  const mass = carMass(spec)
  let impact = 0
  for (const box of boxes) {
    if (b.x < box.x0 - r || b.x > box.x1 + r || b.z < box.z0 - r || b.z > box.z1 + r) continue
    const c = collideShapes(boxShape(box), carShape(b, spec))
    if (!c) continue
    const hit = resolve(b, mass, null, STATIC, flip(c), WALL)
    separate(b, mass, null, STATIC, flip(c), WALL_SLOP)
    if (hit.impact > impact) {
      impact = hit.impact
      if (out) Object.assign(out, { impact, x: hit.x, z: hit.z, nx: c.nx, nz: c.nz })
    }
  }
  return impact
}

/** The same contact seen from the other side. */
function flip(c: Contact): Contact {
  return { ...c, nx: -c.nx, nz: -c.nz }
}

/** Substeps for one tick: no point of the car (spinning corners included) moves more than half its narrowest half-extent. */
export function substeps(b: Body, spec: Vehicle, dt: number) {
  const [hl, hw] = carHalf(spec)
  const travel = (speedOf(b) + spec.accel * dt + Math.abs(b.yaw) * hl) * dt
  return Math.max(1, Math.min(12, Math.ceil(travel / (Math.min(hl, hw) * 0.5))))
}

/**
 * stepBody plus collideBoxes, split into substeps so a fast or spinning car cannot tunnel through thin boxes
 * (roadblocks, parked cars). Returns the largest impact speed and fills `out` with that contact.
 */
export function stepAndCollide(b: Body, input: Input, spec: Vehicle, dt: number, boxes: Box[], out?: Impact): number {
  const n = substeps(b, spec, dt)
  // Only boxes this car could reach during the tick are worth testing in every substep.
  const [hl, hw] = carHalf(spec)
  const m = Math.hypot(hl, hw) + (speedOf(b) + spec.accel * dt) * dt * 1.5 + 0.5
  const near = boxes.filter((box) => b.x > box.x0 - m && b.x < box.x1 + m && b.z > box.z0 - m && b.z < box.z1 + m)
  let impact = 0
  const hit: Impact = { impact: 0, x: 0, z: 0, nx: 0, nz: 0 }
  for (let i = 0; i < n; i++) {
    stepBody(b, input, spec, dt / n)
    const k = near.length ? collideBoxes(b, spec, near, hit) : 0
    if (k > impact) {
      impact = k
      if (out) Object.assign(out, hit)
    }
  }
  if (out && impact === 0) out.impact = 0
  return impact
}

/** Sets the knocked-loose timer from how much a hit changed a body's sideways speed and yaw rate. */
export function knock(b: Body, dvSide: number, dw: number) {
  const s = Math.max(0, dw - 0.6) * 0.3 + Math.max(0, dvSide - 2) * 0.08
  if (s > 0) b.spin = Math.min(DRIVE.spinMax, Math.max(b.spin ?? 0, s))
}

/** A car-to-car contact as seen by the first car: the hit, and each side's change in velocity. */
export type CarHit = Impact & { dvA: number; dvB: number }

const CAR_SLOP = 0.01

/**
 * Car against car: oriented boxes, impulses with friction and spin, split by mass. The hit is resolved at the moment of
 * first touch: the impulse changes the velocities, and each car's position is corrected as if it had moved with its new
 * velocity since then, so fast hits don't sink in for a tick. Leftover overlap is pushed apart by inverse mass. A
 * `fixed` car is an immovable obstacle (frozen during the intro); a car whose body is a throwaway copy (prediction)
 * still gets its mass. Hard hits stun and knock loose. Returns null when they don't touch.
 */
export function collideCars(a: Body, va: Vehicle, b: Body, vb: Vehicle, dt: number, fixedA = false, fixedB = false): CarHit | null {
  if (fixedA && fixedB) return null
  const [la, wa] = carHalf(va)
  const [lb, wb] = carHalf(vb)
  const reach = Math.hypot(la, wa) + Math.hypot(lb, wb)
  const dx = b.x - a.x
  const dz = b.z - a.z
  if (dx * dx + dz * dz >= reach * reach) return null
  const c = collideShapes(carShape(a, va), carShape(b, vb))
  if (!c) return null
  const ma: Mass = fixedA ? STATIC : carMass(va)
  const mb: Mass = fixedB ? STATIC : carMass(vb)
  const closing = (a.vx - b.vx) * c.nx + (a.vz - b.vz) * c.nz
  const back = closing > 0.5 ? Math.min(dt, c.depth / closing) : 0
  const a0 = { vx: a.vx, vz: a.vz, yaw: a.yaw }
  const b0 = { vx: b.vx, vz: b.vz, yaw: b.yaw }
  const hit = resolve(a, ma, fixedB ? null : b, mb, c, CARS)
  for (const [body, v0, fixed] of [
    [a, a0, fixedA],
    [b, b0, fixedB],
  ] as const) {
    if (fixed) continue
    body.x += (body.vx - v0.vx) * back
    body.z += (body.vz - v0.vz) * back
    body.h += (body.yaw - v0.yaw) * back
  }
  const left = collideShapes(carShape(a, va), carShape(b, vb))
  if (left) separate(a, ma, fixedB ? null : b, mb, left, CAR_SLOP)
  const dv: [number, number] = [0, 0]
  ;[a, b].forEach((body, i) => {
    const v0 = i === 0 ? a0 : b0
    if (i === 0 ? fixedA : fixedB) return
    const ex = body.vx - v0.vx
    const ez = body.vz - v0.vz
    dv[i] = Math.hypot(ex, ez)
    knock(body, Math.abs(ex * Math.cos(body.h) - ez * Math.sin(body.h)), Math.abs(body.yaw - v0.yaw))
    if (dv[i]! > RAM_STUN_DV) body.stun = Math.max(body.stun, Math.min(1.1, dv[i]! / 22))
  })
  return { impact: hit.impact, x: hit.x, z: hit.z, nx: c.nx, nz: c.nz, dvA: dv[0], dvB: dv[1] }
}
