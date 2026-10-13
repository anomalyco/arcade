// Automatic carrier landing: head toward your own carrier anywhere near it and an autopilot takes the jet. From behind,
// lined up, it flies straight down the glideslope; from the side or the front it first flies a pattern (out to a lane
// beside the ship, aft along it, a U-turn onto the centreline behind the stern), then the glideslope. The hook traps the
// jet and it stops on the deck. Pure and DOM-free, fixed timestep,
// deterministic, and ship-relative like the catapult (shared/launch.ts).
//
// The approach is flown in ship-local coordinates (carrier-spec: +Z bow, +X port, +Y up) and placed in the world
// through the carrier's pose every step. Far out that pose is the ship's plan pose only (position and heading: a 2 km
// approach must not swing with the hull's pitch); over the last FRAME_BLEND metres before the stern it blends into the full pose (heave,
// pitch, roll), so on touchdown the jet sits on the deck exactly as the catapult run does. The capture itself blends
// the jet from where it was over CAPTURE_BLEND seconds, so nothing snaps.

import { CENTERLINE_X, DECK_Y, STERN_Z, BOW_Z } from "./carrier-spec"
import { DECK_CENTRE_Y, LAUNCH, type ShipLike, deckVelocity } from "./launch"
import { PLANE, type Plane, type Quat, type ShipPoseLike, type Vec3, bodyToWorld, planeAttitude, planeSpeed, quatAxis, quatMul, quatSlerp, setPlaneQuat, shipQuat, shipToWorld, worldToShip } from "./plane"

const DEG = Math.PI / 180

export const LANDING = {
  // Capture window, ship-local (plan frame). Generous: anywhere roughly behind the ship and pointed at it. Close in,
  // the lateral, height and speed limits narrow to a funnel the autopilot can still fly out with its acceleration
  // limits (see `lateralLimit`, `ceilingLimit`, `closingLimit`), so a capture is always landable.
  /** Up to this far behind the stern (m), and at least `minBehind` behind it. */
  behind: 4000,
  minBehind: 15,
  /** Lateral offset from the runway centreline (m): at most `lateral` (and the funnel close in). */
  lateral: 400,
  /** Nose within this angle of the ship's heading (narrowing close in: `headingMin` + `headingSlope` per metre behind). */
  heading: 50 * DEG,
  headingMin: 15 * DEG,
  headingSlope: 0.06 * DEG,
  /** Height above the flight deck (m): at most `ceiling` (and the funnel close in); at least `floor` metres over the
   *  sea. */
  ceiling: 600,
  floor: 8,
  /** Bank and pitch limits for a capture. */
  bank: 60 * DEG,
  pitch: 35 * DEG,
  /** Airspeed above stall by this factor, and closing on the ship at least this fast (m/s). */
  stallMargin: 1.1,
  closing: 5,
  /** Wave-off: a stick deflection beyond this (pitch or roll), or the afterburner. Throttle alone never aborts. */
  waveOffStick: 0.8,

  // The wide window: near the ship from any direction, heading roughly at it. The autopilot flies a pattern from there.
  /** Plan distance from the ship's centre (m), height above the deck (m), nose within this of the bearing to the ship,
   *  and attitude limits. */
  near: 3000,
  nearCeiling: 800,
  nearHeading: 70 * DEG,
  nearBank: 70 * DEG,
  nearPitch: 45 * DEG,

  // The pattern (ship-local, plan frame).
  /** Deck-relative speed flown in the pattern (m/s). */
  patternSpeed: 240,
  /** The downwind lane's distance from the runway centreline (m): also the U-turn's diameter. */
  lane: 600,
  /** The pattern joins the centreline this far behind the stern (m), then hands over to the glideslope approach. */
  entry: 450,
  /** Turn rate limit (rad/s), pursuit look-ahead (m), visual bank limit, and the lowest height above the deck. */
  turnRate: 0.72,
  /** Speed held through the turns (m/s): the pattern slows for them so they stay tight. */
  turnSpeed: 180,
  lookahead: 240,
  patternBank: 72 * DEG,
  patternFloor: 60,
  /** No capture for this long after a launch or a wave-off (s). */
  cooldown: 5,

  // Approach.
  /** Touchdown point: the jet's centre this far forward of the stern, on the centreline. */
  touchZ: STERN_Z + 45,
  /** Glideslope angle. */
  glide: 3.5 * DEG,
  /** Deck-relative approach speed (m/s), normal deceleration toward it, and the most it may brake when captured fast. */
  approachSpeed: 70,
  decel: 14,
  maxDecel: 30,
  /** Slowest deck-relative closing speed (m/s) the approach slows to when it needs time for a big correction. */
  minSpeed: 45,
  accel: 14,
  /** Angle of attack held on the approach (nose above the flight path). */
  aoa: 8 * DEG,
  /** Lateral and vertical corrections settle in a third of the time to go, within these bounds (s). */
  settleMin: 0.5,
  settleMax: 7,
  /** Lateral and vertical acceleration limits of the corrections (m/s²): an S-turn onto the centreline, not a snap. */
  latAccel: 12,
  vertAccel: 8,
  /** Lateral speed (m/s) kept at capture: a jet pointed 50° off the runway is turned in during the capture blend. */
  captureVx: 25,
  /** Bank per m/s² of lateral acceleration, and its limit. */
  bankPer: 0.06,
  bankMax: 35 * DEG,

  // Trap.
  /** Arresting deceleration (m/s², ~3.6 g: 70 m/s stops in ~2 s); stronger if needed to stop clear of the bow. */
  trapDecel: 35,
  bowMargin: 40,
  /** Stopped this long before the flight ends (s). */
  hold: 1,
} as const

