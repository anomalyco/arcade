// Ship simulation: the player's carrier on the deterministic sea. Pure and DOM-free, so the client predicts with it
// and the server can later run it too. Fixed timestep (SHIP.tick); the caller accumulates frame time.
//
// Plan frame: x east, z south (world). Heading h is a compass bearing: the bow points along F = (sin h, -cos h), the
// starboard side along R = (cos h, sin h). Yaw rate r > 0 turns to starboard (h increases). Ship-local points are
// (f, s): f metres toward the bow, s metres to starboard. Pitch > 0 is bow up, roll > 0 is starboard down.
//
// Vertical motion is a spring-damper per axis driven by per-point buoyancy at HULL_POINTS: each point pushes in
// proportion to how far the water stands above it (capped at the draft when it leaves the water, stiffer when buried
// because of the flare), so the hull averages out short chop, rides long swells, and the bow climbs a swell and drops
// back off it. Remote ships run `shipFloat` locally on the same sea, so every client sees them bob in step.

import { BEAM_WL, DRAFT, LENGTH } from "./carrier-spec"
import { type Archipelago, islandFootprint, terrainHeight } from "./islands"
import { type Sea, seaHeight } from "./sea"

export const KNOT = 0.514444

/** Every tunable in one place. Units are SI unless noted. */
export const SHIP = {
  /** Fixed simulation step (s). */
  tick: 1 / 60,

  // Propulsion. The engines hold a speed: the throttle order maps linearly to a target speed (50% = half of top
  // speed). Below it the screws push with thrust · (1 − thrustFade · u/U), easing off over the last `band` m/s; above
  // it the ship coasts down on hull drag (quadratic + linear + friction) until it reaches the target.
  /** Speed at 100% (m/s): 46 kn. Arcade-fast for a carrier, so speed reads at chase-camera distance. */
  topSpeed: 46 * KNOT,
  /** Acceleration from standstill at full power (m/s²): ~7 s to 90% of top speed. */
  thrust: 4.4,
  /** Thrust falls off with speed (screws bite less), so the last knots come slower than the first. */
  thrustFade: 0.55,
  /** Thrust eases off over this many m/s below the target speed. */
  band: 2.5,
  /** Coasting deceleration at top speed (m/s²), the share of it that is linear in speed (the rest quadratic), and a
   *  constant friction so a coasting ship finally stops: ~1 km from 36 kn to a stop. */
  coastDrag: 1.1,
  linearShare: 0.2,
  friction: 0.02,
  /** Deepest astern order (fraction of full power): the throttle runs from −astern to 1. Astern thrust is weaker
   *  (`asternThrust` of `thrust`), so backing up is slow and stopping by reversing takes a while. */
  astern: 0.3,
  asternThrust: 0.6,
  /** Engine output follows the throttle order at these rates (fraction of full power per second). */
  spoolUp: 2,
  spoolDown: 2.5,
  /** Speed lost to a hard turn: drag per unit yaw rate (1/rad). ~25% slower in a full-rudder turn. */
  turnDrag: 1.3,

  // Steering.
  /** Rudder angle slew toward the order and back to centre (fraction of full rudder per second). */
  rudderRate: 3,
  rudderReturn: 3.5,
  /** Turning radius at full rudder (m): turnRadius + turnRadiusPerSpeed · speed, so the ship turns tighter when slow
   *  (but slower: the rudder needs flow). ~0.75 km tactical diameter at full speed, ~0.4 km at 10 kn. */
  turnRadius: 60,
  turnRadiusPerSpeed: 11,
  /** Propeller wash over the rudder at full power, as a share of top speed: a stopped or slow ship still swings its
   *  stern round while the screws turn. */
  wash: 0.5,
  /** Time for the yaw rate to settle on what the rudder asks for (s). Bigger feels heavier. */
  yawLag: 0.55,
  /** Sideslip in a turn: lateral speed = −slip · u · r (the stern swings outward; ~8° drift angle at full turn). */
  slip: 2.6,
  slipLag: 1.5,
  /** Heel outward in a turn (rad per m/s · rad/s): ~4° at full speed and full rudder. */
  heel: 0.032,
  /** Bow-up trim and squat at speed. */
  trim: 0.00045,
  squat: 0.02,

  // Buoyancy (natural periods and damping ratios per axis).
  /** Share of the hull length and beam the buoyancy points span. Shorter than the real waterline so long swells
   *  read on a 330 m hull (the full length averages most of them away). */
  span: 0.7,
  beamSpan: 1,
  /** Scales the water's rise and fall felt by the hull around the waterline. Above 1 exaggerates the motion. */
  gain: 1.3,
  heavePeriod: 7,
  heaveDamp: 0.5,
  pitchPeriod: 6.5,
  pitchDamp: 0.32,
  rollPeriod: 12,
  rollDamp: 0.4,
  /** How much of the water's slope across the hull the roll follows (a carrier's wide, flat hull resists rolling). */
  rollGain: 0.6,
  /** Extra stiffness per metre buried (flared bow and sponsons push harder than the wall-sided waterline). */
  flare: 1 / 7,
  /** The flare stops growing past this depth (m): a buried bow pushes hard, not explosively. */
  flareMax: 5,
  /** Hard limits; past `softLimit` of them a stiff stop spring takes over, so the hull never hits a wall. */
  maxPitch: 0.27,
  maxRoll: 0.36,
  softLimit: 0.75,

  // Storms. A storm sea's significant height (Hs, from the waves' amplitudes) blends the hull from the steady calm
  // response above to a lively one: the buoyancy points close in toward midships (long storm swells come through
  // instead of being averaged out by the hull), the natural periods shorten to the free-fall period of the draft (an
  // emerged bow drops at ~1 g), damping falls, and only the wet part of the hull damps. Calm and light seas are
  // unchanged (Hs below stormHs[0]).
  /** Hs (m) where the storm response starts and where it is complete. */
  stormHs: [9.6, 15] as readonly [number, number],
  stormSpan: 0.7,
  stormRollSpan: 0.8,
  stormGain: 1.15,
  stormHeavePeriod: 5.3,
  stormPitchPeriod: 5.6,
  stormRollPeriod: 8.5,
  stormHeaveDamp: 0.28,
  stormPitchDamp: 0.18,
  stormRollDamp: 0.2,
  stormRollGain: 0.85,
  /** Bow slam: the bow tip (f = slamAt) re-entering the water faster than slamSpeed (m/s) after standing clear of it;
   *  full slam at slamFull m/s. The water takes out part of the bow's downward swing at once (slamStop). */
  slamAt: 150,
  slamSpeed: 2.5,
  slamFull: 9,
  slamStop: 0.45,

  // Grounding.
  /** Keel depth used for grounding at the hull's waterline points; the bow forefoot is shallower. */
  keel: DRAFT,
  bowKeel: 4,
  /** Fraction of the into-land speed bounced back, and tangential friction while aground (1/s per metre of rise). */
  bounce: 0.15,
  groundFriction: 0.9,
  /** Push out of the terrain (m/s per metre of rise, capped). */
  pushOut: 0.8,
  pushMax: 3,
  /** Radius of gyration in yaw (m), for impacts away from the centre. */
  gyration: 0.28 * LENGTH,

  // World edge: beyond this radius from the origin a growing current pushes the ship back.
  edge: 8500,
  edgePush: 0.004,
} as const

