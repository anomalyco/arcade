import { RewindHistory, type RewindFrameSnapshot } from "@arcade/kit/net/rewind"
import { pushOut, type Rect } from "@arcade/kit/sim/geom"
import { Rng } from "@arcade/kit/sim/rng"
import {
  canSpawnZombieAt,
  createAIAgent,
  DEFAULT_PACING_TUNING,
  OutbreakAISubsystem,
  type AIConfig,
  type OutbreakAISnapshot,
} from "./ai"
import {
  createSurvivorCombatState,
  findFinisherTarget,
  OutbreakCombatSubsystem,
  type OutbreakCombatSnapshot,
} from "./combat"
import { advanceHour } from "./day-cycle"
import { outbreakSharedFeatures, survivorDamage } from "./feature-registry"
import "./features"
import { coopSpawnClearance, openingClockActive } from "./pacing"
import { batteryReload, createFlashlightState, DEFAULT_FLASHLIGHT_TUNING, stepFlashlight, toggleFlashlight } from "./flashlight"
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
} from "./interact"
import { makeTown, sightRects, SIZE, solidRects, type Door, type Town, type WindowOpening } from "./map"
import { OutbreakProgression } from "./progression/progression"
import type { ProgressionTuning } from "./progression/tuning"
import type { OutbreakProgressionSnapshot, ProgressionCommand, WorldContext } from "./progression/types"
import { resolveSessionTuning } from "./session-tuning"
import { SPAWN_POINTS } from "./spawn-points"
import type { Command, OutbreakSim, SessionTuning, Survivor, SurvivorSlot } from "./sim-types"
import { createStaminaState, DEFAULT_STAMINA_TUNING, stepStamina } from "./stamina"
import type { Notice } from "./types"
import { OutbreakVehicleSubsystem, vehicleSolidRects, type OutbreakVehicleSnapshot } from "./vehicles"
import { StreamingWorld, type StreamingWorldSnapshot, type WorldMode } from "./world"

export { SPAWN_POINTS }

export const MAX_SURVIVORS = SPAWN_POINTS.length

export type { SurvivorSlot } from "./sim-types"

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

export type SerializedSurvivorSlot = {
  id: string
  index: number
  survivor: Survivor
  notices: Notice[]
}

/**
 * Pure, plain JSON-serialisable snapshot of the entire authoritative `CoopSim` state.
 * Can be diffed, hashed, saved to disk/JSON, loaded, inspected, or forked into parallel rollouts.
 */
export type SimState = {
  version: 1
  seed: number
  houseSeed: number
  terrain: number
  worldMode: WorldMode
  /** Seeded PRNG state living inside the simulation state. */
  rngState: number
  /** Non-zero when forked with a rollout seed to branch stochastic world events. */
  rolloutSeedMix: number
  time: number
  hour: number
  /** Game hours the clock has advanced since the start (absent in older snapshots). */
  elapsedHours?: number
  revision: number
  town: {
    doors: Door[]
    windows: WindowOpening[]
  }
  worldStream: StreamingWorldSnapshot
  slots: SerializedSurvivorSlot[]
  ai: OutbreakAISnapshot
  combat: OutbreakCombatSnapshot
  progression: OutbreakProgressionSnapshot
  vehicles: OutbreakVehicleSnapshot
  featureStates: Record<string, unknown>
  /**
   * Lag-compensation history: recent zombie positions that shots and finishers rewind to (absent in older snapshots).
   * Excluded from `hashSimState`, which digests the world itself; `diffSimState` still compares it.
   */
  rewind?: RewindFrameSnapshot<number>[]
}

export type SimInputs = Readonly<Record<string, Command>> | readonly Command[]

export type StepSimOptions = {
  timeScale?: number
  tuning?: SessionTuning
}

export type SimStateDiffEntry = {
  path: string
  before: unknown
  after: unknown
}

