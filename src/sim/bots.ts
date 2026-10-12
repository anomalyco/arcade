// Bot AI — owned by the Bots agent.
// Deterministic, dependency-free pilots and gunners. All randomness comes from the brain's seeded RNG.
// Hot path is allocation-free: scratch vectors are module-level and outputs are reused per brain.
import type { FlightInput, Missile, PlayerInfo, Quat, SeatInput, Vec3, VehicleEntity, VehicleKind, WorldQuery } from "./types"
import { LAUNCH_LANE_LENGTH, carrierOf, inSafeZone, posedFleet, worldQuery } from "./geography"
import { ROCKET_GRAVITY, SCANNER_FLARE_CLOSE, isSpawnProtected, weaponDirection } from "./combat"
import { AA_RANGE, SHIP_SPECS } from "./fleet"
import { VEHICLES, WEAPONS, type WeaponSpec } from "./vehicles"

/** Enemies closer than this are visible without being spotted. */
export const BOT_VISUAL_RANGE = 4_500
/** Radar officer pulses when an unspotted enemy is within this range. */
export const BOT_PULSE_RANGE = 4_000

/** Helicopters lift vertically off the deck to this altitude (m above sea level) before departing. */
const HELI_LIFTOFF_ALT = 95

export type BotPhase = "takeoff" | "transit" | "engage" | "defend"

export interface BotState {
  /** mulberry32 state. */
  rng: number
  /** 0 (hopeless) .. 1 (ace). Scales aim jitter, reaction delay and fire discipline. */
  skill: number
  vehicleId: string | null
  phase: BotPhase
  /** Horizontal runway / departure direction captured at spawn [x, z] and the spawn point. */
  runwayDir: [number, number]
  spawnPos: Vec3
  targetId: string | null
  retargetAt: number
  waypoint: Vec3
  waypointUntil: number
  jitterYaw: number
  jitterPitch: number
  jitterUntil: number
  threatId: number
  threatSeenAt: number
  breakSign: number
  extendUntil: number
  lastMissileAt: number
  /** Scanner (aim47) target the RSO is painting, and fallback timer when missiles aren't passed in. */
  guideTargetId: string | null
  guideUntil: number
  /** Room time the current engagement started (−1 when not engaged). */
  engagedSince: number
  /** Reaction delay (s) rolled for the current missile threat. */
  threatDelay: number
  /** Gun trigger discipline: fire until `burstUntil`, then hold until `burstPauseUntil`. */
  burstUntil: number
  burstPauseUntil: number
  /** Hull at the previous tick (detects incoming damage) and the break-off window it triggers. */
  lastHp: number
  evadeUntil: number
  evadeCooldownUntil: number
  /** Smoothed steering/aim direction (human-like lag and overshoot) and the time it was last updated. */
  steer: Vec3
  steerAt: number
}

interface BotOutputs {
  flight: FlightInput
  pilotSeat: SeatInput
  gunnerSeat: SeatInput
  flightAim: Vec3
  pilotAim: Vec3
  gunnerAim: Vec3
  pilot: { flight: FlightInput; seat: SeatInput }
  gunner: { flight?: FlightInput; seat: SeatInput }
}

export interface BotBrain {
  /** Free-form per-bot memory for callers (unused by the AI). */
  memory: Record<string, unknown>
  state: BotState
  /**
   * Reused result objects. `botInput` returns these; they are overwritten on the next call for this brain,
   * so copy anything you need to keep.
   */
  out: BotOutputs
}

function emptySeat(aim: Vec3): SeatInput {
  return { aim, firePrimary: false, fireSecondary: false, flares: false, ability: false }
}

export function createBotBrain(seed: number, skill?: number): BotBrain {
  const flightAim: Vec3 = [0, 0, -1], pilotAim: Vec3 = [0, 0, -1], gunnerAim: Vec3 = [0, 0, -1]
  const flight: FlightInput = { aim: flightAim, throttle: 0, roll: 0, yaw: 0, pitch: 0, boost: false, brake: false }
  const pilotSeat = emptySeat(pilotAim), gunnerSeat = emptySeat(gunnerAim)
  const brain: BotBrain = {
    memory: {},
    state: {
      rng: (seed ^ 0x9e3779b9) | 0,
      skill: 0.5,
      vehicleId: null,
      phase: "takeoff",
      runwayDir: [0, -1],
      spawnPos: [0, 0, 0],
      targetId: null,
      retargetAt: 0,
      waypoint: [0, 1000, 0],
      waypointUntil: 0,
      jitterYaw: 0,
      jitterPitch: 0,
      jitterUntil: 0,
      threatId: -1,
      threatSeenAt: 0,
      breakSign: 1,
      extendUntil: 0,
      lastMissileAt: -1e9,
      guideTargetId: null,
      guideUntil: 0,
      engagedSince: -1,
      threatDelay: 1,
      burstUntil: 0,
      burstPauseUntil: 0,
      lastHp: -1,
      evadeUntil: 0,
      evadeCooldownUntil: 0,
      steer: [0, 0, -1],
      steerAt: -1,
    },
    out: {
      flight, pilotSeat, gunnerSeat, flightAim, pilotAim, gunnerAim,
      pilot: { flight, seat: pilotSeat },
      gunner: { seat: gunnerSeat },
    },
  }
  brain.state.skill = clamp(skill ?? 0.35 + botRandom(brain) * 0.3, 0, 1)
  return brain
}

// ---------------------------------------------------------------------------------------------
// Skill curves. skill 0.25 = easy, 0.5 = normal (server default), ~0.9 = hard.

/** Aim jitter amplitude (rad, ±): normal ≈ 3.4°, easy ≈ 4.9°, hard ≈ 1.1°. */
export function jitterAmp(skill: number): number {
  return 0.11 - 0.1 * skill
}
/** Minimum reaction delay (s) to a new missile threat; a random 0–0.6 s is added (normal 0.6–1.2 s). */
export function reactionMin(skill: number): number {
  return 1.0 - 0.8 * skill
}
/** Seconds between missile launches (normal 8 s). */
export function missileInterval(skill: number): number {
  return 11 - 6 * skill
}
/** Max gun engagement range (m). */
function gunRange(skill: number, w: WeaponSpec): number {
  return Math.min(effectiveRange(w), 600 + 500 * skill)
}
/** Fraction of the true lead the bot pulls (lag pursuit at low skill). */
function leadFactor(skill: number): number {
  return 0.5 + 0.5 * skill
}
/** Max steering slew (rad/s) and first-order lag (s) of the bot's aim. */
function steerRate(skill: number): number {
  return 0.8 + 1.2 * skill
}
function steerLag(skill: number): number {
  return 0.6 - 0.45 * skill
}
/** Max distinct bot crews hunting the same target. */
export const MAX_BOTS_PER_TARGET = 2
const CLAIM_TTL = 1.5