export type ShipControls = {
  /** Throttle order −SHIP.astern..1 (negative is astern; the engines spool toward it). */
  throttle: number
  /** Rudder order −1 (port) .. 1 (starboard); 0 returns the rudder to centre. */
  rudder: number
}

export type Ship = {
  /** Sea time of this state (s). */
  t: number
  x: number
  z: number
  heading: number
  /** Forward and starboard speed through the water (m/s). */
  u: number
  v: number
  /** Yaw rate (rad/s, > 0 to starboard). */
  r: number
  heave: number
  heaveVel: number
  pitch: number
  pitchVel: number
  roll: number
  rollVel: number
  /** Engine output −SHIP.astern..1 (lags the order; negative is astern). */
  power: number
  /** Rudder angle −1..1 (lags the order). */
  rudder: number
  /** Latest throttle order, kept for the HUD and the network. */
  order: number
  /** Grounding intensity 0..1: rises on impact, decays. For shake and sound. */
  ground: number
  /** Bow slam intensity 0..1: rises when the bow drops hard into the water, decays. For spray and shake. */
  slam: number
  /** Bow slam events so far (each re-entry of a clear bow into the water at speed): watch it change for spray. */
  slams: number
  /** How far the bow tip stands clear of the water (m, 0 when it is in it). */
  bowAir: number
}

