import {
  createAIAgent,
  DEFAULT_AI_CONFIG as KIT_DEFAULT_AI_CONFIG,
  GridNav,
  hasSeveredLeg,
  isTorsoCrawler,
  NoiseBus,
  SpatialHash,
  stepAICrowd,
  zombieTraitsFromSeed,
  type AIAgent,
  type AIConfig as KitAIConfig,
  type AIState,
  type FlashlightState,
  type NavPortal,
  type NoiseEvent,
  type NoiseKind,
  type PerceptionTarget,
  type ZombieDeathVariant,
  type ZombieHitReaction,
} from "@arcade/kit/sim/ai"
import { FlowFieldCache } from "@arcade/kit/sim/flow-field"
import { type Rect } from "@arcade/kit/sim/geom"
import { dayCycle } from "./day-cycle"
import {
  DEFAULT_FLASHLIGHT_TUNING,
  flashlightAwarenessAt,
  type FlashlightState as SurvivorFlashlightState,
  type FlashlightTuning,
} from "./flashlight"
import { EXTERIOR_VEHICLE_COLLIDERS, propShape, sightRects, SIZE, solidRects, type Town } from "./map"
import {
  canSpawnZombieAt,
  coopChaserScale,
  coopPopulationScale,
  DEFAULT_PACING_TUNING,
  initialSpawnCount,
  isInsideSafeZone,
  isSpawnBehindPlayer,
  isSpawnInView,
  LEGACY_PACING_TUNING,
  OutbreakPacingDirector,
  openingThreat,
  pacingControls,
  spawnLegacyTownZombies,
  spawnPacedTownZombies,
  STARTING_SAFEHOUSE_RECT,
  STARTING_SAFEHOUSE_YARD_RECT,
  type FirstEncounterStage,
  type PacingSurvivorView,
  type PacingTelemetry,
  type PacingTuning,
} from "./pacing/index"

export type AIConfig = KitAIConfig & PacingTuning

/** Outbreak's zombie AI before D-22 (Balanced Curve). Saved presets that carry these values keep them. */
export const LEGACY_AI_CONFIG: AIConfig = {
  ...KIT_DEFAULT_AI_CONFIG,
  ...LEGACY_PACING_TUNING,
}

/** D-22 Balanced Curve, tuned by the survivor-bot CMA-ES search (games/outbreak/scripts/run-bot-tuning.ts). */
export const DEFAULT_AI_CONFIG: AIConfig = {
  ...KIT_DEFAULT_AI_CONFIG,
  ...DEFAULT_PACING_TUNING,
  zombieCount: 16,
  sightRange: 15,
  hearingScale: 0.75,
  chaseSpeed: 2.85,
  aggression: 1.15,
  nightMultiplier: 1.4,
}

export {
  canSpawnZombieAt,
  coopChaserScale,
  coopPopulationScale,
  createAIAgent,
  DEFAULT_PACING_TUNING,
  hasSeveredLeg,
  initialSpawnCount,
  isInsideSafeZone,
  isSpawnBehindPlayer,
  isSpawnInView,
  isTorsoCrawler,
  NoiseBus,
  OutbreakPacingDirector,
  openingThreat,
  pacingControls,
  spawnLegacyTownZombies,
  spawnPacedTownZombies,
  STARTING_SAFEHOUSE_RECT,
  STARTING_SAFEHOUSE_YARD_RECT,
  zombieTraitsFromSeed,
  type AIAgent,
  type AIState,
  type FirstEncounterStage,
  type FlashlightState,
  type NoiseEvent,
  type NoiseKind,
  type PacingSurvivorView,
  type PacingTelemetry,
  type PacingTuning,
  type ZombieDeathVariant,
  type ZombieHitReaction,
}

export const aiControls = [
  { key: "aiDebugOverlay", label: "Debug overlay", group: "AI" },
  { key: "zombieCount", label: "Population", group: "AI", min: 0, max: 100, step: 1, unit: "" },
  { key: "sightRange", label: "Sight range", group: "AI", min: 6, max: 36, step: 1, unit: "m" },
  { key: "sightCone", label: "Sight cone", group: "AI", min: 45, max: 180, step: 5, unit: "deg" },
  { key: "hearingScale", label: "Hearing scale", group: "AI", min: 0, max: 2.5, step: 0.1, unit: "×" },
  {
    key: "ai.walkSpeed",
    field: "walkSpeed",
    legacyKeys: ["aiWalkSpeed"],
    label: "Wander speed",
    group: "AI",
    min: 0.4,
    max: 2.2,
    step: 0.05,
    unit: "m/s",
  },
  { key: "chaseSpeed", label: "Chase speed", group: "AI", min: 1.2, max: 4.8, step: 0.05, unit: "m/s" },
  { key: "aggression", label: "Aggression", group: "AI", min: 0.3, max: 2.5, step: 0.1, unit: "×" },
  { key: "nightMultiplier", label: "Night boost", group: "AI", min: 1.0, max: 2.2, step: 0.05, unit: "×" },
  {
    key: "directorPacing",
    label: "Director pacing",
    group: "AI",
    options: [
      { label: "Off", value: 0 },
      { label: "Active", value: 1 },
    ],
  },
  ...pacingControls,
] as const