/** Deterministic [0, 1) from the brain's RNG (mulberry32). */
export function botRandom(brain: BotBrain): number {
  let t = (brain.state.rng = (brain.state.rng + 0x6d2b79f5) | 0)
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

// ---------------------------------------------------------------------------------------------
// Vehicle choice

const KIND_WEIGHT: Record<VehicleKind, number> = { fighter: 3, apache: 2, warthog: 2, blackbird: 1.2 }
const KINDS = Object.keys(KIND_WEIGHT) as VehicleKind[]

/** Vehicle kind a bot picks when spawning: weighted random, discouraging kinds the team already flies. */
export function chooseBotVehicle(bot: PlayerInfo, teammates: PlayerInfo[], vehicles: VehicleEntity[], rng: () => number): VehicleKind {
  let f = 0, a = 0, w = 0, b = 0
  for (const v of vehicles) {
    if (!v.alive || v.team !== bot.team) continue
    if (v.kind === "fighter") f++
    else if (v.kind === "apache") a++
    else if (v.kind === "warthog") w++
    else b++
  }
  const counts: Record<VehicleKind, number> = { fighter: f, apache: a, warthog: w, blackbird: b }
  let total = 0
  for (const k of KINDS) total += kindWeight(k, counts)
  let r = clamp(rng(), 0, 0.999999) * total
  for (const k of KINDS) {
    r -= kindWeight(k, counts)
    if (r < 0) return k
  }
  return KINDS[0]
}

function kindWeight(k: VehicleKind, counts: Record<VehicleKind, number>): number {
  return (KIND_WEIGHT[k] / (1 + counts[k] * 1.5)) * (k === "blackbird" && counts.blackbird >= 2 ? 0.1 : 1)
}

// ---------------------------------------------------------------------------------------------
// Math helpers (allocation-free)

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

function set3(o: Vec3, x: number, y: number, z: number): Vec3 {
  o[0] = x; o[1] = y; o[2] = z
  return o
}

function copy3(o: Vec3, v: Vec3): Vec3 {
  o[0] = v[0]; o[1] = v[1]; o[2] = v[2]
  return o
}

function norm(v: Vec3): Vec3 {
  const l = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
  if (!(l > 1e-9) || !Number.isFinite(l)) return set3(v, 0, 0, -1)
  v[0] /= l; v[1] /= l; v[2] /= l
  return v
}

function dist(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2]
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

function speedOf(v: Vec3): number {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
}

/** Angle (rad) between unit vector `u` and the direction from `from` to `to`. */
function angleTo(u: Vec3, from: Vec3, to: Vec3): number {
  const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2]
  const l = Math.sqrt(dx * dx + dy * dy + dz * dz)
  if (l < 1e-6) return 0
  return Math.acos(clamp((u[0] * dx + u[1] * dy + u[2] * dz) / l, -1, 1))
}

