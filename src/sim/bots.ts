// Bot AI — owned by the Bots agent.
// Deterministic, dependency-free pilots and gunners. All randomness comes from the brain's seeded RNG.
import type { FlightInput, FlightState, Missile, PlayerInfo, SeatInput, Vec3, VehicleEntity, VehicleKind, WorldQuery } from "./types"
import { NEUTRAL_INPUT, forward } from "./flight"
import { AIRBASES, inSafeZone, worldQuery } from "./geography"
import { VEHICLES, WEAPONS, type WeaponSpec } from "./vehicles"

/** Gravity assumed for gun/rocket drop compensation (m/s²). */
export const BOT_GRAVITY = 9.81
/** Enemies closer than this are visible without radar paint. */
export const BOT_VISUAL_RANGE = 5_000

export type BotPhase = "takeoff" | "transit" | "engage" | "defend"

export interface BotState {
  /** mulberry32 state. */
  rng: number
  /** 0 (hopeless) .. 1 (ace). Scales aim jitter, reaction delay and fire discipline. */
  skill: number
  vehicleId: string | null
  phase: BotPhase
  /** Horizontal runway direction captured at spawn [x, z]. */
  runwayDir: [number, number]
  targetId: string | null
  retargetAt: number
  waypoint: Vec3
  waypointUntil: number
  jitterYaw: number
  jitterPitch: number
  jitterUntil: number
  threatId: number | null
  threatSeenAt: number
  breakSign: number
  extendUntil: number
  lastMissileAt: number
  guideTargetId: string | null
  guideUntil: number
  lastPulseAt: number
}

export interface BotBrain {
  /** Internal per-bot memory (free-form, unused by the core AI; kept for callers). */
  memory: Record<string, unknown>
  state: BotState
}

export function createBotBrain(seed: number, skill?: number): BotBrain {
  const state: BotState = {
    rng: (seed ^ 0x9e3779b9) | 0,
    skill: 0.5,
    vehicleId: null,
    phase: "takeoff",
    runwayDir: [0, -1],
    targetId: null,
    retargetAt: 0,
    waypoint: [0, 1200, 0],
    waypointUntil: 0,
    jitterYaw: 0,
    jitterPitch: 0,
    jitterUntil: 0,
    threatId: null,
    threatSeenAt: 0,
    breakSign: 1,
    extendUntil: 0,
    lastMissileAt: -Infinity,
    guideTargetId: null,
    guideUntil: 0,
    lastPulseAt: -Infinity,
  }
  const brain: BotBrain = { memory: {}, state }
  state.skill = skill ?? 0.35 + botRandom(brain) * 0.5
  return brain
}

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

/** Vehicle kind a bot picks when spawning. */
export function chooseBotVehicle(bot: PlayerInfo, teammates: PlayerInfo[], vehicles: VehicleEntity[], rng: () => number): VehicleKind {
  const counts: Record<VehicleKind, number> = { fighter: 0, apache: 0, warthog: 0, blackbird: 0 }
  for (const v of vehicles) if (v.alive && v.team === bot.team) counts[v.kind]++
  const kinds = Object.keys(KIND_WEIGHT) as VehicleKind[]
  let total = 0
  const weights = kinds.map(k => {
    const w = KIND_WEIGHT[k] / (1 + counts[k] * 1.5) * (k === "blackbird" && counts.blackbird >= 2 ? 0.1 : 1)
    total += w
    return w
  })
  let r = clamp(rng(), 0, 0.999999) * total
  for (let i = 0; i < kinds.length; i++) {
    r -= weights[i]
    if (r < 0) return kinds[i]
  }
  return kinds[0]
}

// ---------------------------------------------------------------------------------------------
// Math helpers (exported decision functions are pure and testable with injected terrain)

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

function norm(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2])
  if (l < 1e-9 || !Number.isFinite(l)) { v[0] = 0; v[1] = 0; v[2] = -1; return v }
  v[0] /= l; v[1] /= l; v[2] /= l
  return v
}

function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

