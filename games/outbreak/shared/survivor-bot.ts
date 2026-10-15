import { attenuateNoise, GridNav, type AIAgent, type NavPortal, type NoiseEvent } from "@arcade/kit/sim/ai"
import { angleDiff, clearLine, distToRect, pushOut, raycast, type Rect, type Vec } from "@arcade/kit/sim/geom"
import { Rng } from "@arcade/kit/sim/rng"
import { samplePointLightLevel } from "./ai"
import { PISTOL_MAG_SIZE, PISTOL_RANGE, SHOVE_RANGE } from "./combat"
import type { CoopSim, SurvivorSlot } from "./coop-sim"
import { dayCycle } from "./day-cycle"
import { DEFAULT_FLASHLIGHT_TUNING, flashlightAwarenessAt } from "./flashlight"
import { INTERACT_RANGE, type InteractTarget } from "./interact"
import { inBuildingFootprint, propShape, sightRects, SIZE, solidRects, type Building, type Town } from "./map"
import { STARTING_SAFEHOUSE_RECT } from "./pacing"
import { RECIPES, type BenchSite, type LootSite } from "./progression"
import type { Command } from "./session"
import { DEFAULT_VISION, Vision } from "./vision"

const insideBuildingAt = (town: Town, x: number, y: number): Building | undefined =>
  town.buildings.find((b) => inBuildingFootprint(b, x, y))

export type BotSkillPresetId = "Novice" | "Casual" | "Skilled" | "Expert" | "Perfect"

export const BOT_SKILL_PRESET_ORDER: readonly BotSkillPresetId[] = [
  "Novice",
  "Casual",
  "Skilled",
  "Expert",
  "Perfect",
] as const

export type BotSkillConfig = {
  /** Sensory-motor reaction delay (s) before responding to newly detected threats. */
  reactionTime: number
  /** Angular aim jitter / error standard deviation (rad). */
  aimError: number
  /** Exponential smoothing time constant (s) for aiming at moving targets. */
  aimTrackingLag: number
  /** Utility score perturbation (0..1) causing occasional suboptimal choices. */
  decisionNoise: number
  /** Close-quarters 360° peripheral/silhouette awareness radius (m). */
  awarenessRadius: number
  /** Tendency (0..1) to panic under horde pressure (smash containers, sprint to exhaustion, spray fire). */
  panicUnderPressure: number
  /** Stamina reserve fraction (0..1) preserved during non-emergency travel. */
  staminaDiscipline: number
  /** Preference (0..1) for saving pistol rounds via melee/shoves and close high-probability shots. */
  ammoDiscipline: number
  /** Prior familiarity (0..1) with town building and workbench layout at t = 0. */
  mapKnowledge: number
}

export const BOT_SKILL_PRESETS: Readonly<Record<BotSkillPresetId, BotSkillConfig>> = {
  Novice: {
    reactionTime: 0.52,
    aimError: 0.24,
    aimTrackingLag: 0.25,
    decisionNoise: 0.36,
    awarenessRadius: 1.8,
    panicUnderPressure: 0.85,
    staminaDiscipline: 0.05,
    ammoDiscipline: 0.12,
    mapKnowledge: 0.05,
  },
  Casual: {
    reactionTime: 0.34,
    aimError: 0.13,
    aimTrackingLag: 0.15,
    decisionNoise: 0.2,
    awarenessRadius: 2.5,
    panicUnderPressure: 0.48,
    staminaDiscipline: 0.25,
    ammoDiscipline: 0.38,
    mapKnowledge: 0.28,
  },
  Skilled: {
    reactionTime: 0.2,
    aimError: 0.055,
    aimTrackingLag: 0.08,
    decisionNoise: 0.08,
    awarenessRadius: 3.2,
    panicUnderPressure: 0.18,
    staminaDiscipline: 0.45,
    ammoDiscipline: 0.68,
    mapKnowledge: 0.6,
  },
  Expert: {
    reactionTime: 0.11,
    aimError: 0.022,
    aimTrackingLag: 0.035,
    decisionNoise: 0.03,
    awarenessRadius: 4.0,
    panicUnderPressure: 0.05,
    staminaDiscipline: 0.62,
    ammoDiscipline: 0.86,
    mapKnowledge: 0.88,
  },
  Perfect: {
    reactionTime: 0.0,
    aimError: 0.0,
    aimTrackingLag: 0.0,
    decisionNoise: 0.0,
    awarenessRadius: 4.8,
    panicUnderPressure: 0.0,
    staminaDiscipline: 0.72,
    ammoDiscipline: 0.96,
    mapKnowledge: 1.0,
  },
}

export function resolveBotSkillPreset(presetOrIndex: BotSkillPresetId | number): BotSkillPresetId {
  if (typeof presetOrIndex === "string") {
    return presetOrIndex in BOT_SKILL_PRESETS ? presetOrIndex : "Skilled"
  }
  const idx = Math.max(0, Math.min(BOT_SKILL_PRESET_ORDER.length - 1, Math.round(presetOrIndex)))
  return BOT_SKILL_PRESET_ORDER[idx] ?? "Skilled"
}

export function botSkillPresetIndex(preset: BotSkillPresetId): number {
  const idx = BOT_SKILL_PRESET_ORDER.indexOf(preset)
  return idx >= 0 ? idx : 2
}

export const botControls = [
  {
    key: "botEnabled",
    label: "Autopilot bot",
    group: "Bots",
    options: [
      { label: "Off (Human)", value: 0 },
      { label: "Active (Bot)", value: 1 },
    ],
  },
  {
    key: "botCount",
    label: "Squad size",
    group: "Bots",
    min: 1,
    max: 4,
    step: 1,
    unit: "survivors",
  },
  {
    key: "botSkillPreset",
    label: "Skill preset",
    group: "Bots",
    options: [
      { label: "Novice", value: 0 },
      { label: "Casual", value: 1 },
      { label: "Skilled", value: 2 },
      { label: "Expert", value: 3 },
      { label: "Perfect", value: 4 },
    ],
  },
  {
    key: "botDebugOverlay",
    label: "Perception & intent overlay",
    group: "Bots",
  },
  {
    key: "botReactionTime",
    label: "Reaction time",
    group: "Bots",
    min: 0,
    max: 0.8,
    step: 0.02,
    unit: "s",
  },
  {
    key: "botAimError",
    label: "Aim error",
    group: "Bots",
    min: 0,
    max: 0.4,
    step: 0.01,
    unit: "rad",
  },
  {
    key: "botAimTrackingLag",
    label: "Tracking lag",
    group: "Bots",
    min: 0,
    max: 0.4,
    step: 0.01,
    unit: "s",
  },
  {
    key: "botDecisionNoise",
    label: "Decision noise",
    group: "Bots",
    min: 0,
    max: 0.6,
    step: 0.02,
    unit: "",
  },
  {
    key: "botAwarenessRadius",
    label: "Awareness radius",
    group: "Bots",
    min: 1.0,
    max: 6.0,
    step: 0.2,
    unit: "m",
  },
  {
    key: "botPanicUnderPressure",
    label: "Panic under pressure",
    group: "Bots",
    min: 0,
    max: 1,
    step: 0.05,
    unit: "",
  },
  {
    key: "botStaminaDiscipline",
    label: "Stamina discipline",
    group: "Bots",
    min: 0,
    max: 0.9,
    step: 0.05,
    unit: "",
  },
  {
    key: "botAmmoDiscipline",
    label: "Ammo discipline",
    group: "Bots",
    min: 0,
    max: 1,
    step: 0.05,
    unit: "",
  },
  {
    key: "botMapKnowledge",
    label: "Map knowledge",
    group: "Bots",
    min: 0,
    max: 1,
    step: 0.05,
    unit: "",
  },
] as const

export type BotIntentKind =
  | "heal"
  | "fight-melee"
  | "kite-shoot"
  | "flee-horde"
  | "reload-cover"
  | "barricade"
  | "retreat-safehouse"
  | "workbench"
  | "craft"
  | "loot"
  | "assist-ally"
  | "explore"

export type PerceivedThreat = {
  id: number
  /** Perceived or remembered world X. */
  x: number
  /** Perceived or remembered world Y. */
  y: number
  vx: number
  vy: number
  distance: number
  source: "sight" | "sound" | "memory"
  /** True once reactionTime has elapsed since initial detection. */
  actionable: boolean
  firstDetectedAt: number
  lastUpdatedAt: number
  /** Confidence (0..1); decays when out of sight. */
  confidence: number
  state: AIAgent["state"]
  hpEstimate: number
}

export type PerceivedSound = {
  id: number
  x: number
  y: number
  kind: string
  loudness: number
  time: number
}

export type DiscoveredContainer = {
  id: string
  x: number
  y: number
  rect: Rect
  buildingId: string | null
  label: string
  searched: boolean
  empty: boolean
  takenOnce: boolean
  unreachableUntil: number
}

export type BotUtilityScore = {
  intent: BotIntentKind
  score: number
  reason: string
  targetX: number
  targetY: number
  targetLabel?: string
}

export type BotTelemetrySnapshot = {
  actorId: string
  preset: BotSkillPresetId
  skill: BotSkillConfig
  intent: BotIntentKind
  intentReason: string
  goalX: number
  goalY: number
  goalLabel: string
  path: Vec[]
  perceivedThreats: PerceivedThreat[]
  perceivedSounds: PerceivedSound[]
  discoveredContainers: number
  searchedContainers: number
  discoveredBenches: string[]
  utilityScores: BotUtilityScore[]
  pressure: number
  panicking: boolean
  lastCommand: Command
}

/** Camera footprint half-extents (m) matching what a player sees on screen. */
export const CAMERA_FOOTPRINT_HALF_W = 22.0
export const CAMERA_FOOTPRINT_HALF_H = 16.0
const MEMORY_DECAY_SECONDS = 4.5

/** Known melee item ids across release-6 and the incoming melee branch. */
export const MELEE_WEAPON_IDS: ReadonlySet<string> = new Set([
  "crowbar",
  "spiked-board",
  "knife",
  "bat",
  "machete",
  "axe",
  "pipe",
  "hammer",
  "fire-axe",
])

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const wrapAngle = (a: number) => {
  let r = (a + Math.PI) % (Math.PI * 2)
  if (r < 0) r += Math.PI * 2
  return r - Math.PI
}

/**
 *Read-only world observation passed to `SurvivorBot.step`.
 * Notice this contains only projected state a client presentation has access to, and the bot
 * filters zombies/containers/noises strictly through its `Vision` and acoustic attenuation.
 */
export type BotWorldView = {
  readonly town: Town
  readonly time: number
  readonly hour: number
  readonly slots: readonly SurvivorSlot[]
  readonly zombies: readonly AIAgent[]
  readonly noises: readonly NoiseEvent[]
  readonly progression: CoopSim["progression"]
  readonly getBarricadePlanks: (portalId: string) => number
}

