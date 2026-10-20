import { angleDiff, clearLine, distToRect, MinHeap, pushOut, rayRect, raycast, type Rect, type Vec } from "./geom"
import type { FlowFieldCache } from "./flow-field"
import { Rng } from "./rng"

export type AIState =
  | "wander"
  | "investigate"
  | "alert"
  | "chase"
  | "bash"
  | "search"
  | "stagger"
  | "knockdown"
  | "crawler"
  | "dead"

export type ZombieHitReaction = 0 | 1 | 2
export type ZombieDeathVariant = 0 | 1 | 2 | 3

export function zombieTraitsFromSeed(seed: number): {
  toughness: number
  hitReaction: ZombieHitReaction
  deathVariant: ZombieDeathVariant
} {
  const h = Math.imul((seed ^ 0x9e3779b9) >>> 0, 0x85ebca6b) >>> 0
  const toughSteps = [0.82, 0.9, 1.0, 1.0, 1.12, 1.24] as const
  return {
    toughness: toughSteps[h % toughSteps.length]!,
    hitReaction: ((h >>> 4) % 3) as ZombieHitReaction,
    deathVariant: ((h >>> 8) & 3) as ZombieDeathVariant,
  }
}

export function hasSeveredLeg(a: Pick<AIAgent, "detachedLimbs">): boolean {
  return (
    a.detachedLimbs.length > 0 &&
    (a.detachedLimbs.includes("left.thigh") ||
    a.detachedLimbs.includes("right.thigh") ||
      a.detachedLimbs.includes("left.shin") ||
      a.detachedLimbs.includes("right.shin"))
  )
}

export function isTorsoCrawler(a: Pick<AIAgent, "detachedLimbs">): boolean {
  const leftGone = a.detachedLimbs.includes("left.thigh") || a.detachedLimbs.includes("left.shin")
  const rightGone = a.detachedLimbs.includes("right.thigh") || a.detachedLimbs.includes("right.shin")
  return leftGone && rightGone
}

export type NoiseKind =
  | "footstep"
  | "sprint"
  | "door"
  | "window"
  | "vault"
  | "search"
  | "barricade"
  | "gunshot"
  | "glass"
  | "shove"
  | "bash"
  | "groan"
  | (string & {})

export type NoiseEvent = {
  id: number
  x: number
  y: number
  radius: number
  loudness: number
  kind: NoiseKind
  sourceId: string
  time: number
  ttl: number
}

export type FlashlightState = {
  on: boolean
  x: number
  y: number
  aim: number
  range: number
  /** Half-angle in radians. */
  halfAngle: number
  /** Normalized beam output (0..1, accounting for battery dimming/flicker). */
  output?: number
  /** Optional authoritative awareness callback (0..1) from the game's flashlight module. */
  awarenessAt?: (observerX: number, observerY: number) => number
}

export type PerceptionTarget = {
  id: string
  x: number
  y: number
  vx: number
  vy: number
  /** 0 (darkness) .. 1+ (daylight or bright lamp pool). */
  lightLevel: number
  /** Continuous acoustic radius around the target (e.g. from stamina.ts player.noise). */
  continuousNoiseRadius: number
  flashlight?: FlashlightState | null
  /**
   * How much of the target there is to see, 0..1 (default 1): scales sight and close-range sensing. A crouching
   * survivor is a smaller shape; one hidden in a closet is not there to see at all.
   */
  visibility?: number
}

export type NavPortal = {
  id: string
  kind: "door" | "window"
  rect: Rect
  open: boolean
  locked?: boolean
  openable?: boolean
  barricadePlanks?: number
  integrity?: number
}

export type AIConfig = {
  zombieCount: number
  sightRange: number
  sightCone: number
  peripheralCone: number
  proximityRange: number
  hearingScale: number
  walkSpeed: number
  chaseSpeed: number
  aggression: number
  darknessPenalty: number
  flashlightBoost: number
  wallAttenuation: number
  doorAttenuation: number
  alertDuration: number
  searchDuration: number
  bashInterval: number
  directorPacing: number
  nightMultiplier: number
  aiDebugOverlay: boolean
  /**
   * Crowd navigation when the world provides flow fields (`AIWorldContext.flow`): 0 = per-agent A* only,
   * 1 = flow fields once more than `FLOW_MIN_CROWD` agents are alive (small groups keep their A* feel), 2 = always.
   */
  flowFields?: number
}

export const DEFAULT_AI_CONFIG: AIConfig = {
  zombieCount: 28,
  sightRange: 18,
  sightCone: 105,
  peripheralCone: 155,
  proximityRange: 2.2,
  hearingScale: 1.0,
  walkSpeed: 0.95,
  chaseSpeed: 2.65,
  aggression: 1.0,
  darknessPenalty: 0.58,
  flashlightBoost: 1.65,
  wallAttenuation: 0.52,
  doorAttenuation: 0.72,
  alertDuration: 0.28,
  searchDuration: 5.5,
  bashInterval: 0.9,
  directorPacing: 1,
  nightMultiplier: 1.35,
  aiDebugOverlay: false,
}

export type AIAgent = {
  id: number
  seed: number
  x: number
  y: number
  vx: number
  vy: number
  aim: number
  state: AIState
  /** 0..1 continuous awareness/alertness level. */
  awareness: number
  targetX: number
  targetY: number
  targetKind: "none" | "sight" | "light" | "noise" | "proximity"
  seesTarget: boolean
  lastHeardNoiseId: number
  stateTime: number
  timer: number
  path: Vec[]
  repathAt: number
  homeX: number
  homeY: number
  wanderX: number
  wanderY: number
  searchIndex: number
  /** Seeded individual variation. */
  speedScale: number
  perceptionScale: number
  aggression: number
  /** Seeded rig traits (0..1). */
  lurch: number
  asymmetry: number
  drag: number
  reach: number
  /** Combat & health state. */
  hp: number
  maxHp: number
  /** Deterministic per-zombie damage resistance multiplier (0.82..1.24). */
  toughness: number
  /** Deterministic hit-reaction style (0 = flinch back, 1 = spin-twist, 2 = knee-buckle). */
  hitReaction: ZombieHitReaction
  /** Deterministic death collapse style (0 = fall forward, 1 = fall backward, 2 = spin collapse, 3 = collapse to knees). */
  deathVariant: ZombieDeathVariant
  /** True when a leg has been crippled (gunshot or heavy blunt blow) without severing the leg. */
  limping?: boolean
  hitFlash: number
  staggerVx: number
  staggerVy: number
  attackCooldown: number
  /** Obstacle interaction state. */
  activePortalId: string | null
  clamberWindowId: string | null
  clamberFromX: number
  clamberFromY: number
  clamberToX: number
  clamberToY: number
  clamberElapsed: number
  clamberDuration: number
  detachedLimbs: string[]
  /** Id of the perception target this agent is attending to when several survivors are present. */
  focusId: string
  /** Id of the survivor who last damaged or killed this agent (for co-op attribution). */
  lastHitBy?: string
  /** Set on members of a roaming horde: the game's horde layer owns them, not chunk streaming or pacing. */
  hordeId?: number
}

export type PortalBashEvent = {
  agentId: number
  portalId: string
  portalKind: "door" | "window"
  x: number
  y: number
  damage: number
}

export type AgentAttackEvent = {
  agentId: number
  targetId: string
  x: number
  y: number
  damage: number
  ankleGrab?: boolean
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

export type NoiseBusSnapshot = {
  nextId: number
  events: NoiseEvent[]
}

/**
 * Deterministic bounded acoustic event bus.
 * Coalesces rapid continuous footsteps per source while keeping discrete impulses distinct.
 */
export class NoiseBus {
  readonly events: NoiseEvent[] = []
  private nextId = 1
  private readonly maxEvents: number

  constructor(maxEvents = 48) {
    this.maxEvents = maxEvents
  }

  reset(): void {
    this.events.length = 0
    this.nextId = 1
  }

  snapshot(): NoiseBusSnapshot {
    return {
      nextId: this.nextId,
      events: this.events.map((e) => ({ ...e })),
    }
  }

  restore(snap: NoiseBusSnapshot): void {
    this.nextId = snap.nextId
    this.events.length = 0
    for (const e of snap.events) {
      this.events.push({ ...e })
    }
  }

  emit(input: {
    x: number
    y: number
    radius: number
    loudness?: number
    kind: NoiseKind
    sourceId?: string
    time: number
    ttl?: number
    coalesceWindow?: number
  }): NoiseEvent {
    const radius = Math.max(0, input.radius)
    const loudness = input.loudness ?? clamp(radius / 18, 0.15, 2.5)
    const sourceId = input.sourceId ?? "world"
    const ttl = input.ttl ?? clamp(0.55 + radius * 0.025, 0.5, 2.2)
    const coalesce = input.coalesceWindow ?? (input.kind === "footstep" || input.kind === "sprint" ? 0.28 : 0)

    if (coalesce > 0) {
      for (let i = this.events.length - 1; i >= 0; i--) {
        const existing = this.events[i]!
        if (
          existing.sourceId === sourceId &&
          existing.kind === input.kind &&
          input.time - existing.time <= coalesce
        ) {
          existing.x = input.x
          existing.y = input.y
          existing.radius = Math.max(existing.radius, radius)
          existing.loudness = Math.max(existing.loudness, loudness)
          existing.time = input.time
          existing.ttl = Math.max(existing.ttl, ttl)
          return existing
        }
      }
    }

    const ev: NoiseEvent = {
      id: this.nextId++,
      x: input.x,
      y: input.y,
      radius,
      loudness,
      kind: input.kind,
      sourceId,
      time: input.time,
      ttl,
    }
    if (this.events.length >= this.maxEvents) {
      this.events.shift()
    }
    this.events.push(ev)
    return ev
  }

  prune(now: number): void {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const ev = this.events[i]!
      if (now - ev.time > ev.ttl) {
        this.events.splice(i, 1)
      }
    }
  }
}

export type AttenuatedNoise = {
  audible: boolean
  distance: number
  effectiveRadius: number
  perceivedLoudness: number
  wallHits: number
  doorHits: number
}

/**
 * Evaluates sound propagation from (ox, oy) to (lx, ly), attenuating radius across solid walls and closed doors.
 */
