// The F/A-18E: an arcade flight model in the Battlefield spirit. Pure and DOM-free, fixed timestep (PLANE.tick); the
// caller accumulates frame time. Deterministic for the same inputs.
//
// World frame: x east, y up, z south (as shared/ship.ts). Body frame (art/hornet.glb): +Z nose, +Y up, +X the pilot's
// LEFT, a right-handed frame, so the model maps to the world by a proper rotation and is never mirrored. The state's
// position is the jet's centre, PLANE.centre metres above the model origin (the lowest belly point).
//
// Model: speed is a scalar along the velocity direction. Thrust ∝ throttle² against v² drag, so the steady level speed is
// topSpeed · throttle; with no key held the throttle springs to `cruise`, which settles on the optimal turn speed (the
// "blue zone"). Gravity acts along the flight path (dives gain, climbs lose). The velocity direction chases the nose at a
// rate that falls to nothing below the stall, where gravity sags the flight path and the nose weathervanes down onto it.
// Stick commands are angular rates (pitch, roll, yaw) scaled by an authority curve that peaks at the optimal speed.
// Pulling bleeds speed. A small bank turn, a small auto-level, a soft ceiling and a world edge (stay out too long and the
// jet is lost) finish it off.

import { DECK_X0, DECK_X1, DECK_Y, ISLAND, STERN_Z, BOW_Z } from "./carrier-spec"
import { type Archipelago, terrainHeight } from "./islands"
import { type Sea, seaHeight } from "./sea"

export const KNOT = 0.514444
const DEG = Math.PI / 180

/** Every tunable in one place. SI units unless noted. */
export const PLANE = {
  /** Fixed simulation step (s), the same as the ship's. */
  tick: 1 / 60,
  /** Height of the jet's centre (its rotation point) above the model origin, the lowest belly point. */
  centre: 1.6,

  // Speed band (m/s).
  /** Below this the wings stop flying: the flight path sags, the nose drops and the controls go mushy. */
  stallSpeed: 55,
  /** Peak turn rate ("blue zone"). The cruise throttle settles here in level flight. */
  optimalSpeed: 140,
  /** Level speed at full military throttle (≈ 1.3 × optimal). */
  topSpeed: 182,
  /** Level speed with the afterburner lit. */
  boostSpeed: 235,
  /** Half-widths of the turn authority bell below and above the optimal speed, and its floor. */
  bandLow: 55,
  bandHigh: 75,
  authFloor: 0.18,

  // Engine.
  /** Acceleration from full military thrust (m/s²); drag is sized so thrust = drag at topSpeed. */
  thrust: 16,
  /** Throttle with no key held: topSpeed · cruise = optimalSpeed. */
  cruise: 140 / 182,
  /** Throttle slew (fraction per second) toward full (W), idle (S) or cruise (released). */
  throttleRate: 0.7,
  /** Airbrake: extra drag (multiples of the clean drag) at full deployment, and its deploy/retract rate (1/s). */
  airbrake: 2.2,
  brakeRate: 3,
  /** Gravity's share along the flight path (1 = physical). */
  gravity: 1,
  /** Speed lost to pulling (m/s² at the full pitch rate, scaled by speed / optimal). */
  turnBleed: 7,
  /** Speed lost to rudder (m/s² at the full yaw rate). */
  yawBleed: 3,

  // Afterburner ("boost").
  /** Full charge lasts this long (s), recharges at `boostRegen` per second after `boostDelay` s, and re-lights only
   *  above `boostRelight` once emptied. */
  boostTime: 5,
  boostRegen: 0.14,
  boostDelay: 1,
  boostRelight: 0.2,

  // Rates at full authority (rad/s) and how quickly the jet reaches them (s).
  pitchRate: 0.95,
  /** Pushing (nose down) is weaker than pulling. */
  pushShare: 0.7,
  rollRate: 3.4,
  yawRate: 0.6,
  pitchLag: 0.12,
  rollLag: 0.08,
  yawLag: 0.2,
  /** Roll keeps this much authority at any speed. */
  rollFloor: 0.45,
  /** How fast the flight path follows the nose at flying speed (1/s): sets the angle of attack in a pull. */
  align: 6,
  /** Nose drop toward the flight path in a full stall (rad/s). */
  stallDrop: 1.1,
  /** Heading change from bank alone (rad/s at 90° bank, at flying speed). */
  bankTurn: 0.22,
  /** Wings-level tendency with the roll stick centred (1/s, only within ±autoLevelMax of level). */
  autoLevel: 0.35,
  autoLevelMax: 50 * DEG,

  // Takeoff hand-over: the controls blend in from an autopilot that holds a climb, wings level.
  blendTime: 0.5,
  climbHold: 8 * DEG,

  // World.
  /** Thrust fades out over `ceilingBand` metres above `ceiling`. */
  ceiling: 3000,
  ceilingBand: 1200,
  /** Beyond this radius from the origin a countdown runs; at `edgeTime` seconds outside the jet is lost. */
  edge: 9000,
  edgeTime: 10,
} as const

