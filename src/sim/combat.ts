// Weapons, missiles, flares, radar and damage. Pure, deterministic, dependency-free.
// Runs on the authoritative server and in the browser's offline mode at 60 Hz.
//
// Call order per tick (room engine): stepFlight for every vehicle → applySeatInput for every occupied
// seat → stepCombat once. Hit detection back-projects vehicles by `velocity * dt`, so it is correct when
// stepCombat runs after vehicles have moved this tick.
//
// Missiles:
// - missile_lock (aim9, tvmissile, hellfire, maverick): hold the seeker axis (pilot: nose, gunner: seat aim)
//   on an enemy for lockTime → locked; fire → fire-and-forget proportional-navigation homing.
// - missile_scanner (aim47): the radar officer's scanner (seat aim) builds the lock; after launch the missile
//   is semi-active — it homes only while the scanner stays within lockCone × SCANNER_CONE_MARGIN of its
//   target. Off target for > SCANNER_GRACE s → guidance lost (`target` becomes null, flies straight); it
//   re-acquires if the scanner returns to the same target while that target is inside the missile's seeker view.
// Flares: lock missiles are decoyed with a deterministic chance (better at range). Scanner missiles ignore
//   flares while the scanner is on target, unless the missile is within SCANNER_FLARE_CLOSE m (terminal seeker).
import type {
  Flare, GameEvent, Missile, Projectile, Quat, SeatIndex, SeatInput, Vec3, VehicleEntity, VehicleKind,
  WeaponId, WeaponRuntime,
} from "./types"
import { TICK_DT } from "./types"
import { VEHICLES, WEAPONS, type WeaponSpec } from "./vehicles"
import { inSafeZone, segmentHitsGround } from "./geography"

// ---------------------------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------------------------

export const MAX_PROJECTILES = 2000
export const MAX_MISSILES = 256
export const MAX_FLARES = 256

/** Damage multiplier while radar-spotted. */
export const SPOTTED_DAMAGE_MULT = 1.2
/** Damage taken multiplier per airframe (A-10 titanium bathtub). */
export const ARMOR: Record<VehicleKind, number> = { fighter: 1, apache: 1, warthog: 0.8, blackbird: 1 }
/** Per-weapon damage multiplier applied on top of WEAPONS[w].damage. */
export const WEAPON_DAMAGE_MULT: Record<WeaponId, number> = {
  cannon20: 1.55, chaingun30: 1.1, gau8: 1, rockets: 1, aim9: 1, tvmissile: 1, hellfire: 1, maverick: 1,
  aim47: 1, radarpulse: 0,
}
/** Weapon-vs-airframe bonuses (chain gun shreds helicopters and slow planes). */
export const CLASS_BONUS: Partial<Record<WeaponId, Partial<Record<VehicleKind, number>>>> = {
  chaingun30: { apache: 1.6, warthog: 1.4 },
}

export interface MissileTuning {
  maxSpeed: number
  /** Motor burn seconds; after burn the missile coasts and decelerates. */
  burn: number
  accel: number
  coastDecel: number
  /** Proximity fuse distance added to the target radius. */
  fuse: number
  /** Max off-boresight angle (rad) of the missile's own seeker (lost beyond it, after MISSILE_LOAL_TIME). */
  gimbal: number
  /** Chance a flare burst decoys this missile when the target is near / beyond `farDist`. */
  flareNear: number
  flareFar: number
  farDist: number
}

export const MISSILE_TUNING: Partial<Record<WeaponId, MissileTuning>> = {
  aim9: { maxSpeed: 750, burn: 2.5, accel: 220, coastDecel: 30, fuse: 6, gimbal: 1.2, flareNear: 0.7, flareFar: 0.85, farDist: 1500 },
  // Radar-guided: flares are less effective.
  tvmissile: { maxSpeed: 700, burn: 3, accel: 160, coastDecel: 25, fuse: 6, gimbal: 1.0, flareNear: 0.45, flareFar: 0.6, farDist: 1500 },
  hellfire: { maxSpeed: 450, burn: 3, accel: 100, coastDecel: 20, fuse: 4, gimbal: 1.0, flareNear: 0.65, flareFar: 0.8, farDist: 1200 },
  maverick: { maxSpeed: 480, burn: 3, accel: 100, coastDecel: 20, fuse: 4, gimbal: 1.0, flareNear: 0.6, flareFar: 0.75, farDist: 1500 },
  // Scanner: flareNear applies only inside SCANNER_FLARE_CLOSE; flareFar when the scanner is off target.
  aim47: { maxSpeed: 800, burn: 4, accel: 110, coastDecel: 10, fuse: 10, gimbal: 1.0, flareNear: 0.6, flareFar: 0.9, farDist: 0 },
}

/** Turret arcs in the vehicle body frame (rad). Yaw 0 = nose, elevation 0 = horizon. */
export const TURRET_ARCS: Partial<Record<WeaponId, { yaw: number; minEl: number; maxEl: number }>> = {
  chaingun30: { yaw: (110 * Math.PI) / 180, minEl: (-85 * Math.PI) / 180, maxEl: (12 * Math.PI) / 180 },
}

export const PROPORTIONAL_NAV_GAIN = 4
export const MISSILE_MIN_SPEED = 120
/** Seconds after launch before a missile's own gimbal limit applies (lets turret locks turn off the rail). */
export const MISSILE_LOAL_TIME = 1
export const ROCKET_GRAVITY = 9.81

/** Scanner guidance: allowed scanner error = lockCone × margin; guidance lost after this many seconds off. */
export const SCANNER_CONE_MARGIN = 1.3
export const SCANNER_GRACE = 1.5
/** Within this distance of its target a scanner missile's terminal seeker can be flared even when painted. */
export const SCANNER_FLARE_CLOSE = 1000

export const FLARE_COOLDOWN = 2.5
export const FLARES_PER_BURST = 3
export const FLARE_TTL = 3.5
export const FLARE_TARGET_PREFIX = "flare:"

/** Seat-2 "mark target" ability for crews without a radar pulse. */
export const MARK_COOLDOWN = 10
export const MARK_DURATION = 8
export const MARK_RANGE = 4000
export const MARK_CONE = 0.08

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

export interface CombatState {
  projectiles: Projectile[]
  missiles: Missile[]
  flares: Flare[]
  nextId: number
}

export function createCombatState(): CombatState {
  return { projectiles: [], missiles: [], flares: [], nextId: 1 }
}