/** Over this many metres behind the stern the frame blends from the ship's plan pose to its full pose. */
const FRAME_BLEND = 450
/** The jet blends from where it was captured over this long (s). */
const CAPTURE_BLEND = 1.2

/**
 * What a vehicle brings to a landing (pass your own; the Hornet's is the default): the height of its centre above the
 * deck when resting on its gear, its stall speed, its approach speed relative to the deck, and optionally `touch`: how
 * far forward of LANDING.touchZ its centre touches down (m, negative aft), so a jet whose hook trails its centre by a
 * different distance than the Hornet's still puts the hook on the same wires.
 */
export type LandingVehicle = { rest: number; stallSpeed: number; approachSpeed: number; touch?: number }
export const HORNET_LANDING: LandingVehicle = { rest: DECK_CENTRE_Y - DECK_Y, stallSpeed: PLANE.stallSpeed, approachSpeed: LANDING.approachSpeed }

export type LandingPhase = "pattern" | "approach" | "trap" | "stopped" | "done"

export type Landing = {
  phase: LandingPhase
  /** Seconds in the phase, and since capture. */
  time: number
  since: number
  /** Ship-local position of the jet's centre, and its deck-relative rates (m/s). */
  x: number
  y: number
  z: number
  u: number
  vx: number
  vy: number
  /** Ship-local attitude: yaw (toward +X positive), pitch (nose up positive), bank (right wing down positive). */
  yaw: number
  pitch: number
  bank: number
  /** Hook and gear 0..1, the throttle shown, and camera trauma. */
  hook: number
  throttle: number
  shake: number
  /** Ship-local height of the jet's centre on the deck (DECK_Y + vehicle rest height), and its approach speed. */
  restY: number
  vA: number
  /** Ship-local z where this jet's centre touches down (LANDING.touchZ plus the vehicle's `touch`). */
  touchZ: number
  /** The pattern: its ship-local plan path [x, z] (ending at the touchdown point), cumulative lengths, progress along
   *  it (m), where it joins the approach (arc length), speed and course (local yaw), and the most it climbs to. Null
   *  path for a straight-in approach. */
  path: [number, number][] | null
  lens: number[]
  s: number
  join: number
  V: number
  psi: number
  yTop: number
  /** World offset and orientation of the jet at capture, faded out over CAPTURE_BLEND. */
  offX: number
  offY: number
  offZ: number
  capQ: Quat
}