export function attenuateNoise(
  ox: number,
  oy: number,
  radius: number,
  loudness: number,
  lx: number,
  ly: number,
  walls: readonly Rect[],
  closedDoors: readonly Rect[],
  config: Pick<AIConfig, "hearingScale" | "wallAttenuation" | "doorAttenuation">,
  perceptionScale = 1,
): AttenuatedNoise {
  const dx = lx - ox
  const dy = ly - oy
  const distance = Math.hypot(dx, dy)
  const baseRadius = radius * config.hearingScale * perceptionScale
  if (distance > baseRadius || baseRadius <= 1e-4) {
    return { audible: false, distance, effectiveRadius: baseRadius, perceivedLoudness: 0, wallHits: 0, doorHits: 0 }
  }
  if (distance < 0.25) {
    return { audible: true, distance, effectiveRadius: baseRadius, perceivedLoudness: loudness, wallHits: 0, doorHits: 0 }
  }

  const ux = dx / distance
  const uy = dy / distance
  const maxT = distance - 0.04
  const segMinX = Math.min(ox, lx) - 0.05
  const segMaxX = Math.max(ox, lx) + 0.05
  const segMinY = Math.min(oy, ly) - 0.05
  const segMaxY = Math.max(oy, ly) + 0.05
  let wallHits = 0
  let doorHits = 0

  for (let i = 0; i < walls.length; i++) {
    const r = walls[i]!
    if (r[2] < segMinX || r[0] > segMaxX || r[3] < segMinY || r[1] > segMaxY) continue
    const t = rayRect(ox, oy, ux, uy, r, maxT)
    if (t > 0.02 && t < maxT) {
      wallHits++
      if (wallHits >= 4) break
    }
  }
  for (let i = 0; i < closedDoors.length; i++) {
    const r = closedDoors[i]!
    if (r[2] < segMinX || r[0] > segMaxX || r[3] < segMinY || r[1] > segMaxY) continue
    const t = rayRect(ox, oy, ux, uy, r, maxT)
    if (t > 0.02 && t < maxT) {
      doorHits++
      if (doorHits >= 3) break
    }
  }

  const attenuation =
    Math.pow(clamp(config.wallAttenuation, 0.05, 1), wallHits) *
    Math.pow(clamp(config.doorAttenuation, 0.05, 1), doorHits)
  const effectiveRadius = baseRadius * attenuation
  if (distance > effectiveRadius) {
    return { audible: false, distance, effectiveRadius, perceivedLoudness: 0, wallHits, doorHits }
  }
  const falloff = 1 - distance / Math.max(0.1, effectiveRadius)
  return {
    audible: true,
    distance,
    effectiveRadius,
    perceivedLoudness: loudness * falloff * attenuation,
    wallHits,
    doorHits,
  }
}

export type SightEvaluation = {
  seesTarget: boolean
  sensesLight: boolean
  sensesProximity: boolean
  /** Rate of awareness gain per second (0..6+). */
  visualGain: number
  stimX: number
  stimY: number
  kind: "none" | "sight" | "light" | "proximity"
  effectiveSightRange: number
}

/**
 * Evaluates visual sight (focus + peripheral cones + target illumination), flashlight beam sensing,
 * and close-range proximity/smell (gated by LOS).
 */
export function evaluateSight(
  agent: Pick<AIAgent, "x" | "y" | "aim" | "perceptionScale">,
  target: PerceptionTarget,
  sightBlockers: readonly Rect[],
  config: Pick<
    AIConfig,
    "sightRange" | "sightCone" | "peripheralCone" | "proximityRange" | "darknessPenalty" | "flashlightBoost"
  >,
): SightEvaluation {
  const dx = target.x - agent.x
  const dy = target.y - agent.y
  const dist = Math.hypot(dx, dy)
  const illum = clamp(target.lightLevel, 0, 1.6)
  const darkPenalty = clamp(config.darknessPenalty, 0, 0.95)
  let lightFactor = 1 - darkPenalty + darkPenalty * Math.min(1, illum)
  if (target.flashlight?.on) {
    lightFactor = Math.max(lightFactor, config.flashlightBoost * 0.85)
  }
  const visibility = clamp(target.visibility ?? 1, 0, 1)
  const effectiveSightRange = config.sightRange * agent.perceptionScale * lightFactor * visibility
  const fl = target.flashlight
  const flActive = Boolean(fl?.on && (fl.output ?? 1) > 0.01)
  const flOutput = flActive ? (fl!.output ?? 1) : 0
  const maxPoolDist = flActive ? config.sightRange * agent.perceptionScale * config.flashlightBoost * flOutput : 0
  const maxPossibleDist = Math.max(
    effectiveSightRange,
    config.proximityRange * agent.perceptionScale * visibility,
    flActive ? fl!.range * 1.25 + maxPoolDist : 0,
  )
  if (dist > maxPossibleDist) {
    return {
      seesTarget: false,
      sensesLight: false,
      sensesProximity: false,
      visualGain: 0,
      stimX: 0,
      stimY: 0,
      kind: "none",
      effectiveSightRange,
    }
  }

  const hasDirectLos =
    dist <= Math.max(effectiveSightRange, config.proximityRange * agent.perceptionScale * visibility, flActive ? fl!.range * 1.25 : 0) &&
    clearLine(agent.x, agent.y, target.x, target.y, sightBlockers)

  const focusHalf = (config.sightCone * Math.PI) / 360
  const periphHalf = (Math.max(config.sightCone, config.peripheralCone) * Math.PI) / 360
  const toTargetAngle = Math.atan2(dy, dx)
  const offAngle = Math.abs(angleDiff(toTargetAngle, agent.aim))

  // 1. Direct visual sighting of the survivor
  if (hasDirectLos && dist <= effectiveSightRange && offAngle <= periphHalf) {
    const angularGain =
      offAngle <= focusHalf
        ? 1.0
        : clamp(1 - ((offAngle - focusHalf) / Math.max(0.05, periphHalf - focusHalf)) * 0.62, 0.35, 1.0)
    const distNorm = clamp(dist / Math.max(1, effectiveSightRange), 0, 1)
    const distGain = 1.15 - 0.75 * distNorm * distNorm
    const speedBoost = Math.hypot(target.vx, target.vy) > 3.8 ? 1.25 : 1.0
    const gain = (1.6 + 2.4 * distGain) * angularGain * lightFactor * speedBoost
    return {
      seesTarget: true,
      sensesLight: false,
      sensesProximity: false,
      visualGain: gain,
      stimX: target.x,
      stimY: target.y,
      kind: "sight",
      effectiveSightRange,
    }
  }

  // 2. Flashlight beam sensing:
  // (a) Beam shining directly onto the zombie (via authoritative awarenessAt or geometric cone),
  // or (b) zombie seeing the flashlight's lit ground pool.
  if (flActive && fl) {
    const fromFlX = agent.x - fl.x
    const fromFlY = agent.y - fl.y
    const flDist = Math.hypot(fromFlX, fromFlY)
    const flAngleToAgent = Math.abs(angleDiff(Math.atan2(fromFlY, fromFlX), fl.aim))
    const directAwareness =
      flDist <= fl.range * 1.25
        ? fl.awarenessAt
          ? fl.awarenessAt(agent.x, agent.y)
          : flDist <= fl.range &&
              flAngleToAgent <= fl.halfAngle + 0.14 &&
              clearLine(fl.x, fl.y, agent.x, agent.y, sightBlockers)
            ? flOutput * (1 - 0.45 * (flDist / Math.max(1, fl.range)))
            : 0
        : 0
    if (directAwareness > 0.01) {
      // Beam hits the zombie directly!
      const beamGain = 2.6 * config.flashlightBoost * directAwareness
      return {
        seesTarget: offAngle <= periphHalf,
        sensesLight: true,
        sensesProximity: false,
        visualGain: beamGain,
        stimX: target.x,
        stimY: target.y,
        kind: "light",
        effectiveSightRange,
      }
    }

    // Check if the zombie can see a point illuminated by the beam ahead of the player
    if (flDist <= fl.range + maxPoolDist) {
      const fdx = Math.cos(fl.aim)
      const fdy = Math.sin(fl.aim)
      const cached = (fl as FlashlightState & { _beamHit?: number })._beamHit
      const beamHit = cached !== undefined ? cached : Math.min(fl.range, raycast(fl.x, fl.y, fdx, fdy, sightBlockers, fl.range))
      ;(fl as FlashlightState & { _beamHit?: number })._beamHit = beamHit
      for (const frac of [0.5, 0.85]) {
        const bx = fl.x + fdx * (beamHit * frac)
        const by = fl.y + fdy * (beamHit * frac)
        const bDist = Math.hypot(bx - agent.x, by - agent.y)
        if (bDist > maxPoolDist) continue
        const bAngle = Math.abs(angleDiff(Math.atan2(by - agent.y, bx - agent.x), agent.aim))
        if (bAngle <= periphHalf && clearLine(agent.x, agent.y, bx, by, sightBlockers)) {
          const poolGain = 1.45 * config.flashlightBoost * flOutput * (1 - 0.6 * (bDist / Math.max(1, maxPoolDist)))
          return {
            seesTarget: false,
            sensesLight: true,
            sensesProximity: false,
            visualGain: poolGain,
            stimX: bx,
            stimY: by,
            kind: "light",
            effectiveSightRange,
          }
        }
      }
    }
  }

  // 3. Close-range proximity / smell (must have unobstructed line of sight, never through a wall)
  const proxRange = config.proximityRange * agent.perceptionScale * visibility
  if (hasDirectLos && dist <= proxRange) {
    const proxGain = (1.1 + 1.8 * (1 - dist / Math.max(0.2, proxRange)))
    return {
      seesTarget: dist <= 1.25,
      sensesLight: false,
      sensesProximity: true,
      visualGain: proxGain,
      stimX: target.x,
      stimY: target.y,
      kind: "proximity",
      effectiveSightRange,
    }
  }

  return {
    seesTarget: false,
    sensesLight: false,
    sensesProximity: false,
    visualGain: 0,
    stimX: 0,
    stimY: 0,
    kind: "none",
    effectiveSightRange,
  }
}

/**
 * Spatial hash grid for O(1) neighborhood queries (flocking, collision separation, groan propagation).
 */
export class SpatialHash {
  readonly cellSize: number
  readonly cols: number
  readonly rows: number
  private readonly mask: number
  private readonly head: Int32Array
  private next: Int32Array

  constructor(_width: number, _height: number, cellSize = 4, initialCapacity = 128) {
    this.cellSize = cellSize
    // Use 4096 hash buckets so wide streaming worlds (e.g. survivors 960 m apart) never alias modulo 96 m
    this.cols = 64
    this.rows = 64
    this.mask = 4095
    this.head = new Int32Array(4096).fill(-1)
    this.next = new Int32Array(initialCapacity).fill(-1)
  }

  private bucket(cx: number, cy: number): number {
    return (Math.imul(cx, 73856093) ^ Math.imul(cy, 19349663)) & this.mask
  }