export type PortalState = {
  integrity: number
  barricadePlanks: number
  barricadeHp: number
  lastBashTime: number
}

/** Computes illumination (0..1.4) at world position (x, y) from time of day and active town lamps. */
export function samplePointLightLevel(town: Town, hour: number, x: number, y: number, lightingScale = 1): number {
  const day = dayCycle(hour)
  const indoor = town.buildings.some((b) => x >= b.rect[0] && x <= b.rect[2] && y >= b.rect[1] && y <= b.rect[3])
  let level = (indoor ? 0.12 : 0.18) + day.sun * (indoor ? 0.35 : 0.82)
  const lampFactor = day.lamps * lightingScale
  if (lampFactor > 0.01) {
    for (let i = 0; i < town.lamps.length; i++) {
      const lamp = town.lamps[i]!
      const dx = x - lamp.x
      const dy = y - lamp.y
      const d = Math.hypot(dx, dy)
      if (d >= lamp.radius) continue
      const u = 1 - d / lamp.radius
      level += lamp.power * lampFactor * u * u * 1.45
    }
  }
  return Math.max(0.05, Math.min(1.5, level))
}

/**
 * Deterministic town-wide zombie spawner.
 * Places loose street/yard rally clusters and solitary shamblers while keeping a safe buffer around the survivor.
 */
export function spawnTownZombies(
  town: Town,
  nav: GridNav,
  count: number,
  avoidX: number,
  avoidY: number,
  minClearance = 3.5,
): AIAgent[] {
  return spawnLegacyTownZombies(town, nav, count, avoidX, avoidY, minClearance)
}

/** What the crowd perceives of a survivor. `id` defaults to "player" (the single-player target id). */
export type AISurvivor = {
  id?: string
  x: number
  y: number
  vx: number
  vy: number
  aim: number
  noise: number
} & SurvivorFlashlightState

export type OutbreakAISnapshot = {
  tick: number
  threat: number
  darkness: number
  nextAgentId: number
  manualSpawnOnly: boolean
  rngSeedMix: number
  config: AIConfig
  agents: AIAgent[]
  portalStates: [string, PortalState][]
  noiseBus: import("@arcade/kit/sim/ai").NoiseBusSnapshot
  pacing: import("./pacing").PacingDirectorSnapshot
  /** Where each survivor's shared flow field is anchored (the fields themselves are rebuilt on demand). */
  flowAnchors?: import("@arcade/kit/sim/flow-field").FlowAnchor[]
}

export class OutbreakAISubsystem {
  readonly nav = new GridNav(SIZE, SIZE, 0.5)
  /** Shared per-goal flow fields over `nav` (derived from it, so never snapshotted). */
  readonly flow = new FlowFieldCache(this.nav)
  readonly spatial = new SpatialHash(SIZE, SIZE, 4)
  readonly noiseBus = new NoiseBus(64)
  readonly portalStates = new Map<string, PortalState>()
  readonly pacing = new OutbreakPacingDirector()
  agents: AIAgent[] = []
  config: AIConfig = { ...DEFAULT_AI_CONFIG }
  tick = 0
  /** Current 0..1 nocturnal threat / darkness level driven by `dayCycle(hour)`. */
  threat = 1
  darkness = 1
  /** Optional simulation PRNG state mix for forked rollouts (0 on baseline runs). */
  rngSeedMix = 0
  private nextAgentId = 1
  private manualSpawnOnly = false
  private walls: Rect[] = []
  private closedDoors: Rect[] = []
  private sightBlockers: Rect[] = []
  private solids: Rect[] = []
  private portals: NavPortal[] = []
  private lastTopologyDigest = -1
  private lastBarriersRef: unknown = null
  private lastDoorsRef: unknown = null
  private lastPropsRef: unknown = null