/** Buoyancy sample points (f, s): 7 along the waterline length by 3 across, narrowing toward the bow. */
export const HULL_POINTS: readonly (readonly [f: number, s: number])[] = (() => {
  const out: [number, number][] = []
  const half = BEAM_WL / 2
  for (let i = 0; i < 7; i++) {
    const f = (i / 3 - 1) * SHIP.span * (LENGTH / 2)
    const w = (f > 100 ? 0.45 : 0.65) * half * SHIP.beamSpan
    for (const s of [-w, 0, w]) out.push([f, s])
  }
  return out
})()

/** Grounding probes on the waterline outline (f, s, keel depth below the waterline). */
export const CONTACT_POINTS: readonly (readonly [f: number, s: number, keel: number])[] = (() => {
  const out: [number, number, number][] = [[164, 0, SHIP.bowKeel], [150, -12, SHIP.bowKeel + 1], [150, 12, SHIP.bowKeel + 1]]
  const half = BEAM_WL / 2
  for (const f of [-162, -120, -80, -40, 0, 40, 80, 120]) {
    out.push([f, -half, SHIP.keel])
    out.push([f, half, SHIP.keel])
  }
  out.push([-164, 0, SHIP.keel - 2])
  return out
})()

export function makeShip(x: number, z: number, heading: number, t = 0): Ship {
  return { t, x, z, heading, u: 0, v: 0, r: 0, heave: 0, heaveVel: 0, pitch: 0, pitchVel: 0, roll: 0, rollVel: 0, power: 0, rudder: 0, order: 0, ground: 0, slam: 0, slams: 0, bowAir: 0 }
}

/** Heading from (x, z) toward (tx, tz). */
export const headingTo = (x: number, z: number, tx: number, tz: number) => Math.atan2(tx - x, -(tz - z))

export const copyShip = (from: Ship, to: Ship): Ship => Object.assign(to, from)

const wrap = (a: number) => a - Math.PI * 2 * Math.floor((a + Math.PI) / (Math.PI * 2))
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
const toward = (v: number, target: number, step: number) => (v < target ? Math.min(target, v + step) : Math.max(target, v - step))

const TAU = Math.PI * 2
const DRAG_TOP = SHIP.coastDrag - SHIP.friction
const DRAG_L = (DRAG_TOP * SHIP.linearShare) / SHIP.topSpeed
const DRAG_Q = (DRAG_TOP * (1 - SHIP.linearShare)) / (SHIP.topSpeed * SHIP.topSpeed)
const SUM_FF = HULL_POINTS.reduce((a, p) => a + p[0] * p[0], 0)
const SUM_SS = HULL_POINTS.reduce((a, p) => a + p[1] * p[1], 0)
const N_HULL = HULL_POINTS.length
const mix = (a: number, b: number, u: number) => a + (b - a) * u

/** 0..1: how stormy a sea is for the hull, from its significant wave height Hs = 2√2 · sqrt(Σ A²). */
export function seaStorm(sea: Sea): number {
  let e = 0
  for (const w of sea.waves) e += w.amp * w.amp
  const hs = 2 * Math.SQRT2 * Math.sqrt(e)
  const u = clamp((hs - SHIP.stormHs[0]) / (SHIP.stormHs[1] - SHIP.stormHs[0]), 0, 1)
  return u * u * (3 - 2 * u)
}

/** Past `softLimit` of the limit a stiff stop spring pushes back; at the limit the angle is held. */
function limit(angle: number, vel: number, max: number, dt: number): [number, number] {
  const soft = max * SHIP.softLimit
  const over = Math.abs(angle) - soft
  if (over > 0) {
    const k = over / (max - soft)
    vel -= Math.sign(angle) * 30 * k * k * dt
    if (Math.sign(vel) === Math.sign(angle)) vel *= Math.exp(-6 * k * dt)
  }
  if (Math.abs(angle) > max) {
    angle = clamp(angle, -max, max)
    if (Math.sign(vel) === Math.sign(angle)) vel *= 0.3
  }
  return [angle, vel]
}

/**
 * Vertical dynamics only: heave, pitch and roll from buoyancy on the sea at `ship.t`, plus heel and trim from the
 * current plan motion. Shared by the full step and by remote ships (whose plan pose comes from the network).
 *
 * Every buoyancy point pushes in proportion to how deep it sits (stiffer when buried, the flare); a point clear of the
 * water only pulls with its weight, so a bow thrown up by a crest falls back under gravity and slams into the trough.
 */