  rebuild(agents: readonly Pick<AIAgent, "x" | "y" | "state">[]): void {
    this.head.fill(-1)
    if (agents.length > this.next.length) {
      this.next = new Int32Array(Math.ceil(agents.length * 1.5)).fill(-1)
    }
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i]!
      if (a.state === "dead") {
        this.next[i] = -1
        continue
      }
      const cx = Math.floor(a.x / this.cellSize)
      const cy = Math.floor(a.y / this.cellSize)
      const cell = this.bucket(cx, cy)
      this.next[i] = this.head[cell]!
      this.head[cell] = i
    }
  }

  query(x: number, y: number, radius: number, out: number[]): number[] {
    out.length = 0
    const rawCx0 = Math.floor((x - radius) / this.cellSize)
    const rawCx1 = Math.floor((x + radius) / this.cellSize)
    const rawCy0 = Math.floor((y - radius) / this.cellSize)
    const rawCy1 = Math.floor((y + radius) / this.cellSize)
    for (let cy = rawCy0; cy <= rawCy1; cy++) {
      for (let cx = rawCx0; cx <= rawCx1; cx++) {
        for (let idx = this.head[this.bucket(cx, cy)]!; idx !== -1; idx = this.next[idx]!) {
          out.push(idx)
        }
      }
    }
    return out
  }
}

export const CELL_FREE = 0
export const CELL_BLOCKED = 1
export const CELL_CLOSED_DOOR = 2
export const CELL_OPEN_WINDOW = 3
export const CELL_BARRICADED = 4

/**
 * 8-connected A* navigation grid with portal support (open/closed/barricaded doors and open windows).
 */
export class GridNav {
  readonly cell: number
  readonly w: number
  readonly h: number
  readonly grid: Uint8Array
  /** Optional per-chunk 64×64 walkability tiles keyed by `"cx,cy"` for unbounded streaming worlds. */
  readonly chunkTiles = new Map<string, Uint8Array>()
  private readonly intChunkTiles = new Map<number, Uint8Array>()
  private intTilesSyncedSize = -1
  private lastTileKey = 0x7fffffff
  private lastTile: Uint8Array | undefined
  private readonly g: Float32Array
  private readonly came: Int32Array
  private readonly seen: Uint32Array
  private stamp = 0
  private readonly heap = new MinHeap()
  /** Bumps whenever walkability may have changed (grid rebuilt or chunk tiles swapped/edited). Caches key on it. */
  revision = 0

  constructor(width: number, height: number, cell = 0.5) {
    this.cell = cell
    this.w = Math.ceil(width / cell)
    this.h = Math.ceil(height / cell)
    const n = this.w * this.h
    this.grid = new Uint8Array(n)
    this.g = new Float32Array(n)
    this.came = new Int32Array(n)
    this.seen = new Uint32Array(n)
  }

  rebuild(solids: readonly Rect[], portals: readonly NavPortal[], agentRadius = 0.28): void {
    this.revision++
    this.grid.fill(CELL_FREE)
    const pad = agentRadius + 0.02
    const { w, h, cell, grid } = this
    for (const r of solids) {
      const x0 = Math.max(0, Math.ceil((r[0] - pad) / cell - 0.5))
      const x1 = Math.min(w - 1, Math.floor((r[2] + pad) / cell - 0.5))
      const y0 = Math.max(0, Math.ceil((r[1] - pad) / cell - 0.5))
      const y1 = Math.min(h - 1, Math.floor((r[3] + pad) / cell - 0.5))
      for (let cy = y0; cy <= y1; cy++) {
        grid.fill(CELL_BLOCKED, cy * w + x0, cy * w + x1 + 1)
      }
    }

    // Carve portal channels so doorways and open windows remain traversable despite adjacent wall inflation.
    for (const p of portals) {
      const [rx0, ry0, rx1, ry1] = p.rect
      const horizontal = rx1 - rx0 > ry1 - ry0
      const barricaded = (p.barricadePlanks ?? 0) > 0
      let cellCode = CELL_BLOCKED
      if (p.kind === "door") {
        cellCode = barricaded ? CELL_BARRICADED : p.open ? CELL_FREE : CELL_CLOSED_DOOR
      } else if (p.kind === "window") {
        cellCode = barricaded ? CELL_BARRICADED : p.open ? CELL_OPEN_WINDOW : CELL_BLOCKED
      }
      if (cellCode === CELL_BLOCKED) continue

      const box: Rect = horizontal
        ? [rx0 + 0.18, ry0 - 0.42, rx1 - 0.18, ry1 + 0.42]
        : [rx0 - 0.42, ry0 + 0.18, rx1 + 0.42, ry1 - 0.18]
      const x0 = Math.max(0, Math.floor(box[0] / cell))
      const x1 = Math.min(w - 1, Math.floor(box[2] / cell))
      const y0 = Math.max(0, Math.floor(box[1] / cell))
      const y1 = Math.min(h - 1, Math.floor(box[3] / cell))
      for (let cy = y0; cy <= y1; cy++) {
        for (let cx = x0; cx <= x1; cx++) {
          grid[cy * w + cx] = cellCode
        }
      }
    }
  }

  private syncIntChunkTiles(): void {
    this.intChunkTiles.clear()
    for (const [k, tile] of this.chunkTiles) {
      const comma = k.indexOf(",")
      const cx = Number(k.slice(0, comma)) | 0
      const cy = Number(k.slice(comma + 1)) | 0
      this.intChunkTiles.set(((cx & 0xffff) << 16) | (cy & 0xffff), tile)
    }
    this.intTilesSyncedSize = this.chunkTiles.size
    this.lastTileKey = 0x7fffffff
    this.lastTile = undefined
  }

  invalidateChunkTileCache(): void {
    this.revision++
    this.intTilesSyncedSize = -1
    this.lastTileKey = 0x7fffffff
    this.lastTile = undefined
  }

  /** Cell code at global grid coordinates (chunk tiles when streaming, otherwise the flat grid; blocked outside). */
  codeAt(gx: number, gy: number): number {
    return this.cellCodeAtGrid(gx, gy)
  }

  /** True when the nav reads 64×64 chunk tiles (unbounded streaming world) instead of its flat grid. */
  get streaming(): boolean {
    return this.chunkTiles.size > 0
  }

  /**
   * Copies the `w×h` block of cell codes starting at global cell `(gx0, gy0)` into `out` (row-major), with cells
   * outside the walkable world reported as blocked. Rows are copied as tile or grid runs, not cell by cell.
   */
  copyCodes(gx0: number, gy0: number, w: number, h: number, out: Uint8Array): void {
    if (this.chunkTiles.size > 0) {
      if (this.intTilesSyncedSize !== this.chunkTiles.size) this.syncIntChunkTiles()
      for (let y = 0; y < h; y++) {
        const gy = gy0 + y
        const row = y * w
        let x = 0
        while (x < w) {
          const gx = gx0 + x
          const run = Math.min(w - x, 64 - (gx & 63))
          const tile = this.intChunkTiles.get((((gx >> 6) & 0xffff) << 16) | ((gy >> 6) & 0xffff))
          if (tile) {
            const src = ((gy & 63) << 6) | (gx & 63)
            out.set(tile.subarray(src, src + run), row + x)
          } else {
            out.fill(CELL_BLOCKED, row + x, row + x + run)
          }
          x += run
        }
      }
      return
    }
    for (let y = 0; y < h; y++) {
      const gy = gy0 + y
      const row = y * w
      if (gy < 0 || gy >= this.h) {
        out.fill(CELL_BLOCKED, row, row + w)
        continue
      }
      const sx0 = Math.max(0, gx0)
      const sx1 = Math.min(this.w, gx0 + w)
      if (sx0 > gx0) out.fill(CELL_BLOCKED, row, row + Math.min(w, sx0 - gx0))
      if (sx1 > sx0) out.set(this.grid.subarray(gy * this.w + sx0, gy * this.w + sx1), row + (sx0 - gx0))
      if (sx1 < gx0 + w) out.fill(CELL_BLOCKED, row + Math.max(0, sx1 - gx0), row + w)
    }
  }

  private cellCodeAtGrid(gx: number, gy: number): number {
    if (this.chunkTiles.size > 0) {
      if (this.intTilesSyncedSize !== this.chunkTiles.size) this.syncIntChunkTiles()
      const cx = gx >> 6
      const cy = gy >> 6
      const key = ((cx & 0xffff) << 16) | (cy & 0xffff)
      let tile = key === this.lastTileKey ? this.lastTile : undefined
      if (tile === undefined && key !== this.lastTileKey) {
        tile = this.intChunkTiles.get(key)
        this.lastTileKey = key
        this.lastTile = tile
      }
      if (!tile) return CELL_BLOCKED
      return tile[((gy & 63) << 6) | (gx & 63)]!
    }
    if (gx < 0 || gy < 0 || gx >= this.w || gy >= this.h) return CELL_BLOCKED
    return this.grid[gy * this.w + gx]!
  }

  invalidateTileCache(): void {
    this.invalidateChunkTileCache()
  }

  private idx(p: Vec): number {
    const cx = clamp(Math.floor(p.x / this.cell), 0, this.w - 1)
    const cy = clamp(Math.floor(p.y / this.cell), 0, this.h - 1)
    return cy * this.w + cx
  }

  private center(i: number): Vec {
    return { x: ((i % this.w) + 0.5) * this.cell, y: (Math.floor(i / this.w) + 0.5) * this.cell }
  }

  walkable(p: Vec): boolean {
    if (this.chunkTiles.size > 0) {
      return this.cellCodeAtGrid(Math.floor(p.x / this.cell), Math.floor(p.y / this.cell)) !== CELL_BLOCKED
    }
    return this.grid[this.idx(p)] !== CELL_BLOCKED
  }

  nearest(p: Vec): Vec {
    if (this.chunkTiles.size > 0) {
      const gx0 = Math.floor(p.x / this.cell)
      const gy0 = Math.floor(p.y / this.cell)
      if (this.cellCodeAtGrid(gx0, gy0) !== CELL_BLOCKED) return p
      let bestX = p.x
      let bestY = p.y
      let bd = Infinity
      for (let ring = 1; ring < 64; ring++) {
        if (bd < Infinity && (ring - 1) * this.cell > Math.sqrt(bd)) break
        for (let y = gy0 - ring; y <= gy0 + ring; y++) {
          const edge = y === gy0 - ring || y === gy0 + ring
          for (let x = gx0 - ring; x <= gx0 + ring; x += edge ? 1 : ring * 2) {
            if (this.cellCodeAtGrid(x, y) === CELL_BLOCKED) continue
            const cx = (x + 0.5) * this.cell
            const cy = (y + 0.5) * this.cell
            const d = (cx - p.x) ** 2 + (cy - p.y) ** 2
            if (d < bd) {
              bd = d
              bestX = cx
              bestY = cy
            }
          }
        }
      }
      return { x: bestX, y: bestY }
    }
    const i = this.idx(p)
    if (this.grid[i] !== CELL_BLOCKED) return p
    const cx = i % this.w
    const cy = Math.floor(i / this.w)
    let best = -1
    let bd = Infinity
    for (let ring = 1; ring < Math.max(this.w, this.h); ring++) {
      if (best >= 0 && (ring - 1) * this.cell > Math.sqrt(bd)) break
      for (let y = cy - ring; y <= cy + ring; y++) {
        if (y < 0 || y >= this.h) continue
        const edge = y === cy - ring || y === cy + ring
        for (let x = cx - ring; x <= cx + ring; x += edge ? 1 : ring * 2) {
          if (x < 0 || x >= this.w) continue
          const k = y * this.w + x
          if (this.grid[k] === CELL_BLOCKED) continue
          const c = this.center(k)
          const d = (c.x - p.x) ** 2 + (c.y - p.y) ** 2
          if (d < bd) {
            bd = d
            best = k
          }
        }
      }
    }
    return best >= 0 ? this.center(best) : p
  }

