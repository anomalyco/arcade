import { RewindHistory } from "@arcade/kit/net/rewind"
import { pushOut, type Rect } from "@arcade/kit/sim/geom"
import { canSpawnZombieAt, createAIAgent, DEFAULT_PACING_TUNING, OutbreakAISubsystem, type AIConfig } from "./ai"
import { createSurvivorCombatState, OutbreakCombatSubsystem } from "./combat"
import { advanceHour } from "./day-cycle"
import { createFlashlightState, DEFAULT_FLASHLIGHT_TUNING, stepFlashlight, toggleFlashlight } from "./flashlight"
import {
  createDoorHandler,
  createInteractActorState,
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
import { makeTown, sightRects, SIZE, solidRects, type Town } from "./map"
import { OutbreakProgression, type Notice, type ProgressionCommand, type ProgressionTuning, type WorldContext } from "./progression"
import { createStaminaState, DEFAULT_STAMINA_TUNING, stepStamina } from "./stamina"
import { resolveSessionTuning, type Command, type SessionTuning, type Survivor } from "./session"
import { boxOf, OutbreakVehicleSubsystem, pushOutBox, vehicleSolidRects } from "./vehicles"
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
  prompt: InteractTarget | undefined
  peek: PeekInfo | null
  /** Feedback for this survivor (search results, recipes learned, "Inventory full"), drained by its presentation. */
  notices: Notice[]
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
    vehicleId: null,
    seatIndex: 0,
    ...createStaminaState(),
    ...createFlashlightState(true),
    ...createInteractActorState(),
    ...createSurvivorCombatState(),
  }
}

/**
 * The authoritative Outbreak world for any number of survivors. `LocalSession` runs it with one survivor; the co-op
 * room runs it with up to four. Each tick: `stepSurvivor` for every survivor's command(s), then `stepWorld` once.
 * Doors, windows, barricades, loot containers, ground drops, workbenches, zombies, shots and the clock are shared;
 * hotbar, belt, pack, stamina, battery and channels belong to each survivor. Items live in `progression.ledger`.
 */
export class CoopSim {
  readonly town: Town
  readonly worldStream: StreamingWorld
  readonly ai: OutbreakAISubsystem
  readonly combat: OutbreakCombatSubsystem
  readonly vehicles: OutbreakVehicleSubsystem
  readonly registry: InteractionRegistry
  readonly progression: OutbreakProgression
  readonly rewind = new RewindHistory<number>(24, 0.25)
  readonly slots: SurvivorSlot[] = []
  hour = DEFAULT_PACING_TUNING.startHour
  time = 0
  revision = 0
  private solids: Rect[]
  private sights: Rect[]
  private vehicleSolids: Rect[]
  private readonly chunkRefs: {
    id: string
    x: number
    y: number
    aim: number
    flashlightOn: boolean
    flashlightOutput: number
  }[] = []

  constructor(
    seed: number,
    houseSeed = seed,
    terrain = 0.22,
    aiConfig?: Partial<AIConfig>,
    progressionTuningOrWorldMode?: Partial<ProgressionTuning> | WorldMode,
    worldMode: WorldMode = "streaming",
  ) {
    const progTuning =
      typeof progressionTuningOrWorldMode === "object" && progressionTuningOrWorldMode !== null
        ? progressionTuningOrWorldMode
        : undefined
    const effWorldMode: WorldMode =
      typeof progressionTuningOrWorldMode === "string" ? progressionTuningOrWorldMode : worldMode
    this.town = makeTown(seed, houseSeed, terrain)
    this.worldStream = new StreamingWorld(seed, houseSeed, terrain, effWorldMode)
    const [sx, sy] = SPAWN_POINTS[0]!
    this.ai = new OutbreakAISubsystem(this.town, sx, sy, aiConfig)
    this.hour = this.ai.config.startHour
    this.combat = new OutbreakCombatSubsystem()
    this.progression = new OutbreakProgression(this.town, progTuning)
    this.progression.bindSquad(() => this.slots)
    const progression = this.progression
    if (effWorldMode === "procedural") {
      this.worldStream.syncTownFromActiveChunks(this.town, this.progression.containers, this.ai.portalStates)
      this.progression.ensureContainerStores()
      this.ai.rebuildTopology(this.town, this.worldStream.navTiles)
    }
    this.vehicles = new OutbreakVehicleSubsystem(this.worldStream, this.town)
    this.registry = new InteractionRegistry([
      createDoorHandler({ access: (actor) => progression.doorAccess(actor), open: (actor, door, how) => progression.openKeyed(actor, door, how) }),
      windowInteractionHandler,
      fenceInteractionHandler,
      this.vehicles.handler(progression, this.ai, () => this.time),
      ...progression.handlers(),
    ])
    this.solids = solidRects(this.town)
    this.sights = sightRects(this.town)
    this.vehicleSolids = vehicleSolidRects(this.town)
  }