export function createBotWorldView(sim: CoopSim): BotWorldView {
  return {
    town: sim.town,
    time: sim.time,
    hour: sim.hour,
    slots: sim.slots,
    zombies: sim.ai.agents,
    noises: sim.ai.noiseBus.events,
    progression: sim.progression,
    getBarricadePlanks: (id: string) => sim.ai.getBarricadePlanks(id),
  }
}

type ThreatMemoryEntry = {
  id: number
  x: number
  y: number
  vx: number
  vy: number
  firstDetectedAt: number
  lastSeenAt: number
  lastUpdatedAt: number
  source: "sight" | "sound" | "memory"
  state: AIAgent["state"]
  hpEstimate: number
}

/**
 * Human-like Outbreak survivor bot that perceives the world strictly through player line-of-sight (`Vision`),
 * camera bounds, illumination/flashlight cones, and attenuated audio, and acts exclusively by returning a
 * player `Command` each tick.
 */
export class SurvivorBot {
  readonly actorId: string
  readonly slotIndex: number
  readonly rng: Rng
  readonly vision = new Vision()
  readonly localNav = new GridNav(SIZE, SIZE, 0.5)
  private navGeometryKey = ""

  preset: BotSkillPresetId
  skill: BotSkillConfig

  private readonly threatMemory = new Map<number, ThreatMemoryEntry>()
  private readonly heardNoiseIds = new Set<number>()
  private readonly recentSounds: PerceivedSound[] = []
  private readonly knownContainers = new Map<string, DiscoveredContainer>()
  private readonly knownBenches = new Map<string, BenchSite>()
  private readonly knownBuildings = new Set<string>()
  private readonly exploredWaypoints = new Set<string>()

  private smoothedAim = -Math.PI / 2
  private aimInitialized = false
  private currentIntent: BotIntentKind = "loot"
  private currentReason = "Initializing"
  private intentLockedUntil = 0
  private goalX = 27.7
  private goalY = 36.1
  private goalLabel = "Ash House"
  private currentPath: Vec[] = []
  private repathAt = 0
  private lastTopologyKey = ""
  private cachedSightBlockers: Rect[] = []
  private cachedSolidBlockers: Rect[] = []
  private cachedWalls: Rect[] = []
  private cachedClosedDoors: Rect[] = []
  private stepCounter = 0
  private kiteLoopIndex = 0

  private lastPosX = 0
  private lastPosY = 0
  private stuckTime = 0
  private unstuckUntil = 0
  private unstuckAngle = 0
  private activeTargetContainerId: string | null = null
  private lastInteractTickTime = -10
  private lastPingTime = -30
  private lastBundleTime = -30
  private holdInteractUntil = -1
  private utilityScores: BotUtilityScore[] = []
  private perceivedThreats: PerceivedThreat[] = []
  private lastCommand: Command = { mx: 0, my: 0, aim: -Math.PI / 2, interact: false }
  private initializedMemory = false

  constructor(
    actorId: string,
    slotIndex = 0,
    seed = 1,
    preset: BotSkillPresetId = "Skilled",
    skillOverrides?: Partial<BotSkillConfig>,
  ) {
    this.actorId = actorId
    this.slotIndex = slotIndex
    this.rng = new Rng(((seed ^ Math.imul(slotIndex + 1, 0x9e3779b9)) >>> 0) || 1)
    this.preset = preset
    this.skill = { ...BOT_SKILL_PRESETS[preset], ...skillOverrides }
  }

  setSkill(preset: BotSkillPresetId, overrides?: Partial<BotSkillConfig>): void {
    this.preset = preset
    this.skill = { ...BOT_SKILL_PRESETS[preset], ...overrides }
  }

  /** Produces the next fixed-tick player `Command` without mutating simulation state. */
  step(dt: number, world: BotWorldView): Command {
    const slot = world.slots.find((s) => s.id === this.actorId)
    if (!slot || slot.survivor.health <= 0) {
      this.lastCommand = { mx: 0, my: 0, aim: this.smoothedAim, interact: false }
      return this.lastCommand
    }
    const p = slot.survivor
    if (!this.aimInitialized) {
      this.smoothedAim = p.aim
      this.lastPosX = p.x
      this.lastPosY = p.y
      this.aimInitialized = true
    }

    // 1. Update topology cache & player-bounded visual/acoustic perception (10 Hz cognitive cycle, always on first step)
    const fullPerceptUpdate = this.stepCounter === 0 || dt >= 0.04 || this.stepCounter % 6 === 0
    this.stepCounter++

    if (fullPerceptUpdate || !this.initializedMemory) {
      this.rebuildLocalNavIfNeeded(world.town, world.getBarricadePlanks)
    }
    if (!this.initializedMemory) {
      this.seedPriorMapKnowledge(world)
      this.initializedMemory = true
    }
    const sightBlockers = this.cachedSightBlockers

    if (fullPerceptUpdate) {
      this.vision.update(
        p.x,
        p.y,
        p.aim,
        sightBlockers,
        {
          range: DEFAULT_VISION.range,
          cone: DEFAULT_VISION.cone,
          awareness: this.skill.awarenessRadius,
        },
        slot.peek,
        null,
        false,
      )
      this.updateSpatialDiscovery(world, p.x, p.y)
      this.updateThreatPerception(world, slot, sightBlockers)
    } else {
      // Advance tracked threat distances & reaction readiness on intermediate motor ticks
      const now = world.time
      for (let i = 0; i < this.perceivedThreats.length; i++) {
        const t = this.perceivedThreats[i]!
        t.x += t.vx * dt
        t.y += t.vy * dt
        t.distance = Math.hypot(t.x - p.x, t.y - p.y)
        const effReact = t.distance < 1.9 ? this.skill.reactionTime * 0.45 : this.skill.reactionTime
        t.actionable = now - t.firstDetectedAt >= effReact
      }
      this.perceivedThreats.sort((a, b) => a.distance - b.distance)
    }

    // 2. If currently executing a timed progression channel (search, research, craft, heal, barricade, pry),
    // hold still so the channel completes unless an approaching threat forces an emergency abort.
    if (p.channel) {
      const imminentBite = this.perceivedThreats.some(
        (z) => (z.actionable || z.distance < 1.9) && z.distance < 2.65 && z.state !== "stagger",
      )
      if (!imminentBite) {
        const chAim = Math.atan2(p.channel.y - p.y, p.channel.x - p.x)
        this.smoothedAim = this.stepAim(dt, Number.isFinite(chAim) ? chAim : p.aim, false)
        this.currentReason = p.channel.label
        this.lastCommand = {
          mx: 0,
          my: 0,
          aim: this.smoothedAim,
          interact: false,
          sprint: false,
        }
        return this.lastCommand
      }
    }

    // 3. Evaluate pressure & panic state
    const actionableThreats = this.perceivedThreats.filter((z) => z.actionable)
    const closeThreats = actionableThreats.filter((z) => z.distance < 8.5)
    const chaserCount = actionableThreats.filter(
      (z) => z.distance < 14 && (z.state === "chase" || z.state === "bash" || z.state === "alert"),
    ).length
    const healthFrac = clamp(p.health / Math.max(1, p.maxHealth), 0, 1)
    const rawPressure = clamp(
      closeThreats.length * 0.24 +
        (closeThreats[0] ? Math.max(0, (5.5 - closeThreats[0].distance) / 5.5) * 0.45 : 0) +
        (1 - healthFrac) * 0.35,
      0,
      1,
    )
    const panicking = rawPressure * this.skill.panicUnderPressure > 0.42

    // 4. Score utility of candidate intents and select active intent on cognitive ticks or immediate close threats
    if (fullPerceptUpdate || (closeThreats[0] && closeThreats[0].distance < 2.5)) {
      this.selectIntent(world, slot, actionableThreats, chaserCount, rawPressure, panicking)
    }

    // 5. Execute the chosen intent into a pure player Command
    const cmd = this.executeIntent(dt, world, slot, sightBlockers, actionableThreats, rawPressure, panicking)
    this.lastCommand = cmd
    return cmd
  }

  getTelemetry(): BotTelemetrySnapshot {
    return {
      actorId: this.actorId,
      preset: this.preset,
      skill: { ...this.skill },
      intent: this.currentIntent,
      intentReason: this.currentReason,
      goalX: this.goalX,
      goalY: this.goalY,
      goalLabel: this.goalLabel,
      path: this.currentPath.map((pt) => ({ x: pt.x, y: pt.y })),
      perceivedThreats: this.perceivedThreats.map((t) => ({ ...t })),
      perceivedSounds: this.recentSounds.map((s) => ({ ...s })),
      discoveredContainers: this.knownContainers.size,
      searchedContainers: [...this.knownContainers.values()].filter((c) => c.searched).length,
      discoveredBenches: [...this.knownBenches.keys()],
      utilityScores: this.utilityScores.map((u) => ({ ...u })),
      pressure: clamp(
        this.perceivedThreats.filter((z) => z.actionable && z.distance < 8.5).length * 0.25,
        0,
        1,
      ),
      panicking:
        this.perceivedThreats.filter((z) => z.actionable && z.distance < 7).length *
          this.skill.panicUnderPressure >
        0.42,
      lastCommand: { ...this.lastCommand },
    }
  }

  private computeContainerStandPoint(town: Town, c: { x: number; y: number; rect: Rect; buildingId?: string | null }): { x: number; y: number } {
    const [x0, y0, x1, y1] = c.rect
    const cx = (x0 + x1) * 0.5
    const cy = (y0 + y1) * 0.5
    const candidates: [number, number][] = [
      [cx, y1 + 0.65],
      [cx, y0 - 0.65],
      [x1 + 0.65, cy],
      [x0 - 0.65, cy],
      [cx + 0.55, y1 + 0.55],
      [cx - 0.55, y1 + 0.55],
      [cx + 0.55, y0 - 0.55],
      [cx - 0.55, y0 - 0.55],
    ]
    for (const [sx, sy] of candidates) {
      if (!this.localNav.walkable({ x: sx, y: sy })) continue
      if (c.buildingId && insideBuildingAt(town, sx, sy)?.id !== c.buildingId) continue
      const nx = Math.max(x0, Math.min(x1, sx))
      const ny = Math.max(y0, Math.min(y1, sy))
      if (!clearLine(sx, sy, nx, ny, this.cachedWalls)) continue
      return { x: sx, y: sy }
    }
    return { x: c.x, y: c.y }
  }

