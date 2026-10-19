import type { RewindHistory } from "@arcade/kit/net/rewind"
import type { Rect } from "@arcade/kit/sim/geom"
import type { AIConfig, OutbreakAISubsystem } from "./ai"
import type { MeleeTuning, OutbreakCombatSubsystem, SurvivorCombatState } from "./combat"
import type { FlashlightState, FlashlightTuning } from "./flashlight"
import type { InteractActionId, InteractActorState, InteractionRegistry, InteractTarget, PeekInfo } from "./interact"
import type { Town } from "./map"
import type { OutbreakProgression } from "./progression/progression"
import type { WorldContext } from "./progression/types"
import type { StaminaState, StaminaTuning } from "./stamina"
import type { Notice, PickMode } from "./types"
import type { OutbreakVehicleSubsystem, VehicleTuning } from "./vehicles"
import type { StreamingWorld } from "./world"

/**
 * The simulation's shared shapes: commands, survivors, session tuning, and `OutbreakSim`, the view of `CoopSim` that
 * features and the feature registry program against. Types only, so features import this instead of `coop-sim.ts`.
 */

export type NamespacedSessionTuning = {
  stamina?: Partial<StaminaTuning>
  flashlight?: Partial<FlashlightTuning>
  ai?: Partial<AIConfig>
  melee?: Partial<MeleeTuning>
  vehicle?: Partial<VehicleTuning>
  combat?: Partial<MeleeTuning> & {
    /** Dev cheat: keeps the pistol magazine full. 1 = on. */
    infiniteAmmo?: number
  }
}

export type LegacyFlatSessionTuning = Partial<StaminaTuning> &
  Partial<FlashlightTuning> &
  Partial<AIConfig> &
  Partial<MeleeTuning> &
  Partial<VehicleTuning> & {
    /** Dev cheat: keeps the pistol magazine full. 1 = on. */
    infiniteAmmo?: number
  }

export type SessionTuning = NamespacedSessionTuning | LegacyFlatSessionTuning

export type ResolvedSessionTuning = {
  stamina: StaminaTuning
  flashlight: FlashlightTuning
  ai: Partial<AIConfig> | undefined
  melee: MeleeTuning
  vehicle: VehicleTuning
  infiniteAmmo: boolean
  features?: Readonly<Record<string, Record<string, unknown>>>
}

export type Command = {
  mx: number
  my: number
  aim: number
  interact: boolean
  interactHeld?: boolean
  flashlight?: boolean
  sprint?: boolean
  jump?: boolean
  hotbarSlot?: number
  hotbarDelta?: number
  fire?: boolean
  /** True while the primary attack button (Mouse0) is held down (charges heavy melee swings). */
  fireHeld?: boolean
  reload?: boolean
  melee?: boolean
  barricade?: boolean
  interactAction?: InteractActionId
  /** G tap: drop the held item. */
  drop?: boolean
  /** G hold: leave a bundle of ammo and planks. */
  bundle?: boolean
  /** Q tap: mark what you are looking at for the squad. */
  ping?: boolean
  /** C tap: cycle vehicle seat. */
  seat?: boolean
  /** Ctrl held: crouch. */
  crouch?: boolean
  /** H hold: vehicle horn. */
  horn?: boolean
  /** A digit while a strip is open (container, stash, the recipe panel or pack). */
  pick?: { mode: PickMode; index: number }
}

export type Survivor = {
  x: number
  y: number
  vx: number
  vy: number
  aim: number
  health: number
  maxHealth: number
  vehicleId?: number | null
  seatIndex?: number
  /** Ctrl held: slower, quieter, a smaller shape to the dead, and able to step over a tripwire. */
  crouching?: boolean
} & StaminaState &
  FlashlightState &
  InteractActorState &
  SurvivorCombatState

export type SurvivorSlot = {
  /** Public id: "player" offline, the seat id in co-op. Also the AI target and noise source id. */
  readonly id: string
  readonly index: number
  survivor: Survivor
  prompt: InteractTarget | undefined
  peek: PeekInfo | null
  /** Feedback for this survivor (search results, recipes learned, "Inventory full"), drained by its presentation. */
  notices: Notice[]
}

/** What features see of the authoritative world (`CoopSim` implements it). */
export interface OutbreakSim {
  readonly seed: number
  readonly town: Town
  readonly worldStream: StreamingWorld
  readonly ai: OutbreakAISubsystem
  readonly combat: OutbreakCombatSubsystem
  readonly vehicles: OutbreakVehicleSubsystem
  readonly registry: InteractionRegistry
  readonly progression: OutbreakProgression
  readonly rewind: RewindHistory<number>
  readonly slots: SurvivorSlot[]
  readonly featureStates: Map<string, unknown>
  vehicleSolids: Rect[]
  hour: number
  time: number
  revision: number
  /** What progression needs to know about the world this tick. */
  world(): WorldContext
  slot(id: string): SurvivorSlot | undefined
  /** Streams active chunks around all connected survivors and updates collision/navigation when windows shift. */
  syncWorldChunks(): boolean
  /** Retrieves pure per-simulation state registered by a shared feature (`id`). */
  getFeatureState<T = unknown>(id: string): T | undefined
}
