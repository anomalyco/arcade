/**
 * A small thrown object (a road flare, a can, a rock) that flies a ballistic arc, bounces and rolls on terrain, stops
 * against trunks, rocks and walls and comes to rest. Pure and deterministic: fixed 1/120 s substeps and only + − × ÷
 * and √, so a room and every client that step the same throw from the same start land it in the same spot to the bit
 * (given the same `ground`). The host owns the world through `ThrownEnv`.
 */

export type ThrownBody = {
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  /** Tumble angle (rad) about the horizontal axis across the throw: presentation reads it, physics doesn't. */
  spin: number
  spinRate: number
  /** Plan direction it was thrown in (unit): a stick comes to rest lying roughly along it. */
  ax: number
  az: number
  /** Seconds in contact and nearly still; past `restAfter` it is at rest. */
  still: number
  rest: boolean
  /** Ground contacts so far (a host plays a clatter on each new one). */
  bounces: number
  /** Leftover time below one substep, carried so any step size gives the same path. */
  carry: number
}

export type ThrownEnv = {
  /** Ground height (m) at a plan point. */
  ground(x: number, z: number): number
  /**
   * Writes vertical cylinders near (x, z) within `reach` as `[x, z, radius, top]` groups into `out` and returns how
   * many it wrote. `top` is the height it stands to (Infinity for a trunk); the body can land on a low top.
   */
  obstacles?(x: number, z: number, reach: number, out: number[]): number
}

export type ThrownParams = {
  /** Body radius (m): a fusee is 2.5 cm across. */
  radius: number
  gravity: number
  /** Share of the normal speed kept in a bounce off the ground, and off a trunk or rock. */
  restitution: number
  wallRestitution: number
  /** Share of the tangential speed kept at an impact. */
  friction: number
  /** Rolling and sliding deceleration in contact (m/s²): above about g × tan(slope) it stops on that slope. */
  rollDrag: number
  /** Linear air drag (1/s). */
  air: number
  /** Normal speed below which a contact doesn't bounce (m/s). */
  bounceMin: number
  /** Speed (m/s) and time (s) under which a body in contact comes to rest. */
  restSpeed: number
  restAfter: number
}

export const THROWN_DEFAULTS: Readonly<ThrownParams> = {
  radius: 0.0125,
  gravity: 9.81,
  restitution: 0.3,
  wallRestitution: 0.25,
  friction: 0.62,
  rollDrag: 3.2,
  air: 0.04,
  bounceMin: 0.7,
  restSpeed: 0.06,
  restAfter: 0.2,
}

export const THROWN_STEP = 1 / 120
/** At most this many substeps per call (2 s of catch-up at 120 Hz is too much: a hitch just slows it down). */
const MAX_SUBSTEPS = 48
const NORMAL_H = 0.2

/** A body leaving (x, y, z) at (vx, vy, vz). `seed` picks its tumble rate and direction. */
export function throwBody(x: number, y: number, z: number, vx: number, vy: number, vz: number, seed = 1): ThrownBody {
  const plan = Math.sqrt(vx * vx + vz * vz)
  const h = hashUnit(seed)
  return {
    x, y, z, vx, vy, vz,
    spin: 0,
    spinRate: (h < 0.5 ? -1 : 1) * (7 + 9 * hashUnit(seed + 17)),
    ax: plan > 1e-6 ? vx / plan : 1,
    az: plan > 1e-6 ? vz / plan : 0,
    still: 0,
    rest: false,
    bounces: 0,
    carry: 0,
  }
}

const scratch: number[] = []

/** Advances the body by `dt` in fixed substeps (leftover carried). A body at rest stays put. */
export function stepThrown(b: ThrownBody, dt: number, env: ThrownEnv, p: Readonly<ThrownParams> = THROWN_DEFAULTS): void {
  if (b.rest || !(dt > 0)) return
  let time = b.carry + dt
  let n = 0
  while (time >= THROWN_STEP && n < MAX_SUBSTEPS && !b.rest) {
    substep(b, env, p)
    time -= THROWN_STEP
    n++
  }
  b.carry = b.rest || n === MAX_SUBSTEPS ? 0 : time
}

