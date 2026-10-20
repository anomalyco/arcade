import type { MeleeSwingPhase } from "@arcade/kit/human-melee"
import type { InterestConfig } from "@arcade/kit/net/interest"
import type { LedgerDelta } from "@arcade/kit/sim/ledger"
import type { AIState } from "./ai"
import type { CombatMeleeEvent, CombatShotEvent, MeleeWeaponId } from "./combat"
import type { DeathSnapshot } from "./death/rules"
import type { NoisesSnapshot } from "./noises/types"
import type { SpecialsSnapshot } from "./specials/net-types"
import type { BodiesSnapshot } from "./bodies/net-types"
import type { BreachSnapshot } from "./breach/net-types"
import type { LoadoutId, SurvivorVariant } from "./loadout"
import type { Survivor } from "./sim-types"
import type { Notice } from "./types"
import type { VehicleKind } from "./vehicles/types"
import type { ChunkCoord } from "./world"

/**
 * The co-op wire protocol's message and snapshot shapes, with no codec code, so features and the registry can name
 * them without importing `net-protocol.ts` (which encodes a whole `CoopSim`).
 */

export type RoomPhase = "lobby" | "running"

export type RosterEntry = {
  id: string
  index: number
  name: string
  connected: boolean
  variant?: SurvivorVariant
  loadout?: LoadoutId
  ready?: boolean
  host?: boolean
}

export type ClientMsg =
  | {
      t: "hello"
      name: string
      token?: string
      build: string
      variant?: SurvivorVariant
      loadout?: LoadoutId
      lobby?: boolean
    }
  /** Commands `s`, `s+1`, … for consecutive 60 Hz ticks, plus optional `a` (last acked snapshot tick) and `v` (view tick). */
  | { t: "in"; s: number; c: CommandTuple[]; a?: number; v?: number }
  | { t: "ping"; c: number; a?: number }
  | { t: "pick"; variant?: SurvivorVariant; loadout?: LoadoutId; name?: string }
  | { t: "ready"; ready: boolean }
  | { t: "start" }
  | { t: "leave" }
  /** After a run is over: start the room's world again (`shared/death`). */
  | { t: "restart" }

export type ServerMsg =
  | {
      t: "welcome"
      id: string
      token: string
      index: number
      room: string
      seed: number
      houseSeed: number
      terrain: number
      zombieCount: number
      phase?: RoomPhase
      hostId?: string
      variant?: SurvivorVariant
      loadout?: LoadoutId
      ready?: boolean
    }
  | { t: "roster"; players: RosterEntry[]; phase?: RoomPhase; hostId?: string }
  | { t: "error"; message: string }
  /** `restart`: the room started its world again after a run ended; otherwise a new build is out. */
  | { t: "reload"; reason?: "restart" }
  | { t: "pong"; c: number }

/** [mx, my, aim, flags, hotbarSlot (−1 none), hotbarDelta, interactAction code, pick code (mode·8 + index + 1)] */
export type CommandTuple = [number, number, number, number, number?, number?, number?, number?, number?]

export type RemoteSurvivor = {
  index: number
  x: number
  y: number
  aim: number
  flashlightOn: boolean
  sprinting: boolean
  pistol: boolean
  reloading: boolean
  exhausted: boolean
  /** Rides the health byte's top bit (health never passes 100). */
  crouching?: boolean
  flashlightOutput: number
  health: number
  recoil: number
  lift: number
  meleeWeapon?: MeleeWeaponId | null
  meleePhase?: MeleeSwingPhase
  meleeCombo?: 1 | 2 | 3
  meleeProgress?: number
}

export type ZombieState = {
  id: number
  seed: number
  x: number
  y: number
  aim: number
  state: AIState
  hp: number
  hitFlash: number
  stateTime: number
  timer: number
  clamber: number
  limbMask?: number
}

export type VehicleState = {
  id: number
  kind: VehicleKind
  x: number
  y: number
  h: number
  vx: number
  vy: number
  w: number
  hp: number
  fuel: number
  hasBattery: boolean
  hasKeys: boolean
  headlights: boolean
  engineOn: boolean
  horn: boolean
  wreck: boolean
  handbrake: boolean
  throttle: number
  steer: number
  /** Survivor seat index (0..3) per vehicle seat, or -1 when empty. */
  seats: number[]
}

export type SharedSnapshot = {
  tick: number
  time: number
  hour: number
  revision: number
  survivors: RemoteSurvivor[]
  zombies: ZombieState[]
  vehicles?: VehicleState[]
  doors: { open: boolean; locked: boolean }[]
  windows: { open: boolean; openable: boolean }[]
  planks: number[]
  /** Barricade hit points per portal, quantised to six bits of wear (see `shared/discovery/barricade.ts`). */
  plankHp: number[]
  pings: { id: number; by: number; x: number; y: number; label: string; left: number }[]
  lures: { id: number; x: number; y: number; left: number }[]
  /** Recent bashes, with the barricade's packed planks and wear after the hit so boards bow on every client. */
  bashes: { portal: number; age: number; planks: number }[]
  shots: (CombatShotEvent & { shooter: number })[]
  meleeSwings?: CombatMeleeEvent[]
  /** Who is down or dead, fallen bodies and the run's end (`shared/death`). */
  death?: DeathSnapshot
  /** Noises the dead heard since the base snapshot, near the recipient (`shared/noises`). */
  noises?: NoisesSnapshot
  /** Active Bloater gas hazards (`shared/specials`). */
  specials?: SpecialsSnapshot
  /** Searchable corpses that started rising (`shared/bodies`). */
  bodies?: BodiesSnapshot
  /** Damaged doors and windows: wear, warning beats, breaches, fallen slabs (`shared/breach`). */
  breach?: BreachSnapshot
}

/** The private part: what to reconcile against, the ledger stores this player can see that changed, and notices. */
export type PersonalSnapshot = { ack: number; survivor: Partial<Survivor>; ledger: LedgerDelta | null; notices: Notice[] }

export type SnapshotEncodeOptions = {
  /** Recipient's active 3×3 chunk window center (when supplied, culls entities outside the bubble). */
  viewerCenter?: ChunkCoord
  /** Last snapshot acknowledged by this recipient (enables delta compression against acked state). */
  baseSnap?: SharedSnapshot
  /** Canonical snapshot emitted for this bubble on the previous snapshot tick, so throttling is independent of `baseSnap`. */
  prevBubbleSnap?: SharedSnapshot
  /** Monotonic snapshot counter (0, 1, 2, …) for priority-accumulator cadence scheduling. */
  snapIndex?: number
  /** Interest bubble and stride configuration. */
  interest?: InterestConfig
  /** Optional output holder receiving the reconstructed `SharedSnapshot` emitted for this recipient/bubble. */
  outSnapshot?: { snap?: SharedSnapshot }
}

export type SnapshotFieldBreakdown = {
  total: number
  personalBytes: number
  headerBytes: number
  survivorsBytes: number
  zombiesBytes: number
  portalsBytes: number
  eventsBytes: number
}
