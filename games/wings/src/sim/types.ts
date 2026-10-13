// Shared, dependency-free types used by both the browser client and the Cloudflare Worker.
// Owned by the orchestrator. Request changes instead of editing from a module agent.

export type Vec3 = [number, number, number]
/** Unit quaternion [x, y, z, w]. Body axes: nose = -Z, up = +Y, right = +X. */
export type Quat = [number, number, number, number]

export type TeamId = 0 | 1 | 2 | 3
export type VehicleKind = "fighter" | "apache" | "warthog" | "blackbird" | "bomber"
export type FlightModel = "jet" | "heli"
export type SeatIndex = 0 | 1
export type WeaponSlot = "primary" | "secondary"
export type Quality = "low" | "balanced" | "high"

export const TICK_RATE = 60
export const TICK_DT = 1 / TICK_RATE
export const SNAPSHOT_RATE = 20

/**
 * Per-tick piloting input (seat 0). All axes are clamped to [-1, 1].
 * Signs: roll +1 = roll right (D), pitch +1 = nose up, yaw +1 = yaw right (E).
 * Helicopters: releasing the throttle axis eases the collective back to hover.
 */
export interface FlightInput {
  /** Mouse-aim: desired nose direction as a world-space unit vector. null = no mouse steering. */
  aim: Vec3 | null
  /** Jets: throttle up/down (W/S). Helicopters: collective up/down. */
  throttle: number
  /** Manual roll (A/D). Overrides the autopilot roll while non-zero. */
  roll: number
  /** Manual yaw / rudder (Q/E). Helicopters: pedal yaw. */
  yaw: number
  /** Manual pitch (arrow keys). Overrides the autopilot pitch while non-zero. */
  pitch: number
  boost: boolean
  /** Jets: airbrake + wheel brakes. Helicopters: hover-hold (auto-level, kill drift). */
  brake: boolean
}

export interface FlightState {
  kind: VehicleKind
  position: Vec3
  velocity: Vec3
  orientation: Quat
  /** Body-space angular velocity (rad/s): x = pitch, y = yaw, z = roll. */
  angularVelocity: Vec3
  /** Stored throttle (jets) or collective (helis), 0..1. Persists between inputs. */
  throttle: number
  onGround: boolean
  gearDown: boolean
  /** Set when the airframe touched terrain/water/boundary hard enough to be destroyed. */
  crashed: null | "terrain" | "water" | "boundary"
  tick: number
}

/** Read-only world queries the flight model needs. Implemented by geography.ts. */
export interface WorldQuery {
  /** Height of the solid surface (terrain, runway or water) at x,z. */
  groundHeight(x: number, z: number): number
  /** True when x,z is on a paved runway/apron (wheels roll there without damage). */
  onRunway(x: number, z: number): boolean
  /** True when the surface at x,z is open water. Optional; flight falls back to height ≤ water level. */
  isWater?(x: number, z: number): boolean
  /** Map boundary half-extent in meters (square map centered on origin). */
  half: number
  /** Hard altitude ceiling in meters. */
  ceiling: number
  /** Velocity of a moving deck (carrier) under x,z, or null/undefined when the surface is static. */
  deckVelocity?(x: number, z: number): Vec3 | null
}

/** Per-tick weapons/aim input for a seat. */
export interface SeatInput {
  /** World-space aim direction (gunner camera / pilot reticle). */
  aim: Vec3 | null
  firePrimary: boolean
  fireSecondary: boolean
  flares: boolean
  /** Seat-2 ability (e.g. radar pulse, mark target). */
  ability: boolean
  /** Seconds the shooter sees remote aircraft behind the server (interp delay + RTT/2), for lag-compensated hits. */
  viewDelay?: number
  /**
   * Bomb-steer mode: while this seat's most recent bomb is falling, `aim` is the unit direction from that bomb
   * toward the desired impact point and steers it (limited fin authority). Ignored when false/absent.
   */
  steerBomb?: boolean
}

export interface WeaponRuntime {
  ammo: number
  /** Room time (seconds) when this weapon can fire again. */
  readyAt: number
  /** Vehicle id currently locked (missiles). */
  lockTarget: string | null
  /** 0..1 lock progress. */
  lock: number
  /** Server-only: room time of last shot (ammo regen delay). */
  firedAt?: number
  /** Server-only: fractional regen accumulator. */
  regen?: number
}