function substep(b: ThrownBody, env: ThrownEnv, p: Readonly<ThrownParams>) {
  const h = THROWN_STEP
  const air = 1 - p.air * h
  b.vx *= air
  b.vz *= air
  b.vy = b.vy * air - p.gravity * h
  b.x += b.vx * h
  b.y += b.vy * h
  b.z += b.vz * h
  b.spin += b.spinRate * h

  // Trunks and rocks: push out sideways and reflect; a low top it is above becomes the floor.
  let floor = env.ground(b.x, b.z)
  let floorIsTop = false
  if (env.obstacles) {
    scratch.length = 0
    const count = env.obstacles(b.x, b.z, 1.5, scratch)
    for (let i = 0; i < count; i++) {
      const cx = scratch[i * 4]!, cz = scratch[i * 4 + 1]!, cr = scratch[i * 4 + 2]!, top = scratch[i * 4 + 3]!
      const dx = b.x - cx, dz = b.z - cz
      const min = cr + p.radius
      const d2 = dx * dx + dz * dz
      if (d2 >= min * min) continue
      if (b.y - p.radius >= top - 0.06) {
        if (top > floor) { floor = top; floorIsTop = true }
        continue
      }
      const d = Math.sqrt(d2)
      const nx = d > 1e-6 ? dx / d : 1, nz = d > 1e-6 ? dz / d : 0
      b.x = cx + nx * min
      b.z = cz + nz * min
      const vn = b.vx * nx + b.vz * nz
      if (vn < 0) {
        const tx = b.vx - vn * nx, tz = b.vz - vn * nz
        b.vx = tx * p.friction - vn * p.wallRestitution * nx
        b.vz = tz * p.friction - vn * p.wallRestitution * nz
        b.spinRate *= -0.7
      }
    }
  }

  const bottom = b.y - p.radius
  if (bottom > floor + 0.002) {
    b.still = 0
    return
  }
  // Contact: the terrain normal from central differences (a rock top is flat).
  let nx = 0, ny = 1, nz = 0
  if (!floorIsTop) {
    const gx = (env.ground(b.x - NORMAL_H, b.z) - env.ground(b.x + NORMAL_H, b.z)) / (2 * NORMAL_H)
    const gz = (env.ground(b.x, b.z - NORMAL_H) - env.ground(b.x, b.z + NORMAL_H)) / (2 * NORMAL_H)
    const len = Math.sqrt(gx * gx + 1 + gz * gz)
    nx = gx / len; ny = 1 / len; nz = gz / len
  }
  if (bottom < floor) b.y = floor + p.radius
  const vn = b.vx * nx + b.vy * ny + b.vz * nz
  let tx = b.vx - vn * nx, ty = b.vy - vn * ny, tz = b.vz - vn * nz
  let bn = 0
  if (vn < -p.bounceMin) {
    bn = -vn * p.restitution
    tx *= p.friction; ty *= p.friction; tz *= p.friction
    b.spinRate *= 0.55
    b.bounces++
  }
  // Rolling and sliding resistance: a constant deceleration along the ground.
  const ts = Math.sqrt(tx * tx + ty * ty + tz * tz)
  if (bn === 0 && ts > 0) {
    const k = Math.max(0, ts - p.rollDrag * THROWN_STEP) / ts
    tx *= k; ty *= k; tz *= k
    // Rolling about its long axis: the tumble slows to the roll.
    b.spinRate *= 0.9
  }
  b.vx = tx + bn * nx
  b.vy = ty + bn * ny
  b.vz = tz + bn * nz
  const speed2 = b.vx * b.vx + b.vy * b.vy + b.vz * b.vz
  if (speed2 < p.restSpeed * p.restSpeed) {
    b.still += THROWN_STEP
    if (b.still >= p.restAfter) {
      b.rest = true
      b.vx = b.vy = b.vz = 0
      b.spinRate = 0
    }
  } else b.still = 0
}

/** Integer hash to [0, 1) (no trig, so a server and every client agree). */
export function hashUnit(n: number): number {
  let h = Math.imul((n | 0) ^ 0x9e3779b9, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}