  /** True when a body can walk straight from a to b without crossing blocked or special portal cells. */
  straightFree(a: Vec, b: Vec): boolean {
    const d = Math.hypot(b.x - a.x, b.y - a.y)
    const n = Math.max(1, Math.ceil(d / (this.cell * 0.4)))
    if (this.chunkTiles.size > 0) {
      for (let k = 1; k <= n; k++) {
        const t = k / n
        const wx = a.x + (b.x - a.x) * t
        const wy = a.y + (b.y - a.y) * t
        if (this.cellCodeAtGrid(Math.floor(wx / this.cell), Math.floor(wy / this.cell)) !== CELL_FREE) return false
      }
      return true
    }
    for (let k = 1; k <= n; k++) {
      const t = k / n
      const code = this.grid[this.idx({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })]
      if (code !== CELL_FREE) return false
    }
    return true
  }

  path(from: Vec, to: Vec, maxSteps = 2800): Vec[] | null {
    if (this.chunkTiles.size > 0) {
      const nearFrom = this.nearest(from)
      const nearTo = this.nearest(to)
      const startGx = Math.floor(nearFrom.x / this.cell)
      const startGy = Math.floor(nearFrom.y / this.cell)
      let goalGx = Math.floor(nearTo.x / this.cell)
      let goalGy = Math.floor(nearTo.y / this.cell)
      if (startGx === goalGx && startGy === goalGy) return [to]

      const { g, came, seen, w, h: rows, heap } = this
      const halfW = w >> 1
      const halfH = rows >> 1
      const baseGx = startGx - halfW
      const baseGy = startGy - halfH
      goalGx = clamp(goalGx, baseGx + 1, baseGx + w - 2)
      goalGy = clamp(goalGy, baseGy + 1, baseGy + rows - 2)
      const start = halfH * w + halfW
      const goal = (goalGy - baseGy) * w + (goalGx - baseGx)
      if (start === goal) return [to]

      if (this.stamp > 0xfffffff0) {
        this.stamp = 0
        this.seen.fill(0)
      }
      const open = (this.stamp += 2)
      const shut = open + 1
      heap.clear()
      const gx = goal % w
      const gy = Math.floor(goal / w)
      const heuristic = (i: number) => {
        const dx = Math.abs((i % w) - gx)
        const dy = Math.abs(Math.floor(i / w) - gy)
        return Math.max(dx, dy) + 0.414 * Math.min(dx, dy)
      }
      g[start] = 0
      came[start] = -1
      seen[start] = open
      heap.push(start, heuristic(start))
      let found = false
      let expanded = 0
      let bestFallback = start
      let bestFallbackH = heuristic(start)

      while (heap.size && expanded++ < maxSteps) {
        const cur = heap.pop()
        if (cur === goal) {
          found = true
          break
        }
        if (seen[cur] === shut) continue
        seen[cur] = shut
        const ch = heuristic(cur)
        if (ch < bestFallbackH) {
          bestFallbackH = ch
          bestFallback = cur
        }
        const cx = cur % w
        const cy = Math.floor(cur / w)
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue
            const nx = cx + dx
            const ny = cy + dy
            if (nx < 0 || ny < 0 || nx >= w || ny >= rows) continue
            const ni = ny * w + nx
            if (seen[ni] === shut) continue
            const code = this.cellCodeAtGrid(baseGx + nx, baseGy + ny)
            if (code === CELL_BLOCKED) continue
            if (
              dx &&
              dy &&
              (this.cellCodeAtGrid(baseGx + nx, baseGy + cy) === CELL_BLOCKED ||
                this.cellCodeAtGrid(baseGx + cx, baseGy + ny) === CELL_BLOCKED)
            )
              continue
            const stepCost =
              (dx && dy ? 1.414 : 1) +
              (code === CELL_CLOSED_DOOR ? 5.5 : code === CELL_OPEN_WINDOW ? 2.4 : code === CELL_BARRICADED ? 11.0 : 0)
            const ng = g[cur]! + stepCost
            if (seen[ni] !== open || ng < g[ni]!) {
              seen[ni] = open
              g[ni] = ng
              came[ni] = cur
              heap.push(ni, ng + heuristic(ni))
            }
          }
        }
      }

      const endCell = found ? goal : bestFallback !== start ? bestFallback : -1
      if (endCell === -1) return null
      const cells: Vec[] = []
      for (let c = endCell; c !== start && c !== -1; c = came[c]!) {
        const lx = c % w
        const ly = Math.floor(c / w)
        cells.push({ x: (baseGx + lx + 0.5) * this.cell, y: (baseGy + ly + 0.5) * this.cell })
      }
      cells.reverse()
      if (found && this.walkable(to)) {
        cells[cells.length - 1] = { x: to.x, y: to.y }
      }
      const out: Vec[] = []
      let anchor = from
      for (let i = 0; i < cells.length; i++) {
        const next = cells[i + 1]
        const wp = cells[i]!
        const curCode = this.cellCodeAtGrid(Math.floor(wp.x / this.cell), Math.floor(wp.y / this.cell))
        if (next && out.length < 4 && i < 16 && curCode === CELL_FREE && this.straightFree(anchor, next)) continue
        out.push(wp)
        anchor = wp
      }
      return out
    }
    const start = this.idx(this.nearest(from))
    const goal = this.idx(this.nearest(to))
    if (start === goal) return [to]
    if (this.stamp > 0xfffffff0) {
      this.stamp = 0
      this.seen.fill(0)
    }
    const open = (this.stamp += 2)
    const shut = open + 1
    const { g, came, seen, grid, w, h: rows, heap } = this
    heap.clear()
    const gx = goal % w
    const gy = Math.floor(goal / w)
    const heuristic = (i: number) => {
      const dx = Math.abs((i % w) - gx)
      const dy = Math.abs(Math.floor(i / w) - gy)
      return Math.max(dx, dy) + 0.414 * Math.min(dx, dy)
    }
    g[start] = 0
    came[start] = -1
    seen[start] = open
    heap.push(start, heuristic(start))
    let found = false
    let expanded = 0
    let bestFallback = start
    let bestFallbackH = heuristic(start)

    while (heap.size && expanded++ < maxSteps) {
      const cur = heap.pop()
      if (cur === goal) {
        found = true
        break
      }
      if (seen[cur] === shut) continue
      seen[cur] = shut
      const ch = heuristic(cur)
      if (ch < bestFallbackH) {
        bestFallbackH = ch
        bestFallback = cur
      }
      const cx = cur % w
      const cy = Math.floor(cur / w)
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue
          const nx = cx + dx
          const ny = cy + dy
          if (nx < 0 || ny < 0 || nx >= w || ny >= rows) continue
          const ni = ny * w + nx
          const code = grid[ni]!
          if (code === CELL_BLOCKED || seen[ni] === shut) continue
          if (dx && dy && (grid[cy * w + nx] === CELL_BLOCKED || grid[ny * w + cx] === CELL_BLOCKED)) continue
          const stepCost =
            (dx && dy ? 1.414 : 1) +
            (code === CELL_CLOSED_DOOR ? 5.5 : code === CELL_OPEN_WINDOW ? 2.4 : code === CELL_BARRICADED ? 11.0 : 0)
          const ng = g[cur]! + stepCost
          if (seen[ni] !== open || ng < g[ni]!) {
            seen[ni] = open
            g[ni] = ng
            came[ni] = cur
            heap.push(ni, ng + heuristic(ni))
          }
        }
      }
    }

    const endCell = found ? goal : bestFallback !== start ? bestFallback : -1
    if (endCell === -1) return null
    const cells: Vec[] = []
    for (let c = endCell; c !== start && c !== -1; c = came[c]!) {
      cells.push(this.center(c))
    }
    cells.reverse()
    if (found && this.walkable(to)) {
      cells[cells.length - 1] = { x: to.x, y: to.y }
    }
    // String-pull only across CELL_FREE segments so portal approaches stay aligned with doors/windows.
    const out: Vec[] = []
    let anchor = from
    for (let i = 0; i < cells.length; i++) {
      const next = cells[i + 1]
      const curCode = grid[this.idx(cells[i]!)]
      if (next && (maxSteps >= 2000 || (out.length < 4 && i < 16)) && curCode === CELL_FREE && this.straightFree(anchor, next)) continue
      out.push(cells[i]!)
      anchor = cells[i]!
    }
    return out
  }
}

/** Creates a deterministic AIAgent with seeded individual speed, perception, aggression, and rig variation. */
export function createAIAgent(id: number, seed: number, x: number, y: number, aim?: number): AIAgent {
  const rng = new Rng((seed ^ Math.imul(id + 1, 0x9e3779b9)) >>> 0)
  const initialAim = aim ?? rng.range(-Math.PI, Math.PI)
  const wAngle = initialAim + rng.range(-0.9, 0.9)
  const wDist = rng.range(3.5, 9.0)
  const agentSeed = (seed ^ Math.imul(id + 17, 0x85ebca6b)) >>> 0
  const traits = zombieTraitsFromSeed(agentSeed)
  return {
    id,
    seed: agentSeed,
    x,
    y,
    vx: 0,
    vy: 0,
    aim: initialAim,
    state: "wander",
    awareness: 0,
    targetX: x,
    targetY: y,
    targetKind: "none",
    seesTarget: false,
    lastHeardNoiseId: 0,
    stateTime: 0,
    timer: rng.range(1.2, 4.5),
    path: [],
    repathAt: 0,
    homeX: x,
    homeY: y,
    wanderX: x + Math.cos(wAngle) * wDist,
    wanderY: y + Math.sin(wAngle) * wDist,
    searchIndex: 0,
    speedScale: rng.range(0.84, 1.18),
    perceptionScale: rng.range(0.86, 1.18),
    aggression: rng.range(0.8, 1.28),
    lurch: rng.range(0.55, 0.98),
    asymmetry: rng.range(0.45, 0.95),
    drag: rng.range(0.5, 0.95),
    reach: rng.range(0.55, 0.95),
    hp: 100,
    maxHp: 100,
    toughness: traits.toughness,
    hitReaction: traits.hitReaction,
    deathVariant: traits.deathVariant,
    limping: false,
    hitFlash: 0,
    staggerVx: 0,
    staggerVy: 0,
    attackCooldown: 0,
    activePortalId: null,
    clamberWindowId: null,
    clamberFromX: 0,
    clamberFromY: 0,
    clamberToX: 0,
    clamberToY: 0,
    clamberElapsed: 0,
    clamberDuration: 0.52,
    detachedLimbs: [],
    focusId: "",
  }
}

