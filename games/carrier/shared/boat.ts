// The Mk VII fast interceptor (art/boat.glb): a carrier-launched planing boat. Pure and DOM-free, fixed timestep
// (BOAT.tick), deterministic for the same inputs, so the room runs it like the carriers and the driver predicts it.
//
// Frames as shared/ship.ts: plan x east, z south; heading h is a compass bearing, the bow points along
// F = (sin h, −cos h), starboard along R = (cos h, sin h); boat-local points (f, s) are metres toward the bow and to
// starboard. Pitch > 0 is bow up, roll > 0 starboard down. The model (art/boat.glb) is +Z bow, +X port, origin on the
// waterline amidships, exactly the carrier's ship-local frame, so shared/plane.ts `shipToWorld`/`worldToShip` place it.
//
// Unlike a carrier, the boat is light: `heave` is the absolute height of its origin and gravity is real. Each buoyancy
// point pushes with the depth of an effective bottom below it (one g in total at rest), only while it is wet, so the
// hull rides the swell, pitches and heels on it, leaves the water off a crest at speed, falls at 1 g and slams back.
// Planing lifts the hull and trims the bow up; the hull heels into turns. Thrust and steering come from the waterjets
// and only work while the stern is wet. Islands ground it (impulses at contact probes, pushed downhill), carriers'
// waterline hulls bounce it off, and a soft current turns it back at the world edge.
//
// Also here: the launch and recovery crane (ship-local poses over the carrier's port side), the 25 mm turret (aim
// slew, arcs, heat) and its rounds (against jets, boats, carriers and the world), boat health and damage, and the wire
// tuple for the room.

import { BOW_Z, DECK_Y, STERN_Z } from "./carrier-spec"
import { type Ground, type GroundShip, groundHit, shipAt, sweep } from "./combat"
import { type Archipelago, islandFootprint, terrainHeight } from "./islands"
import { type ShipPoseLike, type Vec3, shipToWorld, worldToShip } from "./plane"
import { type Sea, seaHeight } from "./sea"
import { canHurt, hash01, type Target } from "./weapons"

export const KNOT = 0.514444
const G = 9.81

/** Every tunable in one place. SI units unless noted. */
export const BOAT = {
  /** Fixed simulation step (s). */
  tick: 1 / 60,
  /** Hull (art/boat-README.md): 18 m long, 5.52 m beam, 0.54 m draft. */
  length: 18,
  beam: 5.52,
  draft: 0.54,

  // Propulsion: the throttle order maps to a target speed; below it the jets push with thrust · (1 − fade · u/U),
  // easing off over the last `band` m/s; above it the hull coasts down on its drag.
  /** 45 kn at full power. */
  topSpeed: 45 * KNOT,
  /** Acceleration from rest (m/s²): ~4 s to 90% of top speed. */
  thrust: 7.6,
  thrustFade: 0.45,
  band: 1.6,
  /** Coasting deceleration at top speed (m/s²), its linear share, and a friction so it stops. */
  coastDrag: 2.4,
  linearShare: 0.3,
  friction: 0.18,
  /** A transom-first hull drags harder: drag multiplier going astern. */
  asternDrag: 2.5,
  /** Deepest astern order and astern thrust (share of thrust). */
  astern: 0.35,
  asternThrust: 0.75,
  /** Engine output follows the order (fraction of full power per second). */
  spoolUp: 2.4,
  spoolDown: 3.2,
  /** Speed lost in a hard turn: drag per unit yaw rate (1/rad). */
  turnDrag: 0.3,

  // Boost (Shift): a short burst of extra power that recharges.
  /** Top speed and thrust multipliers while boosting. */
  boostSpeed: 1.2,
  boostThrust: 1.7,
  /** Seconds of boost on a full charge, seconds to recharge from empty, charge needed to start one. */
  boostTime: 3,
  boostRecharge: 10,
  boostMin: 0.3,

  // Steering (twin vectoring waterjets).
  rudderRate: 4,
  rudderReturn: 5,
  /** Turning radius at full lock: turnRadius + turnRadiusPerSpeed · speed (~60 m circle at top speed). */
  turnRadius: 18,
  turnRadiusPerSpeed: 0.6,
  /** Jet wash over the nozzles at full power (share of top speed): a slow boat still pivots. */
  wash: 0.35,
  yawLag: 0.22,
  /** Sideslip in a turn (the stern slides out) and how fast it builds. */
  slip: 0.3,
  slipLag: 0.35,
  /** Heel INTO a turn (planing hull), rad per (m/s · rad/s), and its limit. */
  heel: 0.012,
  maxHeel: 0.28,

  // Planing: the bow climbs over the hump (~40% of top speed), then holds a lower trim on the plane, and the hull
  // rises (hydrodynamic lift, a share of g at full speed).
  trimHump: 0.1,
  trimPlane: 0.075,
  planeLift: 0.4,

  // Buoyancy.
  /** Depth of the effective bottom below each buoyancy point at rest (m): sets the heave period (~1.7 s). */
  floatDepth: 0.72,
  /** Deepest submersion that still pushes harder (m): the freeboard. */
  maxSubmerge: 2.4,
  heaveDamp: 0.35,
  pitchDamp: 0.4,
  rollDamp: 0.32,
  /** Radii of gyration (m) in pitch and roll. */
  gyrPitch: 4.4,
  gyrRoll: 1.9,
  /** Pitch and roll hard limits (rad), soft above `softLimit` of them. */
  maxPitch: 0.6,
  maxRoll: 0.75,
  softLimit: 0.7,
  /** A wave face pushes the hull down its slope (share of g · slope). */
  surf: 0.25,
  /** Water impact: the hull meeting the water faster than slamSpeed (m/s, relative) is a slam; slamFull is a full one.
   *  The water takes out `slamStop` of the downward speed at once. */
  slamSpeed: 2.2,
  slamFull: 9,
  slamStop: 0.5,
  /** Fastest climb (m/s) the hull keeps as it leaves the water, in a calm sea and a full storm (`boatStorm`), and the
   *  significant wave heights (m) between which the storm response blends in. */
  launch: [0.6, 3] as readonly [number, number],
  /** Gravity while airborne (g): a touch heavier than real, so jumps read snappy and land sooner. */
  airGravity: 1.4,
  stormHs: [9.5, 16] as readonly [number, number],
  /** Air drag while airborne (1/m) and a little nose-down moment in the air (rad/s²). */
  airDrag: 0.0015,
  airNose: 0.35,

  // Grounding.
  keel: 0.54,
  bounce: 0.3,
  groundFriction: 2.2,
  pushOut: 3,
  pushMax: 6,
  /** Yaw radius of gyration (m), for off-centre impacts. */
  gyration: 4.6,
  /** Restitution off a carrier's hull. */
  hullBounce: 0.35,

  /** World edge: beyond this radius a growing current pushes the boat back (as SHIP.edge). */
  edge: 8500,
  edgePush: 0.01,
} as const

/** 0 launching (on the crane), 1 driving, 2 recovering (crane), 3 sinking. */
export const BOAT_MODE = { launch: 0, drive: 1, recover: 2, sunk: 3 } as const
export type BoatMode = (typeof BOAT_MODE)[keyof typeof BOAT_MODE]

export type BoatControls = {
  /** Throttle order −BOAT.astern..1. */
  throttle: number
  /** Steering −1 (port) .. 1 (starboard). */
  steer: number
  boost: boolean
}

