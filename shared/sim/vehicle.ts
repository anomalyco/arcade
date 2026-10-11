import type { Vehicle } from "../config"
import type { Box } from "./city"

export type Input = {
  throttle: number
  brake: number
  steer: number
  handbrake: boolean
  boost: boolean
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
}

export function newBody(x: number, z: number, h: number): Body {
  return { x, z, h, vx: 0, vz: 0, yaw: 0, boostFuel: 1, hp: 1, stun: 0 }
}

export function forward(h: number): [number, number] {
  return [Math.sin(h), Math.cos(h)]
}

export function speedOf(b: Body) {
  return Math.hypot(b.vx, b.vz)
}

/** Integrates one car. Heading changes first, then the world velocity is re-split into forward and sideways parts. */
export function stepBody(b: Body, input: Input, spec: Vehicle, dt: number) {
  if (b.stun > 0) {
    b.stun = Math.max(0, b.stun - dt)
    input = { throttle: 0, brake: 0.6, steer: 0, handbrake: false, boost: false }
  }
  const boosting = input.boost && b.boostFuel > 0 && b.stun <= 0
  if (boosting) b.boostFuel = Math.max(0, b.boostFuel - dt / 4)
  else b.boostFuel = Math.min(1, b.boostFuel + dt / 14)

  let [fx, fz] = forward(b.h)
  let vf = b.vx * fx + b.vz * fz
  const absVf = Math.abs(vf)
  const dir = vf >= -0.5 ? 1 : -1
  const speedFactor = Math.min(1, absVf / 9) * (1 - 0.3 * Math.min(1, absVf / spec.maxSpeed))
  const drift = input.handbrake && absVf > 6
  const targetYaw = input.steer * spec.turn * speedFactor * dir * (drift ? 1.25 : 1)
  const rate = input.steer === 0 ? 5 : drift ? 6 : 9
  b.yaw += (targetYaw - b.yaw) * Math.min(1, dt * rate)
  b.h += b.yaw * dt
  ;[fx, fz] = forward(b.h)
  const rx = fz
  const rz = -fx
  vf = b.vx * fx + b.vz * fz
  let vl = b.vx * rx + b.vz * rz

  const vmax = spec.maxSpeed * (boosting ? 1.3 : 1)
  let a = 0
  if (input.throttle > 0) {
    const room = Math.max(0, 1 - vf / vmax)
    a += spec.accel * input.throttle * (boosting ? 1.6 : 1) * room * (vf < 0 ? 1.4 : 1)
  }
  if (input.throttle < 0) {
    if (vf > 0.5) a -= spec.brake * -input.throttle
    else a += spec.accel * 0.6 * input.throttle * Math.max(0, 1 + vf / 12)
  }
  if (input.brake > 0 && vf > 0.5) a -= spec.brake * input.brake
  a -= 0.12 * vf + 0.003 * vf * Math.abs(vf)
  if (drift) a -= 0.5 * Math.abs(vl)

  const grip = spec.grip * (input.handbrake ? 0.28 : 1) * (absVf < 1.5 ? 2 : 1)
  vl *= Math.exp(-grip * dt)
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

/** Pushes a circle out of axis-aligned boxes. Returns the impact speed (0 if no contact). */
export function collideBoxes(b: Body, radius: number, boxes: Box[]): number {
  let impact = 0
  for (const box of boxes) {
    const cx = Math.min(box.x1, Math.max(box.x0, b.x))
    const cz = Math.min(box.z1, Math.max(box.z0, b.z))
    let dx = b.x - cx
    let dz = b.z - cz
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
      d = 0
    }
    const push = radius - d
    b.x += nx * (push + 0.01)
    b.z += nz * (push + 0.01)
    const vn = b.vx * nx + b.vz * nz
    if (vn < 0) {
      impact = Math.max(impact, -vn)
      b.vx -= (1.3 * vn) * nx
      b.vz -= (1.3 * vn) * nz
      b.vx *= 0.82
      b.vz *= 0.82
    }
  }
  return impact
}