/** Server-side extras on WeaponRuntime (not needed on the wire). */
interface RuntimeExt extends WeaponRuntime {
  /** Room time of the last shot (regen starts refillDelay later). */
  firedAt?: number
  /** Fractional regenerated ammo not yet added to `ammo`. */
  regen?: number
}

/** Server-side extras on Missile (scanner guidance). */
interface MissileExt extends Missile {
  /** Scanner missiles: the designated target (kept while `target` is null after guidance loss). */
  scanTarget?: string | null
  /** Scanner missiles: seconds the scanner has been off target. */
  scanOff?: number
}

/**
 * Fresh weapon runtimes, always two per seat (index = slot). Null slots get an empty placeholder (ammo 0).
 * Unlimited ammo is -1.
 */
export function createWeapons(kind: VehicleKind): [WeaponRuntime[], WeaponRuntime[]] {
  const seats = VEHICLES[kind].seatWeapons
  const mk = (id: WeaponId | null): WeaponRuntime => {
    const ammo = id ? WEAPONS[id].ammo : 0
    const rt: RuntimeExt = { ammo: Number.isFinite(ammo) ? ammo : -1, readyAt: 0, lockTarget: null, lock: 0, firedAt: -1e9, regen: 0 }
    return rt
  }
  return [seats[0].map(mk), seats[1].map(mk)]
}

/** Magazine size (-1 unlimited). */
export function magazine(weapon: WeaponId): number {
  const a = WEAPONS[weapon].ammo
  return Number.isFinite(a) ? a : -1
}

/** Hardpoint index (0-based, alternating) of the missile/rocket launched when ammo dropped to `ammoAfter`. */
export function launchedHardpoint(weapon: WeaponId, ammoAfter: number): number {
  return ((((WEAPONS[weapon].ammo - ammoAfter - 1) % 2) + 2) % 2)
}

export function isHostile(a: VehicleEntity, b: VehicleEntity): boolean {
  return a.team !== b.team
}

function isLockKind(spec: WeaponSpec): boolean {
  return spec.kind === "missile_lock" || spec.kind === "missile_scanner"
}

// ---------------------------------------------------------------------------------------------
// Math helpers (allocation-free; write into `out`)
// ---------------------------------------------------------------------------------------------

function rotate(q: Quat, x: number, y: number, z: number, out: Vec3): Vec3 {
  const qx = q[0], qy = q[1], qz = q[2], qw = q[3]
  const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x)
  out[0] = x + qw * tx + (qy * tz - qz * ty)
  out[1] = y + qw * ty + (qz * tx - qx * tz)
  out[2] = z + qw * tz + (qx * ty - qy * tx)
  return out
}

function rotateInv(q: Quat, x: number, y: number, z: number, out: Vec3): Vec3 {
  const qx = -q[0], qy = -q[1], qz = -q[2], qw = q[3]
  const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x)
  out[0] = x + qw * tx + (qy * tz - qz * ty)
  out[1] = y + qw * ty + (qz * tx - qx * tz)
  out[2] = z + qw * tz + (qx * ty - qy * tx)
  return out
}

function len(v: Vec3): number {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
}

function normalizeInto(v: Vec3, out: Vec3): boolean {
  const l = len(v)
  if (!(l > 1e-9)) return false
  out[0] = v[0] / l
  out[1] = v[1] / l
  out[2] = v[2] / l
  return true
}

function dist(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2]
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

/** Rotate unit vector `dir` toward unit vector `target` by at most `maxAngle` (in place on dir). */
function turnToward(dir: Vec3, target: Vec3, maxAngle: number): void {
  let c = dir[0] * target[0] + dir[1] * target[1] + dir[2] * target[2]
  if (c > 1) c = 1
  else if (c < -1) c = -1
  const theta = Math.acos(c)
  if (theta <= maxAngle) {
    dir[0] = target[0]; dir[1] = target[1]; dir[2] = target[2]
    return
  }
  // Perpendicular component of target relative to dir.
  let px = target[0] - dir[0] * c, py = target[1] - dir[1] * c, pz = target[2] - dir[2] * c
  let pl = Math.sqrt(px * px + py * py + pz * pz)
  if (pl < 1e-6) {
    // Opposite direction: pick any perpendicular.
    if (Math.abs(dir[1]) < 0.9) { px = -dir[2]; py = 0; pz = dir[0] } else { px = 0; py = dir[2]; pz = -dir[1] }
    pl = Math.sqrt(px * px + py * py + pz * pz)
  }
  const cs = Math.cos(maxAngle), sn = Math.sin(maxAngle) / pl
  dir[0] = dir[0] * cs + px * sn
  dir[1] = dir[1] * cs + py * sn
  dir[2] = dir[2] * cs + pz * sn
  const l = Math.sqrt(dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2])
  dir[0] /= l; dir[1] /= l; dir[2] /= l
}

/** Deterministic hash → [0, 1). */
function hash01(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35)
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d)
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

/** Apply a deterministic cone spread (radius `spread` rad) to unit vector `dir` in place. */
function applySpread(dir: Vec3, spread: number, seed: number): void {
  if (spread <= 0) return
  const r = spread * Math.sqrt(hash01(seed, 1)), a = 2 * Math.PI * hash01(seed, 2)
  // Basis perpendicular to dir.
  let ux = 0, uy = 1, uz = 0
  if (Math.abs(dir[1]) > 0.99) { ux = 1; uy = 0 }
  let rx = dir[1] * uz - dir[2] * uy, ry = dir[2] * ux - dir[0] * uz, rz = dir[0] * uy - dir[1] * ux
  const rl = Math.sqrt(rx * rx + ry * ry + rz * rz)
  rx /= rl; ry /= rl; rz /= rl
  const vx = ry * dir[2] - rz * dir[1], vy = rz * dir[0] - rx * dir[2], vz = rx * dir[1] - ry * dir[0]
  const ca = Math.cos(a) * r, sa = Math.sin(a) * r
  dir[0] += rx * ca + vx * sa
  dir[1] += ry * ca + vy * sa
  dir[2] += rz * ca + vz * sa
  const l = Math.sqrt(dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2])
  dir[0] /= l; dir[1] /= l; dir[2] /= l
}

/**
 * First contact fraction [0,1] of a point moving p0→p1 against a sphere of radius r whose center is at
 * c1 now and moved with velocity cv over dt (relative motion, so fast jets don't tunnel). -1 = miss.
 */