export type Boat = {
  t: number
  x: number
  z: number
  heading: number
  /** Forward and starboard speed (m/s) and yaw rate (rad/s, > 0 to starboard). */
  u: number
  v: number
  r: number
  /** Height of the origin (the rest waterline) and its vertical speed. */
  heave: number
  heaveVel: number
  pitch: number
  pitchVel: number
  roll: number
  rollVel: number
  /** Engine output (lags the order), nozzle angle −1..1, the latest orders. */
  power: number
  rudder: number
  order: number
  steer: number
  /** Boost charge 0..1 and whether a burst is on. */
  boost: number
  boosting: boolean
  /** Share of the buoyancy points in the water, and of the aft (waterjet) ones. */
  wet: number
  wetAft: number
  /** Seconds since the hull last touched the water (0 while wet) and the clearance of its lowest point (m). */
  air: number
  clear: number
  /** Mean water height under the hull at the last step (NaN before the first). */
  wy: number
  /** Water impact 0..1 (decays) and count; grounding/collision 0..1 (decays). */
  slam: number
  slams: number
  ground: number
}

/** Buoyancy points (f, s): five stations along the waterline, two across, narrowing to the bow. */
export const BOAT_POINTS: readonly (readonly [f: number, s: number])[] = [
  [6.6, -0.9],
  [6.6, 0.9],
  [3.4, -1.9],
  [3.4, 1.9],
  [0, -2.2],
  [0, 2.2],
  [-3.6, -2.2],
  [-3.6, 2.2],
  [-7.2, -2.0],
  [-7.2, 2.0],
]
/** The aft stations (waterjet intakes): thrust and steering need them wet. */
const AFT = [6, 7, 8, 9]

/** Grounding and hull-contact probes on the waterline outline (f, s). */
export const BOAT_CONTACTS: readonly (readonly [f: number, s: number])[] = [
  [8.8, 0],
  [5.5, -2.2],
  [5.5, 2.2],
  [1, -2.75],
  [1, 2.75],
  [-4, -2.7],
  [-4, 2.7],
  [-8.4, -2.1],
  [-8.4, 2.1],
]

const N = BOAT_POINTS.length
const MEAN_FF = BOAT_POINTS.reduce((a, p) => a + p[0] * p[0], 0) / N
const MEAN_SS = BOAT_POINTS.reduce((a, p) => a + p[1] * p[1], 0) / N
const K = G / BOAT.floatDepth
const W_H = Math.sqrt(K)
const KP = (K * MEAN_FF) / (BOAT.gyrPitch * BOAT.gyrPitch)
const KR = (K * MEAN_SS) / (BOAT.gyrRoll * BOAT.gyrRoll)
const W_P = Math.sqrt(KP)
const W_R = Math.sqrt(KR)
const DRAG_TOP = BOAT.coastDrag - BOAT.friction
const DRAG_L = (DRAG_TOP * BOAT.linearShare) / BOAT.topSpeed
const DRAG_Q = (DRAG_TOP * (1 - BOAT.linearShare)) / (BOAT.topSpeed * BOAT.topSpeed)

export function makeBoat(x: number, z: number, heading: number, t = 0): Boat {
  return { t, x, z, heading, u: 0, v: 0, r: 0, heave: 0, heaveVel: 0, pitch: 0, pitchVel: 0, roll: 0, rollVel: 0, power: 0, rudder: 0, order: 0, steer: 0, boost: 1, boosting: false, wet: 1, wetAft: 1, air: 0, clear: 0, wy: Number.NaN, slam: 0, slams: 0, ground: 0 }
}

export const copyBoat = (from: Boat, to: Boat): Boat => Object.assign(to, from)

const wrap = (a: number) => a - Math.PI * 2 * Math.floor((a + Math.PI) / (Math.PI * 2))
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
const toward = (v: number, target: number, step: number) => (v < target ? Math.min(target, v + step) : Math.max(target, v - step))
const smooth = (a: number, b: number, x: number) => {
  const u = clamp((x - a) / (b - a), 0, 1)
  return u * u * (3 - 2 * u)
}

/** Bow-up trim (rad) at forward speed u: the hump, then the planing attitude. */
export function planingTrim(u: number): number {
  const s = Math.max(0, u) / BOAT.topSpeed
  return BOAT.trimHump * Math.exp(-(((s - 0.38) / 0.2) ** 2)) + BOAT.trimPlane * smooth(0.3, 0.8, s)
}

/** Share of g the planing hull lifts at forward speed u. */
export const planingLift = (u: number): number => BOAT.planeLift * smooth(0.25, 0.9, Math.max(0, u) / BOAT.topSpeed)

function limit(angle: number, vel: number, max: number, dt: number): [number, number] {
  const soft = max * BOAT.softLimit
  const over = Math.abs(angle) - soft
  if (over > 0) {
    const k = over / (max - soft)
    vel -= Math.sign(angle) * 40 * k * k * dt
    if (Math.sign(vel) === Math.sign(angle)) vel *= Math.exp(-8 * k * dt)
  }
  if (Math.abs(angle) > max) {
    angle = clamp(angle, -max, max)
    if (Math.sign(vel) === Math.sign(angle)) vel *= 0.3
  }
  return [angle, vel]
}

const water = new Float64Array(N)

/** 0..1: how stormy a sea is for the boat, from its significant wave height. */
export function boatStorm(sea: Sea): number {
  let e = 0
  for (const w of sea.waves) e += w.amp * w.amp
  return smooth(BOAT.stormHs[0], BOAT.stormHs[1], 2 * Math.SQRT2 * Math.sqrt(e))
}

/**
 * Vertical dynamics: heave, pitch and roll from the buoyancy points on the sea at `b.t`, gravity, planing lift and
 * trim, heel into the turn, slams. Shared by the full step and by remote boats (whose plan pose comes from the
 * network). Returns the water's slope along the heading (for surfing).
 */
export function boatFloat(b: Boat, sea: Sea, dt: number): number {
  const sh = Math.sin(b.heading)
  const ch = Math.cos(b.heading)
  const sp = Math.sin(b.pitch)
  const sr = Math.sin(b.roll)
  let acc = 0
  let accF = 0
  let accS = 0
  let wet = 0
  let wetAft = 0
  let mean = 0
  let clear = Infinity
  let fwd = 0
  let aft = 0
  for (let i = 0; i < N; i++) {
    const [f, s] = BOAT_POINTS[i]!
    const wx = b.x + f * sh + s * ch
    const wz = b.z - f * ch + s * sh
    const h = (water[i] = seaHeight(sea, wx, wz, b.t))
    mean += h
    if (f > 0) fwd += h
    else if (f < 0) aft += h
    const y = b.heave + f * sp - s * sr
    // Submersion of the effective bottom below this point.
    const d = clamp(h - y + BOAT.floatDepth, 0, BOAT.maxSubmerge)
    clear = Math.min(clear, y - BOAT.draft - h)
    if (d > 0) {
      wet++
      if (AFT.includes(i)) wetAft++
    }
    const a = (K * d) / N
    acc += a
    accF += f * a
    accS += s * a
  }
  mean /= N
  const w = wet / N
  b.wet = w
  b.wetAft = wetAft / AFT.length
  b.clear = Math.max(0, clear)
  // The water's own rise and fall under the hull (it includes the boat running over the waves): damp against it.
  const waterVel = Number.isFinite(b.wy) ? (mean - b.wy) / dt : 0
  const rel = b.heaveVel - waterVel
  const wasAir = b.air > 0
  const u = b.u
  const heelTarget = clamp(BOAT.heel * u * b.r, -BOAT.maxHeel, BOAT.maxHeel)
  let ay = acc - G + planingLift(u) * G * w - 2 * BOAT.heaveDamp * W_H * rel * w
  let ap = accF / (BOAT.gyrPitch * BOAT.gyrPitch) + KP * planingTrim(u) * w - 2 * BOAT.pitchDamp * W_P * b.pitchVel * w
  let ar = -accS / (BOAT.gyrRoll * BOAT.gyrRoll) + KR * heelTarget * w - 2 * BOAT.rollDamp * W_R * b.rollVel * w
  if (w === 0) {
    // In the air: gravity, a little nose-down weathervaning, gentle rotational drag.
    ay -= G * (BOAT.airGravity - 1)
    ap -= BOAT.airNose * Math.cos(b.pitch)
    ap -= 0.3 * b.pitchVel
    ar -= 0.3 * b.rollVel
  }
  // Water impact: coming back into the water fast (after flying, or the bow after standing clear).
  if (w > 0 && wasAir && rel < -BOAT.slamSpeed) {
    const hit = Math.min(1, (-rel - BOAT.slamSpeed) / (BOAT.slamFull - BOAT.slamSpeed))
    b.slam = Math.max(b.slam, 0.3 + 0.7 * hit)
    b.slams++
    b.heaveVel -= rel * BOAT.slamStop * Math.min(1, 0.4 + hit)
    b.pitchVel *= 1 - 0.5 * hit
    b.rollVel *= 1 - 0.4 * hit
  }
  // Leaving the water: a calm sea's sharp swell crests only toss it a little; a storm's throw it high.
  if (w === 0 && !wasAir) {
    const st = boatStorm(sea)
    const up = BOAT.launch[0] + (BOAT.launch[1] - BOAT.launch[0]) * st
    if (b.heaveVel > up) b.heaveVel = up
    const spin = 0.25 + 0.5 * st
    b.pitchVel = clamp(b.pitchVel, -spin, spin)
  }
  b.air = w > 0 ? 0 : b.air + dt
  b.wy = mean
  b.slam *= Math.exp(-dt * 3)
  b.heaveVel += ay * dt
  b.pitchVel += ap * dt
  b.rollVel += ar * dt
  b.heave += b.heaveVel * dt
  b.pitch += b.pitchVel * dt
  b.roll += b.rollVel * dt
  ;[b.pitch, b.pitchVel] = limit(b.pitch, b.pitchVel, BOAT.maxPitch, dt)
  ;[b.roll, b.rollVel] = limit(b.roll, b.rollVel, BOAT.maxRoll, dt)
  // Fore-aft water slope along the heading (positive: the water climbs ahead).
  return (fwd / 3 - aft / 4) / 6.9
}