function angleBetween(a: Vec3, b: Vec3): number {
  const la = Math.hypot(a[0], a[1], a[2]), lb = Math.hypot(b[0], b[1], b[2])
  if (la < 1e-9 || lb < 1e-9) return Math.PI
  return Math.acos(clamp((a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (la * lb), -1, 1))
}

/** Unit vector with the horizontal heading of `v` (or `fallback`) and the given pitch (rad). Mutates/returns `out`. */
export function withPitch(v: Vec3, pitch: number, out: Vec3 = [0, 0, 0], fallback?: Vec3): Vec3 {
  let hx = v[0], hz = v[2]
  let h = Math.hypot(hx, hz)
  if (h < 1e-6 && fallback) { hx = fallback[0]; hz = fallback[2]; h = Math.hypot(hx, hz) }
  if (h < 1e-6) { hx = 0; hz = -1; h = 1 }
  const c = Math.cos(pitch)
  out[0] = (hx / h) * c
  out[1] = Math.sin(pitch)
  out[2] = (hz / h) * c
  return out
}

function pitchOf(v: Vec3): number {
  return Math.atan2(v[1], Math.hypot(v[0], v[2]))
}

/**
 * Time for a projectile (muzzle speed `speed`, inheriting shooter velocity) to intercept a target at relative
 * position d moving with relative velocity rv. Falls back to straight-line time when no solution exists.
 */
export function interceptTime(d: Vec3, rv: Vec3, speed: number): number {
  const a = rv[0] * rv[0] + rv[1] * rv[1] + rv[2] * rv[2] - speed * speed
  const b = 2 * (d[0] * rv[0] + d[1] * rv[1] + d[2] * rv[2])
  const c = d[0] * d[0] + d[1] * d[1] + d[2] * d[2]
  const straight = Math.sqrt(c) / Math.max(speed, 1)
  if (Math.abs(a) < 1e-6) {
    const t = b !== 0 ? -c / b : -1
    return t > 0 ? t : straight
  }
  const disc = b * b - 4 * a * c
  if (disc < 0) return straight
  const s = Math.sqrt(disc)
  const t1 = (-b - s) / (2 * a), t2 = (-b + s) / (2 * a)
  const t = t1 > 0 && t2 > 0 ? Math.min(t1, t2) : t1 > 0 ? t1 : t2 > 0 ? t2 : straight
  return Math.min(t, 30)
}

/**
 * Unit aim direction from shooter to the lead point for a projectile of `speed` m/s (shooter velocity is
 * inherited by the projectile). `gravity` adds drop compensation. Returns intercept time.
 */
export function leadDirection(
  shooterPos: Vec3, shooterVel: Vec3, targetPos: Vec3, targetVel: Vec3, speed: number, gravity: number, out: Vec3,
): number {
  const d: Vec3 = [targetPos[0] - shooterPos[0], targetPos[1] - shooterPos[1], targetPos[2] - shooterPos[2]]
  const rv: Vec3 = [targetVel[0] - shooterVel[0], targetVel[1] - shooterVel[1], targetVel[2] - shooterVel[2]]
  const t = interceptTime(d, rv, speed)
  out[0] = d[0] + rv[0] * t
  out[1] = d[1] + rv[1] * t + 0.5 * gravity * t * t
  out[2] = d[2] + rv[2] * t
  norm(out)
  return t
}

/**
 * Minimum aim pitch (rad) that keeps `clearance` meters above terrain over the next `lookahead` seconds,
 * sampling along the horizontal velocity (or `fallbackDir` when slow). Accounts for current sink rate.
 * Returns a large negative number when terrain imposes no constraint.
 */
export function terrainMinPitch(
  pos: Vec3, vel: Vec3, ground: (x: number, z: number) => number, clearance: number, lookahead: number, fallbackDir?: Vec3,
): number {
  let hx = vel[0], hz = vel[2]
  let hs = Math.hypot(hx, hz)
  if (hs < 20 && fallbackDir) {
    const fh = Math.hypot(fallbackDir[0], fallbackDir[2])
    if (fh > 1e-6) { hx = fallbackDir[0] / fh * Math.max(hs, 1); hz = fallbackDir[2] / fh * Math.max(hs, 1) }
  }
  const h = Math.hypot(hx, hz)
  const dx = h > 1e-6 ? hx / h : 0, dz = h > 1e-6 ? hz / h : -1
  const speed = Math.max(hs, 40)
  const sink = Math.min(vel[1], 0)
  let need = -1.2
  const here = ground(pos[0], pos[2])
  const agl = pos[1] - here
  if (agl < clearance) need = Math.max(need, clamp(0.15 + (1 - agl / clearance) * 0.45, 0.15, 0.6))
  for (let i = 1; i <= 6; i++) {
    const t = (lookahead * i) / 6
    const d = speed * t
    const g = ground(pos[0] + dx * d, pos[2] + dz * d)
    const y = pos[1] + sink * Math.min(t, 1.5)
    need = Math.max(need, Math.atan2(g + clearance - y, d))
  }
  return clamp(need, -1.2, 1.2)
}

/** Highest ground (m) along the flight path over the next `lookahead` seconds (min 300 m ahead). */
export function groundAhead(pos: Vec3, dir: Vec3, speed: number, ground: (x: number, z: number) => number, lookahead: number): number {
  const h = Math.hypot(dir[0], dir[2])
  const dx = h > 1e-6 ? dir[0] / h : 0, dz = h > 1e-6 ? dir[2] / h : 0
  const reach = Math.max(speed * lookahead, 300)
  let max = ground(pos[0], pos[2])
  for (let i = 1; i <= 5; i++) {
    const d = (reach * i) / 5
    max = Math.max(max, ground(pos[0] + dx * d, pos[2] + dz * d))
  }
  return max
}

/**
 * Enforce terrain clearance, ceiling, map boundary and enemy-safe-zone avoidance on a desired aim (mutates aim).
 * `team` = own team (enemy bases are avoided); pass null to skip base avoidance.
 */
export function applyAimSafety(
  aim: Vec3, pos: Vec3, vel: Vec3, world: WorldQuery, clearance: number, lookahead: number, team: number | null,
): Vec3 {
  norm(aim)
  // Boundary: turn back toward the center when close to the edge.
  const margin = Math.min(1_500, world.half * 0.15)
  const edge = Math.max(Math.abs(pos[0]), Math.abs(pos[2])) - (world.half - margin)
  if (edge > 0) {
    const cx = -pos[0], cz = -pos[2]
    const cl = Math.hypot(cx, cz) || 1
    const w = clamp(edge / margin + 0.3, 0, 1)
    const p = pitchOf(aim)
    const hx = aim[0] * (1 - w) + (cx / cl) * w, hz = aim[2] * (1 - w) + (cz / cl) * w
    withPitch([hx, 0, hz], p, aim, [cx, 0, cz])
  }
  // Enemy safe zones: no point flying in (targets are invulnerable there).
  if (team !== null) {
    for (const base of AIRBASES) {
      if (base.team === team) continue
      const bx = pos[0] - base.center[0], bz = pos[2] - base.center[2]
      const r = Math.hypot(bx, bz)
      const keep = base.safeRadius + 700
      if (r < keep && r > 1e-3) {
        // Remove the component of the aim heading that points into the zone.
        const inward = -(aim[0] * bx + aim[2] * bz) / r
        if (inward > 0) {
          const p = pitchOf(aim)
          withPitch([aim[0] + (bx / r) * inward * 1.2, 0, aim[2] + (bz / r) * inward * 1.2], p, aim, [bx, 0, bz])
        }
      }
    }
  }
  // Terrain: never aim below the pitch needed to clear terrain ahead.
  const minPitch = terrainMinPitch(pos, vel, (x, z) => world.groundHeight(x, z), clearance, lookahead, aim)
  let p = pitchOf(aim)
  if (p < minPitch) p = minPitch
  // Ceiling.
  if (pos[1] > world.ceiling - 400) p = Math.min(p, -0.08)
  else if (pos[1] > world.ceiling - 900) p = Math.min(p, 0.05)
  if (p !== pitchOf(aim)) withPitch(aim, p, aim)
  return aim
}

// ---------------------------------------------------------------------------------------------
// Perception

function speedOf(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2])
}