  /** What progression needs to know about the world this tick. */
  world(): WorldContext {
    return { town: this.town, ai: this.ai, time: this.time, hour: this.hour, slots: this.slots }
  }

  slot(id: string): SurvivorSlot | undefined {
    return this.slots.find((s) => s.id === id)
  }

  addSurvivor(id: string, index = this.slots.length): SurvivorSlot {
    const [x, y] = SPAWN_POINTS[index % SPAWN_POINTS.length]!
    const survivor = createSurvivor(x, y)
    if (index > 0) pushOut(survivor, 0.3, this.solids)
    const slot: SurvivorSlot = { id, index, survivor, prompt: undefined, peek: null, notices: [] }
    this.progression.addActor(slot)
    this.vehicles.bindActor(slot)
    slot.prompt = selectInteractTarget(this.town, survivor, this.registry)
    this.slots.push(slot)
    this.slots.sort((a, b) => a.index - b.index)
    return slot
  }

  /** With `dropItems` (the room, when a seat expires) what they carried stays on the floor for the squad. */
  removeSurvivor(id: string, dropItems = false): void {
    const i = this.slots.findIndex((s) => s.id === id)
    if (i < 0) return
    const p = this.slots[i]!.survivor
    this.vehicles.leaveSeat(id, p)
    this.slots.splice(i, 1)
    this.progression.removeActor(id, dropItems ? { x: p.x, y: p.y } : undefined)
  }