// ---- islands ------------------------------------------------------------------------------------------------------

type Near = { x: number; z: number; r: number }
const nearCache = new WeakMap<Archipelago, Near[]>()
function islandsOf(arch: Archipelago): Near[] {
  let n = nearCache.get(arch)
  if (!n) {
    n = arch.islands.map((i) => {
      const f = islandFootprint(i)
      return { x: i.x, z: i.z, r: Math.max(f.extent, f.reach, i.radius) + BOAT.length + 150 }
    })
    nearCache.set(arch, n)
  }
  return n
}

function nearIsland(arch: Archipelago, x: number, z: number): Near | null {
  let best: Near | null = null
  let bd = Infinity
  for (const n of islandsOf(arch)) {
    const d = Math.hypot(n.x - x, n.z - z)
    if (d < n.r && d < bd) {
      bd = d
      best = n
    }
  }
  return best
}

const GRAD = 4

/** Pushes the boat out of any island its probes have run onto (impulses at the probes, drag, a nudge downhill). */
function ground(b: Boat, arch: Archipelago, dt: number): void {
  const island = nearIsland(arch, b.x, b.z)
  if (!island) return
  const sh = Math.sin(b.heading)
  const ch = Math.cos(b.heading)
  const sp = Math.sin(b.pitch)
  const sr = Math.sin(b.roll)
  const inertia = BOAT.gyration * BOAT.gyration
  let worst = 0
  let impact = 0
  for (const [f, s] of BOAT_CONTACTS) {
    const ax = f * sh + s * ch
    const az = -f * ch + s * sh
    const px = b.x + ax
    const pz = b.z + az
    const bottom = b.heave + f * sp - s * sr - BOAT.keel
    const pen = terrainHeight(arch, px, pz) - bottom
    if (pen <= 0) continue
    let nx = terrainHeight(arch, px - GRAD, pz) - terrainHeight(arch, px + GRAD, pz)
    let nz = terrainHeight(arch, px, pz - GRAD) - terrainHeight(arch, px, pz + GRAD)
    let len = Math.hypot(nx, nz)
    if (len < 0.02) {
      nx = px - island.x
      nz = pz - island.z
      len = Math.hypot(nx, nz) || 1
    }
    nx /= len
    nz /= len
    const vx = b.u * sh + b.v * ch - b.r * az
    const vz = -b.u * ch + b.v * sh + b.r * ax
    const vn = vx * nx + vz * nz
    const c = -az * nx + ax * nz
    if (vn < 0) {
      const j = (-(1 + BOAT.bounce) * vn) / (1 + (c * c) / inertia)
      b.u += j * (nx * sh - nz * ch)
      b.v += j * (nx * ch + nz * sh)
      b.r += (j * c) / inertia
      impact = Math.max(impact, -vn)
    }
    const push = Math.min(BOAT.pushMax, pen * BOAT.pushOut) * dt
    b.x += nx * push
    b.z += nz * push
    worst = Math.max(worst, pen)
  }
  if (worst > 0) {
    // Resting on the bottom: the ground holds the hull up.
    const lift = Math.min(worst, 0.6)
    b.heave += lift * 0.5
    if (b.heaveVel < 0) b.heaveVel *= 0.3
    const k = Math.exp(-BOAT.groundFriction * Math.min(worst, 2) * dt)
    b.u *= k
    b.v *= k
    b.r *= k
    b.ground = Math.max(b.ground, Math.min(1, impact / 5 + worst * 0.2))
  }
}

// ---- carriers -----------------------------------------------------------------------------------------------------

/** A carrier's plan state for collisions: pose plus plan velocity (forward u, starboard v, yaw rate r). */
export type BoatObstacle = { x: number; z: number; heading: number; u: number; v: number; r: number }

/** A carrier's waterline half-breadth (m) at ship-local f (toward the bow), 0 outside the hull. */
export function carrierHalfBeam(f: number): number {
  if (f > BOW_Z || f < STERN_Z) return 0
  // From src/game/wake.ts BOW_LINE (carrier-mesh STATIONS at y = 0), a full 25.6 m amidships, 24 m at the transom.
  const L: readonly [number, number][] = [
    [165, 9],
    [160, 17.5],
    [153, 21.5],
    [143, 24],
    [128, 25],
    [104, 25.6],
    [-150, 25.6],
    [-165, 24],
  ]
  for (let i = 0; i + 1 < L.length; i++) {
    const [f0, w0] = L[i]!
    const [f1, w1] = L[i + 1]!
    if (f <= f0 && f >= f1) return w0 + ((w1 - w0) * (f0 - f)) / (f0 - f1)
  }
  return 0
}

