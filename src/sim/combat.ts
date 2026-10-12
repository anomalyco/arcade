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
  Flare, GameEvent, Missile, Projectile, Quat, SeatIndex, SeatInput, TeamId, Vec3, VehicleEntity, VehicleKind,
  WeaponId, WeaponRuntime,
} from "./types"
import { TICK_DT } from "./types"
import { STEALTH_AA_CEILING, STEALTH_LOCK_SPOT, STEALTH_LOCK_TIME, VEHICLES, WEAPONS, type WeaponSpec } from "./vehicles"
export { STEALTH_AA_CEILING, STEALTH_LOCK_SPOT, STEALTH_LOCK_TIME }
import { BOMB_STEP, stepBomb } from "./flight"
import { deckVelocity, fleetState, groundHeight, isWater, posedFleet, posedShip, segmentHitsGround, shipAt } from "./geography"
import {
  AA_RANGE, FLEET, SHIP_DAMAGE_SCALE, SHIP_SPECS, SPAWN_PROTECTION, TURRET_HP, shipToWorld, worldToShip, type Ship, type TurretKind,
} from "./fleet"
import type { Crater } from "./protocol"

// ---------------------------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------------------------

export const MAX_PROJECTILES = 2000
export const MAX_MISSILES = 256
export const MAX_FLARES = 256

/** Damage multiplier while radar-spotted. */
export const SPOTTED_DAMAGE_MULT = 1.2
/** Damage taken multiplier per airframe (A-10 titanium bathtub). */
export const ARMOR: Record<VehicleKind, number> = { fighter: 1, apache: 1, warthog: 0.8, blackbird: 1, bomber: 1 }
/** Per-weapon damage multiplier applied on top of WEAPONS[w].damage. */
export const WEAPON_DAMAGE_MULT: Record<WeaponId, number> = {
  cannon20: 1.35, chaingun30: 1.1, gau8: 0.8, rockets: 1, aim9: 1, tvmissile: 1, hellfire: 1, maverick: 1,
  aim47: 1, radarpulse: 0, bomb: 1,
}

/** Bomb near-miss damage to ships (fraction of direct damage at the hull, falling to 0 at splash radius). */
export const BOMB_NEAR_MISS = 0.5

/** Stealth airframe that isn't currently spotted. */
export function isHiddenStealth(v: VehicleEntity, now: number): boolean {
  return !!VEHICLES[v.kind].stealth && v.spottedUntil <= now
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
  // Short-range dogfight missile: modest seeker gimbal and turn rate, so a hard break + flares usually beats it.
  aim9: { maxSpeed: 650, burn: 2, accel: 200, coastDecel: 35, fuse: 6, gimbal: 0.8, flareNear: 0.8, flareFar: 0.9, farDist: 600 },
  // Radar-guided: flares are less effective.
  tvmissile: { maxSpeed: 620, burn: 2.5, accel: 150, coastDecel: 30, fuse: 6, gimbal: 0.8, flareNear: 0.6, flareFar: 0.7, farDist: 800 },
  hellfire: { maxSpeed: 420, burn: 3, accel: 100, coastDecel: 20, fuse: 4, gimbal: 0.9, flareNear: 0.75, flareFar: 0.85, farDist: 800 },
  maverick: { maxSpeed: 440, burn: 3, accel: 100, coastDecel: 20, fuse: 4, gimbal: 0.9, flareNear: 0.7, flareFar: 0.8, farDist: 800 },
  // Scanner: flareNear applies only inside SCANNER_FLARE_CLOSE; flareFar when the scanner is off target.
  aim47: { maxSpeed: 750, burn: 4, accel: 110, coastDecel: 10, fuse: 10, gimbal: 0.9, flareNear: 0.7, flareFar: 0.9, farDist: 0 },
}

/** Turret arcs in the vehicle body frame (rad). Yaw 0 = nose, elevation 0 = horizon. */
export const TURRET_ARCS: Partial<Record<WeaponId, { yaw: number; minEl: number; maxEl: number }>> = {
  chaingun30: { yaw: (110 * Math.PI) / 180, minEl: (-85 * Math.PI) / 180, maxEl: (12 * Math.PI) / 180 },
}

// --- Guns: lag compensation, hitboxes, range falloff -----------------------------------------
/**
 * Default view delay (s) when the room engine doesn't report one: the client renders remote aircraft
 * ~0.1 s in the past (snapshot interpolation) plus ~half an RTT. Bullets are tested against targets rewound
 * by the shooter's view delay ("favor the shooter"). Bots pass `viewDelay: 0`.
 */
export const VIEW_DELAY_DEFAULT = 0.12
export const VIEW_DELAY_MAX = 0.3
/** Ticks of position history kept per vehicle (must cover VIEW_DELAY_MAX + one tick). */
export const HISTORY_TICKS = 24
/** Bullet hitbox: fuselage capsule along body Z and wing/rotor capsule along body X, scaled by VEHICLES.radius. */
export const HITBOX = { fuselageHalf: 1.1, fuselageRadius: 0.55, wingHalf: 1.1, wingRadius: 0.35 }
/** Full gun damage out to this distance; beyond, it falls linearly to GUN_MIN_DAMAGE at max range (speed × ttl). */
export const GUN_FULL_RANGE = 800
export const GUN_MIN_DAMAGE = 0.4
/** Bullet impacts on ground/water: emit a surface event for every Nth round (cheap visuals). */
export const BULLET_IMPACT_EVERY = 3
/** Missiles and rockets that plunge into water: splash limited to this radius and damage fraction. */
export const WATER_SPLASH_RADIUS = 4
export const WATER_SPLASH_DAMAGE = 0.3

/** Pilot guns/rockets are gimbaled: they fire toward the seat aim within this cone (rad) around the nose. */
export const GUN_GIMBAL = (15 * Math.PI) / 180

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

/** Recon look-to-spot: vehicles whose pilot (seat 0) spots enemies by holding their view on them. */
export const RECON_KINDS: ReadonlySet<VehicleKind> = new Set<VehicleKind>(["blackbird"])
export const SPOT_CONE = (5 * Math.PI) / 180
export const SPOT_RANGE = 6000
export const SPOT_TIME = 1.5
/** Progress lost per second while the candidate is outside the view cone. */
export const SPOT_DECAY = 1 / 0.4
export const SPOT_DURATION = 12
/** Per-target cooldown before it can be look-spotted again. */
export const SPOT_COOLDOWN = 3

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
  /** Fleet AA turret runtime, index-aligned with AA_TURRETS. */
  turrets?: TurretState[]
  /** Pending 5-inch flak bursts. */
  bursts?: FlakBurst[]
  /** Fleet Strike: per-ship runtime (hp, turrets, damage decals), keyed by ship id. */
  ships?: Record<string, ShipRuntime>
  /** Damage each team has dealt to enemy ships (index = team). */
  shipDamageBy?: number[]
  /** Terrain craters this match (capped at MAX_CRATERS). */
  craters?: Crater[]
  /** Player-fired 5-inch shells (flak fuse). */
  shells?: Shell[]
}

export function createCombatState(): CombatState {
  return {
    projectiles: [], missiles: [], flares: [], nextId: 1, turrets: createTurretStates(), bursts: [],
    ships: createShips(), shipDamageBy: [0, 0, 0, 0], craters: [], shells: [],
  }
}

/** Server-side extras on WeaponRuntime (not needed on the wire). */
interface RuntimeExt extends WeaponRuntime {
  /** Room time of the last shot (regen starts refillDelay later). */
  firedAt?: number
  /** Fractional regenerated ammo not yet added to `ammo`. */
  regen?: number
}

/** Server-side extras on VehicleEntity. */
interface VehicleExt extends VehicleEntity {
  /** Room time before which this vehicle can't be look-spotted again. */
  spotCooldownUntil?: number
  /** Room time the vehicle (re)spawned; protected for SPAWN_PROTECTION s. */
  spawnedAt?: number
  /** Lag-compensation ring buffer of recent positions (xyz per tick, newest at `histHead`). */
  hist?: Float64Array
  histHead?: number
  histCount?: number
}

/** Server-side extras on Projectile. */
interface ProjectileExt extends Projectile {
  /** Seconds the shooter's view of remote aircraft lagged behind the server (lag compensation rewind). */
  rewind?: number
  /** Fired from a ship turret: that ship's id (its own hull never stops the round). */
  ship?: string
}

/** Room engine: call when a vehicle (re)spawns so it gets SPAWN_PROTECTION seconds of immunity. */
export function markSpawned(vehicle: VehicleEntity, now: number): void {
  (vehicle as VehicleExt).spawnedAt = now
}

