// Catapult takeoff from a moving carrier, then the hand-over to planeStep. Pure and DOM-free, fixed timestep.
//
// The jet lives in ship-local coordinates (carrier-spec: +Z bow, +Y up, origin at the waterline amidships) for the
// whole deck run and is placed in the world through the carrier's current pose every step, so it stays glued to a
// deck that heaves, pitches, rolls and turns. Sequence: line up (roll the last few metres onto the shuttle), spool
// (engines to full, afterburner lit), stroke (constant acceleration down the catapult track to the bow), then airborne:
// the jet keeps the carrier's plan velocity plus the launch speed, gets a slight nose-up and a short autopilot blend.
//
// Why the shuttle is not at the stern: reaching flying speed over the whole 325 m runway in 2-2.5 s means leaving at
// ~290 m/s. A 3.8 g, 2.4 s stroke (real catapults pull 3-4 g) needs ~110 m, so the shuttle sits that far from the bow.

import { BOW_Z, CENTERLINE_X, DECK_Y } from "./carrier-spec"
import { PLANE, type Plane, type Quat, type ShipPoseLike, quatAxis, quatMul, setPlaneQuat, shipQuat, shipToWorld, type Vec3, makePlane } from "./plane"
import { VEHICLES, type VehicleKind, deckCentreY } from "./vehicles"

const DEG = Math.PI / 180

export const LAUNCH = {
  /** Catapult track on the runway centreline: the shuttle's start, and where the jet leaves the deck. */
  x: CENTERLINE_X,
  /** The jet's nose wheel leaves the deck edge here (ship z): the bow minus a little for the notch. */
  endZ: BOW_Z - 1,
  /** The Hornet's stroke length (m) and time (s): the jet's deck-relative speed at the end is 2 · stroke / strokeTime
   *  (each type's own: VEHICLES[kind].stroke / strokeTime). */
  stroke: 110,
  strokeTime: 2.4,
  /** Line-up: the jet rolls this far forward onto the shuttle over `lineupTime` s. */
  lineupFrom: 16,
  lineupTime: 1.1,
  /** Engines to full before the shot (s); the afterburner lights for the last `burnLead` s. */
  spoolTime: 1,
  burnLead: 0.45,
  /** Height of the Hornet's model origin (lowest belly point) above the deck with the gear down (VEHICLES[kind].gear). */
  gear: 1.35,
  /** Nose-up kneel on the catapult (rad), and the extra nose-up and flight-path climb given at the bow. */
  kneel: 1.5 * DEG,
  noseUp: 7 * DEG,
  pathUp: 3.5 * DEG,
  /** After a crash, the player is back on deck after this long (s). */
  respawnDelay: 2.5,
} as const

export type LaunchPhase = "lineup" | "spool" | "stroke" | "airborne"

export type Launch = {
  /** The aircraft type on the catapult (its gear height and stroke). */
  kind: VehicleKind
  phase: LaunchPhase
  /** Seconds in the current phase. */
  time: number
  /** Ship-local z of the jet's centre, and its deck-relative speed (m/s). */
  z: number
  speed: number
  /** Throttle shown during the deck run (0..1), and the afterburner. */
  throttle: number
  burner: number
  /** Catapult trauma for the camera: rises through the stroke, peaks at the shot. */
  shake: number
}

/** Catapult geometry of an aircraft type: shuttle start (ship z), stroke acceleration and speed at the bow. */
export function catapult(kind: VehicleKind): { startZ: number; accel: number; speed: number } {
  const v = VEHICLES[kind]
  const accel = (2 * v.stroke) / (v.strokeTime * v.strokeTime)
  return { startZ: LAUNCH.endZ - v.stroke, accel, speed: accel * v.strokeTime }
}
/** Deck-relative speed at the bow (the Hornet's; `catapult(kind).speed` for others). */
export const LAUNCH_SPEED = catapult("hornet").speed
/** Ship-local height of the Hornet's centre on deck (`deckCentreY(kind)` for others). */
export const DECK_CENTRE_Y = DECK_Y + LAUNCH.gear + PLANE.centre

export function makeLaunch(kind: VehicleKind = "hornet"): Launch {
  return { kind, phase: "lineup", time: 0, z: catapult(kind).startZ - LAUNCH.lineupFrom, speed: 0, throttle: 0.15, burner: 0, shake: 0 }
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

/**
 * One fixed step of the takeoff on the carrier `ship` (already stepped to this tick). While on deck the jet's pose is
 * rebuilt from the ship's; at the bow it is released into free flight. Returns true on the step it leaves the deck;
 * from then on drive it with planeStep.
 */
export function launchStep(l: Launch, plane: Plane, ship: ShipLike, dt: number): boolean {
  if (l.phase === "airborne") return false
  l.time += dt
  plane.t += dt
  l.shake *= Math.exp(-dt * 3)
  const cat = catapult(l.kind)
  if (l.phase === "lineup") {
    const k = Math.min(1, l.time / LAUNCH.lineupTime)
    l.z = cat.startZ - LAUNCH.lineupFrom * (1 - k * k * (3 - 2 * k))
    l.throttle = 0.15
    if (k >= 1) next(l, "spool")
  } else if (l.phase === "spool") {
    const k = Math.min(1, l.time / LAUNCH.spoolTime)
    l.throttle = 0.15 + 0.85 * k
    l.burner = l.time > LAUNCH.spoolTime - LAUNCH.burnLead ? 1 : 0
    l.shake = Math.max(l.shake, 0.25 * k)
    if (k >= 1) next(l, "stroke")
  } else {
    l.speed += cat.accel * dt
    l.z += l.speed * dt
    l.throttle = 1
    l.burner = 1
    l.shake = Math.max(l.shake, 0.35 + 0.4 * (l.speed / cat.speed))
    if (l.z >= LAUNCH.endZ) {
      release(l, plane, ship)
      return true
    }
  }
  place(l, plane, ship, dt)
  return false
}

function next(l: Launch, phase: LaunchPhase): void {
  l.phase = phase
  l.time = 0
}

/** Leaves the bow: heading and roll of the deck, nose-up, deck plan velocity plus launch speed slightly climbing. */
function release(l: Launch, plane: Plane, ship: ShipLike): void {
  l.phase = "airborne"
  l.time = 0
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