/** Bounces the boat off carriers' waterline hulls (they are far heavier: only the boat moves). */
function hulls(b: Boat, ships: readonly BoatObstacle[]): void {
  const inertia = BOAT.gyration * BOAT.gyration
  for (const sh of ships) {
    if (Math.abs(sh.x - b.x) > 200 || Math.abs(sh.z - b.z) > 200) continue
    const hs = Math.sin(sh.heading)
    const hc = Math.cos(sh.heading)
    const bs = Math.sin(b.heading)
    const bc = Math.cos(b.heading)
    for (const [f, s] of BOAT_CONTACTS) {
      const ax = f * bs + s * bc
      const az = -f * bc + s * bs
      const dx = b.x + ax - sh.x
      const dz = b.z + az - sh.z
      // Ship plan frame: along its bow (lf) and to its starboard (ls).
      const lf = dx * hs - dz * hc
      const ls = dx * hc + dz * hs
      const hw = carrierHalfBeam(lf)
      if (hw <= 0 || Math.abs(ls) >= hw) continue
      const side = hw - Math.abs(ls)
      const bow = BOW_Z - lf
      const stern = lf - STERN_Z
      let nf = 0
      let ns = 0
      let pen = side
      if (bow < pen) {
        pen = bow
        nf = 1
      } else if (stern < pen) {
        pen = stern
        nf = -1
      } else ns = Math.sign(ls) || 1
      if (nf !== 0 && side < pen) {
        nf = 0
        ns = Math.sign(ls) || 1
        pen = side
      }
      const nx = nf * hs + ns * hc
      const nz = -nf * hc + ns * hs
      // Relative velocity at the contact: the boat's point minus the ship's.
      const vx = b.u * bs + b.v * bc - b.r * az
      const vz = -b.u * bc + b.v * bs + b.r * ax
      const sx = sh.u * hs + sh.v * hc - sh.r * dz
      const sz = -sh.u * hc + sh.v * hs + sh.r * dx
      const vn = (vx - sx) * nx + (vz - sz) * nz
      const c = -az * nx + ax * nz
      if (vn < 0) {
        const j = (-(1 + BOAT.hullBounce) * vn) / (1 + (c * c) / inertia)
        b.u += j * (nx * bs - nz * bc)
        b.v += j * (nx * bc + nz * bs)
        b.r += (j * c) / inertia
        b.ground = Math.max(b.ground, Math.min(1, -vn / 6))
      }
      b.x += nx * Math.min(pen, 2)
      b.z += nz * Math.min(pen, 2)
    }
  }
}

/**
 * Advances the boat by one fixed step `dt` (use BOAT.tick). Deterministic for the same inputs. `ships`: carriers it
 * can't pass through.
 */
export function boatStep(b: Boat, c: BoatControls, sea: Sea, arch: Archipelago | null, ships: readonly BoatObstacle[] = [], dt: number = BOAT.tick): void {
  const order = clamp(c.throttle, -BOAT.astern, 1)
  b.order = order
  b.steer = clamp(c.steer, -1, 1)
  b.power = toward(b.power, order, (Math.abs(order) > Math.abs(b.power) && order * b.power >= 0 ? BOAT.spoolUp : BOAT.spoolDown) * dt)
  const rate = b.steer === 0 || Math.sign(b.steer) !== Math.sign(b.rudder) ? BOAT.rudderReturn : BOAT.rudderRate
  b.rudder = toward(b.rudder, b.steer, rate * dt)
  // Boost: starts with enough charge and the throttle forward, burns while held.
  if (b.boosting) {
    b.boost = Math.max(0, b.boost - dt / BOAT.boostTime)
    if (!c.boost || b.boost <= 0 || order <= 0) b.boosting = false
  } else {
    if (c.boost && order > 0 && b.boost >= BOAT.boostMin) b.boosting = true
    else b.boost = Math.min(1, b.boost + dt / BOAT.boostRecharge)
  }

  const slope = boatFloat(b, sea, dt)
  const wet = b.wet
  const jets = b.wetAft

  // Surge.
  const u = b.u
  const top = BOAT.topSpeed * (b.boosting ? BOAT.boostSpeed : 1)
  const thrust = BOAT.thrust * (b.boosting ? BOAT.boostThrust : 1) * jets
  const want = b.power * top
  const drag = (DRAG_Q * u * u + DRAG_L * Math.abs(u) + BOAT.friction) * wet * (u < 0 ? BOAT.asternDrag : 1) + BOAT.airDrag * u * u * (1 - wet)
  let a: number
  if (want >= 0 && u >= 0) {
    if (u < want) a = thrust * Math.max(0, 1 - (BOAT.thrustFade * u) / top) * Math.min(1, (want - u) / BOAT.band) - (1 - wet) * BOAT.airDrag * u * u
    else a = -Math.min(drag, (u - want) / dt)
  } else {
    const d = -Math.sign(u) * drag
    if (u > want) a = -thrust * BOAT.asternThrust * Math.min(1, (u - want) / BOAT.band) + d
    else if (want > 0) a = thrust * Math.min(1, (want - u) / BOAT.band) + d
    else a = Math.min(d, (want - u) / dt)
  }
  a -= BOAT.turnDrag * Math.abs(b.r) * u * wet
  a -= G * BOAT.surf * slope * wet
  const dist = Math.hypot(b.x, b.z)
  let ex = 0
  let ez = 0
  if (dist > BOAT.edge) {
    const k = (dist - BOAT.edge) * BOAT.edgePush
    ex = (-b.x / dist) * k
    ez = (-b.z / dist) * k
  }
  const sh = Math.sin(b.heading)
  const ch = Math.cos(b.heading)
  a += ex * sh - ez * ch
  b.u += a * dt
  if (b.power === 0 && Math.abs(b.u) < 0.03 && wet > 0) b.u = 0

  // Yaw: the nozzles work on the flow past them plus their own wash; in the air the boat keeps its spin.
  const washV = BOAT.wash * BOAT.topSpeed * Math.abs(b.power)
  const flow = Math.sqrt(b.u * b.u + washV * washV) * (b.u < 0 ? -1 : 1)
  const rTarget = (b.rudder * flow) / (BOAT.turnRadius + BOAT.turnRadiusPerSpeed * Math.abs(b.u))
  if (jets > 0) b.r += (rTarget - b.r) * (1 - Math.exp((-dt * jets) / BOAT.yawLag))
  else b.r *= Math.exp(-dt * 0.3)
  const vTarget = -BOAT.slip * b.u * b.r
  b.v += (vTarget - b.v) * (1 - Math.exp((-dt * wet) / BOAT.slipLag)) + (ex * ch + ez * sh) * dt
  b.v *= Math.exp(-dt * 0.8 * wet)

  if (arch) ground(b, arch, dt)
  if (ships.length) hulls(b, ships)
  b.ground *= Math.exp(-dt * 2.5)

  b.heading = wrap(b.heading + b.r * dt)
  const sh2 = Math.sin(b.heading)
  const ch2 = Math.cos(b.heading)
  b.x += (b.u * sh2 + b.v * ch2) * dt
  b.z += (-b.u * ch2 + b.v * sh2) * dt
  b.t += dt
}

/** Interpolates two boat states into `out` for rendering (heading the short way round). */
export function lerpBoat(a: Boat, b: Boat, k: number, out: Boat): Boat {
  copyBoat(b, out)
  const m = (x: number, y: number) => x + (y - x) * k
  out.t = m(a.t, b.t)
  out.x = m(a.x, b.x)
  out.z = m(a.z, b.z)
  out.heading = wrap(a.heading + wrap(b.heading - a.heading) * k)
  out.u = m(a.u, b.u)
  out.heave = m(a.heave, b.heave)
  out.pitch = m(a.pitch, b.pitch)
  out.roll = m(a.roll, b.roll)
  out.rudder = m(a.rudder, b.rudder)
  out.power = m(a.power, b.power)
  return out
}

/** World plan velocity of the boat (m/s). */
export function boatVelocity(b: Pick<Boat, "heading" | "u" | "v">, out: [number, number] = [0, 0]): [number, number] {
  const s = Math.sin(b.heading)
  const c = Math.cos(b.heading)
  out[0] = b.u * s + b.v * c
  out[1] = -b.u * c + b.v * s
  return out
}

/** Dead-reckons a plan pose to sea time t along its arc (as shared/ship.ts extrapolatePose). */
export function extrapolateBoat(p: { t: number; x: number; z: number; heading: number; u: number; v: number; r: number }, t: number, out: { x: number; z: number; heading: number }): void {
  const dt = clamp(t - p.t, -1, 1.5)
  const n = Math.max(1, Math.ceil(Math.abs(dt) / 0.05))
  const h = dt / n
  let x = p.x
  let z = p.z
  let hd = p.heading
  for (let i = 0; i < n; i++) {
    const mid = hd + p.r * h * 0.5
    const s = Math.sin(mid)
    const c = Math.cos(mid)
    x += (p.u * s + p.v * c) * h
    z += (-p.u * c + p.v * s) * h
    hd += p.r * h
  }
  out.x = x
  out.z = z
  out.heading = wrap(hd)
}

