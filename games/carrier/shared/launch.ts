// Catapult takeoff from a moving carrier, then the hand-over to planeStep. Pure and DOM-free, fixed timestep.
//
// The jet lives in ship-local coordinates (carrier-spec: +Z bow, +Y up, origin at the waterline amidships) for the
// whole deck run and is placed in the world through the carrier's current pose every step, so it stays glued to a
// deck that heaves, pitches, rolls and turns.
//
// One continuous launch: the jet waits parked on the shuttle at the stern end of the runway, stationary, engines at
// idle (`ready`, LAUNCH.hold s). Then everything starts on the same instant (`launchStart`): full throttle and the
// afterburner, the catapult and the motion, one acceleration curve from rest that eases in over LAUNCH.easeIn s and
// then pulls a near-constant ~3.5 g down nearly the whole runway (`stroke`, `progress` 0..1) to the bow, where the jet
// leaves (`launchEnd`: phase `airborne`) with the carrier's plan velocity plus the launch speed and a slight nose-up.
//
// Audio and effects key off these: `launchStart` = the step `phase` goes ready → stroke, `progress` along the stroke,
// `launchEnd` = the step it goes stroke → airborne (launchStep returns true).
//
// One catapult per ship: the room refuses another launch on the same ship for `catapultTime(kind)` after granting one
// (shared/ops.ts, "catapult-busy").

import { BOW_Z, CENTERLINE_X, DECK_Y, RUNWAY } from "./carrier-spec"
import { PLANE, type Plane, type Quat, type ShipPoseLike, quatAxis, quatMul, setPlaneQuat, shipQuat, shipToWorld, type Vec3, makePlane } from "./plane"
import { VEHICLES, type VehicleKind, deckCentreY } from "./vehicles"

const DEG = Math.PI / 180

export const LAUNCH = {
  /** Catapult track on the runway centreline. */
  x: CENTERLINE_X,
  /** The shuttle (the jet's centre) at the stern end of the runway, and where the jet leaves the deck: ~87% of the
   *  runway's length between them. */
  startZ: RUNWAY.z0 + 43,
  endZ: BOW_Z - 1,
  /** Parked on the shuttle at idle before the launch (s). */
  hold: 1,
  /** The acceleration eases in from zero over this long (s), then holds (each type's from its `strokeTime`). */
  easeIn: 0.3,
  /** Height of the Hornet's model origin (lowest belly point) above the deck with the gear down (VEHICLES[kind].gear). */
  gear: 1.35,
  /** Nose-up kneel on the catapult (rad), and the extra nose-up and flight-path climb given at the bow. */
  kneel: 1.5 * DEG,
  noseUp: 7 * DEG,
  pathUp: 3.5 * DEG,
  /** After a crash, the player is back on deck after this long (s). */
  respawnDelay: 2.5,
} as const

/** The stroke's length (m): shuttle to bow. */
export const STROKE = LAUNCH.endZ - LAUNCH.startZ

export type LaunchPhase = "ready" | "stroke" | "airborne"

export type Launch = {
  /** The aircraft type on the catapult (its gear height and stroke time). */
  kind: VehicleKind
  phase: LaunchPhase
  /** Seconds in the current phase (in `stroke`: since launchStart). */
  time: number
  /** Ship-local z of the jet's centre, its deck-relative speed (m/s), and how far along the stroke it is (0..1). */
  z: number
  speed: number
  progress: number
  /** Throttle shown on the deck (0..1), and the afterburner. */
  throttle: number
  burner: number
  /** Catapult trauma for the camera: rises through the stroke, peaks at the shot. */
  shake: number
}

/** The stroke's distance from rest after t seconds with acceleration a (eased in over LAUNCH.easeIn), and its speed. */
function strokeAt(a: number, t: number, out: { s: number; v: number }): { s: number; v: number } {
  const e = LAUNCH.easeIn
  if (t <= e) {
    out.s = (a * t * t * t) / (6 * e)
    out.v = (a * t * t) / (2 * e)
  } else {
    const u = t - e
    out.s = (a * e * e) / 6 + ((a * e) / 2) * u + (a * u * u) / 2
    out.v = a * (t - e / 2)
  }
  return out
}

