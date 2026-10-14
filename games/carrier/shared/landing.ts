// Carrier landing on request: near a friendly carrier the HUD offers "F LAND"; pressing it hands the jet to a short
// scripted landing that cannot fail. Pure and DOM-free, fixed timestep, deterministic.
//
// The sequence is flown in the carrier's ship-local frame (carrier-spec: +Z bow, +X port, +Y up) and placed in the world
// through the ship's live pose every step, so a moving, pitching, turning deck is matched. Far out the plan pose is used
// (position and heading: a curve hundreds of metres away must not swing with the hull's roll); over the last stretch
// before the stern it blends into the full pose, so on the deck the jet rides it exactly like the catapult run.
//
// 1. Approach: cubic Hermite curves from the jet's position and velocity to a join point JOIN m behind the touchdown
//    point on the centreline, heading up the runway. From behind, one curve; from the side or ahead, via a waypoint
//    beside the ship (on the jet's side, port when it is near the line) and a U-turn onto the line. Kept clear of the hull
//    and the sea. Then a straight 3.5° glideslope to the touchdown point, slowing to the approach speed.
// 2. Trap: the hook catches; a uniform stop over TRAP s with a camera jolt; a short hold; then the flight is over
//    (`landingStep` returns true exactly once). Every step advances the jet's clock, also after the end.
// A hard timeout puts the jet on the deck if the sequence ever overruns.

import { CENTERLINE_X, DECK_Y, STERN_Z, BOW_Z } from "./carrier-spec"
import { type Hull, deckOpen } from "./fleet"
import { LAUNCH, type ShipLike, deckVelocity } from "./launch"
import { type Plane, type Quat, type ShipPoseLike, type Vec3, planeSpeed, quatAxis, quatMul, quatRotate, quatSlerp, setPlaneQuat, shipQuat, shipToWorld } from "./plane"

const DEG = Math.PI / 180

export const LANDING = {
  // The "F LAND" prompt (your own carrier only).
  /** Plan distance from its centre (m), height above its deck (m), how far off the nose it may be (rad), and no prompt
   *  this long after a launch (s). */
  range: 1200,
  ceiling: 600,
  look: 30 * DEG,
  cooldown: 5,
  // The sequence.
  /** Touchdown point (the Hornet's centre, ship-local z), glideslope, and the join point this far behind it (m). */
  touchZ: STERN_Z + 45,
  glide: 3.5 * DEG,
  join: 450,
  /** Deck-relative speed at the join (m/s), the curves' cruise speed range, and the beside-the-ship waypoint's offset
   *  from the centreline (m, also the U-turn's width). */
  joinSpeed: 200,
  curveMin: 200,
  curveMax: 300,
  side: 380,
  /** Angle of attack on the glideslope (nose above the path), and the bank limit in the curves. */
  aoa: 7 * DEG,
  bankMax: 70 * DEG,
  /** The curves keep this far above the deck near the hull, and above the sea everywhere (m). */
  hullClear: 65,
  seaClear: 30,
  /** Arresting stop (s), the hold on deck before the flight ends (s), and the hard timeout (s). */
  trap: 1.5,
  hold: 0.8,
  timeout: 25,
} as const

/** The jet blends from where it was when F was pressed over this long (s); until then it is relayed as flying. */
export const CAPTURE_BLEND = 0.8
/** Over this many metres behind the stern the frame blends from the plan pose to the full pose. */
const FRAME_BLEND = 450

/**
 * What a vehicle brings to a landing (shared/vehicles.ts `landingVehicle`): its centre's height above the deck on its
 * gear, its stall speed, its deck-relative approach speed, and `touch`: how far forward of LANDING.touchZ its centre
 * touches down (m, negative aft), so every type's hook meets the same wires.
 */
export type LandingVehicle = { readonly rest: number; readonly stallSpeed: number; readonly approachSpeed: number; readonly touch: number }

export type LandingPhase = "approach" | "trap" | "stopped" | "done"

/** A Hermite segment in ship-local space: end points, end tangents (already scaled by the duration), duration (s). */
type Segment = { p0: Vec3; p1: Vec3; m0: Vec3; m1: Vec3; T: number; glide: boolean }