export function sweptSphere(p0: Vec3, p1: Vec3, c1: Vec3, cv: Vec3, dt: number, r: number): number {
  const sx = p0[0] - (c1[0] - cv[0] * dt), sy = p0[1] - (c1[1] - cv[1] * dt), sz = p0[2] - (c1[2] - cv[2] * dt)
  const dx = p1[0] - c1[0] - sx, dy = p1[1] - c1[1] - sy, dz = p1[2] - c1[2] - sz
  const c = sx * sx + sy * sy + sz * sz - r * r
  if (c <= 0) return 0
  const a = dx * dx + dy * dy + dz * dz
  if (a < 1e-12) return -1
  const b = 2 * (sx * dx + sy * dy + sz * dz)
  if (b >= 0) return -1
  const disc = b * b - 4 * a * c
  if (disc < 0) return -1
  const t = (-b - Math.sqrt(disc)) / (2 * a)
  return t <= 1 ? t : -1
}

// ---------------------------------------------------------------------------------------------
// Public helpers for HUD / client / bots
// ---------------------------------------------------------------------------------------------

/** Effective damage of one direct hit (before safe-zone checks). */
export function damageFor(weapon: WeaponId, target: VehicleEntity, now: number): number {
  const bonus = CLASS_BONUS[weapon]?.[target.kind] ?? 1
  const spotted = target.spottedUntil > now ? SPOTTED_DAMAGE_MULT : 1
  return WEAPONS[weapon].damage * WEAPON_DAMAGE_MULT[weapon] * ARMOR[target.kind] * bonus * spotted
}

/** Firing direction for a weapon: nose for fixed weapons, arc-clamped seat aim for turrets. */
export function weaponDirection(vehicle: VehicleEntity, weapon: WeaponId, aim: Vec3 | null, out: Vec3): Vec3 {
  const q = vehicle.flight.orientation
  const spec = WEAPONS[weapon]
  if (!spec.turret || !aim || spec.kind !== "gun") return rotate(q, 0, 0, -1, out)
  rotateInv(q, aim[0], aim[1], aim[2], out)
  if (!normalizeInto(out, out)) return rotate(q, 0, 0, -1, out)
  const arc = TURRET_ARCS[weapon]
  if (arc) {
    let yaw = Math.atan2(out[0], -out[2])
    let el = Math.asin(Math.max(-1, Math.min(1, out[1])))
    yaw = Math.max(-arc.yaw, Math.min(arc.yaw, yaw))
    el = Math.max(arc.minEl, Math.min(arc.maxEl, el))
    const ce = Math.cos(el)
    out[0] = Math.sin(yaw) * ce
    out[1] = Math.sin(el)
    out[2] = -Math.cos(yaw) * ce
  }
  return rotate(q, out[0], out[1], out[2], out)
}

/** World-space muzzle / launch position. `hardpoint` alternates missile/rocket rails (0/1). */
export function muzzlePosition(vehicle: VehicleEntity, seat: SeatIndex, weapon: WeaponId, out: Vec3, hardpoint = 0): Vec3 {
  const r = VEHICLES[vehicle.kind].radius
  const spec = WEAPONS[weapon]
  const p = vehicle.flight.position
  if (spec.kind === "gun") {
    if (spec.turret) rotate(vehicle.flight.orientation, 0, -1.6, -r * 0.55, out)
    else rotate(vehicle.flight.orientation, 0, 0, -r * 0.8, out)
  } else {
    const side = hardpoint % 2 === 0 ? -1 : 1
    rotate(vehicle.flight.orientation, side * r * 0.35, -1, -r * 0.1, out)
  }
  out[0] += p[0]; out[1] += p[1]; out[2] += p[2]
  return out
}

/**
 * Gun lead: world point the shooter should aim at so a projectile of `muzzleSpeed` (plus shooter velocity)
 * meets the target. Returns time-to-intercept in seconds, or -1 if no solution (out untouched).
 */
export function leadPoint(shooterPos: Vec3, shooterVel: Vec3, muzzleSpeed: number, targetPos: Vec3, targetVel: Vec3, out: Vec3): number {
  const rx = targetPos[0] - shooterPos[0], ry = targetPos[1] - shooterPos[1], rz = targetPos[2] - shooterPos[2]
  const vx = targetVel[0] - shooterVel[0], vy = targetVel[1] - shooterVel[1], vz = targetVel[2] - shooterVel[2]
  const a = vx * vx + vy * vy + vz * vz - muzzleSpeed * muzzleSpeed
  const b = 2 * (rx * vx + ry * vy + rz * vz)
  const c = rx * rx + ry * ry + rz * rz
  let t: number
  if (Math.abs(a) < 1e-9) {
    if (b >= 0) return -1
    t = -c / b
  } else {
    const disc = b * b - 4 * a * c
    if (disc < 0) return -1
    const s = Math.sqrt(disc)
    const t1 = (-b - s) / (2 * a), t2 = (-b + s) / (2 * a)
    t = t1 > 0 && t2 > 0 ? Math.min(t1, t2) : Math.max(t1, t2)
    if (!(t > 0)) return -1
  }
  out[0] = shooterPos[0] + rx + vx * t
  out[1] = shooterPos[1] + ry + vy * t
  out[2] = shooterPos[2] + rz + vz * t
  return t
}

const _lc: Vec3 = [0, 0, 0]

function seekerAngle(from: Vec3, axis: Vec3, to: Vec3, outDist: { d: number }): number {
  const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2]
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
  outDist.d = d
  if (d < 1e-6) return 0
  const c = (dx * axis[0] + dy * axis[1] + dz * axis[2]) / d
  return Math.acos(Math.max(-1, Math.min(1, c)))
}

const _sd = { d: 0 }

/** Seeker angle if `target` is a valid lock (alive, hostile, unprotected, within range & cone), else -1. */
function lockValid(vehicle: VehicleEntity, spec: WeaponSpec, axis: Vec3, target: VehicleEntity, coneScale: number): number {
  if (!target.alive || target === vehicle || !isHostile(vehicle, target)) return -1
  const range = spec.range ?? 2500
  const cone = (spec.lockCone ?? 0.3) * coneScale
  const tp = target.flight.position
  const ang = seekerAngle(vehicle.flight.position, axis, tp, _sd)
  if (_sd.d > range || ang > cone) return -1
  if (inSafeZone(target.team, tp)) return -1
  return ang
}