/** Catapult of an aircraft type: its acceleration (m/s², after the ease-in), time (s) and deck-relative speed at the
 *  bow (m/s). The time is VEHICLES[kind].strokeTime, the distance STROKE. */
export function catapult(kind: VehicleKind): { accel: number; time: number; speed: number } {
  const T = VEHICLES[kind].strokeTime
  const accel = STROKE / strokeAt(1, T, { s: 0, v: 0 }).s
  return { accel, time: T, speed: strokeAt(accel, T, { s: 0, v: 0 }).v }
}

/** How long a launch of `kind` holds the ship's catapult (s): parked, then the stroke, plus a little slack for the
 *  client starting after the room grants it. */
export const catapultTime = (kind: VehicleKind): number => LAUNCH.hold + VEHICLES[kind].strokeTime + 1

/** Deck-relative speed at the bow (the Hornet's; `catapult(kind).speed` for others). */
export const LAUNCH_SPEED = catapult("hornet").speed
/** Ship-local height of the Hornet's centre on deck (`deckCentreY(kind)` for others). */
export const DECK_CENTRE_Y = DECK_Y + LAUNCH.gear + PLANE.centre

export function makeLaunch(kind: VehicleKind = "hornet"): Launch {
  return { kind, phase: "ready", time: 0, z: LAUNCH.startZ, speed: 0, progress: 0, throttle: 0.15, burner: 0, shake: 0 }
}

/** A jet of type `kind` on the deck at the start of the launch sequence, placed on `ship`. */
export function startLaunch(ship: ShipPoseLike & { t: number }, plane: Plane = makePlane(ship.t), kind: VehicleKind = "hornet"): { launch: Launch; plane: Plane } {
  const launch = makeLaunch(kind)
  Object.assign(plane, makePlane(ship.t))
  place(launch, plane, ship, 0)
  return { launch, plane }
}

/** Plan velocity of the deck at ship-local (x, z): forward and sideways speed plus the turn about the hull's centre.
 *  The lever arm comes from shipToWorld, so it holds whichever way the model's x axis points. */
export function deckVelocity(ship: ShipLike, x: number, z: number, out: Vec3): Vec3 {
  const sh = Math.sin(ship.heading)
  const ch = Math.cos(ship.heading)
  const arm = shipToWorld({ ...ship, heave: 0, pitch: 0, roll: 0 }, x, 0, z, out)
  const ax = arm[0] - ship.x
  const az = arm[2] - ship.z
  out[0] = ship.u * sh + ship.v * ch - ship.r * az
  out[1] = 0
  out[2] = -ship.u * ch + ship.v * sh + ship.r * ax
  return out
}

export type ShipLike = ShipPoseLike & { u: number; v: number; r: number }

const qa: Quat = [0, 0, 0, 1]
const qb: Quat = [0, 0, 0, 1]
const p0: Vec3 = [0, 0, 0]
const vel: Vec3 = [0, 0, 0]

/** Puts the jet at its ship-local spot on the deck; velocity is the deck's own plus the run along it. */
function place(l: Launch, plane: Plane, ship: ShipPoseLike, dt: number): void {
  const p = shipToWorld(ship, LAUNCH.x, deckCentreY(l.kind), l.z, p0)
  const q = shipQuat(ship, qa)
  quatMul(q, quatAxis(1, 0, 0, -LAUNCH.kneel, qb), q)
  if (dt > 0) {
    plane.vx = (p[0] - plane.x) / dt
    plane.vy = (p[1] - plane.y) / dt
    plane.vz = (p[2] - plane.z) / dt
  } else {
    plane.vx = plane.vy = plane.vz = 0
  }
  plane.x = p[0]
  plane.y = p[1]
  plane.z = p[2]
  setPlaneQuat(plane, q)
  plane.throttle = l.throttle
  plane.boosting = l.burner > 0.5 ? 1 : 0
}