export type Landing = {
  phase: LandingPhase
  /** Seconds in the phase, and since F was pressed. */
  time: number
  since: number
  /** Ship-local position of the jet's centre and attitude: yaw (toward +X positive), pitch (nose up), bank (right wing
   *  down positive). */
  x: number
  y: number
  z: number
  yaw: number
  pitch: number
  bank: number
  /** Deck-relative speed (m/s). */
  u: number
  /** Hook and gear 0..1, the throttle shown, and camera trauma. */
  hook: number
  throttle: number
  shake: number
  /** Ship-local touchdown z and deck height of this jet's centre, and its approach speed. */
  touchZ: number
  restY: number
  vA: number
  /** The approach: Hermite segments, the one flown, time into it. */
  segs: Segment[]
  seg: number
  segT: number
  /** World offset and orientation of the jet when the landing began, faded out over CAPTURE_BLEND. */
  offX: number
  offY: number
  offZ: number
  capQ: Quat
}

const smooth = (k: number) => (k <= 0 ? 0 : k >= 1 ? 1 : k * k * (3 - 2 * k))
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
const ease = (dt: number, lag: number) => 1 - Math.exp(-dt / lag)
const wrap = (a: number) => a - Math.PI * 2 * Math.floor((a + Math.PI) / (Math.PI * 2))

// ---- frames -------------------------------------------------------------------------------------------------------------

/** Ship-local point → world through the plan pose only (heading and position; y is height above the sea). */
export function planToWorld(s: ShipPoseLike, x: number, y: number, z: number, out: Vec3 = [0, 0, 0]): Vec3 {
  const a = Math.PI - s.heading
  const c = Math.cos(a)
  const n = Math.sin(a)
  out[0] = s.x + x * c + z * n
  out[1] = y
  out[2] = s.z - x * n + z * c
  return out
}

/** World point → ship-local through the plan pose. */
export function worldToPlan(s: ShipPoseLike, x: number, y: number, z: number, out: Vec3 = [0, 0, 0]): Vec3 {
  const a = Math.PI - s.heading
  const c = Math.cos(a)
  const n = Math.sin(a)
  const dx = x - s.x
  const dz = z - s.z
  out[0] = dx * c - dz * n
  out[1] = y
  out[2] = dx * n + dz * c
  return out
}

/** World direction (x, z) → ship-local plan direction. */
function dirToPlan(s: ShipPoseLike, x: number, z: number, out: Vec3): Vec3 {
  const a = Math.PI - s.heading
  const c = Math.cos(a)
  const n = Math.sin(a)
  out[0] = x * c - z * n
  out[2] = x * n + z * c
  return out
}

/** Full-pose weight at ship-local z: 0 far behind the stern, 1 over the deck, 0 again well ahead of the bow (a curve
 *  starting there must not swing with the hull's pitch). */
export const frameWeight = (z: number) => smooth(1 - (STERN_Z - z) / FRAME_BLEND) * smooth(1 - (z - BOW_Z) / 150)

const p0: Vec3 = [0, 0, 0]
const p1: Vec3 = [0, 0, 0]
const v3: Vec3 = [0, 0, 0]
const qa: Quat = [0, 0, 0, 1]
const qb: Quat = [0, 0, 0, 1]
const qc: Quat = [0, 0, 0, 1]
const ql: Quat = [0, 0, 0, 1]
const qt: Quat = [0, 0, 0, 1]

function localQuat(yaw: number, pitch: number, bank: number, out: Quat): Quat {
  quatMul(quatAxis(0, 1, 0, yaw, qa), quatAxis(1, 0, 0, -pitch, qb), out)
  return quatMul(out, quatAxis(0, 0, 1, bank, qa), out)
}

/**
 * Places a jet at ship-local (x, y, z) with ship-local attitude on `ship`, blending plan → full pose near the runway.
 * Shared by the pilot's own landing, other clients drawing it and the room (relayed ship-local poses).
 */