const smooth = (k: number) => (k <= 0 ? 0 : k >= 1 ? 1 : k * k * (3 - 2 * k))
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
const ease = (dt: number, lag: number) => 1 - Math.exp(-dt / lag)

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

/** World direction → ship-local (plan frame). */
function dirToPlan(s: ShipPoseLike, x: number, z: number, out: Vec3): Vec3 {
  const a = Math.PI - s.heading
  const c = Math.cos(a)
  const n = Math.sin(a)
  out[0] = x * c - z * n
  out[2] = x * n + z * c
  return out
}

/** Full-pose weight at ship-local z: 0 far behind the stern, 1 from the stern on (so over the deck the jet rides the
 *  hull exactly). */
export const frameWeight = (z: number) => smooth(1 - (STERN_Z - z) / FRAME_BLEND)

const p0: Vec3 = [0, 0, 0]
const p1: Vec3 = [0, 0, 0]
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
 * Places a jet at ship-local (x, y, z) with ship-local attitude on `ship`, blending plan → full pose by z. Shared by the
 * pilot's own landing and by other clients drawing it (they pass the relayed local pose, no capture offset).
 */
export function placeLocal(ship: ShipPoseLike, x: number, y: number, z: number, yaw: number, pitch: number, bank: number, out: Plane): Plane {
  // Full pose only over (or just behind) the runway: out in the pattern, a lever arm of hundreds of metres would
  // swing the jet with the hull's roll.
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

/** Places the jet for landing state `l` on `ship` (with the capture blend). */
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

// ---- capture ------------------------------------------------------------------------------------------------------------

const att = { heading: 0, pitch: 0, bank: 0 }
const v3: Vec3 = [0, 0, 0]
const dv: Vec3 = [0, 0, 0]

/** The window's lateral and height limits (m) at `behind` metres behind the stern. */
/** The largest error the approach can close in distance d (m to touchdown) at the slowest speed, with acceleration a
 *  (a third of it, for margin: the jet may first have to brake): a bang-bang manoeuvre takes 2 √(e / a). */
const correctable = (d: number, a: number) => 0.32 * a * (d / (2 * LANDING.minSpeed)) ** 2
export const lateralLimit = (behind: number) => Math.min(LANDING.lateral, 6 + correctable(Math.max(0, behind) + LANDING.touchZ - STERN_Z, LANDING.latAccel))
export const ceilingLimit = (behind: number) => {
  const d = Math.max(0, behind) + LANDING.touchZ - STERN_Z
  return Math.min(LANDING.ceiling, d * Math.tan(LANDING.glide) + 6 + correctable(d, LANDING.vertAccel))
}
/** The window's heading limit (rad) at `behind` metres behind the stern. */
export const headingLimit = (behind: number) => Math.min(LANDING.heading, LANDING.headingMin + LANDING.headingSlope * Math.max(0, behind))

/** The fastest closing speed (m/s) that can still brake to the approach speed by touchdown. */
export const closingLimit = (behind: number, vA: number = LANDING.approachSpeed) => Math.sqrt(vA * vA + LANDING.maxDecel * (Math.max(0, behind) + LANDING.touchZ - STERN_Z))

/** Why a jet is (not) in the straight-in window behind `ship` (lined up, glideslope from here): "" when it is. */
export function directMiss(plane: Plane, ship: ShipLike, vehicle: LandingVehicle = HORNET_LANDING): string {
  if (plane.crashed) return "crashed"
  const l = worldToPlan(ship, plane.x, plane.y, plane.z, p0)
  const behind = STERN_Z - l[2]
  if (behind < LANDING.minBehind || behind > LANDING.behind) return "range"
  if (Math.abs(l[0] - CENTERLINE_X) > lateralLimit(behind)) return "lateral"
  const h = l[1] - DECK_Y
  if (h > ceilingLimit(behind) || l[1] < LANDING.floor) return "height"
  // Close in, the jet must be clear above the real (heaving, pitching) deck height at the stern.
  if (behind < 500 && worldToShip(ship, plane.x, plane.y, plane.z, p1)[1] < DECK_Y + 3) return "low"
  const f = bodyToWorld(plane, 0, 0, 1, v3)
  const fl = dirToPlan(ship, f[0], f[2], dv)
  if (Math.abs(Math.atan2(fl[0], fl[2])) > headingLimit(behind)) return "heading"
  planeAttitude(plane, att)
  if (Math.abs(att.bank) > LANDING.bank || Math.abs(att.pitch) > LANDING.pitch) return "attitude"
  if (planeSpeed(plane) < vehicle.stallSpeed * LANDING.stallMargin) return "slow"
  const d = deckVelocity(ship, l[0], l[2], v3)
  const rel = dirToPlan(ship, plane.vx - d[0], plane.vz - d[2], dv)
  if (rel[2] < LANDING.closing) return "closing"
  if (rel[2] > closingLimit(behind, vehicle.approachSpeed)) return "fast"
  return ""
}

/**
 * Why a jet is (not) captured for landing on `ship`: "" when it is. Either the straight-in window behind the stern, or
 * the wide one: within LANDING.near of the ship from any direction, heading roughly at it, not too high, wings not past
 * 70°, above stall.
 */
export function captureMiss(plane: Plane, ship: ShipLike, vehicle: LandingVehicle = HORNET_LANDING): string {
  if (plane.crashed) return "crashed"
  if (!directMiss(plane, ship, vehicle)) return ""
  const dx = ship.x - plane.x
  const dz = ship.z - plane.z
  const dist = Math.hypot(dx, dz)
  if (dist > LANDING.near) return "range"
  const l = worldToPlan(ship, plane.x, plane.y, plane.z, p0)
  if (l[1] - DECK_Y > LANDING.nearCeiling || l[1] < LANDING.floor) return "height"
  // Right at the hull and below the flight deck: too late to fly a pattern (the jet would go through the ship).
  if (dist < 700 && l[1] < DECK_Y + 25) return "low"
  const f = bodyToWorld(plane, 0, 0, 1, v3)
  const fh = Math.hypot(f[0], f[2])
  if (dist > 1 && fh > 1e-3) {
    const c = (f[0] * dx + f[2] * dz) / (fh * dist)
    if (Math.acos(clamp(c, -1, 1)) > LANDING.nearHeading) return "heading"
  }
  planeAttitude(plane, att)
  if (Math.abs(att.bank) > LANDING.nearBank || Math.abs(att.pitch) > LANDING.nearPitch) return "attitude"
  if (planeSpeed(plane) < vehicle.stallSpeed * LANDING.stallMargin) return "slow"
  return ""
}

/**
 * The pattern from ship-local (x0, z0) to the touchdown point, as a plan polyline: a 45° intercept onto the centreline
 * when there is room behind the stern; otherwise out to the lane on the jet's side (port when it is near the line),
 * aft along it, a U-turn onto the centreline, and down it.
 */
export function patternPath(x0: number, z0: number, touchZ: number = LANDING.touchZ): { path: [number, number][]; join: number } {
  const CL = CENTERLINE_X
  const zE = STERN_Z - LANDING.entry
  const dx = Math.abs(x0 - CL)
  const pts: [number, number][] = [[x0, z0]]
  // Room to turn in onto the line before the join: a 45° intercept.
  if (z0 + dx <= zE - 500) {
    pts.push([CL, z0 + dx])
  } else {
    // Out to the lane on the jet's side, aft along it, and a U-turn (the base turn) that ends on the centreline at the
    // join: no long straight final first, the approach takes over from the end of the turn.
    const s = dx < 150 ? 1 : Math.sign(x0 - CL)
    const X = CL + s * LANDING.lane
    const r = LANDING.lane / 2
    let zB = zE
    if (z0 > zB + 300) pts.push([X, clamp(z0 - 250, zB + 150, BOW_Z + 1200)])
    else zB = Math.min(zB, z0 - 550)
    for (let i = 0; i <= 8; i++) {
      const a = (i / 8) * Math.PI
      pts.push([CL + s * r * (1 + Math.cos(a)), zB - r * Math.sin(a)])
    }
  }
  pts.push([CL, zE])
  const joinIndex = pts.length - 1
  pts.push([CL, touchZ])
  let len = 0
  let join = 0
  for (let i = 1; i < pts.length; i++) {
    len += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1])
    if (i === joinIndex) join = len
  }
  return { path: pts, join }
}