// ---- launch and recovery ------------------------------------------------------------------------------------------

/**
 * The boat goes over the carrier's PORT side at the deck-edge elevator (concept/boat-README.md): it waits on the
 * elevator, an implied crane swings it out past the elevator's edge and lowers it 26 m to the water, then lets go
 * (a splash) and it inherits the carrier's motion. Recovery runs it backwards: the boat is drawn alongside under the
 * crane, hoisted, swung in onto the elevator and struck below (despawns). Ship-local metres (+X port, +Z bow).
 */
export const CRANE = {
  /** On the elevator (ship-local x, z) and swung out over the water. */
  deckX: 45.5,
  outX: 59,
  z: 18,
  /** Origin height resting on the elevator (the keel is 0.54 m under the origin). */
  deckY: DECK_Y + 0.6,
  /** Launch timeline (s): sits, swings out (lifting a little), lowers, touches the water, released. */
  sit: 0.35,
  swing: 1.0,
  lower: 2.6,
  release: 2.95,
  /** Recovery: glide alongside at up to `glideSpeed` m/s relative (≥ glideMin s), hoist, swing in, done. */
  glideSpeed: 12,
  glideMin: 1.2,
  glideMax: 4,
  hoist: 1.7,
  swingIn: 0.7,
  /** Recovery zones (plan, ship-local): within `reach` of the crane point, or `stern` m behind the stern within
   *  `sternWidth` of the centreline; slower than `speed` m/s relative to the carrier and in the water. */
  reach: 45,
  stern: 80,
  sternWidth: 45,
  speed: 6,
} as const

/** The world pose of a boat on the crane: where its model goes. */
export type CranePose = { x: number; y: number; z: number; heading: number; pitch: number; roll: number }

const cv: Vec3 = [0, 0, 0]
const ease = (u: number) => {
  const k = clamp(u, 0, 1)
  return k * k * (3 - 2 * k)
}



/** Duration of a recovery's glide from ship-local (fx, fz). */
export function glideTime(fx: number, fz: number): number {
  return clamp(Math.hypot(fx - CRANE.outX, fz - CRANE.z) / CRANE.glideSpeed, CRANE.glideMin, CRANE.glideMax)
}

/** Total length of a recovery from ship-local (fx, fz). */
export const recoverTime = (fx: number, fz: number): number => glideTime(fx, fz) + CRANE.hoist + CRANE.swingIn

/**
 * The boat on the crane, `t` seconds into a launch (`from` null) or a recovery (from its ship-local plan position and
 * yaw at capture), on carrier `ship` (its drawn pose). `water(x, z)`: the sea height there (where the hull rides
 * once it is down). The crane's swing adds a little sway. Into `out`.
 */
export function cranePose(t: number, ship: ShipPoseLike, water: (x: number, z: number) => number, from: { x: number; z: number; yaw: number } | null, out: CranePose): CranePose {
  const c = CRANE
  let lx: number
  let ly: number
  let lz = c.z
  let yaw = 0
  let sway = 0
  /** 0: held by the crane in the carrier's frame, 1: riding the sea. */
  let down: number
  if (!from) {
    const sw = ease((t - c.sit) / (c.swing - c.sit))
    down = ease((t - c.swing) / (c.lower - c.swing))
    lx = c.deckX + (c.outX - c.deckX) * sw
    ly = c.deckY + Math.sin(sw * Math.PI) * 1.2
    sway = Math.sin(t * 6.3) * Math.exp(-t * 0.6) * 0.035 * smooth(0.3, 1, t) * (1 - down)
  } else {
    const g = glideTime(from.x, from.z)
    if (t < g) {
      const k = ease(t / g)
      lx = from.x + (c.outX - from.x) * k
      lz = from.z + (c.z - from.z) * k
      ly = c.deckY + 1.2
      yaw = from.yaw * (1 - k)
      down = 1
    } else if (t < g + c.hoist) {
      lx = c.outX
      ly = c.deckY + 1.2
      down = 1 - ease((t - g) / c.hoist)
      sway = Math.sin((t - g) * 6.3) * 0.03 * Math.min(1, (t - g) * 2) * (1 - down)
    } else {
      const k = ease((t - g - c.hoist) / c.swingIn)
      lx = c.outX + (c.deckX - c.outX) * k
      ly = c.deckY + 1.2 * (1 - k)
      down = 0
    }
  }
  // Held: the point in the carrier's frame. Down: the same plan point on the sea, level.
  const p = shipToWorld(ship, lx, ly, lz, cv)
  out.x = p[0]
  out.z = p[2]
  out.y = p[1] + (water(p[0], p[2]) - p[1]) * down
  out.heading = wrap(ship.heading + yaw)
  out.pitch = ship.pitch * (1 - down)
  out.roll = ship.roll * (1 - down) + sway
  return out
}

/** Where the crane drops the boat: the ship-local plan point (for the sea height under it). */
export function cranePoint(ship: ShipPoseLike, out: Vec3 = [0, 0, 0]): Vec3 {
  return shipToWorld(ship, CRANE.outX, 0, CRANE.z, out)
}

/**
 * Releases a launched boat into the sim: at the crane point, on the carrier's heading, moving with the carrier there
 * (`ship` with its plan velocity), floating at sea height `wy`. Into `b` (keeps its boost charge).
 */
export function releaseBoat(b: Boat, ship: ShipPoseLike & BoatObstacle, wy: number, t: number): Boat {
  const p = cranePoint(ship, cv)
  const boost = b.boost
  Object.assign(b, makeBoat(p[0], p[2], ship.heading, t), { boost })
  b.heave = wy
  b.wy = Number.NaN
  // The carrier's velocity at that point, in the boat's (= the ship's) axes.
  const dx = p[0] - ship.x
  const dz = p[2] - ship.z
  const s = Math.sin(ship.heading)
  const c = Math.cos(ship.heading)
  const vx = ship.u * s + ship.v * c - ship.r * dz
  const vz = -ship.u * c + ship.v * s + ship.r * dx
  b.u = vx * s - vz * c
  b.v = vx * c + vz * s
  b.r = ship.r
  b.power = b.order = Math.max(0, Math.min(1, b.u / BOAT.topSpeed))
  return b
}

/** Whether the boat can be picked up by carrier `ship` now (in a recovery zone, slow relative to it, in the water).
 *  Returns its ship-local plan position and yaw for `cranePose`, or null. */
export function recoverable(b: Boat, ship: ShipPoseLike & BoatObstacle): { x: number; z: number; yaw: number } | null {
  if (b.wet <= 0) return null
  const l = worldToShip(ship, b.x, ship.heave, b.z, cv)
  const lx = l[0]
  const lz = l[2]
  const near = Math.hypot(lx - CRANE.outX, lz - CRANE.z) < CRANE.reach
  const stern = lz < STERN_Z + 10 && lz > STERN_Z - CRANE.stern && Math.abs(lx) < CRANE.sternWidth
  if (!near && !stern) return null
  const [bvx, bvz] = boatVelocity(b, rv)
  const s = Math.sin(ship.heading)
  const c = Math.cos(ship.heading)
  const dx = b.x - ship.x
  const dz = b.z - ship.z
  const vx = ship.u * s + ship.v * c - ship.r * dz
  const vz = -ship.u * c + ship.v * s + ship.r * dx
  if (Math.hypot(bvx - vx, bvz - vz) > CRANE.speed) return null
  return { x: lx, z: lz, yaw: wrap(b.heading - ship.heading) }
}
const rv: [number, number] = [0, 0]

// ---- the 25 mm turret -----------------------------------------------------------------------------------------------

const DEG = Math.PI / 180