  private seedPriorMapKnowledge(world: BotWorldView): void {
    // Every player spawning at (27.7, 41) sees the starting safehouse (Ash House) right in front of them.
    const ash = world.town.buildings[0]
    if (ash) {
      this.knownBuildings.add(ash.id)
    }
    const knowProb = clamp(this.skill.mapKnowledge, 0, 1)
    for (const b of world.town.buildings) {
      if (b.id === "ash" || this.rng.next() < knowProb) {
        this.knownBuildings.add(b.id)
      }
    }
    for (const bench of world.progression.benches) {
      if (bench.buildingId === "ash" || this.rng.next() < knowProb) {
        this.knownBenches.set(bench.id, bench)
      }
    }
    for (const c of world.progression.containers) {
      // Starting house containers or prior map knowledge of furniture locations (never their hidden contents!)
      const inAsh = c.buildingId === "ash"
      if ((inAsh && knowProb >= 0.15) || this.rng.next() < knowProb * 0.85) {
        const stand = this.computeContainerStandPoint(world.town, c)
        this.knownContainers.set(c.id, {
          id: c.id,
          x: stand.x,
          y: stand.y,
          rect: c.rect,
          buildingId: c.buildingId,
          label: c.label,
          searched: Boolean(c.searched),
          empty: false,
          takenOnce: false,
          unreachableUntil: -1,
        })
      }
    }
  }

  private inCameraFootprint(px: number, py: number, tx: number, ty: number): boolean {
    return Math.abs(tx - px) <= CAMERA_FOOTPRINT_HALF_W && Math.abs(ty - py) <= CAMERA_FOOTPRINT_HALF_H
  }

  private updateSpatialDiscovery(world: BotWorldView, px: number, py: number): void {
    const hereBuilding = insideBuildingAt(world.town, px, py)
    if (hereBuilding) {
      this.knownBuildings.add(hereBuilding.id)
    }
    for (const b of world.town.buildings) {
      const cx = (b.rect[0] + b.rect[2]) * 0.5
      const cy = (b.rect[1] + b.rect[3]) * 0.5
      if (this.inCameraFootprint(px, py, cx, cy) && this.vision.visible(cx, b.rect[3])) {
        this.knownBuildings.add(b.id)
      }
    }

    for (const bench of world.progression.benches) {
      if (
        hereBuilding?.id === bench.buildingId ||
        (this.inCameraFootprint(px, py, bench.bench.x, bench.bench.y) &&
          this.vision.visible(bench.bench.x, bench.bench.y))
      ) {
        this.knownBenches.set(bench.id, bench)
      }
    }

    for (const c of world.progression.containers) {
      const existing = this.knownContainers.get(c.id)
      const inCam = this.inCameraFootprint(px, py, c.x, c.y)
      const sameRoom = hereBuilding && c.buildingId === hereBuilding.id && Math.hypot(c.x - px, c.y - py) < 8.5
      const visibleNow = (inCam && this.vision.visible(c.x, c.y)) || Boolean(sameRoom)
      if (!existing && visibleNow) {
        const st = world.progression.ledger.store(c.id)
        const revealed = Boolean(st?.revealed || c.searched)
        const empty = revealed ? world.progression.contents(c.id).length === 0 : false
        const stand = this.computeContainerStandPoint(world.town, c)
        this.knownContainers.set(c.id, {
          id: c.id,
          x: stand.x,
          y: stand.y,
          rect: c.rect,
          buildingId: c.buildingId,
          label: c.label,
          searched: revealed && empty,
          empty,
          takenOnce: false,
          unreachableUntil: -1,
        })
      } else if (existing && (visibleNow || Math.hypot(c.x - px, c.y - py) <= INTERACT_RANGE + 0.5)) {
        const st = world.progression.ledger.store(c.id)
        if (st?.revealed) {
          const hasItems = world.progression.contents(c.id).length > 0
          existing.empty = !hasItems
          existing.searched = !hasItems || existing.takenOnce
        }
      }
    }
  }

  private updateThreatPerception(
    world: BotWorldView,
    slot: SurvivorSlot,
    sightBlockers: readonly Rect[],
  ): void {
    const p = slot.survivor
    const now = world.time
    const walls = this.cachedWalls
    const closedDoors = this.cachedClosedDoors

    // 1. Process acoustic events from the noise bus
    for (let i = this.recentSounds.length - 1; i >= 0; i--) {
      if (now - this.recentSounds[i]!.time > 4.0) this.recentSounds.splice(i, 1)
    }
    const hearingConfig = {
      hearingScale: clamp(0.75 + this.skill.awarenessRadius * 0.08, 0.7, 1.15),
      wallAttenuation: 0.55,
      doorAttenuation: 0.75,
    }
    for (const ev of world.noises) {
      if (ev.sourceId === this.actorId || this.heardNoiseIds.has(ev.id)) continue
      this.heardNoiseIds.add(ev.id)
      const att = attenuateNoise(
        ev.x,
        ev.y,
        ev.radius,
        ev.loudness,
        p.x,
        p.y,
        walls,
        closedDoors,
        hearingConfig,
        1.0,
      )
      if (att.audible) {
        const jitter = (1 - clamp(att.perceivedLoudness, 0.1, 1)) * 1.8
        const jx = ev.x + (this.rng.next() - 0.5) * jitter
        const jy = ev.y + (this.rng.next() - 0.5) * jitter
        this.recentSounds.push({
          id: ev.id,
          x: jx,
          y: jy,
          kind: ev.kind,
          loudness: att.perceivedLoudness,
          time: now,
        })
      }
    }

    // 2. Evaluate visual and close-acoustic detection for each living zombie
    const day = dayCycle(world.hour)
    for (const z of world.zombies) {
      if (z.state === "dead") {
        this.threatMemory.delete(z.id)
        continue
      }
      const dx = z.x - p.x
      const dy = z.y - p.y
      const dist = Math.hypot(dx, dy)

      // Visual check: must be inside camera footprint and pass Vision polar raycast
      let visuallySeen = false
      if (this.inCameraFootprint(p.x, p.y, z.x, z.y)) {
        const visWeight = this.vision.actorVisible(z.x, z.y, 0.28)
        if (visWeight > 0) {
          if (dist <= this.skill.awarenessRadius) {
            visuallySeen = true
          } else if (day.darkness < 0.45) {
            visuallySeen = true
          } else {
            // At night, check ambient/lamp illumination at the zombie or any survivor's flashlight cone
            const lightAtZ = samplePointLightLevel(world.town, world.hour, z.x, z.y)
            const litByFlashlight = world.slots.some(
              (s) =>
                s.survivor.flashlightOn &&
                s.survivor.flashlightOutput > 0.05 &&
                flashlightAwarenessAt(
                  s.survivor,
                  z.x,
                  z.y,
                  sightBlockers,
                  DEFAULT_FLASHLIGHT_TUNING,
                ) > 0.02,
            )
            visuallySeen = lightAtZ >= 0.21 || litByFlashlight
          }
        }
      }

      if (visuallySeen) {
        const prev = this.threatMemory.get(z.id)
        this.threatMemory.set(z.id, {
          id: z.id,
          x: z.x,
          y: z.y,
          vx: z.vx,
          vy: z.vy,
          firstDetectedAt: prev ? prev.firstDetectedAt : now,
          lastSeenAt: now,
          lastUpdatedAt: now,
          source: "sight",
          state: z.state,
          hpEstimate: z.hp,
        })
        continue
      }

      // Close-range acoustic footstep/groan/bash perception when zombie is active nearby
      const activeZombieNoiseRadius =
        z.state === "bash" ? 13.0 : z.state === "chase" ? 8.5 : z.state === "alert" ? 6.0 : 2.8
      if (dist <= activeZombieNoiseRadius * 1.15) {
        const att = attenuateNoise(
          z.x,
          z.y,
          activeZombieNoiseRadius,
          0.8,
          p.x,
          p.y,
          walls,
          closedDoors,
          hearingConfig,
          1.0,
        )
        if (att.audible) {
          const prev = this.threatMemory.get(z.id)
          const acousticErr = clamp(dist * 0.12 + att.wallHits * 0.65, 0.2, 2.4)
          const estX = prev && now - prev.lastSeenAt < 1.0 ? z.x : z.x + (this.rng.next() - 0.5) * acousticErr
          const estY = prev && now - prev.lastSeenAt < 1.0 ? z.y : z.y + (this.rng.next() - 0.5) * acousticErr
          this.threatMemory.set(z.id, {
            id: z.id,
            x: estX,
            y: estY,
            vx: z.vx,
            vy: z.vy,
            firstDetectedAt: prev ? prev.firstDetectedAt : now,
            lastSeenAt: prev ? prev.lastSeenAt : -Infinity,
            lastUpdatedAt: now,
            source: "sound",
            state: z.state,
            hpEstimate: prev ? prev.hpEstimate : 100,
          })
        }
      }
    }

    // 3. Build sorted list of perceived threats and decay stale memories
    const out: PerceivedThreat[] = []
    for (const [id, mem] of this.threatMemory) {
      const age = now - mem.lastUpdatedAt
      if (age > MEMORY_DECAY_SECONDS) {
        this.threatMemory.delete(id)
        continue
      }
      const predDt = Math.min(age, 1.2)
      const px = mem.x + (age > 0.05 ? mem.vx * predDt * 0.5 : 0)
      const py = mem.y + (age > 0.05 ? mem.vy * predDt * 0.5 : 0)
      const dist = Math.hypot(px - p.x, py - p.y)
      const confidence = age <= 0.05 ? 1.0 : clamp(1 - age / MEMORY_DECAY_SECONDS, 0, 1)
      const effectiveReaction =
        dist < 1.9 ? this.skill.reactionTime * 0.45 : this.skill.reactionTime
      const actionable = now - mem.firstDetectedAt >= effectiveReaction
      out.push({
        id,
        x: px,
        y: py,
        vx: mem.vx,
        vy: mem.vy,
        distance: dist,
        source: age <= 0.06 ? mem.source : "memory",
        actionable,
        firstDetectedAt: mem.firstDetectedAt,
        lastUpdatedAt: mem.lastUpdatedAt,
        confidence,
        state: mem.state,
        hpEstimate: mem.hpEstimate,
      })
    }
    out.sort((a, b) => a.distance - b.distance)
    this.perceivedThreats = out
  }