/** One aircraft's flight tuning: PLANE's fields (shared/vehicles.ts has one per type; PLANE is the Hornet's). */
export type PlaneTuning = { readonly [K in keyof typeof PLANE]: number }

/** Throttle intent: 1 = W (more), -1 = S (less and airbrake), 0 = released (spring to cruise). */
export type PlaneControls = {
  /** Stick, -1..1: nose up +, roll right +, nose right +. */
  pitch: number
  roll: number
  yaw: number
  throttle: -1 | 0 | 1
  boost: boolean
}

/** Why a jet was lost: into the sea, an island or a carrier, beyond the edge, or shot down (shared/combat.ts). */
export type CrashKind = "" | "sea" | "land" | "ship" | "lost" | "shot"

export type Plane = {
  /** Sea time of this state (s). */
  t: number
  x: number
  y: number
  z: number
  /** Orientation, body → world (unit quaternion). */
  qx: number
  qy: number
  qz: number
  qw: number
  vx: number
  vy: number
  vz: number
  /** Body rates (rad/s): pitch nose up +, roll right +, yaw nose right +. */
  p: number
  r: number
  w: number
  /** Engine throttle 0..1 (lags the intent). */
  throttle: number
  /** Airbrake deployment 0..1. */
  brake: number
  /** Afterburner charge 0..1, 1 while lit, seconds since it was last lit. */
  boost: number
  boosting: number
  boostIdle: number
  /** Player authority 0..1 (0 right after the catapult, then blends in). */
  blend: number
  /** Stall amount 0..1 (0 = flying), for the HUD and the camera. */
  stall: number
  /** Load factor (g) of the current pull, for vapour and the HUD. */
  g: number
  /** Seconds spent beyond PLANE.edge. */
  outside: number
  crashed: CrashKind
}

export function makePlane(t = 0): Plane {
  return { t, x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, vx: 0, vy: 0, vz: 0, p: 0, r: 0, w: 0, throttle: 0, brake: 0, boost: 1, boosting: 0, boostIdle: 10, blend: 1, stall: 0, g: 1, outside: 0, crashed: "" }
}

export const copyPlane = (from: Plane, to: Plane): Plane => Object.assign(to, from)

// ---- quaternions --------------------------------------------------------------------------------------------------------

export type Quat = [x: number, y: number, z: number, w: number]
export type Vec3 = [number, number, number]

export function quatAxis(ax: number, ay: number, az: number, angle: number, out: Quat = [0, 0, 0, 1]): Quat {
  const s = Math.sin(angle / 2)
  out[0] = ax * s
  out[1] = ay * s
  out[2] = az * s
  out[3] = Math.cos(angle / 2)
  return out
}

/** a ⊗ b (apply b, then a). */
export function quatMul(a: Quat, b: Quat, out: Quat = [0, 0, 0, 1]): Quat {
  const [ax, ay, az, aw] = a
  const [bx, by, bz, bw] = b
  out[0] = aw * bx + ax * bw + ay * bz - az * by
  out[1] = aw * by - ax * bz + ay * bw + az * bx
  out[2] = aw * bz + ax * by - ay * bx + az * bw
  out[3] = aw * bw - ax * bx - ay * by - az * bz
  return out
}