export function placeLocal(ship: ShipPoseLike, x: number, y: number, z: number, yaw: number, pitch: number, bank: number, out: Plane): Plane {
  // Full pose only over (or just behind) the runway: out to the side, a lever arm of hundreds of metres would swing
  // the jet with the hull's roll.
  const w = frameWeight(z) * smooth(1 - (Math.abs(x - CENTERLINE_X) - 40) / 160)
  planToWorld(ship, x, y, z, p0)
  shipToWorld(ship, x, y, z, p1)
  out.x = p0[0] + (p1[0] - p0[0]) * w
  out.y = p0[1] + (p1[1] - p0[1]) * w
  out.z = p0[2] + (p1[2] - p0[2]) * w
  localQuat(yaw, pitch, bank, ql)
  const plan = quatMul(quatAxis(0, 1, 0, Math.PI - ship.heading, qc), ql, qt)
  const full = quatMul(shipQuat(ship, qc), ql, qb)
  setPlaneQuat(out, quatSlerp(plan, full, w, qc))
  return out
}

/** Places the jet for landing state `l` on `ship` (with the blend from where it was when the landing began). */
export function landingPose(l: Landing, ship: ShipPoseLike, out: Plane): Plane {
  placeLocal(ship, l.x, l.y, l.z, l.yaw, l.pitch, l.bank, out)
  const k = smooth(l.since / CAPTURE_BLEND)
  if (k < 1) {
    out.x += l.offX * (1 - k)
    out.y += l.offY * (1 - k)
    out.z += l.offZ * (1 - k)
    qa[0] = out.qx
    qa[1] = out.qy
    qa[2] = out.qz
    qa[3] = out.qw
    setPlaneQuat(out, quatSlerp(l.capQ, qa, k, qb))
  }
  return out
}

// ---- the prompt ---------------------------------------------------------------------------------------------------------

/** A carrier the jet might land on: its pose, crew ship id and team. */
export type LandingShip = ShipLike & { id: number; team: number }

const nose: Vec3 = [0, 0, 0]

/**
 * Whether the "F LAND" prompt offers `ship` (your own carrier): its deck open (no deck fire, not sinking: `hull`), within
 * LANDING.range in plan, the jet below LANDING.ceiling above the deck and pointing at it (nose within LANDING.look of the
 * line to the ship), flying above stall, at least LANDING.cooldown s after its launch (`airborne`).
 */
export function landTarget<S extends ShipLike>(plane: Plane, airborne: number, ship: S | undefined, hull: Pick<Hull, "deckFire" | "sinkAt"> | undefined, t: number, vehicle: LandingVehicle): S | null {
  if (!ship || plane.crashed || airborne < LANDING.cooldown || !deckOpen(hull, t)) return null
  if (planeSpeed(plane) < vehicle.stallSpeed || plane.stall > 0.5) return null
  const dx = ship.x - plane.x
  const dy = ship.heave + DECK_Y - plane.y
  const dz = ship.z - plane.z
  if (Math.hypot(dx, dz) > LANDING.range || -dy > LANDING.ceiling) return null
  quatRotate(plane.qx, plane.qy, plane.qz, plane.qw, 0, 0, 1, nose)
  return (nose[0] * dx + nose[1] * dy + nose[2] * dz) / Math.hypot(dx, dy, dz) >= Math.cos(LANDING.look) ? ship : null
}

// ---- the sequence -------------------------------------------------------------------------------------------------------

const H = (k: number): [number, number, number, number] => {
  const k2 = k * k
  const k3 = k2 * k
  return [2 * k3 - 3 * k2 + 1, k3 - 2 * k2 + k, -2 * k3 + 3 * k2, k3 - k2]
}
const dH = (k: number): [number, number, number, number] => [6 * k * k - 6 * k, 3 * k * k - 4 * k + 1, -6 * k * k + 6 * k, 3 * k * k - 2 * k]
const ddH = (k: number): [number, number, number, number] => [12 * k - 6, 6 * k - 4, -12 * k + 6, 6 * k - 2]

function hermite(s: Segment, k: number, basis: (k: number) => [number, number, number, number], out: Vec3): Vec3 {
  const [a, b, c, d] = basis(k)
  for (let i = 0; i < 3; i++) out[i] = a * s.p0[i]! + b * s.m0[i]! + c * s.p1[i]! + d * s.m1[i]!
  return out
}