function canEngage(target: VehicleEntity, myTeam: number): boolean {
  return target.alive && target.team !== myTeam && !target.flight.crashed && !inSafeZone(target.team, target.flight.position)
}

/** Score-based target choice: nearest, prefers spotted, threatening, damaged and the current target. */
export function selectTarget(
  self: VehicleEntity, vehicles: VehicleEntity[], now: number, maxRange: number, currentId: string | null,
): VehicleEntity | null {
  const me = self.flight.position
  const heli = VEHICLES[self.kind].flight === "heli"
  let best: VehicleEntity | null = null
  let bestScore = Infinity
  for (const v of vehicles) {
    if (v === self || !canEngage(v, self.team)) continue
    const d = dist(me, v.flight.position)
    const spotted = v.spottedUntil > now
    if (d > maxRange || (!spotted && d > BOT_VISUAL_RANGE)) continue
    let score = d
    if (spotted) score *= 0.75
    if (v.id === currentId) score *= 0.6
    score *= 0.6 + 0.4 * (v.hp / Math.max(v.maxHp, 1))
    // Threat: enemy close and pointing at us.
    if (d < 1_800) {
      const f = forward(v.flight.orientation)
      const tx = me[0] - v.flight.position[0], ty = me[1] - v.flight.position[1], tz = me[2] - v.flight.position[2]
      if ((f[0] * tx + f[1] * ty + f[2] * tz) / Math.max(d, 1) > 0.9) score *= 0.5
    }
    if (heli && speedOf(v.flight.velocity) > 150) score *= 1.6
    if (score < bestScore) { bestScore = score; best = v }
  }
  return best
}