const cumulative = (pts: [number, number][]): number[] => {
  const out = [0]
  for (let i = 1; i < pts.length; i++) out.push(out[i - 1]! + Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]))
  return out
}

/** The point at arc length s along a polyline. */
function along(pts: [number, number][], lens: number[], s: number, out: [number, number]): [number, number] {
  let i = 1
  while (i < pts.length - 1 && lens[i]! < s) i++
  const a = pts[i - 1]!
  const b = pts[i]!
  const k = clamp((s - lens[i - 1]!) / Math.max(1e-6, lens[i]! - lens[i - 1]!), 0, 1)
  out[0] = a[0] + (b[0] - a[0]) * k
  out[1] = a[1] + (b[1] - a[1]) * k
  return out
}

/** Arc length of the point on the polyline closest to (x, z), searching forward from `from` (never backward). */
function progress(pts: [number, number][], lens: number[], from: number, x: number, z: number): number {
  let best = from
  let bd = Infinity
  for (let i = 1; i < pts.length; i++) {
    if (lens[i]! < from) continue
    const a = pts[i - 1]!
    const b = pts[i]!
    const ux = b[0] - a[0]
    const uz = b[1] - a[1]
    const l2 = ux * ux + uz * uz || 1
    const k = clamp(((x - a[0]) * ux + (z - a[1]) * uz) / l2, 0, 1)
    const d = Math.hypot(a[0] + ux * k - x, a[1] + uz * k - z)
    const s = Math.max(from, lens[i - 1]! + k * Math.sqrt(l2))
    if (d < bd - 1e-9) {
      bd = d
      best = s
    }
    // Only look a little way ahead: the U-turn passes close to earlier legs.
    if (lens[i - 1]! > from + 600) break
  }
  return best
}