export interface VehicleEntity {
  id: string
  kind: VehicleKind
  team: TeamId
  flight: FlightState
  hp: number
  maxHp: number
  /** Player ids per seat, null when empty. */
  seats: [string | null, string | null]
  /** Latest aim per seat (world-space unit vectors). */
  aim: [Vec3 | null, Vec3 | null]
  /** weapons[seat][slotIndex]: 0 = primary, 1 = secondary. */
  weapons: [WeaponRuntime[], WeaponRuntime[]]
  flaresReadyAt: number
  flareCount: number
  abilityReadyAt: number
  /** Room time until which the enemy team sees this vehicle highlighted (spotted / radar paint). */
  spottedUntil: number
  /** Recon look-to-spot progress 0..1 held by the spotting vehicle (pilot seat), and its current candidate. */
  spotProgress?: number
  spotCandidate?: string | null
  lastDamagedBy: string | null
  alive: boolean
  /** Room time the vehicle spawned (spawn protection). */
  spawnedAt?: number
}

export interface PlayerInfo {
  id: string
  name: string
  team: TeamId
  vehicleId: string | null
  seat: SeatIndex | null
  kills: number
  deaths: number
  bot: boolean
  /** Room time when the player may spawn again (after death). */
  respawnAt: number
  /** When manning a ship turret instead of flying: ship + turret ids. */
  turret?: { ship: string; turret: string } | null
}

/**
 * Bombs are projectiles with weapon "bomb". The bomb a player can steer is their own most recent one:
 * the highest-`id` "bomb" projectile whose `owner` is that player id (no extra wire field).
 */
export interface Projectile {
  id: number
  weapon: WeaponId
  owner: string // player id
  vehicle: string // shooter vehicle id
  team: TeamId
  position: Vec3
  velocity: Vec3
  age: number
  ttl: number
}

export interface Missile {
  id: number
  weapon: WeaponId
  owner: string
  vehicle: string
  team: TeamId
  position: Vec3
  velocity: Vec3
  target: string | null
  /** Scanner-guided (aim47): homes only while the operator's scanner stays on target. */
  steered: boolean
  /** Scanner missiles: currently receiving guidance. */
  guided?: boolean
  /** Scanner missiles: the target it was fired at (kept after guidance drops, for the HUD). */
  scanTarget?: string | null
  /** Seat that launched it (steering source). */
  seat?: SeatIndex
  age: number
  ttl: number
}

export interface Flare {
  id: number
  vehicle: string
  position: Vec3
  velocity: Vec3
  age: number
  ttl: number
}

export type WeaponId =
  | "bomb"
  | "cannon20"
  | "chaingun30"
  | "gau8"
  | "rockets"
  | "aim9"
  | "tvmissile"
  | "hellfire"
  | "maverick"
  | "aim47"
  | "radarpulse"

/** Ids: `vehicle`, `target`, `victim` are vehicle ids; `by`, `killer`, `player` are player ids. */
export type GameEvent =
  | { type: "fire"; vehicle: string; seat: SeatIndex; weapon: WeaponId; hardpoint?: number }
  | { type: "hit"; target: string; by: string; weapon: WeaponId; damage: number; position: Vec3 }
  | { type: "kill"; victim: string; victimTeam: TeamId; killer: string | null; killerTeam?: TeamId; weapon: WeaponId | "crash" | "aa"; position: Vec3 }
  /** Fleet anti-air fire: `position` = muzzle, `aim` = lead point. ~10/s per firing CIWS, once per gun shot. */
  | { type: "aa"; ship: string; turret: string; kind: "ciws" | "gun"; target: string; position: Vec3; aim: Vec3 }
  | { type: "explosion"; position: Vec3; size: number; surface?: "water" | "ground" | "air"; kind?: "flak" }
  | { type: "flares"; vehicle: string }
  | { type: "lock"; vehicle: string; target: string; locked: boolean }
  | { type: "pulse"; vehicle: string; team: TeamId; position: Vec3; radius: number }
  | { type: "guidance"; missile: number; vehicle: string; target: string; guided: boolean }
  /** A ship took damage (`by` = player id or null), at a world position. */
  | { type: "ship-hit"; ship: string; by: string | null; damage: number; position: Vec3; turret?: string }
  /** A ship turret was knocked out. */
  | { type: "turret-destroyed"; ship: string; turret: string; by: string | null }
  /** A ship sank. `team` = the ship's team. */
  | { type: "ship-sunk"; ship: string; team: TeamId; by: string | null; position: Vec3 }
  /** Terrain damage: a crater/scorch mark on an island. */
  | { type: "crater"; position: Vec3; radius: number }
  /** An enemy was spotted (recon look-to-spot or radar pulse); `by` = spotting vehicle, `target` = spotted vehicle. */
  | { type: "spotted"; by: string; team: TeamId; target: string; until: number }
  | { type: "chat"; player: string; text: string }
  | { type: "score"; scores: number[] }
  | { type: "match-end"; winner: TeamId | null; reason?: "carriers-sunk" | "time" | "score" }