/** A segment from p0 (velocity v0) to p1 (velocity v1), timed so the average speed fits the curves' speed range and
 *  any height change is gentle. */
function segment(a: Vec3, v0: Vec3, b: Vec3, v1: Vec3, glide = false): Segment {
  const s: Segment = { p0: [...a], p1: [...b], m0: [0, 0, 0], m1: [0, 0, 0], T: 1, glide }
  const chord = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
  let T = Math.max(1.5, chord / LANDING.curveMax)
  // Leaving against the chord, a full-length start tangent would throw a wide, fast loop: shorten it.
  const c0 = (v0[0] * (b[0] - a[0]) + v0[1] * (b[1] - a[1]) + v0[2] * (b[2] - a[2])) / Math.max(1e-6, Math.hypot(v0[0], v0[1], v0[2]) * chord)
  const f0 = clamp(0.55 + 0.45 * c0, 0.2, 1)
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 3; j++) {
      s.m0[j] = v0[j]! * T * f0
      s.m1[j] = v1[j]! * T
    }
    s.T = T
    let len = 0
    let prev = hermite(s, 0, H, [0, 0, 0])
    for (let n = 1; n <= 24; n++) {
      const q = hermite(s, n / 24, H, [0, 0, 0])
      len += Math.hypot(q[0] - prev[0], q[1] - prev[1], q[2] - prev[2])
      prev = q
    }
    const v = clamp(len / 3, LANDING.curveMin, LANDING.curveMax)
    T = clamp(len / v, 1.2, 10.5)
  }
  // Mismatched end tangents can bulge the speed mid-curve: stretch the time until the peak is within the limit.
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 3; j++) {
      s.m0[j] = v0[j]! * T * f0
      s.m1[j] = v1[j]! * T
    }
    s.T = T
    let peak = 0
    for (let n = 0; n <= 24; n++) {
      const d = hermite(s, n / 24, dH, [0, 0, 0])
      peak = Math.max(peak, Math.hypot(d[0], d[1], d[2]) / T)
    }
    if (peak <= LANDING.curveMax * 1.1 || T >= 10.5) break
    T = Math.min(10.5, T * Math.min(1.5, peak / LANDING.curveMax))
  }
  return s
}

/** The approach from ship-local position `at` and velocity `vel`: curves to the join point, then the glideslope. */
function approachPath(at: Vec3, vel: Vec3, touchZ: number, restY: number, vA: number): Segment[] {
  const tg = Math.tan(LANDING.glide)
  const zJ = touchZ - LANDING.join
  const vJ = LANDING.joinSpeed
  const J: Vec3 = [CENTERLINE_X, restY + LANDING.join * tg, zJ]
  const VJ: Vec3 = [0, -vJ * tg, vJ]
  // A gentle start: at least a modest speed, at most the curves' top speed, the jet's own direction.
  const sp = Math.hypot(vel[0], vel[1], vel[2])
  const k = sp > 1 ? clamp(sp, 120, LANDING.curveMax) / sp : 0
  const V0: Vec3 = sp > 1 ? [vel[0] * k, clamp(vel[1] * k, -60, 40), vel[2] * k] : [0, 0, 120]
  const segs: Segment[] = []
  if (at[2] < zJ - 200 && V0[2] > 0) segs.push(segment(at, V0, J, VJ))
  else {
    // Beside the ship on the jet's side (port when near the line: the island is to starboard), heading aft, abeam the
    // join point; then a U-turn onto the line.
    const side = Math.abs(at[0] - CENTERLINE_X) < 120 ? 1 : Math.sign(at[0] - CENTERLINE_X)
    const W: Vec3 = [CENTERLINE_X + side * LANDING.side, J[1] + 40, zJ + 250]
    const VW: Vec3 = [0, -8, -vJ]
    segs.push(segment(at, V0, W, VW))
    segs.push(segment(W, VW, J, VJ))
  }
  // The glideslope: straight down the centreline, slowing from the join speed to the approach speed.
  const T: Vec3 = [CENTERLINE_X, restY, touchZ]
  const Tf = (2 * LANDING.join) / (vJ + vA)
  segs.push({ p0: J, p1: T, m0: [0, -vJ * tg * Tf, vJ * Tf], m1: [0, -vA * tg * Tf, vA * Tf], T: Tf, glide: true })
  return segs
}