  constructor(town: Town, initialPlayerX = 27.7, initialPlayerY = 41, config: Partial<AIConfig> = {}) {
    Object.assign(this.config, config)
    this.manualSpawnOnly = this.config.zombieCount === 0
    this.initPortals(town)
    this.rebuildTopology(town)
    this.agents = spawnPacedTownZombies(town, this.nav, this.sightBlockers, this.config, [
      { x: initialPlayerX, y: initialPlayerY, aim: -Math.PI / 2, flashlightOn: true, flashlightOutput: 1 },
    ])
    this.nextAgentId = this.agents.reduce((m, a) => Math.max(m, a.id), 0) + 1
    this.pacing.telemetry = this.pacing.evaluateCurve(
      this.config,
      this.config.startHour,
      0,
      1,
      this.agents.length,
    )
  }

  /** Re-applies opening pacing placement for the given survivor positions (used when safeRadius/initialDensity change in Lab). */
  resetOpeningPopulation(town: Town, survivors: readonly PacingSurvivorView[]): void {
    this.manualSpawnOnly = this.config.zombieCount === 0
    this.pacing.reset()
    this.rebuildTopology(town, this.nav.chunkTiles.size > 0 ? new Map(this.nav.chunkTiles) : undefined)
    this.agents = spawnPacedTownZombies(town, this.nav, this.sightBlockers, this.config, survivors)
    this.nextAgentId = this.agents.reduce((m, a) => Math.max(m, a.id), 0) + 1
    this.pacing.stepAfterCrowd(this.nav, this.agents, survivors, this.config, 0, this.manualSpawnOnly)
  }

  private initPortals(town: Town): void {
    this.portalStates.clear()
    for (const d of town.doors) {
      this.portalStates.set(d.id, { integrity: 100, barricadePlanks: 0, barricadeHp: 0, lastBashTime: -Infinity })
    }
    for (const w of town.windows) {
      this.portalStates.set(w.id, { integrity: 100, barricadePlanks: 0, barricadeHp: 0, lastBashTime: -Infinity })
    }
  }

  private ensurePortals(town: Town): void {
    for (const d of town.doors) {
      if (!this.portalStates.has(d.id)) {
        this.portalStates.set(d.id, { integrity: 100, barricadePlanks: 0, barricadeHp: 0, lastBashTime: -Infinity })
      }
    }
    for (const w of town.windows) {
      if (!this.portalStates.has(w.id)) {
        this.portalStates.set(w.id, { integrity: 100, barricadePlanks: 0, barricadeHp: 0, lastBashTime: -Infinity })
      }
    }
  }

  private computeTopologyDigest(town: Town, chunkTiles?: ReadonlyMap<string, Uint8Array>): number {
    let h = 2166136261 >>> 0
    h = Math.imul(h ^ town.barriers.length, 16777619) >>> 0
    h = Math.imul(h ^ town.props.length, 16777619) >>> 0
    h = Math.imul(h ^ (town.vehicles?.length ?? 0), 16777619) >>> 0
    h = Math.imul(h ^ (chunkTiles?.size ?? 0), 16777619) >>> 0
    for (let i = 0; i < town.doors.length; i++) {
      const d = town.doors[i]!
      const st = this.portalStates.get(d.id)
      const mask = (d.open ? 1 : 0) | (d.locked ? 2 : 0) | ((st?.barricadePlanks ?? 0) << 2) | ((st?.integrity ?? 100) << 5)
      h = Math.imul(h ^ mask, 16777619) >>> 0
    }
    for (let i = 0; i < town.windows.length; i++) {
      const w = town.windows[i]!
      const st = this.portalStates.get(w.id)
      const mask = (w.open ? 1 : 0) | (w.openable ? 2 : 0) | ((st?.barricadePlanks ?? 0) << 2) | ((st?.integrity ?? 100) << 5)
      h = Math.imul(h ^ mask, 16777619) >>> 0
    }
    return h >>> 0
  }