/** Most urgent missile homing on (or steered at) this vehicle, or null. */
export function findThreat(self: VehicleEntity, missiles: readonly Missile[] | undefined): Missile | null {
  if (!missiles) return null
  const me = self.flight.position
  let best: Missile | null = null
  let bestD = Infinity
  for (const m of missiles) {
    if (m.team === self.team) continue
    const d = dist(me, m.position)
    let homing = m.target === self.id
    if (!homing && m.steered && d < 2_000) {
      const to: Vec3 = [me[0] - m.position[0], me[1] - m.position[1], me[2] - m.position[2]]
      homing = angleBetween(m.velocity, to) < 0.2
    }
    if (homing && d < bestD) { bestD = d; best = m }
  }
  return best
}

// ---------------------------------------------------------------------------------------------
// Per-tick control

const EMPTY_SEAT: SeatInput = { aim: null, firePrimary: false, fireSecondary: false, flares: false, ability: false }

function neutral(): { flight?: FlightInput; seat: SeatInput } {
  return { seat: { ...EMPTY_SEAT } }
}

function updateJitter(brain: BotBrain, now: number): void {
  const s = brain.state
  if (now < s.jitterUntil) return
  const amp = (1 - s.skill) * 0.06 + 0.002
  s.jitterYaw = (botRandom(brain) * 2 - 1) * amp
  s.jitterPitch = (botRandom(brain) * 2 - 1) * amp
  s.jitterUntil = now + 0.3 + botRandom(brain) * 0.5
}

function applyJitter(brain: BotBrain, aim: Vec3): Vec3 {
  const s = brain.state
  const c = Math.cos(s.jitterYaw), sn = Math.sin(s.jitterYaw)
  const x = aim[0] * c + aim[2] * sn, z = -aim[0] * sn + aim[2] * c
  aim[0] = x; aim[2] = z
  return withPitch(aim, clamp(pitchOf(aim) + s.jitterPitch, -1.5, 1.5), aim)
}

function reactionDelay(brain: BotBrain): number {
  return 0.15 + (1 - brain.state.skill) * 0.8
}

function weaponReady(rt: { ammo: number; readyAt: number } | undefined, now: number): boolean {
  return !rt || (rt.ammo > 0 && rt.readyAt <= now)
}

function effectiveRange(w: WeaponSpec): number {
  switch (w.kind) {
    case "gun": return Math.min(w.speed * w.ttl * 0.6, 1_400)
    case "rockets": return Math.min(w.speed * w.ttl * 0.45, 1_300)
    case "missile_ir": return w.speed * w.ttl * 0.75
    case "missile_long": return w.speed * w.ttl * 0.85
    case "missile_steered": return w.speed * w.ttl * 0.7
    case "pulse": return 4_000
  }
}

function resetForVehicle(brain: BotBrain, vehicle: VehicleEntity): void {
  const s = brain.state
  s.vehicleId = vehicle.id
  s.phase = vehicle.flight.onGround ? "takeoff" : "transit"
  const f = forward(vehicle.flight.orientation)
  const h = Math.hypot(f[0], f[2])
  s.runwayDir = h > 1e-6 ? [f[0] / h, f[2] / h] : [0, -1]
  s.targetId = null
  s.retargetAt = 0
  s.waypointUntil = 0
  s.threatId = null
  s.extendUntil = 0
  s.guideTargetId = null
  s.guideUntil = 0
  s.breakSign = botRandom(brain) < 0.5 ? -1 : 1
}

/**
 * Compute this tick's input for a bot occupying `vehicle` in its seat.
 * `missiles` (optional) enables missile-threat reactions and steered-missile guidance tracking;
 * `world` defaults to the shared geography.
 */
export function botInput(
  brain: BotBrain, bot: PlayerInfo, vehicle: VehicleEntity, vehicles: VehicleEntity[], now: number,
  missiles?: readonly Missile[], world: WorldQuery = worldQuery,
): { flight?: FlightInput; seat: SeatInput } {
  if (!vehicle.alive || vehicle.flight.crashed) return bot.seat === 0 ? { flight: { ...NEUTRAL_INPUT }, seat: { ...EMPTY_SEAT } } : neutral()
  if (brain.state.vehicleId !== vehicle.id) resetForVehicle(brain, vehicle)
  updateJitter(brain, now)
  if (bot.seat === 0) return pilotInput(brain, bot, vehicle, vehicles, now, missiles, world)
  if (bot.seat === 1) return { seat: gunnerInput(brain, bot, vehicle, vehicles, now, missiles) }
  return neutral()
}