/** The foredeck remote weapon station and its 25 mm autocannon. */
export const GUN = {
  /** Rounds per second (moderate: 420 rpm), muzzle speed (m/s, plus the boat's velocity), life (s): ~1.25 km. */
  rate: 7,
  muzzle: 1100,
  life: 1.15,
  gravity: 1,
  spread: 0.22 * DEG,
  /** Every Nth round is a tracer. */
  tracer: 2,
  /** Seconds of fire from cold to overheated, cooling (heat/s), delay before cooling, restart level. */
  heatTime: 6,
  cool: 0.32,
  coolDelay: 0.3,
  restart: 0.35,
  /** Turret slew (rad/s), arcs: yaw ±`arc` from the bow (the wheelhouse blocks the stern), elevation limits. */
  yawRate: 2.4,
  pitchRate: 1.6,
  arc: 145 * DEG,
  minElev: -10 * DEG,
  maxElev: 70 * DEG,
  /** Model-space pivots (art/boat-README.md): turret yaw base, gun trunnion (in the turret's frame), barrel length. */
  yawPivot: [0, 2.3, 4.97] as const,
  trunnion: [0, 0.18, 0.3] as const,
  barrel: 1.48,
  /** Hit sphere around a jet's centre (m), and the slack added to a boat's hull box (m). */
  jetRadius: 6,
  boatSlack: 0.6,
} as const

export type Turret = {
  /** Turret yaw (rad, + toward port, about model +Y) and gun elevation (rad, + up), and where they are slewing. */
  yaw: number
  pitch: number
  aimYaw: number
  aimPitch: number
  /** The barrel is on the aim (within ~2°) and the aim is inside the arcs. */
  onTarget: boolean
  heat: number
  overheated: boolean
  idle: number
  owed: number
  round: number
}

export const makeTurret = (): Turret => ({ yaw: 0, pitch: 0, aimYaw: 0, aimPitch: 0, onTarget: false, heat: 0, overheated: false, idle: 10, owed: 0.999, round: 0 })

/** The parts of a pose that place the boat's model (heave = origin height). */
export type BoatPoseLike = ShipPoseLike

const tl: Vec3 = [0, 0, 0]

/** Slews the turret toward world point (ax, ay, az) within its arcs and rates. */
export function turretStep(tr: Turret, pose: BoatPoseLike, ax: number, ay: number, az: number, dt: number): void {
  const l = worldToShip(pose, ax, ay, az, tl)
  const dx = l[0] - GUN.yawPivot[0]
  const dz = l[2] - GUN.yawPivot[2]
  const dy = l[1] - GUN.yawPivot[1] - GUN.trunnion[1]
  let yaw = Math.atan2(dx, dz)
  let pitch = Math.atan2(dy, Math.hypot(dx, dz))
  const inside = Math.abs(yaw) <= GUN.arc && pitch >= GUN.minElev && pitch <= GUN.maxElev
  yaw = clamp(yaw, -GUN.arc, GUN.arc)
  pitch = clamp(pitch, GUN.minElev, GUN.maxElev)
  tr.aimYaw = yaw
  tr.aimPitch = pitch
  tr.yaw = toward(tr.yaw, yaw, GUN.yawRate * dt)
  tr.pitch = toward(tr.pitch, pitch, GUN.pitchRate * dt)
  tr.onTarget = inside && Math.abs(tr.yaw - yaw) < 2 * DEG && Math.abs(tr.pitch - pitch) < 2 * DEG
}

/** Steps the gun's heat with the trigger held or not; returns the rounds that leave the muzzle this step. */
export function turretGun(tr: Turret, trigger: boolean, dt: number): number {
  if (tr.overheated && tr.heat <= GUN.restart) tr.overheated = false
  let n = 0
  if (trigger && !tr.overheated) {
    tr.owed += GUN.rate * dt
    n = Math.floor(tr.owed)
    tr.owed -= n
    tr.heat = Math.min(1, tr.heat + dt / GUN.heatTime)
    tr.idle = 0
    if (tr.heat >= 1) {
      tr.overheated = true
      tr.owed = 0
    }
  } else {
    tr.owed = trigger ? 0 : 0.999
    tr.idle += dt
    if (tr.idle > GUN.coolDelay) tr.heat = Math.max(0, tr.heat - GUN.cool * dt)
  }
  return n
}

/** Model-space muzzle position and barrel direction for turret yaw/pitch (into `pos` and `dir`). */
export function muzzleLocal(yaw: number, pitch: number, pos: Vec3, dir: Vec3): void {
  const sy = Math.sin(yaw)
  const cy = Math.cos(yaw)
  const cp = Math.cos(pitch)
  const sp = Math.sin(pitch)
  dir[0] = sy * cp
  dir[1] = sp
  dir[2] = cy * cp
  // Trunnion in the turret's frame, rotated by the yaw about the yaw pivot.
  const tx = GUN.trunnion[0]
  const tz = GUN.trunnion[2]
  pos[0] = GUN.yawPivot[0] + tx * cy + tz * sy + dir[0] * GUN.barrel
  pos[1] = GUN.yawPivot[1] + GUN.trunnion[1] + dir[1] * GUN.barrel
  pos[2] = GUN.yawPivot[2] - tx * sy + tz * cy + dir[2] * GUN.barrel
}

const mp: Vec3 = [0, 0, 0]
const md: Vec3 = [0, 0, 0]

/** World muzzle position and unit barrel direction of a boat's turret. */
export function muzzleWorld(pose: BoatPoseLike, yaw: number, pitch: number, pos: Vec3, dir: Vec3): void {
  muzzleLocal(yaw, pitch, mp, md)
  shipToWorld(pose, mp[0], mp[1], mp[2], pos)
  shipToWorld(pose, mp[0] + md[0], mp[1] + md[1], mp[2] + md[2], dir)
  dir[0] -= pos[0]
  dir[1] -= pos[1]
  dir[2] -= pos[2]
}

// ---- rounds -------------------------------------------------------------------------------------------------------

/** A boat as rounds and weapons see it: crew player id, team, pose, plan velocity, alive. */
export type BoatTarget = { id: number; team: number; pose: BoatPoseLike; vx: number; vz: number; alive: boolean }

/** Model-space hull box of the boat (with the wheelhouse): x beam, y keel to cabin roof, z stern to bow. */
export const BOAT_BOX = { x0: -2.8, x1: 2.8, y0: -0.6, y1: 3.6, z0: -9, z1: 9 } as const

const ba: Vec3 = [0, 0, 0]
const bb: Vec3 = [0, 0, 0]

/**
 * Where the segment a → b (world) first enters a boat's hull box grown by `slack`: the fraction 0..1 along it, or −1.
 * The boat is taken where it is (its motion over one step is far smaller than a round's).
 */
export function boatSegmentHit(pose: BoatPoseLike, ax: number, ay: number, az: number, bx: number, by: number, bz: number, slack = 0): number {
  if (Math.min(ax, bx) > pose.x + 12 + slack || Math.max(ax, bx) < pose.x - 12 - slack || Math.min(az, bz) > pose.z + 12 + slack || Math.max(az, bz) < pose.z - 12 - slack) return -1
  const p = worldToShip(pose, ax, ay, az, ba)
  const q = worldToShip(pose, bx, by, bz, bb)
  let t0 = 0
  let t1 = 1
  const lo = [BOAT_BOX.x0 - slack, BOAT_BOX.y0 - slack, BOAT_BOX.z0 - slack]
  const hi = [BOAT_BOX.x1 + slack, BOAT_BOX.y1 + slack, BOAT_BOX.z1 + slack]
  for (let k = 0; k < 3; k++) {
    const d = q[k]! - p[k]!
    if (Math.abs(d) < 1e-9) {
      if (p[k]! < lo[k]! || p[k]! > hi[k]!) return -1
      continue
    }
    let e0 = (lo[k]! - p[k]!) / d
    let e1 = (hi[k]! - p[k]!) / d
    if (e0 > e1) [e0, e1] = [e1, e0]
    t0 = Math.max(t0, e0)
    t1 = Math.min(t1, e1)
    if (t0 > t1) return -1
  }
  return t0
}