  /**
   * Applies one fixed-tick command to one survivor: movement, interactions and combat actions.
   * With `predict`, only what a client may predict for its own survivor runs (aim, flashlight toggle, stamina,
   * movement, vault/peek state, climbing); nothing shared changes and no noise is emitted.
   */
  stepSurvivor(
    slot: SurvivorSlot,
    command: Command,
    dt: number,
    tuning: SessionTuning = DEFAULT_STAMINA_TUNING,
    predict = false,
    viewTime?: number,
  ): void {
    const resolved = resolveSessionTuning(tuning)
    Object.assign(this.vehicles.tuning, resolved.vehicle)
    const p = slot.survivor
    const town = this.town
    if (!p.vault) p.aim = command.aim

    const clampClassic = this.worldStream.mode === "classic"
    if (p.vehicleId) {
      const wasPassenger = (p.seatIndex ?? 0) > 0
      const handled = this.vehicles.stepSeatedSurvivor(
        slot,
        command,
        dt,
        this.vehicleSolids,
        this.progression,
        this.ai,
        this.time,
        predict,
      )
      if (handled) {
        stepStamina(p, false, false, dt, resolved.stamina)
        if (p.vehicleId && wasPassenger && (p.seatIndex ?? 0) > 0) {
          if (!predict && command.hotbarSlot !== undefined) {
            this.progression.select(slot, command.hotbarSlot)
            this.progression.project(slot)
          }
          if (!predict && command.hotbarDelta) {
            this.progression.select(slot, undefined, command.hotbarDelta)
            this.progression.project(slot)
          }
          if (command.flashlight) toggleFlashlight(p)
          if (!predict) {
            const ammo = this.progression.pistol(slot.id)
            const use = this.progression.heldUse(slot.id)
            const blockers = sightRects(town)
            if (command.reload) this.combat.startReload(p, this.ai, this.time, ammo)
            if (command.fire && use === "fire") {
              if (resolved.infiniteAmmo) ammo.fill()
              if (viewTime !== undefined && viewTime < this.time) {
                this.rewind.withRewoundPositions(this.ai.agents, viewTime, () =>
                  this.combat.firePistol(p, this.ai, blockers, this.time, ammo),
                )
              } else {
                this.combat.firePistol(p, this.ai, blockers, this.time, ammo)
              }
            }
          }
        }
        if (predict && !clampClassic) {
          this.syncWorldChunks()
        }
        return
      }
    }

    if (!predict && command.hotbarSlot !== undefined) {
      this.progression.select(slot, command.hotbarSlot)
      this.progression.project(slot)
    }
    if (!predict && command.hotbarDelta) {
      this.progression.select(slot, undefined, command.hotbarDelta)
      this.progression.project(slot)
    }
    if (command.flashlight) toggleFlashlight(p)

    const x = p.x
    const y = p.y
    if (stepInteractionState(town, p, dt)) {
      stepStamina(p, false, false, dt, resolved.stamina)
      if (!p.vault) {
        pushOut(p, 0.3, this.solids)
        for (const v of this.vehicles.list) pushOutBox(p, 0.3, boxOf(v, v.spec))
        if (clampClassic) {
          p.x = Math.max(0.4, Math.min(SIZE - 0.4, p.x))
          p.y = Math.max(0.4, Math.min(SIZE - 0.4, p.y))
        }
      }
    } else {
      const rawLen = Math.hypot(command.mx, command.my)
      const moving = rawLen > 1e-4
      const length = Math.max(1, rawLen)
      const speed = stepStamina(p, moving, Boolean(command.sprint), dt, resolved.stamina)
      const steps = Math.max(1, Math.ceil(dt * 60))
      for (let i = 0; i < steps; i++) {
        p.x += ((command.mx / length) * speed * dt) / steps
        p.y += ((command.my / length) * speed * dt) / steps
        pushOut(p, 0.3, this.solids)
        for (const v of this.vehicles.list) pushOutBox(p, 0.3, boxOf(v, v.spec))
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

    if (!predict) this.applyActions(slot, command, dt, resolved, viewTime)

    p.vx = dt > 0 ? (p.x - x) / dt : 0
    p.vy = dt > 0 ? (p.y - y) / dt : 0
  }

  private applyActions(
    slot: SurvivorSlot,
    command: Command,
    dt: number,
    resolved: ReturnType<typeof resolveSessionTuning>,
    viewTime?: number,
  ): void {
    const infiniteAmmo = resolved.infiniteAmmo
    const p = slot.survivor
    const town = this.town
    const progression = this.progression
    const world = this.world()
    const target = selectInteractTarget(town, p, this.registry)
    const verbs: ProgressionCommand = {
      barricade: command.barricade || command.interactAction === "barricade",
      drop: command.drop,
      bundle: command.bundle,
      ping: command.ping,
      pick: command.pick,
    }
    if (!verbs.barricade && command.interact) {
      const isBarricadedPortal =
        target &&
        (target.kind === "door" || target.kind === "window") &&
        this.ai.getBarricadePlanks(target.id) > 0 &&
        (command.interactAction ?? target.primary.id) !== "peek"
      if (isBarricadedPortal) {
        p.lootMessage = `Blocked by barricade (${this.ai.getBarricadePlanks(target.id)}/3 planks)`
        p.lootMessageUntil = this.time + 2.0
      } else {
        // Shift+E takes a target's alternative (smash a container open instead of searching it).
        const action = command.interactAction ?? (command.sprint && target?.alt ? target.alt.id : "primary")
        const outcome = executeInteraction(town, p, action, this.registry, Boolean(command.interactHeld))
        if (outcome.handled && outcome.noise) {
          const noiseKind = outcome.noiseKind ?? (outcome.action === "climb" ? "vault" : outcome.kind === "window" ? "window" : "door")
          this.ai.emitNoise(p.x, p.y, outcome.noise, noiseKind, this.time, slot.id)
        }
        if (outcome.action === "locked") progression.notify(slot, "Locked. A key or a crowbar opens it", "warning", "portal")
        if (outcome.topologyChanged) this.topologyChanged()
      }
    }

    const holdOutcome = stepHoldInteraction(town, p, Boolean(command.interactHeld), dt, this.registry)
    if (holdOutcome.handled && holdOutcome.noise) {
      const noiseKind = holdOutcome.noiseKind ?? (holdOutcome.action === "climb" ? "vault" : holdOutcome.kind === "window" ? "window" : "door")
      this.ai.emitNoise(p.x, p.y, holdOutcome.noise, noiseKind, this.time, slot.id)
    }
    if (holdOutcome.topologyChanged) this.topologyChanged()

    const ammo = progression.pistol(slot.id)
    const use = progression.heldUse(slot.id)
    const held = progression.selected(slot.id)?.item
    const blockers = this.sights
    if (command.reload) {
      // R swaps a spare battery into the flashlight when it is in hand and low; otherwise it reloads the pistol.
      const battery = held === "flashlight" && (p.battery < 0.95 || p.batteryDepleted) && progression.ledger.count(slot.id, "battery") > 0
      if (battery) verbs.reload = true
      else if (this.combat.startReload(p, this.ai, this.time, ammo, slot.id)) progression.ledger.cancel(slot.id)
    }
    const shove = () => {
      const ready = p.shoveCooldown <= 0
      this.combat.meleeShove(p, this.ai, blockers, this.time, progression.shoveMods(slot.id), slot.id)
      if (ready) progression.ledger.cancel(slot.id)
    }
    if (command.melee) shove()
    if (command.fire) {
      if (use === "fire") {
        if (infiniteAmmo) ammo.fill()
        const fired =
          viewTime !== undefined && viewTime < this.time
            ? this.rewind.withRewoundPositions(this.ai.agents, viewTime, () =>
                this.combat.firePistol(p, this.ai, blockers, this.time, ammo, slot.id),
              )
            : this.combat.firePistol(p, this.ai, blockers, this.time, ammo, slot.id)
        if (fired) progression.ledger.cancel(slot.id)
      } else if (use === "melee") {
        const wpn = progression.heldMeleeWeapon(slot.id)
        if (wpn && this.combat.startMeleeSwing(p, wpn, this.time, resolved.melee)) {
          progression.ledger.cancel(slot.id)
        }
      } else if (use === "shove") shove()
      else verbs.fire = true
    }
    if (p.meleePhase !== "idle" || p.meleeWeapon) {
      const runSwing = () =>
        this.combat.stepMelee(
          p,
          dt,
          this.time,
          Boolean(command.fireHeld),
          this.ai,
          blockers,
          progression.melee(slot.id),
          resolved.melee,
          slot.id,
          slot.index,
          town,
          (text, kind, key) => progression.notify(slot, text, kind, key),
        )
      const meleeRes =
        viewTime !== undefined && viewTime < this.time && p.meleePhase !== "idle"
          ? this.rewind.withRewoundPositions(this.ai.agents, viewTime, runSwing)
          : runSwing()
      if (meleeRes.topologyChanged) this.topologyChanged()
    }
    const made = progression.act(slot, verbs, world, target)
    if (made.noise > 0) {
      p.noise = Math.max(p.noise, made.noise)
      this.ai.emitNoise(p.x, p.y, made.noise, made.noiseKind, this.time, slot.id)
    }
  }

  /** Streams active chunks around all connected survivors and updates collision/navigation when windows shift. */
  syncWorldChunks(): boolean {
    const survivors = this.chunkRefs
    survivors.length = this.slots.length
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i]!
      const ref = survivors[i]
      if (ref) {
        ref.id = s.id
        ref.x = s.survivor.x
        ref.y = s.survivor.y
        ref.aim = s.survivor.aim
        ref.flashlightOn = s.survivor.flashlightOn
        ref.flashlightOutput = s.survivor.flashlightOutput
      } else {
        survivors[i] = {
          id: s.id,
          x: s.survivor.x,
          y: s.survivor.y,
          aim: s.survivor.aim,
          flashlightOn: s.survivor.flashlightOn,
          flashlightOutput: s.survivor.flashlightOutput,
        }
      }
    }
    if (!this.worldStream.wouldWindowsChange(survivors)) return false
    this.progression.ensureContainerStores()
    const blockers = this.sights
    const safeRadius = this.ai.config.directorPacing > 0 ? Math.max(12, this.ai.config.safeRadius * 0.75) : 6.0
    const res = this.worldStream.updateActiveWindows(
      survivors,
      this.town,
      this.progression.containers,
      this.ai.portalStates,
      this.ai.agents,
      (id, seed, x, y, aim) => createAIAgent(id, seed, x, y, aim),
      1,
      (x, y) =>
        canSpawnZombieAt(x, y, this.town, this.ai.nav, survivors, blockers, {
          safeRadius,
          forbidInView: this.ai.config.directorPacing > 0,
          forbidBehind: this.ai.config.directorPacing > 0,
          behindDist: 16,
        }),
    )
    if (res.changed) {
      this.progression.ensureContainerStores()
      this.vehicles.syncChunks(this.worldStream, this.town)
      this.revision++
      this.solids = solidRects(this.town)
      this.sights = sightRects(this.town)
      this.vehicleSolids = vehicleSolidRects(this.town)
      this.ai.rebuildTopology(this.town, this.worldStream.navTiles)
    }
    return res.changed
  }