// ---------------------------------------------------------------------------------------------
// Pilot

function throttleToward(fs: FlightState, desired: number): number {
  return clamp((desired - fs.throttle) * 4, -1, 1)
}

function pickWaypoint(brain: BotBrain, now: number, heli: boolean): void {
  const s = brain.state
  const ang = botRandom(brain) * Math.PI * 2
  const r = botRandom(brain) * (heli ? 3_000 : 4_500)
  s.waypoint = [Math.cos(ang) * r, heli ? 250 : 1_000 + botRandom(brain) * 800, Math.sin(ang) * r]
  s.waypointUntil = now + 20 + botRandom(brain) * 20
}

function pilotInput(
  brain: BotBrain, bot: PlayerInfo, vehicle: VehicleEntity, vehicles: VehicleEntity[], now: number,
  missiles: readonly Missile[] | undefined, world: WorldQuery,
): { flight: FlightInput; seat: SeatInput } {
  const s = brain.state
  const spec = VEHICLES[vehicle.kind]
  const heli = spec.flight === "heli"
  const fs = vehicle.flight
  const pos = fs.position, vel = fs.velocity
  const fwd = forward(fs.orientation)
  const speed = speedOf(vel)
  const ground = world.groundHeight(pos[0], pos[2])
  const agl = pos[1] - ground

  const flight: FlightInput = { aim: null, throttle: 0, roll: 0, yaw: 0, pitch: 0, boost: false, brake: false }
  const seat: SeatInput = { aim: null, firePrimary: false, fireSecondary: false, flares: false, ability: false }
  const aim: Vec3 = [fwd[0], fwd[1], fwd[2]]
  let desiredThrottle = 0.8
  let heliAlt = pos[1]
  let clearance = heli ? 45 : 160
  const lookahead = heli ? 4 : 7

  // Phase bookkeeping.
  if (fs.onGround && s.phase !== "takeoff" && agl < 5) s.phase = "takeoff"
  if (s.phase === "takeoff" && !fs.onGround && agl > (heli ? 80 : 150)) s.phase = "transit"

  // --- Takeoff
  if (s.phase === "takeoff") {
    const rd = s.runwayDir
    if (heli) {
      withPitch([rd[0], 0, rd[1]], 0, aim)
      heliAlt = ground + 100
      flight.brake = agl < 60
    } else {
      const rotate = speed >= spec.stall * 1.1
      const pitch = fs.onGround ? (rotate ? 0.2 : 0) : 0.22
      withPitch([rd[0], 0, rd[1]], pitch, aim)
      desiredThrottle = 1
      clearance = 30
      if (!fs.onGround) applyAimSafety(aim, pos, vel, world, clearance, lookahead, bot.team)
    }
    return finishPilot(flight, seat, aim, fs, heli, desiredThrottle, heliAlt, ground, world, vel)
  }

  // --- Threat assessment (with reaction delay)
  const threat = findThreat(vehicle, missiles)
  if (threat) {
    if (s.threatId !== threat.id) { s.threatId = threat.id; s.threatSeenAt = now; s.breakSign = botRandom(brain) < 0.5 ? -1 : 1 }
  } else s.threatId = null
  const defending = threat !== null && now >= s.threatSeenAt + reactionDelay(brain)

  // --- Target selection
  if (now >= s.retargetAt || (s.targetId && !vehicles.some(v => v.id === s.targetId && canEngage(v, vehicle.team)))) {
    const maxRange = vehicle.kind === "blackbird" ? 14_000 : heli ? 5_000 : 9_000
    const t = selectTarget(vehicle, vehicles, now, maxRange, s.targetId)
    s.targetId = t ? t.id : null
    s.retargetAt = now + 0.4 + (1 - s.skill) * 1.2 + botRandom(brain) * 0.3
  }
  const target = s.targetId ? vehicles.find(v => v.id === s.targetId) ?? null : null
  const inOwnSafe = inSafeZone(vehicle.team, pos)

  if (defending && threat) {
    s.phase = "defend"
    // Beam the missile: turn perpendicular to its line of sight, dive if altitude allows.
    const lx = pos[0] - threat.position[0], lz = pos[2] - threat.position[2]
    const l = Math.hypot(lx, lz) || 1
    const px = -lz / l * s.breakSign, pz = lx / l * s.breakSign
    withPitch([px, 0, pz], agl > 600 ? -0.2 : 0.1, aim)
    desiredThrottle = 1
    flight.boost = true
    const md = dist(pos, threat.position)
    if (threat.target === vehicle.id && md < 1_800 && vehicle.flareCount > 0 && vehicle.flaresReadyAt <= now) seat.flares = true
    heliAlt = Math.max(ground + 40, pos[1] - 30)
  } else if (target) {
    s.phase = "engage"
    desiredThrottle = engage(brain, vehicle, target, now, aim, flight, seat, inOwnSafe)
    if (heli) {
      const tp = target.flight.position
      heliAlt = clamp(tp[1], ground + 60, ground + 900)
    }
  } else {
    s.phase = "transit"
    if (now >= s.waypointUntil || Math.hypot(pos[0] - s.waypoint[0], pos[2] - s.waypoint[2]) < (heli ? 400 : 1_200)) pickWaypoint(brain, now, heli)
    const wp = s.waypoint
    const dx = wp[0] - pos[0], dz = wp[2] - pos[2]
    const hd = Math.hypot(dx, dz)
    if (heli) {
      heliAlt = ground + wp[1]
      withPitch([dx, 0, dz], hd > 300 ? -0.15 : 0, aim, fwd)
      desiredThrottle = 0.8
      flight.boost = hd > 4_000
    } else {
      const alt = Math.max(wp[1], ground + 500)
      withPitch([dx, 0, dz], clamp(Math.atan2(alt - pos[1], 2_000), -0.3, 0.35), aim, fwd)
      desiredThrottle = 0.85
      flight.boost = hd > 6_000 && speed < spec.cruise * 1.2
    }
  }

  if (s.phase === "engage") applyJitter(brain, aim)
  applyAimSafety(aim, pos, vel, world, clearance, lookahead, bot.team)
  // Never take the ship below stall speed in jets.
  if (!heli && speed < spec.stall * 1.3) { desiredThrottle = 1; flight.boost = true }
  return finishPilot(flight, seat, aim, fs, heli, desiredThrottle, heliAlt, ground, world, vel)
}