/**
 * Seeker axis for a seat's lock weapon: pilots (seat 0) and fixed weapons lock along the nose; gunner
 * turret/scanner weapons along the seat aim (nose if no aim).
 */
export function seekerAxis(vehicle: VehicleEntity, seat: SeatIndex, weapon: WeaponId, aim: Vec3 | null, out: Vec3): Vec3 {
  if (seat !== 0 && WEAPONS[weapon].turret && aim && normalizeInto(aim, out)) return out
  return rotate(vehicle.flight.orientation, 0, 0, -1, out)
}

/** Best lock candidate for a seat's lock weapon (closest to the seeker axis). */
export function lockCandidate(
  vehicle: VehicleEntity, seat: SeatIndex, weapon: WeaponId, aim: Vec3 | null, vehicles: VehicleEntity[],
): VehicleEntity | null {
  const spec = WEAPONS[weapon]
  if (!isLockKind(spec)) return null
  const axis = seekerAxis(vehicle, seat, weapon, aim, _lc)
  let best: VehicleEntity | null = null
  let bestAng = Infinity
  for (let i = 0; i < vehicles.length; i++) {
    const ang = lockValid(vehicle, spec, axis, vehicles[i], 1)
    if (ang >= 0 && ang < bestAng) { bestAng = ang; best = vehicles[i] }
  }
  return best
}

function findVehicle(vehicles: VehicleEntity[], id: string): VehicleEntity | null {
  for (let i = 0; i < vehicles.length; i++) if (vehicles[i].id === id) return vehicles[i]
  return null
}

// ---------------------------------------------------------------------------------------------
// Damage & kills
// ---------------------------------------------------------------------------------------------

/**
 * Destroy a vehicle once: sets alive=false, hp=0 and pushes `kill` + `explosion`. Returns false if it was
 * already dead. For crashes pass reason "crash"; `killer` undefined credits `lastDamagedBy`.
 */
export function killVehicle(vehicle: VehicleEntity, reason: WeaponId | "crash", killer: string | null | undefined, events: GameEvent[]): boolean {
  if (!vehicle.alive) return false
  vehicle.alive = false
  vehicle.hp = 0
  const p = vehicle.flight.position
  events.push({
    type: "kill", victim: vehicle.id, victimTeam: vehicle.team,
    killer: killer === undefined ? vehicle.lastDamagedBy : killer, weapon: reason, position: [p[0], p[1], p[2]],
  })
  events.push({ type: "explosion", position: [p[0], p[1], p[2]], size: VEHICLES[vehicle.kind].radius * 3 })
  return true
}

/** Apply raw (already multiplied) damage. Respects safe zones. Returns damage dealt. */
function dealDamage(target: VehicleEntity, amount: number, weapon: WeaponId, owner: string, pos: Vec3, events: GameEvent[]): number {
  if (!target.alive || amount <= 0) return 0
  if (inSafeZone(target.team, target.flight.position)) return 0
  target.hp -= amount
  target.lastDamagedBy = owner
  events.push({ type: "hit", target: target.id, by: owner, weapon, damage: amount, position: [pos[0], pos[1], pos[2]] })
  if (target.hp <= 0) killVehicle(target, weapon, owner, events)
  return amount
}

/** Splash damage around `pos` (linear falloff from the hull surface), skipping `direct` and friendlies. */
function splash(
  pos: Vec3, weapon: WeaponId, owner: string, team: number, shooterId: string, direct: VehicleEntity | null,
  vehicles: VehicleEntity[], now: number, events: GameEvent[],
): void {
  const radius = WEAPONS[weapon].splash
  if (radius <= 0) return
  for (let i = 0; i < vehicles.length; i++) {
    const v = vehicles[i]
    if (v === direct || !v.alive || v.team === team || v.id === shooterId) continue
    const d = Math.max(0, dist(pos, v.flight.position) - VEHICLES[v.kind].radius)
    if (d >= radius) continue
    dealDamage(v, damageFor(weapon, v, now) * (1 - d / radius), weapon, owner, pos, events)
  }
}

// ---------------------------------------------------------------------------------------------
// Seat input
// ---------------------------------------------------------------------------------------------

const _dir: Vec3 = [0, 0, 0]
const _muz: Vec3 = [0, 0, 0]
const _aim: Vec3 = [0, 0, 0]

/**
 * Apply one seat's weapon input for this tick (assumes one call per seat per TICK_DT): stores the seat aim,
 * updates seeker/scanner locks, fires guns/rockets/missiles, deploys flares and triggers abilities.
 */
export function applySeatInput(
  cs: CombatState, vehicle: VehicleEntity, seat: SeatIndex, input: SeatInput,
  vehicles: VehicleEntity[], now: number, events: GameEvent[],
): void {
  if (!vehicle.alive) return
  const aim = input.aim && normalizeInto(input.aim, _aim) ? _aim : null
  if (aim) {
    const stored = vehicle.aim[seat]
    if (stored) { stored[0] = aim[0]; stored[1] = aim[1]; stored[2] = aim[2] } else vehicle.aim[seat] = [aim[0], aim[1], aim[2]]
  }

  const kinds = VEHICLES[vehicle.kind].seatWeapons[seat]
  const runtimes = vehicle.weapons[seat]

  // Seekers run continuously, whether or not the trigger is held.
  for (let slot = 0; slot < 2; slot++) {
    const id = kinds[slot]
    if (id && runtimes[slot] && isLockKind(WEAPONS[id])) updateLock(vehicle, seat, WEAPONS[id], runtimes[slot], aim, vehicles, events)
  }

  if (input.flares) deployFlares(cs, vehicle, vehicles, now, events)
  if (input.ability) triggerAbility(vehicle, seat, aim, vehicles, now, events)

  const protectedNow = inSafeZone(vehicle.team, vehicle.flight.position)
  for (let slot = 0; slot < 2; slot++) {
    if (!(slot === 0 ? input.firePrimary : input.fireSecondary)) continue
    const id = kinds[slot]
    const rt = runtimes[slot]
    if (!id || !rt) continue
    const spec = WEAPONS[id]
    if (spec.kind === "pulse") { radarPulse(vehicle, seat, vehicles, now, events); continue }
    if (protectedNow) continue
    if (spec.kind === "gun" || spec.kind === "rockets") fireBallistic(cs, vehicle, seat, spec, rt, aim, now, events)
    else fireMissile(cs, vehicle, seat, spec, rt, now, events)
  }
}

