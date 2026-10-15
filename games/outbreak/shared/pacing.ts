import {
  createAIAgent,
  type AIAgent,
  type AIConfig as KitAIConfig,
  type GridNav,
  type NoiseBus,
} from "@arcade/kit/sim/ai"
import { angleDiff, clearLine, distToRect, type Rect } from "@arcade/kit/sim/geom"
import { Rng } from "@arcade/kit/sim/rng"
import { dayCycle } from "./day-cycle"
import { BUILDING_RECTS, SIZE, type Town } from "./map"

export type PacingTuning = {
  /** Starting clock hour (0..24) on the first night. Default 17.5 (17:30 dusk, already in the Noir palette). */
  startHour: number
  /** Multiplier (0.1..1) on the day-cycle time scale from the start until the first 18:00, so nightfall still takes about a minute. */
  openingClock: number
  /** Seconds (0..180) over which zombie perception eases from daytime to the hour's nocturnal threat at the start. */
  openingCalm: number
  /** Radius (m) around spawn and the starting safehouse kept clear of zombies at start. */
  safeRadius: number
  /** Fraction (0..1) of target zombieCount present at t = 0. */
  initialDensity: number
  /** Duration (s) over which the director ramps base tension and population to full night intensity. */
  rampTime: number
  /** Multiplier (0..2.5) on how strongly loud noises accelerate director tension and waves. */
  noiseSensitivity: number
  /** Maximum simultaneous zombies actively chasing/attacking near a solo player (scales in co-op). */
  maxActiveNearPlayer: number
}

/**
 * Opening pacing with the difficulty knobs as they were before D-22 (Balanced Curve); the D-18 opening clock is shared.
 * Saved presets that carry these values keep them.
 */
export const LEGACY_PACING_TUNING: PacingTuning = {
  startHour: 17.5,
  openingClock: 0.25,
  openingCalm: 50,
  safeRadius: 20,
  initialDensity: 0.25,
  rampTime: 360,
  noiseSensitivity: 1.0,
  maxActiveNearPlayer: 4,
}

/** D-22 Balanced Curve, tuned by the survivor-bot CMA-ES search (games/outbreak/scripts/run-bot-tuning.ts). */
export const DEFAULT_PACING_TUNING: PacingTuning = {
  ...LEGACY_PACING_TUNING,
  safeRadius: 17,
  initialDensity: 0.1,
  rampTime: 405,
  noiseSensitivity: 1.05,
  maxActiveNearPlayer: 3,
}

/**
 * Lab controls for opening pacing (`Pacing` group).
 * Update boundaries:
 * - `startHour`: Live & session-start value (updates current hour immediately when scrubbed and sets starting hour on reset).
 * - `openingClock`: Live; slows the clock only before the first 18:00 (see `openingClockActive`).
 * - `openingCalm`: Live; eases the threat the crowd and director read during the opening (see `openingThreat`).
 * - `safeRadius`, `initialDensity`: Spawn-time & opening clearance values (re-syncs opening population when adjusted in the opening window).
 * - `rampTime`, `noiseSensitivity`, `maxActiveNearPlayer`: Live director parameters evaluated each tick.
 */
export const pacingControls = [
  { key: "startHour", label: "Start hour", group: "Pacing", min: 12, max: 22, step: 0.25, unit: "h" },
  { key: "openingClock", label: "Opening clock", group: "Pacing", min: 0.1, max: 1, step: 0.05, unit: "×" },
  { key: "openingCalm", label: "Opening calm", group: "Pacing", min: 0, max: 180, step: 5, unit: "s" },
  { key: "safeRadius", label: "Safe radius", group: "Pacing", min: 0, max: 45, step: 1, unit: "m" },
  { key: "initialDensity", label: "Initial density", group: "Pacing", min: 0, max: 1, step: 0.05, unit: "×" },
  { key: "rampTime", label: "Ramp time", group: "Pacing", min: 30, max: 900, step: 15, unit: "s" },
  { key: "noiseSensitivity", label: "Noise sensitivity", group: "Pacing", min: 0, max: 2.5, step: 0.1, unit: "×" },
  { key: "maxActiveNearPlayer", label: "Max active near player", group: "Pacing", min: 1, max: 30, step: 1, unit: "" },
] as const

/** Hour at which the first night has fallen and the opening clock returns to normal speed. */
export const NIGHTFALL_HOUR = 18

/**
 * True while the opening clock applies: the director is on, the first night has not fallen yet (fewer than 12 game
 * hours elapsed) and the clock reads between noon and 18:00.
 */
export function openingClockActive(directorPacing: number, hour: number, elapsedHours: number): boolean {
  return directorPacing > 0 && elapsedHours < 12 && hour >= 12 && hour < NIGHTFALL_HOUR
}

/**
 * Threat the crowd and director read: the hour's nocturnal threat, eased in over the first `openingCalm` seconds so a
 * dusk start keeps the calm, daytime-perception opening (the curve a 16:00 start produced at the default clock).
 */
export function openingThreat(threat: number, time: number, config: Pick<PacingTuning, "openingCalm"> & { directorPacing: number }): number {
  if (config.directorPacing <= 0 || config.openingCalm <= 0) return threat
  return threat * smoothstep(config.openingCalm * 0.2, config.openingCalm, time)
}

export type PacingSurvivorView = {
  id?: string
  x: number
  y: number
  vx?: number
  vy?: number
  aim: number
  flashlightOn?: boolean
  flashlightOutput?: number
}

export type FirstEncounterStage = "grace" | "staged" | "completed"