function finishPilot(
  flight: FlightInput, seat: SeatInput, aim: Vec3, fs: FlightState, heli: boolean, desiredThrottle: number,
  heliAlt: number, ground: number, world: WorldQuery, vel: Vec3,
): { flight: FlightInput; seat: SeatInput } {
  norm(aim)
  if (heli) {
    const floor = groundAhead(fs.position, aim, Math.hypot(vel[0], vel[2]), (x, z) => world.groundHeight(x, z), 4) + 45
    const alt = clamp(Math.max(heliAlt, floor), ground + 10, world.ceiling - 300)
    flight.throttle = clamp((alt - fs.position[1]) * 0.03 - vel[1] * 0.25, -1, 1)
  } else {
    flight.throttle = throttleToward(fs, desiredThrottle)
  }
  flight.aim = [aim[0], aim[1], aim[2]]
  seat.aim = [aim[0], aim[1], aim[2]]
  sanitizeFlight(flight)
  return { flight, seat }
}

function engage(
  brain: BotBrain, vehicle: VehicleEntity, target: VehicleEntity, now: number,
  aim: Vec3, flight: FlightInput, seat: SeatInput, inOwnSafe: boolean,
): number {
  const s = brain.state
  const spec = VEHICLES[vehicle.kind]
  const heli = spec.flight === "heli"
  const fs = vehicle.flight
  const pos = fs.position, vel = fs.velocity
  const tp = target.flight.position, tv = target.flight.velocity
  const fwd = forward(fs.orientation)
  const d = dist(pos, tp)
  const toT: Vec3 = [tp[0] - pos[0], tp[1] - pos[1], tp[2] - pos[2]]
  const closing = -((tv[0] - vel[0]) * toT[0] + (tv[1] - vel[1]) * toT[1] + (tv[2] - vel[2]) * toT[2]) / Math.max(d, 1)
  let throttle = 0.85

  const primary = WEAPONS[spec.seatWeapons[0][0]]
  const secondary = WEAPONS[spec.seatWeapons[0][1]]
  // Steer toward the lead point of the primary fixed weapon (or pure pursuit for missile-only ships).
  const steerWeapon = primary.kind === "gun" || primary.kind === "rockets" ? primary : null
  const lead: Vec3 = [0, 0, 0]
  if (steerWeapon && d < 2_500) {
    leadDirection(pos, vel, tp, tv, steerWeapon.speed, BOT_GRAVITY, lead)
  } else {
    lead[0] = toT[0]; lead[1] = toT[1]; lead[2] = toT[2]
    norm(lead)
  }

  const blackbird = vehicle.kind === "blackbird"
  if (blackbird && (now < s.extendUntil || d < 1_500)) {
    // Extend away after a shot or when too close, then turn back in.
    if (now >= s.extendUntil) s.extendUntil = now + 5 + botRandom(brain) * 3
    withPitch([-toT[0], 0, -toT[2]], 0.05, aim, fwd)
    flight.boost = true
    throttle = 1
  } else if (heli) {
    // Stand off and point the nose (rockets) at the target.
    aim[0] = lead[0]; aim[1] = lead[1]; aim[2] = lead[2]
    const hd = Math.hypot(toT[0], toT[2])
    if (hd > 1_500) {
      withPitch(toT, -0.15, aim)
      flight.boost = hd > 3_000
    } else if (hd < 500) {
      // Too close: turn broadside and slide away.
      withPitch([-toT[2] * s.breakSign, 0, toT[0] * s.breakSign], 0, aim)
    } else {
      flight.brake = true
      withPitch(aim, clamp(pitchOf(aim), -0.5, 0.5), aim)
    }
    throttle = 0.8
  } else {
    aim[0] = lead[0]; aim[1] = lead[1]; aim[2] = lead[2]
    if (d < 180 && closing > 0) {
      // Collision avoidance: break up and to the side.
      withPitch([-toT[2] * s.breakSign, 0, toT[0] * s.breakSign], 0.4, aim)
    }
    if (d > 3_000) { throttle = 1; flight.boost = true }
    else if (d > 1_200) throttle = 1
    else if (d < 600 && closing > 40) { throttle = 0.35; flight.brake = closing > 80 }
    else throttle = 0.8
  }
  if (inOwnSafe) return throttle
  // --- Fire control (pilot weapons)
  const slots: [WeaponSpec, number][] = [[primary, 0], [secondary, 1]]
  for (const [w, slot] of slots) {
    const rt = vehicle.weapons[0][slot]
    if (!weaponReady(rt, now)) continue
    const range = effectiveRange(w)
    if (w.kind === "gun" || w.kind === "rockets") {
      if (d > range) continue
      const ld: Vec3 = [0, 0, 0]
      leadDirection(pos, vel, tp, tv, w.speed, BOT_GRAVITY, ld)
      const err = angleBetween(fwd, ld)
      const tol = Math.atan2(VEHICLES[target.kind].radius * (w.kind === "rockets" ? 1.2 : 1.6), d) + 0.004 + (1 - s.skill) * 0.01
      if (err < tol) {
        if (slot === 0) seat.firePrimary = true
        else seat.fireSecondary = true
      }
    } else if (w.kind === "missile_ir" || w.kind === "missile_long") {
      if (!rt || rt.lock < 1 || !rt.lockTarget || now - s.lastMissileAt < 3) continue
      const locked = rt.lockTarget === target.id ? target : null
      if (!locked || dist(pos, locked.flight.position) > range) continue
      if (slot === 0) seat.firePrimary = true
      else seat.fireSecondary = true
      s.lastMissileAt = now
      if (blackbird) s.extendUntil = now + 4 + botRandom(brain) * 3
      break
    }
  }
  return throttle
}

