import { pushOut, type Rect } from "@arcade/kit/sim/geom"
import { createAIAgent, OutbreakAISubsystem, type AIConfig } from "./ai"
import { createSurvivorCombatState, OutbreakCombatSubsystem } from "./combat"
import { advanceHour } from "./day-cycle"
import { createFlashlightState, DEFAULT_FLASHLIGHT_TUNING, stepFlashlight, toggleFlashlight } from "./flashlight"
import {
  createInteractActorState,
  doorInteractionHandler,
  executeInteraction,
  fenceInteractionHandler,
  InteractionRegistry,
  peekInfoFor,
  selectInteractTarget,
  stepHoldInteraction,
  stepInteractionState,
  windowInteractionHandler,
  type InteractTarget,
  type PeekInfo,
} from "./interact"
import {
  createInventoryState,
  cycleHotbarSlot,
  selectHotbarSlot,
  syncCombatInventory,
  syncFlashlightItem,
  type InventoryState,
} from "./inventory"
import { makeTown, sightRects, SIZE, solidRects, type Town } from "./map"
import { createStaminaState, DEFAULT_STAMINA_TUNING, stepStamina } from "./stamina"
import type { Command, SessionTuning, Survivor } from "./session"
import { StreamingWorld, type WorldMode } from "./world"

/** Where survivors start: the single-player spot first, then beside it. */
export const SPAWN_POINTS: readonly (readonly [number, number])[] = [
  [27.7, 41],
  [29.3, 41.2],
  [26.1, 41.2],
  [27.7, 42.6],
]

export const MAX_SURVIVORS = SPAWN_POINTS.length

export type SurvivorSlot = {
  /** Public id: "player" offline, the seat id in co-op. Also the AI target and noise source id. */
  readonly id: string
  readonly index: number
  survivor: Survivor
  inventory: InventoryState
  prompt: InteractTarget | undefined
  peek: PeekInfo | null
  /** Set by an action this tick; makes the next inventory sync add combat slots. */
  ensureCombatSlots: boolean
}

export function createSurvivor(x: number, y: number): Survivor {
  return {
    x,
    y,
    vx: 0,
    vy: 0,
    aim: -Math.PI / 2,
    health: 100,
    maxHealth: 100,
    ...createStaminaState(),
    ...createFlashlightState(true),
    ...createInteractActorState(),
    ...createSurvivorCombatState(),
  }
}

/**
 * The authoritative Outbreak world for any number of survivors. `LocalSession` runs it with one survivor; the co-op
 * room runs it with up to four. Each tick: `stepSurvivor` for every survivor's command(s), then `stepWorld` once.
 * Doors, windows, barricades, loot containers, zombies, shots and the clock are shared; inventory, ammo, planks,
 * stamina, battery and channels belong to each survivor.
 */
export class CoopSim {
  readonly town: Town
  readonly world: StreamingWorld
  readonly ai: OutbreakAISubsystem
  readonly combat: OutbreakCombatSubsystem
  readonly registry: InteractionRegistry
  readonly slots: SurvivorSlot[] = []
  hour = 18
  time = 0
  revision = 0
  private solids: Rect[]
  /** The survivor whose command is being applied (container searches channel on it). */
  private actor: Survivor | null = null

  constructor(
    seed: number,
    houseSeed = seed,
    terrain = 0.22,
    aiConfig?: Partial<AIConfig>,
    worldMode: WorldMode = "streaming",
  ) {
    this.town = makeTown(seed, houseSeed, terrain)
    this.world = new StreamingWorld(seed, houseSeed, terrain, worldMode)
    const [sx, sy] = SPAWN_POINTS[0]!
    this.combat = new OutbreakCombatSubsystem(this.town)
    this.ai = new OutbreakAISubsystem(this.town, sx, sy, aiConfig)
    if (worldMode === "procedural") {
      this.world.syncTownFromActiveChunks(this.town, this.combat.containers, this.ai.portalStates)
      this.ai.rebuildTopology(this.town, this.world.navTiles)
    }
    this.registry = new InteractionRegistry([
      doorInteractionHandler,
      windowInteractionHandler,
      fenceInteractionHandler,
      this.combat.createContainerHandler(() => this.actor ?? this.slots[0]!.survivor, this.ai, () => this.time),
    ])
    this.solids = solidRects(this.town)
  }