  /** Advances everything shared once per tick: clock, channels, flashlights, vehicles, the crowd and its attacks, prompts. */
  stepWorld(dt: number, timeScale: number, tuning: SessionTuning = DEFAULT_STAMINA_TUNING): void {
    const resolved = resolveSessionTuning(tuning)
    Object.assign(this.vehicles.tuning, resolved.vehicle)
    this.time += dt
    this.hour = advanceHour(this.hour, dt, timeScale)
    this.syncWorldChunks()
    const flashlightTuning = resolved.flashlight

    for (const slot of this.slots) {
      this.combat.step(slot.survivor, dt, this.time, this.progression.pistol(slot.id))
      stepFlashlight(slot.survivor, dt, this.time, flashlightTuning)
    }
    if (this.progression.step(dt, this.world()).topologyChanged) {
      this.topologyChanged()
    }

    this.vehicles.stepWorld(dt, this.time, this.town, this.vehicleSolids, this.slots, this.ai, this.progression)

    if (resolved.ai) {
      const config = this.ai.config
      if (resolved.ai.sightRange !== undefined) config.sightRange = resolved.ai.sightRange
      if (resolved.ai.sightCone !== undefined) config.sightCone = resolved.ai.sightCone
      if (resolved.ai.hearingScale !== undefined) config.hearingScale = resolved.ai.hearingScale
      if (resolved.ai.walkSpeed !== undefined) config.walkSpeed = resolved.ai.walkSpeed
      if (resolved.ai.chaseSpeed !== undefined) config.chaseSpeed = resolved.ai.chaseSpeed
      if (resolved.ai.aggression !== undefined) config.aggression = resolved.ai.aggression
      if (resolved.ai.nightMultiplier !== undefined) config.nightMultiplier = resolved.ai.nightMultiplier
      if (resolved.ai.directorPacing !== undefined) config.directorPacing = resolved.ai.directorPacing
      if (resolved.ai.aiDebugOverlay !== undefined) config.aiDebugOverlay = resolved.ai.aiDebugOverlay
      if (resolved.ai.startHour !== undefined) config.startHour = resolved.ai.startHour
      if (resolved.ai.safeRadius !== undefined) config.safeRadius = resolved.ai.safeRadius
      if (resolved.ai.initialDensity !== undefined) config.initialDensity = resolved.ai.initialDensity
      if (resolved.ai.rampTime !== undefined) config.rampTime = resolved.ai.rampTime
      if (resolved.ai.noiseSensitivity !== undefined) config.noiseSensitivity = resolved.ai.noiseSensitivity
      if (resolved.ai.maxActiveNearPlayer !== undefined) config.maxActiveNearPlayer = resolved.ai.maxActiveNearPlayer
    }

    const survivors = this.slots.map((s) => {
      const p = s.survivor
      const v = this.vehicles.vehicleOf(p)
      if (v && (p.seatIndex ?? 0) === 0) {
        const hlOn = v.headlights && v.hasBattery && !v.wreck
        return {
          ...p,
          id: s.id,
          aim: hlOn ? v.h : p.aim,
          flashlightOn: hlOn || p.flashlightOn,
          flashlightOutput: hlOn ? 1 : p.flashlightOutput,
          lightSignature: hlOn ? this.vehicles.tuning.headlightRange : p.lightSignature,
          noise: v.engineOn ? Math.max(p.noise, this.vehicles.tuning.engineNoise * 0.45) : p.noise,
        }
      }
      return { ...p, id: s.id }
    })
    const aiStep = this.ai.stepSurvivors(this.town, survivors, this.hour, this.time, dt, flashlightTuning)
    if (aiStep.topologyChanged) {
      this.topologyChanged()
    }
    this.slots.forEach((slot, i) => {
      const damage = aiStep.damage[i]!
      if (damage > 0) {
        const v = this.vehicles.vehicleOf(slot.survivor)
        const armor = v ? (v.spec.seats[slot.survivor.seatIndex ?? 0]?.armor ?? 0.4) : 1
        slot.survivor.health = Math.max(0, slot.survivor.health - damage * armor)
      }
    })
    this.rewind.record(Math.round(this.time * 60), this.time, this.ai.agents, (a) => (a as { state?: string }).state !== "dead")
    for (const slot of this.slots) this.refreshPrompt(slot)
  }