function sanitizeFlight(f: FlightInput): void {
  f.throttle = Number.isFinite(f.throttle) ? clamp(f.throttle, -1, 1) : 0
  f.roll = clamp(f.roll, -1, 1)
  f.yaw = clamp(f.yaw, -1, 1)
  f.pitch = clamp(f.pitch, -1, 1)
  if (f.aim && !(Number.isFinite(f.aim[0]) && Number.isFinite(f.aim[1]) && Number.isFinite(f.aim[2]))) f.aim = null
}

// ---------------------------------------------------------------------------------------------
// Gunner / weapons officer (seat 1)

function gunnerInput(
  brain: BotBrain, bot: PlayerInfo, vehicle: VehicleEntity, vehicles: VehicleEntity[], now: number,
  missiles: readonly Missile[] | undefined,
): SeatInput {
  const s = brain.state
  const spec = VEHICLES[vehicle.kind]
  const fs = vehicle.flight
  const pos = fs.position, vel = fs.velocity
  const fwd = forward(fs.orientation)
  const seat: SeatInput = { aim: [fwd[0], fwd[1], fwd[2]], firePrimary: false, fireSecondary: false, flares: false, ability: false }
  const weps = spec.seatWeapons[1].map(id => WEAPONS[id])
  const inOwnSafe = inSafeZone(vehicle.team, pos)

  // Radar officer: pulse when enemies are near.
  if (weps[0].kind === "pulse") {
    let near: VehicleEntity | null = null
    let nd = Infinity
    let unspotted = false
    for (const v of vehicles) {
      if (!v.alive || v.team === vehicle.team) continue
      const d = dist(pos, v.flight.position)
      if (d < 4_000) { if (v.spottedUntil <= now) unspotted = true; if (d < nd) { nd = d; near = v } }
    }
    if (near) {
      const a: Vec3 = [near.flight.position[0] - pos[0], near.flight.position[1] - pos[1], near.flight.position[2] - pos[2]]
      seat.aim = applyJitter(brain, norm(a))
    }
    const rt = vehicle.weapons[1][0]
    const ready = weaponReady(rt, now) && vehicle.abilityReadyAt <= now && now - s.lastPulseAt > 2
    if (near && unspotted && ready) {
      seat.firePrimary = true
      seat.ability = true
      s.lastPulseAt = now
    }
    return seat
  }

  // Track our own steered missile in flight.
  let myMissile: Missile | null = null
  if (missiles) {
    for (const m of missiles) if (m.steered && m.owner === bot.id && m.vehicle === vehicle.id) { myMissile = m; break }
    if (!myMissile && now - s.lastMissileAt > 0.5) s.guideUntil = Math.min(s.guideUntil, now)
  }
  const guiding = myMissile !== null || now < s.guideUntil

  if (!guiding && now >= s.retargetAt) {
    const maxRange = Math.max(...weps.map(effectiveRange))
    const t = selectTarget(vehicle, vehicles, now, maxRange, s.targetId)
    s.targetId = t ? t.id : null
    s.retargetAt = now + 0.3 + (1 - s.skill) * 1.0 + botRandom(brain) * 0.3
  }
  const targetId = guiding ? s.guideTargetId ?? s.targetId : s.targetId
  const target = targetId ? vehicles.find(v => v.id === targetId && v.alive) ?? null : null
  if (!target) { s.guideUntil = Math.min(s.guideUntil, now); return seat }
  const tp = target.flight.position, tv = target.flight.velocity
  const d = dist(pos, tp)
  const aim: Vec3 = [0, 0, 0]

  if (guiding) {
    // Keep the seeker on the target, leading by the missile's remaining flight time.
    const src = myMissile ? myMissile.position : pos
    const mw = WEAPONS[myMissile ? myMissile.weapon : (weps.find(w => w.kind === "missile_steered") ?? weps[0]).id]
    const eta = dist(src, tp) / Math.max(mw.speed, 1)
    const px = tp[0] + tv[0] * eta * 0.5, py = tp[1] + tv[1] * eta * 0.5, pz = tp[2] + tv[2] * eta * 0.5
    aim[0] = px - pos[0]; aim[1] = py - pos[1]; aim[2] = pz - pos[2]
    norm(aim)
    seat.aim = applyJitter(brain, aim)
    return seat
  }

  const canFire = !inOwnSafe && canEngage(target, vehicle.team)
  // Prefer the turret gun when in range, otherwise launch a steered missile.
  for (let slot = 0; slot < 2; slot++) {
    const w = weps[slot]
    const rt = vehicle.weapons[1][slot]
    const range = effectiveRange(w)
    if (w.kind === "gun" && d <= range) {
      leadDirection(pos, vel, tp, tv, w.speed, BOT_GRAVITY, aim)
      seat.aim = applyJitter(brain, aim)
      // Turret tracks instantly; fire when the commanded aim is near the true lead (skill-limited).
      const err = Math.hypot(s.jitterYaw, s.jitterPitch)
      const tol = Math.atan2(VEHICLES[target.kind].radius * 1.6, d) + 0.004
      if (canFire && weaponReady(rt, now) && err < tol) {
        if (slot === 0) seat.firePrimary = true
        else seat.fireSecondary = true
      }
      return seat
    }
    if (w.kind === "missile_steered" && d <= range && d > 250) {
      aim[0] = tp[0] - pos[0]; aim[1] = tp[1] - pos[1]; aim[2] = tp[2] - pos[2]
      norm(aim)
      seat.aim = applyJitter(brain, aim)
      if (canFire && weaponReady(rt, now) && now - s.lastMissileAt > 1.5) {
        if (slot === 0) seat.firePrimary = true
        else seat.fireSecondary = true
        s.lastMissileAt = now
        s.guideTargetId = target.id
        s.guideUntil = now + Math.min(w.ttl, d / w.speed * 1.5 + 1)
      }
      return seat
    }
  }
  // Out of range: just track the target.
  aim[0] = tp[0] - pos[0]; aim[1] = tp[1] - pos[1]; aim[2] = tp[2] - pos[2]
  seat.aim = applyJitter(brain, norm(aim))
  return seat
}