  slot(id: string): SurvivorSlot | undefined {
    return this.slots.find((s) => s.id === id)
  }

  addSurvivor(id: string, index = this.slots.length): SurvivorSlot {
    const [x, y] = SPAWN_POINTS[index % SPAWN_POINTS.length]!
    const survivor = createSurvivor(x, y)
    if (index > 0) pushOut(survivor, 0.3, this.solids)
    const slot: SurvivorSlot = {
      id,
      index,
      survivor,
      inventory: createInventoryState(survivor.flashlightOn),
      prompt: undefined,
      peek: null,
      ensureCombatSlots: false,
    }
    slot.prompt = selectInteractTarget(this.town, survivor, this.registry)
    this.slots.push(slot)
    this.slots.sort((a, b) => a.index - b.index)
    return slot
  }

  removeSurvivor(id: string): void {
    const i = this.slots.findIndex((s) => s.id === id)
    if (i >= 0) this.slots.splice(i, 1)
  }

  /**
   * Applies one fixed-tick command to one survivor: movement, interactions and combat actions.
   * With `predict`, only what a client may predict for its own survivor runs (aim, flashlight toggle, stamina,
   * movement, vault/peek state, climbing); nothing shared changes and no noise is emitted.
   */
  stepSurvivor(slot: SurvivorSlot, command: Command, dt: number, tuning: SessionTuning = DEFAULT_STAMINA_TUNING, predict = false): void {
    const p = slot.survivor
    const town = this.town
    this.actor = p
    if (!p.vault) p.aim = command.aim

    if (!predict && command.hotbarSlot !== undefined) {
      const selected = selectHotbarSlot(slot.inventory, command.hotbarSlot)
      if (selected?.kind === "pistol") p.equippedItem = "pistol"
    }
    if (!predict && command.hotbarDelta) {
      const selected = cycleHotbarSlot(slot.inventory, command.hotbarDelta)
      if (selected?.kind === "pistol") p.equippedItem = "pistol"
    }
    if (command.flashlight) toggleFlashlight(p)

    const clampClassic = this.world.mode === "classic"
    const x = p.x
    const y = p.y
    if (stepInteractionState(town, p, dt)) {
      stepStamina(p, false, false, dt, tuning)
      if (!p.vault) {
        pushOut(p, 0.3, this.solids)
        if (clampClassic) {
          p.x = Math.max(0.4, Math.min(SIZE - 0.4, p.x))
          p.y = Math.max(0.4, Math.min(SIZE - 0.4, p.y))
        }
      }
    } else {
      const rawLen = Math.hypot(command.mx, command.my)
      const moving = rawLen > 1e-4
      const length = Math.max(1, rawLen)
      const speed = stepStamina(p, moving, Boolean(command.sprint), dt, tuning)
      const steps = Math.max(1, Math.ceil(dt * 60))
      for (let i = 0; i < steps; i++) {
        p.x += ((command.mx / length) * speed * dt) / steps
        p.y += ((command.my / length) * speed * dt) / steps
        pushOut(p, 0.3, this.solids)
        if (clampClassic) {
          p.x = Math.max(0.4, Math.min(SIZE - 0.4, p.x))
          p.y = Math.max(0.4, Math.min(SIZE - 0.4, p.y))
        }
      }
      stepInteractionState(town, p, 0)
    }
    if (predict && !clampClassic) {
      this.syncWorldChunks()
    }

    if (command.jump) {
      const outcome = executeInteraction(town, p, "climb", this.registry)
      if (!predict && outcome.handled && outcome.noise) {
        this.ai.emitNoise(p.x, p.y, outcome.noise, "vault", this.time, slot.id)
      }
      if (!predict && outcome.topologyChanged) this.topologyChanged()
    }

    if (!predict) this.applyActions(slot, command, dt, tuning)

    p.vx = dt > 0 ? (p.x - x) / dt : 0
    p.vy = dt > 0 ? (p.y - y) / dt : 0
  }