/** What a 25 mm round struck: a jet or a boat (`id`), or the world (`id` −1); `ship` the carrier when it was one. */
export type BoatRoundHit = (owner: number, kind: "jet" | "boat" | "sea" | "land" | "ship", id: number, x: number, y: number, z: number, ship: GroundShip | null) => void

const sd: [number] = [0]

/**
 * 25 mm rounds in flight: a fixed ring, structure of arrays, as shared/combat.ts `Bullets` but with the turret's
 * ballistics, and boats (hull boxes) as targets besides jets (spheres). `hits` false: cosmetic (world only).
 */
export class BoatRounds {
  readonly cap: number
  readonly x: Float64Array
  readonly y: Float64Array
  readonly z: Float64Array
  readonly vx: Float64Array
  readonly vy: Float64Array
  readonly vz: Float64Array
  readonly age: Float32Array
  readonly owner: Int32Array
  readonly team: Int32Array
  /** 0 free, 1 flying, 2 flying tracer. */
  readonly state: Uint8Array
  hits = true
  live = 0
  private next = 0

  constructor(cap = 128) {
    this.cap = cap
    this.x = new Float64Array(cap)
    this.y = new Float64Array(cap)
    this.z = new Float64Array(cap)
    this.vx = new Float64Array(cap)
    this.vy = new Float64Array(cap)
    this.vz = new Float64Array(cap)
    this.age = new Float32Array(cap)
    this.owner = new Int32Array(cap)
    this.team = new Int32Array(cap)
    this.state = new Uint8Array(cap)
  }

  clear(): void {
    this.state.fill(0)
    this.live = 0
  }

  /** Fires round `round` of `owner` from (x, y, z) along unit d, with the boat's velocity (vx, vz); dispersion hashed. */
  fire(owner: number, team: number, round: number, x: number, y: number, z: number, dx: number, dy: number, dz: number, vx: number, vz: number): number {
    const i = this.next
    this.next = (i + 1) % this.cap
    if (!this.state[i]) this.live++
    // Two axes square to d for the dispersion disc.
    let ux = -dz
    let uz = dx
    const ul = Math.hypot(ux, uz) || 1
    ux /= ul
    uz /= ul
    const wx = dy * uz
    const wy = dz * ux - dx * uz
    const wz = -dy * ux
    const a = hash01(owner + 0x2500, round) * Math.PI * 2
    const r = Math.sqrt(hash01(owner ^ 0x25d1, round)) * Math.tan(GUN.spread)
    let fx = dx + (ux * Math.cos(a) + wx * Math.sin(a)) * r
    let fy = dy + wy * Math.sin(a) * r
    let fz = dz + (uz * Math.cos(a) + wz * Math.sin(a)) * r
    const n = Math.hypot(fx, fy, fz)
    fx /= n
    fy /= n
    fz /= n
    this.vx[i] = vx + fx * GUN.muzzle
    this.vy[i] = fy * GUN.muzzle
    this.vz[i] = vz + fz * GUN.muzzle
    this.x[i] = x
    this.y[i] = y
    this.z[i] = z
    this.age[i] = 0
    this.owner[i] = owner
    this.team[i] = team
    this.state[i] = round % GUN.tracer === 0 ? 2 : 1
    return i
  }

  /** One step at sea time t: gravity, then each round against enemy jets (spheres), boats (boxes) and the world. */
  step(dt: number, t: number, jets: readonly Target[], boats: readonly BoatTarget[], world: Ground, hit: BoatRoundHit): void {
    if (!this.live) return
    const r2 = GUN.jetRadius * GUN.jetRadius
    const grav = G * GUN.gravity * dt
    for (let i = 0; i < this.cap; i++) {
      if (!this.state[i]) continue
      const ax = this.x[i]!
      const ay = this.y[i]!
      const az = this.z[i]!
      this.vy[i] = this.vy[i]! - grav
      const bx = ax + this.vx[i]! * dt
      const by = ay + this.vy[i]! * dt
      const bz = az + this.vz[i]! * dt
      this.x[i] = bx
      this.y[i] = by
      this.z[i] = bz
      this.age[i] = this.age[i]! + dt
      if (this.hits) {
        let best = -1
        let bestK = 2
        let jet = true
        for (let j = 0; j < jets.length; j++) {
          const tg = jets[j]!
          if (!tg.alive || !canHurt(this.team[i]!, this.owner[i]!, tg.team, tg.id)) continue
          const qx = tg.x - bx
          const qy = tg.y - by
          const qz = tg.z - bz
          const reach = 30 + GUN.jetRadius
          if (qx * qx + qy * qy + qz * qz > reach * reach) continue
          const k = sweep(ax, ay, az, bx, by, bz, tg.x - tg.vx * dt, tg.y - tg.vy * dt, tg.z - tg.vz * dt, tg.x, tg.y, tg.z, sd)
          if (sd[0] <= r2 && k < bestK) {
            best = j
            bestK = k
          }
        }
        for (let j = 0; j < boats.length; j++) {
          const tg = boats[j]!
          if (!tg.alive || !canHurt(this.team[i]!, this.owner[i]!, tg.team, tg.id)) continue
          const k = boatSegmentHit(tg.pose, ax, ay, az, bx, by, bz, GUN.boatSlack)
          if (k >= 0 && k < bestK) {
            best = j
            bestK = k
            jet = false
          }
        }
        if (best >= 0) {
          this.kill(i)
          const id = jet ? jets[best]!.id : boats[best]!.id
          hit(this.owner[i]!, jet ? "jet" : "boat", id, ax + (bx - ax) * bestK, ay + (by - ay) * bestK, az + (bz - az) * bestK, null)
          continue
        }
      }
      const kind = by < 640 ? groundHit(world, bx, by, bz, t) : ""
      if (kind) {
        this.kill(i)
        hit(this.owner[i]!, kind, -1, bx, kind === "sea" && world.sea ? seaHeight(world.sea, bx, bz, t) : by, bz, kind === "ship" ? shipAt(world, bx, by, bz) : null)
        continue
      }
      if (this.age[i]! >= GUN.life) this.kill(i)
    }
  }

  private kill(i: number): void {
    this.state[i] = 0
    this.live--
  }
}

// ---- health and damage --------------------------------------------------------------------------------------------

/** What can hurt a boat (and what the boat's gun does to others). */
export type BoatWeapon = "cannon" | "gun" | "missile" | "bomb" | "ciws" | "shell" | "crash"

export const BOAT_HEALTH = {
  max: 200,
  /** Smoke below this share of max, fire below `fire`. */
  smoke: 0.5,
  fire: 0.25,
  /** Field repair after `repairDelay` s without damage, hp per second. */
  repairDelay: 12,
  repair: 3,
  /** A boat lost within this long of damage credits the attacker (s). */
  credit: 12,
  /** Seconds a destroyed boat takes to go under (it is drawn sinking), and the slot's recharge after (shared/ops.ts). */
  sink: 7,
}

/** Damage per hit. `cannon` is the boat's 25 mm, per round; `gun` the jets' M61, per round. */
export const BOAT_DAMAGE = {
  /** The 25 mm on a boat, a jet (100 hp) and a carrier (1,000 hp: chip damage). */
  cannonBoat: 9,
  cannonJet: 7,
  cannonShip: 1.2,
  /** Jet cannon round, CIWS round, a missile strike (proximity: falls to `missileEdge` at 12 m), a bomb burst at the
   *  centre (falls to `bombEdge` at 30 m), a 5-inch shell burst (falls to `shellEdge` at 15 m), a jet crashing into it. */
  gun: 1.6,
  ciws: 4,
  missile: 140,
  missileEdge: 60,
  missileFuse: 12,
  bomb: 220,
  bombEdge: 50,
  bombRadius: 30,
  shell: 110,
  shellEdge: 20,
  shellRadius: 15,
  crash: 80,
}