export function shipFloat(ship: Ship, sea: Sea, dt: number, lift = 0, liftPitch = 0): void {
  const st = seaStorm(sea)
  const span = mix(1, SHIP.stormSpan, st)
  const rollSpan = mix(1, SHIP.stormRollSpan, st)
  const gain = mix(SHIP.gain, SHIP.stormGain, st)
  const wH = TAU / mix(SHIP.heavePeriod, SHIP.stormHeavePeriod, st)
  const wP = TAU / mix(SHIP.pitchPeriod, SHIP.stormPitchPeriod, st)
  const wR = TAU / mix(SHIP.rollPeriod, SHIP.stormRollPeriod, st)
  const sh = Math.sin(ship.heading)
  const ch = Math.cos(ship.heading)
  const sp = Math.sin(ship.pitch)
  const sr = Math.sin(ship.roll)
  let sum = 0
  let sumF = 0
  let sumS = 0
  let wet = 0
  for (let i = 0; i < N_HULL; i++) {
    const p = HULL_POINTS[i]!
    const f = p[0] * span
    const s = p[1] * rollSpan
    const wx = ship.x + f * sh + s * ch
    const wz = ship.z - f * ch + s * sh
    const y = ship.heave + f * sp - s * sr
    let d = seaHeight(sea, wx, wz, ship.t) * gain - y
    if (d < -DRAFT) d = -DRAFT
    else if (d > 0) d *= 1 + Math.min(d, SHIP.flareMax) * SHIP.flare
    wet += d >= 0 ? 1 : 1 + d / DRAFT
    sum += d
    sumF += f * d
    sumS += s * d
  }
  // Only the wet hull damps: a bow flung clear of the water swings and falls freely.
  const damp = mix(1, wet / N_HULL, st)
  const u = ship.u
  const heave = (wH * wH * (sum / N_HULL - SHIP.squat * u) - 2 * mix(SHIP.heaveDamp, SHIP.stormHeaveDamp, st) * damp * wH * ship.heaveVel + lift) * dt
  const pitch = (wP * wP * (sumF / (SUM_FF * span * span) + SHIP.trim * u) - 2 * mix(SHIP.pitchDamp, SHIP.stormPitchDamp, st) * damp * wP * ship.pitchVel + liftPitch) * dt
  const roll = (wR * wR * ((-mix(SHIP.rollGain, SHIP.stormRollGain, st) * sumS) / (SUM_SS * rollSpan * rollSpan) - SHIP.heel * u * ship.r) - 2 * mix(SHIP.rollDamp, SHIP.stormRollDamp, st) * damp * wR * ship.rollVel) * dt

  // Bow slam: the bow tip comes back into the water fast after standing clear of it.
  const fb = SHIP.slamAt
  const bowY = ship.heave + fb * sp
  const bowWater = seaHeight(sea, ship.x + fb * sh, ship.z - fb * ch, ship.t) * gain
  const air = Math.max(0, bowY - bowWater)
  const bowVel = ship.heaveVel + fb * Math.cos(ship.pitch) * ship.pitchVel
  if (air === 0 && ship.bowAir > 0 && bowVel < -SHIP.slamSpeed) {
    const hit = Math.min(1, (-bowVel - SHIP.slamSpeed) / (SHIP.slamFull - SHIP.slamSpeed))
    ship.slam = Math.max(ship.slam, (0.35 + 0.65 * hit) * mix(0.4, 1, st))
    ship.slams++
    // The water stops the falling bow: part of its downward swing is taken out at once.
    ship.pitchVel -= ship.pitchVel * SHIP.slamStop * hit * st
  } else {
    // A buried bow driving down hard still shudders (the old calm-sea slam).
    const legacy = ship.heaveVel + 160 * ship.pitchVel
    if (air === 0 && bowWater - bowY > 0 && legacy < -0.8) ship.slam = Math.max(ship.slam, Math.min(1, (-legacy - 0.8) / 2.5) * 0.6)
  }
  ship.bowAir = air
  ship.slam *= Math.exp(-dt * 2.5)
  ship.heaveVel += heave
  ship.pitchVel += pitch
  ship.rollVel += roll
  ship.heave += ship.heaveVel * dt
  ship.pitch += ship.pitchVel * dt
  ship.roll += ship.rollVel * dt
  ;[ship.pitch, ship.pitchVel] = limit(ship.pitch, ship.pitchVel, SHIP.maxPitch, dt)
  ;[ship.roll, ship.rollVel] = limit(ship.roll, ship.rollVel, SHIP.maxRoll, dt)
}

