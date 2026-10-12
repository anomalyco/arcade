// Network protocol between browser and Room Durable Object (JSON over WebSocket).
// Owned by the orchestrator.
import type {
  Flare, FlightInput, GameEvent, Missile, PlayerInfo, Projectile, SeatIndex, SeatInput, TeamId, VehicleEntity, VehicleKind,
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
  | { type: "board"; vehicle: string; seat: SeatIndex }
  | { type: "switch-seat"; seat: SeatIndex }
  | { type: "leave-vehicle" }
  | { type: "team"; team: TeamId }
  | { type: "input"; seq: number; flight?: FlightInput; seat?: SeatInput }
  | { type: "chat"; text: string }
  | { type: "ping"; t: number }

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