/** Damage to a boat from weapon `w` (`n` rounds for the guns; `dist` m from a burst for the explosives). */
export function boatDamage(w: BoatWeapon, n = 1, dist = 0): number {
  const D = BOAT_DAMAGE
  const fall = (at: number, edge: number, radius: number) => (dist > radius ? 0 : at + (edge - at) * (dist / radius))
  if (w === "cannon") return D.cannonBoat * n
  if (w === "gun") return D.gun * n
  if (w === "ciws") return D.ciws * n
  if (w === "missile") return fall(D.missile, D.missileEdge, D.missileFuse)
  if (w === "bomb") return fall(D.bomb, D.bombEdge, D.bombRadius)
  if (w === "shell") return fall(D.shell, D.shellEdge, D.shellRadius)
  return D.crash
}

/** Damage state of a boat's health: 0 fine, 1 smoking, 2 burning, 3 destroyed. */
export function boatState(hp: number): 0 | 1 | 2 | 3 {
  const h = BOAT_HEALTH
  if (hp <= 0) return 3
  if (hp < h.max * h.fire) return 2
  if (hp < h.max * h.smoke) return 1
  return 0
}

/** One boat's health in a `BoatCombat`. */
export type BoatLife = { id: number; team: number; hp: number; alive: boolean; hitAt: number; by: number; w: BoatWeapon; rounds: number; sent: number }

export type BoatEvent =
  /** A boat's health changed (damage, or repair with by −1). */
  | { k: "bhp"; on: number; hp: number; by: number; w: BoatWeapon | "" }
  /** A boat was destroyed, by whom (−1 lost on its own) and with what. */
  | { k: "bkill"; on: number; by: number; w: BoatWeapon | "" }

/**
 * Boat health for a room (or the offline harness): spawn on launch, `hit` applies damage (friendly fire off), a
 * round budget checks reported 25 mm rounds, repair after a quiet spell, kill credit. Events accumulate in `events`.
 */
export class BoatCombat {
  t = 0
  readonly boats = new Map<number, BoatLife>()
  readonly events: BoatEvent[] = []

  spawn(id: number, team: number, t = this.t): BoatLife {
    const b: BoatLife = { id, team, hp: BOAT_HEALTH.max, alive: true, hitAt: t - 1e6, by: -1, w: "cannon", rounds: GUN.rate, sent: BOAT_HEALTH.max }
    this.boats.set(id, b)
    return b
  }

  remove(id: number): void {
    this.boats.delete(id)
  }

  hp(id: number): number {
    return this.boats.get(id)?.hp ?? BOAT_HEALTH.max
  }

  /** Spends up to `n` reported 25 mm rounds from boat `shooter`'s budget (refilled at the gun's rate). */
  spend(shooter: number, n: number): number {
    const a = this.boats.get(shooter)
    if (!a || !a.alive) return 0
    const use = Math.max(0, Math.min(Math.floor(n), Math.floor(a.rounds)))
    a.rounds -= use
    return use
  }

  /** `amount` damage to boat `on` from `by` (team `team`) with `w`. Refused for friends and dead boats. */
  hit(on: number, by: number, team: number, w: BoatWeapon, amount: number): number {
    const b = this.boats.get(on)
    if (!b || !b.alive || amount <= 0 || !canHurt(team, by, b.team, on)) return 0
    b.hp = Math.max(0, b.hp - amount)
    b.sent = b.hp
    b.hitAt = this.t
    b.by = by
    b.w = w
    this.events.push({ k: "bhp", on, hp: Math.round(b.hp * 10) / 10, by, w })
    if (b.hp <= 0) {
      b.alive = false
      this.events.push({ k: "bkill", on, by, w })
    }
    return amount
  }

  /** A boat lost on its own (ran into something, left the map): destroyed, credited to a recent attacker. */
  lose(on: number): void {
    const b = this.boats.get(on)
    if (!b || !b.alive) return
    b.alive = false
    b.hp = 0
    const credit = b.by >= 0 && this.t - b.hitAt <= BOAT_HEALTH.credit
    this.events.push({ k: "bkill", on, by: credit ? b.by : -1, w: credit ? b.w : "" })
  }

  /** Advances to sea time t: round budgets refill, quiet boats repair. */
  step(t: number): void {
    const dt = Math.max(0, Math.min(1, t - this.t))
    this.t = t
    const h = BOAT_HEALTH
    for (const b of this.boats.values()) {
      if (!b.alive) continue
      b.rounds = Math.min(GUN.rate * 1.5, b.rounds + GUN.rate * 1.15 * dt)
      if (b.hp < h.max && t - b.hitAt > h.repairDelay) {
        b.hp = Math.min(h.max, b.hp + h.repair * dt)
        if (b.hp - b.sent >= 10 || b.hp >= h.max) {
          b.sent = b.hp
          this.events.push({ k: "bhp", on: b.id, hp: Math.round(b.hp * 10) / 10, by: -1, w: "" })
        }
      }
    }
  }
}

// ---- wire ---------------------------------------------------------------------------------------------------------

/**
 * A boat on the wire: [id, t, x, z, heading, u, v, r, power, rudder, turretYaw, turretPitch, mode, modeAt, ship,
 * fromX, fromZ, fromYaw, firing, boosting]. `mode` BOAT_MODE; `modeAt` the sea time it began; `ship` the carrier its
 * crane belongs to; `from*` the recovery's ship-local start.
 */
export type BoatTuple = number[]
export const BOAT_TUPLE = 20

export type BoatNet = {
  id: number
  t: number
  x: number
  z: number
  heading: number
  u: number
  v: number
  r: number
  power: number
  rudder: number
  yaw: number
  pitch: number
  mode: BoatMode
  modeAt: number
  ship: number
  from: { x: number; z: number; yaw: number } | null
  firing: boolean
  boosting: boolean
}

const r3 = (v: number) => Math.round(v * 1000) / 1000
const r2 = (v: number) => Math.round(v * 100) / 100

export function packBoat(b: BoatNet): BoatTuple {
  return [b.id, r3(b.t), r2(b.x), r2(b.z), r3(b.heading), r2(b.u), r2(b.v), r3(b.r), r2(b.power), r2(b.rudder), r3(b.yaw), r3(b.pitch), b.mode, r3(b.modeAt), b.ship, r2(b.from?.x ?? 0), r2(b.from?.z ?? 0), r3(b.from?.yaw ?? 0), b.firing ? 1 : 0, b.boosting ? 1 : 0]
}

export function isBoatTuple(v: unknown): v is BoatTuple {
  return Array.isArray(v) && v.length === BOAT_TUPLE && v.every((x) => typeof x === "number" && Number.isFinite(x)) && Number.isInteger(v[0]) && v[12] >= 0 && v[12] <= 3 && Number.isInteger(v[12])
}

export function unpackBoat(v: BoatTuple): BoatNet {
  const mode = v[12] as BoatMode
  return {
    id: v[0]!,
    t: v[1]!,
    x: v[2]!,
    z: v[3]!,
    heading: v[4]!,
    u: v[5]!,
    v: v[6]!,
    r: v[7]!,
    power: v[8]!,
    rudder: v[9]!,
    yaw: v[10]!,
    pitch: v[11]!,
    mode,
    modeAt: v[13]!,
    ship: v[14]!,
    from: mode === BOAT_MODE.recover ? { x: v[15]!, z: v[16]!, yaw: v[17]! } : null,
    firing: v[18] === 1,
    boosting: v[19] === 1,
  }
}