type Near = { x: number; z: number; r: number }
const nearCache = new WeakMap<Archipelago, Near[]>()
function islandsOf(arch: Archipelago): Near[] {
  let n = nearCache.get(arch)
  if (!n) {
    n = arch.islands.map((i) => {
      const f = islandFootprint(i)
      return { x: i.x, z: i.z, r: Math.max(f.extent, f.reach, i.radius) + LENGTH / 2 + 150 }
    })
    nearCache.set(arch, n)
  }
  return n
}

/** Nearest island centre within reach of the ship, or null in open water. */
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

const GRAD = 12

/**
 * Pushes the ship out of any island its waterline probes have run onto: cancels the speed into the slope at each
 * probe (an impulse on the whole hull, so a glancing stern swings round), drags the rest, and nudges the hull
 * downhill. Returns the summed rise above the keel for heave/pitch lift.
 */
function ground(ship: Ship, arch: Archipelago, dt: number, out: { lift: number; liftPitch: number }): void {
  out.lift = 0
  out.liftPitch = 0
  const island = nearIsland(arch, ship.x, ship.z)
  if (!island) return
  const sh = Math.sin(ship.heading)
  const ch = Math.cos(ship.heading)
  const inertia = SHIP.gyration * SHIP.gyration
  let worst = 0
  let impact = 0
  for (const [f, s, keel] of CONTACT_POINTS) {
    const ax = f * sh + s * ch
    const az = -f * ch + s * sh
    const px = ship.x + ax
    const pz = ship.z + az
    const pen = terrainHeight(arch, px, pz) + keel
    if (pen <= 0) continue
    // Downhill normal; on a flat shelf fall back to "away from the island".
    let nx = terrainHeight(arch, px - GRAD, pz) - terrainHeight(arch, px + GRAD, pz)
    let nz = terrainHeight(arch, px, pz - GRAD) - terrainHeight(arch, px, pz + GRAD)
    let len = Math.hypot(nx, nz)
    if (len < 0.05) {
      nx = px - island.x
      nz = pz - island.z
      len = Math.hypot(nx, nz) || 1
    }
    nx /= len
    nz /= len
    // Point velocity: hull velocity plus r · perp(a), perp(a) = (−az, ax).
    const vx = ship.u * sh + ship.v * ch - ship.r * az
    const vz = -ship.u * ch + ship.v * sh + ship.r * ax
    const vn = vx * nx + vz * nz
    const c = -az * nx + ax * nz
    if (vn < 0) {
      const j = (-(1 + SHIP.bounce) * vn) / (1 + (c * c) / inertia)
      const dvx = j * nx
      const dvz = j * nz
      ship.u += dvx * sh - dvz * ch
      ship.v += dvx * ch + dvz * sh
      ship.r += (j * c) / inertia
      impact = Math.max(impact, -vn)
      // Running the bow up a slope lifts it.
      out.liftPitch += f > 100 ? -vn * 0.004 : 0
    }
    const push = Math.min(SHIP.pushMax, pen * SHIP.pushOut) * dt
    ship.x += nx * push
    ship.z += nz * push
    worst = Math.max(worst, pen)
    out.lift += Math.min(pen, 3) * 0.3
    out.liftPitch += Math.min(pen, 3) * 0.0004 * Math.sign(f) * (Math.abs(f) / 160)
    // Shudder: a deterministic roll kick toward the side that struck.
    ship.rollVel += -Math.sign(s) * Math.min(0.01, -Math.min(0, vn) * 0.004)
  }
  if (worst > 0) {
    const k = Math.exp(-SHIP.groundFriction * Math.min(worst, 4) * dt)
    ship.u *= k
    ship.v *= k
    ship.r *= k
    ship.ground = Math.max(ship.ground, Math.min(1, impact / 4 + worst * 0.05))
  }
}

const groundOut = { lift: 0, liftPitch: 0 }