/** Takes the jet over for landing on `ship` from wherever it is now. */
export function startLanding(plane: Plane, ship: ShipLike, vehicle: LandingVehicle = HORNET_LANDING): Landing {
  const l = worldToPlan(ship, plane.x, plane.y, plane.z, [0, 0, 0])
  // Ship-local coordinates that the blended landing frame maps back onto the jet: a few fixed-point corrections from
  // the plan-frame guess (the frames differ only by the hull's heave, pitch and roll).
  const probe = { ...plane }
  for (let i = 0; i < 4; i++) {
    placeLocal(ship, l[0], l[1], l[2], 0, 0, 0, probe)
    const e = dirToPlan(ship, plane.x - probe.x, plane.z - probe.z, dv)
    l[0] += e[0]
    l[1] += plane.y - probe.y
    l[2] += e[2]
  }
  const d = deckVelocity(ship, l[0], l[2], v3)
  const rel = dirToPlan(ship, plane.vx - d[0], plane.vz - d[2], [0, 0, 0])
  const u = Math.max(LANDING.closing, rel[2])
  // Lateral speed kept: less close in, where there is no room to turn it back.
  const touchZ = LANDING.touchZ + (vehicle.touch ?? 0)
  const vxMax = Math.min(LANDING.captureVx, 0.08 * (touchZ - l[2]))
  const vx = clamp(rel[0], -vxMax, vxMax)
  const vy = clamp(plane.vy, -20, 15)
  planeAttitude(plane, att)
  const direct = !directMiss(plane, ship, vehicle)
  const pat = direct ? null : patternPath(l[0], l[2], touchZ)
  const V = clamp(Math.hypot(rel[0], rel[2]), 40, 260)
  const psi = Math.atan2(rel[0], rel[2])
  const landing: Landing = {
    phase: direct ? "approach" : "pattern",
    path: pat?.path ?? null,
    lens: pat ? cumulative(pat.path) : [],
    s: 0,
    join: pat?.join ?? 0,
    V,
    psi,
    yTop: Math.max(l[1], DECK_Y + vehicle.rest + 150),
    time: 0,
    since: 0,
    x: l[0],
    y: l[1],
    z: l[2],
    u,
    vx,
    vy,
    yaw: direct ? Math.atan2(vx, u) : psi,
    pitch: (direct ? Math.atan2(vy, u) : Math.atan2(vy, V)) + LANDING.aoa,
    bank: 0,
    hook: 0,
    restY: DECK_Y + vehicle.rest,
    vA: vehicle.approachSpeed,
    touchZ,
    throttle: plane.throttle,
    shake: 0,
    offX: 0,
    offY: 0,
    offZ: 0,
    capQ: [plane.qx, plane.qy, plane.qz, plane.qw],
  }
  // Where the jet really is, minus where the landing frame puts it: faded out over the capture blend.
  const at = placeLocal(ship, landing.x, landing.y, landing.z, landing.yaw, landing.pitch, landing.bank, probe)
  landing.offX = plane.x - at.x
  landing.offY = plane.y - at.y
  landing.offZ = plane.z - at.z
  return landing
}

