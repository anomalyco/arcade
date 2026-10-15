import type { AIAgent, AIConfig, NoiseEvent, OutbreakAISubsystem } from "./ai"
import type { CombatMeleeEvent, CombatShotEvent, OutbreakCombatSubsystem } from "./combat"
import { CoopSim } from "./coop-sim"
import type { InteractionRegistry, InteractTarget, PeekInfo } from "./interact"
import { inventoryView, type InventoryState } from "./inventory"
import type { Town } from "./map"
import type { LootSite } from "./progression/loot"
import type { OutbreakProgression } from "./progression/progression"
import type { ProgressionTuning } from "./progression/tuning"
import type { Command, SessionTuning, Survivor, SurvivorSlot } from "./sim-types"
import { DEFAULT_STAMINA_TUNING } from "./stamina"
import type { Notice } from "./types"
import type { OutbreakVehicle, OutbreakVehicleSubsystem } from "./vehicles"
import type { StreamingWorld, WorldMode } from "./world"

export { resolveSessionTuning } from "./session-tuning"
export type {
  Command,
  LegacyFlatSessionTuning,
  NamespacedSessionTuning,
  ResolvedSessionTuning,
  SessionTuning,
  Survivor,
} from "./sim-types"

export type SessionView = {
  town: Town
  player: Survivor
  /** The local survivor's id in the progression ledger. */
  actorId: string
  inventory: InventoryState
  progression: OutbreakProgression
  /** Feedback for the local survivor since the presentation last drained it. */
  notices: Notice[]
  zombies: AIAgent[]
  vehicles: OutbreakVehicle[]
  noises: NoiseEvent[]
  shots: CombatShotEvent[]
  meleeSwings: CombatMeleeEvent[]
  containers: LootSite[]
  hour: number
  time: number
  revision: number
  prompt: InteractTarget | undefined
  peek: PeekInfo | null
  pendingItems?: ReadonlySet<string>
}

/** Transport boundary: M4 can implement the same update/view contract with snapshots. */
export interface Session {
  readonly view: SessionView
  update(dt: number, command: Command, timeScale: number, tuning?: SessionTuning): void
  close(): void
}

/** A session's view backed by a `CoopSim` slot: assignments to hour/time/revision write through to the sim. */
export function slotView(sim: CoopSim, slot: () => SurvivorSlot): SessionView {
  return {
    town: sim.town,
    get player() {
      return slot().survivor
    },
    get actorId() {
      return slot().id
    },
    get inventory() {
      const s = slot()
      return inventoryView(sim.progression, s.id, s.survivor)
    },
    progression: sim.progression,
    get notices() {
      return slot().notices
    },
    get zombies() {
      return sim.ai.agents
    },
    get vehicles() {
      return sim.vehicles.list
    },
    get noises() {
      return sim.ai.noiseBus.events
    },
    shots: sim.combat.shots,
    meleeSwings: sim.combat.meleeSwings,
    containers: sim.progression.containers,
    get hour() {
      return sim.hour
    },
    set hour(v) {
      sim.hour = v
    },
    get time() {
      return sim.time
    },
    set time(v) {
      sim.time = v
    },
    get revision() {
      return sim.revision
    },
    set revision(v) {
      sim.revision = v
    },
    get prompt() {
      return slot().prompt
    },
    get peek() {
      return slot().peek
    },
  }
}

/** Offline single-player: a `CoopSim` with one survivor, stepped with the same command contract as co-op. */
export class LocalSession implements Session {
  readonly sim: CoopSim
  readonly slot: SurvivorSlot
  readonly view: SessionView
  constructor(
    seed: number,
    houseSeed = seed,
    terrain = 0.22,
    aiConfig?: Partial<AIConfig>,
    progressionTuningOrWorldMode?: Partial<ProgressionTuning> | WorldMode,
    worldMode: WorldMode = "streaming",
  ) {
    this.sim = new CoopSim(seed, houseSeed, terrain, aiConfig, progressionTuningOrWorldMode, worldMode)
    const slot = this.sim.addSurvivor("player", 0)
    this.slot = slot
    this.view = slotView(this.sim, () => slot)
  }

  get world(): StreamingWorld {
    return this.sim.worldStream
  }

  get ai(): OutbreakAISubsystem {
    return this.sim.ai
  }

  get combat(): OutbreakCombatSubsystem {
    return this.sim.combat
  }

  get vehicles(): OutbreakVehicleSubsystem {
    return this.sim.vehicles
  }

  get registry(): InteractionRegistry {
    return this.sim.registry
  }

  update(dt: number, command: Command, timeScale: number, tuning: SessionTuning = DEFAULT_STAMINA_TUNING): void {
    dt = Math.max(0, Math.min(0.1, dt))
    this.sim.stepSurvivor(this.slot, command, dt, tuning)
    this.sim.stepWorld(dt, timeScale, tuning)
  }

  close(): void {}

  rebuildCollision(): void {
    this.sim.rebuildCollision()
  }
}