export type AIWorldContext = {
  time: number
  tick: number
  dt: number
  worldSize: number
  /** Optional explicit world bounds [minX, minY, maxX, maxY] for streaming worlds. */
  worldBounds?: Rect
  /** Optional simulation PRNG state mix for forked rollouts. */
  rngSeedMix?: number
  /** 1.0 during day, up to config.nightMultiplier at night. */
  nightFactor: number
  solids: readonly Rect[]
  walls: readonly Rect[]
  closedDoors: readonly Rect[]
  sightBlockers: readonly Rect[]
  portals: readonly NavPortal[]
  nav: GridNav
  spatial: SpatialHash
  noiseBus: NoiseBus
  config: AIConfig
  targets: readonly PerceptionTarget[]
  /** Shared per-goal flow fields; hunters farther than a few metres from their goal steer by these instead of A*. */
  flow?: FlowFieldCache
  /**
   * How one listener hears one noise, replacing the straight-line wall and door muffling of `attenuateNoise` (a game
   * can muffle noise inside shut buildings, say). Gets the listener's perception scale and the crowd's config.
   */
  hearNoise?: (ev: NoiseEvent, lx: number, ly: number, perceptionScale: number, config: AIConfig) => AttenuatedNoise
  /**
   * A game's behaviour layer: this tick's multiplier on one agent's walking speed (0 holds it where it stands, still
   * able to attack) and on its senses (sight and hearing reach). Absent, every agent steps exactly as before.
   */
  agentSpeed?: (a: AIAgent) => number
  agentSenses?: (a: AIAgent) => number
}

/** Above this many living agents the crowd paths by shared flow fields (when `flowFields` is 1, the default). */
export const FLOW_MIN_CROWD = 64
/** Within this distance of its goal an agent paths on its own (A*) rather than by the shared field. */
const FLOW_NEAR = 3.5
/** Downhill cells walked when picking a flow waypoint (6 m at 0.5 m cells). */
const FLOW_LOOKAHEAD = 12
const flowWaypoint: Vec = { x: 0, y: 0 }
const flowTo: Vec = { x: 0, y: 0 }
let flowAgent: AIAgent | null = null
let flowNav: GridNav | null = null
const flowClear = (tx: number, ty: number): boolean => {
  flowTo.x = tx
  flowTo.y = ty
  return flowNav!.straightFree(flowAgent!, flowTo)
}

export type AIStepResult = {
  bashes: PortalBashEvent[]
  attacks: AgentAttackEvent[]
}

const neighborScratch: number[] = []

/**
 * Struct-of-arrays copy of the fields the neighbour loop reads (position, heading, id, wandering), loaded at the start
 * of a crowd step and rewritten as each agent finishes moving. Neighbour scans then walk contiguous typed arrays
 * instead of chasing a thousand agent objects around the heap. The agents stay the record; this is a hot-loop view.
 */
class CrowdColumns {
  x = new Float64Array(256)
  y = new Float64Array(256)
  aim = new Float64Array(256)
  id = new Int32Array(256)
  wander = new Uint8Array(256)

  load(agents: readonly AIAgent[]): void {
    if (agents.length > this.x.length) {
      const n = Math.ceil(agents.length * 1.5)
      this.x = new Float64Array(n)
      this.y = new Float64Array(n)
      this.aim = new Float64Array(n)
      this.id = new Int32Array(n)
      this.wander = new Uint8Array(n)
    }
    for (let i = 0; i < agents.length; i++) this.write(i, agents[i]!)
  }

  write(i: number, a: AIAgent): void {
    this.x[i] = a.x
    this.y[i] = a.y
    this.aim[i] = a.aim
    this.id[i] = a.id
    this.wander[i] = a.state === "wander" ? 1 : 0
  }
}
const crowd = new CrowdColumns()
const zombieSourceIds: string[] = []
/** Noise-bus source id of agent `id` (`zombie-<id>`), interned so the per-event comparison never builds a string. */
function zombieSourceId(id: number): string {
  return (zombieSourceIds[id] ??= `zombie-${id}`)
}

function pickWanderPoint(
  agent: AIAgent,
  nav: GridNav,
  worldSize: number,
  tick: number,
  worldBounds?: Rect,
  rngSeedMix = 0,
): void {
  const rng = new Rng((agent.seed ^ Math.imul(tick + 1, 0x27d4eb2d) ^ (rngSeedMix >>> 0)) >>> 0)
  const minX = worldBounds ? worldBounds[0] + 2 : 2
  const minY = worldBounds ? worldBounds[1] + 2 : 2
  const maxX = worldBounds ? worldBounds[2] - 2 : worldSize - 2
  const maxY = worldBounds ? worldBounds[3] - 2 : worldSize - 2
  for (let attempt = 0; attempt < 6; attempt++) {
    const anchorX = attempt < 3 ? (agent.x * 0.65 + agent.homeX * 0.35) : agent.x
    const anchorY = attempt < 3 ? (agent.y * 0.65 + agent.homeY * 0.35) : agent.y
    const ang = rng.range(-Math.PI, Math.PI)
    const dist = rng.range(4.0, 11.5)
    const wx = clamp(anchorX + Math.cos(ang) * dist, minX, maxX)
    const wy = clamp(anchorY + Math.sin(ang) * dist, minY, maxY)
    if (nav.walkable({ x: wx, y: wy })) {
      agent.wanderX = wx
      agent.wanderY = wy
      return
    }
  }
  const fallback = nav.nearest({ x: agent.homeX, y: agent.homeY })
  agent.wanderX = fallback.x
  agent.wanderY = fallback.y
}

function findBlockingPortal(
  agent: AIAgent,
  moveDirX: number,
  moveDirY: number,
  portals: readonly NavPortal[],
): NavPortal | undefined {
  let best: NavPortal | undefined
  let bestDist = 1.08
  const ax = agent.x
  const ay = agent.y
  for (let i = 0; i < portals.length; i++) {
    const p = portals[i]!
    const r = p.rect
    if (ax < r[0] - 1.1 || ax > r[2] + 1.1 || ay < r[1] - 1.1 || ay > r[3] + 1.1) continue
    const barricaded = (p.barricadePlanks ?? 0) > 0
    if (p.kind === "door" ? p.open && !barricaded : !p.open && !barricaded) continue
    const d = distToRect(ax, ay, r)
    if (d > bestDist) continue
    const cx = (r[0] + r[2]) * 0.5
    const cy = (r[1] + r[3]) * 0.5
    const toPortalX = cx - ax
    const toPortalY = cy - ay
    const toLen = Math.hypot(toPortalX, toPortalY) || 1
    const dot = (toPortalX / toLen) * moveDirX + (toPortalY / toLen) * moveDirY
    if (dot < 0.15 && d > 0.55) continue
    bestDist = d
    best = p
  }
  return best
}

/** Body radius the crowd collides with (m). */
const BODY_RADIUS = 0.28
const funnelAim: Vec = { x: 0, y: 0 }

/**
 * Doorway funnel. A body steering at `(tx, ty)` through an open door's plane has to be inside the door's clear span
 * (the opening less a body radius each side) for as long as it is within a body radius of the wall, or it catches the
 * jamb. When the straight line would leave that span inside the band, this writes a better aim to `funnelAim`: the
 * span's mouth on the agent's side while it lines up, then straight across to the far mouth. Returns false (aim
 * unchanged) when the line already clears both jambs or crosses no nearby open door.
 */
function funnelThroughDoor(ax: number, ay: number, tx: number, ty: number, portals: readonly NavPortal[]): boolean {
  for (let i = 0; i < portals.length; i++) {
    const p = portals[i]!
    if (p.kind !== "door" || !p.open || (p.barricadePlanks ?? 0) > 0) continue
    const r = p.rect
    if (ax < r[0] - 2.5 || ax > r[2] + 2.5 || ay < r[1] - 2.5 || ay > r[3] + 2.5) continue
    // Door-local frame: u along the opening, v across it.
    const horizontal = r[2] - r[0] > r[3] - r[1]
    const u0 = horizontal ? r[0] : r[1]
    const u1 = horizontal ? r[2] : r[3]
    const vc = horizontal ? (r[1] + r[3]) * 0.5 : (r[0] + r[2]) * 0.5
    const halfT = (horizontal ? r[3] - r[1] : r[2] - r[0]) * 0.5
    const au = horizontal ? ax : ay
    const av = (horizontal ? ay : ax) - vc
    const tu = horizontal ? tx : ty
    const tv = (horizontal ? ty : tx) - vc
    const band = halfT + BODY_RADIUS + 0.04
    const agentIn = Math.abs(av) < band
    const targetIn = Math.abs(tv) < band
    const crossing = av * tv < 0
    // In the doorway proper (within the wall's thickness, plus a little).
    const inDoorway = Math.abs(av) <= halfT + 0.06
    // Through this door: from one side to the other, aiming into the doorway from outside, or standing in it.
    if (!(crossing || (targetIn && !agentIn) || inDoorway)) continue
    const side = crossing || !agentIn ? Math.sign(av) || 1 : -Math.sign(tv) || Math.sign(av) || 1
    const dv = tv - av
    const uAt = (v: number) => (Math.abs(dv) > 1e-6 ? au + ((tu - au) * (v - av)) / dv : tu)
    const crossU = targetIn && !crossing ? tu : uAt(0)
    if (crossU < u0 - 1.2 || crossU > u1 + 1.2) continue
    const margin = 0.05
    let lo = u0 + BODY_RADIUS + margin
    let hi = u1 - BODY_RADIUS - margin
    if (lo > hi) lo = hi = (u0 + u1) * 0.5
    // Where the straight line meets each band edge (the agent's own u if it is already inside the band).
    const nearV = side * band
    const farV = -side * band
    const uNear = agentIn ? au : uAt(nearV)
    const uFar = targetIn ? tu : uAt(farV)
    if (uNear >= lo && uNear <= hi && uFar >= lo && uFar <= hi) return false
    let aimU: number
    let aimV: number
    if (!agentIn) {
      // Line up on the near mouth first, a body radius off the wall face, then step into the band.
      aimU = clamp(crossU, lo, hi)
      aimV = side * (band - 0.08)
    } else if (au < lo - 0.02 || au > hi + 0.02) {
      // In the band beside the opening (against the wall face): slide along it into the span.
      aimU = clamp(au, lo, hi)
      aimV = av - side * 0.12
    } else {
      // In the span: straight across to the far mouth, then out.
      aimU = clamp(uFar, lo, hi)
      aimV = farV - side * 0.2
    }
    funnelAim.x = horizontal ? aimU : aimV + vc
    funnelAim.y = horizontal ? aimV + vc : aimU
    return true
  }
  return false
}

