// Shared, dependency-free types used by both the browser client and the Cloudflare Worker.
// Owned by the orchestrator. Request changes instead of editing from a module agent.

export type Vec3 = [number, number, number]
/** Unit quaternion [x, y, z, w]. Body axes: nose = -Z, up = +Y, right = +X. */
export type Quat = [number, number, number, number]

export type TeamId = 0 | 1 | 2 | 3
export type VehicleKind = "fighter" | "apache" | "warthog" | "blackbird"
export type FlightModel = "jet" | "heli"
export type SeatIndex = 0 | 1
export type WeaponSlot = "primary" | "secondary"
export type Quality = "low" | "balanced" | "high"

export const TICK_RATE = 60
export const TICK_DT = 1 / TICK_RATE
export const SNAPSHOT_RATE = 20

/** Per-tick piloting input (seat 0). All axes are clamped to [-1, 1]. */
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
  /** Map boundary half-extent in meters (square map centered on origin). */
  half: number
  /** Hard altitude ceiling in meters. */
  ceiling: number
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
}

export interface WeaponRuntime {
  ammo: number
  /** Room time (seconds) when this weapon can fire again. */
  readyAt: number
  /** Vehicle id currently locked (missiles). */
  lockTarget: string | null
  /** 0..1 lock progress. */
  lock: number
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
  /** Room time until which enemies see this vehicle highlighted (radar paint). */
  spottedUntil: number
  lastDamagedBy: string | null
  alive: boolean
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
}

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
  /** Player-steered (TV/Hellfire): guidance follows the owner's seat aim. */
  steered: boolean
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

export type GameEvent =
  | { type: "fire"; vehicle: string; seat: SeatIndex; weapon: WeaponId }
  | { type: "hit"; target: string; by: string; weapon: WeaponId; damage: number; position: Vec3 }
  | { type: "kill"; victim: string; victimTeam: TeamId; killer: string | null; weapon: WeaponId | "crash"; position: Vec3 }
  | { type: "explosion"; position: Vec3; size: number }
  | { type: "flares"; vehicle: string }
  | { type: "lock"; vehicle: string; target: string; locked: boolean }
  | { type: "pulse"; vehicle: string; team: TeamId; position: Vec3; radius: number }
  | { type: "chat"; player: string; text: string }
  | { type: "score"; scores: number[] }
  | { type: "match-end"; winner: TeamId | null }