function updateLock(
  vehicle: VehicleEntity, seat: SeatIndex, spec: WeaponSpec, rt: WeaponRuntime, aim: Vec3 | null,
  vehicles: VehicleEntity[], events: GameEvent[],
): void {
  const axis = seekerAxis(vehicle, seat, spec.id, aim, _lc)
  let target: VehicleEntity | null = null
  if (rt.lockTarget) {
    const cur = findVehicle(vehicles, rt.lockTarget)
    // Hysteresis: keep the current target slightly beyond the acquisition cone.
    if (cur && lockValid(vehicle, spec, axis, cur, 1.15) >= 0) target = cur
  }
  if (!target) target = lockCandidate(vehicle, seat, spec.id, aim, vehicles)

  const newId = target ? target.id : null
  if (newId !== rt.lockTarget) {
    if (rt.lockTarget && rt.lock >= 1) events.push({ type: "lock", vehicle: vehicle.id, target: rt.lockTarget, locked: false })
    rt.lockTarget = newId
    rt.lock = 0
  }
  if (!target) return
  const was = rt.lock >= 1
  rt.lock = Math.min(1, rt.lock + TICK_DT / (spec.lockTime ?? 1))
  // Float accumulation guard so lockTime/TICK_DT ticks reliably reaches 1.
  if (rt.lock > 1 - 1e-9) rt.lock = 1
  if (!was && rt.lock >= 1) events.push({ type: "lock", vehicle: vehicle.id, target: target.id, locked: true })
}

function ownerOf(vehicle: VehicleEntity, seat: SeatIndex): string {
  return vehicle.seats[seat] ?? vehicle.id
}

function fireBallistic(
  cs: CombatState, vehicle: VehicleEntity, seat: SeatIndex, spec: WeaponSpec, rt: WeaponRuntime,
  aim: Vec3 | null, now: number, events: GameEvent[],
): void {
  const interval = 1 / spec.rate
  const burstStart = rt.readyAt < now - interval
  if (rt.readyAt < now - TICK_DT) rt.readyAt = now
  const sv = vehicle.flight.velocity
  let fired = 0
  while (rt.readyAt <= now + 1e-9 && (rt.ammo < 0 || rt.ammo >= 1) && fired < 8 && cs.projectiles.length < MAX_PROJECTILES) {
    const id = cs.nextId++
    weaponDirection(vehicle, spec.id, aim, _dir)
    applySpread(_dir, spec.spread ?? 0, id)
    const hp = spec.kind === "rockets" ? launchedHardpoint(spec.id, rt.ammo - 1) : 0
    muzzlePosition(vehicle, seat, spec.id, _muz, hp)
    const vx = sv[0] + _dir[0] * spec.speed, vy = sv[1] + _dir[1] * spec.speed, vz = sv[2] + _dir[2] * spec.speed
    // Spawned one tick "behind" so this tick's stepCombat sweeps it from (muzzle - v·dt) to the muzzle in
    // lockstep with vehicles that already moved; `back` also staggers rounds fired earlier within the tick.
    const back = now - rt.readyAt - TICK_DT
    cs.projectiles.push({
      id, weapon: spec.id, owner: ownerOf(vehicle, seat), vehicle: vehicle.id, team: vehicle.team,
      position: [_muz[0] + vx * back, _muz[1] + vy * back, _muz[2] + vz * back],
      velocity: [vx, vy, vz], age: back, ttl: spec.ttl,
    })
    consumeAmmo(rt, now)
    rt.readyAt += interval
    fired++
    if (spec.kind === "rockets") events.push({ type: "fire", vehicle: vehicle.id, seat, weapon: spec.id, hardpoint: hp })
  }
  // Guns: one `fire` event at burst start and every 0.25 s while firing (clients loop audio ~0.3 s).
  if (fired > 0 && spec.kind === "gun" && (burstStart || Math.floor(now * 4) !== Math.floor((now - TICK_DT) * 4))) {
    events.push({ type: "fire", vehicle: vehicle.id, seat, weapon: spec.id })
  }
}

function consumeAmmo(rt: WeaponRuntime, now: number): void {
  const x = rt as RuntimeExt
  if (rt.ammo > 0) rt.ammo--
  x.firedAt = now
  x.regen = 0
}

function fireMissile(
  cs: CombatState, vehicle: VehicleEntity, seat: SeatIndex, spec: WeaponSpec, rt: WeaponRuntime,
  now: number, events: GameEvent[],
): void {
  if (rt.readyAt > now || (rt.ammo >= 0 && rt.ammo < 1) || cs.missiles.length >= MAX_MISSILES) return
  // Holding fire while the seeker is acquiring waits for the lock instead of wasting a dumbfire.
  if (rt.lockTarget && rt.lock < 1) return
  const target = rt.lockTarget && rt.lock >= 1 ? rt.lockTarget : null
  const hp = launchedHardpoint(spec.id, rt.ammo - 1)
  muzzlePosition(vehicle, seat, spec.id, _muz, hp)
  rotate(vehicle.flight.orientation, 0, 0, -1, _dir)
  const sv = vehicle.flight.velocity
  const vx = sv[0] + _dir[0] * spec.speed, vy = sv[1] + _dir[1] * spec.speed, vz = sv[2] + _dir[2] * spec.speed
  const scanner = spec.kind === "missile_scanner"
  // One tick behind the rail, like projectiles (see fireBallistic).
  const m: MissileExt = {
    id: cs.nextId++, weapon: spec.id, owner: ownerOf(vehicle, seat), vehicle: vehicle.id, team: vehicle.team,
    position: [_muz[0] - vx * TICK_DT, _muz[1] - vy * TICK_DT, _muz[2] - vz * TICK_DT],
    velocity: [vx, vy, vz], target, steered: scanner, seat, age: -TICK_DT, ttl: spec.ttl,
  }
  if (scanner) { m.scanTarget = target; m.scanOff = 0 }
  cs.missiles.push(m)
  consumeAmmo(rt, now)
  rt.readyAt = now + 1 / spec.rate
  events.push({ type: "fire", vehicle: vehicle.id, seat, weapon: spec.id, hardpoint: hp })
}