function computeWindowClamberDest(win: NavPortal, fromX: number, fromY: number): { toX: number; toY: number; aim: number } {
  const [x0, y0, x1, y1] = win.rect
  const horizontal = x1 - x0 > y1 - y0
  const wx = (x0 + x1) * 0.5
  const wy = (y0 + y1) * 0.5
  const clearance = 0.56
  if (horizontal) {
    const intoNorth = fromY >= wy
    return {
      toX: wx,
      toY: intoNorth ? y0 - clearance : y1 + clearance,
      aim: intoNorth ? -Math.PI / 2 : Math.PI / 2,
    }
  }
  const intoWest = fromX >= wx
  return {
    toX: intoWest ? x0 - clearance : x1 + clearance,
    toY: wy,
    aim: intoWest ? Math.PI : 0,
  }
}

/** The target an agent attends to: its focus when several survivors are present, otherwise the only target. */
function focusOf(a: AIAgent, targets: readonly PerceptionTarget[]): PerceptionTarget | undefined {
  if (targets.length <= 1) return targets[0]
  for (const t of targets) if (t.id === a.focusId) return t
  return targets[0]
}

function focusScore(a: AIAgent, target: PerceptionTarget, sight: SightEvaluation): number {
  const dist = Math.hypot(target.x - a.x, target.y - a.y)
  return (sight.seesTarget ? 100 : 0) + sight.visualGain * (target.id === a.focusId ? 1.3 : 1) - dist * 0.01
}

/**
 * Advances the entire AI crowd for one fixed tick.
 * Uses spatial hashing and staggered perception/repath updates to stay well under 1 ms for 50–100 agents.
 */
