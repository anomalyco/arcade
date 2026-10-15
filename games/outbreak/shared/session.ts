import type { AIAgent, AIConfig, NoiseEvent, OutbreakAISubsystem } from "./ai"
import type { CombatShotEvent, OutbreakCombatSubsystem, SurvivorCombatState } from "./combat"
import { CoopSim, type SurvivorSlot } from "./coop-sim"
import { DEFAULT_FLASHLIGHT_TUNING, type FlashlightState, type FlashlightTuning } from "./flashlight"
import type { InteractActionId, InteractActorState, InteractionRegistry, InteractTarget, PeekInfo } from "./interact"
import { inventoryView, type InventoryState } from "./inventory"
import type { LootSite, Notice, OutbreakProgression, PickMode, ProgressionTuning } from "./progression"
import type { Town } from "./map"
import type { StaminaState, StaminaTuning } from "./stamina"
import { DEFAULT_STAMINA_TUNING } from "./stamina"
import type { StreamingWorld, WorldMode } from "./world"

export type NamespacedSessionTuning = {
  stamina?: Partial<StaminaTuning>
  flashlight?: Partial<FlashlightTuning>
  ai?: Partial<AIConfig>
  combat?: {
    /** Dev cheat: keeps the pistol magazine full. 1 = on. */
    infiniteAmmo?: number
  }
}

export type LegacyFlatSessionTuning = Partial<StaminaTuning> &
  Partial<FlashlightTuning> &
  Partial<AIConfig> & {
    /** Dev cheat: keeps the pistol magazine full. 1 = on. */
    infiniteAmmo?: number
  }

export type SessionTuning = NamespacedSessionTuning | LegacyFlatSessionTuning

export type ResolvedSessionTuning = {
  stamina: StaminaTuning
  flashlight: FlashlightTuning
  ai: Partial<AIConfig> | undefined
  infiniteAmmo: boolean
}

function isNamespacedSessionTuning(tuning: SessionTuning): tuning is NamespacedSessionTuning {
  return "stamina" in tuning || "flashlight" in tuning || "ai" in tuning || "combat" in tuning
}

export function resolveSessionTuning(tuning?: SessionTuning): ResolvedSessionTuning {
  if (!tuning) {
    return {
      stamina: DEFAULT_STAMINA_TUNING,
      flashlight: DEFAULT_FLASHLIGHT_TUNING,
      ai: undefined,
      infiniteAmmo: false,
    }
  }
  if (isNamespacedSessionTuning(tuning)) {
    return {
      stamina: tuning.stamina ? { ...DEFAULT_STAMINA_TUNING, ...tuning.stamina } : DEFAULT_STAMINA_TUNING,
      flashlight: tuning.flashlight ? { ...DEFAULT_FLASHLIGHT_TUNING, ...tuning.flashlight } : DEFAULT_FLASHLIGHT_TUNING,
      ai: tuning.ai,
      infiniteAmmo: Boolean(tuning.combat?.infiniteAmmo),
    }
  }
  const hasAiKeys =
    tuning.sightRange !== undefined ||
    tuning.sightCone !== undefined ||
    tuning.hearingScale !== undefined ||
    tuning.chaseSpeed !== undefined ||
    tuning.aggression !== undefined ||
    tuning.nightMultiplier !== undefined ||
    tuning.directorPacing !== undefined ||
    tuning.aiDebugOverlay !== undefined
  return {
    stamina: { ...DEFAULT_STAMINA_TUNING, ...tuning },
    flashlight: { ...DEFAULT_FLASHLIGHT_TUNING, ...tuning },
    ai: hasAiKeys
      ? {
          sightRange: tuning.sightRange,
          sightCone: tuning.sightCone,
          hearingScale: tuning.hearingScale,
          chaseSpeed: tuning.chaseSpeed,
          aggression: tuning.aggression,
          nightMultiplier: tuning.nightMultiplier,
          directorPacing: tuning.directorPacing,
          aiDebugOverlay: tuning.aiDebugOverlay,
        }
      : undefined,
    infiniteAmmo: Boolean(tuning.infiniteAmmo),
  }
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
  /** A digit while a strip is open (container, stash, bench, field craft or pack). */
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
} & StaminaState &
  FlashlightState &
  InteractActorState &
  SurvivorCombatState

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
  noises: NoiseEvent[]
  shots: CombatShotEvent[]
  containers: LootSite[]
  hour: number
  time: number
  revision: number
  prompt: InteractTarget | undefined
  peek: PeekInfo | null
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
    get noises() {
      return sim.ai.noiseBus.events
    },
    shots: sim.combat.shots,
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