function deployFlares(cs: CombatState, vehicle: VehicleEntity, vehicles: VehicleEntity[], now: number, events: GameEvent[]): void {
  if (vehicle.flaresReadyAt > now || vehicle.flareCount <= 0) return
  vehicle.flareCount--
  vehicle.flaresReadyAt = now + FLARE_COOLDOWN
  const p = vehicle.flight.position, v = vehicle.flight.velocity, q = vehicle.flight.orientation
  let firstId = -1
  for (let i = 0; i < FLARES_PER_BURST && cs.flares.length < MAX_FLARES; i++) {
    const id = cs.nextId++
    if (firstId < 0) firstId = id
    const side = (i - (FLARES_PER_BURST - 1) / 2) * 18
    rotate(q, side, -12, 8, _dir)
    cs.flares.push({
      id, vehicle: vehicle.id, position: [p[0], p[1] - 1, p[2]],
      velocity: [v[0] * 0.6 + _dir[0], v[1] * 0.6 + _dir[1], v[2] * 0.6 + _dir[2]], age: 0, ttl: FLARE_TTL,
    })
  }
  events.push({ type: "flares", vehicle: vehicle.id })
  if (firstId < 0) return

  // Decoy inbound missiles (deterministic roll per missile & burst).
  for (let i = 0; i < cs.missiles.length; i++) {
    const m = cs.missiles[i] as MissileExt
    const t = MISSILE_TUNING[m.weapon]
    if (!t) continue
    const d = dist(m.position, p)
    let chance: number
    if (m.steered) {
      if (m.scanTarget !== vehicle.id) continue
      const painted = m.target !== null && (m.scanOff ?? 0) === 0
      chance = d <= SCANNER_FLARE_CLOSE ? t.flareNear : painted ? 0 : t.flareFar
    } else {
      if (m.target !== vehicle.id) continue
      chance = d > t.farDist ? t.flareFar : t.flareNear
    }
    if (hash01(m.id, firstId) < chance) {
      m.target = FLARE_TARGET_PREFIX + firstId
      if (m.steered) m.scanTarget = null
    }
  }
  // Flares also break seeker locks on this vehicle (scanner locks too: the operator must re-acquire).
  for (let i = 0; i < vehicles.length; i++) {
    const o = vehicles[i]
    for (let s = 0; s < 2; s++) {
      const rts = o.weapons[s]
      for (let k = 0; k < rts.length; k++) {
        const rt = rts[k]
        if (rt.lockTarget !== vehicle.id) continue
        if (rt.lock >= 1) events.push({ type: "lock", vehicle: o.id, target: vehicle.id, locked: false })
        rt.lock = 0
      }
    }
  }
}

function hasPulse(vehicle: VehicleEntity, seat: SeatIndex): boolean {
  const k = VEHICLES[vehicle.kind].seatWeapons[seat]
  return k[0] === "radarpulse" || k[1] === "radarpulse"
}

function triggerAbility(vehicle: VehicleEntity, seat: SeatIndex, aim: Vec3 | null, vehicles: VehicleEntity[], now: number, events: GameEvent[]): void {
  if (hasPulse(vehicle, seat)) { radarPulse(vehicle, seat, vehicles, now, events); return }
  if (seat !== 1 || !aim || vehicle.abilityReadyAt > now) return
  // Mark target: spot the enemy closest to the aim ray.
  let best: VehicleEntity | null = null
  let bestAng = MARK_CONE
  for (let i = 0; i < vehicles.length; i++) {
    const o = vehicles[i]
    if (!o.alive || !isHostile(vehicle, o)) continue
    const ang = seekerAngle(vehicle.flight.position, aim, o.flight.position, _sd)
    if (_sd.d <= MARK_RANGE && ang < bestAng) { bestAng = ang; best = o }
  }
  if (!best) return
  best.spottedUntil = Math.max(best.spottedUntil, now + MARK_DURATION)
  vehicle.abilityReadyAt = now + MARK_COOLDOWN
}

/** Radar pulse: spots every enemy within WEAPONS.radarpulse.splash for its ttl. Cooldown in abilityReadyAt. */
function radarPulse(vehicle: VehicleEntity, seat: SeatIndex, vehicles: VehicleEntity[], now: number, events: GameEvent[]): void {
  if (vehicle.abilityReadyAt > now) return
  const spec = WEAPONS.radarpulse
  vehicle.abilityReadyAt = now + 1 / spec.rate
  const p = vehicle.flight.position
  for (let i = 0; i < vehicles.length; i++) {
    const o = vehicles[i]
    if (!o.alive || !isHostile(vehicle, o)) continue
    if (dist(p, o.flight.position) <= spec.splash) o.spottedUntil = Math.max(o.spottedUntil, now + spec.ttl)
  }
  events.push({ type: "pulse", vehicle: vehicle.id, team: vehicle.team, position: [p[0], p[1], p[2]], radius: spec.splash })
  events.push({ type: "fire", vehicle: vehicle.id, seat, weapon: "radarpulse" })
}

// ---------------------------------------------------------------------------------------------
// Simulation step
// ---------------------------------------------------------------------------------------------

const _p0: Vec3 = [0, 0, 0]
const _p1: Vec3 = [0, 0, 0]
const _hit: Vec3 = [0, 0, 0]
const _des: Vec3 = [0, 0, 0]
const _tp: Vec3 = [0, 0, 0]
const _tv: Vec3 = [0, 0, 0]
const _scan: Vec3 = [0, 0, 0]

interface SegmentHit { t: number; vehicle: VehicleEntity | null }
const _sh: SegmentHit = { t: 2, vehicle: null }

/** Nearest hostile vehicle hit along p0→p1 (sphere radius + extra), or t = 2. */
function sweepVehicles(p0: Vec3, p1: Vec3, team: number, shooterId: string, extra: number, vehicles: VehicleEntity[], dt: number): SegmentHit {
  _sh.t = 2
  _sh.vehicle = null
  const mx = (p0[0] + p1[0]) * 0.5, my = (p0[1] + p1[1]) * 0.5, mz = (p0[2] + p1[2]) * 0.5
  const halfSeg = dist(p0, p1) * 0.5
  for (let i = 0; i < vehicles.length; i++) {
    const v = vehicles[i]
    if (!v.alive || v.team === team || v.id === shooterId) continue
    const c = v.flight.position, cv = v.flight.velocity
    const r = VEHICLES[v.kind].radius + extra
    const dx = c[0] - mx, dy = c[1] - my, dz = c[2] - mz
    const reach = r + halfSeg + Math.sqrt(cv[0] * cv[0] + cv[1] * cv[1] + cv[2] * cv[2]) * dt
    if (dx * dx + dy * dy + dz * dz > reach * reach) continue
    const t = sweptSphere(p0, p1, c, cv, dt, r)
    if (t >= 0 && t < _sh.t) { _sh.t = t; _sh.vehicle = v }
  }
  return _sh
}