/** Clearance floor of the curves at ship-local (x, z): above the hull (with a margin round it) and above the sea. */
function floorAt(x: number, z: number): number {
  const dx = Math.max(0, Math.abs(x) - 45)
  const dz = Math.max(0, STERN_Z - z, z - BOW_Z)
  const near = smooth(1 - Math.hypot(dx, dz) / 220)
  return Math.max(LANDING.seaClear, DECK_Y + LANDING.hullClear * near)
}

const pos: Vec3 = [0, 0, 0]
const vel: Vec3 = [0, 0, 0]
const acc: Vec3 = [0, 0, 0]

/** Writes the approach's position and attitude at the current segment time into `l`. */
function flyApproach(l: Landing, dt: number): void {
  const s = l.segs[l.seg]!
  const k = clamp(l.segT / s.T, 0, 1)
  hermite(s, k, H, pos)
  hermite(s, k, dH, vel)
  hermite(s, k, ddH, acc)
  for (let i = 0; i < 3; i++) {
    vel[i] = vel[i]! / s.T
    acc[i] = acc[i]! / (s.T * s.T)
  }
  l.x = pos[0]
  l.z = pos[2]
  if (s.glide) {
    // Exactly on the glideslope, on the centreline.
    l.x = CENTERLINE_X
    l.y = l.restY + Math.max(0, l.touchZ - l.z) * Math.tan(LANDING.glide)
  } else l.y = Math.max(pos[1], floorAt(pos[0], pos[2]))
  const vh = Math.hypot(vel[0], vel[2])
  l.u = Math.hypot(vh, vel[1])
  if (vh > 1) {
    const yaw = Math.atan2(vel[0], vel[2])
    const omega = (vel[2] * acc[0] - vel[0] * acc[2]) / (vh * vh)
    const bank = s.glide ? 0 : clamp(-Math.atan((vh * omega) / 9.81), -LANDING.bankMax, LANDING.bankMax)
    const pitch = Math.atan2(vel[1], vh) + (s.glide ? LANDING.aoa : LANDING.aoa * 0.4)
    // Eased, so the joins between segments never snap.
    l.yaw = wrap(l.yaw + wrap(yaw - l.yaw) * ease(dt, 0.12))
    l.pitch += (pitch - l.pitch) * ease(dt, 0.2)
    l.bank += (bank - l.bank) * ease(dt, 0.25)
  }
  l.throttle += ((s.glide ? 0.62 : 0.75) - l.throttle) * ease(dt, 0.8)
}

/**
 * Takes the jet over to land on `ship` from wherever it is (the player pressed F at the prompt). The sequence starts
 * exactly where the jet is and blends its attitude in, so nothing jumps.
 */
export function startLanding(plane: Plane, ship: ShipLike, vehicle: LandingVehicle): Landing {
  const at = worldToPlan(ship, plane.x, plane.y, plane.z, [0, 0, 0])
  const d = deckVelocity(ship, at[0], at[2], v3)
  const rel = dirToPlan(ship, plane.vx - d[0], plane.vz - d[2], [0, 0, 0])
  rel[1] = plane.vy
  const touchZ = LANDING.touchZ + vehicle.touch
  const restY = DECK_Y + vehicle.rest
  const l: Landing = {
    phase: "approach",
    time: 0,
    since: 0,
    x: at[0],
    y: at[1],
    z: at[2],
    yaw: Math.atan2(rel[0], rel[2]),
    pitch: Math.atan2(rel[1], Math.hypot(rel[0], rel[2])),
    bank: 0,
    u: Math.hypot(rel[0], rel[1], rel[2]),
    hook: 0,
    throttle: plane.throttle,
    shake: 0,
    touchZ,
    restY,
    vA: vehicle.approachSpeed,
    segs: approachPath(at, rel, touchZ, restY, vehicle.approachSpeed),
    seg: 0,
    segT: 0,
    offX: 0,
    offY: 0,
    offZ: 0,
    capQ: [plane.qx, plane.qy, plane.qz, plane.qw],
  }
  flyApproach(l, 1)
  // Where the jet really is, minus where the sequence puts it (the path starts from its plan-frame position; near the
  // hull the full frame adds heave, pitch and roll): faded out over the capture blend.
  const probe = placeLocal(ship, l.x, l.y, l.z, l.yaw, l.pitch, l.bank, { ...plane })
  l.offX = plane.x - probe.x
  l.offY = plane.y - probe.y
  l.offZ = plane.z - probe.z
  return l
}

