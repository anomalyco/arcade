import { pushOut } from "@arcade/kit/sim/geom"
import { OutbreakAISubsystem, type AIAgent, type AIConfig, type NoiseEvent } from "./ai"
import {
  createSurvivorCombatState,
  OutbreakCombatSubsystem,
  type CombatShotEvent,
  type LootContainer,
  type SurvivorCombatState,
} from "./combat"
import { advanceHour } from "./day-cycle"
import {
  createFlashlightState,
  DEFAULT_FLASHLIGHT_TUNING,
  stepFlashlight,
  toggleFlashlight,
  type FlashlightState,
  type FlashlightTuning,
} from "./flashlight"
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
  type InteractActionId,
  type InteractActorState,
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
import {
  createStaminaState,
  DEFAULT_STAMINA_TUNING,
  stepStamina,
  type StaminaState,
  type StaminaTuning,
} from "./stamina"

export type SessionTuning = StaminaTuning & Partial<FlashlightTuning> & Partial<AIConfig> & {
  aiWalkSpeed?: number
  /** Dev cheat: keeps the pistol magazine full. 1 = on. */
  infiniteAmmo?: number
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
  inventory: InventoryState
  zombies: AIAgent[]
  noises: NoiseEvent[]
  shots: CombatShotEvent[]
  containers: LootContainer[]
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

export class LocalSession implements Session {
  readonly view: SessionView
  readonly ai: OutbreakAISubsystem
  readonly combat: OutbreakCombatSubsystem
  readonly registry: InteractionRegistry
  private solids
  constructor(seed: number, houseSeed = seed, terrain = 0.22, aiConfig?: Partial<AIConfig>) {
    const town = makeTown(seed, houseSeed, terrain)
    const player: Survivor = {
      x: 27.7,
      y: 41,
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
    this.ai = new OutbreakAISubsystem(town, player.x, player.y, aiConfig)
    this.combat = new OutbreakCombatSubsystem(town)
    this.registry = new InteractionRegistry([
      doorInteractionHandler,
      windowInteractionHandler,
      fenceInteractionHandler,
      this.combat.createContainerHandler(() => this.view.player, this.ai, () => this.view.time),
    ])
    this.view = {
      town,
      player,
      inventory: createInventoryState(player.flashlightOn),
      zombies: this.ai.agents,
      noises: this.ai.noiseBus.events,
      shots: this.combat.shots,
      containers: this.combat.containers,
      hour: 18,
      time: 0,
      revision: 0,
      prompt: selectInteractTarget(town, player, this.registry),
      peek: null,
    }
    this.solids = solidRects(town)
  }

  update(dt: number, command: Command, timeScale: number, tuning: SessionTuning = DEFAULT_STAMINA_TUNING): void {
    const view = this.view
    const p = view.player
    dt = Math.max(0, Math.min(0.1, dt))
    if (!p.vault) p.aim = command.aim

    if (command.hotbarSlot !== undefined) {
      const selected = selectHotbarSlot(view.inventory, command.hotbarSlot)
      if (selected?.kind === "pistol") {
        p.equippedItem = "pistol"
      }
    }
    if (command.hotbarDelta) {
      const selected = cycleHotbarSlot(view.inventory, command.hotbarDelta)
      if (selected?.kind === "pistol") {
        p.equippedItem = "pistol"
      }
    }
    if (command.flashlight) {
      toggleFlashlight(p)
    }

    const x = p.x
    const y = p.y
    if (stepInteractionState(view.town, p, dt)) {
      stepStamina(p, false, false, dt, tuning)
      if (!p.vault) {
        pushOut(p, 0.3, this.solids)
        p.x = Math.max(0.4, Math.min(SIZE - 0.4, p.x))
        p.y = Math.max(0.4, Math.min(SIZE - 0.4, p.y))
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
        p.x = Math.max(0.4, Math.min(SIZE - 0.4, p.x))
        p.y = Math.max(0.4, Math.min(SIZE - 0.4, p.y))
      }
      stepInteractionState(view.town, p, 0)
    }

    let ensureCombatSlots = false
    if (command.jump) {
      const outcome = executeInteraction(view.town, p, "climb", this.registry)
      if (outcome.handled && outcome.noise) {
        this.ai.emitNoise(p.x, p.y, outcome.noise, "vault", view.time, "player")
      }
      if (outcome.topologyChanged) {
        view.revision++
        this.solids = solidRects(view.town)
        this.ai.rebuildTopology(view.town)
      }
    }

    if (command.barricade || command.interactAction === "barricade") {
      this.combat.startBarricade(view.town, p, this.ai, view.time)
      ensureCombatSlots = true
    } else if (command.interact) {
      const currentTarget = selectInteractTarget(view.town, p, this.registry)
      const isBarricadedPortal =
        currentTarget &&
        (currentTarget.kind === "door" || currentTarget.kind === "window") &&
        this.ai.getBarricadePlanks(currentTarget.id) > 0 &&
        (command.interactAction ?? currentTarget.primary.id) !== "peek"
      if (isBarricadedPortal) {
        p.lootMessage = `Blocked by barricade (${this.ai.getBarricadePlanks(currentTarget.id)}/3 planks)`
        p.lootMessageUntil = view.time + 2.0
      } else {
        const outcome = executeInteraction(
          view.town,
          p,
          command.interactAction ?? "primary",
          this.registry,
          Boolean(command.interactHeld),
        )
        if (outcome.handled && outcome.noise && outcome.kind !== "container") {
          const noiseKind =
            outcome.action === "climb" ? "vault" : outcome.kind === "window" ? "window" : "door"
          this.ai.emitNoise(p.x, p.y, outcome.noise, noiseKind, view.time, "player")
        }
        if (outcome.kind === "container") {
          ensureCombatSlots = true
        }
        if (outcome.topologyChanged) {
          view.revision++
          this.solids = solidRects(view.town)
          this.ai.rebuildTopology(view.town)
        }
      }
    }

    const holdOutcome = stepHoldInteraction(view.town, p, Boolean(command.interactHeld), dt, this.registry)
    if (holdOutcome.handled && holdOutcome.noise) {
      const noiseKind =
        holdOutcome.action === "climb" ? "vault" : holdOutcome.kind === "window" ? "window" : "door"
      this.ai.emitNoise(p.x, p.y, holdOutcome.noise, noiseKind, view.time, "player")
    }
    if (holdOutcome.topologyChanged) {
      view.revision++
      this.solids = solidRects(view.town)
      this.ai.rebuildTopology(view.town)
    }

    if (command.reload) {
      this.combat.startReload(p, this.ai, view.time)
      ensureCombatSlots = true
    }
    if (command.melee) {
      this.combat.meleeShove(p, this.ai, sightRects(view.town), view.time)
    }
    if (command.fire) {
      if (p.equippedItem === "hands") {
        this.combat.meleeShove(p, this.ai, sightRects(view.town), view.time)
      } else {
        if (tuning.infiniteAmmo) p.magAmmo = p.magCapacity
        this.combat.firePistol(p, this.ai, sightRects(view.town), view.time)
        ensureCombatSlots = true
      }
    }

    p.vx = dt > 0 ? (p.x - x) / dt : 0
    p.vy = dt > 0 ? (p.y - y) / dt : 0
    view.time += dt
    view.hour = advanceHour(view.hour, dt, timeScale)

    const wasChannelling = Boolean(p.channel)
    const combatStep = this.combat.step(view.town, p, this.ai, dt, view.time)
    if (wasChannelling && !p.channel) {
      ensureCombatSlots = true
    }
    if (combatStep.topologyChanged) {
      view.revision++
      this.solids = solidRects(view.town)
    }

    const flashlightTuning = { ...DEFAULT_FLASHLIGHT_TUNING, ...tuning }
    stepFlashlight(p, dt, view.time, flashlightTuning)
    syncFlashlightItem(view.inventory, p.battery, p.flashlightOn)
    syncCombatInventory(view.inventory, p, ensureCombatSlots)

    // Sync AI tunables if provided
    if (tuning.sightRange !== undefined) this.ai.config.sightRange = tuning.sightRange
    if (tuning.sightCone !== undefined) this.ai.config.sightCone = tuning.sightCone
    if (tuning.hearingScale !== undefined) this.ai.config.hearingScale = tuning.hearingScale
    if (tuning.aiWalkSpeed !== undefined) this.ai.config.walkSpeed = tuning.aiWalkSpeed
    else if (tuning.walkSpeed !== undefined && tuning.walkSpeed < 2.3) this.ai.config.walkSpeed = tuning.walkSpeed
    if (tuning.chaseSpeed !== undefined) this.ai.config.chaseSpeed = tuning.chaseSpeed
    if (tuning.aggression !== undefined) this.ai.config.aggression = tuning.aggression
    if (tuning.nightMultiplier !== undefined) this.ai.config.nightMultiplier = tuning.nightMultiplier
    if (tuning.directorPacing !== undefined) this.ai.config.directorPacing = tuning.directorPacing
    if (tuning.aiDebugOverlay !== undefined) this.ai.config.aiDebugOverlay = tuning.aiDebugOverlay

    const aiStep = this.ai.step(view.town, p, view.hour, view.time, dt, flashlightTuning)
    if (aiStep.topologyChanged) {
      view.revision++
      this.solids = solidRects(view.town)
    }
    if (aiStep.playerDamage > 0) {
      p.health = Math.max(0, p.health - aiStep.playerDamage)
    }

    view.peek = peekInfoFor(view.town, p)
    view.prompt = selectInteractTarget(view.town, p, this.registry)
  }

  close(): void {}

  rebuildCollision(): void {
    this.solids = solidRects(this.view.town)
    this.ai.rebuildTopology(this.view.town)
    this.view.peek = peekInfoFor(this.view.town, this.view.player)
    this.view.prompt = selectInteractTarget(this.view.town, this.view.player, this.registry)
  }
}