function lerpInto(a: Vec3, b: Vec3, t: number, out: Vec3): Vec3 {
  out[0] = a[0] + (b[0] - a[0]) * t
  out[1] = a[1] + (b[1] - a[1]) * t
  out[2] = a[2] + (b[2] - a[2]) * t
  return out
}

/**
 * Advance projectiles, missiles and flares one tick; regenerate ammo; detect hits against living vehicles
 * and the ground, apply damage (respecting safe zones), mark vehicles dead and push hit/kill/explosion events.
 */
export function stepCombat(cs: CombatState, vehicles: VehicleEntity[], dt: number, now: number, events: GameEvent[]): void {
  regenAmmo(vehicles, dt, now)
  stepProjectiles(cs, vehicles, dt, now, events)
  stepMissiles(cs, vehicles, dt, now, events)
  stepFlares(cs, dt)
}

/** Continuous magazine regen: ammo/refill per second, starting refillDelay s after the weapon last fired. */
function regenAmmo(vehicles: VehicleEntity[], dt: number, now: number): void {
  for (let i = 0; i < vehicles.length; i++) {
    const v = vehicles[i]
    if (!v.alive) continue
    const kinds = VEHICLES[v.kind].seatWeapons
    for (let s = 0; s < 2; s++) {
      for (let k = 0; k < 2; k++) {
        const id = kinds[s][k]
        const rt = v.weapons[s][k] as RuntimeExt | undefined
        if (!id || !rt) continue
        const spec = WEAPONS[id]
        const max = magazine(id)
        if (max < 0 || spec.refill <= 0) continue
        if (rt.ammo >= max) { rt.ammo = max; rt.regen = 0; continue }
        if (now - (rt.firedAt ?? -1e9) < spec.refillDelay - 1e-9) continue
        let acc = (rt.regen ?? 0) + (max / spec.refill) * dt
        // Tolerance so `refill` seconds of accumulation fills the magazine despite float error.
        const whole = Math.floor(acc + 1e-6)
        if (whole > 0) {
          rt.ammo = Math.min(max, rt.ammo + whole)
          acc = Math.max(0, acc - whole)
        }
        rt.regen = rt.ammo >= max ? 0 : acc
      }
    }
  }
}

function stepProjectiles(cs: CombatState, vehicles: VehicleEntity[], dt: number, now: number, events: GameEvent[]): void {
  const list = cs.projectiles
  let w = 0
  for (let i = 0; i < list.length; i++) {
    const p = list[i]
    p.age += dt
    if (p.age > p.ttl) continue
    const spec = WEAPONS[p.weapon]
    if (spec.kind === "rockets") p.velocity[1] -= ROCKET_GRAVITY * dt
    const pos = p.position, vel = p.velocity
    _p0[0] = pos[0]; _p0[1] = pos[1]; _p0[2] = pos[2]
    _p1[0] = pos[0] + vel[0] * dt; _p1[1] = pos[1] + vel[1] * dt; _p1[2] = pos[2] + vel[2] * dt
    const hit = sweepVehicles(_p0, _p1, p.team, p.vehicle, 0, vehicles, dt)
    const g = segmentHitsGround(_p0, _p1)
    if (hit.vehicle && (g === null || hit.t <= g)) {
      const target = hit.vehicle
      lerpInto(_p0, _p1, hit.t, _hit)
      dealDamage(target, damageFor(p.weapon, target, now), p.weapon, p.owner, _hit, events)
      splash(_hit, p.weapon, p.owner, p.team, p.vehicle, target, vehicles, now, events)
      if (spec.kind === "rockets") events.push({ type: "explosion", position: [_hit[0], _hit[1], _hit[2]], size: spec.splash })
      continue
    }
    if (g !== null) {
      lerpInto(_p0, _p1, g, _hit)
      splash(_hit, p.weapon, p.owner, p.team, p.vehicle, null, vehicles, now, events)
      if (spec.kind === "rockets") events.push({ type: "explosion", position: [_hit[0], _hit[1], _hit[2]], size: spec.splash })
      continue
    }
    pos[0] = _p1[0]; pos[1] = _p1[1]; pos[2] = _p1[2]
    list[w++] = p
  }
  list.length = w
}

function findFlare(cs: CombatState, id: number): Flare | null {
  for (let i = 0; i < cs.flares.length; i++) if (cs.flares[i].id === id) return cs.flares[i]
  return null
}

function detonate(
  m: Missile, pos: Vec3, direct: VehicleEntity | null, vehicles: VehicleEntity[], now: number, events: GameEvent[],
): void {
  if (direct) dealDamage(direct, damageFor(m.weapon, direct, now), m.weapon, m.owner, pos, events)
  splash(pos, m.weapon, m.owner, m.team, m.vehicle, direct, vehicles, now, events)
  events.push({ type: "explosion", position: [pos[0], pos[1], pos[2]], size: WEAPONS[m.weapon].splash })
}

/** True when the scanner operator of missile `m` currently paints its designated target. */
export function scannerOnTarget(m: Missile, target: VehicleEntity, vehicles: VehicleEntity[]): boolean {
  const shooter = findVehicle(vehicles, m.vehicle)
  if (!shooter || !shooter.alive || !target.alive) return false
  const seat = (m.seat ?? 1) as SeatIndex
  if (shooter.seats[seat] !== m.owner) return false
  const aim = shooter.aim[seat]
  if (!aim || !normalizeInto(aim, _scan)) return false
  const spec = WEAPONS[m.weapon]
  const ang = seekerAngle(shooter.flight.position, _scan, target.flight.position, _sd)
  return ang <= (spec.lockCone ?? 0.12) * SCANNER_CONE_MARGIN && _sd.d <= (spec.range ?? 8000) * 1.1
}

/** Scanner (semi-active) guidance bookkeeping; returns the vehicle to home on, or null. */
function scannerGuidance(m: MissileExt, vehicles: VehicleEntity[], tune: MissileTuning, dt: number): VehicleEntity | null {
  if (!m.scanTarget) return null
  const target = findVehicle(vehicles, m.scanTarget)
  if (!target || !target.alive) { m.scanTarget = null; m.target = null; return null }
  if (scannerOnTarget(m, target, vehicles)) {
    m.scanOff = 0
    if (m.target === null) {
      // Re-acquire only if the target is inside the missile's own seeker view.
      _dir[0] = m.velocity[0]; _dir[1] = m.velocity[1]; _dir[2] = m.velocity[2]
      if (normalizeInto(_dir, _dir) && seekerAngle(m.position, _dir, target.flight.position, _sd) <= tune.gimbal) m.target = target.id
    }
  } else {
    m.scanOff = (m.scanOff ?? 0) + dt
    if (m.scanOff > SCANNER_GRACE) m.target = null
  }
  return m.target === target.id ? target : null
}