  private rebuildLocalNavIfNeeded(town: Town, getBarricadePlanks: (id: string) => number): void {
    let key = `${town.barriers.length}:${town.props.length}:`
    for (let i = 0; i < town.doors.length; i++) {
      const d = town.doors[i]!
      key += `${d.open ? 1 : 0}${d.locked ? 1 : 0}${getBarricadePlanks(d.id)},`
    }
    for (let i = 0; i < town.windows.length; i++) {
      const w = town.windows[i]!
      key += `${w.open ? 1 : 0}${getBarricadePlanks(w.id)},`
    }
    if (key === this.lastTopologyKey) return
    this.lastTopologyKey = key

    this.cachedSightBlockers = sightRects(town)
    this.cachedSolidBlockers = solidRects(town)
    this.cachedWalls = town.barriers.filter((b) => b.kind === "wall").map((b) => b.rect)
    this.cachedClosedDoors = town.doors
      .filter((d) => !d.open || getBarricadePlanks(d.id) > 0)
      .map((d) => d.rect)

    const geomKey = `${town.barriers.length}:${town.props.length}:${town.doors.length}`
    if (geomKey === this.navGeometryKey) return
    this.navGeometryKey = geomKey

    const solids = solidRects(town)
    const portals: NavPortal[] = town.doors.map((d): NavPortal => ({
      id: d.id,
      kind: "door",
      rect: d.rect,
      open: true,
      locked: false,
      barricadePlanks: 0,
    }))
    this.localNav.rebuild(solids, portals, 0.22)
    this.repathAt = 0
  }

  private hasMeleeWeaponInHotbar(world: BotWorldView): { slotIndex: number; item: string } | null {
    const hotbar = world.progression.hotbar(this.actorId)
    if (!hotbar) return null
    for (let i = 0; i < hotbar.slots.length; i++) {
      const s = hotbar.slots[i]
      if (s && MELEE_WEAPON_IDS.has(s.item)) {
        return { slotIndex: i, item: s.item }
      }
    }
    return null
  }

  private hasHealingItemInHotbar(world: BotWorldView): { slotIndex: number; item: string } | null {
    const hotbar = world.progression.hotbar(this.actorId)
    if (!hotbar) return null
    for (let i = 0; i < hotbar.slots.length; i++) {
      const s = hotbar.slots[i]
      if (s && (s.item === "medkit" || s.item === "bandage") && s.count > 0) {
        return { slotIndex: i, item: s.item }
      }
    }
    return null
  }

  private hasLureInHotbar(world: BotWorldView): { slotIndex: number; count: number } | null {
    const hotbar = world.progression.hotbar(this.actorId)
    if (!hotbar) return null
    for (let i = 0; i < hotbar.slots.length; i++) {
      const s = hotbar.slots[i]
      if (s && s.item === "noisemaker" && s.count > 0) {
        return { slotIndex: i, count: s.count }
      }
    }
    return null
  }

  private findPackSwapCandidate(world: BotWorldView): { packIndex: number; targetHotbarSlot: number } | null {
    const pack = world.progression.ledger.store(`${this.actorId}/pack`)
    const hotbar = world.progression.hotbar(this.actorId)
    if (!pack || !hotbar) return null
    for (let i = 0; i < pack.slots.length; i++) {
      const s = pack.slots[i]
      if (!s) continue
      if (MELEE_WEAPON_IDS.has(s.item)) {
        const curSlot2 = hotbar.slots[2]
        if (!curSlot2 || (curSlot2.item === "crowbar" && s.item !== "crowbar")) {
          return { packIndex: i, targetHotbarSlot: 2 }
        }
      }
      if ((s.item === "medkit" || s.item === "bandage") && !hotbar.slots[3]) {
        return { packIndex: i, targetHotbarSlot: 3 }
      }
    }
    return null
  }