/** Places a jet of type `kind` at ship-local catapult position z on `ship` (position and orientation only), e.g. to
 *  draw it glued to the hull as drawn this frame, or to show another player's launch on this client's copy of their
 *  carrier. */
export function launchPose(z: number, ship: ShipPoseLike, plane: Plane, kind: VehicleKind = "hornet"): Plane {
  const p = shipToWorld(ship, LAUNCH.x, deckCentreY(kind), z, p0)
  const q = shipQuat(ship, qa)
  quatMul(q, quatAxis(1, 0, 0, -LAUNCH.kneel, qb), q)
  plane.x = p[0]
  plane.y = p[1]
  plane.z = p[2]
  setPlaneQuat(plane, q)
  return plane
}

const run = { s: 0, v: 0 }

/**
 * One fixed step of the takeoff on the carrier `ship` (already stepped to this tick). While on deck the jet's pose is
 * rebuilt from the ship's; at the bow it is released into free flight. Returns true on the step it leaves the deck
 * (`launchEnd`); from then on drive it with planeStep.
 */
export function launchStep(l: Launch, plane: Plane, ship: ShipLike, dt: number): boolean {
  if (l.phase === "airborne") return false
  l.time += dt
  plane.t += dt
  l.shake *= Math.exp(-dt * 3)
  if (l.phase === "ready") {
    // Parked at idle, not moving. At the end of the hold: launchStart, from this very step.
    if (l.time < LAUNCH.hold) {
      place(l, plane, ship, dt)
      return false
    }
    l.phase = "stroke"
    l.time = 0
  }
  const cat = catapult(l.kind)
  strokeAt(cat.accel, l.time, run)
  l.z = LAUNCH.startZ + run.s
  l.speed = run.v
  l.progress = Math.min(1, run.s / STROKE)
  l.throttle = 1
  l.burner = 1
  l.shake = Math.max(l.shake, 0.3 + 0.45 * l.progress)
  if (l.z >= LAUNCH.endZ) {
    release(l, plane, ship)
    return true
  }
  place(l, plane, ship, dt)
  return false
}

/** Leaves the bow: heading and roll of the deck, nose-up, deck plan velocity plus launch speed slightly climbing. */
function release(l: Launch, plane: Plane, ship: ShipLike): void {
  l.phase = "airborne"
  l.time = 0
  l.progress = 1
  l.shake = 1
  const p = shipToWorld(ship, LAUNCH.x, deckCentreY(l.kind), LAUNCH.endZ, p0)
  const speed = catapult(l.kind).speed
  // Never leave pointing down: a bow pitching under gets a level flight path, not the deck's.
  const pitch = Math.max(0, ship.pitch)
  const roll = ship.roll * 0.5
  const q = quatMul(quatAxis(0, 1, 0, Math.PI - ship.heading, qa), quatAxis(1, 0, 0, -(pitch + LAUNCH.noseUp), qb), qa)
  quatMul(q, quatAxis(0, 0, 1, roll, qb), q)
  setPlaneQuat(plane, q)
  const d = deckVelocity(ship, LAUNCH.x, LAUNCH.endZ, vel)
  const path = pitch + LAUNCH.pathUp
  const sh = Math.sin(ship.heading)
  const ch = Math.cos(ship.heading)
  const cp = Math.cos(path)
  plane.x = p[0]
  plane.y = p[1]
  plane.z = p[2]
  plane.vx = d[0] + speed * cp * sh
  plane.vy = speed * Math.sin(path)
  plane.vz = d[2] - speed * cp * ch
  plane.p = plane.r = plane.w = 0
  plane.throttle = 1
  plane.boosting = 0
  plane.blend = 0
}