function angleBetween(a: Vec3, b: Vec3): number {
  const la = speedOf(a), lb = speedOf(b)
  if (la < 1e-9 || lb < 1e-9) return Math.PI
  return Math.acos(clamp((a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (la * lb), -1, 1))
}

/** Nose direction (body −Z) into `out`. */
export function noseInto(q: Quat, out: Vec3): Vec3 {
  const [x, y, z, w] = q
  return set3(out, -(2 * (x * z + w * y)), -(2 * (y * z - w * x)), -(1 - 2 * (x * x + y * y)))
}

/** Unit vector with horizontal heading (hx, hz) and the given pitch (rad) into `out`. */
export function headingPitch(hx: number, hz: number, pitch: number, out: Vec3): Vec3 {
  let h = Math.sqrt(hx * hx + hz * hz)
  if (h < 1e-6) { hx = 0; hz = -1; h = 1 }
  const c = Math.cos(pitch)
  return set3(out, (hx / h) * c, Math.sin(pitch), (hz / h) * c)
}

function pitchOf(v: Vec3): number {
  return Math.atan2(v[1], Math.sqrt(v[0] * v[0] + v[2] * v[2]))
}

/** Replace the pitch of `v` (in place), keeping its heading. */
function setPitch(v: Vec3, pitch: number): Vec3 {
  return headingPitch(v[0], v[2], pitch, v)
}

/**
 * Time for a projectile (muzzle speed `speed`, inheriting shooter velocity) to reach a target at relative
 * position (dx,dy,dz) moving with relative velocity (vx,vy,vz). Falls back to straight-line time.
 */
export function interceptTime(dx: number, dy: number, dz: number, vx: number, vy: number, vz: number, speed: number): number {
  const a = vx * vx + vy * vy + vz * vz - speed * speed
  const b = 2 * (dx * vx + dy * vy + dz * vz)
  const c = dx * dx + dy * dy + dz * dz
  const straight = Math.sqrt(c) / Math.max(speed, 1)
  let t: number
  if (Math.abs(a) < 1e-6) t = b < 0 ? -c / b : straight
  else {
    const disc = b * b - 4 * a * c
    if (disc < 0) return straight
    const s = Math.sqrt(disc)
    const t1 = (-b - s) / (2 * a), t2 = (-b + s) / (2 * a)
    t = t1 > 0 && t2 > 0 ? Math.min(t1, t2) : t1 > 0 ? t1 : t2 > 0 ? t2 : straight
  }
  return Math.min(t, 20)
}

/**
 * Unit aim direction (into `out`) from shooter to the lead point of a projectile of `speed` m/s that inherits
 * the shooter's velocity; `gravity` adds drop compensation. Returns time to intercept.
 */
export function leadDirection(
  shooterPos: Vec3, shooterVel: Vec3, targetPos: Vec3, targetVel: Vec3, speed: number, gravity: number, out: Vec3,
): number {
  const dx = targetPos[0] - shooterPos[0], dy = targetPos[1] - shooterPos[1], dz = targetPos[2] - shooterPos[2]
  const vx = targetVel[0] - shooterVel[0], vy = targetVel[1] - shooterVel[1], vz = targetVel[2] - shooterVel[2]
  const t = interceptTime(dx, dy, dz, vx, vy, vz, speed)
  set3(out, dx + vx * t, dy + vy * t + 0.5 * gravity * t * t, dz + vz * t)
  norm(out)
  return t
}

/** Ground query subset used by the terrain helpers. */
export interface GroundQuery { groundHeight(x: number, z: number): number }

/**
 * Minimum aim pitch (rad) that keeps `clearance` m above terrain over the next `lookahead` seconds, sampling
 * along the horizontal velocity (or `fallbackDir` when slow) and accounting for the current sink rate.
 * Returns −1.2 when terrain imposes no constraint.
 */
export function terrainMinPitch(pos: Vec3, vel: Vec3, ground: GroundQuery, clearance: number, lookahead: number, fallbackDir?: Vec3): number {
  let hx = vel[0], hz = vel[2]
  const hs = Math.sqrt(hx * hx + hz * hz)
  if (hs < 20 && fallbackDir) { hx = fallbackDir[0]; hz = fallbackDir[2] }
  const h = Math.sqrt(hx * hx + hz * hz)
  const dx = h > 1e-6 ? hx / h : 0, dz = h > 1e-6 ? hz / h : -1
  const speed = Math.max(hs, 40)
  const sink = Math.min(vel[1], 0)
  let need = -1.2
  const agl = pos[1] - ground.groundHeight(pos[0], pos[2])
  if (agl < clearance) need = clamp(0.15 + (1 - agl / clearance) * 0.45, 0.15, 0.6)
  for (let i = 1; i <= 6; i++) {
    const t = (lookahead * i) / 6
    const d = speed * t
    const g = ground.groundHeight(pos[0] + dx * d, pos[2] + dz * d)
    const y = pos[1] + sink * Math.min(t, 1.5)
    const n = Math.atan2(g + clearance - y, d)
    if (n > need) need = n
  }
  return clamp(need, -1.2, 1.2)
}

/** Highest ground (m) along horizontal direction `dir` over max(speed·lookahead, 300) m. */
export function groundAhead(pos: Vec3, dir: Vec3, speed: number, ground: GroundQuery, lookahead: number): number {
  const h = Math.sqrt(dir[0] * dir[0] + dir[2] * dir[2])
  const dx = h > 1e-6 ? dir[0] / h : 0, dz = h > 1e-6 ? dir[2] / h : 0
  const reach = Math.max(speed * lookahead, 300)
  let max = ground.groundHeight(pos[0], pos[2])
  for (let i = 1; i <= 5; i++) {
    const d = (reach * i) / 5
    const g = ground.groundHeight(pos[0] + dx * d, pos[2] + dz * d)
    if (g > max) max = g
  }
  return max
}

/**
 * Bots treat everything within this horizontal range of a non-own fleet ship as a no-fly zone (fleet AA).
 * Ship queries use geography's current poses (`posedFleet`: active teams only, moving with match time).
 */
export const BOT_NO_FLY_RADIUS = AA_RANGE + 300
/** Extra distance outside the no-fly radius where steering starts bending away. */
const NO_FLY_BUFFER = 500

/** Horizontal distance from (x, z) to the nearest ship not belonging to `team` (Infinity if none). */
export function hostileFleetDistance(team: number, x: number, z: number): number {
  let best = Infinity
  const fleet = posedFleet()
  for (let i = 0; i < fleet.length; i++) {
    const sh = fleet[i]
    if (sh.team === team) continue
    const dx = x - sh.position[0], dz = z - sh.position[2]
    const d = Math.sqrt(dx * dx + dz * dz)
    if (d < best) best = d
  }
  return best
}

/**
 * Highest altitude (m) needed to clear any ship hull/superstructure (plus `margin`) along the horizontal
 * direction (dx, dz) within `reach` m, or −Infinity if none is in the way. Ships are solid.
 */
export function shipClearanceAlt(pos: Vec3, dx: number, dz: number, reach: number, margin: number): number {
  const h = Math.sqrt(dx * dx + dz * dz)
  if (h < 1e-6) { dx = 0; dz = 0 } else { dx /= h; dz /= h }
  let need = -Infinity
  const fleet = posedFleet()
  for (let i = 0; i < fleet.length; i++) {
    const sh = fleet[i]
    const sp = SHIP_SPECS[sh.kind]
    const top = sp.island.center[1] + sp.island.half[1]
    if (pos[1] > top + margin + 60) continue
    const rx = sh.position[0] - pos[0], rz = sh.position[2] - pos[2]
    const along = rx * dx + rz * dz
    const lateral = Math.abs(rx * dz - rz * dx)
    const hit = sp.halfLength + 40
    // Ignore hulls we're already past (e.g. the carrier behind a jet leaving the bow).
    if (along < -0.3 * hit || along > reach + hit || lateral > hit) continue
    if (top + margin > need) need = top + margin
  }
  return need
}

/**
 * Enforce map boundary, hostile-fleet no-fly zones, terrain/ship clearance and ceiling on a desired aim
 * (mutated in place). `team` = own team; pass null to skip fleet avoidance.
 */
export function applyAimSafety(
  aim: Vec3, pos: Vec3, vel: Vec3, world: WorldQuery, clearance: number, lookahead: number, team: number | null,
  jet = true,
): Vec3 {
  norm(aim)
  const margin = Math.min(1_200, world.half * 0.15)
  const edge = Math.max(Math.abs(pos[0]), Math.abs(pos[2])) - (world.half - margin)
  if (edge > 0) {
    const cl = Math.sqrt(pos[0] * pos[0] + pos[2] * pos[2]) || 1
    const w = clamp(edge / margin + 0.3, 0, 1)
    headingPitch(aim[0] * (1 - w) - (pos[0] / cl) * w, aim[2] * (1 - w) - (pos[2] / cl) * w, pitchOf(aim), aim)
  }
  if (team !== null) {
    const fleet = posedFleet()
    for (let i = 0; i < fleet.length; i++) {
      const sh = fleet[i]
      if (sh.team === team) continue
      const bx = pos[0] - sh.position[0], bz = pos[2] - sh.position[2]
      const r = Math.sqrt(bx * bx + bz * bz)
      const reach = BOT_NO_FLY_RADIUS + NO_FLY_BUFFER
      if (r >= reach || r < 1e-3) continue
      const ox = bx / r, oz = bz / r
      const h = Math.sqrt(aim[0] * aim[0] + aim[2] * aim[2]) || 1
      const inward = -(aim[0] * ox + aim[2] * oz) / h
      // 0 at the buffer edge → 1 at the no-fly radius; inside it, head straight out.
      const w = clamp((reach - r) / NO_FLY_BUFFER, 0, 1)
      if (r < BOT_NO_FLY_RADIUS) headingPitch(ox, oz, pitchOf(aim), aim)
      else if (inward > -0.3 * w) {
        const push = (Math.max(inward, 0) + 0.3 * w) * (0.5 + w)
        headingPitch(aim[0] / h + ox * push, aim[2] / h + oz * push, pitchOf(aim), aim)
      }
    }
  }
  let minPitch = terrainMinPitch(pos, vel, world, clearance, lookahead, aim)
  const reach = Math.max(Math.sqrt(vel[0] * vel[0] + vel[2] * vel[2]) * lookahead, 300)
  const shipAlt = shipClearanceAlt(pos, aim[0], aim[2], reach, 40)
  if (shipAlt > pos[1]) minPitch = Math.max(minPitch, Math.atan2(shipAlt - pos[1], 250))
  const p0 = pitchOf(aim)
  let p = p0 < minPitch ? minPitch : p0
  if (pos[1] > world.ceiling - 350) p = Math.min(p, -0.08)
  else if (pos[1] > world.ceiling - 800) p = Math.min(p, 0.05)
  if (p !== p0) setPitch(aim, p)
  if (jet) jetEnvelope(aim, pos, vel, world)
  return aim
}

/**
 * Jets near the ground: limit how far off the flight path the aim may sit (hard banks bleed altitude), and
 * when sinking toward the ground, roll wings-level and pull up along the current track.
 */
function jetEnvelope(aim: Vec3, pos: Vec3, vel: Vec3, world: WorldQuery): void {
  const hs = Math.sqrt(vel[0] * vel[0] + vel[2] * vel[2])
  if (hs < 20) return
  const agl = pos[1] - Math.max(world.groundHeight(pos[0], pos[2]), 0)
  const sink = -vel[1]
  if (sink > 20 && agl < 250 + sink * 6) {
    headingPitch(vel[0], vel[2], 0.35, aim)
    return
  }
  if (agl > 700) return
  const maxOff = 0.5 + (agl / 700) * 0.6
  const vh = Math.atan2(vel[0], vel[2]), ah = Math.atan2(aim[0], aim[2])
  let d = ah - vh
  d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI
  if (Math.abs(d) <= maxOff) return
  const h = vh + Math.sign(d) * maxOff
  headingPitch(Math.sin(h), Math.cos(h), Math.max(pitchOf(aim), 0.05), aim)
}

// ---------------------------------------------------------------------------------------------
// Perception

const _t0: Vec3 = [0, 0, 0]
const _t1: Vec3 = [0, 0, 0]
const _t2: Vec3 = [0, 0, 0]
const _nose: Vec3 = [0, 0, 0]
const _lead: Vec3 = [0, 0, 0]

/** Valid target: alive, hostile, not spawn-protected, and not sheltering under any hostile fleet's AA. */
function canEngage(target: VehicleEntity, myTeam: number, now: number): boolean {
  if (!target.alive || target.team === myTeam || target.flight.crashed || isSpawnProtected(target, now)) return false
  const p = target.flight.position
  return !inSafeZone(target.team, p) && hostileFleetDistance(myTeam, p[0], p[2]) > BOT_NO_FLY_RADIUS
}

function findVehicle(vehicles: VehicleEntity[], id: string | null): VehicleEntity | null {
  if (!id) return null
  for (let i = 0; i < vehicles.length; i++) if (vehicles[i].id === id) return vehicles[i]
  return null
}

/** Score-based target choice: nearest, prefers spotted, threatening, damaged and the current target. */
export function selectTarget(
  self: VehicleEntity, vehicles: VehicleEntity[], now: number, maxRange: number, currentId: string | null,
): VehicleEntity | null {
  const me = self.flight.position
  const heli = VEHICLES[self.kind].flight === "heli"
  let best: VehicleEntity | null = null
  let bestScore = Infinity
  for (let i = 0; i < vehicles.length; i++) {
    const v = vehicles[i]
    if (v === self || !canEngage(v, self.team, now)) continue
    if (v.id !== currentId && claimCount(v, self.id, now) >= MAX_BOTS_PER_TARGET) continue
    const d = dist(me, v.flight.position)
    const spotted = v.spottedUntil > now
    if (d > maxRange || (!spotted && d > BOT_VISUAL_RANGE)) continue
    let score = d
    if (spotted) score *= 0.75
    if (v.id === currentId) score *= 0.6
    score *= 0.6 + 0.4 * (v.hp / Math.max(v.maxHp, 1))
    if (d < 1_800 && angleTo(noseInto(v.flight.orientation, _t0), v.flight.position, me) < 0.45) score *= 0.5
    if (heli && speedOf(v.flight.velocity) > 150) score *= 1.6
    if (score < bestScore) { bestScore = score; best = v }
  }
  return best
}

interface Claimed { botClaims?: Record<string, number> }

/** Other bot crews currently hunting `target`. */
export function claimCount(target: VehicleEntity, selfId: string, now: number): number {
  const c = (target as Claimed).botClaims
  if (!c) return 0
  let n = 0
  for (const k in c) if (k !== selfId && c[k] > now) n++
  return n
}

/** Register this crew (by vehicle id) as hunting `target` for CLAIM_TTL seconds; prunes stale claims. */
export function claimTarget(target: VehicleEntity, selfId: string, now: number): void {
  const t = target as Claimed
  const c = t.botClaims ?? (t.botClaims = {})
  for (const k in c) if (c[k] <= now) delete c[k]
  c[selfId] = now + CLAIM_TTL
}

/** Nearest missile homing on (or scanner-guided toward) this vehicle, or null. */
export function findThreat(self: VehicleEntity, missiles: readonly Missile[] | undefined): Missile | null {
  if (!missiles) return null
  const me = self.flight.position
  let best: Missile | null = null
  let bestD = Infinity
  for (let i = 0; i < missiles.length; i++) {
    const m = missiles[i]
    if (m.team === self.team) continue
    if (m.target !== self.id && !(m.steered && m.scanTarget === self.id)) continue
    const d = dist(me, m.position)
    if (d < bestD) { bestD = d; best = m }
  }
  return best
}

// ---------------------------------------------------------------------------------------------
// Per-tick control

function updateJitter(brain: BotBrain, now: number): void {
  const s = brain.state
  if (now < s.jitterUntil) return
  const amp = jitterAmp(s.skill)
  s.jitterYaw = (botRandom(brain) * 2 - 1) * amp
  s.jitterPitch = (botRandom(brain) * 2 - 1) * amp
  s.jitterUntil = now + 0.3 + botRandom(brain) * 0.5
}

function applyJitter(brain: BotBrain, aim: Vec3): Vec3 {
  const s = brain.state
  const c = Math.cos(s.jitterYaw), sn = Math.sin(s.jitterYaw)
  const x = aim[0] * c + aim[2] * sn, z = -aim[0] * sn + aim[2] * c
  aim[0] = x; aim[2] = z
  return setPitch(aim, clamp(pitchOf(aim) + s.jitterPitch, -1.5, 1.5))
}

/** Ease the bot's steering toward `desired` (in place → result in `desired`): rate-limited, lagged. */
function smoothSteer(brain: BotBrain, desired: Vec3, now: number, from: Vec3): void {
  const s = brain.state
  const dt = s.steerAt < 0 ? 0 : clamp(now - s.steerAt, 0, 0.25)
  if (s.steerAt < 0 || now - s.steerAt > 0.5) copy3(s.steer, from)
  s.steerAt = now
  const st = s.steer
  const ang = angleBetween(st, desired)
  if (ang < 1e-6 || dt === 0) { if (dt === 0) copy3(desired, st); else copy3(st, desired); return }
  const step = Math.min(ang, ang * (1 - Math.exp(-dt / steerLag(s.skill))), steerRate(s.skill) * dt)
  const t = step / ang
  // Normalized lerp is accurate enough for small steps.
  set3(st, st[0] + (desired[0] - st[0]) * t, st[1] + (desired[1] - st[1]) * t, st[2] + (desired[2] - st[2]) * t)
  norm(st)
  copy3(desired, st)
}

/** Gun trigger: short bursts with pauses; returns whether the trigger may be held this tick. */
function burstAllowed(brain: BotBrain, now: number): boolean {
  const s = brain.state
  if (now < s.burstUntil) return true
  if (now < s.burstPauseUntil) return false
  s.burstUntil = now + 0.35 + 0.4 * s.skill + botRandom(brain) * 0.3
  s.burstPauseUntil = s.burstUntil + (1.2 - 0.9 * s.skill) + botRandom(brain) * 0.5
  return true
}

function weaponReady(rt: { ammo: number; readyAt: number } | undefined, now: number): boolean {
  return !!rt && (rt.ammo < 0 || rt.ammo >= 1) && rt.readyAt <= now
}

function effectiveRange(w: WeaponSpec): number {
  switch (w.kind) {
    case "gun": return Math.min(w.speed * w.ttl * 0.6, 1_300)
    case "rockets": return Math.min(w.speed * w.ttl * 0.45, 1_200)
    case "missile_lock": return (w.range ?? 2_500) * 0.95
    case "missile_scanner": return (w.range ?? 8_000) * 0.9
    case "pulse": return BOT_PULSE_RANGE
  }
}

function resetSeat(seat: SeatInput, aimBuf: Vec3, aim: Vec3 | null): SeatInput {
  seat.aim = aim ? copy3(aimBuf, aim) : null
  seat.firePrimary = false
  seat.fireSecondary = false
  seat.flares = false
  seat.ability = false
  return seat
}

function resetForVehicle(brain: BotBrain, vehicle: VehicleEntity): void {
  const s = brain.state
  s.vehicleId = vehicle.id
  s.phase = vehicle.flight.onGround ? "takeoff" : "transit"
  noseInto(vehicle.flight.orientation, _t0)
  if (vehicle.flight.onGround) {
    // Launch along the (current) carrier bow.
    const hd = carrierOf(vehicle.team).heading
    set3(_t0, -Math.sin(hd), 0, -Math.cos(hd))
  }
  const h = Math.sqrt(_t0[0] * _t0[0] + _t0[2] * _t0[2])
  s.runwayDir[0] = h > 1e-6 ? _t0[0] / h : 0
  s.runwayDir[1] = h > 1e-6 ? _t0[2] / h : -1
  copy3(s.spawnPos, vehicle.flight.position)
  s.targetId = null
  s.retargetAt = 0
  s.waypointUntil = 0
  s.threatId = -1
  s.extendUntil = 0
  s.guideTargetId = null
  s.guideUntil = 0
  s.engagedSince = -1
  s.breakSign = botRandom(brain) < 0.5 ? -1 : 1
}

/**
 * Compute this tick's input for a bot occupying `vehicle` in its seat. `missiles` (optional, pass
 * `combatState.missiles`) enables missile defence and scanner-guidance tracking; `world` defaults to the
 * shared geography. The returned objects are owned by the brain and reused on the next call.
 */
export function botInput(
  brain: BotBrain, bot: PlayerInfo, vehicle: VehicleEntity, vehicles: VehicleEntity[], now: number,
  missiles?: readonly Missile[], world: WorldQuery = worldQuery,
): { flight?: FlightInput; seat: SeatInput } {
  const o = brain.out
  if (!vehicle.alive || vehicle.flight.crashed || (bot.seat !== 0 && bot.seat !== 1)) {
    const f = o.flight
    f.aim = null; f.throttle = 0; f.roll = 0; f.yaw = 0; f.pitch = 0; f.boost = false; f.brake = false
    resetSeat(o.pilotSeat, o.pilotAim, null)
    resetSeat(o.gunnerSeat, o.gunnerAim, null)
    return bot.seat === 0 ? o.pilot : o.gunner
  }
  if (brain.state.vehicleId !== vehicle.id) resetForVehicle(brain, vehicle)
  updateJitter(brain, now)
  if (bot.seat === 0) return pilotInput(brain, bot, vehicle, vehicles, now, missiles, world)
  gunnerInput(brain, bot, vehicle, vehicles, now, missiles)
  return o.gunner
}

// ---------------------------------------------------------------------------------------------
// Pilot

function pickWaypoint(brain: BotBrain, now: number, heli: boolean, half: number): void {
  const s = brain.state
  const ang = botRandom(brain) * Math.PI * 2
  // Patrol the central battle space (scaled to the map), inside the carrier orbit.
  const r = botRandom(brain) * half * (heli ? 0.3 : 0.45)
  set3(s.waypoint, Math.cos(ang) * r, heli ? 180 : 900 + botRandom(brain) * 700, Math.sin(ang) * r)
  s.waypointUntil = now + 20 + botRandom(brain) * 20
}

function pilotInput(
  brain: BotBrain, bot: PlayerInfo, vehicle: VehicleEntity, vehicles: VehicleEntity[], now: number,
  missiles: readonly Missile[] | undefined, world: WorldQuery,
): { flight: FlightInput; seat: SeatInput } {
  const s = brain.state
  const o = brain.out
  const spec = VEHICLES[vehicle.kind]
  const heli = spec.flight === "heli"
  const fs = vehicle.flight
  const pos = fs.position, vel = fs.velocity
  const nose = noseInto(fs.orientation, _nose)
  const speed = speedOf(vel)
  const ground = world.groundHeight(pos[0], pos[2])
  const agl = pos[1] - ground

  const flight = o.flight
  flight.roll = 0; flight.yaw = 0; flight.pitch = 0; flight.boost = false; flight.brake = false
  const seat = resetSeat(o.pilotSeat, o.pilotAim, null)
  const aim = copy3(o.flightAim, nose)
  let desiredThrottle = 0.85
  let heliAlt = pos[1]
  let clearance = heli ? 45 : 150
  const lookahead = heli ? 4 : 7
  let lookTarget: VehicleEntity | null = null

  if (fs.onGround && s.phase !== "takeoff") { s.phase = "takeoff"; copy3(s.spawnPos, pos) }
  if (s.phase === "takeoff" && !fs.onGround) {
    const fromSpawn = Math.hypot(pos[0] - s.spawnPos[0], pos[2] - s.spawnPos[2])
    if (heli ? pos[1] > HELI_LIFTOFF_ALT : (fromSpawn > LAUNCH_LANE_LENGTH * 0.5 && agl > 150) || fromSpawn > LAUNCH_LANE_LENGTH) s.phase = "transit"
  }

  if (s.phase === "takeoff") {
    // Jets: power up on the catapult, then hold the bow heading with a gentle climb through the launch lane.
    // Helicopters: lift straight up off the deck (hover-hold), then go.
    const rd = s.runwayDir
    if (heli) {
      headingPitch(rd[0], rd[1], 0, aim)
      heliAlt = HELI_LIFTOFF_ALT + 15
      flight.brake = true
    } else {
      const pitch = fs.onGround ? 0 : speed > spec.stall * 1.6 ? 0.15 : 0.07
      headingPitch(rd[0], rd[1], pitch, aim)
      desiredThrottle = 1
      flight.boost = fs.onGround || speed < spec.stall * 1.5
      clearance = 25
      if (!fs.onGround) applyAimSafety(aim, pos, vel, world, clearance, lookahead, null)
    }
    s.engagedSince = -1
    return finishPilot(brain, vehicle, aim, heli, desiredThrottle, heliAlt, ground, world, null)
  }

  // Threat assessment (with reaction delay).
  const threat = findThreat(vehicle, missiles)
  if (threat) {
    if (s.threatId !== threat.id) {
      s.threatId = threat.id; s.threatSeenAt = now; s.breakSign = botRandom(brain) < 0.5 ? -1 : 1
      s.threatDelay = reactionMin(s.skill) + botRandom(brain) * 0.6
    }
  } else s.threatId = -1
  const defending = threat !== null && now >= s.threatSeenAt + s.threatDelay

  // Taking hits: break off for a few seconds (less often for skilled bots).
  if (s.lastHp >= 0 && vehicle.hp < s.lastHp - 0.5 && now >= s.evadeCooldownUntil && botRandom(brain) < 1 - 0.5 * s.skill) {
    s.evadeUntil = now + 2 + botRandom(brain) * 2
    s.evadeCooldownUntil = s.evadeUntil + 4
    s.breakSign = botRandom(brain) < 0.5 ? -1 : 1
  }
  s.lastHp = vehicle.hp
  const evading = now < s.evadeUntil

  // Target selection.
  let target = findVehicle(vehicles, s.targetId)
  if (now >= s.retargetAt || (target && !canEngage(target, vehicle.team, now))) {
    const maxRange = vehicle.kind === "blackbird" ? 12_000 : heli ? 5_000 : 9_000
    target = selectTarget(vehicle, vehicles, now, maxRange, s.targetId)
    s.targetId = target ? target.id : null
    s.retargetAt = now + 0.6 + (1 - s.skill) * 1.5 + botRandom(brain) * 0.4
  }
  if (target && !canEngage(target, vehicle.team, now)) target = null
  if (target) claimTarget(target, vehicle.id, now)
  const inOwnSafe = inSafeZone(vehicle.team, pos)

  if (defending && threat) {
    s.phase = "defend"
    // Beam the missile: turn perpendicular to its line of sight; dive if there's room.
    const lx = pos[0] - threat.position[0], lz = pos[2] - threat.position[2]
    headingPitch(-lz * s.breakSign, lx * s.breakSign, agl > 600 ? -0.2 : 0.1, aim)
    desiredThrottle = 1
    flight.boost = true
    const md = dist(pos, threat.position)
    const flareAt = threat.steered ? SCANNER_FLARE_CLOSE : 1_000 + 1_500 * s.skill
    if (md < flareAt && vehicle.flareCount > 0 && vehicle.flaresReadyAt <= now) seat.flares = true
    heliAlt = Math.max(ground + 40, pos[1] - 30)
    lookTarget = target
  } else if (evading) {
    s.phase = "defend"
    // Break turn away from the current heading, with altitude change if there's room; no shooting.
    const hx = vel[0], hz = vel[2]
    headingPitch(hx * 0.3 - hz * s.breakSign, hz * 0.3 + hx * s.breakSign, agl > 700 ? -0.15 : 0.2, aim)
    desiredThrottle = 1
    flight.boost = true
    heliAlt = Math.max(ground + 50, pos[1] - 20)
    lookTarget = target
  } else if (target) {
    if (s.phase !== "engage") s.engagedSince = now
    s.phase = "engage"
    desiredThrottle = engage(brain, vehicle, target, now, aim, inOwnSafe)
    if (heli) heliAlt = clamp(target.flight.position[1], ground + 60, ground + 600)
    lookTarget = target
  } else {
    s.phase = "transit"
    if (now >= s.waypointUntil || Math.hypot(pos[0] - s.waypoint[0], pos[2] - s.waypoint[2]) < (heli ? 400 : 1_000)) pickWaypoint(brain, now, heli, world.half)
    const wp = s.waypoint
    const dx = wp[0] - pos[0], dz = wp[2] - pos[2]
    const hd = Math.sqrt(dx * dx + dz * dz)
    if (heli) {
      heliAlt = ground + wp[1]
      headingPitch(dx, dz, hd > 300 ? -0.3 : 0, aim)
      flight.boost = hd > 3_000
    } else {
      const alt = Math.max(wp[1], ground + 450)
      headingPitch(dx, dz, clamp(Math.atan2(alt - pos[1], 2_000), -0.3, 0.35), aim)
      flight.boost = hd > 5_000 && speed < spec.cruise * 1.2
    }
  }
  if (s.phase !== "engage") s.engagedSince = -1

  if (s.phase === "engage" && vehicle.kind !== "blackbird") applyJitter(brain, aim)
  applyAimSafety(aim, pos, vel, world, clearance, lookahead, bot.team, !heli)
  if (!heli && speed < spec.stall * 1.3) { desiredThrottle = 1; flight.boost = true }
  return finishPilot(brain, vehicle, aim, heli, desiredThrottle, heliAlt, ground, world, lookTarget)
}

function finishPilot(
  brain: BotBrain, vehicle: VehicleEntity, aim: Vec3, heli: boolean, desiredThrottle: number,
  heliAlt: number, ground: number, world: WorldQuery, lookTarget: VehicleEntity | null,
): { flight: FlightInput; seat: SeatInput } {
  const o = brain.out
  const flight = o.flight, seat = o.pilotSeat, fs = vehicle.flight, vel = fs.velocity
  norm(aim)
  if (heli) {
    const hs = Math.hypot(vel[0], vel[2])
    const floor = Math.max(groundAhead(fs.position, aim, hs, world, 4) + 45, shipClearanceAlt(fs.position, aim[0], aim[2], Math.max(hs * 5, 300), 30))
    const alt = clamp(Math.max(heliAlt, floor), ground + 10, world.ceiling - 300)
    const err = alt - fs.position[1]
    // Collective is a rate input; released it eases back to hover with altitude hold.
    flight.throttle = Math.abs(err) < 6 && Math.abs(vel[1]) < 1.5 ? 0 : clamp(err * 0.03 - vel[1] * 0.2, -1, 1)
  } else {
    flight.throttle = clamp((desiredThrottle - fs.throttle) * 4, -1, 1)
  }
  if (!Number.isFinite(flight.throttle)) flight.throttle = 0
  flight.aim = aim
  // Pilot reticle: toward the current target when there is one (drives recon look-to-spot), else the nose aim.
  if (lookTarget) {
    const tp = lookTarget.flight.position, p = fs.position
    seat.aim = norm(set3(o.pilotAim, tp[0] - p[0], tp[1] - p[1], tp[2] - p[2]))
  } else seat.aim = copy3(o.pilotAim, aim)
  return o.pilot
}

/** Steering + pilot fire control while engaged. Writes the desired nose into `aim`; returns desired throttle. */
function engage(brain: BotBrain, vehicle: VehicleEntity, target: VehicleEntity, now: number, aim: Vec3, inOwnSafe: boolean): number {
  const s = brain.state
  const o = brain.out
  const flight = o.flight, seat = o.pilotSeat
  const spec = VEHICLES[vehicle.kind]
  const heli = spec.flight === "heli"
  const fs = vehicle.flight
  const pos = fs.position, vel = fs.velocity
  const tp = target.flight.position, tv = target.flight.velocity
  const nose = _nose
  const d = dist(pos, tp)
  const tx = tp[0] - pos[0], ty = tp[1] - pos[1], tz = tp[2] - pos[2]
  const closing = -((tv[0] - vel[0]) * tx + (tv[1] - vel[1]) * ty + (tv[2] - vel[2]) * tz) / Math.max(d, 1)
  let throttle = 0.85

  const pId = spec.seatWeapons[0][0], sId = spec.seatWeapons[0][1]
  const primary = pId ? WEAPONS[pId] : null
  const steerW = primary && (primary.kind === "gun" || primary.kind === "rockets") ? primary : null
  const lead = _lead
  if (steerW && d < 2_500) {
    // Lag pursuit at lower skill: pull only part of the true lead.
    leadDirection(pos, vel, tp, tv, steerW.speed, steerW.kind === "rockets" ? ROCKET_GRAVITY : 0, lead)
    const f = leadFactor(s.skill)
    norm(set3(lead, tx / d * (1 - f) + lead[0] * f, ty / d * (1 - f) + lead[1] * f, tz / d * (1 - f) + lead[2] * f))
  } else norm(set3(lead, tx, ty, tz))
  smoothSteer(brain, lead, now, nose)

  if (vehicle.kind === "blackbird") {
    // No pilot weapons: keep the target ahead within scanner range (3–6.5 km) and outside gun range.
    const hd = Math.sqrt(tx * tx + tz * tz)
    if (now < s.extendUntil || d < 2_200) {
      if (now >= s.extendUntil) s.extendUntil = now + 6 + botRandom(brain) * 3
      headingPitch(-tx, -tz, 0.05, aim)
      flight.boost = true
      throttle = 1
    } else if (d > 6_500) {
      copy3(aim, lead)
      throttle = 1
      flight.boost = d > 9_000
    } else {
      // Crank: offset ~40° from the target so range closes slowly while it stays in front.
      const c = Math.cos(0.7 * s.breakSign), sn = Math.sin(0.7 * s.breakSign)
      headingPitch((tx * c + tz * sn) / hd, (-tx * sn + tz * c) / hd, clamp(Math.atan2(ty, hd), -0.25, 0.25), aim)
      throttle = 0.9
    }
    return throttle
  }

  if (heli) {
    const hd = Math.sqrt(tx * tx + tz * tz)
    if (hd > 1_400) {
      headingPitch(tx, tz, -0.3, aim)
      flight.boost = hd > 3_000
    } else if (hd < 550) {
      headingPitch(-tz * s.breakSign - tx, tx * s.breakSign - tz, -0.3, aim)
    } else {
      copy3(aim, lead)
      setPitch(aim, clamp(pitchOf(aim), -0.35, 0.3))
    }
    throttle = 0.8
  } else {
    copy3(aim, lead)
    if (d < 200 && closing > 0) headingPitch(-tz * s.breakSign, tx * s.breakSign, 0.4, aim) // don't ram
    if (d > 3_000) { throttle = 1; flight.boost = true }
    else if (d > 1_200) throttle = 1
    else if (d < 600 && closing > 40) { throttle = 0.35; flight.brake = closing > 80 }
    else throttle = 0.8
  }

  if (inOwnSafe) return throttle
  for (let slot = 0; slot < 2; slot++) {
    const id = slot === 0 ? pId : sId
    if (!id) continue
    const w = WEAPONS[id]
    const rt = vehicle.weapons[0][slot]
    if (!weaponReady(rt, now)) continue
    if (w.kind === "gun" || w.kind === "rockets") {
      if (d > gunRange(s.skill, w)) continue
      leadDirection(pos, vel, tp, tv, w.speed, w.kind === "rockets" ? ROCKET_GRAVITY : 0, _t1)
      const err = angleBetween(nose, _t1)
      // Fire only when well aligned, in short bursts.
      const tol = Math.atan2(VEHICLES[target.kind].radius * (1.4 + 0.6 * s.skill), d)
      if (err < tol && burstAllowed(brain, now)) {
        if (slot === 0) seat.firePrimary = true
        else seat.fireSecondary = true
      }
    } else if (w.kind === "missile_lock") {
      // Fire-and-forget once the nose seeker has a full lock on a valid enemy.
      if (rt.lock < 1 || !rt.lockTarget || now - s.lastMissileAt < missileInterval(s.skill)) continue
      if (slot === 0) seat.firePrimary = true
      else seat.fireSecondary = true
      s.lastMissileAt = now
    }
  }
  return throttle
}

// ---------------------------------------------------------------------------------------------
// Gunner / weapons officer (seat 1)

function myScannerMissile(bot: PlayerInfo, vehicle: VehicleEntity, missiles: readonly Missile[]): Missile | null {
  for (let i = 0; i < missiles.length; i++) {
    const m = missiles[i]
    if (m.steered && m.vehicle === vehicle.id && m.owner === bot.id && m.scanTarget) return m
  }
  return null
}

function gunnerInput(
  brain: BotBrain, bot: PlayerInfo, vehicle: VehicleEntity, vehicles: VehicleEntity[], now: number,
  missiles: readonly Missile[] | undefined,
): void {
  const s = brain.state
  const o = brain.out
  const spec = VEHICLES[vehicle.kind]
  const fs = vehicle.flight
  const pos = fs.position, vel = fs.velocity
  const nose = noseInto(fs.orientation, _nose)
  const seat = resetSeat(o.gunnerSeat, o.gunnerAim, nose)
  const aim = o.gunnerAim
  const ids = spec.seatWeapons[1]
  const inOwnSafe = inSafeZone(vehicle.team, pos)
  let hasPulse = false
  let maxRange = 0
  for (let slot = 0; slot < 2; slot++) {
    const id = ids[slot]
    if (!id) continue
    if (WEAPONS[id].kind === "pulse") hasPulse = true
    maxRange = Math.max(maxRange, effectiveRange(WEAPONS[id]))
  }

  // Radar pulse (Blackbird RSO): when an unspotted enemy is near and the cooldown allows.
  if (hasPulse && vehicle.abilityReadyAt <= now) {
    for (let i = 0; i < vehicles.length; i++) {
      const v = vehicles[i]
      if (v.alive && v.team !== vehicle.team && v.spottedUntil <= now && dist(pos, v.flight.position) < BOT_PULSE_RANGE) {
        seat.ability = true
        break
      }
    }
  }

  // Scanner guidance: keep painting the target of our aim47 until it's gone.
  let scanning: VehicleEntity | null = null
  if (missiles) {
    const m = myScannerMissile(bot, vehicle, missiles)
    if (m) { s.guideTargetId = m.scanTarget ?? null; s.guideUntil = now + 0.5 }
    else if (now - s.lastMissileAt > 0.5) s.guideUntil = Math.min(s.guideUntil, now)
  }
  if (now < s.guideUntil) {
    scanning = findVehicle(vehicles, s.guideTargetId)
    if (scanning && !scanning.alive) scanning = null
  }
  if (scanning) {
    const tp = scanning.flight.position
    applyJitter(brain, norm(set3(aim, tp[0] - pos[0], tp[1] - pos[1], tp[2] - pos[2])))
    return
  }

  let target = findVehicle(vehicles, s.targetId)
  if (now >= s.retargetAt || (target && !canEngage(target, vehicle.team, now))) {
    target = selectTarget(vehicle, vehicles, now, maxRange, s.targetId)
    s.targetId = target ? target.id : null
    s.retargetAt = now + 0.6 + (1 - s.skill) * 1.5 + botRandom(brain) * 0.4
  }
  if (!target || !canEngage(target, vehicle.team, now)) return
  claimTarget(target, vehicle.id, now)
  const tp = target.flight.position, tv = target.flight.velocity
  const d = dist(pos, tp)
  const canFire = !inOwnSafe
  const noseAngle = angleTo(nose, pos, tp)
  let aimed = false

  for (let slot = 0; slot < 2; slot++) {
    const id = ids[slot]
    if (!id) continue
    const w = WEAPONS[id]
    const rt = vehicle.weapons[1][slot]
    const range = effectiveRange(w)
    if (w.kind === "gun" && d <= gunRange(s.skill, w) && !aimed) {
      leadDirection(pos, vel, tp, tv, w.speed, 0, aim)
      smoothSteer(brain, aim, now, nose)
      applyJitter(brain, aim)
      aimed = true
      // Only fire when the turret can actually reach the commanded direction and the aim is near the true lead.
      leadDirection(pos, vel, tp, tv, w.speed, 0, _t1)
      weaponDirection(vehicle, id, aim, _t2)
      const tol = Math.atan2(VEHICLES[target.kind].radius * (0.8 + 0.4 * s.skill), d)
      if (canFire && weaponReady(rt, now) && angleBetween(_t2, _t1) < tol && burstAllowed(brain, now)) {
        if (slot === 0) seat.firePrimary = true
        else seat.fireSecondary = true
      }
    } else if ((w.kind === "missile_lock" || w.kind === "missile_scanner") && d <= range && d > 300) {
      if (!aimed) {
        norm(set3(aim, tp[0] - pos[0], tp[1] - pos[1], tp[2] - pos[2]))
        smoothSteer(brain, aim, now, nose)
        applyJitter(brain, aim)
        aimed = true
      }
      // Missiles launch along the nose: only fire when the target is within the missile's turn-off-the-rail reach.
      if (canFire && weaponReady(rt, now) && rt.lock >= 1 && rt.lockTarget === target.id && noseAngle < (w.kind === "missile_scanner" ? 0.9 : 1.1) && now - s.lastMissileAt > missileInterval(s.skill)) {
        if (slot === 0) seat.firePrimary = true
        else seat.fireSecondary = true
        s.lastMissileAt = now
        if (w.kind === "missile_scanner") { s.guideTargetId = target.id; s.guideUntil = now + Math.min(w.ttl, d / w.speed * 2 + 2) }
      }
    }
  }
  if (!aimed) {
    norm(set3(aim, tp[0] - pos[0], tp[1] - pos[1], tp[2] - pos[2]))
    smoothSteer(brain, aim, now, nose)
    applyJitter(brain, aim)
  }
  // Crews without a radar pulse mark the target for the team when it's unspotted and on the crosshair.
  if (!hasPulse && vehicle.abilityReadyAt <= now && target.spottedUntil <= now && d < 4_000 && angleTo(aim, pos, tp) < 0.06) seat.ability = true
}