  rebuildTopology(town: Town, chunkTiles?: ReadonlyMap<string, Uint8Array>): void {
    this.ensurePortals(town)
    const digest = this.computeTopologyDigest(town, chunkTiles)
    if (
      digest === this.lastTopologyDigest &&
      this.lastBarriersRef === town.barriers &&
      this.lastDoorsRef === town.doors &&
      this.lastPropsRef === town.props &&
      (!chunkTiles || chunkTiles.size === this.nav.chunkTiles.size)
    ) {
      return
    }
    this.lastTopologyDigest = digest
    this.lastBarriersRef = town.barriers
    this.lastDoorsRef = town.doors
    this.lastPropsRef = town.props

    this.walls = town.barriers.filter((b) => b.kind === "wall").map((b) => b.rect)
    this.closedDoors = town.doors
      .filter((d) => !d.open || (this.portalStates.get(d.id)?.barricadePlanks ?? 0) > 0)
      .map((d) => d.rect)
    this.sightBlockers = sightRects(town)

    const baseSolids = solidRects(town)
    const extraBarricadeSolids: Rect[] = []
    for (const d of town.doors) {
      if (d.open && (this.portalStates.get(d.id)?.barricadePlanks ?? 0) > 0) {
        extraBarricadeSolids.push(d.rect)
      }
    }
    this.solids = extraBarricadeSolids.length ? [...baseSolids, ...extraBarricadeSolids] : baseSolids

    this.portals = [
      ...town.doors.map((d): NavPortal => {
        const st = this.portalStates.get(d.id)
        return {
          id: d.id,
          kind: "door",
          rect: d.rect,
          open: d.open,
          locked: d.locked,
          barricadePlanks: st?.barricadePlanks ?? 0,
          integrity: st?.integrity ?? 100,
        }
      }),
      ...town.windows.map((w): NavPortal => {
        const st = this.portalStates.get(w.id)
        return {
          id: w.id,
          kind: "window",
          rect: w.rect,
          open: w.open,
          openable: w.openable,
          barricadePlanks: st?.barricadePlanks ?? 0,
          integrity: st?.integrity ?? 100,
        }
      }),
    ]

    if (chunkTiles && chunkTiles.size > 0) {
      this.nav.chunkTiles.clear()
      for (const [k, tile] of chunkTiles) this.nav.chunkTiles.set(k, tile)
      this.nav.invalidateTileCache()
      return
    }
    this.nav.chunkTiles.clear()
    this.nav.invalidateTileCache()
    const navObstacleRects = [
      ...town.barriers.map((b) => b.rect),
      ...town.props.flatMap((p) => {
        const s = propShape(p)
        return s ? [s.rect] : []
      }),
      ...(town.vehicles ?? EXTERIOR_VEHICLE_COLLIDERS),
    ]
    this.nav.rebuild(navObstacleRects, this.portals, 0.28)
  }

  syncPopulation(town: Town, avoidX: number, avoidY: number): void {
    const desired = Math.max(0, Math.min(100, Math.round(this.config.zombieCount)))
    this.manualSpawnOnly = desired === 0
    const living = this.agents.filter((a) => a.state !== "dead")
    if (living.length === desired) return
    if (living.length > desired) {
      let toRemove = living.length - desired
      for (let i = this.agents.length - 1; i >= 0 && toRemove > 0; i--) {
        if (this.agents[i]!.state !== "dead") {
          this.agents.splice(i, 1)
          toRemove--
        }
      }
      return
    }
    const extra = spawnLegacyTownZombies(
      town,
      this.nav,
      desired - living.length + 8,
      avoidX,
      avoidY,
      Math.max(7.0, this.config.directorPacing > 0 ? this.config.safeRadius * 0.5 : 3.5),
    )
    for (const a of extra) {
      if (this.agents.filter((z) => z.state !== "dead").length >= desired) break
      a.id = this.nextAgentId++
      this.agents.push(a)
    }
  }

  spawnZombie(town: Town, x: number, y: number, state: AIState = "wander", aim?: number): AIAgent {
    const pos = this.nav.nearest({ x, y })
    const agent = createAIAgent(this.nextAgentId++, town.seed + this.tick, pos.x, pos.y, aim)
    agent.state = state
    if (state === "chase" || state === "alert") {
      agent.awareness = 1
    } else if (state === "investigate" || state === "search") {
      agent.awareness = 0.6
    }
    this.agents.push(agent)
    this.config.zombieCount = this.agents.filter((a) => a.state !== "dead").length
    return agent
  }

  setZombieState(state: AIState, targetX?: number, targetY?: number, agentId?: number): number {
    let count = 0
    for (const a of this.agents) {
      if (a.state === "dead") continue
      if (agentId !== undefined && a.id !== agentId) continue
      a.state = state
      a.stateTime = 0
      a.repathAt = 0
      if (targetX !== undefined && targetY !== undefined) {
        a.targetX = targetX
        a.targetY = targetY
      }
      if (state === "chase" || state === "alert") a.awareness = 1
      else if (state === "investigate" || state === "search") a.awareness = Math.max(0.55, a.awareness)
      else if (state === "wander") a.awareness = 0
      count++
    }
    return count
  }