/** Rotates (x, y, z) by q into out. */
export function quatRotate(qx: number, qy: number, qz: number, qw: number, x: number, y: number, z: number, out: Vec3): Vec3 {
  // t = 2 q.xyz × v; v' = v + w t + q.xyz × t
  const tx = 2 * (qy * z - qz * y)
  const ty = 2 * (qz * x - qx * z)
  const tz = 2 * (qx * y - qy * x)
  out[0] = x + qw * tx + (qy * tz - qz * ty)
  out[1] = y + qw * ty + (qz * tx - qx * tz)
  out[2] = z + qw * tz + (qx * ty - qy * tx)
  return out
}

export function quatSlerp(a: Quat, b: Quat, k: number, out: Quat): Quat {
  let [bx, by, bz, bw] = b
  let d = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw
  if (d < 0) {
    d = -d
    bx = -bx
    by = -by
    bz = -bz
    bw = -bw
  }
  let ka = 1 - k
  let kb = k
  if (d < 0.9995) {
    const th = Math.acos(d)
    const s = Math.sin(th)
    ka = Math.sin((1 - k) * th) / s
    kb = Math.sin(k * th) / s
  }
  out[0] = a[0] * ka + bx * kb
  out[1] = a[1] * ka + by * kb
  out[2] = a[2] * ka + bz * kb
  out[3] = a[3] * ka + bw * kb
  const l = Math.hypot(out[0], out[1], out[2], out[3])
  out[0] /= l
  out[1] /= l
  out[2] /= l
  out[3] /= l
  return out
}

export const planeQuat = (s: Plane, out: Quat = [0, 0, 0, 1]): Quat => {
  out[0] = s.qx
  out[1] = s.qy
  out[2] = s.qz
  out[3] = s.qw
  return out
}

export const setPlaneQuat = (s: Plane, q: Quat): void => {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1
  s.qx = q[0] / l
  s.qy = q[1] / l
  s.qz = q[2] / l
  s.qw = q[3] / l
}

/** A body-frame vector in the world. */
export const bodyToWorld = (s: Plane, x: number, y: number, z: number, out: Vec3 = [0, 0, 0]): Vec3 => quatRotate(s.qx, s.qy, s.qz, s.qw, x, y, z, out)

export const planeSpeed = (s: Plane): number => Math.hypot(s.vx, s.vy, s.vz)

/** Compass heading of the nose (0 north, π/2 east), its pitch above the horizon, and bank (right wing down +). */
export function planeAttitude(s: Plane, out = { heading: 0, pitch: 0, bank: 0 }): { heading: number; pitch: number; bank: number } {
  const f = bodyToWorld(s, 0, 0, 1, v0)
  const l = bodyToWorld(s, 1, 0, 0, v1)
  const u = bodyToWorld(s, 0, 1, 0, v2)
  out.heading = Math.atan2(f[0], -f[2])
  out.pitch = Math.asin(clamp(f[1], -1, 1))
  out.bank = Math.atan2(l[1], u[1])
  return out
}

// ---- ship frames --------------------------------------------------------------------------------------------------------

/** The parts of a carrier's state that place its model (shared/ship.ts `Ship` has them all). */
export type ShipPoseLike = { x: number; z: number; heave: number; heading: number; pitch: number; roll: number }

/** Ship-local (carrier-spec: +Z bow, +Y up) → world rotation, matching ShipPass: Ry(π − heading) · Rx(−pitch) · Rz(roll). */
export function shipQuat(s: ShipPoseLike, out: Quat = [0, 0, 0, 1]): Quat {
  const a = quatAxis(0, 1, 0, Math.PI - s.heading, qa)
  const b = quatAxis(1, 0, 0, -s.pitch, qb)
  const c = quatAxis(0, 0, 1, s.roll, qc)
  return quatMul(quatMul(a, b, qd), c, out)
}

/** Ship-local point → world. */
export function shipToWorld(s: ShipPoseLike, x: number, y: number, z: number, out: Vec3 = [0, 0, 0]): Vec3 {
  const q = shipQuat(s, qe)
  quatRotate(q[0], q[1], q[2], q[3], x, y, z, out)
  out[0] += s.x
  out[1] += s.heave
  out[2] += s.z
  return out
}