/** Advances the ship by one fixed step `dt` (use SHIP.tick). Deterministic for the same inputs. */
export function shipStep(ship: Ship, controls: ShipControls, sea: Sea, arch: Archipelago | null, dt: number = SHIP.tick): void {
  const order = clamp(controls.throttle, -SHIP.astern, 1)
  ship.order = order
  ship.power = toward(ship.power, order, (Math.abs(order) > Math.abs(ship.power) && order * ship.power >= 0 ? SHIP.spoolUp : SHIP.spoolDown) * dt)
  const rudderOrder = clamp(controls.rudder, -1, 1)
  const rate = rudderOrder === 0 || Math.sign(rudderOrder) !== Math.sign(ship.rudder) ? SHIP.rudderReturn : SHIP.rudderRate
  ship.rudder = toward(ship.rudder, rudderOrder, rate * dt)

  // Surge.
  const u = ship.u
  const want = ship.power * SHIP.topSpeed
  let a: number
  if (want >= 0 && u >= 0) {
    if (u < want) a = SHIP.thrust * Math.max(0, 1 - (SHIP.thrustFade * Math.max(0, u)) / SHIP.topSpeed) * Math.min(1, (want - u) / SHIP.band)
    else a = -Math.min(DRAG_Q * u * u + DRAG_L * u + SHIP.friction, (u - want) / dt)
  } else {
    // Astern, or still moving backwards: hull drag opposes the motion, the screws push toward the ordered speed.
    const drag = -Math.sign(u) * (DRAG_Q * u * u + DRAG_L * Math.abs(u) + SHIP.friction)
    if (u > want) a = -SHIP.thrust * SHIP.asternThrust * Math.max(0, 1 - (SHIP.thrustFade * Math.max(0, -u)) / SHIP.topSpeed) * Math.min(1, (u - want) / SHIP.band) + drag
    else if (want > 0) a = SHIP.thrust * Math.min(1, (want - u) / SHIP.band) + drag
    else a = Math.min(drag, (want - u) / dt)
  }
  a -= SHIP.turnDrag * Math.abs(ship.r) * u
  // Soft world edge: a current back toward the middle.
  const dist = Math.hypot(ship.x, ship.z)
  let ex = 0
  let ez = 0
  if (dist > SHIP.edge) {
    const k = (dist - SHIP.edge) * SHIP.edgePush
    ex = (-ship.x / dist) * k
    ez = (-ship.z / dist) * k
  }
  const sh = Math.sin(ship.heading)
  const ch = Math.cos(ship.heading)
  a += ex * sh - ez * ch
  ship.u += a * dt
  if (ship.power === 0 && Math.abs(ship.u) < 0.02) ship.u = 0

  // Yaw: the rudder works on the flow past it, the ship's speed plus the screws' wash.
  const washV = SHIP.wash * SHIP.topSpeed * ship.power
  const flow = Math.sqrt(ship.u * ship.u + washV * washV) * (ship.u < 0 ? -1 : 1)
  const rTarget = (ship.rudder * flow) / (SHIP.turnRadius + SHIP.turnRadiusPerSpeed * Math.abs(ship.u))
  ship.r += (rTarget - ship.r) * (1 - Math.exp(-dt / SHIP.yawLag))
  // Sway: the stern slides outward in a turn.
  const vTarget = -SHIP.slip * ship.u * ship.r
  ship.v += (vTarget - ship.v) * (1 - Math.exp(-dt / SHIP.slipLag)) + (ex * ch + ez * sh) * dt

  if (arch) ground(ship, arch, dt, groundOut)
  else groundOut.lift = groundOut.liftPitch = 0
  ship.ground *= Math.exp(-dt * 1.8)

  ship.heading = wrap(ship.heading + ship.r * dt)
  const sh2 = Math.sin(ship.heading)
  const ch2 = Math.cos(ship.heading)
  ship.x += (ship.u * sh2 + ship.v * ch2) * dt
  ship.z += (-ship.u * ch2 + ship.v * sh2) * dt
  ship.t += dt

  shipFloat(ship, sea, dt, groundOut.lift, groundOut.liftPitch / dt)
}

/** Interpolates two ship states into `out` for rendering (heading takes the short way round). */
export function lerpShip(a: Ship, b: Ship, k: number, out: Ship): Ship {
  copyShip(b, out)
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

/** Plan pose sent over the network: everything a remote client needs to dead-reckon the hull. */
export type ShipPose = { t: number; x: number; z: number; heading: number; u: number; v: number; r: number; order: number; rudder: number }

export const poseOf = (s: Ship): ShipPose => ({ t: s.t, x: s.x, z: s.z, heading: s.heading, u: s.u, v: s.v, r: s.r, order: s.order, rudder: s.rudder })

/** Dead-reckons a pose forward to sea time t along its arc (constant speed and yaw rate), into `out`. */
export function extrapolatePose(p: ShipPose, t: number, out: { x: number; z: number; heading: number }): void {
  const dt = clamp(t - p.t, -1, 2)
  // Integrate in a few steps so the arc stays an arc.
  const n = Math.max(1, Math.ceil(Math.abs(dt) / 0.1))
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