  emitNoise(
    x: number,
    y: number,
    radius: number,
    kind: NoiseKind,
    time: number,
    sourceId = "player",
    loudness?: number,
  ): NoiseEvent {
    return this.noiseBus.emit({ x, y, radius, kind, time, sourceId, loudness })
  }

  /** Adds one plank holding `hp` (100 plain, more when reinforced). */
  addBarricadePlank(portalId: string, hp = 100): boolean {
    const st = this.portalStates.get(portalId)
    if (!st || st.barricadePlanks >= 3) return false
    st.barricadeHp = (st.barricadePlanks > 0 ? st.barricadeHp : 0) + hp
    st.barricadePlanks++
    return true
  }

  getBarricadePlanks(portalId: string): number {
    return this.portalStates.get(portalId)?.barricadePlanks ?? 0
  }

  snapshot(): OutbreakAISnapshot {
    return {
      tick: this.tick,
      threat: this.threat,
      darkness: this.darkness,
      nextAgentId: this.nextAgentId,
      manualSpawnOnly: this.manualSpawnOnly,
      rngSeedMix: this.rngSeedMix,
      config: { ...this.config },
      agents: this.agents.map((a) => ({
        ...a,
        path: a.path.map((pt) => ({ x: pt.x, y: pt.y })),
        detachedLimbs: [...a.detachedLimbs],
      })),
      portalStates: [...this.portalStates.entries()].map(([k, v]) => [k, { ...v }]),
      noiseBus: this.noiseBus.snapshot(),
      pacing: this.pacing.snapshot(),
      ...(this.flow.anchors.length > 0 ? { flowAnchors: this.flow.anchors.map((a) => ({ ...a })) } : {}),
    }
  }

  restore(town: Town, snap: OutbreakAISnapshot, chunkTiles?: ReadonlyMap<string, Uint8Array>): void {
    this.tick = snap.tick
    this.threat = snap.threat
    this.darkness = snap.darkness
    this.nextAgentId = snap.nextAgentId
    this.manualSpawnOnly = snap.manualSpawnOnly
    this.rngSeedMix = snap.rngSeedMix ?? 0
    this.config = { ...snap.config }
    this.agents = snap.agents.map((a) => ({
      ...a,
      path: a.path.map((pt) => ({ x: pt.x, y: pt.y })),
      detachedLimbs: [...a.detachedLimbs],
    }))
    this.portalStates.clear()
    for (const [k, v] of snap.portalStates) {
      this.portalStates.set(k, { ...v, lastBashTime: v.lastBashTime ?? -Infinity })
    }
    this.noiseBus.restore(snap.noiseBus)
    this.pacing.restore(snap.pacing)
    this.flow.anchors = (snap.flowAnchors ?? []).map((a) => ({ ...a }))
    this.lastTopologyDigest = -1
    this.rebuildTopology(town, chunkTiles)
  }

  step(
    town: Town,
    player: AISurvivor,
    hour: number,
    time: number,
    dt: number,
    flashlightTuning: Pick<FlashlightTuning, "flashlightRange" | "flashlightCone"> = DEFAULT_FLASHLIGHT_TUNING,
  ): { topologyChanged: boolean; playerDamage: number } {
    const res = this.stepSurvivors(town, [player], hour, time, dt, flashlightTuning)
    return { topologyChanged: res.topologyChanged, playerDamage: res.damage[0]! }
  }