  private applyActions(slot: SurvivorSlot, command: Command, dt: number, tuning: SessionTuning): void {
    const p = slot.survivor
    const town = this.town
    if (command.barricade || command.interactAction === "barricade") {
      this.combat.startBarricade(town, p, this.ai, this.time)
      slot.ensureCombatSlots = true
    } else if (command.interact) {
      const currentTarget = selectInteractTarget(town, p, this.registry)
      const isBarricadedPortal =
        currentTarget &&
        (currentTarget.kind === "door" || currentTarget.kind === "window") &&
        this.ai.getBarricadePlanks(currentTarget.id) > 0 &&
        (command.interactAction ?? currentTarget.primary.id) !== "peek"
      if (isBarricadedPortal) {
        p.lootMessage = `Blocked by barricade (${this.ai.getBarricadePlanks(currentTarget.id)}/3 planks)`
        p.lootMessageUntil = this.time + 2.0
      } else {
        const outcome = executeInteraction(town, p, command.interactAction ?? "primary", this.registry, Boolean(command.interactHeld))
        if (outcome.handled && outcome.noise && outcome.kind !== "container") {
          const noiseKind = outcome.action === "climb" ? "vault" : outcome.kind === "window" ? "window" : "door"
          this.ai.emitNoise(p.x, p.y, outcome.noise, noiseKind, this.time, slot.id)
        }
        if (outcome.kind === "container") slot.ensureCombatSlots = true
        if (outcome.topologyChanged) this.topologyChanged()
      }
    }

    const holdOutcome = stepHoldInteraction(town, p, Boolean(command.interactHeld), dt, this.registry)
    if (holdOutcome.handled && holdOutcome.noise) {
      const noiseKind = holdOutcome.action === "climb" ? "vault" : holdOutcome.kind === "window" ? "window" : "door"
      this.ai.emitNoise(p.x, p.y, holdOutcome.noise, noiseKind, this.time, slot.id)
    }
    if (holdOutcome.topologyChanged) this.topologyChanged()

    if (command.reload) {
      this.combat.startReload(p, this.ai, this.time)
      slot.ensureCombatSlots = true
    }
    if (command.melee) this.combat.meleeShove(p, this.ai, sightRects(town), this.time)
    if (command.fire) {
      if (p.equippedItem === "hands") {
        this.combat.meleeShove(p, this.ai, sightRects(town), this.time)
      } else {
        if (tuning.infiniteAmmo) p.magAmmo = p.magCapacity
        this.combat.firePistol(p, this.ai, sightRects(town), this.time)
        slot.ensureCombatSlots = true
      }
    }
  }

  /** Streams active chunks around all connected survivors and updates collision/navigation when windows shift. */
  syncWorldChunks(): boolean {
    const survivors = this.slots.map((s) => ({ id: s.id, x: s.survivor.x, y: s.survivor.y }))
    const res = this.world.updateActiveWindows(
      survivors,
      this.town,
      this.combat.containers,
      this.ai.portalStates,
      this.ai.agents,
      (id, seed, x, y, aim) => createAIAgent(id, seed, x, y, aim),
    )
    if (res.changed) {
      this.revision++
      this.solids = solidRects(this.town)
      this.ai.rebuildTopology(this.town, this.world.navTiles)
    }
    return res.changed
  }