function stepMissiles(cs: CombatState, vehicles: VehicleEntity[], dt: number, now: number, events: GameEvent[]): void {
  const list = cs.missiles
  let w = 0
  for (let i = 0; i < list.length; i++) {
    const m = list[i] as MissileExt
    const spec = WEAPONS[m.weapon]
    const tune = MISSILE_TUNING[m.weapon]!
    m.age += dt
    if (m.age > m.ttl) {
      detonate(m, m.position, null, vehicles, now, events)
      continue
    }
    const vel = m.velocity, pos = m.position
    let speed = len(vel)
    if (speed < 1e-6) speed = 1e-6

    // Motor: accelerate during burn, decelerate while coasting.
    if (m.age <= tune.burn) { if (speed < tune.maxSpeed) speed = Math.min(tune.maxSpeed, speed + tune.accel * dt) }
    else speed = Math.max(MISSILE_MIN_SPEED, speed - tune.coastDecel * dt)

    const maxTurn = (spec.turnRate ?? 1) * dt
    let flareTarget: Flare | null = null
    let ok = false
    if (m.target && m.target.startsWith(FLARE_TARGET_PREFIX)) {
      flareTarget = findFlare(cs, Number(m.target.slice(FLARE_TARGET_PREFIX.length)))
      if (flareTarget) {
        _tp[0] = flareTarget.position[0]; _tp[1] = flareTarget.position[1]; _tp[2] = flareTarget.position[2]
        _tv[0] = flareTarget.velocity[0]; _tv[1] = flareTarget.velocity[1]; _tv[2] = flareTarget.velocity[2]
        ok = true
      } else m.target = null
    } else {
      const t = m.steered ? scannerGuidance(m, vehicles, tune, dt) : m.target ? findVehicle(vehicles, m.target) : null
      if (t && t.alive) {
        const fp = t.flight.position, fv = t.flight.velocity
        _tp[0] = fp[0]; _tp[1] = fp[1]; _tp[2] = fp[2]
        _tv[0] = fv[0]; _tv[1] = fv[1]; _tv[2] = fv[2]
        ok = true
      } else if (!m.steered) m.target = null
    }

    _dir[0] = vel[0] / len(vel); _dir[1] = vel[1] / len(vel); _dir[2] = vel[2] / len(vel)
    if (ok && m.age > MISSILE_LOAL_TIME && seekerAngle(pos, _dir, _tp, _sd) > tune.gimbal) {
      ok = false
      m.target = null
      if (m.steered) m.scanTarget = null
    }
    if (ok) proNav(pos, _dir, speed, _tp, _tv, dt, maxTurn)

    vel[0] = _dir[0] * speed; vel[1] = _dir[1] * speed; vel[2] = _dir[2] * speed
    _p0[0] = pos[0]; _p0[1] = pos[1]; _p0[2] = pos[2]
    _p1[0] = pos[0] + vel[0] * dt; _p1[1] = pos[1] + vel[1] * dt; _p1[2] = pos[2] + vel[2] * dt

    const hit = sweepVehicles(_p0, _p1, m.team, m.vehicle, tune.fuse, vehicles, dt)
    const g = segmentHitsGround(_p0, _p1)
    if (hit.vehicle && (g === null || hit.t <= g)) {
      detonate(m, lerpInto(_p0, _p1, hit.t, _hit), hit.vehicle, vehicles, now, events)
      continue
    }
    if (g !== null) {
      detonate(m, lerpInto(_p0, _p1, g, _hit), null, vehicles, now, events)
      continue
    }
    if (flareTarget && dist(_p1, flareTarget.position) < tune.fuse + 4) {
      detonate(m, _p1, null, vehicles, now, events)
      continue
    }
    pos[0] = _p1[0]; pos[1] = _p1[1]; pos[2] = _p1[2]
    list[w++] = m
  }
  list.length = w
}

/** Proportional navigation: commanded accel = N · Ω × Vm, then turn-rate capped. Updates `dir`. */
function proNav(mp: Vec3, dir: Vec3, speed: number, tp: Vec3, tv: Vec3, dt: number, maxTurn: number): void {
  const rx = tp[0] - mp[0], ry = tp[1] - mp[1], rz = tp[2] - mp[2]
  const r2 = rx * rx + ry * ry + rz * rz
  if (r2 < 1e-6) return
  const vmx = dir[0] * speed, vmy = dir[1] * speed, vmz = dir[2] * speed
  const vrx = tv[0] - vmx, vry = tv[1] - vmy, vrz = tv[2] - vmz
  // LOS rotation rate Ω = (r × vr) / |r|²
  const ox = (ry * vrz - rz * vry) / r2, oy = (rz * vrx - rx * vrz) / r2, oz = (rx * vry - ry * vrx) / r2
  const n = PROPORTIONAL_NAV_GAIN
  const ax = n * (oy * vmz - oz * vmy), ay = n * (oz * vmx - ox * vmz), az = n * (ox * vmy - oy * vmx)
  _des[0] = vmx + ax * dt; _des[1] = vmy + ay * dt; _des[2] = vmz + az * dt
  // If the target is behind the missile (e.g. turret lock off the rail), pure pursuit.
  if (rx * dir[0] + ry * dir[1] + rz * dir[2] < 0) { _des[0] = rx; _des[1] = ry; _des[2] = rz }
  if (normalizeInto(_des, _des)) turnToward(dir, _des, maxTurn)
}

function stepFlares(cs: CombatState, dt: number): void {
  const list = cs.flares
  let w = 0
  const drag = Math.exp(-1.2 * dt)
  for (let i = 0; i < list.length; i++) {
    const f = list[i]
    f.age += dt
    if (f.age > f.ttl) continue
    const v = f.velocity, p = f.position
    v[0] *= drag; v[1] = v[1] * drag - 9.81 * dt; v[2] *= drag
    p[0] += v[0] * dt; p[1] += v[1] * dt; p[2] += v[2] * dt
    list[w++] = f
  }
  list.length = w
}