/** World point → ship-local. */
export function worldToShip(s: ShipPoseLike, x: number, y: number, z: number, out: Vec3 = [0, 0, 0]): Vec3 {
  const q = shipQuat(s, qe)
  return quatRotate(-q[0], -q[1], -q[2], q[3], x - s.x, y - s.heave, z - s.z, out)
}

// ---- step ---------------------------------------------------------------------------------------------------------------

export type PlaneWorld = {
  sea: Sea | null
  arch: Archipelago | null
  /** Carriers to crash into (hull up to the flight deck, and the island). */
  ships?: readonly ShipPoseLike[]
}

/** Collision probes (body frame, relative to the centre): nose, tail, wingtips, belly, fin tips. */
export const PROBES: readonly Vec3[] = [
  [0, -0.3, 9.1],
  [0, 0.2, -8.6],
  [6.9, -0.4, -2.6],
  [-6.9, -0.4, -2.6],
  [0, -1.6, 0],
  [1.9, 3, -6.6],
  [-1.9, 3, -6.6],
]

const MAX_PEAK = 620

/** Turn authority 0..1 at speed s: a bell peaking at the optimal speed, never below the floor. */
export function authority(s: number, P: PlaneTuning = PLANE): number {
  const d = s - P.optimalSpeed
  const w = d < 0 ? P.bandLow : P.bandHigh
  return P.authFloor + (1 - P.authFloor) * Math.exp(-(d * d) / (w * w))
}

/** How much the wings fly at speed s: 0 well below the stall, 1 at and above it. */
export function liftAt(s: number, P: PlaneTuning = PLANE): number {
  const k = clamp((s - 0.6 * P.stallSpeed) / (0.4 * P.stallSpeed), 0, 1)
  return k * k * (3 - 2 * k)
}

/**
 * Advances the jet by one fixed step (use PLANE.tick) with tuning `P` (the aircraft's, shared/vehicles.ts; the Hornet's
 * by default) and collision `probes`. A crashed jet only advances its clock.
 */