// ---- step ---------------------------------------------------------------------------------------------------------------

const glideY = (restY: number, z: number, touchZ: number = LANDING.touchZ) => restY + Math.max(0, touchZ - z) * Math.tan(LANDING.glide)

/** The glideslope's ship-local height at ship-local z for the Hornet (for drawing the approach gates). */
export const glideSlopeY = (z: number) => glideY(DECK_CENTRE_Y, z)

/**
 * The speed (m/s, signed) to close an error `e` with time constant `tau`, never faster than can be stopped with
 * acceleration `a` (so a big correction is an S-turn that arrives without overshoot).
 */
const closeRate = (e: number, tau: number, a: number) => Math.sign(e) * Math.min(Math.abs(e) / tau, Math.sqrt(2 * a * Math.abs(e)))

const wrapAngle = (a: number) => a - Math.PI * 2 * Math.floor((a + Math.PI) / (Math.PI * 2))
const carrot: [number, number] = [0, 0]

/** One step of the pattern: pure pursuit of a point LANDING.lookahead ahead along the path, turn-rate limited, speed
 *  toward the pattern speed (slowing to the approach speed by the join), height down a glideslope measured along the
 *  path; at the join it hands over to the straight-in approach. */
function patternStep(l: Landing, dt: number): void {
  const pts = l.path!
  const lens = l.lens
  l.s = progress(pts, lens, l.s, l.x, l.z)
  along(pts, lens, Math.min(lens[lens.length - 1]!, l.s + LANDING.lookahead), carrot)
  const want = Math.atan2(carrot[0] - l.x, carrot[1] - l.z)
  const err = wrapAngle(want - l.psi)
  const omega = clamp(err * 1.6, -LANDING.turnRate, LANDING.turnRate)
  l.psi = wrapAngle(l.psi + omega * dt)
  // Speed: fast on the legs, slower in the turns (so they stay tight), and on the approach's braking schedule by the
  // distance left to touchdown, so the hand-over is seamless.
  const total = lens[lens.length - 1]!
  const rem = Math.max(0, total - l.s)
  const turning = clamp((Math.abs(err) - 0.15) / 0.5, 0, 1)
  const vLeg = LANDING.patternSpeed - (LANDING.patternSpeed - LANDING.turnSpeed) * turning
  const vWant = Math.min(vLeg, Math.sqrt(l.vA * l.vA + 2 * LANDING.decel * rem))
  l.V = l.V > vWant ? Math.max(vWant, l.V - LANDING.maxDecel * dt) : Math.min(vWant, l.V + LANDING.accel * dt)
  // Height: the glideslope by the distance left along the path, never above the capture height (or 150 m), never
  // below the pattern floor.
  const yWant = clamp(l.restY + rem * Math.tan(LANDING.glide), l.restY + LANDING.patternFloor, Math.max(l.yTop, l.restY + LANDING.patternFloor))
  const vyWant = clamp(-l.V * Math.tan(LANDING.glide) * (yWant < l.yTop ? 1 : 0) + closeRate(yWant - l.y, 2.5, LANDING.vertAccel * 0.6), -45, 15)
  l.vy += clamp((vyWant - l.vy) * ease(dt, 0.6), -LANDING.vertAccel * dt, LANDING.vertAccel * dt)
  l.x += Math.sin(l.psi) * l.V * dt
  l.z += Math.cos(l.psi) * l.V * dt
  l.y += l.vy * dt
  // Attitude: along the course, banked into the turn (left turns, toward +X, are left wing down).
  l.yaw = l.psi
  l.pitch += (Math.atan2(l.vy, l.V) + LANDING.aoa * 0.5 - l.pitch) * ease(dt, 0.4)
  const bankWant = clamp(-Math.atan((l.V * omega) / 9.81), -LANDING.patternBank, LANDING.patternBank)
  l.bank += (bankWant - l.bank) * ease(dt, 0.5)
  l.throttle += (0.7 - l.throttle) * ease(dt, 0.8)
  // Past the end of the base turn and close to the line (still curving in is fine): the approach takes it from here
  // and finishes the line-up. Not close by the time it is near the stern: go around (a new pattern from here).
  const settled = Math.abs(l.x - CENTERLINE_X) < 25 && Math.abs(l.psi) < 0.3 && Math.abs(l.x - CENTERLINE_X + Math.sin(l.psi) * 80) < 30
  if (l.s >= l.join - 1 && !settled && l.z > STERN_Z - 350) {
    const pat = patternPath(l.x, l.z, l.touchZ)
    l.path = pat.path
    l.lens = cumulative(pat.path)
    l.join = pat.join
    l.s = 0
    return
  }
  if (l.s >= l.join - 1 && settled) {
    l.phase = "approach"
    l.u = Math.max(LANDING.closing, Math.cos(l.psi) * l.V)
    l.vx = Math.sin(l.psi) * l.V
    l.time = 0
  }
}
const STOP_Z = BOW_Z - LANDING.bowMargin
/** Arriving high, the jet may float this far past the touchdown point before it is put down. */
const FLOAT = 70