  /** Advances everything shared once per tick: clock, channels, flashlights, the crowd and its attacks, prompts. */
  stepWorld(dt: number, timeScale: number, tuning: SessionTuning = DEFAULT_STAMINA_TUNING): void {
    this.time += dt
    this.hour = advanceHour(this.hour, dt, timeScale)
    this.syncWorldChunks()
    const flashlightTuning = { ...DEFAULT_FLASHLIGHT_TUNING, ...tuning }

    for (const slot of this.slots) {
      const p = slot.survivor
      const wasChannelling = Boolean(p.channel)
      const combatStep = this.combat.step(this.town, p, this.ai, dt, this.time)
      if (wasChannelling && !p.channel) slot.ensureCombatSlots = true
      if (combatStep.topologyChanged) {
        this.topologyChanged()
      }
      stepFlashlight(p, dt, this.time, flashlightTuning)
      syncFlashlightItem(slot.inventory, p.battery, p.flashlightOn)
      syncCombatInventory(slot.inventory, p, slot.ensureCombatSlots)
      slot.ensureCombatSlots = false
    }

    const config = this.ai.config
    if (tuning.sightRange !== undefined) config.sightRange = tuning.sightRange
    if (tuning.sightCone !== undefined) config.sightCone = tuning.sightCone
    if (tuning.hearingScale !== undefined) config.hearingScale = tuning.hearingScale
    if (tuning.aiWalkSpeed !== undefined) config.walkSpeed = tuning.aiWalkSpeed
    else if (tuning.walkSpeed !== undefined && tuning.walkSpeed < 2.3) config.walkSpeed = tuning.walkSpeed
    if (tuning.chaseSpeed !== undefined) config.chaseSpeed = tuning.chaseSpeed
    if (tuning.aggression !== undefined) config.aggression = tuning.aggression
    if (tuning.nightMultiplier !== undefined) config.nightMultiplier = tuning.nightMultiplier
    if (tuning.directorPacing !== undefined) config.directorPacing = tuning.directorPacing
    if (tuning.aiDebugOverlay !== undefined) config.aiDebugOverlay = tuning.aiDebugOverlay

    const survivors = this.slots.map((s) => ({ ...s.survivor, id: s.id }))
    const aiStep = this.ai.stepSurvivors(this.town, survivors, this.hour, this.time, dt, flashlightTuning)
    if (aiStep.topologyChanged) {
      this.topologyChanged()
    }
    this.slots.forEach((slot, i) => {
      const damage = aiStep.damage[i]!
      if (damage > 0) slot.survivor.health = Math.max(0, slot.survivor.health - damage)
    })
    for (const slot of this.slots) this.refreshPrompt(slot)
  }

  refreshPrompt(slot: SurvivorSlot): void {
    slot.peek = peekInfoFor(this.town, slot.survivor)
    slot.prompt = selectInteractTarget(this.town, slot.survivor, this.registry)
  }

  /** Re-derives survivor collision after doors or barricades changed (clients call this after a snapshot). */
  rebuildSolids(): void {
    this.syncWorldChunks()
    this.solids = solidRects(this.town)
    for (const slot of this.slots) this.refreshPrompt(slot)
  }

  /** Collision, crowd navigation and prompts after an external edit (Lab, harness pose). */
  rebuildCollision(): void {
    this.syncWorldChunks()
    this.solids = solidRects(this.town)
    this.world.rebuildActiveNavTiles(this.town, this.ai.portalStates)
    this.ai.rebuildTopology(this.town, this.world.navTiles)
    for (const slot of this.slots) this.refreshPrompt(slot)
  }

  private topologyChanged(): void {
    this.revision++
    for (const chunk of this.world.activeChunks.values()) {
      this.world.captureChunkDelta(chunk, this.town, this.combat.containers, this.ai.portalStates, this.ai.agents)
    }
    this.world.rebuildActiveNavTiles(this.town, this.ai.portalStates)
    this.solids = solidRects(this.town)
    this.ai.rebuildTopology(this.town, this.world.navTiles)
  }
}
