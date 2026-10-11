// Shared contract between the sim, the Room Durable Object and the client.
// Owned by the integrator: extend only by adding optional fields or new union members.
import type { WeaponId } from "./weapons"

export type PowerupId = "credits" | "weapon" | "shield" | "boost" | "repair" | "preview" | "fuel"
export type Phase = "lobby" | "aim" | "resolve" | "shop" | "over"
export type Mode = "ffa" | "teams"

export const TEAM_COLORS = ["#2ee6ff", "#ff8a1f", "#ff3df0", "#a6ff3d", "#ffd84a", "#8b6bff", "#ff4a5e", "#4affc1", "#4a8bff", "#ff9ec7", "#e8f0ff", "#c0ff8a"]

export interface Unit {
  id: number
  team: number
  name: string
  x: number
  y: number
  hp: number
  maxHp: number
  alive: boolean
  kills: number
  ammo: Record<WeaponId, number>
  shield: number
  boost: number
  fuel: number
  angle: number
  // aim-preview level: 0/undefined = base length; each level (targeting lens, LONG SIGHT crate) extends it
  preview?: number
}

export interface Shot {
  unit: number
  weapon: WeaponId
  angle: number
  power: number
}

export interface Crate {
  id: number
  x: number
  y: number
  kind: PowerupId
  landed: boolean
}

export interface Ghost {
  unit: number
  angle: number
  power: number
  locked: boolean
}

export type SimEvent =
  | { t: number; type: "carve"; x: number; y: number; r: number }
  | { t: number; type: "fill"; x0: number; y0: number; x1: number; y1: number }
  | { t: number; type: "chunk"; id: number; x: number; y: number; w: number; h: number; bits: string; dy: number; dur: number }
  | { t: number; type: "boom"; x: number; y: number; r: number; kind: WeaponId; owner: number }
  | { t: number; type: "collide"; x: number; y: number }
  | { t: number; type: "hit"; unit: number; amount: number; x: number; y: number; killer: number; kill: boolean }
  | { t: number; type: "absorb"; unit: number; amount: number }
  | { t: number; type: "move"; unit: number; x: number; y: number; dur: number }
  | { t: number; type: "fall"; unit: number; x: number; y: number; dy: number; dmg: number }
  | { t: number; type: "fire"; x0: number; x1: number; y: number; dur: number; owner: number }
  | { t: number; type: "well"; x: number; y: number; r: number; dur: number; owner: number }
  | { t: number; type: "builder"; x: number; y: number; w: number; h: number }
  | { t: number; type: "teleport"; unit: number; x0: number; y0: number; x: number; y: number }
  | { t: number; type: "shieldUp"; unit: number; hp: number }
  | { t: number; type: "crate"; crate: number; unit: number; kind: PowerupId; detail: string }
  | { t: number; type: "hazard"; y: number }

export interface PathOut {
  id: number
  owner: number
  kind: WeaponId | "bomblet"
  t0: number
  dt: number
  pts: number[]
}

export interface VolleyResult {
  events: SimEvent[]
  paths: PathOut[]
  durationMs: number
  hash: number
}

export interface PlayerView {
  id: string
  name: string
  team: number
  unit: number
  bot: boolean
  connected: boolean
  locked: boolean
  spectator: boolean
  credits: number
  score: number
  damage: number
  kills: number
  wins: number
  host: boolean
}

export interface MatchView {
  room: string
  mode: Mode
  phase: Phase
  phaseEndsAt: number
  now: number
  battle: number
  battles: number
  volley: number
  seed: number
  wind: number
  hazardY: number
  units: Unit[]
  players: PlayerView[]
  crates: Crate[]
  ghosts: Ghost[]
  battleWinner: string | null
  matchWinner: string | null
  mask?: string
}

export type ClientMsg =
  | { type: "join"; name: string }
  | { type: "aim"; angle: number; power: number; weapon: WeaponId }
  | { type: "move"; dir: -1 | 1 }
  | { type: "lock" }
  | { type: "buy"; item: string }
  | { type: "ready" }
  | { type: "start"; mode: Mode; bots: number; battles: number }
  | { type: "ping"; t: number }

export type ServerMsg =
  | { type: "welcome"; you: string; view: MatchView }
  | { type: "state"; view: MatchView }
  | { type: "ghosts"; ghosts: Ghost[] }
  | { type: "volley"; shots: Shot[]; result: VolleyResult; before: MatchView; after: MatchView }
  | { type: "pong"; t: number; now: number }
  | { type: "notice"; text: string }
  | { type: "error"; message: string }
