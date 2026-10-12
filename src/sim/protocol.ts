// Network protocol between browser and Room Durable Object (JSON over WebSocket).
// Owned by the orchestrator.
import type {
  Flare, FlightInput, GameEvent, Missile, PlayerInfo, Projectile, SeatIndex, SeatInput, TeamId, Vec3, VehicleEntity, VehicleKind,
} from "./types"

export interface RoomConfig {
  /** 2..4 */
  teams: number
  /** Bots per team (0..10). Bots fill seats/vehicles server-side. */
  bots: number
  /** Bot skill 0..1 (default 0.5). */
  botSkill?: number
  /** Quick Play: fill each team up to this many players with bots while humans are few. */
  botFill?: number
  maxPerTeam: number
  scoreLimit: number
  /** Seconds. */
  timeLimit: number
  /** Listed in the public room browser. */
  listed: boolean
  name: string
}

export const DEFAULT_ROOM_CONFIG: RoomConfig = {
  teams: 2, bots: 0, maxPerTeam: 10, scoreLimit: 50, timeLimit: 10 * 60, listed: true, name: "Open Skies",
}

/** Empty rooms (no humans) are destroyed after this many ms. */
export const EMPTY_ROOM_TTL_MS = 60_000
export const RESPAWN_DELAY = 5

export type ClientMessage =
  | { type: "hello"; name: string; team?: TeamId; config?: Partial<RoomConfig> }
  | { type: "spawn"; kind: VehicleKind }
  /** Take control of a ship turret on your own team instead of flying (seat input aims + fires it). */
  | { type: "man-turret"; ship: string; turret: string }
  | { type: "board"; vehicle: string; seat: SeatIndex }
  | { type: "switch-seat"; seat: SeatIndex }
  | { type: "leave-vehicle" }
  | { type: "team"; team: TeamId }
  | { type: "input"; seq: number; flight?: FlightInput; seat?: SeatInput }
  | { type: "chat"; text: string }
  | { type: "ping"; t: number }

/** Live state of a ship (destructible objective). */
export interface ShipState {
  id: string
  hp: number
  maxHp: number
  sunk: boolean
  /** Room time the ship was sunk (sinking animation), or 0. */
  sunkAt: number
  /** Per-turret hp (0 = knocked out) and the player manning it (null = AI). */
  turrets: Record<string, { hp: number; manned: string | null }>
  /** Damage decals: ship-local hit points (for fires/smoke/scorch), capped list. */
  damage: Vec3[]
}

/** Persistent terrain damage (craters/scorch on islands), world position + radius. */
export interface Crater {
  position: Vec3
  radius: number
}

export interface Snapshot {
  type: "snapshot"
  /** Room time in seconds. */
  time: number
  tick: number
  vehicles: VehicleEntity[]
  players: PlayerInfo[]
  projectiles: Projectile[]
  missiles: Missile[]
  flares: Flare[]
  scores: number[]
  /** Ship objectives (only active teams). */
  ships?: ShipState[]
  /** Craters added since the last snapshot (clients accumulate; full list sent on join). */
  craters?: Crater[]
  /** Room time when the current match ends (time limit). */
  matchEndsAt: number
  /** Room time when the current match started (fleet movement uses match time = time - matchStartedAt). */
  matchStartedAt?: number
  /** True between matches (no spawning/scoring); next match starts at `matchEndsAt`. */
  intermission: boolean
  /** Last input seq processed for the receiving player (for reconciliation). */
  ack: number
}

export type ServerMessage =
  | { type: "welcome"; playerId: string; room: string; config: RoomConfig }
  | Snapshot
  | { type: "events"; events: GameEvent[] }
  | { type: "error"; message: string }
  | { type: "pong"; t: number }

export interface RoomSummary {
  code: string
  name: string
  teams: number
  players: number
  humans: number
  maxPlayers: number
}