export function planeStep(s: Plane, c: PlaneControls, dt: number, world: PlaneWorld, P: PlaneTuning = PLANE, probes: readonly Vec3[] = PROBES): void {
  s.t += dt
  if (s.crashed) return
  const DRAG = P.thrust / (P.topSpeed * P.topSpeed)
  const BOOST_THRUST = DRAG * P.boostSpeed * P.boostSpeed

  // Engine: throttle springs toward cruise when released, airbrake on S.
  const want = c.throttle > 0 ? 1 : c.throttle < 0 ? 0 : P.cruise
  s.throttle = toward(s.throttle, want, P.throttleRate * dt)
  s.brake = toward(s.brake, c.throttle < 0 ? 1 : 0, P.brakeRate * dt)
  const lit = c.boost && s.boost > 0 && (s.boosting > 0 || s.boost >= P.boostRelight)
  s.boosting = lit ? 1 : 0
  if (lit) {
    s.boost = Math.max(0, s.boost - dt / P.boostTime)
    s.boostIdle = 0
  } else {
    s.boostIdle += dt
    if (s.boostIdle > P.boostDelay) s.boost = Math.min(1, s.boost + P.boostRegen * dt)
  }

  let speed = Math.hypot(s.vx, s.vy, s.vz)
  const fwd = bodyToWorld(s, 0, 0, 1, v0)
  let dx = fwd[0]
  let dy = fwd[1]
  let dz = fwd[2]
  if (speed > 0.5) {
    dx = s.vx / speed
    dy = s.vy / speed
    dz = s.vz / speed
  }
  const lift = liftAt(speed, P)
  s.stall = 1 - lift
  const auth = authority(speed, P) * (0.35 + 0.65 * lift)

  // Controls: blend in from the takeoff autopilot (hold a climb, wings level).
  const att = planeAttitude(s, attScratch)
  let pc = clamp(c.pitch, -1, 1)
  let rc = clamp(c.roll, -1, 1)
  let yc = clamp(c.yaw, -1, 1)
  if (s.blend < 1) {
    const path = Math.asin(clamp(dy, -1, 1))
    const k = s.blend * s.blend * (3 - 2 * s.blend)
    pc = pc * k + clamp((P.climbHold - path) * 3, -1, 1) * (1 - k)
    rc = rc * k + clamp(-att.bank * 2, -1, 1) * (1 - k)
    yc *= k
    s.blend = Math.min(1, s.blend + dt / P.blendTime)
  }

  // Body rates chase the commanded rates.
  const pTarget = pc * P.pitchRate * auth * (pc < 0 ? P.pushShare : 1)
  let rTarget = rc * P.rollRate * (P.rollFloor + (1 - P.rollFloor) * auth)
  if (Math.abs(rc) < 0.05 && Math.abs(att.bank) < P.autoLevelMax) rTarget -= att.bank * P.autoLevel
  const yTarget = yc * P.yawRate * (0.4 + 0.6 * auth)
  s.p += (pTarget - s.p) * ease(dt, P.pitchLag)
  s.r += (rTarget - s.r) * ease(dt, P.rollLag)
  s.w += (yTarget - s.w) * ease(dt, P.yawLag)

  // Integrate the body rates: pitch up is about body −X, roll right about +Z, yaw right about −Y.
  const q = planeQuat(s, qa)
  const wx = -s.p
  const wy = -s.w
  const wz = s.r
  const wl = Math.hypot(wx, wy, wz)
  if (wl > 1e-9) quatMul(q, quatAxis(wx / wl, wy / wl, wz / wl, wl * dt, qb), q)
  // Bank turns the heading a little even without a pull (world yaw; right bank turns right).
  const bankTurn = Math.sin(att.bank) * Math.cos(att.pitch) * P.bankTurn * lift
  if (bankTurn) quatMul(quatAxis(0, 1, 0, -bankTurn * dt, qb), q, q)
  // Gravity bends the path (and so the nose) down wherever the wings' lift isn't pointing up: nothing wings-level,
  // g/v in a knife edge, more inverted. Keeps hard banked turns level instead of spiralling up.
  {
    const f = quatRotate(q[0], q[1], q[2], q[3], 0, 0, 1, v1)
    const up = quatRotate(q[0], q[1], q[2], q[3], 0, 1, 0, v2)[1]
    const h = Math.hypot(f[0], f[2])
    const fall = ((9.81 * h) / Math.max(speed, 30)) * Math.min(1.5, 1 - up) * lift
    if (h > 1e-3 && fall > 0) quatMul(quatAxis(f[2] / h, 0, -f[0] / h, fall * dt, qb), q, q)
  }
  // Stall: the nose weathervanes down onto the sagging flight path.
  if (s.stall > 0.01) {
    const f = quatRotate(q[0], q[1], q[2], q[3], 0, 0, 1, v1)
    let tx = dx
    let ty = dy - 0.6 * s.stall
    let tz = dz
    const tl = Math.hypot(tx, ty, tz)
    tx /= tl
    ty /= tl
    tz /= tl
    let ax = f[1] * tz - f[2] * ty
    let ay = f[2] * tx - f[0] * tz
    let az = f[0] * ty - f[1] * tx
    const sin = Math.hypot(ax, ay, az)
    if (sin > 1e-6) {
      const angle = Math.atan2(sin, f[0] * tx + f[1] * ty + f[2] * tz)
      ax /= sin
      ay /= sin
      az /= sin
      quatMul(quatAxis(ax, ay, az, Math.min(angle, P.stallDrop * s.stall * dt), qb), q, q)
    }
  }
  setPlaneQuat(s, q)

  // Speed along the path.
  const ceil = clamp(1 - (s.y - P.ceiling) / P.ceilingBand, 0, 1)
  const thrust = (lit ? BOOST_THRUST : P.thrust * s.throttle * s.throttle) * ceil
  const drag = DRAG * speed * speed * (1 + P.airbrake * s.brake)
  const bleed = P.turnBleed * (Math.abs(s.p) / P.pitchRate) * (speed / P.optimalSpeed) + P.yawBleed * (Math.abs(s.w) / P.yawRate)
  speed = Math.max(0, speed + (thrust - drag - bleed - 9.81 * P.gravity * dy) * dt)

  // The flight path follows the nose while the wings fly.
  const nf = bodyToWorld(s, 0, 0, 1, v1)
  const k = ease(dt, 1 / Math.max(1e-3, P.align * lift))
  dx += (nf[0] - dx) * k
  dy += (nf[1] - dy) * k
  dz += (nf[2] - dz) * k
  const dl = Math.hypot(dx, dy, dz) || 1
  dx /= dl
  dy /= dl
  dz /= dl
  s.vx = dx * speed
  s.vy = dy * speed
  s.vz = dz * speed
  // Gravity across the path where the wings don't hold it.
  if (s.stall > 0) {
    const g = 9.81 * s.stall * dt
    s.vx += g * dy * dx
    s.vy += g * (dy * dy - 1)
    s.vz += g * dy * dz
  }
  s.g = 1 + (speed * s.p) / 9.81

  s.x += s.vx * dt
  s.y += s.vy * dt
  s.z += s.vz * dt

  if (Math.hypot(s.x, s.z) > P.edge) {
    s.outside += dt
    if (s.outside >= P.edgeTime) s.crashed = "lost"
  } else s.outside = 0

  collide(s, world, probes)
}