function cloneSurvivorState(s: Survivor): Survivor {
  return {
    ...s,
    meleeComboUntil: s.meleeComboUntil ?? -Infinity,
    lootMessageUntil: s.lootMessageUntil ?? (s.lootMessage ? Infinity : -Infinity),
    vault: s.vault ? { ...s.vault } : null,
    channel: s.channel ? { ...s.channel } : null,
  }
}

/**
 * The authoritative Outbreak world for any number of survivors. `LocalSession` runs it with one survivor; the co-op
 * room runs it with up to six. Each tick: `stepSurvivor` for every survivor's command(s), then `stepWorld` once.
 * Doors, windows, barricades, loot containers, ground drops, workbenches, zombies, shots and the clock are shared;
 * hotbar, belt, pack, stamina, battery and channels belong to each survivor. Items live in `progression.ledger`.
 */
export class CoopSim implements OutbreakSim {
  readonly seed: number
  readonly houseSeed: number
  readonly terrain: number
  readonly rng: Rng
  rolloutSeedMix = 0
  readonly town: Town
  readonly worldStream: StreamingWorld
  readonly ai: OutbreakAISubsystem
  readonly combat: OutbreakCombatSubsystem
  readonly vehicles: OutbreakVehicleSubsystem
  readonly registry: InteractionRegistry
  readonly progression: OutbreakProgression
  readonly rewind = new RewindHistory<number>(24, 0.25)
  readonly slots: SurvivorSlot[] = []
  readonly featureStates: Map<string, unknown>
  hour = DEFAULT_PACING_TUNING.startHour
  /** Game hours the clock has advanced since the start; the opening clock and night counts read it. */
  elapsedHours = 0
  time = 0
  revision = 0
  solids: Rect[]
  private sights: Rect[]
  vehicleSolids: Rect[]
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
    this.seed = seed >>> 0
    this.houseSeed = houseSeed >>> 0
    this.terrain = terrain
    this.rng = new Rng(((this.seed ^ 0x9e3779b9) >>> 0) || 1)
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
    if (this.progression.knowledge.boardHeldOut(this.town, this.ai)) this.ai.rebuildTopology(this.town, this.worldStream.navTiles)
    this.vehicles = new OutbreakVehicleSubsystem(this.worldStream, this.town)
    this.featureStates = outbreakSharedFeatures.createSimStates(this)
    this.registry = new InteractionRegistry([
      createDoorHandler({ access: (actor) => progression.doorAccess(actor), open: (actor, door, how) => progression.openKeyed(actor, door, how) }),
      windowInteractionHandler,
      fenceInteractionHandler,
      this.vehicles.handler(progression, this.ai, () => this.time),
      ...progression.handlers(),
    ])
    for (const feature of outbreakSharedFeatures.list()) {
      feature.registerInteractions?.(this, this.registry, this.featureStates.get(feature.id))
    }
    this.solids = solidRects(this.town)
    this.sights = sightRects(this.town)
    this.vehicleSolids = vehicleSolidRects(this.town)
  }

  /** Retrieves pure per-simulation state registered by a shared feature (`id`). */
  getFeatureState<T = unknown>(id: string): T | undefined {
    return this.featureStates.get(id) as T | undefined
  }

  /** Deterministically clones all registered per-simulation feature states onto `targetSim` when forking a simulation. */
  cloneFeatureStatesTo(targetSim: CoopSim): void {
    const cloned = outbreakSharedFeatures.cloneSimStates(this.featureStates, targetSim, this)
    targetSim.featureStates.clear()
    for (const [k, v] of cloned) targetSim.featureStates.set(k, v)
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
    p.crouching = Boolean(command.crouch) && !p.vehicleId

    const clampClassic = this.worldStream.mode === "classic"
    for (const feature of outbreakSharedFeatures.list()) {
      if (
        feature.stepSurvivorMovement?.({
          sim: this,
          slot,
          command,
          dt,
          resolved,
          predict,
          clampClassic,
          viewTime,
          state: this.featureStates.get(feature.id),
        })
      ) {
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
        for (const feature of outbreakSharedFeatures.list()) {
          feature.pushOutSurvivor?.(this, p, 0.3, this.featureStates.get(feature.id))
        }
        if (clampClassic) {
          p.x = Math.max(0.4, Math.min(SIZE - 0.4, p.x))
          p.y = Math.max(0.4, Math.min(SIZE - 0.4, p.y))
        }
      }
    } else {
      const rawLen = Math.hypot(command.mx, command.my)
      const moving = rawLen > 1e-4
      const length = Math.max(1, rawLen)
      const t = this.progression.tuning
      const crouch = p.crouching ? { speed: t.crouchSpeed, noise: t.crouchNoise } : undefined
      const speed = stepStamina(p, moving, Boolean(command.sprint), dt, resolved.stamina, crouch)
      const steps = Math.max(1, Math.ceil(dt * 60))
      for (let i = 0; i < steps; i++) {
        p.x += ((command.mx / length) * speed * dt) / steps
        p.y += ((command.my / length) * speed * dt) / steps
        pushOut(p, 0.3, this.solids)
        for (const feature of outbreakSharedFeatures.list()) {
          feature.pushOutSurvivor?.(this, p, 0.3, this.featureStates.get(feature.id))
        }
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
        (command.interactAction ?? (command.sprint && target.alt ? target.alt.id : target.primary.id)) !== "peek"
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
    const blockers = this.sights
    if (command.reload) {
      // R reloads the pistol; a dead (or low, with nothing to reload) shoulder light takes a spare battery instead.
      if (batteryReload(p, progression.ledger.count(slot.id, "battery"), ammo)) verbs.reload = true
      if ((!verbs.reload || p.batteryDepleted) && this.combat.startReload(p, this.ai, this.time, ammo, slot.id)) progression.ledger.cancel(slot.id)
    }
    const tryFinisher = () => {
      const runFinisher = () => {
        const finTarget = findFinisherTarget(p, this.ai.agents, blockers)
        if (!finTarget) return null
        return this.combat.executeFinisher(
          p,
          finTarget,
          this.ai,
          progression.melee(slot.id),
          this.time,
          resolved.melee,
          slot.id,
          slot.index,
          (text, kind, key) => progression.notify(slot, text, kind, key),
        )
      }
      const ev =
        viewTime !== undefined && viewTime < this.time
          ? this.rewind.withRewoundPositions(this.ai.agents, viewTime, runFinisher)
          : runFinisher()
      if (ev) progression.ledger.cancel(slot.id)
      return Boolean(ev)
    }
    const shove = () => {
      if (tryFinisher()) return
      const ready = p.shoveCooldown <= 0
      this.combat.meleeShove(p, this.ai, blockers, this.time, progression.shoveMods(slot.id), slot.id)
      if (ready) progression.ledger.cancel(slot.id)
    }
    if (command.melee) shove()
    if (command.fire) {
      if ((use === "melee" || use === "shove" || use === "fire") && tryFinisher()) {
        // Contextual finisher on downed or crawling zombie handled
      } else if (use === "fire") {
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
    const made = progression.act(slot, verbs, world, target)
    if (made.noise > 0) {
      p.noise = Math.max(p.noise, made.noise)
      this.ai.emitNoise(p.x, p.y, made.noise, made.noiseKind, this.time, slot.id)
    }
    const clampClassic = this.worldStream.mode === "classic"
    for (const feature of outbreakSharedFeatures.list()) {
      const res = feature.stepSurvivorActions?.({
        sim: this,
        slot,
        command,
        dt,
        resolved,
        predict: false,
        clampClassic,
        viewTime,
        state: this.featureStates.get(feature.id),
      })
      if (res?.topologyChanged) this.topologyChanged()
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
    const safeRadius = this.ai.config.directorPacing > 0 ? Math.max(12, this.ai.config.safeRadius * 0.75, coopSpawnClearance(this.ai.pacing.coop)) : 6.0
    // A new chunk's dead are placed after the town takes it in: its walls hide them and its ground holds them, read
    // from the world's fresh nav tiles (the crowd's nav is rebuilt below).
    let blockers: Rect[] | null = null
    const ground = { walkable: (p: { x: number; y: number }) => this.worldStream.walkable(p.x, p.y) ?? this.ai.nav.walkable(p) }
    // ...and no more of them than the director wants alive, so the night ramp and the day's lull hold out of town too
    // (a chunk's dead left out come back when it next loads).
    const paced = this.ai.config.directorPacing > 0 && this.ai.config.zombieCount > 0
    const wanted = this.ai.pacing.telemetry.desiredPopulation
    const living = () => this.ai.agents.reduce((n, a) => (a.state !== "dead" && a.hordeId === undefined ? n + 1 : n), 0)
    const res = this.worldStream.updateActiveWindows(
      survivors,
      this.town,
      this.progression.containers,
      this.ai.portalStates,
      this.ai.agents,
      (id, seed, x, y, aim) => createAIAgent(id, seed, x, y, aim),
      1,
      (x, y) =>
        (!paced || living() < wanted) &&
        canSpawnZombieAt(x, y, this.town, ground, survivors, (blockers ??= sightRects(this.town)), {
          safeRadius,
          forbidInView: this.ai.config.directorPacing > 0,
          forbidBehind: this.ai.config.directorPacing > 0,
          behindDist: 16,
        }),
      () => !paced || living() < wanted,
    )
    if (res.changed) {
      for (const feature of outbreakSharedFeatures.list()) {
        feature.onChunkSync?.(this, this.featureStates.get(feature.id))
      }
      this.revision++
      this.solids = solidRects(this.town)
      this.sights = sightRects(this.town)
      this.ai.rebuildTopology(this.town, this.worldStream.navTiles)
    }
    return res.changed
  }

  /** Advances everything shared once per tick: clock, channels, flashlights, vehicles, the crowd and its attacks, prompts. */
  stepWorld(dt: number, timeScale: number, tuning: SessionTuning = DEFAULT_STAMINA_TUNING): void {
    const resolved = resolveSessionTuning(tuning)
    this.rng.next()
    this.ai.rngSeedMix = this.rolloutSeedMix ? ((this.rng.getState() ^ this.rolloutSeedMix) >>> 0) : 0
    this.time += dt
    const pacing = this.ai.config
    const rate = openingClockActive(pacing.directorPacing, this.hour, this.elapsedHours)
      ? timeScale * pacing.openingClock
      : timeScale
    this.hour = advanceHour(this.hour, dt, rate)
    this.elapsedHours += (dt * rate) / 3600
    this.syncWorldChunks()
    const flashlightTuning = resolved.flashlight

    for (const slot of this.slots) {
      this.combat.step(slot.survivor, dt, this.time, this.progression.pistol(slot.id))
      stepFlashlight(slot.survivor, dt, this.time, flashlightTuning)
    }

    for (const feature of outbreakSharedFeatures.list()) {
      const res = feature.stepWorld?.({
        sim: this,
        dt,
        timeScale,
        resolved,
        state: this.featureStates.get(feature.id),
      })
      if (res?.topologyChanged) this.topologyChanged()
    }

    if (resolved.ai) {
      const config = this.ai.config
      if (resolved.ai.sightRange !== undefined) config.sightRange = resolved.ai.sightRange
      if (resolved.ai.sightCone !== undefined) config.sightCone = resolved.ai.sightCone
      if (resolved.ai.hearingScale !== undefined) config.hearingScale = resolved.ai.hearingScale
      if (resolved.ai.walkSpeed !== undefined) config.walkSpeed = resolved.ai.walkSpeed
      if (resolved.ai.chaseSpeed !== undefined) config.chaseSpeed = resolved.ai.chaseSpeed
      if (resolved.ai.aggression !== undefined) config.aggression = resolved.ai.aggression
      if (resolved.ai.nightMultiplier !== undefined) config.nightMultiplier = resolved.ai.nightMultiplier
      if (resolved.ai.aiDebugOverlay !== undefined) config.aiDebugOverlay = resolved.ai.aiDebugOverlay
    }

    const survivors = this.slots.map((s) => {
      let view: Survivor & { id: string } = { ...s.survivor, id: s.id }
      for (const feature of outbreakSharedFeatures.list()) {
        if (feature.transformAISurvivor) {
          view = feature.transformAISurvivor(this, s, view, this.featureStates.get(feature.id))
        }
      }
      return view
    })
    const aiStep = this.ai.stepSurvivors(this.town, survivors, this.hour, this.time, dt, flashlightTuning)
    if (aiStep.topologyChanged) {
      this.topologyChanged()
    }
    this.slots.forEach((slot, i) => {
      let damage = aiStep.damage[i]!
      if (damage > 0) {
        damage = survivorDamage(this, slot, damage, "crowd")
        slot.survivor.health = Math.max(0, slot.survivor.health - damage)
        if (aiStep.ankleGrabbed[i] && !slot.survivor.vehicleId) {
          slot.survivor.stamina = Math.max(0, slot.survivor.stamina - 0.14)
          slot.survivor.vx *= 0.45
          slot.survivor.vy *= 0.45
        }
      }
    })
    for (const feature of outbreakSharedFeatures.list()) {
      feature.stepWorldLate?.({ sim: this, dt, timeScale, resolved, state: this.featureStates.get(feature.id) })
    }
    this.rewind.record(Math.round(this.time * 60), this.time, this.ai.agents, (a) => (a as { state?: string }).state !== "dead")
    for (const slot of this.slots) this.refreshPrompt(slot)
  }

  refreshPrompt(slot: SurvivorSlot): void {
    for (const feature of outbreakSharedFeatures.list()) {
      if (feature.refreshPrompt?.(this, slot, this.featureStates.get(feature.id))) return
    }
    slot.peek = peekInfoFor(this.town, slot.survivor)
    slot.prompt = selectInteractTarget(this.town, slot.survivor, this.registry)
  }

  /** Re-derives survivor collision after doors or barricades changed (clients call this after a snapshot). */
  rebuildSolids(): void {
    this.syncWorldChunks()
    for (const feature of outbreakSharedFeatures.list()) {
      feature.onChunkSync?.(this, this.featureStates.get(feature.id))
    }
    this.solids = solidRects(this.town)
    this.sights = sightRects(this.town)
    for (const slot of this.slots) this.refreshPrompt(slot)
  }

  /** Collision, crowd navigation and prompts after an external edit (Lab, harness pose). */
  rebuildCollision(): void {
    this.syncWorldChunks()
    for (const feature of outbreakSharedFeatures.list()) {
      feature.onChunkSync?.(this, this.featureStates.get(feature.id))
    }
    this.solids = solidRects(this.town)
    this.sights = sightRects(this.town)
    this.worldStream.rebuildActiveNavTiles(this.town, this.ai.portalStates)
    this.ai.rebuildTopology(this.town, this.worldStream.navTiles)
    for (const slot of this.slots) this.refreshPrompt(slot)
  }

  private topologyChanged(): void {
    this.revision++
    for (const feature of outbreakSharedFeatures.list()) {
      feature.onTopologyChanged?.(this, this.featureStates.get(feature.id))
    }
    for (const chunk of this.worldStream.activeChunks.values()) {
      this.worldStream.captureChunkDelta(chunk, this.town, this.progression.containers, this.ai.portalStates, this.ai.agents)
    }
    this.worldStream.rebuildActiveNavTiles(this.town, this.ai.portalStates)
    this.solids = solidRects(this.town)
    this.sights = sightRects(this.town)
    this.ai.rebuildTopology(this.town, this.worldStream.navTiles)
  }

  /** Produces a pure, plain JSON-serialisable snapshot of the entire `CoopSim` state. */
  toSnapshot(): SimState {
    const featureStatesObj: Record<string, unknown> = {}
    const clonedFeatures = outbreakSharedFeatures.cloneSimStates(this.featureStates, this, this)
    for (const [k, v] of clonedFeatures) {
      if (v !== undefined) featureStatesObj[k] = JSON.parse(JSON.stringify(v))
    }
    return {
      version: 1,
      seed: this.seed,
      houseSeed: this.houseSeed,
      terrain: this.terrain,
      worldMode: this.worldStream.mode,
      rngState: this.rng.getState(),
      rolloutSeedMix: this.rolloutSeedMix,
      time: this.time,
      hour: this.hour,
      elapsedHours: this.elapsedHours,
      revision: this.revision,
      town: {
        doors: this.town.doors.map((d) => ({ ...d, rect: [...d.rect] as Rect })),
        windows: this.town.windows.map((w) => ({ ...w, rect: [...w.rect] as Rect })),
      },
      worldStream: this.worldStream.snapshot(),
      slots: this.slots.map((s) => ({
        id: s.id,
        index: s.index,
        survivor: cloneSurvivorState(s.survivor),
        notices: s.notices.map((n) => ({ ...n })),
      })),
      ai: this.ai.snapshot(),
      combat: this.combat.snapshot(this.slots),
      progression: this.progression.snapshot(),
      vehicles: this.vehicles.snapshot(),
      featureStates: featureStatesObj,
      rewind: this.rewind.snapshot(),
    }
  }

  /** Restores a `SimState` snapshot onto this `CoopSim` instance so future ticks are bit-identical. */
  restoreSnapshot(state: SimState): void {
    this.rng.setState(state.rngState)
    this.rolloutSeedMix = state.rolloutSeedMix ?? 0
    this.time = state.time
    this.hour = state.hour
    this.elapsedHours = state.elapsedHours ?? 0
    this.revision = state.revision

    this.worldStream.restore(state.worldStream)
    const portalMap = new Map(state.ai.portalStates)
    if (state.worldMode === "procedural" || !this.worldStream.isOriginNineOnly()) {
      this.worldStream.syncTownFromActiveChunks(this.town, this.progression.containers, portalMap)
    }

    const doorById = new Map(state.town.doors.map((d) => [d.id, d]))
    for (const d of this.town.doors) {
      const sd = doorById.get(d.id)
      if (sd) {
        d.open = sd.open
        d.locked = sd.locked
        d.keyed = sd.keyed
      }
    }
    const winById = new Map(state.town.windows.map((w) => [w.id, w]))
    for (const w of this.town.windows) {
      const sw = winById.get(w.id)
      if (sw) {
        w.open = sw.open
        w.openable = sw.openable
      }
    }
    for (const ch of this.worldStream.activeChunks.values()) {
      for (const d of ch.doors) {
        const sd = doorById.get(d.id)
        if (sd) {
          d.open = sd.open
          d.locked = sd.locked
          d.keyed = sd.keyed
        }
      }
      for (const w of ch.windows) {
        const sw = winById.get(w.id)
        if (sw) {
          w.open = sw.open
          w.openable = sw.openable
        }
      }
    }

    this.slots.length = 0
    for (const s of state.slots) {
      const survivor = cloneSurvivorState(s.survivor)
      const slot: SurvivorSlot = {
        id: s.id,
        index: s.index,
        survivor,
        prompt: undefined,
        peek: null,
        notices: s.notices.map((n) => ({ ...n })),
      }
      this.slots.push(slot)
    }
    this.slots.sort((a, b) => a.index - b.index)

    this.progression.restore(state.progression, this.slots)
    if (state.worldStream.hasNavTiles) {
      this.worldStream.rebuildActiveNavTiles(this.town, portalMap)
    }
    this.ai.restore(
      this.town,
      state.ai,
      this.worldStream.navTiles.size > 0 ? this.worldStream.navTiles : undefined,
    )
    this.combat.restore(state.combat, this.slots)
    this.vehicles.restore(state.vehicles, this.slots)
    this.rewind.restore(state.rewind ?? [])

    for (const [k, v] of Object.entries(state.featureStates ?? {})) {
      this.featureStates.set(k, JSON.parse(JSON.stringify(v)))
    }

    this.solids = solidRects(this.town)
    this.sights = sightRects(this.town)
    this.vehicleSolids = vehicleSolidRects(this.town)
    for (const slot of this.slots) this.refreshPrompt(slot)
  }

  /** Constructs a fresh `CoopSim` restored from a plain `SimState` value. */
  static fromSnapshot(state: SimState): CoopSim {
    const sim = new CoopSim(
      state.seed,
      state.houseSeed,
      state.terrain,
      state.ai.config,
      state.progression.tuning,
      state.worldMode,
    )
    sim.restoreSnapshot(state)
    return sim
  }

  /** Deep-clones this `CoopSim` via its plain serialisable `SimState`. */
  clone(): CoopSim {
    return CoopSim.fromSnapshot(this.toSnapshot())
  }
}

/** A sim that is still exactly at the `SimState` it last returned. */
type LiveSim = { sim: CoopSim | undefined }

/** States returned by `stepSim`, mapped to the sim that produced them. Taken (and deleted) by the next step. */
const liveSims = new WeakMap<SimState, LiveSim>()
/** The newest live sims; older ones are released so many abandoned branch heads don't each pin a world. */
const liveOrder: LiveSim[] = []
const MAX_LIVE_SIMS = 8

function takeLiveSim(state: SimState): CoopSim | undefined {
  const live = liveSims.get(state)
  if (!live?.sim) return undefined
  liveSims.delete(state)
  const sim = live.sim
  live.sim = undefined
  // The caller may have edited the state since we returned it; only an untouched state continues the live sim.
  return sameValue(state, sim.toSnapshot()) ? sim : undefined
}

function keepLiveSim(state: SimState, sim: CoopSim): void {
  const live: LiveSim = { sim }
  liveSims.set(state, live)
  liveOrder.push(live)
  if (liveOrder.length > MAX_LIVE_SIMS) liveOrder.shift()!.sim = undefined
  for (let i = liveOrder.length - 1; i >= 0; i--) if (!liveOrder[i]!.sim) liveOrder.splice(i, 1)
}

/** Deep equality of plain JSON-like values (`Object.is` on leaves, so `-Infinity` and `NaN` compare exactly). */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return Object.is(a, b)
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!sameValue(a[i], b[i])) return false
    return true
  }
  if (Array.isArray(b)) return false
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  for (const k of keys) {
    if (!Object.hasOwn(b, k) || !sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false
  }
  return true
}

/**
 * Pure simulation transition function `step(state, inputs, dt) -> state`:
 * Treats the entire game state as an immutable value with no hidden globals, clocks, or `Math.random`.
 *
 * Chained calls are cheap: the sim that produced `state` is kept alive (keyed by the returned object) and stepped in
 * place when `state` comes back unedited, so the town, chunks and nav topology are reused rather than rebuilt. Any
 * other state (a fork, an older tick, an edited one) is restored into a fresh sim. Both paths give identical results
 * because restoring a snapshot is lossless; `stepSim` never mutates `state`.
 */
export function stepSim(
  state: SimState,
  inputs: SimInputs,
  dt: number,
  options: StepSimOptions = {},
): SimState {
  const sim = takeLiveSim(state) ?? CoopSim.fromSnapshot(state)
  const tuning = options.tuning ?? DEFAULT_STAMINA_TUNING
  const timeScale = options.timeScale ?? 240
  for (let i = 0; i < sim.slots.length; i++) {
    const slot = sim.slots[i]!
    const cmd: Command = Array.isArray(inputs)
      ? (inputs[i] ?? { mx: 0, my: 0, aim: slot.survivor.aim, interact: false })
      : ((inputs as Readonly<Record<string, Command>>)[slot.id] ?? {
          mx: 0,
          my: 0,
          aim: slot.survivor.aim,
          interact: false,
        })
    sim.stepSurvivor(slot, cmd, dt, tuning)
  }
  sim.stepWorld(dt, timeScale, tuning)
  const next = sim.toSnapshot()
  keepLiveSim(next, sim)
  return next
}

const JSON_INF = "__arcade_inf__"
const JSON_NEG_INF = "__arcade_neg_inf__"

function simJsonReplacer(_key: string, value: unknown): unknown {
  if (value === Infinity) return JSON_INF
  if (value === -Infinity) return JSON_NEG_INF
  return value
}

function simJsonReviver(_key: string, value: unknown): unknown {
  if (value === JSON_INF) return Infinity
  if (value === JSON_NEG_INF) return -Infinity
  return value
}

export function cloneSimState(state: SimState): SimState {
  return JSON.parse(JSON.stringify(state, simJsonReplacer), simJsonReviver) as SimState
}

export function saveSimState(state: SimState): string {
  return JSON.stringify(state, simJsonReplacer)
}

export function loadSimState(json: string): SimState {
  return JSON.parse(json, simJsonReviver) as SimState
}

/**
 * Creates a forked copy of `state` with an optional new `rolloutSeed` (or AI/progression tuning overrides)
 * so parallel rollouts from the same snapshot explore distinct future stochastic trajectories.
 */
export function forkSimState(
  state: SimState,
  options: {
    rolloutSeed?: number
    aiConfig?: Partial<AIConfig>
    progressionTuning?: Partial<ProgressionTuning>
  } = {},
): SimState {
  const next = cloneSimState(state)
  if (options.rolloutSeed !== undefined) {
    const mix = (Math.imul((options.rolloutSeed >>> 0) + 1, 0x85ebca6b) || 1) >>> 0
    next.rngState = ((next.rngState ^ Math.imul((options.rolloutSeed >>> 0) + 1, 0x9e3779b9)) >>> 0) || 1
    next.rolloutSeedMix = mix
    next.ai.rngSeedMix = mix
  }
  if (options.aiConfig) {
    Object.assign(next.ai.config, options.aiConfig)
  }
  if (options.progressionTuning) {
    Object.assign(next.progression.tuning, options.progressionTuning)
  }
  return next
}

/**
 * Computes a deterministic 64-bit FNV-1a hex digest (`"16-hex-chars"`) over a `SimState` snapshot.
 * The world only: the `rewind` lag-compensation history is left out, so digests match those taken before it was
 * serialised.
 */
export function hashSimState(state: SimState): string {
  const str = JSON.stringify(state, function (this: unknown, key: string, value: unknown) {
    if (key === "rewind" && this === state) return undefined
    return simJsonReplacer(key, value)
  })
  let h1 = 0x811c9dc5 >>> 0
  let h2 = 0xcbf29ce4 >>> 0
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ ((c << 3) ^ (c >>> 2)), 0x100000001b3 & 0xffffffff) >>> 0
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`
}

/**
 * Structural recursive diff between two `SimState` snapshots `a` and `b`.
 * Returns `[]` when the two states are bit-identical.
 */
export function diffSimState(a: SimState, b: SimState, maxDiffs = 64): SimStateDiffEntry[] {
  const diffs: SimStateDiffEntry[] = []
  const visit = (va: unknown, vb: unknown, path: string) => {
    if (diffs.length >= maxDiffs) return
    if (Object.is(va, vb)) return
    if (
      typeof va !== "object" ||
      va === null ||
      typeof vb !== "object" ||
      vb === null ||
      Array.isArray(va) !== Array.isArray(vb)
    ) {
      diffs.push({ path, before: va, after: vb })
      return
    }
    if (Array.isArray(va) && Array.isArray(vb)) {
      if (va.length !== vb.length) {
        diffs.push({ path: `${path}.length`, before: va.length, after: vb.length })
      }
      const len = Math.min(va.length, vb.length)
      for (let i = 0; i < len; i++) {
        visit(va[i], vb[i], `${path}[${i}]`)
        if (diffs.length >= maxDiffs) return
      }
      return
    }
    const oa = va as Record<string, unknown>
    const ob = vb as Record<string, unknown>
    const keys = new Set([...Object.keys(oa), ...Object.keys(ob)])
    for (const k of [...keys].sort()) {
      visit(oa[k], ob[k], path ? `${path}.${k}` : k)
      if (diffs.length >= maxDiffs) return
    }
  }
  visit(a, b, "")
  return diffs
}