  refreshPrompt(slot: SurvivorSlot): void {
    if (slot.survivor.vehicleId) {
      slot.peek = null
      slot.prompt = undefined
      return
    }
    slot.peek = peekInfoFor(this.town, slot.survivor)
    slot.prompt = selectInteractTarget(this.town, slot.survivor, this.registry)
  }

  /** Re-derives survivor collision after doors or barricades changed (clients call this after a snapshot). */
  rebuildSolids(): void {
    this.syncWorldChunks()
    this.vehicles.syncChunks(this.worldStream, this.town)
    this.solids = solidRects(this.town)
    this.sights = sightRects(this.town)
    this.vehicleSolids = vehicleSolidRects(this.town)
    for (const slot of this.slots) this.refreshPrompt(slot)
  }

  /** Collision, crowd navigation and prompts after an external edit (Lab, harness pose). */
  rebuildCollision(): void {
    this.syncWorldChunks()
    this.vehicles.syncChunks(this.worldStream, this.town)
    this.solids = solidRects(this.town)
    this.sights = sightRects(this.town)
    this.vehicleSolids = vehicleSolidRects(this.town)
    this.worldStream.rebuildActiveNavTiles(this.town, this.ai.portalStates)
    this.ai.rebuildTopology(this.town, this.worldStream.navTiles)
    for (const slot of this.slots) this.refreshPrompt(slot)
  }

  private topologyChanged(): void {
    this.revision++
    this.progression.ensureContainerStores()
    this.vehicles.syncChunks(this.worldStream, this.town)
    for (const chunk of this.worldStream.activeChunks.values()) {
      this.worldStream.captureChunkDelta(chunk, this.town, this.progression.containers, this.ai.portalStates, this.ai.agents)
    }
    this.worldStream.rebuildActiveNavTiles(this.town, this.ai.portalStates)
    this.solids = solidRects(this.town)
    this.sights = sightRects(this.town)
    this.vehicleSolids = vehicleSolidRects(this.town)
    this.ai.rebuildTopology(this.town, this.worldStream.navTiles)
  }
}