/** Seconds the approach takes (curves and glideslope), for scripts and tests. */
export const approachTime = (l: Landing): number => l.segs.reduce((t, s) => t + s.T, 0)

/** Where the jet comes to a stop (ship-local z). */
const stopZ = (l: Landing): number => l.touchZ + (l.vA * LANDING.trap) / 2

/**
 * One fixed step of the landing on `ship` (already stepped to this tick): advances the ship-local state and places the
 * jet in the world (position, orientation, finite-difference velocity). Always advances the jet's clock. Returns true
 * exactly once: on the step the flight is over (stopped on deck and held).
 */
export function landingStep(l: Landing, plane: Plane, ship: ShipLike, dt: number): boolean {
  l.time += dt
  l.since += dt
  plane.t += dt
  l.shake *= Math.exp(-dt * 3)
  l.hook = Math.min(1, l.hook + dt)
  let landed = false
  // The hard timeout: whatever happened, the jet ends up stopped on the deck.
  if (l.since >= LANDING.timeout && (l.phase === "approach" || l.phase === "trap")) {
    l.phase = "stopped"
    l.time = 0
    l.x = CENTERLINE_X
    l.y = l.restY
    l.z = stopZ(l)
    l.u = 0
  }
  if (l.phase === "approach") {
    l.segT += dt
    while (l.seg < l.segs.length - 1 && l.segT >= l.segs[l.seg]!.T) {
      l.segT -= l.segs[l.seg]!.T
      l.seg++
    }
    flyApproach(l, dt)
    if (l.seg === l.segs.length - 1 && l.segT >= l.segs[l.seg]!.T) {
      l.phase = "trap"
      l.time = 0
      l.x = CENTERLINE_X
      l.y = l.restY
      l.z = l.touchZ
      l.u = l.vA
      l.shake = 0.75
    }
  } else if (l.phase === "trap") {
    const k = Math.min(1, l.time / LANDING.trap)
    l.z = l.touchZ + l.vA * LANDING.trap * (k - (k * k) / 2)
    l.u = l.vA * (1 - k)
    l.x = CENTERLINE_X
    l.y = l.restY
    l.yaw += (0 - l.yaw) * ease(dt, 0.2)
    l.pitch += (LAUNCH.kneel - l.pitch) * ease(dt, 0.2)
    l.bank += (0 - l.bank) * ease(dt, 0.15)
    l.throttle += (0.15 - l.throttle) * ease(dt, 0.4)
    if (k >= 1) {
      l.phase = "stopped"
      l.time = 0
    }
  } else {
    l.yaw += (0 - l.yaw) * ease(dt, 0.2)
    l.pitch += (LAUNCH.kneel - l.pitch) * ease(dt, 0.2)
    l.bank = 0
    l.throttle += (0.15 - l.throttle) * ease(dt, 0.4)
    if (l.phase === "stopped" && l.time >= LANDING.hold) {
      l.phase = "done"
      landed = true
    }
  }
  const ox = plane.x
  const oy = plane.y
  const oz = plane.z
  landingPose(l, ship, plane)
  plane.vx = (plane.x - ox) / dt
  plane.vy = (plane.y - oy) / dt
  plane.vz = (plane.z - oz) / dt
  plane.throttle = l.throttle
  plane.boosting = 0
  plane.p = plane.r = plane.w = 0
  plane.stall = 0
  plane.g = 1
  return landed
}