/** Spawn-protected vehicles take no damage, can't fire, and are ignored by locks and fleet AA. */
export function isSpawnProtected(vehicle: VehicleEntity, now: number): boolean {
  const t = (vehicle as VehicleExt).spawnedAt
  return t !== undefined && now - t < SPAWN_PROTECTION
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

const _gim: Vec3 = [0, 0, 0]

/**
 * Firing direction for a weapon. Turret guns: seat aim clamped to the turret arc. Pilot guns and rockets
 * (fixed, gimbaled): seat aim clamped to a GUN_GIMBAL cone around the nose ("mouse aims, keys fly").
 * Missiles and null aim: along the nose.
 */
export function weaponDirection(vehicle: VehicleEntity, weapon: WeaponId, aim: Vec3 | null, out: Vec3): Vec3 {
  const q = vehicle.flight.orientation
  const spec = WEAPONS[weapon]
  if (!spec.turret && aim && (spec.kind === "gun" || spec.kind === "rockets")) {
    rotate(q, 0, 0, -1, out)
    if (!normalizeInto(aim, _gim)) return out
    turnToward(out, _gim, GUN_GIMBAL)
    return out
  }
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
function lockValid(vehicle: VehicleEntity, spec: WeaponSpec, axis: Vec3, target: VehicleEntity, coneScale: number, now: number): number {
  if (!target.alive || target === vehicle || !isHostile(vehicle, target)) return -1
  const range = spec.range ?? 2500
  const cone = (spec.lockCone ?? 0.3) * coneScale
  const tp = target.flight.position
  const ang = seekerAngle(vehicle.flight.position, axis, tp, _sd)
  if (_sd.d > range || ang > cone) return -1
  if (isSpawnProtected(target, now)) return -1
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
  vehicle: VehicleEntity, seat: SeatIndex, weapon: WeaponId, aim: Vec3 | null, vehicles: VehicleEntity[], now = 0,
): VehicleEntity | null {
  const spec = WEAPONS[weapon]
  if (!isLockKind(spec)) return null
  const axis = seekerAxis(vehicle, seat, weapon, aim, _lc)
  let best: VehicleEntity | null = null
  let bestAng = Infinity
  for (let i = 0; i < vehicles.length; i++) {
    const ang = lockValid(vehicle, spec, axis, vehicles[i], 1, now)
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
export function killVehicle(
  vehicle: VehicleEntity, reason: WeaponId | "crash" | "aa", killer: string | null | undefined, events: GameEvent[],
  killerTeam?: TeamId,
): boolean {
  if (!vehicle.alive) return false
  vehicle.alive = false
  vehicle.hp = 0
  const p = vehicle.flight.position
  const kill = {
    type: "kill", victim: vehicle.id, victimTeam: vehicle.team,
    killer: killer === undefined ? vehicle.lastDamagedBy : killer, weapon: reason, position: [p[0], p[1], p[2]],
  } as GameEvent & { killerTeam?: TeamId }
  // `killerTeam` (proposed type field) lets the room score fleet-AA kills, which have no killer player.
  if (killerTeam !== undefined) kill.killerTeam = killerTeam
  events.push(kill)
  const low = p[1] - groundHeight(p[0], p[2]) < 15
  pushExplosion(events, p, VEHICLES[vehicle.kind].radius * 3, low ? surfaceAt(p) : "air")
  return true
}

/** Apply raw (already multiplied) damage. Respects spawn protection. Returns damage dealt. */
function dealDamage(target: VehicleEntity, amount: number, weapon: WeaponId, owner: string, pos: Vec3, now: number, events: GameEvent[]): number {
  if (!target.alive || amount <= 0) return 0
  if (isSpawnProtected(target, now)) return 0
  target.hp -= amount
  target.lastDamagedBy = owner
  events.push({ type: "hit", target: target.id, by: owner, weapon, damage: amount, position: [pos[0], pos[1], pos[2]] })
  if (target.hp <= 0) killVehicle(target, weapon, owner, events)
  return amount
}

/** Splash damage around `pos` (linear falloff from the hull surface), skipping `direct` and friendlies. */
function splash(
  pos: Vec3, weapon: WeaponId, owner: string, team: number, shooterId: string, direct: VehicleEntity | null,
  vehicles: VehicleEntity[], now: number, events: GameEvent[], radiusCap = Infinity, scale = 1,
): void {
  const radius = Math.min(WEAPONS[weapon].splash, radiusCap)
  if (radius <= 0 || scale <= 0) return
  for (let i = 0; i < vehicles.length; i++) {
    const v = vehicles[i]
    if (v === direct || !v.alive || v.team === team || v.id === shooterId) continue
    const d = Math.max(0, dist(pos, v.flight.position) - VEHICLES[v.kind].radius)
    if (d >= radius) continue
    dealDamage(v, damageFor(weapon, v, now) * scale * (1 - d / radius), weapon, owner, pos, now, events)
  }
}

export type Surface = "water" | "ground" | "air"

/** Surface under an impact point: open water vs land/ship deck. */
export function surfaceAt(p: Vec3): "water" | "ground" {
  return isWater(p[0], p[2]) ? "water" : "ground"
}

function pushExplosion(events: GameEvent[], p: Vec3, size: number, surface: Surface, flak = false): void {
  const e: GameEvent = { type: "explosion", position: [p[0], p[1], p[2]], size, surface }
  if (flak) e.kind = "flak"
  events.push(e)
}

/** Gun damage multiplier for a round that has flown `age` seconds (range falloff). */
export function gunRangeFactor(weapon: WeaponId, age: number): number {
  const spec = WEAPONS[weapon]
  const d = Math.max(0, age) * spec.speed
  if (d <= GUN_FULL_RANGE) return 1
  const max = Math.max(spec.speed * spec.ttl, GUN_FULL_RANGE + 1)
  return Math.max(GUN_MIN_DAMAGE, 1 - (1 - GUN_MIN_DAMAGE) * (d - GUN_FULL_RANGE) / (max - GUN_FULL_RANGE))
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
    if (id && runtimes[slot] && isLockKind(WEAPONS[id])) updateLock(cs, vehicle, seat, WEAPONS[id], runtimes[slot], aim, vehicles, now, events)
  }

  if (seat === 0 && RECON_KINDS.has(vehicle.kind)) updateSpotting(vehicle, aim, vehicles, now, events)
  if (input.flares) deployFlares(cs, vehicle, vehicles, now, events)
  if (input.ability) triggerAbility(vehicle, seat, aim, vehicles, now, events)

  const protectedNow = isSpawnProtected(vehicle, now)
  for (let slot = 0; slot < 2; slot++) {
    if (!(slot === 0 ? input.firePrimary : input.fireSecondary)) continue
    const id = kinds[slot]
    const rt = runtimes[slot]
    if (!id || !rt) continue
    const spec = WEAPONS[id]
    if (spec.kind === "pulse") { radarPulse(vehicle, seat, vehicles, now, events); continue }
    if (protectedNow) continue
    if (spec.kind === "gun" || spec.kind === "rockets") fireBallistic(cs, vehicle, seat, spec, rt, aim, now, events, viewDelayOf(input))
    else if (spec.kind === "bomb") fireBomb(cs, vehicle, seat, spec, rt, now, events)
    else fireMissile(cs, vehicle, seat, spec, rt, now, events)
  }
}

/** View angle if the enemy is within the spot cone, range and line of sight and not on cooldown, else -1. */
function spotValid(vehicle: VehicleEntity, axis: Vec3, target: VehicleEntity, cone: number, now: number): number {
  if (!target.alive || !isHostile(vehicle, target)) return -1
  if (((target as VehicleExt).spotCooldownUntil ?? 0) > now) return -1
  const ang = seekerAngle(vehicle.flight.position, axis, target.flight.position, _sd)
  if (ang > cone || _sd.d > SPOT_RANGE) return -1
  if (segmentHitsGround(vehicle.flight.position, target.flight.position) !== null) return -1
  return ang
}

function markSpotted(spotter: VehicleEntity, target: VehicleEntity, until: number, events: GameEvent[]): void {
  target.spottedUntil = Math.max(target.spottedUntil, until)
  events.push({ type: "spotted", by: spotter.id, team: spotter.team, target: target.id, until: target.spottedUntil })
}

/** Recon pilot look-to-spot: progress builds while an enemy stays in the view cone, then spots it. */
function updateSpotting(vehicle: VehicleEntity, aim: Vec3 | null, vehicles: VehicleEntity[], now: number, events: GameEvent[]): void {
  let progress = vehicle.spotProgress ?? 0
  let candidate: VehicleEntity | null = vehicle.spotCandidate ? findVehicle(vehicles, vehicle.spotCandidate) : null
  let inView = false
  if (aim) {
    if (candidate && spotValid(vehicle, aim, candidate, SPOT_CONE * 1.2, now) >= 0) inView = true
    else {
      let best: VehicleEntity | null = null
      let bestAng = Infinity
      for (let i = 0; i < vehicles.length; i++) {
        const ang = spotValid(vehicle, aim, vehicles[i], SPOT_CONE, now)
        if (ang >= 0 && ang < bestAng) { bestAng = ang; best = vehicles[i] }
      }
      if (best) {
        if (best !== candidate) progress = 0
        candidate = best
        inView = true
      }
    }
  }
  if (inView && candidate) {
    progress += TICK_DT / SPOT_TIME
    if (progress >= 1 - 1e-9) {
      markSpotted(vehicle, candidate, now + SPOT_DURATION, events)
      ;(candidate as VehicleExt).spotCooldownUntil = now + SPOT_COOLDOWN
      progress = 0
      candidate = null
    }
  } else {
    progress = Math.max(0, progress - SPOT_DECAY * TICK_DT)
    if (progress === 0) candidate = null
  }
  vehicle.spotProgress = progress
  vehicle.spotCandidate = candidate ? candidate.id : null
}

/** Proposed `SeatInput.viewDelay` (s): how far behind the server the shooter sees remote aircraft. */
export function viewDelayOf(input: SeatInput): number {
  const d = (input as SeatInput & { viewDelay?: number }).viewDelay
  if (d === undefined || !Number.isFinite(d)) return VIEW_DELAY_DEFAULT
  return Math.min(VIEW_DELAY_MAX, Math.max(0, d))
}

function updateLock(
  cs: CombatState, vehicle: VehicleEntity, seat: SeatIndex, spec: WeaponSpec, rt: WeaponRuntime, aim: Vec3 | null,
  vehicles: VehicleEntity[], now: number, events: GameEvent[],
): void {
  const axis = seekerAxis(vehicle, seat, spec.id, aim, _lc)
  let target: VehicleEntity | null = null
  let shipTarget: string | null = null
  if (rt.lockTarget) {
    if (rt.lockTarget.startsWith(SHIP_TARGET_PREFIX)) {
      if (shipLockAngle(cs, vehicle, spec, axis, rt.lockTarget.slice(SHIP_TARGET_PREFIX.length)) >= 0) shipTarget = rt.lockTarget
    } else {
      const cur = findVehicle(vehicles, rt.lockTarget)
      // No hysteresis: the lock breaks the moment the target leaves the cone.
      if (cur && lockValid(vehicle, spec, axis, cur, 1, now) >= 0) target = cur
    }
  }
  if (!target && !shipTarget) target = lockCandidate(vehicle, seat, spec.id, aim, vehicles, now)
  // Lock-on missiles can also lock enemy ships (aim point: amidships).
  if (!target && !shipTarget && spec.kind === "missile_lock") {
    const sh = shipLockCandidate(cs, vehicle, spec, axis)
    if (sh) shipTarget = SHIP_TARGET_PREFIX + sh
  }

  const newId = target ? target.id : shipTarget
  if (newId !== rt.lockTarget) {
    if (rt.lockTarget && rt.lock >= 1) events.push({ type: "lock", vehicle: vehicle.id, target: rt.lockTarget, locked: false })
    rt.lockTarget = newId
    rt.lock = 0
  }
  if (!newId) return
  const was = rt.lock
  // Unspotted stealth: the seeker must stay on it for STEALTH_LOCK_TIME (completing the lock spots it).
  const stealthy = target !== null && isHiddenStealth(target, now)
  rt.lock = Math.min(1, rt.lock + TICK_DT / (stealthy ? Math.max(STEALTH_LOCK_TIME, spec.lockTime ?? 1) : spec.lockTime ?? 1))
  // Float accumulation guard so lockTime/TICK_DT ticks reliably reaches 1.
  if (rt.lock > 1 - 1e-9) rt.lock = 1
  if (stealthy && rt.lock >= 1) markSpotted(vehicle, target!, now + STEALTH_LOCK_SPOT, events)
  if (was < 1 && rt.lock >= 1) events.push({ type: "lock", vehicle: vehicle.id, target: newId, locked: true })
  // Tracking warning for the target: `locked: false` when acquisition starts and again at half lock.
  else if (was === 0 || (was < 0.5 && rt.lock >= 0.5)) events.push({ type: "lock", vehicle: vehicle.id, target: newId, locked: false })
}

function ownerOf(vehicle: VehicleEntity, seat: SeatIndex): string {
  return vehicle.seats[seat] ?? vehicle.id
}

function fireBallistic(
  cs: CombatState, vehicle: VehicleEntity, seat: SeatIndex, spec: WeaponSpec, rt: WeaponRuntime,
  aim: Vec3 | null, now: number, events: GameEvent[], viewDelay = VIEW_DELAY_DEFAULT,
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
    const proj: ProjectileExt = {
      id, weapon: spec.id, owner: ownerOf(vehicle, seat), vehicle: vehicle.id, team: vehicle.team,
      position: [_muz[0] + vx * back, _muz[1] + vy * back, _muz[2] + vz * back],
      velocity: [vx, vy, vz], age: back, ttl: spec.ttl,
    }
    if (viewDelay > 0) proj.rewind = viewDelay
    cs.projectiles.push(proj)
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

/**
 * Bomb release: drops from the bay (a few meters below the airframe) with the aircraft's velocity; flies the
 * same gravity + drag model as flight's bombImpactPoint (unguided). Bombs live in `projectiles` (weapon "bomb").
 */
function fireBomb(cs: CombatState, vehicle: VehicleEntity, seat: SeatIndex, spec: WeaponSpec, rt: WeaponRuntime, now: number, events: GameEvent[]): void {
  if (rt.readyAt > now || (rt.ammo >= 0 && rt.ammo < 1) || cs.projectiles.length >= MAX_PROJECTILES) return
  rotate(vehicle.flight.orientation, 0, -3, 0, _muz)
  const p = vehicle.flight.position, v = vehicle.flight.velocity
  cs.projectiles.push({
    id: cs.nextId++, weapon: spec.id, owner: ownerOf(vehicle, seat), vehicle: vehicle.id, team: vehicle.team,
    position: [p[0] + _muz[0], p[1] + _muz[1], p[2] + _muz[2]], velocity: [v[0], v[1], v[2]], age: 0, ttl: spec.ttl,
  })
  consumeAmmo(rt, now)
  rt.readyAt = now + 1 / spec.rate
  events.push({ type: "fire", vehicle: vehicle.id, seat, weapon: spec.id })
}

/** Bomb impact: ships take direct (or near-miss) damage, aircraft splash, craters on land, splash in water. */
function bombImpact(cs: CombatState, p: Projectile, pos: Vec3, directShip: Ship | null, vehicles: VehicleEntity[], now: number, events: GameEvent[]): void {
  const spec = WEAPONS[p.weapon]
  const full = shipDamageFor(p.weapon)
  if (directShip) {
    if (directShip.team !== p.team) damageShip(cs, directShip.id, full, p.owner, p.team, pos, now, events)
  } else {
    // Near misses still hurt ships within the blast radius.
    const fleet = posedFleet()
    for (let i = 0; i < fleet.length; i++) {
      const sh = fleet[i]
      if (sh.team === p.team) continue
      const sp = SHIP_SPECS[sh.kind]
      toShipLocal(sh, pos, _sl0)
      const dx = Math.max(0, Math.abs(_sl0[0]) - sp.halfWidth), dz = Math.max(0, Math.abs(_sl0[2]) - sp.halfLength)
      const dy = Math.max(0, _sl0[1] - sp.deckHeight)
      const d = Math.hypot(dx, dy, dz)
      if (d < spec.splash) damageShip(cs, sh.id, full * BOMB_NEAR_MISS * (1 - d / spec.splash), p.owner, p.team, pos, now, events)
    }
  }
  const surface = directShip ? "ground" : surfaceAt(pos)
  splash(pos, p.weapon, p.owner, p.team, p.vehicle, null, vehicles, now, events, surface === "water" ? spec.splash * 0.6 : Infinity)
  pushExplosion(events, pos, surface === "water" ? spec.splash * 0.5 : spec.splash, surface)
  if (!directShip && surface === "ground") addCrater(cs, pos, 15, events)
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
    if (dist(p, o.flight.position) <= spec.splash) markSpotted(vehicle, o, now + spec.ttl, events)
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
 * and the ground, apply damage (respecting spawn protection), run fleet AA, mark vehicles dead and push hit/kill/explosion events.
 */
export function stepCombat(cs: CombatState, vehicles: VehicleEntity[], dt: number, now: number, events: GameEvent[]): void {
  regenAmmo(vehicles, dt, now)
  recordHistory(vehicles)
  stepProjectiles(cs, vehicles, dt, now, events)
  stepMissiles(cs, vehicles, dt, now, events)
  stepFlares(cs, dt)
  stepShells(cs, vehicles, dt, now, events)
  stepFleetAA(cs, vehicles, dt, now, events)
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
    const p = list[i] as ProjectileExt
    p.age += dt
    if (p.age > p.ttl) continue
    const spec = WEAPONS[p.weapon]
    if (spec.kind === "bomb") {
      stepBombProjectile(cs, p, vehicles, dt, now, events)
      if (p.age >= 0) list[w++] = p
      continue
    }
    const gun = spec.kind === "gun"
    if (!gun) p.velocity[1] -= ROCKET_GRAVITY * dt
    const pos = p.position, vel = p.velocity
    _p0[0] = pos[0]; _p0[1] = pos[1]; _p0[2] = pos[2]
    _p1[0] = pos[0] + vel[0] * dt; _p1[1] = pos[1] + vel[1] * dt; _p1[2] = pos[2] + vel[2] * dt
    const hit = sweepRewound(_p0, _p1, p.team, p.vehicle, vehicles, dt, p.rewind ?? 0, gun)
    let g = segmentHitsGround(_p0, _p1)
    // Turret rounds pass through their own ship's hull.
    if (p.ship && g !== null) {
      const own = shipSegmentT(p.ship, _p0, _p1)
      if (own !== null && Math.abs(own - g) < 1e-4) g = null
    }
    const sh = g !== null ? segmentHitsShipEx(cs, _p0, _p1, now, p.ship ?? null) : null
    if (hit.vehicle && (g === null || hit.t <= g)) {
      const target = hit.vehicle
      lerpInto(_p0, _p1, hit.t, _hit)
      const dmg = damageFor(p.weapon, target, now) * (gun ? gunRangeFactor(p.weapon, p.age) : 1)
      dealDamage(target, dmg, p.weapon, p.owner, _hit, now, events)
      splash(_hit, p.weapon, p.owner, p.team, p.vehicle, target, vehicles, now, events)
      if (!gun) pushExplosion(events, _hit, spec.splash, "air")
      continue
    }
    if (g !== null && sh && sh.t <= g + 1e-4) {
      lerpInto(_p0, _p1, sh.t, _hit)
      const base = WEAPONS[p.weapon].damage * (gun ? gunRangeFactor(p.weapon, p.age) : 1)
      if (sh.ship.team !== p.team) damageShip(cs, sh.ship.id, base * shipScale(p.weapon), p.owner, p.team, _hit, now, events)
      if (!gun || p.id % BULLET_IMPACT_EVERY === 0) pushExplosion(events, _hit, gun ? 1 : spec.splash, "ground")
      continue
    }
    if (g !== null) {
      lerpInto(_p0, _p1, g, _hit)
      const surface = surfaceAt(_hit)
      if (!gun && surface === "ground") addCrater(cs, _hit, craterRadius(p.weapon), events)
      if (gun) {
        // Bullets: no splash in water; small splash (30mm) on land. Visual puff for every Nth round.
        if (surface === "ground") splash(_hit, p.weapon, p.owner, p.team, p.vehicle, null, vehicles, now, events)
        if (p.id % BULLET_IMPACT_EVERY === 0) pushExplosion(events, _hit, 1, surface)
      } else if (surface === "water") {
        splash(_hit, p.weapon, p.owner, p.team, p.vehicle, null, vehicles, now, events, WATER_SPLASH_RADIUS, WATER_SPLASH_DAMAGE)
        pushExplosion(events, _hit, spec.splash * 0.3, "water")
      } else {
        splash(_hit, p.weapon, p.owner, p.team, p.vehicle, null, vehicles, now, events)
        pushExplosion(events, _hit, spec.splash, "ground")
      }
      continue
    }
    pos[0] = _p1[0]; pos[1] = _p1[1]; pos[2] = _p1[2]
    list[w++] = p
  }
  list.length = w
}

/** Advance a bomb (flight's bomb model); on impact applies effects and marks it spent (age = -1). */
function stepBombProjectile(cs: CombatState, p: Projectile, vehicles: VehicleEntity[], dt: number, now: number, events: GameEvent[]): void {
  const pos = p.position
  _p0[0] = pos[0]; _p0[1] = pos[1]; _p0[2] = pos[2]
  let left = dt
  while (left > 1e-9) {
    const h = Math.min(BOMB_STEP, left)
    stepBomb(pos, p.velocity, h)
    left -= h
  }
  _p1[0] = pos[0]; _p1[1] = pos[1]; _p1[2] = pos[2]
  const g = segmentHitsGround(_p0, _p1)
  if (g === null && p.age <= p.ttl) return
  if (g === null) { p.age = -1; return }
  const sh = segmentHitsShipEx(cs, _p0, _p1, now, null)
  const direct = sh && sh.t <= g + 1e-4 ? sh.ship : null
  lerpInto(_p0, _p1, direct ? sh!.t : g, _hit)
  bombImpact(cs, p, _hit, direct, vehicles, now, events)
  p.age = -1
}

/** True when a seat's gimbaled/turret gun can point at world point `p` (pilot guns: within GUN_GIMBAL of the nose). */
export function gunCanReach(shooter: VehicleEntity, seat: SeatIndex, p: Vec3, weapon?: WeaponId): boolean {
  const ids = VEHICLES[shooter.kind].seatWeapons[seat]
  const id = weapon ?? (ids[0] && WEAPONS[ids[0]].kind === "gun" ? ids[0] : ids[1] && WEAPONS[ids[1]].kind === "gun" ? ids[1] : null)
  if (!id) return false
  muzzlePosition(shooter, seat, id, _muz)
  _gim[0] = p[0] - _muz[0]; _gim[1] = p[1] - _muz[1]; _gim[2] = p[2] - _muz[2]
  if (!normalizeInto(_gim, _gim)) return true
  weaponDirection(shooter, id, _gim, _ls0)
  return _ls0[0] * _gim[0] + _ls0[1] * _gim[1] + _ls0[2] * _gim[2] > Math.cos(1e-3)
}

// ---------------------------------------------------------------------------------------------
// Lag compensation & bullet hitboxes

/** Push every living vehicle's current position into its history ring (once per tick). */
function recordHistory(vehicles: VehicleEntity[]): void {
  for (let i = 0; i < vehicles.length; i++) {
    const v = vehicles[i] as VehicleExt
    if (!v.alive) { v.histCount = 0; continue }
    const h = v.hist ?? (v.hist = new Float64Array(HISTORY_TICKS * 3))
    const head = v.histCount ? ((v.histHead ?? 0) + 1) % HISTORY_TICKS : 0
    const p = v.flight.position
    h[head * 3] = p[0]; h[head * 3 + 1] = p[1]; h[head * 3 + 2] = p[2]
    v.histHead = head
    v.histCount = Math.min(HISTORY_TICKS, (v.histCount ?? 0) + 1)
  }
}

/** Position of `v` `back` seconds ago (interpolated from history; clamps to the oldest sample). */
export function rewoundPosition(v: VehicleEntity, back: number, out: Vec3): Vec3 {
  const x = v as VehicleExt
  const p = v.flight.position
  const n = x.histCount ?? 0
  if (!x.hist || n === 0 || back <= 0) {
    // No history yet: extrapolate backwards along the current velocity.
    const u = v.flight.velocity, b = Math.max(0, back)
    out[0] = p[0] - u[0] * b; out[1] = p[1] - u[1] * b; out[2] = p[2] - u[2] * b
    return out
  }
  const k = Math.min(back / TICK_DT, n - 1)
  const i0 = Math.floor(k), f = k - i0, i1 = Math.min(i0 + 1, n - 1)
  const h = x.hist, head = x.histHead ?? 0
  const a = ((head - i0) % HISTORY_TICKS + HISTORY_TICKS) % HISTORY_TICKS * 3
  const b = ((head - i1) % HISTORY_TICKS + HISTORY_TICKS) % HISTORY_TICKS * 3
  out[0] = h[a] + (h[b] - h[a]) * f
  out[1] = h[a + 1] + (h[b + 1] - h[a + 1]) * f
  out[2] = h[a + 2] + (h[b + 2] - h[a + 2]) * f
  return out
}

const _c0: Vec3 = [0, 0, 0]
const _c1: Vec3 = [0, 0, 0]
const _cv: Vec3 = [0, 0, 0]
const _ls0: Vec3 = [0, 0, 0]
const _ls1: Vec3 = [0, 0, 0]

/**
 * Closest approach between segment P(s)=a+s·(b−a) and Q(t)=c+t·(d−c), s,t ∈ [0,1]. Returns squared distance,
 * writes s into _segS.
 */
let _segS = 0
function segSegDist2(a: Vec3, b: Vec3, c: Vec3, d: Vec3): number {
  const d1x = b[0] - a[0], d1y = b[1] - a[1], d1z = b[2] - a[2]
  const d2x = d[0] - c[0], d2y = d[1] - c[1], d2z = d[2] - c[2]
  const rx = a[0] - c[0], ry = a[1] - c[1], rz = a[2] - c[2]
  const A = d1x * d1x + d1y * d1y + d1z * d1z, E = d2x * d2x + d2y * d2y + d2z * d2z
  const F = d2x * rx + d2y * ry + d2z * rz
  let s: number, t: number
  if (A <= 1e-12 && E <= 1e-12) { s = 0; t = 0 }
  else if (A <= 1e-12) { s = 0; t = clamp01(F / E) }
  else {
    const C = d1x * rx + d1y * ry + d1z * rz
    if (E <= 1e-12) { t = 0; s = clamp01(-C / A) }
    else {
      const B = d1x * d2x + d1y * d2y + d1z * d2z
      const den = A * E - B * B
      s = den > 1e-12 ? clamp01((B * F - C * E) / den) : 0
      t = (B * s + F) / E
      if (t < 0) { t = 0; s = clamp01(-C / A) }
      else if (t > 1) { t = 1; s = clamp01((B - C) / A) }
    }
  }
  _segS = s
  const px = a[0] + d1x * s - (c[0] + d2x * t), py = a[1] + d1y * s - (c[1] + d2y * t), pz = a[2] + d1z * s - (c[2] + d2z * t)
  return px * px + py * py + pz * pz
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x
}

const _capA: Vec3 = [0, 0, 0]
const _capB: Vec3 = [0, 0, 0]

/**
 * First-contact fraction of a (target-relative, body-frame) segment s0→s1 against the bullet hitbox of a
 * vehicle with bounding radius R: fuselage capsule along Z plus wing/rotor capsule along X. -1 = miss.
 */
export function hitboxSweep(s0: Vec3, s1: Vec3, R: number): number {
  const segLen = dist(s0, s1)
  let best = 2
  for (let k = 0; k < 2; k++) {
    const half = R * (k === 0 ? HITBOX.fuselageHalf : HITBOX.wingHalf)
    const r = R * (k === 0 ? HITBOX.fuselageRadius : HITBOX.wingRadius)
    if (k === 0) { _capA[0] = 0; _capA[1] = 0; _capA[2] = -half; _capB[0] = 0; _capB[1] = 0; _capB[2] = half }
    else { _capA[0] = -half; _capA[1] = 0; _capA[2] = 0; _capB[0] = half; _capB[1] = 0; _capB[2] = 0 }
    const d2 = segSegDist2(s0, s1, _capA, _capB)
    if (d2 > r * r) continue
    // Back up from the closest approach to the (approximate) entry point.
    const t = segLen > 1e-9 ? Math.max(0, _segS - Math.sqrt(r * r - d2) / segLen) : 0
    if (t < best) best = t
  }
  return best <= 1 ? best : -1
}

/**
 * Nearest hostile hit along p0→p1 with targets rewound by `rewind` s. Bullets (`capsule`) use the
 * fuselage/wing hitbox; rockets use the bounding sphere. Motion is relative, so nothing tunnels.
 */
function sweepRewound(
  p0: Vec3, p1: Vec3, team: number, shooterId: string, vehicles: VehicleEntity[], dt: number, rewind: number, capsule: boolean,
): SegmentHit {
  _sh.t = 2
  _sh.vehicle = null
  const mx = (p0[0] + p1[0]) * 0.5, my = (p0[1] + p1[1]) * 0.5, mz = (p0[2] + p1[2]) * 0.5
  const halfSeg = dist(p0, p1) * 0.5
  for (let i = 0; i < vehicles.length; i++) {
    const v = vehicles[i]
    if (!v.alive || v.team === team || v.id === shooterId) continue
    const R = VEHICLES[v.kind].radius
    rewoundPosition(v, rewind, _c1)
    rewoundPosition(v, rewind + dt, _c0)
    const dx = _c1[0] - mx, dy = _c1[1] - my, dz = _c1[2] - mz
    const reach = R * 1.7 + halfSeg + dist(_c0, _c1)
    if (dx * dx + dy * dy + dz * dz > reach * reach) continue
    let t: number
    if (capsule) {
      const q = v.flight.orientation
      rotateInv(q, p0[0] - _c0[0], p0[1] - _c0[1], p0[2] - _c0[2], _ls0)
      rotateInv(q, p1[0] - _c1[0], p1[1] - _c1[1], p1[2] - _c1[2], _ls1)
      t = hitboxSweep(_ls0, _ls1, R)
    } else {
      _cv[0] = (_c1[0] - _c0[0]) / dt; _cv[1] = (_c1[1] - _c0[1]) / dt; _cv[2] = (_c1[2] - _c0[2]) / dt
      t = sweptSphere(p0, p1, _c1, _cv, dt, R)
    }
    if (t >= 0 && t < _sh.t) { _sh.t = t; _sh.vehicle = v }
  }
  return _sh
}

/**
 * HUD lead pipper for a seat's gun against `target` (same ballistics and muzzle as the server): writes the
 * world point to aim the seat at and returns time to intercept, -1 = no gun / no solution. Bullets fire
 * along the aim clamped to the gimbal; use `gunCanReach` to grey out a pipper outside it.
 */
export function gunLeadPoint(shooter: VehicleEntity, seat: SeatIndex, target: VehicleEntity, out: Vec3, weapon?: WeaponId): number {
  let id = weapon ?? null
  if (!id) {
    const ids = VEHICLES[shooter.kind].seatWeapons[seat]
    id = ids[0] && WEAPONS[ids[0]].kind === "gun" ? ids[0] : ids[1] && WEAPONS[ids[1]].kind === "gun" ? ids[1] : null
  }
  if (!id) return -1
  muzzlePosition(shooter, seat, id, _muz)
  return leadPoint(_muz, shooter.flight.velocity, WEAPONS[id].speed, target.flight.position, target.flight.velocity, out)
}

function findFlare(cs: CombatState, id: number): Flare | null {
  for (let i = 0; i < cs.flares.length; i++) if (cs.flares[i].id === id) return cs.flares[i]
  return null
}

/** Direct hits (incl. proximity-fuse) from lock-on/scanner missiles destroy any aircraft outright. */
export function missileDirectDamage(weapon: WeaponId, target: VehicleEntity, now: number): number {
  const k = WEAPONS[weapon].kind
  if (k === "missile_lock" || k === "missile_scanner") return Math.max(target.hp, target.maxHp) + 1
  return damageFor(weapon, target, now)
}

function detonate(
  m: Missile, pos: Vec3, direct: VehicleEntity | null, vehicles: VehicleEntity[], now: number, events: GameEvent[],
  surface: Surface = "air",
): void {
  const size = WEAPONS[m.weapon].splash
  if (direct) dealDamage(direct, missileDirectDamage(m.weapon, direct, now), m.weapon, m.owner, pos, now, events)
  if (surface === "water") {
    splash(pos, m.weapon, m.owner, m.team, m.vehicle, direct, vehicles, now, events, WATER_SPLASH_RADIUS, WATER_SPLASH_DAMAGE)
    pushExplosion(events, pos, size * 0.3, "water")
    return
  }
  splash(pos, m.weapon, m.owner, m.team, m.vehicle, direct, vehicles, now, events)
  pushExplosion(events, pos, size, surface)
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
function scannerGuidance(m: MissileExt, vehicles: VehicleEntity[], tune: MissileTuning, dt: number, events: GameEvent[]): VehicleEntity | null {
  if (!m.scanTarget) return null
  const target = findVehicle(vehicles, m.scanTarget)
  if (!target || !target.alive) { m.scanTarget = null; m.target = null; return null }
  if (scannerOnTarget(m, target, vehicles)) {
    m.scanOff = 0
    if (m.target === null) {
      // Re-acquire only if the target is inside the missile's own seeker view.
      _dir[0] = m.velocity[0]; _dir[1] = m.velocity[1]; _dir[2] = m.velocity[2]
      if (normalizeInto(_dir, _dir) && seekerAngle(m.position, _dir, target.flight.position, _sd) <= tune.gimbal) {
        m.target = target.id
        events.push({ type: "guidance", missile: m.id, vehicle: m.vehicle, target: target.id, guided: true })
      }
    }
  } else {
    m.scanOff = (m.scanOff ?? 0) + dt
    if (m.scanOff > SCANNER_GRACE && m.target !== null) {
      m.target = null
      events.push({ type: "guidance", missile: m.id, vehicle: m.vehicle, target: target.id, guided: false })
    }
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
    } else if (m.target && m.target.startsWith(SHIP_TARGET_PREFIX)) {
      if (shipAimPoint(cs, m.target.slice(SHIP_TARGET_PREFIX.length), _tp)) {
        const dv = deckVelocity(_tp[0], _tp[2])
        _tv[0] = dv ? dv[0] : 0; _tv[1] = 0; _tv[2] = dv ? dv[2] : 0
        ok = true
      } else m.target = null
    } else {
      const t = m.steered ? scannerGuidance(m, vehicles, tune, dt, events) : m.target ? findVehicle(vehicles, m.target) : null
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
      const sh = segmentHitsShipEx(cs, _p0, _p1, now, null)
      if (sh && sh.t <= g + 1e-4) {
        lerpInto(_p0, _p1, sh.t, _hit)
        if (sh.ship.team !== m.team) damageShip(cs, sh.ship.id, shipDamageFor(m.weapon), m.owner, m.team, _hit, now, events)
        detonate(m, _hit, null, vehicles, now, events, "ground")
        continue
      }
      lerpInto(_p0, _p1, g, _hit)
      const surface = surfaceAt(_hit)
      detonate(m, _hit, null, vehicles, now, events, surface)
      if (surface === "ground") addCrater(cs, _hit, craterRadius(m.weapon), events)
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

// ---------------------------------------------------------------------------------------------
// Fleet Strike: destructible ships, turret knockouts, craters, ship locks, manned turrets
// ---------------------------------------------------------------------------------------------

/** Lock target id prefix for ships (`ship:<shipId>`), like FLARE_TARGET_PREFIX. */
export const SHIP_TARGET_PREFIX = "ship:"
/** Ship locks use a wider cone (ships are large) — multiplier on the weapon's lockCone. */
export const SHIP_LOCK_CONE_SCALE = 1.6
/** Hits within this distance of a turret mount also damage the turret. */
export const TURRET_HIT_RADIUS = 12
/** Max damage decals kept per ship (ring buffer). */
export const SHIP_DAMAGE_POINTS = 16
/** A sunk ship stops colliding (for our hit tests) this long after sinking. */
export const SHIP_SINK_COLLISION_TIME = 20
export const MAX_CRATERS = 300
/** Player-manned turrets: CIWS fires 20 mm rounds (cannon20 ballistics) at this rate; 5-inch reload. */
export const MANNED_CIWS_RATE = 20
export const MANNED_GUN_RELOAD = 1.5
export const MANNED_GUN_FUSE = 18
export const SHELL_TTL = 3.5

export interface ShipTurretRuntime { hp: number; manned: string | null; readyAt: number }

export interface ShipRuntime {
  id: string
  team: TeamId
  kind: Ship["kind"]
  hp: number
  maxHp: number
  sunk: boolean
  sunkAt: number
  turrets: Record<string, ShipTurretRuntime>
  /** Ship-local damage points (ring buffer of SHIP_DAMAGE_POINTS). */
  damage: Vec3[]
  damageCount: number
}

export interface Shell {
  id: number
  owner: string
  ship: string
  team: TeamId
  position: Vec3
  velocity: Vec3
  age: number
}

function createShips(): Record<string, ShipRuntime> {
  const out: Record<string, ShipRuntime> = {}
  for (const sh of FLEET) {
    const spec = SHIP_SPECS[sh.kind]
    const turrets: Record<string, ShipTurretRuntime> = {}
    for (const t of spec.turrets) turrets[t.id] = { hp: TURRET_HP, manned: null, readyAt: 0 }
    out[sh.id] = { id: sh.id, team: sh.team, kind: sh.kind, hp: spec.maxHp, maxHp: spec.maxHp, sunk: false, sunkAt: 0, turrets, damage: [], damageCount: 0 }
  }
  return out
}

/** Ship runtime (creating the table on old states). */
export function shipRuntime(cs: CombatState, id: string): ShipRuntime | null {
  if (!cs.ships) cs.ships = createShips()
  return cs.ships[id] ?? null
}

/** Ship damage for a weapon (base damage × SHIP_DAMAGE_SCALE[kind]). */
export function shipScale(weapon: WeaponId): number {
  const spec = WEAPONS[weapon]
  return spec ? SHIP_DAMAGE_SCALE[spec.kind] ?? 0 : 0
}
export function shipDamageFor(weapon: WeaponId): number {
  return (WEAPONS[weapon]?.damage ?? 0) * shipScale(weapon)
}

/** Crater radius (m) by weapon (rockets small, heavy missiles large). */
export function craterRadius(weapon: WeaponId | "flak"): number {
  if (weapon === "flak") return 6
  return Math.min(15, Math.max(6, (WEAPONS[weapon]?.splash ?? 8) * 0.8))
}

/** Record a terrain crater (land only: not water, not ship decks). */
export function addCrater(cs: CombatState, p: Vec3, radius: number, events: GameEvent[]): void {
  if (!cs.craters) cs.craters = []
  if (cs.craters.length >= MAX_CRATERS || isWater(p[0], p[2]) || shipAt(p[0], p[2])) return
  const position: Vec3 = [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10, Math.round(p[2] * 10) / 10]
  const r = Math.round(radius * 10) / 10
  cs.craters.push({ position, radius: r })
  events.push({ type: "crater", position: [position[0], position[1], position[2]], radius: r })
}

const _sl0: Vec3 = [0, 0, 0]
const _sl1: Vec3 = [0, 0, 0]

/** Slab test of a ship-local segment against a box; entry fraction or null. */
function boxT(a: Vec3, b: Vec3, cx: number, cy: number, cz: number, hx: number, hy: number, hz: number): number | null {
  let t0 = 0, t1 = 1
  for (let k = 0; k < 3; k++) {
    const pa = a[k], d = b[k] - pa
    const c = k === 0 ? cx : k === 1 ? cy : cz, h = k === 0 ? hx : k === 1 ? hy : hz
    const lo = c - h, hi = c + h
    if (Math.abs(d) < 1e-9) { if (pa < lo || pa > hi) return null; continue }
    let u0 = (lo - pa) / d, u1 = (hi - pa) / d
    if (u0 > u1) { const x = u0; u0 = u1; u1 = x }
    if (u0 > t0) t0 = u0
    if (u1 < t1) t1 = u1
    if (t0 > t1) return null
  }
  return t0
}

function toShipLocal(ship: Ship, p: Vec3, out: Vec3): Vec3 {
  const dx = p[0] - ship.position[0], dz = p[2] - ship.position[2]
  const c = Math.cos(ship.heading), s = Math.sin(ship.heading)
  out[0] = dx * c - dz * s
  out[1] = p[1] - ship.position[1]
  out[2] = dx * s + dz * c
  return out
}

/** Hull/superstructure hit fraction of segment a→b against one (posed) ship, or null. */
function shipBoxesT(ship: Ship, a: Vec3, b: Vec3): number | null {
  const sp = SHIP_SPECS[ship.kind]
  const r = Math.hypot(sp.halfLength, sp.halfWidth) + 5
  const P = ship.position
  if (Math.max(a[0], b[0]) < P[0] - r || Math.min(a[0], b[0]) > P[0] + r || Math.max(a[2], b[2]) < P[2] - r || Math.min(a[2], b[2]) > P[2] + r) return null
  toShipLocal(ship, a, _sl0)
  toShipLocal(ship, b, _sl1)
  const hull = boxT(_sl0, _sl1, 0, (sp.deckHeight - 15) / 2, 0, sp.halfWidth, (sp.deckHeight + 15) / 2, sp.halfLength)
  const I = sp.island
  const isl = boxT(_sl0, _sl1, I.center[0], I.center[1], I.center[2], I.half[0], I.half[1], I.half[2])
  return hull === null ? isl : isl === null ? hull : Math.min(hull, isl)
}

/** Hit fraction of a→b against ship `id` at its current pose (null if none / unknown). */
export function shipSegmentT(id: string, a: Vec3, b: Vec3): number | null {
  const ship = posedShip(id)
  return ship ? shipBoxesT(ship, a, b) : null
}

const _shipHit = { t: 2, ship: null as unknown as Ship }

/** First active, still-solid ship hit along a→b (skipping `skip`), or null. Shared result object. */
export function segmentHitsShipEx(cs: CombatState, a: Vec3, b: Vec3, now: number, skip: string | null): { t: number; ship: Ship } | null {
  const fleet = posedFleet()
  let best: Ship | null = null
  let bestT = 2
  for (let i = 0; i < fleet.length; i++) {
    const ship = fleet[i]
    if (ship.id === skip) continue
    const rt = shipRuntime(cs, ship.id)
    if (rt && rt.sunk && now - rt.sunkAt > SHIP_SINK_COLLISION_TIME) continue
    const t = shipBoxesT(ship, a, b)
    if (t !== null && t < bestT) { bestT = t; best = ship }
  }
  if (!best) return null
  _shipHit.t = bestT
  _shipHit.ship = best
  return _shipHit
}

/** Missile aim point on ship `id` (amidships, ~60% deck height); false if gone/sunk. */
export function shipAimPoint(cs: CombatState, id: string, out: Vec3): boolean {
  const ship = posedShip(id)
  const rt = shipRuntime(cs, id)
  if (!ship || !rt || rt.sunk || ship.team >= fleetState().teams) return false
  out[0] = ship.position[0]
  out[1] = SHIP_SPECS[ship.kind].deckHeight * 0.6
  out[2] = ship.position[2]
  return true
}

const _sap: Vec3 = [0, 0, 0]

/** Seeker angle to an enemy ship if lockable (in range and cone), else -1. */
function shipLockAngle(cs: CombatState, vehicle: VehicleEntity, spec: WeaponSpec, axis: Vec3, id: string): number {
  const ship = posedShip(id)
  if (!ship || ship.team === vehicle.team || !shipAimPoint(cs, id, _sap)) return -1
  const ang = seekerAngle(vehicle.flight.position, axis, _sap, _sd)
  const range = spec.range ?? 2500
  return _sd.d > range || ang > (spec.lockCone ?? 0.3) * SHIP_LOCK_CONE_SCALE ? -1 : ang
}

function shipLockCandidate(cs: CombatState, vehicle: VehicleEntity, spec: WeaponSpec, axis: Vec3): string | null {
  const fleet = posedFleet()
  let best: string | null = null
  let bestAng = Infinity
  for (let i = 0; i < fleet.length; i++) {
    const ang = shipLockAngle(cs, vehicle, spec, axis, fleet[i].id)
    if (ang >= 0 && ang < bestAng) { bestAng = ang; best = fleet[i].id }
  }
  return best
}

/**
 * Damage an enemy ship (amount already scaled for ships). Hits near a turret mount damage that turret too.
 * Pushes ship-hit / turret-destroyed / ship-sunk. Friendly fire is ignored by callers.
 */
export function damageShip(
  cs: CombatState, id: string, amount: number, by: string | null, byTeam: number, worldPos: Vec3, now: number, events: GameEvent[],
): void {
  const rt = shipRuntime(cs, id)
  const ship = posedShip(id)
  if (!rt || !ship || rt.sunk || amount <= 0 || rt.team === byTeam) return
  const dealt = Math.min(amount, rt.hp)
  rt.hp -= dealt
  if (!cs.shipDamageBy) cs.shipDamageBy = [0, 0, 0, 0]
  if (byTeam >= 0 && byTeam < 4) cs.shipDamageBy[byTeam] += dealt
  const local = toShipLocal(ship, worldPos, [0, 0, 0])
  const decal: Vec3 = [Math.round(local[0] * 10) / 10, Math.round(local[1] * 10) / 10, Math.round(local[2] * 10) / 10]
  if (rt.damage.length < SHIP_DAMAGE_POINTS) rt.damage.push(decal)
  else rt.damage[rt.damageCount % SHIP_DAMAGE_POINTS] = decal
  rt.damageCount++
  // Nearest turret mount within TURRET_HIT_RADIUS takes the hit as well.
  let hitTurret: string | null = null
  let bestD = TURRET_HIT_RADIUS
  for (const t of SHIP_SPECS[rt.kind].turrets) {
    const tr = rt.turrets[t.id]
    if (!tr || tr.hp <= 0) continue
    const d = Math.hypot(local[0] - t.offset[0], local[1] - t.offset[1], local[2] - t.offset[2])
    if (d <= bestD) { bestD = d; hitTurret = t.id }
  }
  const e: GameEvent = { type: "ship-hit", ship: id, by, damage: Math.round(dealt * 10) / 10, position: [worldPos[0], worldPos[1], worldPos[2]] }
  if (hitTurret) e.turret = hitTurret
  events.push(e)
  if (hitTurret) {
    const tr = rt.turrets[hitTurret]
    tr.hp = Math.max(0, tr.hp - amount)
    if (tr.hp <= 0) events.push({ type: "turret-destroyed", ship: id, turret: hitTurret, by })
  }
  if (rt.hp <= 0) {
    rt.hp = 0
    rt.sunk = true
    rt.sunkAt = now
    events.push({ type: "ship-sunk", ship: id, team: rt.team, by, position: [ship.position[0], 0, ship.position[2]] })
  }
}

/** True if this fleet turret may fire (ship afloat, turret intact). */
export function turretOperational(cs: CombatState, shipId: string, turretId: string): boolean {
  const rt = shipRuntime(cs, shipId)
  if (!rt || rt.sunk) return false
  const tr = rt.turrets[turretId]
  return !!tr && tr.hp > 0
}

const _ta: Vec3 = [0, 0, 0]
const _tm: Vec3 = [0, 0, 0]

/** Fleet turret by ship + turret id. */
export function findTurret(shipId: string, turretId: string): AaTurret | null {
  for (let i = 0; i < AA_TURRETS.length; i++) if (AA_TURRETS[i].ship.id === shipId && AA_TURRETS[i].turret === turretId) return AA_TURRETS[i]
  return null
}

/** Muzzle for a manned turret shot along `dir`: the mount, pushed out of the own hull/superstructure. */
function turretMuzzle(t: AaTurret, dir: Vec3, out: Vec3): Vec3 {
  out[0] = t.position[0] + dir[0] * 3; out[1] = t.position[1] + dir[1] * 3; out[2] = t.position[2] + dir[2] * 3
  return out
}

/**
 * Player-controlled turret: `input.aim` aims, `firePrimary` fires. CIWS fires real 20 mm rounds (cannon20
 * ballistics); the 5-inch fires a flak shell with a proximity fuse. `player` is credited for hits/kills.
 */
export function applyTurretInput(
  cs: CombatState, shipId: string, turretId: string, player: string, input: SeatInput, now: number, events: GameEvent[],
): void {
  const t = findTurret(shipId, turretId)
  const rt = shipRuntime(cs, shipId)
  if (!t || !rt || !turretOperational(cs, shipId, turretId) || t.team >= fleetState().teams) return
  const tr = rt.turrets[turretId]
  refreshTurret(t)
  if (!input.firePrimary || !input.aim || !normalizeInto(input.aim, _ta)) return
  if (tr.readyAt < now - TICK_DT) tr.readyAt = now
  if (t.kind === "ciws") {
    const spec = WEAPONS.cannon20
    let fired = 0
    while (tr.readyAt <= now + 1e-9 && fired < 4 && cs.projectiles.length < MAX_PROJECTILES) {
      const id = cs.nextId++
      _dir[0] = _ta[0]; _dir[1] = _ta[1]; _dir[2] = _ta[2]
      applySpread(_dir, 0.004, id)
      turretMuzzle(t, _dir, _tm)
      const vx = _dir[0] * spec.speed, vy = _dir[1] * spec.speed, vz = _dir[2] * spec.speed
      const proj: ProjectileExt = {
        id, weapon: "cannon20", owner: player, vehicle: shipId, team: t.team,
        position: [_tm[0] - vx * TICK_DT, _tm[1] - vy * TICK_DT, _tm[2] - vz * TICK_DT], velocity: [vx, vy, vz],
        age: -TICK_DT, ttl: spec.ttl, ship: shipId,
      }
      cs.projectiles.push(proj)
      tr.readyAt += 1 / MANNED_CIWS_RATE
      fired++
    }
    if (fired && Math.floor(now * 4) !== Math.floor((now - TICK_DT) * 4)) emitAa(t, null, aimPointAlong(t.position, _ta, 800), events)
  } else if (tr.readyAt <= now + 1e-9) {
    tr.readyAt = now + MANNED_GUN_RELOAD
    if (!cs.shells) cs.shells = []
    turretMuzzle(t, _ta, _tm)
    cs.shells.push({
      id: cs.nextId++, owner: player, ship: shipId, team: t.team, position: [_tm[0], _tm[1], _tm[2]],
      velocity: [_ta[0] * AA_GUN_SHELL_SPEED, _ta[1] * AA_GUN_SHELL_SPEED, _ta[2] * AA_GUN_SHELL_SPEED], age: 0,
    })
    emitAa(t, null, aimPointAlong(t.position, _ta, 1500), events)
  }
}

const _apa: Vec3 = [0, 0, 0]
function aimPointAlong(p: Vec3, dir: Vec3, d: number): Vec3 {
  _apa[0] = p[0] + dir[0] * d; _apa[1] = p[1] + dir[1] * d; _apa[2] = p[2] + dir[2] * d
  return _apa
}

/** Player 5-inch shells: fly straight, burst near an enemy aircraft, on impact, or at SHELL_TTL. */
function stepShells(cs: CombatState, vehicles: VehicleEntity[], dt: number, now: number, events: GameEvent[]): void {
  const list = cs.shells
  if (!list || !list.length) return
  let w = 0
  for (let i = 0; i < list.length; i++) {
    const sh = list[i]
    sh.age += dt
    const pos = sh.position, vel = sh.velocity
    _p0[0] = pos[0]; _p0[1] = pos[1]; _p0[2] = pos[2]
    _p1[0] = pos[0] + vel[0] * dt; _p1[1] = pos[1] + vel[1] * dt; _p1[2] = pos[2] + vel[2] * dt
    // Proximity fuse: closest approach to any enemy aircraft this tick.
    let burstT = -1
    for (let k = 0; k < vehicles.length; k++) {
      const v = vehicles[k]
      if (!v.alive || v.team === sh.team) continue
      const t = sweptSphere(_p0, _p1, v.flight.position, v.flight.velocity, dt, MANNED_GUN_FUSE + VEHICLES[v.kind].radius)
      if (t >= 0 && (burstT < 0 || t < burstT)) burstT = t
    }
    let g = segmentHitsGround(_p0, _p1)
    if (g !== null) {
      const own = shipSegmentT(sh.ship, _p0, _p1)
      if (own !== null && Math.abs(own - g) < 1e-4 && sh.age < 0.5) g = null
    }
    const impact = g !== null && (burstT < 0 || g < burstT)
    if (burstT < 0 && !impact && sh.age < SHELL_TTL) {
      pos[0] = _p1[0]; pos[1] = _p1[1]; pos[2] = _p1[2]
      list[w++] = sh
      continue
    }
    lerpInto(_p0, _p1, impact ? g! : burstT >= 0 ? burstT : 1, _hit)
    if (impact) {
      const shp = segmentHitsShipEx(cs, _p0, _p1, now, sh.ship)
      if (shp && Math.abs(shp.t - g!) < 1e-3) {
        if (shp.ship.team !== sh.team) damageShip(cs, shp.ship.id, AA_GUN_DAMAGE * (SHIP_DAMAGE_SCALE.rockets ?? 1), sh.owner, sh.team, _hit, now, events)
        pushExplosion(events, _hit, AA_GUN_SPLASH * 0.5, "ground")
      } else {
        const surface = surfaceAt(_hit)
        pushExplosion(events, _hit, AA_GUN_SPLASH * 0.5, surface)
        if (surface === "ground") addCrater(cs, _hit, craterRadius("flak"), events)
      }
    } else pushExplosion(events, _hit, AA_GUN_SPLASH * 0.5, "air", true)
    for (let k = 0; k < vehicles.length; k++) {
      const v = vehicles[k]
      if (!v.alive || v.team === sh.team) continue
      const dd = Math.max(0, dist(_hit, v.flight.position) - VEHICLES[v.kind].radius)
      if (dd >= AA_GUN_SPLASH) continue
      dealDamage(v, aaDamage(v, AA_GUN_DAMAGE * (1 - dd / AA_GUN_SPLASH), now), AA_WEAPON, sh.owner, _hit, now, events)
    }
  }
  list.length = w
}

// ---------------------------------------------------------------------------------------------
// Fleet anti-air (carrier-group turrets; ships are indestructible and follow geography's fleet state,
// which the room engine sets every tick from match time — see setFleetState)
// ---------------------------------------------------------------------------------------------

/** Proposed WeaponId for fleet AA damage/kills (cast locally until types.ts adds it). */
export const AA_WEAPON = "aa" as WeaponId
/** Seconds a turret tracks a new target before it starts hitting. */
export const AA_ACQUIRE = 1.0
/** Seconds between target re-scans / line-of-sight checks per turret (staggered across turrets). */
export const AA_SCAN_INTERVAL = 0.1
/**
 * CIWS expected damage per second per turret (hit-probability model) against a slow, steady target: full
 * inside CIWS_FULL_RANGE, falling linearly to 0 at CIWS_MAX_RANGE. Actual damage is further scaled by
 * aaAccuracy (fast, crossing and maneuvering targets are hard to hit). AA is a threat, not a death ray.
 */
export const CIWS_DPS = 52
export const CIWS_FULL_RANGE = 400
export const CIWS_MAX_RANGE = 900
/** Accuracy model scales: crossing rate (rad/s), lateral acceleration (m/s²), speed (m/s). */
export const AA_CROSSING_SCALE = 0.3
export const AA_MANEUVER_SCALE = 35
export const AA_SPEED_SCALE = 450
/** CIWS damage is applied (and `aa` events emitted) in chunks of this many seconds. */
export const AA_EVENT_INTERVAL = 0.1
export const CIWS_TRACER_SPEED = 1100
/** 5-inch gun: shell speed, reload, flak burst damage/radius, dispersion (fraction of range, ± uniform). */
export const AA_GUN_SHELL_SPEED = 800
export const AA_GUN_RELOAD = 2
export const AA_GUN_DAMAGE = 70
export const AA_GUN_SPLASH = 25
export const AA_GUN_DISPERSION = 0.035

/** CIWS damage factor (0..1) at distance d from the mount. */
export function ciwsFactor(d: number): number {
  if (d >= CIWS_MAX_RANGE) return 0
  if (d <= CIWS_FULL_RANGE) return 1
  return 1 - (d - CIWS_FULL_RANGE) / (CIWS_MAX_RANGE - CIWS_FULL_RANGE)
}

/**
 * Hit-probability multiplier (0..1] for fleet AA against a target at distance `d` with velocity `v` and
 * lateral acceleration `accel` (m/s², from turret tracking): fast, crossing and jinking targets are hard to hit.
 */
export function aaAccuracy(turretPos: Vec3, targetPos: Vec3, v: Vec3, accel: number): number {
  const dx = targetPos[0] - turretPos[0], dy = targetPos[1] - turretPos[1], dz = targetPos[2] - turretPos[2]
  const d = Math.max(1, Math.sqrt(dx * dx + dy * dy + dz * dz))
  const radial = (v[0] * dx + v[1] * dy + v[2] * dz) / d
  const speed2 = v[0] * v[0] + v[1] * v[1] + v[2] * v[2]
  const crossing = Math.sqrt(Math.max(0, speed2 - radial * radial)) / d
  const c = crossing / AA_CROSSING_SCALE, a = accel / AA_MANEUVER_SCALE, sp = Math.sqrt(speed2) / AA_SPEED_SCALE
  return 1 / (1 + c * c + a * a + sp * sp)
}

/**
 * HUD/bot helper: expected CIWS damage per second (before armor) an aircraft of `team` would take at `p`
 * from every active hostile fleet turret in range, ignoring line of sight and acquisition. 0 = safe.
 */
export function fleetAaDps(team: TeamId, p: Vec3): number {
  const teams = fleetState().teams
  let dps = 0
  for (let i = 0; i < AA_TURRETS.length; i++) {
    const t = AA_TURRETS[i]
    if (t.team === team || t.kind !== "ciws" || (t.offset && t.team >= teams)) continue
    refreshTurret(t)
    dps += CIWS_DPS * ciwsFactor(dist(t.position, p))
  }
  return dps
}

export interface AaTurret {
  ship: Ship
  turret: string
  kind: TurretKind
  team: TeamId
  /** Current world position (refreshed from the ship's current pose when `offset` is set). */
  position: Vec3
  /** Mount position in ship-local coordinates (fleet turrets). */
  offset?: Vec3
}

export interface TurretState {
  /** Target velocity last tick and smoothed lateral acceleration (accuracy model). */
  lastVel?: Vec3
  accel?: number
  target: string | null
  /** Seconds tracked on the current target. */
  track: number
  /** Accumulated CIWS damage not yet applied. */
  pending: number
  nextEventAt: number
  readyAt: number
  nextScanAt: number
}

export interface FlakBurst {
  at: number
  position: Vec3
  ship: string
  team: TeamId
}

/** Every fleet turret (all four teams; inactive teams are skipped at runtime). Positions follow the ships. */
export const AA_TURRETS: AaTurret[] = FLEET.flatMap(ship =>
  SHIP_SPECS[ship.kind].turrets.map(t => ({ ship, turret: t.id, kind: t.kind, team: ship.team, position: shipToWorld(ship, t.offset), offset: t.offset })),
)

/** The turret's ship at its current pose (geography fleet state), or its static ship if not part of the fleet. */
function poseOf(ship: Ship): Ship {
  return posedShip(ship.id) ?? ship
}

/** Update a fleet turret's world position from its ship's current pose (in place). */
export function refreshTurret(t: AaTurret): void {
  if (!t.offset) return
  const ship = poseOf(t.ship)
  const c = Math.cos(ship.heading), s = Math.sin(ship.heading), o = t.offset
  t.position[0] = ship.position[0] + o[0] * c + o[2] * s
  t.position[1] = ship.position[1] + o[1]
  t.position[2] = ship.position[2] - o[0] * s + o[2] * c
}

function createTurretStates(): TurretState[] {
  return AA_TURRETS.map((_, i) => ({
    target: null, track: 0, pending: 0, nextEventAt: 0, readyAt: 0,
    // Stagger scans so turrets don't all ray-march on the same tick.
    nextScanAt: (i % 6) * (AA_SCAN_INTERVAL / 6),
  }))
}

const _ls: Vec3 = [0, 0, 0]
const _lead: Vec3 = [0, 0, 0]
const _zero: Vec3 = [0, 0, 0]

/**
 * Line of sight from a turret to a point, ignoring the turret's own ship (clip the segment start to where
 * it leaves the ship's bounding box).
 */
export function turretHasLOS(t: AaTurret, p: Vec3): boolean {
  const spec = SHIP_SPECS[t.ship.kind]
  refreshTurret(t)
  const ship = poseOf(t.ship)
  const a = worldToShip(ship, t.position), b = worldToShip(ship, p)
  const top = Math.max(spec.deckHeight, spec.island.center[1] + spec.island.half[1]) + 2
  const lo = [-spec.halfWidth - 2, -5, -spec.halfLength - 2], hi = [spec.halfWidth + 2, top, spec.halfLength + 2]
  // Slab test: exit fraction of segment a→b from the box (a may be inside or outside).
  let tExit = 0
  let tEnter = 0, tOut = 1, hits = true
  for (let k = 0; k < 3; k++) {
    const d = b[k] - a[k]
    if (Math.abs(d) < 1e-9) { if (a[k] < lo[k] || a[k] > hi[k]) { hits = false; break } continue }
    let t0 = (lo[k] - a[k]) / d, t1 = (hi[k] - a[k]) / d
    if (t0 > t1) { const x = t0; t0 = t1; t1 = x }
    if (t0 > tEnter) tEnter = t0
    if (t1 < tOut) tOut = t1
    if (tEnter > tOut) { hits = false; break }
  }
  if (hits && tEnter <= 0) tExit = Math.min(1, tOut + 1e-4)
  if (tExit >= 1) return true
  lerpInto(t.position, p, tExit, _ls)
  return segmentHitsGround(_ls, p) === null
}

function aaEligible(t: AaTurret, v: VehicleEntity, now: number): boolean {
  if (!v.alive || v.team === t.team || isSpawnProtected(v, now)) return false
  const p = v.flight.position
  // Stealth airframes above the AA ceiling are never engaged (spotted or not).
  if (VEHICLES[v.kind].stealth && p[1] > STEALTH_AA_CEILING) return false
  const dx = p[0] - t.position[0], dy = p[1] - t.position[1], dz = p[2] - t.position[2]
  return dx * dx + dy * dy + dz * dz <= AA_RANGE * AA_RANGE
}

/** Nearest eligible enemy with line of sight (tests LOS in distance order, at most 3 ray-marches). */
function aaScan(t: AaTurret, vehicles: VehicleEntity[], now: number): VehicleEntity | null {
  let lastD = -1
  for (let attempt = 0; attempt < 3; attempt++) {
    let best: VehicleEntity | null = null
    let bestD = Infinity
    for (let i = 0; i < vehicles.length; i++) {
      const v = vehicles[i]
      if (!aaEligible(t, v, now)) continue
      const d = dist(t.position, v.flight.position)
      if (d > lastD && d < bestD) { bestD = d; best = v }
    }
    if (!best) return null
    if (turretHasLOS(t, best.flight.position)) return best
    lastD = bestD
  }
  return null
}

function aaDamage(v: VehicleEntity, amount: number, now: number): number {
  const spotted = v.spottedUntil > now ? SPOTTED_DAMAGE_MULT : 1
  return amount * ARMOR[v.kind] * spotted
}

function applyAaDamage(t: AaTurret, v: VehicleEntity, amount: number, pos: Vec3, now: number, events: GameEvent[]): void {
  if (!v.alive || amount <= 0 || isSpawnProtected(v, now)) return
  v.hp -= amount
  events.push({ type: "hit", target: v.id, by: t.ship.id, weapon: AA_WEAPON, damage: amount, position: [pos[0], pos[1], pos[2]] })
  if (v.hp <= 0) killVehicle(v, "aa", null, events, t.team)
}

function emitAa(t: AaTurret, target: VehicleEntity | null, aim: Vec3, events: GameEvent[]): void {
  events.push({
    type: "aa", ship: t.ship.id, turret: t.turret, kind: t.kind, target: target ? target.id : "",
    position: [t.position[0], t.position[1], t.position[2]], aim: [aim[0], aim[1], aim[2]],
  } as unknown as GameEvent)
}

function stepFleetAA(cs: CombatState, vehicles: VehicleEntity[], dt: number, now: number, events: GameEvent[]): void {
  if (!cs.turrets || cs.turrets.length !== AA_TURRETS.length) cs.turrets = createTurretStates()
  if (!cs.bursts) cs.bursts = []
  const states = cs.turrets
  const teams = fleetState().teams
  for (let i = 0; i < AA_TURRETS.length; i++) {
    const t = AA_TURRETS[i], st = states[i]
    // Only fleets of teams in play exist; their turrets ride the moving ships.
    if (t.offset && t.team >= teams) { st.target = null; st.track = 0; st.pending = 0; continue }
    // Knocked-out turrets, sunk ships and player-manned turrets aren't AI-controlled.
    const srt = t.offset ? shipRuntime(cs, t.ship.id) : null
    const trt = srt ? srt.turrets[t.turret] : null
    if (srt && (srt.sunk || !trt || trt.hp <= 0 || trt.manned)) { st.target = null; st.track = 0; st.pending = 0; continue }
    refreshTurret(t)
    let target = st.target ? findVehicle(vehicles, st.target) : null
    if (target && !aaEligible(t, target, now)) target = null
    if (now >= st.nextScanAt) {
      st.nextScanAt = now + AA_SCAN_INTERVAL
      // Keep a still-visible target; otherwise pick the nearest visible one.
      if (!target || !turretHasLOS(t, target.flight.position)) target = aaScan(t, vehicles, now)
    }
    const id = target ? target.id : null
    if (id !== st.target) { st.target = id; st.track = 0; st.pending = 0; st.accel = 0; st.lastVel = undefined }
    if (!target) continue
    const tp = target.flight.position, tv = target.flight.velocity
    // Track the target's lateral acceleration (jinking), smoothed over ~0.3 s.
    if (st.lastVel) {
      const ax = (tv[0] - st.lastVel[0]) / dt, ay = (tv[1] - st.lastVel[1]) / dt, az = (tv[2] - st.lastVel[2]) / dt
      const sp = Math.max(1e-6, Math.sqrt(tv[0] * tv[0] + tv[1] * tv[1] + tv[2] * tv[2]))
      const along = (ax * tv[0] + ay * tv[1] + az * tv[2]) / sp
      const lat = Math.sqrt(Math.max(0, ax * ax + ay * ay + az * az - along * along))
      st.accel = (st.accel ?? 0) + (Math.min(lat, 200) - (st.accel ?? 0)) * Math.min(1, dt / 0.3)
      st.lastVel[0] = tv[0]; st.lastVel[1] = tv[1]; st.lastVel[2] = tv[2]
    } else st.lastVel = [tv[0], tv[1], tv[2]]
    st.track += dt
    // Unspotted stealth below the ceiling takes twice as long to acquire.
    if (st.track < AA_ACQUIRE * (isHiddenStealth(target, now) ? 2 : 1)) continue

    const d = dist(t.position, tp)
    const acc = aaAccuracy(t.position, tp, tv, st.accel ?? 0)
    if (t.kind === "ciws") {
      st.pending += aaDamage(target, CIWS_DPS * ciwsFactor(d) * acc, now) * dt
      if (now >= st.nextEventAt) {
        st.nextEventAt = now + AA_EVENT_INTERVAL
        if (leadPoint(t.position, _zero, CIWS_TRACER_SPEED, tp, tv, _lead) < 0) { _lead[0] = tp[0]; _lead[1] = tp[1]; _lead[2] = tp[2] }
        emitAa(t, target, _lead, events)
        const dmg = st.pending
        st.pending = 0
        applyAaDamage(t, target, dmg, tp, now, events)
      }
    } else if (now >= st.readyAt) {
      st.readyAt = now + AA_GUN_RELOAD
      const tof = leadPoint(t.position, _zero, AA_GUN_SHELL_SPEED, tp, tv, _lead)
      if (tof < 0) continue
      const seed = (i + 1) * 7919 + Math.floor(now * 60)
      // Mostly near misses: dispersion grows with range and with how hard the target is to track.
      const spread = AA_GUN_DISPERSION * d / Math.sqrt(acc)
      const ox = (hash01(seed, 11) * 2 - 1) * spread, oy = (hash01(seed, 12) * 2 - 1) * spread, oz = (hash01(seed, 13) * 2 - 1) * spread
      emitAa(t, target, _lead, events)
      cs.bursts.push({ at: now + tof, position: [_lead[0] + ox, _lead[1] + oy, _lead[2] + oz], ship: t.ship.id, team: t.team })
    }
  }

  // Flak bursts: splash to enemies of the firing fleet.
  const bursts = cs.bursts
  let w = 0
  for (let i = 0; i < bursts.length; i++) {
    const b = bursts[i]
    if (b.at > now) { bursts[w++] = b; continue }
    pushExplosion(events, b.position, AA_GUN_SPLASH * 0.5, "air", true)
    const t = AA_TURRETS.find(x => x.ship.id === b.ship)
    if (!t) continue
    for (let k = 0; k < vehicles.length; k++) {
      const v = vehicles[k]
      if (!v.alive || v.team === b.team) continue
      const dd = Math.max(0, dist(b.position, v.flight.position) - VEHICLES[v.kind].radius)
      if (dd >= AA_GUN_SPLASH) continue
      applyAaDamage(t, v, aaDamage(v, AA_GUN_DAMAGE * (1 - dd / AA_GUN_SPLASH), now), b.position, now, events)
    }
  }
  bursts.length = w
}