/** First thing the jet's probes touch: "sea", "land", "ship", or "" when clear. Sets `crashed`. */
export function collide(s: Plane, world: PlaneWorld, probes: readonly Vec3[] = PROBES): CrashKind {
  const near = s.y < 40
  const land = world.arch && s.y < MAX_PEAK + 20
  const ships = world.ships
  if (!near && !land && !ships?.length) return ""
  for (const pr of probes) {
    const p = bodyToWorld(s, pr[0], pr[1], pr[2], v2)
    const x = s.x + p[0]
    const y = s.y + p[1]
    const z = s.z + p[2]
    if (near && world.sea && y < seaHeight(world.sea, x, z, s.t)) return (s.crashed = "sea")
    if (!world.sea && y < 0) return (s.crashed = "sea")
    if (land && y < terrainHeight(world.arch!, x, z)) return (s.crashed = "land")
    if (ships)
      for (const sh of ships) {
        if (Math.abs(x - sh.x) > 220 || Math.abs(z - sh.z) > 220 || y > sh.heave + ISLAND.y1 + 2) continue
        const l = worldToShip(sh, x, y, z, v1)
        const inHull = l[0] > DECK_X0 && l[0] < DECK_X1 && l[2] > STERN_Z && l[2] < BOW_Z && l[1] < DECK_Y && l[1] > -10
        const inIsland = l[0] > ISLAND.x0 && l[0] < ISLAND.x1 && l[2] > ISLAND.z0 && l[2] < ISLAND.z1 && l[1] < ISLAND.y1
        if (inHull || inIsland) return (s.crashed = "ship")
      }
  }
  return ""
}

/** Interpolates two jet states into out for drawing. */
export function lerpPlane(a: Plane, b: Plane, k: number, out: Plane): Plane {
  copyPlane(b, out)
  const m = (x: number, y: number) => x + (y - x) * k
  out.t = m(a.t, b.t)
  out.x = m(a.x, b.x)
  out.y = m(a.y, b.y)
  out.z = m(a.z, b.z)
  out.vx = m(a.vx, b.vx)
  out.vy = m(a.vy, b.vy)
  out.vz = m(a.vz, b.vz)
  out.throttle = m(a.throttle, b.throttle)
  out.p = m(a.p, b.p)
  const q = quatSlerp(planeQuat(a, qa), planeQuat(b, qb), k, qc)
  setPlaneQuat(out, q)
  return out
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
const toward = (v: number, target: number, step: number) => (v < target ? Math.min(target, v + step) : Math.max(target, v - step))
const ease = (dt: number, lag: number) => 1 - Math.exp(-dt / lag)

const v0: Vec3 = [0, 0, 0]
const v1: Vec3 = [0, 0, 0]
const v2: Vec3 = [0, 0, 0]
const qa: Quat = [0, 0, 0, 1]
const qb: Quat = [0, 0, 0, 1]
const qc: Quat = [0, 0, 0, 1]
const qd: Quat = [0, 0, 0, 1]
const qe: Quat = [0, 0, 0, 1]
const attScratch = { heading: 0, pitch: 0, bank: 0 }
