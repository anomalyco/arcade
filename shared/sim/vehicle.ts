import type { Vehicle } from "../config"
import type { Box } from "./city"

export type Input = {
  throttle: number
  brake: number
  steer: number
  handbrake: boolean
  boost: boolean
  /** Gadget slot pressed (Q = 0, E = 1). The world fires once per press: a value that repeats across inputs is ignored until it goes back to null. */
  gadget?: 0 | 1 | null
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
  /** Seconds left on a flat tire (lower top speed and grip). */
  flat?: number
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
  recoverGain: 3,
  reverseMax: 14,
  flatSpeed: 0.68,
  flatGrip: 0.55,
  oilGrip: 0.05,
}

export function newBody(x: number, z: number, h: number): Body {
  return { x, z, h, vx: 0, vz: 0, yaw: 0, boostFuel: 1, hp: 1, stun: 0, drift: 0, slip: 0, flat: 0 }
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
  const flat = b.flat ?? 0
  if (slip > 0) b.slip = Math.max(0, slip - dt)
  if (flat > 0) b.flat = Math.max(0, flat - dt)
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
  const vmax = spec.maxSpeed * (boosting ? DRIVE.boostSpeed : 1) * (flat > 0 ? DRIVE.flatSpeed : 1)

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
    a += spec.accel * input.throttle * (boosting ? DRIVE.boostAccel : 1) * Math.max(0, 1 - x * x) * (vf < 0 ? 1.4 : 1)
  }
  if (input.throttle < 0) {
    if (vf > 0.5) a -= spec.brake * -input.throttle
    else a += spec.accel * 0.6 * input.throttle * Math.max(0, 1 + vf / DRIVE.reverseMax)
  }
  if (input.brake > 0 && vf > 0.5) a -= spec.brake * input.brake
  if (input.handbrake && absVf > 0.5) a -= 5 * Math.sign(vf)
  a -= input.throttle !== 0 ? 0.02 * vf : Math.sign(vf) * Math.min(Math.abs(vf) * 4, 0.6 + 0.04 * Math.abs(vf))
  if (vf > vmax) a -= (vf - vmax) * 0.8
  if (drift > 0) a -= 0.15 * Math.abs(vl) * Math.sign(vf)

  let gripMul = 1
  if (drift > 0) gripMul = 1 + ((input.handbrake ? DRIVE.handbrakeGrip : DRIVE.driftGrip) - 1) * Math.min(1, drift * 2.5)
  // Assist: past ~60 degrees of slide the tires bite back, so overcooked drifts straighten out instead of spinning.
  if (beta > DRIVE.recoverAngle) gripMul *= 1 + DRIVE.recoverGain * (beta - DRIVE.recoverAngle)
  if (flat > 0) gripMul *= DRIVE.flatGrip
  if (absVf < 1.5) gripMul *= 2
  if (slip > 0) gripMul = DRIVE.oilGrip
  const lat0 = vl
  vl *= Math.exp(-spec.grip * gripMul * dt)
  // Some of the scrubbed sideways speed carries into forward speed, so a held slide keeps its pace.
  if (drift > 0 && input.throttle > 0 && vf > 0) vf += Math.abs(lat0 - vl) * DRIVE.driftMomentum * drift
  vf += a * dt
  if (b.stun > 0) vf *= Math.exp(-2 * dt)
  if (input.brake > 0.5 && input.throttle === 0 && Math.abs(vf) < 2.5) {
    vf = 0
    vl = 0
  }
  if (Math.abs(vf) < 0.05 && Math.abs(vl) < 0.05 && input.throttle === 0) {
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

/** Pushes a circle out of axis-aligned boxes and bounces it off. Returns the impact speed (0 if no contact). */
export function collideBoxes(b: Body, radius: number, boxes: Box[]): number {
  let impact = 0
  for (const box of boxes) {
    if (b.x < box.x0 - radius || b.x > box.x1 + radius || b.z < box.z0 - radius || b.z > box.z1 + radius) continue
    const cx = Math.min(box.x1, Math.max(box.x0, b.x))
    const cz = Math.min(box.z1, Math.max(box.z0, b.z))
    const dx = b.x - cx
    const dz = b.z - cz
    const d2 = dx * dx + dz * dz
    if (d2 >= radius * radius) continue
    let nx: number
    let nz: number
    let d: number
    if (d2 > 1e-8) {
      d = Math.sqrt(d2)
      nx = dx / d
      nz = dz / d
    } else {
      const pl = b.x - box.x0
      const pr = box.x1 - b.x
      const pt = b.z - box.z0
      const pb = box.z1 - b.z
      const m = Math.min(pl, pr, pt, pb)
      nx = m === pl ? -1 : m === pr ? 1 : 0
      nz = nx !== 0 ? 0 : m === pt ? -1 : 1
      d = -m
    }
    const push = radius - d
    b.x += nx * (push + 0.01)
    b.z += nz * (push + 0.01)
    const vn = b.vx * nx + b.vz * nz
    if (vn < 0) {
      impact = Math.max(impact, -vn)
      // Bounce the normal part back at 30%; glancing scrapes keep most of their speed, head-on hits lose more.
      const tx = b.vx - vn * nx
      const tz = b.vz - vn * nz
      const keep = Math.max(0.55, 1 - 0.018 * -vn)
      b.vx = tx * keep - 0.3 * vn * nx
      b.vz = tz * keep - 0.3 * vn * nz
      b.yaw *= 0.5
    }
  }
  return impact
}

/**
 * stepBody plus collideBoxes, split into substeps so a fast car never moves more than ~60% of its radius per substep
 * and cannot tunnel through thin boxes (roadblocks, parked cars). Returns the largest impact speed.
 */
export function stepAndCollide(b: Body, input: Input, spec: Vehicle, dt: number, radius: number, boxes: Box[]): number {
  const reach = (speedOf(b) + spec.accel * dt) * dt
  const n = Math.max(1, Math.min(8, Math.ceil(reach / (radius * 0.6))))
  let impact = 0
  for (let i = 0; i < n; i++) {
    stepBody(b, input, spec, dt / n)
    impact = Math.max(impact, collideBoxes(b, radius, boxes))
  }
  return impact
}