/**
 * One fixed step of the landing on `ship` (already stepped to this tick): advances the ship-local state and places the
 * jet in the world (position, orientation, finite-difference velocity). Returns true once, on the step the jet has
 * been stopped for LANDING.hold seconds: the flight is over ("landed").
 */
export function landingStep(l: Landing, plane: Plane, ship: ShipLike, dt: number): boolean {
  if (l.phase === "done") return false
  l.time += dt
  l.since += dt
  plane.t += dt
  l.shake *= Math.exp(-dt * 3)
  l.hook = Math.min(1, l.hook + dt)
  let landed = false
  if (l.phase === "pattern" && l.path) patternStep(l, dt)
  else if (l.phase === "approach") {
    const d = l.touchZ - l.z
    // Speed: brake toward the approach speed so as to reach it at the touchdown point, slower still (down to minSpeed)
    // while a big lateral or height correction needs more time than is left.
    const vA = l.vA
    const ex = CENTERLINE_X - l.x
    const ey = glideY(l.restY, l.z, l.touchZ) - l.y
    // (Small residuals are left to the final line-up: they never slow the approach.)
    const tNeed = Math.max(2 * Math.sqrt(Math.max(0, Math.abs(ex) - 4) / (0.6 * LANDING.latAccel)), 2 * Math.sqrt(Math.max(0, Math.abs(ey) - 3) / (0.6 * LANDING.vertAccel)))
    // The nominal braking schedule (reaches vA at touchdown), capped by the time the corrections need.
    const uSched = Math.sqrt(vA * vA + 2 * LANDING.decel * Math.max(d, 0))
    const uTime = Math.max(LANDING.minSpeed, d / Math.max(tNeed, 1e-3))
    // Far out the approach may speed up (to the pattern speed) to get there sooner; the schedule brakes it in time.
    const want = Math.min(uSched, uTime, LANDING.patternSpeed)
    if (l.u > want) l.u = Math.max(want, l.u - LANDING.maxDecel * dt)
    else if (l.u < want) l.u = Math.min(want, l.u + LANDING.accel * dt)
    const tgo = Math.max(0.05, d / l.u)
    const tau = clamp(tgo / 3, LANDING.settleMin, LANDING.settleMax)
    // Line up on the centreline: rate-limited, so a big offset is a smooth S-turn.
    const vxWant = clamp(closeRate(CENTERLINE_X - l.x, tau, LANDING.latAccel * 0.6), -60, 60)
    const ax = clamp((vxWant - l.vx) * ease(dt, 0.35), -LANDING.latAccel * dt, LANDING.latAccel * dt)
    l.vx += ax
    // Down the glideslope.
    const glideV = -l.u * Math.tan(LANDING.glide)
    const floating = l.z >= l.touchZ - 5
    const vyWant = floating ? clamp((l.restY - l.y) / 0.4, -25, 0) : clamp(glideV + closeRate(glideY(l.restY, l.z, l.touchZ) - l.y, tau, LANDING.vertAccel * 0.6), -40, 20)
    l.vy += floating ? (vyWant - l.vy) * ease(dt, 0.15) : clamp((vyWant - l.vy) * ease(dt, 0.5), -LANDING.vertAccel * dt, LANDING.vertAccel * dt)
    l.x += l.vx * dt
    l.y += l.vy * dt
    l.z += l.u * dt
    // Never below the deck once over it.
    if (l.z > STERN_Z - 2) l.y = Math.max(l.y, l.restY)
    // Attitude: nose along the path plus the approach angle of attack, banked into the line-up correction.
    l.yaw += (Math.atan2(l.vx, l.u) - l.yaw) * ease(dt, 0.35)
    l.pitch += (Math.atan2(l.vy, l.u) + LANDING.aoa - l.pitch) * ease(dt, 0.35)
    l.bank += (clamp((-ax / dt) * LANDING.bankPer, -LANDING.bankMax, LANDING.bankMax) - l.bank) * ease(dt, 0.4)
    l.throttle += (0.62 - l.throttle) * ease(dt, 0.8)
    // Touch down at the touchdown point, or (arriving high) as soon as the jet settles onto the deck after it.
    if (l.z >= l.touchZ && (l.y - l.restY < 0.6 || l.z >= l.touchZ + FLOAT)) {
      l.y = l.restY
      l.vy = 0
      l.phase = "trap"
      l.time = 0
      l.shake = 0.75
    }
  } else if (l.phase === "trap") {
    const room = Math.max(1, STOP_Z - l.z)
    const a = Math.max(LANDING.trapDecel, (l.u * l.u) / (2 * room))
    l.u = Math.max(0, l.u - a * dt)
    l.z += l.u * dt
    l.vx = (CENTERLINE_X - l.x) * 2
    l.x += l.vx * dt
    l.y = l.restY
    l.yaw += (0 - l.yaw) * ease(dt, 0.25)
    l.pitch += (LAUNCH.kneel - l.pitch) * ease(dt, 0.2)
    l.bank += (0 - l.bank) * ease(dt, 0.15)
    l.throttle += (0.15 - l.throttle) * ease(dt, 0.4)
    if (l.u <= 0) {
      l.phase = "stopped"
      l.time = 0
    }
  } else if (l.phase === "stopped") {
    l.yaw += (0 - l.yaw) * ease(dt, 0.25)
    l.pitch += (LAUNCH.kneel - l.pitch) * ease(dt, 0.2)
    l.bank = 0
    l.throttle += (0.15 - l.throttle) * ease(dt, 0.4)
    if (l.time >= LANDING.hold) {
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

/** Strong stick or the afterburner: the pilot is waving off (throttle alone never is). Only on the approach. */
export const wantsWaveOff = (l: Landing, c: { pitch: number; roll: number; boost: boolean; throttle?: number }): boolean =>
  (l.phase === "approach" || l.phase === "pattern") && (Math.abs(c.pitch) > LANDING.waveOffStick || Math.abs(c.roll) > LANDING.waveOffStick || c.boost)

/** Hands the jet back to the pilot mid-approach: full power, and the takeoff autopilot's short climb-out blend. */
export function waveOff(plane: Plane): void {
  plane.throttle = 1
  plane.blend = 0
  plane.p = plane.r = plane.w = 0
}