export type PacingTelemetry = {
  ramp: number
  timeProgress: number
  exploreProgress: number
  threat: number
  noiseHeat: number
  playerCount: number
  coopScale: number
  desiredPopulation: number
  livingPopulation: number
  effectiveMaxActive: number
  activeChasers: number
  firstEncounterStage: FirstEncounterStage
  firstContactTime: number | null
  maxDistanceExplored: number
  cumulativeDistanceWalked: number
  within15m: number
  within30m: number
  within60m: number
  inViewSpawns: number
  behindSpawns: number
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const lerp = (a: number, b: number, t: number) => a + (b - a) * clamp(t, 0, 1)
const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = clamp((x - edge0) / Math.max(1e-5, edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}

/** Ash House (building 0) is the starting safehouse containing the squad workbench and stash. */
export const STARTING_SAFEHOUSE_RECT: Rect = [
  BUILDING_RECTS[0][0],
  BUILDING_RECTS[0][1],
  BUILDING_RECTS[0][2],
  BUILDING_RECTS[0][3],
]
export const STARTING_SAFEHOUSE_YARD_RECT: Rect = [18, 20, 39, 37.5]

/** Co-op population multiplier: 1.0x for 1 player, 1.35x for 2, 1.70x for 3, 2.05x for 4. */
export function coopPopulationScale(playerCount: number): number {
  return 1 + (Math.max(1, playerCount) - 1) * 0.35
}

/** Co-op active-chaser cap multiplier: 1.0x for 1 player, up to 2.8x for 4 players. */
export function coopChaserScale(playerCount: number): number {
  return 1 + (Math.max(1, playerCount) - 1) * 0.6
}

/**
 * Computes the initial zombie count at t = 0 from `zombieCount`, `initialDensity`, and `playerCount`.
 * Preserves small explicit test counts (`1..6`) while scaling full town populations (`>= 8`) by `initialDensity`.
 */
export function initialSpawnCount(
  zombieCount: number,
  initialDensity: number,
  playerCount = 1,
  directorPacing = 1,
): number {
  const base = Math.max(0, Math.round(zombieCount))
  if (base <= 0) return 0
  if (directorPacing <= 0 || initialDensity >= 0.999) {
    return Math.min(100, Math.round(base * coopPopulationScale(playerCount)))
  }
  const density = clamp(initialDensity, 0, 1)
  if (density <= 0) return 0
  if (base < 8) return base
  const initScale = 1 + (Math.max(1, playerCount) - 1) * 0.25
  return Math.max(1, Math.min(100, Math.round(base * density * initScale)))
}

/**
 * True if `(x, y)` lies inside the opening safe radius around any survivor or inside the starting safehouse (`ash`).
 */
export function isInsideSafeZone(
  x: number,
  y: number,
  survivors: readonly Pick<PacingSurvivorView, "x" | "y">[],
  safeRadius: number,
): boolean {
  if (safeRadius <= 0) return false
  if (safeRadius >= 8) {
    const [sx0, sy0, sx1, sy1] = STARTING_SAFEHOUSE_RECT
    if (x >= sx0 - 0.6 && x <= sx1 + 0.6 && y >= sy0 - 0.6 && y <= sy1 + 0.6) return true
  }
  if (safeRadius >= 14) {
    const [yx0, yy0, yx1, yy1] = STARTING_SAFEHOUSE_YARD_RECT
    if (x >= yx0 && x <= yx1 && y >= yy0 && y <= yy1) return true
  }
  for (let i = 0; i < survivors.length; i++) {
    const s = survivors[i]!
    if (Math.hypot(x - s.x, y - s.y) < safeRadius) return true
  }
  return false
}

/**
 * True if `(x, y)` is currently visible to any survivor (inside their unobstructed sight cone, close awareness, or flashlight beam).
 */
export function isSpawnInView(
  x: number,
  y: number,
  survivors: readonly PacingSurvivorView[],
  sightBlockers: readonly Rect[],
  visionRange = 28,
  visionConeDeg = 110,
  awarenessRadius = 3.5,
): boolean {
  const halfCone = ((visionConeDeg + 18) * Math.PI) / 360
  for (let i = 0; i < survivors.length; i++) {
    const s = survivors[i]!
    const dx = x - s.x
    const dy = y - s.y
    const dist = Math.hypot(dx, dy)
    if (dist > visionRange + 4) continue
    if (!clearLine(s.x, s.y, x, y, sightBlockers)) continue
    if (dist <= awarenessRadius) return true
    const off = Math.abs(angleDiff(Math.atan2(dy, dx), s.aim))
    if (dist <= visionRange && off <= halfCone) return true
    if (s.flashlightOn && (s.flashlightOutput ?? 1) > 0.05 && dist <= 21 && off <= 0.62) return true
  }
  return false
}

/**
 * True if `(x, y)` is in the rear hemisphere right behind any survivor within `behindDist` metres.
 */
export function isSpawnBehindPlayer(
  x: number,
  y: number,
  survivors: readonly PacingSurvivorView[],
  behindDist = 20,
): boolean {
  if (behindDist <= 0) return false
  for (let i = 0; i < survivors.length; i++) {
    const s = survivors[i]!
    const dx = x - s.x
    const dy = y - s.y
    const dist = Math.hypot(dx, dy)
    if (dist > behindDist) continue
    const off = Math.abs(angleDiff(Math.atan2(dy, dx), s.aim))
    if (off >= Math.PI * 0.55) return true
  }
  return false
}

export type SpawnRuleOptions = {
  safeRadius: number
  forbidInView?: boolean
  forbidBehind?: boolean
  behindDist?: number
  minSpacing?: number
  existingAgents?: readonly Pick<AIAgent, "x" | "y" | "state">[]
  allowInterior?: boolean
}

/**
 * Validates that a candidate spawn coordinate `(x, y)` obeys all Outbreak opening & backstage spawn rules:
 * 1. Walkable on `GridNav` and outside closed buildings (unless `allowInterior` is set).
 * 2. Outside `safeRadius` around all survivors and outside the starting safehouse (`ash`).
 * 3. Never in a survivor's unobstructed sight cone, close awareness, or flashlight beam.
 * 4. Never right behind a survivor.
 * 5. Spaced at least `minSpacing` metres from existing living zombies.
 */
export function canSpawnZombieAt(
  x: number,
  y: number,
  town: Town,
  nav: GridNav,
  survivors: readonly PacingSurvivorView[],
  sightBlockers: readonly Rect[],
  options: SpawnRuleOptions,
): boolean {
  if (!nav.walkable({ x, y })) return false
  if (!options.allowInterior) {
    const insideBuilding = town.buildings.some(
      (b) => x > b.rect[0] + 0.2 && x < b.rect[2] - 0.2 && y > b.rect[1] + 0.2 && y < b.rect[3] - 0.2,
    )
    if (insideBuilding) return false
  }
  if (isInsideSafeZone(x, y, survivors, options.safeRadius)) return false
  if (options.forbidInView !== false && isSpawnInView(x, y, survivors, sightBlockers)) return false
  const behindDist = options.behindDist ?? Math.max(16, options.safeRadius * 0.9)
  if (options.forbidBehind !== false && isSpawnBehindPlayer(x, y, survivors, behindDist)) return false
  const minSpacing = options.minSpacing ?? 0
  if (minSpacing > 0 && options.existingAgents) {
    for (let i = 0; i < options.existingAgents.length; i++) {
      const a = options.existingAgents[i]!
      if (a.state === "dead") continue
      if (Math.hypot(a.x - x, a.y - y) < minSpacing) return false
    }
  }
  return true
}

/**
 * Curated opening anchors outside the 20 m safehouse safe radius, spaced across the mid-ring (22–32 m)
 * and outer block (34–68 m) so the player can explore Ash House and its workbench before making first contact.
 */
export const PACED_OPENING_ANCHORS: readonly (readonly [number, number])[] = [
  [48.5, 48.8], // 22.2 m: SE crossroads corner
  [12.5, 58.0], // 22.8 m: West wooded lot behind Elm fence (occluded)
  [52.5, 42.0], // 24.8 m: East street before Hardware Store
  [26.5, 67.5], // 26.5 m: South of Elm House frontage
  [44.2, 16.5], // 29.6 m: North avenue past abandoned cruiser
  [14.0, 14.0], // 30.3 m: North-West wooded corner behind Ash back fence (occluded)
  [44.5, 68.5], // 32.2 m: South avenue by Pharmacy/Elm corner
  [62.5, 43.5], // 34.9 m: East commercial strip between Hardware & Pharmacy
  [64.0, 20.0], // 41.9 m: North-East lane behind Hardware Store
  [44.0, 82.0], // 44.1 m: Far South avenue
  [76.0, 44.0], // 48.4 m: Far East street approach
  [65.0, 72.0], // 48.5 m: South-East lot behind Pharmacy
  [14.0, 78.0], // 39.5 m: South-West wooded lot
  [78.0, 22.0], // 53.8 m: North-East perimeter
  [78.0, 68.0], // 57.1 m: South-East perimeter
  [24.0, 84.0], // 43.2 m: South suburban yard
]

/**
 * Legacy un-paced town spawner (used when `directorPacing === 0` or `safeRadius <= 4 && initialDensity >= 0.99`
 * for before/after A/B comparisons).
 */
export function spawnLegacyTownZombies(
  town: Town,
  nav: GridNav,
  count: number,
  avoidX: number,
  avoidY: number,
  minClearance = 3.5,
): AIAgent[] {
  const rng = new Rng((town.seed ^ 0x7a4f9b13) >>> 0)
  const agents: AIAgent[] = []
  if (count <= 0) return agents

  const anchors: [number, number][] = [
    [30.0, 37.3],
    [26.8, 38.6],
    [32.9, 38.6],
    [27.9, 27.0],
    [29.6, 29.9],
    [35.2, 43.2],
    [21.2, 43.5],
    [31.5, 46.5],
    [46.5, 35.5],
    [47.5, 49.5],
    [52.0, 43.8],
    [43.8, 56.0],
    [28.5, 49.5],
    [60.0, 43.5],
    [29.5, 19.5],
    [44.0, 21.0],
    [63.0, 50.0],
    [44.0, 68.0],
    [16.0, 44.0],
    [75.0, 44.0],
  ]

  let nextId = 1
  for (let aIdx = 0; aIdx < anchors.length && agents.length < count; aIdx++) {
    const [ax, ay] = anchors[aIdx]!
    const isHeroAnchor = aIdx < 5
    const groupSize = isHeroAnchor ? 1 : aIdx < 9 ? 2 + (aIdx % 2) : 2 + rng.int(3)
    for (let m = 0; m < groupSize && agents.length < count; m++) {
      const offsetAngle = rng.range(-Math.PI, Math.PI)
      const offsetDist = isHeroAnchor ? 0 : m === 0 ? rng.range(0, 1.2) : rng.range(1.2, 3.8)
      const candidate = nav.nearest({
        x: Math.max(3, Math.min(SIZE - 3, ax + Math.cos(offsetAngle) * offsetDist)),
        y: Math.max(3, Math.min(SIZE - 3, ay + Math.sin(offsetAngle) * offsetDist)),
      })
      if (!isHeroAnchor && Math.hypot(candidate.x - avoidX, candidate.y - avoidY) < minClearance) continue
      const allowInterior = aIdx === 3 || aIdx === 4
      const insideHouse =
        !allowInterior &&
        town.buildings.some(
          (b) =>
            candidate.x > b.rect[0] + 0.2 &&
            candidate.x < b.rect[2] - 0.2 &&
            candidate.y > b.rect[1] + 0.2 &&
            candidate.y < b.rect[3] - 0.2,
        )
      if (insideHouse) continue
      const awayAim = isHeroAnchor
        ? Math.PI / 2 + (aIdx === 1 ? 0.35 : aIdx === 2 ? -0.4 : aIdx === 4 ? 2.4 : 0.1)
        : Math.atan2(candidate.y - avoidY, candidate.x - avoidX) + rng.range(-0.7, 0.7)
      agents.push(createAIAgent(nextId++, town.seed, candidate.x, candidate.y, awayAim))
    }
  }

  let attempts = 0
  while (agents.length < count && attempts++ < count * 12) {
    const onStreet = rng.next() < 0.68
    const rawX = onStreet
      ? rng.next() < 0.5
        ? rng.range(38.2, 49.8)
        : rng.range(8, SIZE - 8)
      : rng.range(6, SIZE - 6)
    const rawY = onStreet
      ? rawX >= 38 && rawX <= 50
        ? rng.range(8, SIZE - 8)
        : rng.range(38.2, 49.8)
      : rng.range(6, SIZE - 6)
    const candidate = nav.nearest({ x: rawX, y: rawY })
    if (Math.hypot(candidate.x - avoidX, candidate.y - avoidY) < minClearance) continue
    const insideHouse = town.buildings.some(
      (b) =>
        candidate.x > b.rect[0] + 0.2 &&
        candidate.x < b.rect[2] - 0.2 &&
        candidate.y > b.rect[1] + 0.2 &&
        candidate.y < b.rect[3] - 0.2,
    )
    if (insideHouse) continue
    const awayAim = Math.atan2(candidate.y - avoidY, candidate.x - avoidX) + rng.range(-0.7, 0.7)
    agents.push(createAIAgent(nextId++, town.seed, candidate.x, candidate.y, awayAim))
  }

  return agents
}

/**
 * Opening-paced town zombie spawner:
 * - Clears `safeRadius` around all survivor spawn points and the starting safehouse (`ash`).
 * - Places `initialSpawnCount` solitary idle/wandering shamblers spaced out across mid and outer rings.
 * - Never places a zombie in a survivor's initial sight cone or right behind them.
 */
export function spawnPacedTownZombies(
  town: Town,
  nav: GridNav,
  sightBlockers: readonly Rect[],
  config: Pick<KitAIConfig, "zombieCount" | "directorPacing"> & PacingTuning,
  survivors: readonly PacingSurvivorView[],
): AIAgent[] {
  const effectiveSurvivors: readonly PacingSurvivorView[] =
    survivors.length > 0 ? survivors : [{ x: 27.7, y: 41, aim: -Math.PI / 2, flashlightOn: true, flashlightOutput: 1 }]

  if (config.directorPacing <= 0 || (config.safeRadius <= 4 && config.initialDensity >= 0.99)) {
    const primary = effectiveSurvivors[0]!
    return spawnLegacyTownZombies(
      town,
      nav,
      Math.round(config.zombieCount),
      primary.x,
      primary.y,
      Math.max(3.5, config.safeRadius),
    )
  }

  const targetCount = initialSpawnCount(
    config.zombieCount,
    config.initialDensity,
    effectiveSurvivors.length,
    config.directorPacing,
  )
  const agents: AIAgent[] = []
  if (targetCount <= 0) return agents

  const rng = new Rng((town.seed ^ 0x7a4f9b13) >>> 0)
  const primary = effectiveSurvivors[0]!
  const minSpacing = Math.max(4.5, Math.min(11.5, 13.0 - targetCount * 0.22))
  let nextId = 1

  const configureCalmShambler = (agent: AIAgent) => {
    agent.state = "wander"
    agent.awareness = 0
    agent.timer = rng.range(5.5, 9.5)
    // Keep initial wander target close to the zombie's own home lot and away from the safehouse
    const awayAng = Math.atan2(agent.y - primary.y, agent.x - primary.x) + rng.range(-0.85, 0.85)
    const wDist = rng.range(3.0, 6.5)
    const wx = clamp(agent.x + Math.cos(awayAng) * wDist, 4, SIZE - 4)
    const wy = clamp(agent.y + Math.sin(awayAng) * wDist, 4, SIZE - 4)
    if (nav.walkable({ x: wx, y: wy }) && !isInsideSafeZone(wx, wy, effectiveSurvivors, config.safeRadius)) {
      agent.wanderX = wx
      agent.wanderY = wy
    } else {
      agent.wanderX = agent.x
      agent.wanderY = agent.y
    }
    return agent
  }

  // Pass 1: Curated spaced solitary anchors from mid-ring (22–32 m) to outer ring (34–68 m)
  for (let i = 0; i < PACED_OPENING_ANCHORS.length && agents.length < targetCount; i++) {
    const [ax, ay] = PACED_OPENING_ANCHORS[i]!
    const jitterAng = rng.range(-Math.PI, Math.PI)
    const jitterDist = rng.range(0, 1.4)
    const candidate = nav.nearest({
      x: clamp(ax + Math.cos(jitterAng) * jitterDist, 4, SIZE - 4),
      y: clamp(ay + Math.sin(jitterAng) * jitterDist, 4, SIZE - 4),
    })
    if (
      !canSpawnZombieAt(candidate.x, candidate.y, town, nav, effectiveSurvivors, sightBlockers, {
        safeRadius: config.safeRadius,
        forbidInView: true,
        forbidBehind: true,
        behindDist: Math.max(15, config.safeRadius * 0.8),
        minSpacing,
        existingAgents: agents,
      })
    ) {
      continue
    }
    const awayAim = Math.atan2(candidate.y - primary.y, candidate.x - primary.x) + rng.range(-0.65, 0.65)
    agents.push(configureCalmShambler(createAIAgent(nextId++, town.seed, candidate.x, candidate.y, awayAim)))
  }

  // Pass 2: Deterministic street & lot sampling for higher initialDensity or co-op counts
  let attempts = 0
  const maxAttempts = targetCount * 28
  while (agents.length < targetCount && attempts++ < maxAttempts) {
    const onStreet = rng.next() < 0.62
    const rawX = onStreet
      ? rng.next() < 0.5
        ? rng.range(38.2, 49.8)
        : rng.range(8, SIZE - 8)
      : rng.range(6, SIZE - 6)
    const rawY = onStreet
      ? rawX >= 38 && rawX <= 50
        ? rng.range(8, SIZE - 8)
        : rng.range(38.2, 49.8)
      : rng.range(6, SIZE - 6)
    const candidate = nav.nearest({ x: rawX, y: rawY })
    const relaxedSpacing = attempts > targetCount * 14 ? Math.max(3.0, minSpacing * 0.55) : minSpacing
    if (
      !canSpawnZombieAt(candidate.x, candidate.y, town, nav, effectiveSurvivors, sightBlockers, {
        safeRadius: config.safeRadius,
        forbidInView: true,
        forbidBehind: attempts <= targetCount * 20,
        behindDist: Math.max(14, config.safeRadius * 0.75),
        minSpacing: relaxedSpacing,
        existingAgents: agents,
      })
    ) {
      continue
    }
    const awayAim = Math.atan2(candidate.y - primary.y, candidate.x - primary.x) + rng.range(-0.7, 0.7)
    agents.push(configureCalmShambler(createAIAgent(nextId++, town.seed, candidate.x, candidate.y, awayAim)))
  }

  return agents
}

export type PacingDirectorSnapshot = {
  spawnOrigins: [string, { x: number; y: number }][]
  prevPositions: [string, { x: number; y: number }][]
  maxDistanceExplored: number
  cumulativeDistanceWalked: number
  noiseHeat: number
  totalNoiseImpulse: number
  lastNoiseId: number
  firstEncounterStage: FirstEncounterStage
  firstContactTime: number | null
  reinforceCooldown: number
  waveCooldown: number
  inViewSpawns: number
  behindSpawns: number
  telemetry: PacingTelemetry
}

/**
 * Authoritative Opening & Night Pacing Director.
 * Drives the transition from a quiet dusk safehouse opening to a first 1–3 zombie encounter as night falls,
 * followed by a gradual night ramp governed by time, distance explored, player noise, nocturnal threat, and co-op squad size.
 */
export class OutbreakPacingDirector {
  private readonly spawnOrigins = new Map<string, { x: number; y: number }>()
  private readonly prevPositions = new Map<string, { x: number; y: number }>()
  maxDistanceExplored = 0
  cumulativeDistanceWalked = 0
  noiseHeat = 0
  totalNoiseImpulse = 0
  private lastNoiseId = 0
  firstEncounterStage: FirstEncounterStage = "grace"
  firstContactTime: number | null = null
  private reinforceCooldown = 8.0
  private waveCooldown = 18.0
  inViewSpawns = 0
  behindSpawns = 0
  telemetry: PacingTelemetry = {
    ramp: 0,
    timeProgress: 0,
    exploreProgress: 0,
    threat: 0,
    noiseHeat: 0,
    playerCount: 1,
    coopScale: 1,
    desiredPopulation: 0,
    livingPopulation: 0,
    effectiveMaxActive: 4,
    activeChasers: 0,
    firstEncounterStage: "grace",
    firstContactTime: null,
    maxDistanceExplored: 0,
    cumulativeDistanceWalked: 0,
    within15m: 0,
    within30m: 0,
    within60m: 0,
    inViewSpawns: 0,
    behindSpawns: 0,
  }

  reset(): void {
    this.spawnOrigins.clear()
    this.prevPositions.clear()
    this.maxDistanceExplored = 0
    this.cumulativeDistanceWalked = 0
    this.noiseHeat = 0
    this.totalNoiseImpulse = 0
    this.lastNoiseId = 0
    this.firstEncounterStage = "grace"
    this.firstContactTime = null
    this.reinforceCooldown = 8.0
    this.waveCooldown = 18.0
    this.inViewSpawns = 0
    this.behindSpawns = 0
  }

  snapshot(): PacingDirectorSnapshot {
    return {
      spawnOrigins: [...this.spawnOrigins.entries()].map(([k, v]) => [k, { x: v.x, y: v.y }]),
      prevPositions: [...this.prevPositions.entries()].map(([k, v]) => [k, { x: v.x, y: v.y }]),
      maxDistanceExplored: this.maxDistanceExplored,
      cumulativeDistanceWalked: this.cumulativeDistanceWalked,
      noiseHeat: this.noiseHeat,
      totalNoiseImpulse: this.totalNoiseImpulse,
      lastNoiseId: this.lastNoiseId,
      firstEncounterStage: this.firstEncounterStage,
      firstContactTime: this.firstContactTime,
      reinforceCooldown: this.reinforceCooldown,
      waveCooldown: this.waveCooldown,
      inViewSpawns: this.inViewSpawns,
      behindSpawns: this.behindSpawns,
      telemetry: { ...this.telemetry },
    }
  }

  restore(snap: PacingDirectorSnapshot): void {
    this.spawnOrigins.clear()
    for (const [k, v] of snap.spawnOrigins) this.spawnOrigins.set(k, { x: v.x, y: v.y })
    this.prevPositions.clear()
    for (const [k, v] of snap.prevPositions) this.prevPositions.set(k, { x: v.x, y: v.y })
    this.maxDistanceExplored = snap.maxDistanceExplored
    this.cumulativeDistanceWalked = snap.cumulativeDistanceWalked
    this.noiseHeat = snap.noiseHeat
    this.totalNoiseImpulse = snap.totalNoiseImpulse
    this.lastNoiseId = snap.lastNoiseId
    this.firstEncounterStage = snap.firstEncounterStage
    this.firstContactTime = snap.firstContactTime
    this.reinforceCooldown = snap.reinforceCooldown
    this.waveCooldown = snap.waveCooldown
    this.inViewSpawns = snap.inViewSpawns
    this.behindSpawns = snap.behindSpawns
    this.telemetry = { ...snap.telemetry }
  }

  /** Computes the current pacing curve state from elapsed time, exploration, noise, threat, and survivor count. */
  evaluateCurve(
    config: Pick<KitAIConfig, "zombieCount" | "directorPacing"> & PacingTuning,
    hour: number,
    time: number,
    playerCount: number,
    livingPopulation: number,
  ): PacingTelemetry {
    const threat = openingThreat(dayCycle(hour).threat, time, config)
    const pCount = Math.max(1, playerCount)
    const coopScale = coopPopulationScale(pCount)
    const chaserScale = coopChaserScale(pCount)

    if (config.directorPacing <= 0) {
      const fullPop = Math.min(100, Math.round(config.zombieCount * coopScale))
      return {
        ...this.telemetry,
        ramp: 1,
        timeProgress: 1,
        exploreProgress: 1,
        threat,
        noiseHeat: this.noiseHeat,
        playerCount: pCount,
        coopScale,
        desiredPopulation: fullPop,
        livingPopulation,
        effectiveMaxActive: 100,
      }
    }

    const rampTime = Math.max(30, config.rampTime)
    // Hold time progress gentle during the first 25 s so the player can search the starting safehouse & workbench
    const timeProgress = smoothstep(0, rampTime, Math.max(0, time - 25))
    const exploreProgress = clamp(
      (this.maxDistanceExplored / 52) * 0.55 + (this.cumulativeDistanceWalked / 165) * 0.45,
      0,
      1,
    )
    const noiseBoost = clamp(this.noiseHeat * 0.36 + Math.min(0.32, this.totalNoiseImpulse * 0.06), 0, 0.85)
    const baseRamp =
      (0.52 * timeProgress + 0.22 * exploreProgress + 0.26 * timeProgress * threat) * (0.72 + 0.28 * threat)
    const ramp = clamp(baseRamp + noiseBoost * 0.55, 0, 1)

    const initPop = initialSpawnCount(config.zombieCount, config.initialDensity, pCount, config.directorPacing)
    const fullPop =
      config.zombieCount <= 0 ? 0 : Math.min(100, Math.max(initPop, Math.round(config.zombieCount * coopScale)))
    const desiredPopulation = config.zombieCount <= 0 ? 0 : Math.round(lerp(initPop, fullPop, ramp))

    const baseMaxActive = Math.max(1, Math.round(config.maxActiveNearPlayer))
    let soloCap: number
    if (time < 36 && this.noiseHeat < 0.45) {
      soloCap = Math.min(baseMaxActive, 1)
    } else if (time < 85 && this.noiseHeat < 0.65) {
      soloCap = Math.min(baseMaxActive, Math.max(1, Math.min(2, baseMaxActive)))
    } else {
      const rampCap = lerp(Math.min(2, baseMaxActive), baseMaxActive, clamp(ramp * 1.35 + this.noiseHeat * 0.45, 0, 1))
      soloCap = Math.min(baseMaxActive, Math.max(1, Math.round(rampCap)))
    }
    const effectiveMaxActive = Math.max(1, Math.round(soloCap * chaserScale))

    return {
      ...this.telemetry,
      ramp,
      timeProgress,
      exploreProgress,
      threat,
      noiseHeat: this.noiseHeat,
      playerCount: pCount,
      coopScale,
      desiredPopulation,
      livingPopulation,
      effectiveMaxActive,
      firstEncounterStage: this.firstEncounterStage,
      firstContactTime: this.firstContactTime,
      maxDistanceExplored: this.maxDistanceExplored,
      cumulativeDistanceWalked: this.cumulativeDistanceWalked,
      inViewSpawns: this.inViewSpawns,
      behindSpawns: this.behindSpawns,
    }
  }

  /**
   * Pre-crowd director step:
   * - Updates survivor exploration metrics and noise heat.
   * - Keeps opening shamblers from wandering into the safehouse during the opening grace period.
   * - Triggers the first 1–3 zombie encounter once the player has explored or dusk settles.
   * - Trickle-spawns backstage zombies (never in view, never right behind) as the ramp climbs.
   * - Coordinates late-night / high-noise waves.
   */
  stepBeforeCrowd(
    town: Town,
    nav: GridNav,
    agents: AIAgent[],
    survivors: readonly PacingSurvivorView[],
    sightBlockers: readonly Rect[],
    noiseBus: NoiseBus,
    config: KitAIConfig & PacingTuning,
    hour: number,
    time: number,
    dt: number,
    tick: number,
    allocAgentId: () => number,
    manualSpawnOnly: boolean,
    rngSeedMix = 0,
  ): void {
    const pCount = Math.max(1, survivors.length)
    for (let i = 0; i < survivors.length; i++) {
      const s = survivors[i]!
      const id = s.id ?? `p${i}`
      let origin = this.spawnOrigins.get(id)
      if (!origin) {
        origin = { x: s.x, y: s.y }
        this.spawnOrigins.set(id, origin)
      }
      const prev = this.prevPositions.get(id)
      if (prev) {
        const stepDist = Math.hypot(s.x - prev.x, s.y - prev.y)
        // Ignore teleports (`pose` > 3 m in one tick) when accumulating walked distance
        if (stepDist > 0 && stepDist < 2.5) {
          this.cumulativeDistanceWalked += stepDist / pCount
        }
      }
      this.prevPositions.set(id, { x: s.x, y: s.y })
      const distFromOrigin = Math.hypot(s.x - origin.x, s.y - origin.y)
      if (distFromOrigin < 250) {
        this.maxDistanceExplored = Math.max(this.maxDistanceExplored, distFromOrigin)
      }
    }

    // Accumulate loud player/world noises into director heat (quiet footsteps, doors, and quiet searches do not spike heat)
    const sens = Math.max(0, config.noiseSensitivity)
    for (let i = 0; i < noiseBus.events.length; i++) {
      const ev = noiseBus.events[i]!
      if (ev.id <= this.lastNoiseId) continue
      this.lastNoiseId = Math.max(this.lastNoiseId, ev.id)
      if (ev.sourceId.startsWith("zombie-")) continue
      if (ev.radius < 8.5 || ev.kind === "footstep" || ev.kind === "search" || ev.kind === "door") continue
      const gain =
        ev.kind === "sprint"
          ? 0.024 * sens
          : sens * Math.pow(Math.max(0, (ev.radius - 7.5) / 22), 1.3)
      this.noiseHeat = clamp(this.noiseHeat + gain, 0, 3.0)
      this.totalNoiseImpulse += gain
    }
    this.noiseHeat = Math.max(0, this.noiseHeat - dt * 0.022)

    let livingCount = 0
    for (let i = 0; i < agents.length; i++) {
      if (agents[i]!.state !== "dead") livingCount++
    }

    this.telemetry = this.evaluateCurve(config, hour, time, pCount, livingCount)
    if (config.directorPacing <= 0 || manualSpawnOnly || survivors.length === 0) return

    // If additional co-op survivors joined before the first tick, top up the opening sparse population to the co-op initial count
    if (tick <= 2 && time < 0.1 && pCount > 1 && config.zombieCount >= 8 && config.initialDensity > 0 && config.initialDensity < 0.99) {
      const targetInit = initialSpawnCount(config.zombieCount, config.initialDensity, pCount, config.directorPacing)
      if (livingCount < targetInit) {
        const rng = new Rng((town.seed ^ Math.imul(pCount + 73, 0x9e3779b9)) >>> 0)
        while (livingCount < targetInit) {
          const pt = this.findBackstageSpawnPoint(town, nav, agents, survivors, sightBlockers, rng, config.safeRadius)
          if (!pt) break
          const id = allocAgentId()
          const agent = createAIAgent(id, town.seed + id * 13, pt.x, pt.y, pt.aim)
          agent.timer = rng.range(5.0, 9.0)
          agents.push(agent)
          livingCount++
        }
        this.telemetry.livingPopulation = livingCount
      }
    }

    const allInsideSafehouse = survivors.every(
      (s) =>
        s.x >= STARTING_SAFEHOUSE_RECT[0] - 1.0 &&
        s.x <= STARTING_SAFEHOUSE_RECT[2] + 1.0 &&
        s.y >= STARTING_SAFEHOUSE_RECT[1] - 1.0 &&
        s.y <= STARTING_SAFEHOUSE_RECT[3] + 1.2,
    )

    // 1. Opening Grace Period: keep idle shamblers outside the safehouse safe zone while the player explores Ash House
    if (this.firstEncounterStage === "grace" && time < 42 && this.noiseHeat < 0.45) {
      const guardRadius = Math.max(14, config.safeRadius * 0.95)
      for (let i = 0; i < agents.length; i++) {
        const a = agents[i]!
        if (a.state === "dead") continue
        if (allInsideSafehouse && a.state !== "chase") {
          a.awareness = Math.min(a.awareness, 0.18)
          if (a.state === "investigate" || a.state === "alert") a.state = "wander"
        }
        if (
          a.state === "wander" &&
          (isInsideSafeZone(a.x, a.y, survivors, guardRadius) ||
            isInsideSafeZone(a.wanderX, a.wanderY, survivors, guardRadius))
        ) {
          const primary = survivors[0]!
          const outAng = Math.atan2(a.y - primary.y, a.x - primary.x) + ((a.id % 2 === 0 ? 1 : -1) * 0.35)
          const dest = nav.nearest({
            x: clamp(a.x + Math.cos(outAng) * 7.5, 4, SIZE - 4),
            y: clamp(a.y + Math.sin(outAng) * 7.5, 4, SIZE - 4),
          })
          a.wanderX = dest.x
          a.wanderY = dest.y
          a.timer = 4.5
        }
      }
    }

    // 2. First Scripted-Feeling Encounter of 1–3 Zombies
    if (
      this.firstEncounterStage === "grace" &&
      (time >= 42 ||
        (time >= 28 && this.cumulativeDistanceWalked >= 28 && !allInsideSafehouse) ||
        this.noiseHeat >= 0.45)
    ) {
      this.firstEncounterStage = "staged"
      const lead = survivors[0]!
      const scoutGoalCount = clamp(
        Math.round((this.noiseHeat >= 0.5 ? 2.4 : 1.7) * (1 + (pCount - 1) * 0.35)),
        1,
        Math.min(3 * pCount, Math.max(1, this.telemetry.effectiveMaxActive)),
      )
      // Pick the nearest idle wanderers and send them to investigate the street corridor outside the player's position
      const candidates = agents
        .filter((a) => a.state === "wander")
        .map((a) => ({ agent: a, dist: Math.hypot(a.x - lead.x, a.y - lead.y) }))
        .sort((x, y) => x.dist - y.dist)

      let staged = 0
      for (let i = 0; i < candidates.length && staged < scoutGoalCount; i++) {
        const a = candidates[i]!.agent
        const approachAng = Math.atan2(a.y - lead.y, a.x - lead.x) + ((staged % 2 === 0 ? 1 : -1) * 0.28)
        const stageDist = 7.5 + staged * 2.2
        const goal = nav.nearest({
          x: clamp(lead.x + Math.cos(approachAng) * stageDist, 4, SIZE - 4),
          y: clamp(lead.y + Math.sin(approachAng) * stageDist, 4, SIZE - 4),
        })
        a.state = "investigate"
        a.awareness = Math.max(a.awareness, 0.45)
        a.targetX = goal.x
        a.targetY = goal.y
        a.targetKind = "noise"
        a.stateTime = 0
        a.repathAt = 0
        staged++
      }
    }

    // If first encounter is staged and all staged scouts returned to wander without spotting the player, nudge 1–2 closer along the street
    if (this.firstEncounterStage === "staged" && time >= 48) {
      const anyEngaged = agents.some(
        (a) => a.state === "investigate" || a.state === "alert" || a.state === "chase" || a.state === "bash",
      )
      if (!anyEngaged) {
        const lead = survivors[0]!
        const nearest = agents
          .filter((a) => a.state === "wander")
          .sort((a, b) => Math.hypot(a.x - lead.x, a.y - lead.y) - Math.hypot(b.x - lead.x, b.y - lead.y))
          .slice(0, Math.min(2, this.telemetry.effectiveMaxActive))
        for (let i = 0; i < nearest.length; i++) {
          const a = nearest[i]!
          const goal = nav.nearest({
            x: clamp(lead.x + (i === 0 ? 5.5 : -5.5), 4, SIZE - 4),
            y: clamp(lead.y + 4.5, 4, SIZE - 4),
          })
          a.state = "investigate"
          a.awareness = 0.48
          a.targetX = goal.x
          a.targetY = goal.y
          a.targetKind = "noise"
          a.stateTime = 0
          a.repathAt = 0
        }
      }
    }

    // 3. Backstage Trickle Spawning as the Pacing Ramp Climbs (never in view, never right behind)
    this.reinforceCooldown -= dt
    if (
      time >= 28 &&
      this.reinforceCooldown <= 0 &&
      livingCount < this.telemetry.desiredPopulation &&
      config.zombieCount > 0
    ) {
      this.reinforceCooldown = Math.max(3.5, (11.5 - 6.0 * this.telemetry.ramp) / this.telemetry.coopScale)
      const batch = Math.min(2, this.telemetry.desiredPopulation - livingCount)
      const rng = new Rng((town.seed ^ Math.imul(tick + 101, 0x85ebca6b) ^ (rngSeedMix >>> 0)) >>> 0)
      const dynamicSafeRadius = Math.max(16, config.safeRadius * (1 - 0.25 * this.telemetry.ramp))

      for (let b = 0; b < batch; b++) {
        const pt = this.findBackstageSpawnPoint(
          town,
          nav,
          agents,
          survivors,
          sightBlockers,
          rng,
          dynamicSafeRadius,
        )
        if (!pt) break
        const id = allocAgentId()
        const agent = createAIAgent(id, (town.seed + id * 13 + (rngSeedMix >>> 0)) >>> 0, pt.x, pt.y, pt.aim)
        agent.timer = rng.range(3.5, 7.5)
        agents.push(agent)
        livingCount++
      }
      this.telemetry.livingPopulation = livingCount
    }

    // 4. Director Pacing Waves:
    // - Gentle 1–2 roamer drift during mid-ramp
    // - Coordinated horde waves (3–5+ roamers) ONLY later in the night (`ramp >= 0.72 && threat >= 0.85`) or on high noise (`noiseHeat >= 0.85`)
    if (this.firstEncounterStage === "completed" || time >= 75) {
      const isHordeCondition =
        (this.telemetry.ramp >= 0.72 && this.telemetry.threat >= 0.85) || this.noiseHeat >= 0.85
      const rate = (0.75 + 0.55 * this.telemetry.threat) * (isHordeCondition ? 1.35 : 0.85)
      this.waveCooldown -= dt * rate
      if (this.waveCooldown <= 0) {
        const waveJitter = rngSeedMix ? ((rngSeedMix ^ tick) >>> 0) % 5 : tick % (isHordeCondition ? 6 : 8)
        this.waveCooldown = (isHordeCondition ? 13 : 20) + waveJitter
        const maxWaveSize = isHordeCondition
          ? Math.min(
              this.telemetry.effectiveMaxActive,
              Math.max(2, Math.round((2.5 + this.telemetry.ramp * 2.0) * this.telemetry.coopScale)),
            )
          : Math.min(2, Math.max(1, Math.round(1.2 * this.telemetry.coopScale)))

        let nudged = 0
        for (let i = 0; i < agents.length && nudged < maxWaveSize; i++) {
          const a = agents[i]!
          if (a.state !== "wander") continue
          const targetSurvivor = survivors[nudged % survivors.length]!
          const d = Math.hypot(a.x - targetSurvivor.x, a.y - targetSurvivor.y)
          if (d > 18 && d < 62) {
            const ang =
              Math.atan2(targetSurvivor.y - a.y, targetSurvivor.x - a.x) + ((i % 2 === 0 ? 1 : -1) * 0.32)
            const stepDist = isHordeCondition ? Math.min(18, d - 10) : Math.min(13, d - 15)
            const dest = nav.nearest({
              x: clamp(a.x + Math.cos(ang) * stepDist, 4, SIZE - 4),
              y: clamp(a.y + Math.sin(ang) * stepDist, 4, SIZE - 4),
            })
            if (isHordeCondition && nudged < 2) {
              a.state = "investigate"
              a.awareness = Math.max(a.awareness, 0.44)
              a.targetX = dest.x
              a.targetY = dest.y
              a.targetKind = "noise"
              a.stateTime = 0
              a.repathAt = 0
            } else {
              a.wanderX = dest.x
              a.wanderY = dest.y
              a.timer = 6.0
            }
            nudged++
          }
        }
      }
    }
  }

  /**
   * Finds a deterministic backstage spawn position outside all survivors' safe radius, sight cones, and rear arcs.
   */
  findBackstageSpawnPoint(
    town: Town,
    nav: GridNav,
    agents: readonly AIAgent[],
    survivors: readonly PacingSurvivorView[],
    sightBlockers: readonly Rect[],
    rng: Rng,
    safeRadius: number,
  ): { x: number; y: number; aim: number } | null {
    const primary = survivors[0]!
    // First try curated outer anchors that are currently backstage
    const startIdx = rng.int(PACED_OPENING_ANCHORS.length)
    for (let k = 0; k < PACED_OPENING_ANCHORS.length; k++) {
      const [ax, ay] = PACED_OPENING_ANCHORS[(startIdx + k) % PACED_OPENING_ANCHORS.length]!
      const cand = nav.nearest({
        x: clamp(ax + rng.range(-2.2, 2.2), 4, SIZE - 4),
        y: clamp(ay + rng.range(-2.2, 2.2), 4, SIZE - 4),
      })
      if (
        canSpawnZombieAt(cand.x, cand.y, town, nav, survivors, sightBlockers, {
          safeRadius,
          forbidInView: true,
          forbidBehind: true,
          behindDist: Math.max(16, safeRadius * 0.9),
          minSpacing: 6.0,
          existingAgents: agents,
        })
      ) {
        const aim = Math.atan2(primary.y - cand.y, primary.x - cand.x) + rng.range(-0.6, 0.6)
        return { x: cand.x, y: cand.y, aim }
      }
    }

    // Fallback: sample backstage perimeter ring (24..56 m from survivor)
    for (let attempt = 0; attempt < 36; attempt++) {
      const anchor = survivors[attempt % survivors.length]!
      // Sample forward/side quadrants (avoiding the rear hemisphere behind the survivor!)
      const sideSign = attempt % 2 === 0 ? 1 : -1
      const relAngle = sideSign * rng.range(0.68, Math.PI * 0.52)
      const worldAngle = anchor.aim + relAngle
      const dist = rng.range(Math.max(22, safeRadius + 3), 54)
      const cand = nav.nearest({
        x: clamp(anchor.x + Math.cos(worldAngle) * dist, 5, SIZE - 5),
        y: clamp(anchor.y + Math.sin(worldAngle) * dist, 5, SIZE - 5),
      })
      if (
        canSpawnZombieAt(cand.x, cand.y, town, nav, survivors, sightBlockers, {
          safeRadius,
          forbidInView: true,
          forbidBehind: true,
          behindDist: Math.max(16, safeRadius * 0.9),
          minSpacing: 5.0,
          existingAgents: agents,
        })
      ) {
        const aim = Math.atan2(anchor.y - cand.y, anchor.x - cand.x) + rng.range(-0.6, 0.6)
        return { x: cand.x, y: cand.y, aim }
      }
    }
    return null
  }

  /**
   * Post-crowd director step:
   * - Records `firstContactTime` when the first zombie alerts/chases.
   * - Enforces `effectiveMaxActive` (`maxActiveNearPlayer` scaled by ramp and co-op player count) so excess distant
   *   zombies prowl the outer perimeter in `investigate` / `search` rather than 30 zombies rushing at once.
   * - Updates distance-band telemetry (`within15m`, `within30m`, `within60m`, `activeChasers`).
   */
  stepAfterCrowd(
    nav: GridNav,
    agents: AIAgent[],
    survivors: readonly PacingSurvivorView[],
    config: KitAIConfig & PacingTuning,
    time: number,
    manualSpawnOnly: boolean,
  ): void {
    if (survivors.length === 0) return

    const allInsideSafehouse =
      config.directorPacing > 0 &&
      !manualSpawnOnly &&
      this.firstEncounterStage === "grace" &&
      time < 42 &&
      this.noiseHeat < 0.45 &&
      survivors.every(
        (s) =>
          s.x >= STARTING_SAFEHOUSE_RECT[0] - 1.0 &&
          s.x <= STARTING_SAFEHOUSE_RECT[2] + 1.0 &&
          s.y >= STARTING_SAFEHOUSE_RECT[1] - 1.0 &&
          s.y <= STARTING_SAFEHOUSE_RECT[3] + 1.2,
      )
    if (allInsideSafehouse) {
      for (let i = 0; i < agents.length; i++) {
        const a = agents[i]!
        if (a.state === "dead") continue
        if (a.state === "alert" || a.state === "chase" || a.state === "investigate") {
          a.state = "wander"
          a.awareness = Math.min(a.awareness, 0.18)
          a.seesTarget = false
        }
      }
    }

    // Gather pursuing agents (`chase` | `alert` | `bash`)
    const pursuers: { agent: AIAgent; minDist: number; priority: number }[] = []
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i]!
      if (a.state === "dead") continue
      if (a.state === "chase" || a.state === "alert" || a.state === "bash") {
        let minDist = Infinity
        for (let k = 0; k < survivors.length; k++) {
          const s = survivors[k]!
          const d = Math.hypot(a.x - s.x, a.y - s.y)
          if (d < minDist) minDist = d
        }
        const priority = (a.seesTarget ? 50 : 0) + (a.state === "bash" ? 25 : 0) - minDist
        pursuers.push({ agent: a, minDist, priority })
      }
    }

    if (pursuers.length > 0) {
      if (this.firstContactTime === null) {
        this.firstContactTime = Number(time.toFixed(2))
      }
      if (this.firstEncounterStage === "staged") {
        this.firstEncounterStage = "completed"
      }
    }

    // Enforce simultaneous active chaser cap (`effectiveMaxActive`) when directorPacing is active
    const maxActive = this.telemetry.effectiveMaxActive
    if (config.directorPacing > 0 && !manualSpawnOnly && pursuers.length > maxActive) {
      pursuers.sort((x, y) => y.priority - x.priority)
      for (let i = maxActive; i < pursuers.length; i++) {
        const { agent: a, minDist } = pursuers[i]!
        const s = survivors[0]!
        const outAng = Math.atan2(a.y - s.y, a.x - s.x) + ((a.id % 2 === 0 ? 1 : -1) * 0.42)
        const holdDist = Math.max(15, Math.min(24, minDist + 4))
        const holdPos = nav.nearest({
          x: clamp(s.x + Math.cos(outAng) * holdDist, 4, SIZE - 4),
          y: clamp(s.y + Math.sin(outAng) * holdDist, 4, SIZE - 4),
        })
        a.state = minDist > 16 ? "investigate" : "search"
        a.awareness = Math.min(a.awareness, 0.48)
        a.seesTarget = false
        a.activePortalId = null
        a.targetX = holdPos.x
        a.targetY = holdPos.y
        a.stateTime = 0
        a.timer = 4.5
        a.repathAt = time + 0.8
      }
    }

    // Also prevent non-chasing zombies from over-packing inside 15 m during low/moderate tension
    if (config.directorPacing > 0 && !manualSpawnOnly) {
      const maxNear15 = Math.max(2, maxActive + (this.noiseHeat >= 1.0 ? 2 : 1))
      const near15: { agent: AIAgent; dist: number; surv: PacingSurvivorView }[] = []
      for (let i = 0; i < agents.length; i++) {
        const a = agents[i]!
        if (a.state === "dead") continue
        let bestS = survivors[0]!
        let bestD = Math.hypot(a.x - bestS.x, a.y - bestS.y)
        for (let k = 1; k < survivors.length; k++) {
          const s = survivors[k]!
          const d = Math.hypot(a.x - s.x, a.y - s.y)
          if (d < bestD) {
            bestD = d
            bestS = s
          }
        }
        if (bestD <= 15) {
          near15.push({ agent: a, dist: bestD, surv: bestS })
        }
      }
      if (near15.length > maxNear15) {
        near15.sort((x, y) => x.dist - y.dist)
        for (let i = maxNear15; i < near15.length; i++) {
          const { agent: a, surv } = near15[i]!
          if (a.state === "chase" || a.state === "alert" || a.state === "bash") continue
          const awayAng = Math.atan2(a.y - surv.y, a.x - surv.x) + ((a.id % 2 === 0 ? 1 : -1) * 0.35)
          const dest = nav.nearest({
            x: clamp(surv.x + Math.cos(awayAng) * 21, 4, SIZE - 4),
            y: clamp(surv.y + Math.sin(awayAng) * 21, 4, SIZE - 4),
          })
          a.state = "wander"
          a.awareness = Math.min(a.awareness, 0.2)
          a.wanderX = dest.x
          a.wanderY = dest.y
          a.timer = 5.5
        }
      }
    }

    // Compute final distance-band & active-chaser metrics
    let within15m = 0
    let within30m = 0
    let within60m = 0
    let activeChasers = 0
    let livingPopulation = 0
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i]!
      if (a.state === "dead") continue
      livingPopulation++
      if (a.state === "chase" || a.state === "alert" || a.state === "bash") activeChasers++
      let minDist = Infinity
      for (let k = 0; k < survivors.length; k++) {
        const s = survivors[k]!
        const d = Math.hypot(a.x - s.x, a.y - s.y)
        if (d < minDist) minDist = d
      }
      if (minDist <= 15) within15m++
      if (minDist <= 30) within30m++
      if (minDist <= 60) within60m++
    }

    this.telemetry.livingPopulation = livingPopulation
    this.telemetry.activeChasers = activeChasers
    this.telemetry.within15m = within15m
    this.telemetry.within30m = within30m
    this.telemetry.within60m = within60m
    this.telemetry.firstEncounterStage = this.firstEncounterStage
    this.telemetry.firstContactTime = this.firstContactTime
  }
}
