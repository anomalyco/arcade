import { pushOut } from "@arcade/kit/sim/geom"
import { OutbreakAISubsystem, type AIAgent, type AIConfig, type NoiseEvent } from "./ai"
import { advanceHour } from "./day-cycle"
import {
  createInteractActorState,
  cycleInteractAction,
  executeInteraction,
  peekInfoFor,
  selectInteractTarget,
  stepInteractionState,
  type InteractActionId,
  type InteractActorState,
  type InteractTarget,
  type PeekInfo,
} from "./interact"
import { makeTown, SIZE, solidRects, type Town } from "./map"
import {
  createStaminaState,
  DEFAULT_STAMINA_TUNING,
  stepStamina,
  type StaminaState,
  type StaminaTuning,
} from "./stamina"

export type Command = {
  mx: number
  my: number
  aim: number
  interact: boolean
  sprint?: boolean
  cycle?: boolean
  toggleFlashlight?: boolean
  interactAction?: InteractActionId
}

export type Survivor = {
  x: number
  y: number
  vx: number
  vy: number
  aim: number
  flashlightOn: boolean
  health: number
  maxHealth: number
} & StaminaState &
  InteractActorState

export type SessionView = {
  town: Town
  player: Survivor
  zombies: AIAgent[]
  noises: NoiseEvent[]
  hour: number
  time: number
  revision: number
  prompt: InteractTarget | undefined
  peek: PeekInfo | null
}

/** Transport boundary: M4 can implement the same update/view contract with snapshots. */
export interface Session {
  readonly view: SessionView
  update(dt: number, command: Command, timeScale: number, tuning?: StaminaTuning & Partial<AIConfig>): void
  close(): void
}

export class LocalSession implements Session {
  readonly view: SessionView
  readonly ai: OutbreakAISubsystem
  private solids
  constructor(seed: number, houseSeed = seed, terrain = 0.22, aiConfig?: Partial<AIConfig>) {
    const town = makeTown(seed, houseSeed, terrain)
    const player: Survivor = {
      x: 27.7,
      y: 41,
      vx: 0,
      vy: 0,
      aim: -Math.PI / 2,
      flashlightOn: false,
      health: 100,
      maxHealth: 100,
      ...createStaminaState(),
      ...createInteractActorState(),
    }
    this.ai = new OutbreakAISubsystem(town, player.x, player.y, aiConfig)
    this.view = {
      town,
      player,
      zombies: this.ai.agents,
      noises: this.ai.noiseBus.events,
      hour: 18,
      time: 0,
      revision: 0,
      prompt: selectInteractTarget(town, player),
      peek: null,
    }
    this.solids = solidRects(town)
  }

  update(
    dt: number,
    command: Command,
    timeScale: number,
    tuning: StaminaTuning & Partial<AIConfig> = DEFAULT_STAMINA_TUNING,
  ): void {
    const view = this.view
    const p = view.player
    dt = Math.max(0, Math.min(0.1, dt))
    if (!p.vault) p.aim = command.aim
    if (command.toggleFlashlight) {
      p.flashlightOn = !p.flashlightOn
    }
    if (command.cycle) {
      cycleInteractAction(view.town, p)
    }
    if (command.interact) {
      const outcome = executeInteraction(view.town, p, command.interactAction)
      if (outcome.handled && outcome.noise) {
        const noiseKind =
          outcome.action === "climb" ? "vault" : outcome.kind === "window" ? "window" : "door"
        this.ai.emitNoise(p.x, p.y, outcome.noise, noiseKind, view.time, "player")
      }
      if (outcome.topologyChanged) {
        view.revision++
        this.solids = solidRects(view.town)
        this.ai.rebuildTopology(view.town)
      }
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
    p.vx = dt > 0 ? (p.x - x) / dt : 0
    p.vy = dt > 0 ? (p.y - y) / dt : 0

    // Sync AI tunables if provided
    if (tuning.sightRange !== undefined) this.ai.config.sightRange = tuning.sightRange
    if (tuning.sightCone !== undefined) this.ai.config.sightCone = tuning.sightCone
    if (tuning.hearingScale !== undefined) this.ai.config.hearingScale = tuning.hearingScale
    if (tuning.walkSpeed !== undefined) this.ai.config.walkSpeed = tuning.walkSpeed
    if (tuning.chaseSpeed !== undefined) this.ai.config.chaseSpeed = tuning.chaseSpeed
    if (tuning.aggression !== undefined) this.ai.config.aggression = tuning.aggression
    if (tuning.nightMultiplier !== undefined) this.ai.config.nightMultiplier = tuning.nightMultiplier
    if (tuning.directorPacing !== undefined) this.ai.config.directorPacing = tuning.directorPacing
    if (tuning.aiDebugOverlay !== undefined) this.ai.config.aiDebugOverlay = tuning.aiDebugOverlay

    const aiStep = this.ai.step(view.town, p, view.hour, view.time, dt)
    if (aiStep.topologyChanged) {
      view.revision++
      this.solids = solidRects(view.town)
    }
    if (aiStep.playerDamage > 0) {
      p.health = Math.max(0, p.health - aiStep.playerDamage)
    }

    view.peek = peekInfoFor(view.town, p)
    view.prompt = selectInteractTarget(view.town, p)
    view.time += dt
    view.hour = advanceHour(view.hour, dt, timeScale)
  }

  close(): void {}

  rebuildCollision(): void {
    this.solids = solidRects(this.view.town)
    this.ai.rebuildTopology(this.view.town)
    this.view.peek = peekInfoFor(this.view.town, this.view.player)
    this.view.prompt = selectInteractTarget(this.view.town, this.view.player)
  }
}