export function stepAICrowd(agents: AIAgent[], ctx: AIWorldContext): AIStepResult {
  const { dt, time, tick, worldSize, worldBounds, rngSeedMix = 0, nightFactor, solids, walls, closedDoors, sightBlockers, portals, nav, spatial, noiseBus, config, targets } = ctx
  let living = 0
  for (let i = 0; i < agents.length; i++) if (agents[i]!.state !== "dead") living++
  const flowMode = config.flowFields ?? 1
  const flow = flowMode === 2 || (flowMode === 1 && living > FLOW_MIN_CROWD) ? ctx.flow : undefined
  flow?.beginTick(targets)
  flowNav = nav
  const minX = worldBounds ? worldBounds[0] + 0.5 : 0.5
  const minY = worldBounds ? worldBounds[1] + 0.5 : 0.5
  const maxX = worldBounds ? worldBounds[2] - 0.5 : worldSize - 0.5
  const maxY = worldBounds ? worldBounds[3] - 0.5 : worldSize - 0.5
  const bashes: PortalBashEvent[] = []
  const attacks: AgentAttackEvent[] = []

  noiseBus.prune(time)
  spatial.rebuild(agents)
  crowd.load(agents)

  // Emit continuous movement noise from targets into the noise bus (throttled via coalesceWindow).
  for (const t of targets) {
    if (t.continuousNoiseRadius >= 3.2) {
      const speed = Math.hypot(t.vx, t.vy)
      if (speed > 0.25) {
        noiseBus.emit({
          x: t.x,
          y: t.y,
          radius: t.continuousNoiseRadius,
          kind: t.continuousNoiseRadius > 7 ? "sprint" : "footstep",
          sourceId: t.id,
          time,
          ttl: 0.55,
          coalesceWindow: 0.25,
        })
      }
    }
  }

  const MAX_REPATHS_PER_TICK = agents.length >= 250 ? 2 : 4
  const maxPathSteps = agents.length >= 250 ? 900 : 2800
  let repathsThisTick = 0
  const largeCrowd = agents.length > 64

  for (let i = 0; i < agents.length; i++) {
    // Agents before i have finished their step: publish it so neighbours read where they are now.
    if (i > 0) crowd.write(i - 1, agents[i - 1]!)
    const a = agents[i]!
    if (a.state === "dead") {
      a.stateTime += dt
      if (a.stateTime < 0.35 && (Math.abs(a.staggerVx) > 0.05 || Math.abs(a.staggerVy) > 0.05)) {
        a.x += a.staggerVx * dt
        a.y += a.staggerVy * dt
        const damp = Math.exp(-dt * 8)
        a.staggerVx *= damp
        a.staggerVy *= damp
        pushOut(a, 0.28, solids)
        a.x = clamp(a.x, minX, maxX)
        a.y = clamp(a.y, minY, maxY)
      } else {
        a.staggerVx = 0
        a.staggerVy = 0
      }
      a.vx = 0
      a.vy = 0
      a.hitFlash = Math.max(0, a.hitFlash - dt * 4)
      continue
    }

    // In large crowds (>64), distant idle wanderers (>36 m from all survivors) step movement/collision at 20-30 Hz
    if (largeCrowd && a.state === "wander" && a.awareness === 0 && a.hitFlash === 0) {
      let minD2 = Infinity
      for (let k = 0; k < targets.length; k++) {
        const t = targets[k]!
        const dx = t.x - a.x
        const dy = t.y - a.y
        const d2 = dx * dx + dy * dy
        if (d2 < minD2) minD2 = d2
      }
      if (minD2 > 36 * 36 && ((a.id + tick) & 1) !== 0) {
        a.stateTime += dt
        a.timer -= dt
        a.x = clamp(a.x + a.vx * dt, minX, maxX)
        a.y = clamp(a.y + a.vy * dt, minY, maxY)
        continue
      }
    }

    a.stateTime += dt
    a.hitFlash = Math.max(0, a.hitFlash - dt * 5)
    if (a.attackCooldown > 0) a.attackCooldown = Math.max(0, a.attackCooldown - dt)

    const prevX = a.x
    const prevY = a.y

    // Handle active window clambering
    if (a.clamberWindowId) {
      a.clamberElapsed += dt
      const u = clamp(a.clamberElapsed / Math.max(0.1, a.clamberDuration), 0, 1)
      const s = u * u * (3 - 2 * u)
      a.x = a.clamberFromX + (a.clamberToX - a.clamberFromX) * s
      a.y = a.clamberFromY + (a.clamberToY - a.clamberFromY) * s
      a.aim = Math.atan2(a.clamberToY - a.clamberFromY, a.clamberToX - a.clamberFromX)
      if (u >= 1) {
        a.x = a.clamberToX
        a.y = a.clamberToY
        a.clamberWindowId = null
        a.repathAt = 0
      }
      a.vx = dt > 0 ? (a.x - prevX) / dt : 0
      a.vy = dt > 0 ? (a.y - prevY) / dt : 0
      continue
    }

    // Handle stagger state (from bullet hits, melee shove, or light melee swings)
    if (a.state === "stagger") {
      a.timer -= dt
      a.x += a.staggerVx * dt
      a.y += a.staggerVy * dt
      const damp = Math.exp(-dt * 9)
      a.staggerVx *= damp
      a.staggerVy *= damp
      pushOut(a, 0.28, solids)
      a.x = clamp(a.x, minX, maxX)
      a.y = clamp(a.y, minY, maxY)
      a.vx = dt > 0 ? (a.x - prevX) / dt : 0
      a.vy = dt > 0 ? (a.y - prevY) / dt : 0
      if (a.timer <= 0) {
        a.state = hasSeveredLeg(a) ? "crawler" : a.awareness >= 0.55 ? "chase" : "investigate"
        a.stateTime = 0
        a.repathAt = 0
      }
      continue
    }

    // Handle knockdown state (from heavy melee swings, bats, spiked boards, gunshots, or combo finishers)
    if (a.state === "knockdown") {
      a.timer -= dt
      if (a.stateTime < 0.42) {
        a.x += a.staggerVx * dt
        a.y += a.staggerVy * dt
      }
      const damp = Math.exp(-dt * 8)
      a.staggerVx *= damp
      a.staggerVy *= damp
      pushOut(a, 0.28, solids)
      a.x = clamp(a.x, minX, maxX)
      a.y = clamp(a.y, minY, maxY)
      a.vx = dt > 0 ? (a.x - prevX) / dt : 0
      a.vy = dt > 0 ? (a.y - prevY) / dt : 0
      if (a.timer <= 0) {
        a.state = hasSeveredLeg(a) ? "crawler" : a.awareness >= 0.55 ? "chase" : "investigate"
        a.stateTime = 0
        a.repathAt = 0
      }
      continue
    }

    if (hasSeveredLeg(a) && a.state !== "crawler" && a.state !== "bash") {
      a.state = "crawler"
      a.stateTime = 0
    }

    // Staggered perception cadence: engaged zombies check every 2 ticks, idle wanderers every 4 ticks
    const isEngaged = a.state === "chase" || a.state === "alert" || a.state === "crawler"
    const scheduledTick = (a.id + tick) % (isEngaged ? 2 : 4) === 0
    const shouldSense = scheduledTick || tick === 0
    const senseDt = dt * (scheduledTick ? (isEngaged ? 2 : 4) : 1)

    if (shouldSense && targets.length > 0) {
      const senseMul = ctx.agentSenses ? ctx.agentSenses(a) : 1
      const effectivePerceptionAgent = {
        x: a.x,
        y: a.y,
        aim: a.aim,
        perceptionScale: a.perceptionScale * Math.sqrt(nightFactor) * senseMul,
      }
      let target = targets[0]!
      let sight = evaluateSight(effectivePerceptionAgent, target, sightBlockers, config)
      if (targets.length > 1) {
        // Several survivors: attend to the strongest stimulus, with a little stickiness to the current focus.
        let best = focusScore(a, target, sight)
        for (let k = 1; k < targets.length; k++) {
          const other = targets[k]!
          const otherSight = evaluateSight(effectivePerceptionAgent, other, sightBlockers, config)
          const score = focusScore(a, other, otherSight)
          if (score > best) {
            best = score
            target = other
            sight = otherSight
          }
        }
      }
      a.focusId = target.id
      a.seesTarget = sight.seesTarget

      if (sight.visualGain > 0) {
        a.awareness = clamp(a.awareness + sight.visualGain * senseDt, 0, 1)
        a.targetX = sight.stimX
        a.targetY = sight.stimY
        a.targetKind = sight.kind
      } else {
        const decayRate = a.state === "chase" ? 0.14 : a.state === "search" ? 0.18 : 0.25
        a.awareness = Math.max(0, a.awareness - decayRate * senseDt)
      }

      // Check discrete noise events on the bus
      const selfSource = zombieSourceId(a.id)
      let bestNoiseScore = 0
      let bestNoise: NoiseEvent | null = null
      for (let eIdx = 0; eIdx < noiseBus.events.length; eIdx++) {
        const ev = noiseBus.events[eIdx]!
        if (ev.sourceId === selfSource) continue
        // Groans from other zombies only pull wanderers/searchers, not already-chasing zombies
        if (ev.kind === "groan" && (a.state === "chase" || a.state === "alert" || a.state === "bash")) continue
        const hearScale = a.perceptionScale * Math.sqrt(nightFactor) * senseMul
        const att = ctx.hearNoise
          ? ctx.hearNoise(ev, a.x, a.y, hearScale, config)
          : attenuateNoise(ev.x, ev.y, ev.radius, ev.loudness, a.x, a.y, walls, closedDoors, config, hearScale)
        if (!att.audible) continue
        const freshness = clamp(1 - (time - ev.time) / Math.max(0.2, ev.ttl), 0.2, 1)
        const score = att.perceivedLoudness * freshness
        if (score > bestNoiseScore) {
          bestNoiseScore = score
          bestNoise = ev
        }
      }

      if (bestNoise && (!a.seesTarget || bestNoise.kind === "gunshot")) {
        const isNewImpulse = bestNoise.id !== a.lastHeardNoiseId
        const isGroan = bestNoise.kind === "groan"
        const audioGain = isNewImpulse
          ? isGroan
            ? clamp(bestNoiseScore * 0.48, 0.06, 0.36)
            : clamp(bestNoiseScore * 0.72, 0.08, 0.68)
          : bestNoiseScore * (isGroan ? 0.22 : 0.55) * senseDt
        const maxAudioAwareness = isGroan ? 0.52 : 1.0
        a.awareness = clamp(Math.min(maxAudioAwareness, a.awareness + audioGain), 0, 1)
        a.lastHeardNoiseId = bestNoise.id
        if (!a.seesTarget) {
          a.targetX = bestNoise.x
          a.targetY = bestNoise.y
          a.targetKind = "noise"
          if (isNewImpulse && bestNoiseScore > 0.25) {
            a.repathAt = 0
          }
        }
      }
    }

    // State machine transitions
    if (a.state === "wander") {
      if (a.seesTarget && a.awareness >= 0.65) {
        a.state = "alert"
        a.stateTime = 0
        a.timer = config.alertDuration
        noiseBus.emit({
          x: a.x,
          y: a.y,
          radius: 8.5,
          loudness: 0.7,
          kind: "groan",
          sourceId: zombieSourceId(a.id),
          time,
          ttl: 0.7,
          coalesceWindow: 1.5,
        })
      } else if (a.awareness >= 0.32) {
        a.state = "investigate"
        a.stateTime = 0
        a.repathAt = 0
      }
    } else if (a.state === "investigate") {
      if ((a.seesTarget && a.awareness >= 0.65) || a.awareness >= 0.88) {
        a.state = "alert"
        a.stateTime = 0
        a.timer = config.alertDuration
        noiseBus.emit({
          x: a.x,
          y: a.y,
          radius: 8.5,
          loudness: 0.7,
          kind: "groan",
          sourceId: zombieSourceId(a.id),
          time,
          ttl: 0.7,
          coalesceWindow: 1.5,
        })
      } else if (Math.hypot(a.targetX - a.x, a.targetY - a.y) < 0.95) {
        a.state = "search"
        a.stateTime = 0
        a.timer = config.searchDuration * 0.7
        a.searchIndex = 0
      } else if (a.awareness <= 0.08 && a.stateTime > 4.0) {
        a.state = "wander"
        a.stateTime = 0
      }
    } else if (a.state === "alert") {
      const wantAim = Math.atan2(a.targetY - a.y, a.targetX - a.x)
      a.aim += clamp(angleDiff(wantAim, a.aim), -dt * 9, dt * 9)
      a.timer -= dt
      if (a.timer <= 0) {
        a.state = "chase"
        a.stateTime = 0
        a.repathAt = 0
      }
    } else if (a.state === "chase" || a.state === "crawler") {
      const focus = focusOf(a, targets)
      if (a.seesTarget && focus) {
        a.targetX = focus.x
        a.targetY = focus.y
      } else if (a.state === "chase" && (Math.hypot(a.targetX - a.x, a.targetY - a.y) < 0.95 || a.stateTime > 8.0)) {
        if (!a.seesTarget) {
          a.state = "search"
          a.stateTime = 0
          a.timer = config.searchDuration
          a.searchIndex = 0
        }
      }
    } else if (a.state === "bash") {
      const portal = portals.find((p) => p.id === a.activePortalId)
      const stillBlocking =
        portal &&
        ((portal.kind === "door" && (!portal.open || (portal.barricadePlanks ?? 0) > 0)) ||
          (portal.kind === "window" && (portal.barricadePlanks ?? 0) > 0)) &&
        distToRect(a.x, a.y, portal.rect) <= 1.25
      if (!stillBlocking) {
        a.activePortalId = null
        a.state = hasSeveredLeg(a) ? "crawler" : a.awareness >= 0.5 ? "chase" : "investigate"
        a.stateTime = 0
        a.repathAt = 0
      } else {
        const cx = (portal.rect[0] + portal.rect[2]) * 0.5
        const cy = (portal.rect[1] + portal.rect[3]) * 0.5
        const want = Math.atan2(cy - a.y, cx - a.x)
        a.aim += clamp(angleDiff(want, a.aim), -dt * 8, dt * 8)
        a.timer -= dt * a.aggression * config.aggression
        if (a.timer <= 0) {
          a.timer = config.bashInterval
          bashes.push({
            agentId: a.id,
            portalId: portal.id,
            portalKind: portal.kind,
            x: cx,
            y: cy,
            damage: 34 * a.aggression * config.aggression,
          })
          noiseBus.emit({
            x: cx,
            y: cy,
            radius: 14.0,
            loudness: 1.1,
            kind: "bash",
            sourceId: zombieSourceId(a.id),
            time,
            ttl: 0.85,
            coalesceWindow: 0.4,
          })
        }
      }
    } else if (a.state === "search") {
      a.timer -= dt
      if (a.seesTarget && a.awareness >= 0.55) {
        a.state = "chase"
        a.stateTime = 0
        a.repathAt = 0
      } else if (a.timer <= 0 || a.awareness <= 0.05) {
        a.state = "wander"
        a.stateTime = 0
        a.awareness = 0
        a.targetKind = "none"
        pickWanderPoint(a, nav, worldSize, tick, worldBounds, rngSeedMix)
      }
    }

    // Movement & steering per state
    let moveDirX = 0
    let moveDirY = 0
    let desiredSpeed = 0
    // The point being steered at (NaN when steering by direction only), for the corner slide's choice of side.
    let steerX = Number.NaN
    let steerY = Number.NaN

    if (a.state === "wander") {
      a.timer -= dt
      if (a.timer <= 0 || Math.hypot(a.wanderX - a.x, a.wanderY - a.y) < 0.95) {
        pickWanderPoint(a, nav, worldSize, tick, worldBounds, rngSeedMix)
        a.timer = 3.2 + ((a.id * 17 + tick) % 5)
      }
      const dx = a.wanderX - a.x
      const dy = a.wanderY - a.y
      const d = Math.hypot(dx, dy)
      if (d > 0.2) {
        moveDirX = dx / d
        moveDirY = dy / d
        // Organic shambling lurch: cadence surges on the stepping beat and drags between steps
        const lurchPhase = (time * (1.35 + (a.id % 5) * 0.12) + a.id * 0.7) % 1
        const lurchPulse = 0.76 + 0.38 * Math.pow(Math.sin(lurchPhase * Math.PI), 2)
        desiredSpeed = config.walkSpeed * a.speedScale * lurchPulse * (0.92 + 0.08 * nightFactor)
      }
    } else if (a.state === "investigate" || a.state === "chase" || a.state === "crawler") {
      const goalX = a.targetX
      const goalY = a.targetY
      const distToGoal = Math.hypot(goalX - a.x, goalY - a.y)
      const isCrawler = a.state === "crawler"
      const limbs = a.detachedLimbs
      const leftArmGone = limbs.length > 0 && (limbs.includes("left.upperArm") || limbs.includes("left.foreArm"))
      const rightArmGone = limbs.length > 0 && (limbs.includes("right.upperArm") || limbs.includes("right.foreArm"))
      const armFactor = leftArmGone && rightArmGone ? 0.52 : leftArmGone || rightArmGone ? 0.78 : 1.0

      // Check close-range attack against survivor when chasing or crawling (ankle-grab)
      const focus = focusOf(a, targets)
      const attackRange = isCrawler ? 0.88 : 0.92
      if ((a.state === "chase" || isCrawler) && a.seesTarget && focus && distToGoal <= attackRange) {
        const want = Math.atan2(focus.y - a.y, focus.x - a.x)
        a.aim += clamp(angleDiff(want, a.aim), -dt * 10, dt * 10)
        if (a.attackCooldown <= 0) {
          a.attackCooldown = (isCrawler ? 1.25 : 1.05) / Math.max(0.5, a.aggression * config.aggression)
          attacks.push({
            agentId: a.id,
            targetId: focus.id,
            x: a.x,
            y: a.y,
            damage: Math.round((isCrawler ? 12 : 20) * config.aggression * armFactor),
            ...(isCrawler ? { ankleGrab: true } : {}),
          })
        }
        desiredSpeed = config.walkSpeed * (isCrawler ? 0.12 : 0.25)
      } else {
        // Fan out chasing packs slightly so zombies form a crescent instead of single-file stacking
        const fanOffset =
          (a.state === "chase" || isCrawler) && distToGoal > 2.2
            ? (((a.id % 5) - 2) * 0.38) * clamp((distToGoal - 1.5) / 6, 0, 1)
            : 0
        const toGoalAngle = Math.atan2(goalY - a.y, goalX - a.x)
        const effGoalX = goalX + Math.cos(toGoalAngle + Math.PI / 2) * fanOffset
        const effGoalY = goalY + Math.sin(toGoalAngle + Math.PI / 2) * fanOffset

        const shouldCheckStraight =
          a.seesTarget && (!largeCrowd || a.path.length === 0 || ((a.id + tick) & 3) === 0)
        const canWalkStraight =
          shouldCheckStraight &&
          (largeCrowd && a.path.length === 0 && time < a.repathAt
            ? true
            : nav.straightFree(a, { x: effGoalX, y: effGoalY }))
        if (canWalkStraight) {
          if (largeCrowd && time >= a.repathAt) a.repathAt = time + 0.2
          a.path.length = 0
          const ed = Math.hypot(effGoalX - a.x, effGoalY - a.y) || 1
          moveDirX = (effGoalX - a.x) / ed
          moveDirY = (effGoalY - a.y) / ed
          steerX = effGoalX
          steerY = effGoalY
        } else {
          const repathDue = time >= a.repathAt || a.path.length === 0
          let routed = false
          // Shared flow field: every agent heading for the same goal reads one cost field and steers to the farthest
          // downhill cell it can walk straight to. Close in (or off the field) the agent falls back to its own A*.
          if (flow && distToGoal > FLOW_NEAR) {
            while (a.path.length > 0 && Math.hypot(a.path[0]!.x - a.x, a.path[0]!.y - a.y) < 0.48) {
              a.path.shift()
            }
          }
          if (flow && distToGoal > FLOW_NEAR && (time >= a.repathAt || a.path.length === 0)) {
            const field = flow.field(goalX, goalY)
            flowAgent = a
            let found = field !== null && field.waypoint(a.x, a.y, FLOW_LOOKAHEAD, flowClear, flowWaypoint)
            // At the field's seed (a coarse goal quantum) the rest is the agent's own: straight if it can.
            if (field !== null && !found && flowClear(goalX, goalY)) {
              flowWaypoint.x = goalX
              flowWaypoint.y = goalY
              found = true
            }
            if (found) {
              const wp = a.path.length === 1 ? a.path[0]! : { x: 0, y: 0 }
              wp.x = flowWaypoint.x
              wp.y = flowWaypoint.y
              if (a.path.length !== 1) a.path = [wp]
              a.repathAt = time + 0.24 + (a.id % 5) * 0.03
              routed = true
            }
          }
          if (!routed && (repathDue || a.path.length === 0) && repathsThisTick < MAX_REPATHS_PER_TICK) {
            repathsThisTick++
            a.path = nav.path(a, { x: goalX, y: goalY }, maxPathSteps) ?? [{ x: goalX, y: goalY }]
            a.repathAt = time + (a.state === "chase" || isCrawler ? 0.42 : 0.75) + (a.id % 5) * 0.07
          }
          while (a.path.length > 0 && Math.hypot(a.path[0]!.x - a.x, a.path[0]!.y - a.y) < 0.48) {
            a.path.shift()
          }
          const wp = a.path[0] ?? { x: goalX, y: goalY }
          const wdx = wp.x - a.x
          const wdy = wp.y - a.y
          const wd = Math.hypot(wdx, wdy) || 1
          moveDirX = wdx / wd
          moveDirY = wdy / wd
          steerX = wp.x
          steerY = wp.y
        }
        // Through an open doorway, line up on its clear span rather than clipping a jamb.
        if (funnelThroughDoor(a.x, a.y, steerX, steerY, portals)) {
          const fdx = funnelAim.x - a.x
          const fdy = funnelAim.y - a.y
          const fd = Math.hypot(fdx, fdy)
          if (fd > 1e-3) {
            moveDirX = fdx / fd
            moveDirY = fdy / fd
            steerX = funnelAim.x
            steerY = funnelAim.y
          }
        }

        if (isCrawler) {
          const torsoOnly = isTorsoCrawler(a)
          const crawlPulse = 0.68 + 0.42 * Math.pow(Math.sin(time * 3.1 + a.id * 0.9), 2)
          const crawlBase = config.walkSpeed * (torsoOnly ? 0.34 : 0.48) * armFactor
          desiredSpeed = crawlBase * a.speedScale * crawlPulse * (0.92 + 0.08 * nightFactor)
        } else {
          const baseSpeed = a.state === "chase" ? config.chaseSpeed : config.walkSpeed * 1.35
          desiredSpeed = baseSpeed * a.speedScale * (0.92 + 0.08 * nightFactor)
        }

        // Check if a closed door, barricaded opening, or open window is right in front of the agent
        const portal = findBlockingPortal(a, moveDirX, moveDirY, portals)
        if (portal) {
          const barricaded = (portal.barricadePlanks ?? 0) > 0
          if (!isCrawler && portal.kind === "window" && portal.open && !barricaded) {
            const dest = computeWindowClamberDest(portal, a.x, a.y)
            a.clamberWindowId = portal.id
            a.clamberFromX = a.x
            a.clamberFromY = a.y
            a.clamberToX = dest.toX
            a.clamberToY = dest.toY
            a.clamberElapsed = 0
            a.clamberDuration = 0.52 / Math.max(0.7, a.speedScale)
            desiredSpeed = 0
          } else if ((portal.kind === "door" && (!portal.open || barricaded)) || (!isCrawler && portal.kind === "window" && barricaded)) {
            a.state = "bash"
            a.stateTime = 0
            a.activePortalId = portal.id
            a.timer = config.bashInterval * 0.45
            desiredSpeed = 0
          }
        }
      }
    } else if (a.state === "search") {
      // Search around Last Known Position: alternate between stepping to local offsets and sweeping head/aim
      const searchAngle = a.seed * 0.001 + a.searchIndex * 2.15
      const sx = a.targetX + Math.cos(searchAngle) * 2.1
      const sy = a.targetY + Math.sin(searchAngle) * 2.1
      const d = Math.hypot(sx - a.x, sy - a.y)
      if (d < 0.65) {
        // Pause and look left/right before advancing to the next search point
        const lookWave = Math.sin(a.stateTime * 3.2 + a.id) * 0.85
        const want = searchAngle + lookWave
        a.aim += clamp(angleDiff(want, a.aim), -dt * 3.4, dt * 3.4)
        if ((a.stateTime + a.id * 0.3) % 1.4 < dt * 1.5) {
          a.searchIndex++
        }
      } else {
        moveDirX = (sx - a.x) / d
        moveDirY = (sy - a.y) / d
        desiredSpeed = config.walkSpeed * a.speedScale * 0.85
      }
    }

    if (a.limping && a.state !== "crawler") {
      const limpPhase = (time * 1.45 + a.id * 0.5) % 1
      const limpHitch = 0.52 + 0.22 * Math.sin(limpPhase * Math.PI)
      desiredSpeed *= limpHitch
    }
    if (ctx.agentSpeed) desiredSpeed *= ctx.agentSpeed(a)

    // Apply local Boids flocking (non-clumping personal space separation + loose street pack cohesion)
    const isWander = a.state === "wander"
    const sepRadius = isWander ? 1.65 : 1.28
    const queryRadius = isWander ? 4.8 : sepRadius
    const maxR2 = queryRadius * queryRadius
    const sepR2 = sepRadius * sepRadius
    const neighbors = spatial.query(a.x, a.y, queryRadius, neighborScratch)
    let sepX = 0
    let sepY = 0
    let cohX = 0
    let cohY = 0
    let alignX = 0
    let alignY = 0
    let flockCount = 0

    const { x: colX, y: colY, aim: colAim, id: colId, wander: colWander } = crowd
    const ax = a.x
    const ay = a.y
    for (let k = 0; k < neighbors.length; k++) {
      const j = neighbors[k]!
      if (j === i) continue
      const dx = ax - colX[j]!
      const dy = ay - colY[j]!
      const d2 = dx * dx + dy * dy
      if (d2 >= maxR2) continue
      if (d2 < 1e-6) {
        sepX += (a.id > colId[j]! ? 1 : -1) * 0.7
        continue
      }
      if (d2 < sepR2) {
        const d = Math.sqrt(d2)
        const u = (sepRadius - d) / sepRadius
        const push = u * u * 1.85 + u * 0.55
        sepX += (dx / d) * push
        sepY += (dy / d) * push
      } else if (isWander && colWander[j] === 1 && d2 >= 1.8 * 1.8) {
        cohX += colX[j]!
        cohY += colY[j]!
        alignX += Math.cos(colAim[j]!)
        alignY += Math.sin(colAim[j]!)
        flockCount++
      }
    }

    if (flockCount > 0 && a.state === "wander") {
      const cx = cohX / flockCount - a.x
      const cy = cohY / flockCount - a.y
      const cl = Math.hypot(cx, cy) || 1
      moveDirX += (cx / cl) * 0.14 + (alignX / flockCount) * 0.12
      moveDirY += (cy / cl) * 0.14 + (alignY / flockCount) * 0.12
    }

    moveDirX += sepX
    moveDirY += sepY
    const moveLen = Math.hypot(moveDirX, moveDirY)
    if (moveLen > 1e-4 && desiredSpeed > 0) {
      const ux = moveDirX / moveLen
      const uy = moveDirY / moveLen
      const expectedStep = desiredSpeed * dt
      a.x += ux * expectedStep
      a.y += uy * expectedStep
      pushOut(a, 0.28, solids)

      // Corner-slide recovery: if a wall/corner ate most of the step, slide along the open tangent
      const progressed = (a.x - prevX) * ux + (a.y - prevY) * uy
      if (progressed < expectedStep * 0.42) {
        const tang1X = -uy
        const tang1Y = ux
        const probe1 = { x: prevX + tang1X * expectedStep * 0.85, y: prevY + tang1Y * expectedStep * 0.85 }
        pushOut(probe1, 0.28, solids)
        const probe2 = { x: prevX - tang1X * expectedStep * 0.85, y: prevY - tang1Y * expectedStep * 0.85 }
        pushOut(probe2, 0.28, solids)
        const d1 = Math.hypot(probe1.x - prevX, probe1.y - prevY)
        const d2 = Math.hypot(probe2.x - prevX, probe2.y - prevY)
        if (Math.max(d1, d2) > expectedStep * 0.45) {
          // Both sides open: slide the way that closes on the steering point (a jamb corner is passed, not fled).
          const bothOpen = Math.min(d1, d2) > expectedStep * 0.45
          const toward =
            bothOpen && !Number.isNaN(steerX)
              ? Math.hypot(probe1.x - steerX, probe1.y - steerY) <= Math.hypot(probe2.x - steerX, probe2.y - steerY)
              : d1 >= d2
          const bestProbe = toward ? probe1 : probe2
          a.x = bestProbe.x
          a.y = bestProbe.y
        }
        if (a.path.length > 1) a.path.shift()
      }

      const actualDx = a.x - prevX
      const actualDy = a.y - prevY
      const actualMoveAngle = Math.hypot(actualDx, actualDy) > expectedStep * 0.2 ? Math.atan2(actualDy, actualDx) : Math.atan2(uy, ux)
      const seen = a.seesTarget ? focusOf(a, targets) : undefined
      const wantAim = seen ? Math.atan2(seen.y - a.y, seen.x - a.x) : actualMoveAngle
      const turnRate =
        (a.state === "chase" ? 6.8 : a.state === "investigate" || a.state === "search" ? 3.8 : 2.3) * dt
      a.aim += clamp(angleDiff(wantAim, a.aim), -turnRate, turnRate)
    } else {
      pushOut(a, 0.28, solids)
    }

    a.x = clamp(a.x, minX, maxX)
    a.y = clamp(a.y, minY, maxY)

    // Redirect wander waypoint if agent got stuck against an obstacle
    const actualMoved = Math.hypot(a.x - prevX, a.y - prevY)
    if (a.state === "wander" && desiredSpeed > 0.3 && actualMoved < desiredSpeed * dt * 0.15) {
      pickWanderPoint(a, nav, worldSize, tick + 7, worldBounds)
    }

    // Big crowds keep headings wrapped so angleDiff never loops (small groups stay bit-identical to before).
    if (largeCrowd) {
      if (a.aim > Math.PI) a.aim -= Math.PI * 2
      else if (a.aim < -Math.PI) a.aim += Math.PI * 2
    }
    a.vx = dt > 0 ? (a.x - prevX) / dt : 0
    a.vy = dt > 0 ? (a.y - prevY) / dt : 0
  }

  return { bashes, attacks }
}