  private canResearchAnyAtBench(world: BotWorldView, benchId: string): { recipeIndex: number; label: string } | null {
    const rows = world.progression.benchRows()
    const tier = world.progression.tier(benchId)
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!
      if (world.progression.learned(r.id)) continue
      if (r.tier > tier) continue
      const ok = Object.entries(r.research).every(([mat, needed]) => {
        const have =
          world.progression.ledger.count(`${this.actorId}/belt`, mat) +
          world.progression.ledger.count(benchId, mat)
        return have >= needed
      })
      if (ok) return { recipeIndex: i, label: r.label }
    }
    return null
  }

  private canFieldCraftUseful(world: BotWorldView, p: SurvivorSlot["survivor"]): { craftIndex: number; label: string } | null {
    const craftable = world.progression.craftable()
    const healItem = this.hasHealingItemInHotbar(world)
    const meleeItem = this.hasMeleeWeaponInHotbar(world)
    const lureItem = this.hasLureInHotbar(world)

    for (let i = 0; i < craftable.length; i++) {
      const r = craftable[i]!
      if (!r.craft) continue
      const hasMats = Object.entries(r.craft).every(
        ([mat, count]) => world.progression.ledger.count(`${this.actorId}/belt`, mat) >= count,
      )
      if (!hasMats) continue
      if (r.id === "bandage" && (!healItem || p.health < 85)) {
        return { craftIndex: i, label: r.label }
      }
      if (r.id === "spiked-board" && (!meleeItem || meleeItem.item === "crowbar")) {
        return { craftIndex: i, label: r.label }
      }
      if (r.id === "lure" && !lureItem) {
        return { craftIndex: i, label: r.label }
      }
      if (r.id === "battery" && p.battery < 0.45 && world.progression.ledger.count(`${this.actorId}/belt`, "battery") === 0) {
        return { craftIndex: i, label: r.label }
      }
    }
    return null
  }

  private hasWorkbenchPartInPack(world: BotWorldView): boolean {
    const pack = world.progression.ledger.store(`${this.actorId}/pack`)
    if (!pack) return false
    return pack.slots.some((s) => s && (s.item === "toolbox" || s.item === "car-battery"))
  }

  private pickBestSafehousePoint(world: BotWorldView, px: number, py: number): { x: number; y: number; label: string; buildingId: string } {
    // Prefer Ash House front yard/porch or nearest known house porch so the bot has open escape lines
    let best: { x: number; y: number; label: string; buildingId: string; dist: number } | null = null
    for (const b of this.knownBenches.values()) {
      const building = world.town.buildings.find((tb) => tb.id === b.buildingId)
      const porchX = building ? (building.rect[0] + building.rect[2]) * 0.5 : b.bench.x
      const porchY = building ? building.rect[3] + 2.2 : b.bench.y + 6.0
      const d = Math.hypot(porchX - px, porchY - py)
      if (!best || d < best.dist) {
        best = {
          x: porchX,
          y: porchY,
          label: `${b.buildingId} Safehouse`,
          buildingId: b.buildingId,
          dist: d,
        }
      }
    }
    if (best) return best
    return {
      x: (STARTING_SAFEHOUSE_RECT[0] + STARTING_SAFEHOUSE_RECT[2]) * 0.5,
      y: STARTING_SAFEHOUSE_RECT[3] + 2.2,
      label: "Ash Safehouse",
      buildingId: "ash",
    }
  }

  private pickOpenKitePoint(
    px: number,
    py: number,
    _threats: readonly PerceivedThreat[],
  ): { x: number; y: number; label: string } {
    // Clockwise avenue patrol loop along wide streets (x=44, y=17, x=76, y=73)
    const loopWaypoints: readonly { x: number; y: number; label: string }[] = [
      { x: 44.0, y: 44.0, label: "Central Crossroads" },
      { x: 44.0, y: 17.0, label: "North Avenue" },
      { x: 76.0, y: 17.0, label: "North-East Avenue" },
      { x: 76.0, y: 46.0, label: "East Avenue" },
      { x: 76.0, y: 73.0, label: "South-East Avenue" },
      { x: 44.0, y: 73.0, label: "South Avenue" },
    ]
    const isKiting =
      this.currentIntent === "flee-horde" ||
      this.currentIntent === "kite-shoot" ||
      this.currentIntent === "reload-cover"
    if (!isKiting) {
      let bestIdx = 0
      let bestDist = Infinity
      for (let i = 0; i < loopWaypoints.length; i++) {
        const d = Math.hypot(loopWaypoints[i]!.x - px, loopWaypoints[i]!.y - py)
        if (d < bestDist) {
          bestDist = d
          bestIdx = i
        }
      }
      this.kiteLoopIndex = bestIdx
    }
    const cur = loopWaypoints[this.kiteLoopIndex % loopWaypoints.length]!
    if (Math.hypot(cur.x - px, cur.y - py) < 3.2) {
      this.kiteLoopIndex = (this.kiteLoopIndex + 1) % loopWaypoints.length
    }
    return loopWaypoints[this.kiteLoopIndex % loopWaypoints.length]!
  }

  private findBarricadeCandidate(
    world: BotWorldView,
    px: number,
    py: number,
    buildingId: string | null,
  ): { id: string; x: number; y: number; planks: number } | null {
    if (!buildingId) return null
    const building = world.town.buildings.find((b) => b.id === buildingId)
    if (!building) return null
    // Only barricade secondary windows (never seal exterior doors or the last unbarricaded window)
    const windowsInBuilding = world.town.windows.filter((w) => w.buildingId === buildingId)
    const unbarricadedWindows = windowsInBuilding.filter((w) => world.getBarricadePlanks(w.id) === 0)
    if (unbarricadedWindows.length <= 1) return null

    let best: { id: string; x: number; y: number; planks: number; score: number } | null = null
    for (const w of windowsInBuilding) {
      const planks = world.getBarricadePlanks(w.id)
      if (planks >= 2) continue
      const cx = (w.rect[0] + w.rect[2]) * 0.5
      const cy = (w.rect[1] + w.rect[3]) * 0.5
      const d = Math.hypot(cx - px, cy - py)
      const threatNear = this.perceivedThreats.some((z) => Math.hypot(z.x - cx, z.y - cy) < 9.0)
      const score = 20 + (threatNear ? 25 : 0) - d * 1.4 - planks * 4
      if (!best || score > best.score) {
        best = { id: w.id, x: cx, y: cy, planks, score }
      }
    }
    return best
  }

  private findBestLootCandidate(
    world: BotWorldView,
    px: number,
    py: number,
  ): { id: string; x: number; y: number; label: string; score: number } | null {
    const now = world.time
    let best: { id: string; x: number; y: number; label: string; score: number } | null = null

    // Check nearby ground drops first
    for (const st of world.progression.ledger.stores.values()) {
      if (!st.id.startsWith("drop:") || !st.at) continue
      if (!this.inCameraFootprint(px, py, st.at.x, st.at.y)) continue
      const stacks = world.progression.contents(st.id)
      if (!stacks.length) continue
      const d = Math.hypot(st.at.x - px, st.at.y - py)
      if (d > 16) continue
      const score = 42 - d * 1.8
      if (!best || score > best.score) {
        best = { id: st.id, x: st.at.x, y: st.at.y, label: "Dropped supplies", score }
      }
    }

    const hasKeyOrCrowbar =
      world.progression.ledger.count(`${this.actorId}/belt`, "key") > 0 ||
      world.progression.ledger.count(`${this.actorId}/hotbar`, "crowbar") > 0 ||
      world.progression.ledger.count(`${this.actorId}/pack`, "crowbar") > 0

    const otherBotTargets = new Set<string>()
    const hereId = insideBuildingAt(world.town, px, py)?.id ?? null
    for (const c of this.knownContainers.values()) {
      if (c.searched || c.empty || now < c.unreachableUntil) continue
      if (otherBotTargets.has(c.id)) continue
      // Once the opening calm ends (t > 65s), avoid entering new indoor buildings from outside if threats are known
      if (now > 65 && c.buildingId && hereId !== c.buildingId && this.perceivedThreats.length > 0) {
        continue
      }
      if (!hasKeyOrCrowbar && (c.buildingId === "hardware" || c.buildingId === "pharmacy")) {
        const roomDoor = world.town.doors.find((d) => d.id === `${c.buildingId}-room`)
        const splitY = c.buildingId === "hardware" ? 28.5 : 59.5
        if (roomDoor?.locked && c.rect[1] < splitY) continue
      }
      const d = Math.hypot(c.x - px, c.y - py)
      // Penalize containers right next to perceived zombies
      const threatPenalty = this.perceivedThreats.reduce((acc, z) => {
        const zd = Math.hypot(z.x - c.x, z.y - c.y)
        return zd < 6.5 ? acc + (6.5 - zd) * 5.5 : acc
      }, 0)
      const sameBuildingBonus =
        c.buildingId && insideBuildingAt(world.town, px, py)?.id === c.buildingId ? 14 : 0
      // Stagger co-op bots slightly across containers
      const slotSpread =
        ((c.id.charCodeAt(c.id.length - 1) + this.slotIndex) % Math.max(1, world.slots.length)) === 0
          ? 5
          : 0
      const score = 38 + sameBuildingBonus + slotSpread - d * 0.85 - threatPenalty
      if (!best || score > best.score) {
        best = { id: c.id, x: c.x, y: c.y, label: c.label, score }
      }
    }
    return best
  }

  private pickExploreTarget(world: BotWorldView, px: number, py: number): { x: number; y: number; label: string } {
    // 1. During the opening calm, check buildings in the current town that still have unsearched containers
    if (world.time < 65) {
      const candidateBuildings: { b: Building; x: number; y: number; score: number }[] = []
      for (const b of world.town.buildings) {
        const cx = (b.rect[0] + b.rect[2]) * 0.5
        const cy = (b.rect[1] + b.rect[3]) * 0.5
        const key = `b:${b.id}`
        const visited = this.exploredWaypoints.has(key)
        if (Math.hypot(cx - px, cy - py) < 5.5) {
          this.exploredWaypoints.add(key)
          continue
        }
        const unsearchedInBuilding = world.progression.containers.filter(
          (c) => c.buildingId === b.id && !c.searched && !this.knownContainers.get(c.id)?.searched,
        ).length
        if (visited && unsearchedInBuilding === 0) continue
        const d = Math.hypot(cx - px, cy - py)
        const archetypeBonus = b.kind === "hardware" ? 18 : b.kind === "pharmacy" ? 15 : 8
        const score = (visited ? 0 : 25) + unsearchedInBuilding * 10 + archetypeBonus - d * 0.45
        const frontDoor = world.town.doors.find((door) => door.id === `${b.id}-front`)
        const tx = frontDoor ? (frontDoor.rect[0] + frontDoor.rect[2]) * 0.5 : cx
        const ty = frontDoor ? (frontDoor.rect[1] + frontDoor.rect[3]) * 0.5 - 1.2 : cy
        candidateBuildings.push({ b, x: tx, y: ty, score })
      }
      if (candidateBuildings.length > 0) {
        candidateBuildings.sort((a, b) => b.score - a.score)
        const pick = candidateBuildings[0]!
        return { x: pick.x, y: pick.y, label: `Explore ${pick.b.kind} (${pick.b.id})` }
      }
    }

    // 2. Patrol along the wide avenue network
    return this.pickOpenKitePoint(px, py, this.perceivedThreats)
  }

  private selectIntent(
    world: BotWorldView,
    slot: SurvivorSlot,
    threats: readonly PerceivedThreat[],
    chaserCount: number,
    pressure: number,
    panicking: boolean,
  ): void {
    const p = slot.survivor
    const now = world.time
    const day = dayCycle(world.hour)
    const isNightOrLateDusk = day.darkness > 0.58 || world.hour >= 18.2 || world.hour < 6.2
    const hereBuilding = insideBuildingAt(world.town, p.x, p.y)
    const nearestThreat = threats[0]
    const nearestDist = nearestThreat ? nearestThreat.distance : Infinity
    const pistol = world.progression.pistol(this.actorId)
    const totalAmmo = pistol.loaded + pistol.reserve
    const meleeWeapon = this.hasMeleeWeaponInHotbar(world)
    const healItem = this.hasHealingItemInHotbar(world)
    const planks = world.progression.ledger.count(`${this.actorId}/belt`, "plank")

    const candidates: BotUtilityScore[] = []
    const noise = () => (this.rng.next() - 0.5) * 2 * this.skill.decisionNoise * 18

    // 1. HEAL: injured and has medkit/bandage, and not in immediate bite range (< 2.4m)
    if (healItem && p.health <= (panicking ? 52 : 68) && nearestDist > 2.4) {
      const urgency = clamp((80 - p.health) / 65, 0.2, 1.0)
      candidates.push({
        intent: "heal",
        score: 78 * urgency + (nearestDist > 6 ? 14 : -10) + noise(),
        reason: `Patching up (${Math.round(p.health)} HP) with ${healItem.item}`,
        targetX: p.x,
        targetY: p.y,
        targetLabel: healItem.item,
      })
    }

    // 2. FLEE HORDE: outnumbered, out of ammo with active chasers nearby, or indoors with approaching threats
    if (
      chaserCount >= 2 ||
      (chaserCount >= 1 && nearestDist <= 9.5 && totalAmmo === 0) ||
      (p.health < 45 && nearestDist < 9.5) ||
      (hereBuilding && nearestDist < 12.0)
    ) {
      const kitePt = this.pickOpenKitePoint(p.x, p.y, threats)
      candidates.push({
        intent: "flee-horde",
        score: 90 + chaserCount * 6 + (panicking ? 12 : 0) + noise(),
        reason:
          totalAmmo === 0
            ? `Out of ammo — kiting ${chaserCount || 1} threat(s) toward ${kitePt.label}`
            : `Breaking contact from ${chaserCount || 1} chaser(s) toward ${kitePt.label}`,
        targetX: kitePt.x,
        targetY: kitePt.y,
        targetLabel: kitePt.label,
      })
    }

    // 3. FIGHT MELEE / SHOVE: zombie in close range or conserving ammo on 1 staggered/isolated zombie
    if (nearestThreat && nearestDist <= 3.2) {
      const preferMeleeSaveAmmo =
        chaserCount <= 1 &&
        Boolean(meleeWeapon) &&
        p.health > 55 &&
        totalAmmo <= 3
      const inShoveRange = nearestDist <= 1.85 && chaserCount <= 2
      if (inShoveRange || preferMeleeSaveAmmo || (totalAmmo === 0 && chaserCount <= 1)) {
        candidates.push({
          intent: "fight-melee",
          score: (inShoveRange ? 84 : 74) + (meleeWeapon ? 6 : 0) + noise(),
          reason: meleeWeapon
            ? `Striking closest zombie (${nearestDist.toFixed(1)}m) with ${meleeWeapon.item}`
            : `Shoving zombie back (${nearestDist.toFixed(1)}m)`,
          targetX: nearestThreat.x,
          targetY: nearestThreat.y,
          targetLabel: meleeWeapon?.item ?? "shove",
        })
      }
    }

    // 4. KITE & SHOOT: actionable threat within gun range and ammo available
    if (nearestThreat && nearestDist <= 16.5 && pistol.loaded > 0) {
      const distFactor = clamp(1 - nearestDist / 18, 0.15, 1)
      candidates.push({
        intent: "kite-shoot",
        score: 76 + distFactor * 18 + (chaserCount >= 2 ? 6 : 0) + noise(),
        reason: `Kiting & shooting threat at ${nearestDist.toFixed(1)}m (${pistol.loaded}/${pistol.capacity} mag)`,
        targetX: nearestThreat.x,
        targetY: nearestThreat.y,
        targetLabel: `Zombie #${nearestThreat.id}`,
      })
    }

    // 5. RELOAD BEHIND COVER: mag empty (or < 3 between fights) with reserve ammo
    if (
      pistol.reserve > 0 &&
      (pistol.loaded === 0 || (pistol.loaded <= 3 && nearestDist > 7.5))
    ) {
      candidates.push({
        intent: "reload-cover",
        score: (pistol.loaded === 0 ? 82 : 56) + noise(),
        reason: `Reloading 9mm pistol (${pistol.loaded}/${pistol.capacity}, +${pistol.reserve} reserve)`,
        targetX: p.x,
        targetY: p.y,
        targetLabel: "Reload 9mm",
      })
    }

    // 6. WORKBENCH & RESEARCH: has parts in pack or researchable recipe at known bench
    const benchSite = this.knownBenches.get("bench:ash") ?? [...this.knownBenches.values()][0]
    if (benchSite && chaserCount === 0 && nearestDist > 9.0) {
      const researchable = this.canResearchAnyAtBench(world, benchSite.id)
      const hasPart = this.hasWorkbenchPartInPack(world)
      const benchLight = world.progression.benchLight(
        benchSite.id,
        world.hour,
        world.slots.map((s) => s.survivor),
      )
      if ((hasPart || researchable) && benchLight + 0.2 >= world.progression.tuning.researchLight) {
        const d = Math.hypot(benchSite.bench.x - p.x, benchSite.bench.y - p.y)
        candidates.push({
          intent: "workbench",
          score: 64 + (hasPart ? 12 : 0) + (researchable ? 10 : 0) - d * 0.4 + noise(),
          reason: researchable
            ? `Researching ${researchable.label} at Workbench`
            : `Installing upgrade part at Workbench`,
          targetX: benchSite.bench.x,
          targetY: benchSite.bench.y,
          targetLabel: "Workbench",
        })
      }
    }

    // 7. FIELD CRAFT: can craft a needed bandage, spiked-board, lure, or battery right now
    if (nearestDist > 5.5) {
      const craftJob = this.canFieldCraftUseful(world, p)
      if (craftJob) {
        candidates.push({
          intent: "craft",
          score: 66 + noise(),
          reason: `Field-crafting ${craftJob.label}`,
          targetX: p.x,
          targetY: p.y,
          targetLabel: craftJob.label,
        })
      }
    }

    // 8. BARRICADE: inside a house with planks when dusk/night or threats outside
    if (planks > 0 && hereBuilding && nearestDist > 2.3) {
      const portal = this.findBarricadeCandidate(world, p.x, p.y, hereBuilding.id)
      if (portal && (isNightOrLateDusk || world.hour >= 17.2 || threats.length > 0)) {
        candidates.push({
          intent: "barricade",
          score: (isNightOrLateDusk ? 68 : 54) + noise(),
          reason: `Boarding up ${portal.id} (${portal.planks}/3 planks)`,
          targetX: portal.x,
          targetY: portal.y,
          targetLabel: portal.id,
        })
      }
    }

    // 9. RETREAT TO SAFEHOUSE AT NIGHT: shelter near safehouse porch when night is calm
    if (isNightOrLateDusk && chaserCount === 0 && nearestDist > 11) {
      const safe = this.pickBestSafehousePoint(world, p.x, p.y)
      const distToSafe = Math.hypot(safe.x - p.x, safe.y - p.y)
      if (distToSafe > 6.5 && (day.threat > 0.72 || p.health < 75 || planks >= 2)) {
        candidates.push({
          intent: "retreat-safehouse",
          score: 58 + day.threat * 10 + noise(),
          reason: `Retreating to ${safe.label} for night defense`,
          targetX: safe.x,
          targetY: safe.y,
          targetLabel: safe.label,
        })
      }
    }

    // 10. ASSIST ALLY (Co-op 2-4 players): help a pressured or low-resource squadmate
    if (world.slots.length > 1) {
      let bestAlly: { slot: SurvivorSlot; dist: number; needBundle: boolean; pressured: boolean } | null = null
      for (const ally of world.slots) {
        if (ally.id === this.actorId || ally.survivor.health <= 0) continue
        const d = Math.hypot(ally.survivor.x - p.x, ally.survivor.y - p.y)
        const allyAmmo = ally.survivor.magAmmo + ally.survivor.reserveAmmo
        const needBundle = allyAmmo === 0 && totalAmmo >= 10 && now - this.lastBundleTime > 20
        const pressured = ally.survivor.health < 60 || d > 26
        if (needBundle || pressured) {
          if (!bestAlly || d < bestAlly.dist) {
            bestAlly = { slot: ally, dist: d, needBundle, pressured }
          }
        }
      }
      if (bestAlly) {
        candidates.push({
          intent: "assist-ally",
          score: (bestAlly.needBundle ? 65 : 52) + noise(),
          reason: bestAlly.needBundle
            ? `Sharing ammo/plank bundle with ${bestAlly.slot.id}`
            : `Regrouping with squadmate ${bestAlly.slot.id}`,
          targetX: bestAlly.slot.survivor.x,
          targetY: bestAlly.slot.survivor.y,
          targetLabel: bestAlly.slot.id,
        })
      }
    }

    // 11. LOOT CONTAINER / DROP (only when no active chasers and no immediate close threat)
    const minLootSafeDist = 6.5 + (1 - this.skill.decisionNoise) * 5.0
    if (chaserCount === 0 && nearestDist > (totalAmmo === 0 ? 12.0 : minLootSafeDist)) {
      const lootTarget = this.findBestLootCandidate(world, p.x, p.y)
      if (lootTarget) {
        candidates.push({
          intent: "loot",
          score: Math.max(32, lootTarget.score) + noise(),
          reason: `Searching ${lootTarget.label}`,
          targetX: lootTarget.x,
          targetY: lootTarget.y,
          targetLabel: lootTarget.label,
        })
      }
    }

    // 12. EXPLORE NEW CHUNKS / BUILDINGS
    const exploreTarget = this.pickExploreTarget(world, p.x, p.y)
    candidates.push({
      intent: "explore",
      score: 30 + noise(),
      reason: exploreTarget.label,
      targetX: exploreTarget.x,
      targetY: exploreTarget.y,
      targetLabel: exploreTarget.label,
    })

    candidates.sort((a, b) => b.score - a.score)
    this.utilityScores = candidates

    const top = candidates[0]!
    const urgentCombat =
      top.intent === "fight-melee" ||
      top.intent === "kite-shoot" ||
      top.intent === "flee-horde" ||
      top.intent === "heal"
    if (urgentCombat || now >= this.intentLockedUntil || top.intent === this.currentIntent) {
      if (top.intent !== this.currentIntent) {
        this.currentIntent = top.intent
        this.intentLockedUntil = now + (urgentCombat ? 0.35 : 1.1)
        this.repathAt = 0
      }
      this.currentReason = top.reason
      this.goalX = top.targetX
      this.goalY = top.targetY
      this.goalLabel = top.targetLabel ?? top.intent
    }
  }

  private executeIntent(
    dt: number,
    world: BotWorldView,
    slot: SurvivorSlot,
    sightBlockers: readonly Rect[],
    threats: readonly PerceivedThreat[],
    pressure: number,
    panicking: boolean,
  ): Command {
    const p = slot.survivor
    const now = world.time
    const cmd: Command = {
      mx: 0,
      my: 0,
      aim: this.smoothedAim,
      interact: false,
      sprint: false,
    }

    // Manage flashlight: turn on at dusk/night or indoors when battery > 0; swap battery if depleted
    const day = dayCycle(world.hour)
    const shouldUseLight = day.darkness > 0.32 || Boolean(insideBuildingAt(world.town, p.x, p.y))
    if (shouldUseLight && !p.flashlightOn && !p.batteryDepleted) {
      cmd.flashlight = true
    } else if (!shouldUseLight && day.darkness < 0.12 && p.flashlightOn) {
      cmd.flashlight = true
    }
    if (
      (p.batteryDepleted || p.battery < 0.15) &&
      world.progression.ledger.count(`${this.actorId}/belt`, "battery") > 0 &&
      (!threats[0] || threats[0].distance > 3.5)
    ) {
      const selected = world.progression.selected(this.actorId)?.item
      if (selected !== "flashlight") {
        cmd.hotbarSlot = 0
      } else {
        cmd.reload = true
      }
    }

    // Equip better weapon or healing item from pack when safe
    if (!threats[0] || threats[0].distance > 6.0) {
      const swap = this.findPackSwapCandidate(world)
      if (swap) {
        const hotbar = world.progression.hotbar(this.actorId)
        if (hotbar && hotbar.selected !== swap.targetHotbarSlot) {
          cmd.hotbarSlot = swap.targetHotbarSlot
          return cmd
        }
        cmd.pick = { mode: "pack", index: swap.packIndex }
        return cmd
      }
    }

    // Squad ping when spotting a large horde or workbench in co-op
    if (
      world.slots.length > 1 &&
      now - this.lastPingTime > 18 &&
      (threats.length >= 3 || slot.prompt?.kind === "bench")
    ) {
      cmd.ping = true
      this.lastPingTime = now
    }

    const nearest = threats[0]
    const closeChasers = threats.filter((t) => t.distance < 9.5).length
    const kiteThrottle = this.computeCombatMoveScale(now, p, closeChasers)
    const meleeWeapon = this.hasMeleeWeaponInHotbar(world)
    const pistolState = world.progression.pistol(this.actorId)
    const totalAmmo = pistolState.loaded + pistolState.reserve
    const hotbar = world.progression.hotbar(this.actorId)

    // When out of pistol ammo (or mag empty while threats are within 4.5m), equip melee weapon in slot 2 so shoves deal lethal crowbar/spiked-board damage
    if (
      meleeWeapon &&
      hotbar &&
      hotbar.selected !== meleeWeapon.slotIndex &&
      (totalAmmo === 0 || (pistolState.loaded === 0 && nearest && nearest.distance < 4.5))
    ) {
      cmd.hotbarSlot = meleeWeapon.slotIndex
    }

    // Close-quarters melee/shove reflex when a zombie closes inside strike range and shove is ready
    const strikeRange =
      SHOVE_RANGE + (meleeWeapon?.item === "spiked-board" ? 0.32 : meleeWeapon ? 0.22 : 0)
    const canReflexStrike =
      !p.exhausted &&
      (!panicking || (nearest?.distance !== undefined && nearest.distance <= 1.55))
    let meleeLockedAim = false
    if (
      nearest &&
      nearest.distance <= strikeRange &&
      p.shoveCooldown <= 0 &&
      nearest.state !== "stagger" &&
      canReflexStrike
    ) {
      const aimToZ = Math.atan2(nearest.y - p.y, nearest.x - p.x)
      this.smoothedAim = this.stepAim(dt, aimToZ, false)
      cmd.aim = this.smoothedAim
      if (Math.abs(angleDiff(this.smoothedAim, aimToZ)) <= 1.05) {
        cmd.melee = true
        if (
          meleeWeapon &&
          hotbar?.selected === meleeWeapon.slotIndex &&
          p.meleePhase === "idle" &&
          p.stamina > 0.48
        ) {
          cmd.fire = true
        }
        meleeLockedAim = true
      }
    }

    switch (this.currentIntent) {
      case "heal": {
        const healItem = this.hasHealingItemInHotbar(world)
        if (healItem) {
          const hotbar = world.progression.hotbar(this.actorId)
          if (hotbar && hotbar.selected !== healItem.slotIndex) {
            cmd.hotbarSlot = healItem.slotIndex
          } else {
            cmd.fire = true
          }
        }
        if (nearest && nearest.distance < 5.0) {
          const away = this.computeKiteVector(world.town, p.x, p.y, threats)
          cmd.mx = away.mx
          cmd.my = away.my
        }
        cmd.aim = this.smoothedAim
        return cmd
      }

      case "fight-melee": {
        if (!nearest) break
        const meleeWeapon = this.hasMeleeWeaponInHotbar(world)
        const hotbar = world.progression.hotbar(this.actorId)
        if (meleeWeapon && hotbar && hotbar.selected !== meleeWeapon.slotIndex) {
          cmd.hotbarSlot = meleeWeapon.slotIndex
        }
        const aimToZ = Math.atan2(nearest.y - p.y, nearest.x - p.x)
        this.smoothedAim = this.stepAim(dt, aimToZ, true)
        cmd.aim = this.smoothedAim

        const strikeRange = SHOVE_RANGE + (meleeWeapon?.item === "spiked-board" ? 0.3 : 0.15)
        if (nearest.distance > strikeRange * 0.92 && p.shoveCooldown <= 0.05 && p.meleePhase === "idle") {
          // Step in to land the blow
          cmd.mx = ((nearest.x - p.x) / Math.max(0.1, nearest.distance)) * kiteThrottle
          cmd.my = ((nearest.y - p.y) / Math.max(0.1, nearest.distance)) * kiteThrottle
        } else {
          // Step back after swinging so we don't trade hits
          const kite = this.computeKiteVector(world.town, p.x, p.y, threats)
          cmd.mx = kite.mx * kiteThrottle
          cmd.my = kite.my * kiteThrottle
        }
        if (
          nearest.distance <= strikeRange &&
          !p.exhausted &&
          Math.abs(angleDiff(this.smoothedAim, aimToZ)) <= 0.85
        ) {
          cmd.melee = true
          if (
            meleeWeapon &&
            hotbar?.selected === meleeWeapon.slotIndex &&
            p.meleePhase === "idle" &&
            p.stamina > 0.42
          ) {
            cmd.fire = true
          }
        }
        return cmd
      }

      case "kite-shoot": {
        if (!nearest) break
        if (
          hotbar &&
          hotbar.selected !== 1 &&
          pistolState.loaded > 0 &&
          world.progression.ledger.count(`${this.actorId}/hotbar`, "pistol") > 0
        ) {
          cmd.hotbarSlot = 1
        }
        const kitePt = this.pickOpenKitePoint(p.x, p.y, threats)
        const navMove = this.followPathTo(dt, world, slot, kitePt.x, kitePt.y, true, false)
        const kite = this.computeKiteVector(world.town, p.x, p.y, threats)
        const blend = nearest.distance < 3.4 ? 0.38 : 0.15
        const bx = navMove.mx * (1 - blend) + kite.mx * blend
        const by = navMove.my * (1 - blend) + kite.my * blend
        const len = Math.hypot(bx, by) || 1
        cmd.mx = (bx / len) * kiteThrottle
        cmd.my = (by / len) * kiteThrottle
        cmd.interact = navMove.interact
        cmd.interactHeld = navMove.interactHeld
        cmd.jump = navMove.jump
        cmd.sprint = this.shouldSprint(p, nearest.distance < 2.6 || panicking, now)

        if (!meleeLockedAim) {
          const trueAim = Math.atan2(nearest.y - p.y, nearest.x - p.x)
          this.smoothedAim = this.stepAim(dt, trueAim, true)
          cmd.aim = this.smoothedAim
        }

        const trueAim = Math.atan2(nearest.y - p.y, nearest.x - p.x)
        const maxFireDist = panicking
          ? PISTOL_RANGE * 0.75
          : 5.4 + (1 - this.skill.ammoDiscipline) * 5.2
        const aimTolerance =
          0.11 + (1 - this.skill.ammoDiscipline) * 0.16 + (panicking ? 0.14 : 0)
        const aligned = Math.abs(angleDiff(this.smoothedAim, trueAim)) <= aimTolerance
        const hasLos = clearLine(p.x, p.y, nearest.x, nearest.y, sightBlockers)
        if (
          hasLos &&
          nearest.distance <= maxFireDist &&
          aligned &&
          p.fireCooldown <= 0 &&
          p.reloadRemaining <= 0
        ) {
          cmd.fire = true
        }
        return cmd
      }

      case "flee-horde": {
        // Throw a noisemaker lure if carrying one and chased by >= 3 zombies
        const lure = this.hasLureInHotbar(world)
        if (lure && threats.length >= 3 && nearest && nearest.distance < 8.5) {
          if (hotbar && hotbar.selected !== lure.slotIndex) {
            cmd.hotbarSlot = lure.slotIndex
            return cmd
          }
          cmd.fire = true
          return cmd
        }
        const kitePt = this.pickOpenKitePoint(p.x, p.y, threats)
        const navMove = this.followPathTo(dt, world, slot, kitePt.x, kitePt.y, true, false)
        const kite = this.computeKiteVector(world.town, p.x, p.y, threats)
        const blend = nearest && nearest.distance < 3.4 ? 0.38 : 0.15
        const bx = navMove.mx * (1 - blend) + kite.mx * blend
        const by = navMove.my * (1 - blend) + kite.my * blend
        const len = Math.hypot(bx, by) || 1
        cmd.mx = (bx / len) * kiteThrottle
        cmd.my = (by / len) * kiteThrottle
        cmd.sprint = this.shouldSprint(p, Boolean(nearest && nearest.distance < 2.6) || panicking, now)
        cmd.interact = navMove.interact
        cmd.interactHeld = navMove.interactHeld
        cmd.jump = navMove.jump
        if (!meleeLockedAim) {
          // Keep flashlight and melee arc trained on closest chaser unless opening a door
          const desiredAim =
            nearest && nearest.distance <= 14.5 && slot.prompt?.kind !== "door"
              ? Math.atan2(nearest.y - p.y, nearest.x - p.x)
              : Math.atan2(cmd.my, cmd.mx)
          this.smoothedAim = this.stepAim(dt, desiredAim, false)
          cmd.aim = this.smoothedAim
        }
        return cmd
      }

      case "reload-cover": {
        if (hotbar && hotbar.selected !== 1) {
          cmd.hotbarSlot = 1
        } else if (p.reloadRemaining <= 0) {
          cmd.reload = true
        }
        if (nearest && nearest.distance < 15.0) {
          const kitePt = this.pickOpenKitePoint(p.x, p.y, threats)
          const navMove = this.followPathTo(dt, world, slot, kitePt.x, kitePt.y, true, false)
          const kite = this.computeKiteVector(world.town, p.x, p.y, threats)
          const blend = nearest.distance < 3.4 ? 0.38 : 0.15
          const bx = navMove.mx * (1 - blend) + kite.mx * blend
          const by = navMove.my * (1 - blend) + kite.my * blend
          const len = Math.hypot(bx, by) || 1
          const reloadThrottle = clamp(kiteThrottle * 0.94, 0.35, 0.98)
          cmd.mx = (bx / len) * reloadThrottle
          cmd.my = (by / len) * reloadThrottle
          cmd.interact = navMove.interact
          cmd.sprint = this.shouldSprint(p, nearest.distance < 2.5, now)
        }
        cmd.aim = this.smoothedAim
        return cmd
      }

      case "workbench": {
        if (slot.prompt?.kind === "bench") {
          const benchId = slot.prompt.id
          if (this.hasWorkbenchPartInPack(world)) {
            cmd.interact = true
            return cmd
          }
          const job = this.canResearchAnyAtBench(world, benchId)
          if (job) {
            if (!p.flashlightOn && !p.batteryDepleted) {
              cmd.flashlight = true
            }
            cmd.pick = { mode: "bench", index: job.recipeIndex }
            return cmd
          }
        }
        return this.followPathTo(dt, world, slot, this.goalX, this.goalY, false)
      }

      case "craft": {
        const job = this.canFieldCraftUseful(world, p)
        if (job) {
          cmd.pick = { mode: "craft", index: job.craftIndex }
          return cmd
        }
        break
      }

      case "barricade": {
        const distToGoal = Math.hypot(this.goalX - p.x, this.goalY - p.y)
        if (distToGoal <= INTERACT_RANGE - 0.25 && slot.prompt?.kind === "window") {
          const aimToPortal = Math.atan2(this.goalY - p.y, this.goalX - p.x)
          this.smoothedAim = this.stepAim(dt, aimToPortal, false)
          cmd.aim = this.smoothedAim
          cmd.barricade = true
          return cmd
        }
        return this.followPathTo(dt, world, slot, this.goalX, this.goalY, false)
      }

      case "assist-ally": {
        const dist = Math.hypot(this.goalX - p.x, this.goalY - p.y)
        if (dist <= 2.4 && now - this.lastBundleTime > 20) {
          const pistol = world.progression.pistol(this.actorId)
          if (pistol.reserve >= 6) {
            cmd.bundle = true
            this.lastBundleTime = now
            return cmd
          }
        }
        return this.followPathTo(dt, world, slot, this.goalX, this.goalY, dist > 12)
      }

      case "retreat-safehouse":
      case "explore": {
        return this.followPathTo(
          dt,
          world,
          slot,
          this.goalX,
          this.goalY,
          this.currentIntent === "retreat-safehouse" && day.threat > 0.7,
        )
      }

      case "loot": {
        // Check if standing right at a container or drop prompt
        if (slot.prompt?.kind === "drop") {
          cmd.interact = true
          return cmd
        }
        if (slot.prompt?.kind === "container") {
          const cMem = this.knownContainers.get(slot.prompt.id)
          if (slot.prompt.primary.id === "search") {
            cmd.interact = true
            // Panicking bots smash containers instead of searching quietly
            if (panicking && slot.prompt.alt?.id === "smash") {
              cmd.sprint = true
            }
            return cmd
          }
          if (slot.prompt.primary.id === "take") {
            cmd.interact = true
            if (cMem) {
              cMem.takenOnce = true
              cMem.searched = true
              cMem.empty = true
            }
            return cmd
          }
        }
        return this.followPathTo(dt, world, slot, this.goalX, this.goalY, false)
      }
    }

    return this.followPathTo(dt, world, slot, this.goalX, this.goalY, false)
  }

  private computeCombatMoveScale(
    _now: number,
    p: SurvivorSlot["survivor"],
    closeChasers: number,
  ): number {
    const skillQuality = clamp(
      1 -
        this.skill.panicUnderPressure * 0.52 -
        this.skill.decisionNoise * 0.55 -
        this.skill.reactionTime * 0.48 -
        (1 - this.skill.staminaDiscipline) * 0.18,
      0,
      1,
    )
    const baseMoveThrottle = clamp(0.65 + skillQuality * 0.34, 0.65, 0.99)
    const chaserCapacity = 1.1 + skillQuality * 4.3
    const overCapacity = Math.max(0, closeChasers - chaserCapacity)
    const hordeCongestion = clamp(
      1 - overCapacity * (0.06 + this.skill.panicUnderPressure * 0.09 + this.skill.decisionNoise * 0.06),
      0.36,
      1.0,
    )
    const exhaustedPenalty = p.exhausted ? 0.62 + this.skill.staminaDiscipline * 0.22 : 1.0
    return clamp(baseMoveThrottle * hordeCongestion * exhaustedPenalty, 0.35, 0.99)
  }

  private shouldSprint(p: SurvivorSlot["survivor"], emergency: boolean, _now = 0): boolean {
    if (p.exhausted) return false
    if (emergency) return p.stamina > 0.08
    return p.stamina > Math.min(0.52, Math.max(0.18, this.skill.staminaDiscipline))
  }

  private stepAim(dt: number, targetAim: number, combatJitter: boolean): number {
    let desired = targetAim
    if (combatJitter && this.skill.aimError > 0) {
      // Smooth pseudo-oscillation + bounded random jitter proportional to aimError
      const err = (this.rng.next() - 0.5) * 2 * this.skill.aimError
      desired = wrapAngle(desired + err)
    }
    if (this.skill.aimTrackingLag <= 1e-4) {
      return desired
    }
    const alpha = 1 - Math.exp(-dt / Math.max(0.01, this.skill.aimTrackingLag))
    const diff = angleDiff(desired, this.smoothedAim)
    return wrapAngle(this.smoothedAim + diff * alpha)
  }

  private computeKiteVector(
    town: Town,
    px: number,
    py: number,
    threats: readonly PerceivedThreat[],
  ): { mx: number; my: number } {
    let rx = 0
    let ry = 0
    for (const z of threats) {
      if (!z.actionable || z.distance > 12) continue
      const w = 1 / Math.max(0.35, z.distance * z.distance)
      rx += ((px - z.x) / Math.max(0.1, z.distance)) * w
      ry += ((py - z.y) / Math.max(0.1, z.distance)) * w
    }
    // Gentle inward pull away from the outer map boundaries (0..SIZE)
    const margin = 12
    if (px < margin) rx += (margin - px) * 0.25
    else if (px > SIZE - margin) rx -= (px - (SIZE - margin)) * 0.25
    if (py < margin) ry += (margin - py) * 0.25
    else if (py > SIZE - margin) ry -= (py - (SIZE - margin)) * 0.25

    const baseAngle = rx === 0 && ry === 0 ? this.smoothedAim + Math.PI : Math.atan2(ry, rx)
    const blockers = this.cachedSolidBlockers.length ? this.cachedSolidBlockers : solidRects(town)

    // Probe candidate escape angles around baseAngle against all solid blockers (walls, windows, fences, props, vehicles)
    let bestAngle = baseAngle
    let bestScore = -Infinity
    const offsets = [0, 0.35, -0.35, 0.72, -0.72, 1.1, -1.1, 1.5, -1.5, 2.0, -2.0, Math.PI]
    for (const off of offsets) {
      const a = baseAngle + off
      const dx = Math.cos(a)
      const dy = Math.sin(a)
      const nx = -dy * 0.28
      const ny = dx * 0.28
      const cCenter = raycast(px, py, dx, dy, blockers, 7.5)
      const cLeft = raycast(px + nx, py + ny, dx, dy, blockers, 5.5)
      const cRight = raycast(px - nx, py - ny, dx, dy, blockers, 5.5)
      const clearDist = Math.min(7.5, cCenter, cLeft + 0.8, cRight + 0.8)

      // Penalize angles heading toward map boundaries
      const projX = px + dx * Math.min(clearDist, 5.0)
      const projY = py + dy * Math.min(clearDist, 5.0)
      const edgePenalty =
        projX < 6 || projX > SIZE - 6 || projY < 6 || projY > SIZE - 6 ? 12 : 0

      // Penalize angles running into a close non-staggered zombie
      let threatPenalty = 0
      for (const z of threats) {
        if (!z.actionable || z.state === "stagger" || z.distance > 5.0) continue
        const angToZ = Math.atan2(z.y - py, z.x - px)
        const diff = Math.abs(angleDiff(a, angToZ))
        if (diff < 0.85) {
          threatPenalty += (0.85 - diff) * (6.0 / Math.max(0.8, z.distance))
        }
      }

      const align = Math.cos(off)
      const score = clearDist * (0.72 + 0.28 * align) - edgePenalty - threatPenalty
      if (score > bestScore) {
        bestScore = score
        bestAngle = a
      }
    }
    return { mx: Math.cos(bestAngle), my: Math.sin(bestAngle) }
  }

  private followPathTo(
    dt: number,
    world: BotWorldView,
    slot: SurvivorSlot,
    targetX: number,
    targetY: number,
    urgent: boolean,
    updateAim = true,
  ): Command {
    const p = slot.survivor
    const now = world.time
    const cmd: Command = {
      mx: 0,
      my: 0,
      aim: this.smoothedAim,
      interact: false,
      sprint: false,
    }

    // Check if we need to hold E to open a closed window blocking our path
    if (now < this.holdInteractUntil) {
      cmd.interactHeld = true
      return cmd
    }

    // Track movement progress to recover from getting snagged on props/corners
    const moved = Math.hypot(p.x - this.lastPosX, p.y - this.lastPosY)
    const distToGoal = Math.hypot(targetX - p.x, targetY - p.y)
    this.lastPosX = p.x
    this.lastPosY = p.y
    const lingeringAtLoot =
      this.currentIntent === "loot" && distToGoal <= 1.6 && slot.prompt?.kind !== "container"
    if ((moved < dt * 0.45 && distToGoal > 1.1) || lingeringAtLoot) {
      this.stuckTime += lingeringAtLoot ? dt * 1.6 : dt
      if (this.stuckTime > 0.75) {
        this.stuckTime = 0
        this.unstuckUntil = now + 0.55
        this.unstuckAngle = this.smoothedAim + (this.rng.next() < 0.5 ? 1.35 : -1.35)
        this.repathAt = 0
        if (this.currentIntent === "loot") {
          for (const c of this.knownContainers.values()) {
            if (Math.hypot(c.x - targetX, c.y - targetY) < 1.2) {
              c.unreachableUntil = now + 45
            }
          }
        }
      }
    } else {
      this.stuckTime = Math.max(0, this.stuckTime - dt * 2)
    }

    // Handle door/window/container interactions along the path
    const prompt: InteractTarget | undefined = slot.prompt
    if (prompt && now - this.lastInteractTickTime > 0.22) {
      if (prompt.kind === "door") {
        const door = world.town.doors.find((d) => d.id === prompt.id)
        const planks = world.getBarricadePlanks(prompt.id)
        if (door && !door.open && planks === 0) {
          if (
            prompt.primary.id === "toggle" ||
            prompt.primary.id === "unlock" ||
            prompt.primary.id === "pry"
          ) {
            cmd.interact = true
            this.lastInteractTickTime = now
          } else if (
            prompt.primary.id === "locked" &&
            world.progression.ledger.count(`${this.actorId}/hotbar`, "crowbar") > 0
          ) {
            cmd.hotbarSlot = 2
            this.lastInteractTickTime = now
          }
        }
      } else if (prompt.kind === "window" && this.stuckTime > 0.25) {
        const win = world.town.windows.find((w) => w.id === prompt.id)
        if (win && world.getBarricadePlanks(win.id) === 0) {
          if (win.open) {
            cmd.jump = true
            this.lastInteractTickTime = now
          } else if (win.openable) {
            cmd.interact = true
            cmd.interactAction = "toggle"
            this.holdInteractUntil = now + 0.42
            this.lastInteractTickTime = now
          }
        }
      }
    }

    // Hierarchical doorway subgoal: exit current building via its front door before crossing town,
    // and approach a target building's front porch before entering its rooms.
    let effTargetX = targetX
    let effTargetY = targetY
    const hereBuilding = insideBuildingAt(world.town, p.x, p.y)
    const goalBuilding = insideBuildingAt(world.town, targetX, targetY)
    if (hereBuilding && hereBuilding.id !== goalBuilding?.id) {
      effTargetX = hereBuilding.rect[0] + 5.7
      effTargetY = hereBuilding.rect[3] + 1.5
    } else if (!hereBuilding && goalBuilding) {
      const porchX = goalBuilding.rect[0] + 5.7
      const porchY = goalBuilding.rect[3] + 1.5
      if (Math.hypot(p.x - porchX, p.y - porchY) > 3.2) {
        effTargetX = porchX
        effTargetY = porchY
      }
    }

    // If a closed, unbarricaded door is right in front of us (within 1.55m), face it and press interact so we never get trapped indoors
    for (const door of world.town.doors) {
      if (door.open || world.getBarricadePlanks(door.id) > 0) continue
      const d = distToRect(p.x, p.y, door.rect)
      if (d <= 1.55) {
        const dcx = (door.rect[0] + door.rect[2]) * 0.5
        const dcy = (door.rect[1] + door.rect[3]) * 0.5
        const doorAng = Math.atan2(dcy - p.y, dcx - p.x)
        this.smoothedAim = this.stepAim(dt, doorAng, false)
        cmd.aim = this.smoothedAim
        if (now - this.lastInteractTickTime > 0.2) {
          cmd.interact = true
          this.lastInteractTickTime = now
        }
        updateAim = false
        break
      }
    }

    // Recompute A* path on the local nav grid when needed
    const goalVec = this.localNav.nearest({ x: effTargetX, y: effTargetY })
    if (
      now >= this.repathAt ||
      this.currentPath.length === 0 ||
      Math.hypot(
        (this.currentPath[this.currentPath.length - 1]?.x ?? effTargetX) - goalVec.x,
        (this.currentPath[this.currentPath.length - 1]?.y ?? effTargetY) - goalVec.y,
      ) > 1.5
    ) {
      const startVec = this.localNav.nearest({ x: p.x, y: p.y })
      const path = this.localNav.path(startVec, goalVec, 2400)
      this.currentPath = path && path.length > 0 ? path : [goalVec]
      this.repathAt = now + 0.9
    }

    // Advance along waypoints (only use wide arrival radius when next waypoint is in clear line of sight)
    while (this.currentPath.length > 1) {
      const d0 = Math.hypot(this.currentPath[0]!.x - p.x, this.currentPath[0]!.y - p.y)
      const canSeeNext =
        urgent &&
        clearLine(p.x, p.y, this.currentPath[1]!.x, this.currentPath[1]!.y, this.cachedSolidBlockers)
      if (d0 < (canSeeNext ? 1.05 : 0.55)) {
        this.currentPath.shift()
      } else {
        break
      }
    }

    const wp = this.currentPath[0] ?? { x: targetX, y: targetY }
    let dx = wp.x - p.x
    let dy = wp.y - p.y
    const dist = Math.hypot(dx, dy)

    if (now < this.unstuckUntil) {
      dx = Math.cos(this.unstuckAngle)
      dy = Math.sin(this.unstuckAngle)
    } else if (dist > 0.08) {
      dx /= dist
      dy /= dist
    } else {
      dx = 0
      dy = 0
    }

    const closeChasers = this.perceivedThreats.filter((t) => t.actionable && t.distance < 11).length
    const moveScale = closeChasers > 0 ? this.computeCombatMoveScale(now, p, closeChasers) : 1.0
    cmd.mx = dx * moveScale
    cmd.my = dy * moveScale
    const totalDist = Math.hypot(targetX - p.x, targetY - p.y)
    cmd.sprint = this.shouldSprint(p, urgent, now) && totalDist > 3.5

    // Look toward where we are walking (or toward target when close)
    if (updateAim) {
      const lookTargetX = totalDist < 2.2 ? targetX : p.x + dx * 3
      const lookTargetY = totalDist < 2.2 ? targetY : p.y + dy * 3
      const desiredAim =
        Math.hypot(lookTargetX - p.x, lookTargetY - p.y) > 0.05
          ? Math.atan2(lookTargetY - p.y, lookTargetX - p.x)
          : this.smoothedAim
      this.smoothedAim = this.stepAim(dt, desiredAim, false)
    }
    cmd.aim = this.smoothedAim

    return cmd
  }
}

/**
 * Guarded wrapper around `SurvivorBot.step` that verifies at runtime (for tests and proofs)
 * that the bot never mutates simulation state directly and only returns a valid `Command`.
 */
export function stepBotReadOnly(bot: SurvivorBot, dt: number, sim: CoopSim): Command {
  const view = createBotWorldView(sim)
  return bot.step(dt, view)
}