  /** Advances the crowd against every survivor; `damage[i]` is the damage dealt to `survivors[i]` this tick. */
  stepSurvivors(
    town: Town,
    survivors: readonly AISurvivor[],
    hour: number,
    time: number,
    dt: number,
    flashlightTuning: Pick<FlashlightTuning, "flashlightRange" | "flashlightCone"> = DEFAULT_FLASHLIGHT_TUNING,
  ): { topologyChanged: boolean; damage: number[]; ankleGrabbed: boolean[] } {
    this.tick++
    const day = dayCycle(hour)
    this.darkness = day.darkness
    this.threat = openingThreat(day.threat, time, this.config)
    // 0 at the start of the opening calm, 1 once it has passed: beams carry half as far while the opening is calm
    const calm = openingThreat(1, time, this.config)
    // Peaceful during the day (0.68× calmer perception/speed), rising through dusk to full nocturnal threat at night
    const nightFactor = 0.68 + this.threat * (0.32 + (this.config.nightMultiplier - 1))
    const threatConfig: AIConfig = {
      ...this.config,
      flashlightBoost: this.config.flashlightBoost * (0.5 + 0.5 * calm),
      aggression: this.config.aggression * (0.65 + 0.35 * this.threat),
      sightRange: this.config.sightRange * (0.72 + 0.28 * this.threat),
      walkSpeed: this.config.walkSpeed * (0.82 + 0.18 * this.threat),
      chaseSpeed: this.config.chaseSpeed * (0.88 + 0.12 * this.threat),
    }
    const targets: PerceptionTarget[] = survivors.map((player) => {
      const baseLightLevel = samplePointLightLevel(town, hour, player.x, player.y, 1)
      const lightLevel = Math.min(1.5, baseLightLevel + (player.flashlightOn ? player.flashlightOutput * 0.55 : 0))
      const flashlight: FlashlightState | null =
        player.flashlightOn && player.flashlightOutput > 0.01
          ? {
              on: true,
              x: player.x,
              y: player.y,
              aim: player.aim,
              range: player.lightSignature || flashlightTuning.flashlightRange,
              halfAngle: (flashlightTuning.flashlightCone * Math.PI) / 360,
              output: player.flashlightOutput,
              awarenessAt: (zx, zy) => flashlightAwarenessAt(player, zx, zy, this.sightBlockers, flashlightTuning),
            }
          : null
      return {
        id: player.id ?? "player",
        x: player.x,
        y: player.y,
        vx: player.vx,
        vy: player.vy,
        lightLevel,
        continuousNoiseRadius: player.noise,
        flashlight,
      }
    })

    // Opening & Night Pacing Director: exploration/noise ramp, first 1–3 zombie encounter, backstage trickle spawns & waves
    this.pacing.stepBeforeCrowd(
      town,
      this.nav,
      this.agents,
      survivors,
      this.sightBlockers,
      this.noiseBus,
      this.config,
      hour,
      time,
      dt,
      this.tick,
      () => this.nextAgentId++,
      this.manualSpawnOnly,
      this.rngSeedMix,
    )

    const res = stepAICrowd(this.agents, {
      time,
      tick: this.tick,
      dt,
      worldSize: SIZE,
      worldBounds: town.worldBounds,
      rngSeedMix: this.rngSeedMix,
      nightFactor,
      solids: this.solids,
      walls: this.walls,
      closedDoors: this.closedDoors,
      sightBlockers: this.sightBlockers,
      portals: this.portals,
      nav: this.nav,
      spatial: this.spatial,
      noiseBus: this.noiseBus,
      config: threatConfig,
      targets,
      flow: this.flow,
    })

    this.pacing.stepAfterCrowd(
      this.nav,
      this.agents,
      survivors,
      this.config,
      time,
      this.manualSpawnOnly,
    )

    let topologyChanged = false
    for (const bash of res.bashes) {
      const st = this.portalStates.get(bash.portalId)
      if (!st) continue
      st.lastBashTime = time
      if (st.barricadePlanks > 0) {
        const perPlank = st.barricadeHp / st.barricadePlanks
        st.barricadeHp = Math.max(0, st.barricadeHp - bash.damage)
        const nextPlanks = Math.max(0, Math.min(st.barricadePlanks, Math.ceil(st.barricadeHp / perPlank - 1e-9)))
        if (nextPlanks !== st.barricadePlanks) {
          st.barricadePlanks = nextPlanks
          topologyChanged = true
        }
      } else if (bash.portalKind === "door") {
        const door = town.doors.find((d) => d.id === bash.portalId)
        if (door && !door.open) {
          st.integrity = Math.max(0, st.integrity - bash.damage)
          if (st.integrity <= 0) {
            door.open = true
            door.locked = false
            st.integrity = 100
            topologyChanged = true
          }
        }
      }
    }

    if (topologyChanged) {
      this.rebuildTopology(town, this.nav.chunkTiles.size > 0 ? new Map(this.nav.chunkTiles) : undefined)
    }

    const damage = survivors.map(() => 0)
    const ankleGrabbed = survivors.map(() => false)
    for (const atk of res.attacks) {
      const i = survivors.length === 1 ? 0 : targets.findIndex((t) => t.id === atk.targetId)
      const player = survivors[i]
      if (player && Math.hypot(atk.x - player.x, atk.y - player.y) <= 1.25) {
        damage[i]! += atk.damage
        if (atk.ankleGrab) ankleGrabbed[i] = true
      }
    }

    return { topologyChanged, damage, ankleGrabbed }
  }
}
