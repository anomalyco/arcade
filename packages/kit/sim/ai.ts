import { angleDiff, clearLine, distToRect, pushOut, rayRect, raycast, type Rect, type Vec } from "./geom"
import { Rng } from "./rng"

export type AIState =
  | "wander"
  | "investigate"
  | "alert"
  | "chase"
  | "bash"
  | "search"
  | "stagger"
  | "dead"

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
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

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
  let wallHits = 0
  let doorHits = 0

  for (let i = 0; i < walls.length; i++) {
    const t = rayRect(ox, oy, ux, uy, walls[i]!, maxT)
    if (t > 0.02 && t < maxT) {
      wallHits++
      if (wallHits >= 4) break
    }
  }
  for (let i = 0; i < closedDoors.length; i++) {
    const t = rayRect(ox, oy, ux, uy, closedDoors[i]!, maxT)
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
  const effectiveSightRange = config.sightRange * agent.perceptionScale * lightFactor
  const hasDirectLos =
    dist <= Math.max(effectiveSightRange, config.proximityRange * agent.perceptionScale, target.flashlight?.on ? target.flashlight.range * 1.25 : 0) &&
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
  const fl = target.flashlight
  if (fl?.on && (fl.output ?? 1) > 0.01) {
    const flOutput = fl.output ?? 1
    const fromFlX = agent.x - fl.x
    const fromFlY = agent.y - fl.y
    const flDist = Math.hypot(fromFlX, fromFlY)
    const flAngleToAgent = Math.abs(angleDiff(Math.atan2(fromFlY, fromFlX), fl.aim))
    const directAwareness = fl.awarenessAt
      ? fl.awarenessAt(agent.x, agent.y)
      : flDist <= fl.range &&
          flAngleToAgent <= fl.halfAngle + 0.14 &&
          clearLine(fl.x, fl.y, agent.x, agent.y, sightBlockers)
        ? flOutput * (1 - 0.45 * (flDist / Math.max(1, fl.range)))
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
    const fdx = Math.cos(fl.aim)
    const fdy = Math.sin(fl.aim)
    const beamHit = Math.min(fl.range, raycast(fl.x, fl.y, fdx, fdy, sightBlockers, fl.range))
    for (const frac of [0.5, 0.85]) {
      const bx = fl.x + fdx * (beamHit * frac)
      const by = fl.y + fdy * (beamHit * frac)
      const bDist = Math.hypot(bx - agent.x, by - agent.y)
      const bAngle = Math.abs(angleDiff(Math.atan2(by - agent.y, bx - agent.x), agent.aim))
      const maxPoolDist = config.sightRange * agent.perceptionScale * config.flashlightBoost * flOutput
      if (bDist <= maxPoolDist && bAngle <= periphHalf && clearLine(agent.x, agent.y, bx, by, sightBlockers)) {
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

  // 3. Close-range proximity / smell (must have unobstructed line of sight, never through a wall)
  const proxRange = config.proximityRange * agent.perceptionScale
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
  private readonly head: Int32Array
  private next: Int32Array

  constructor(width: number, height: number, cellSize = 4, initialCapacity = 128) {
    this.cellSize = cellSize
    this.cols = Math.max(1, Math.ceil(width / cellSize))
    this.rows = Math.max(1, Math.ceil(height / cellSize))
    this.head = new Int32Array(this.cols * this.rows).fill(-1)
    this.next = new Int32Array(initialCapacity).fill(-1)
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
      const cx = clamp(Math.floor(a.x / this.cellSize), 0, this.cols - 1)
      const cy = clamp(Math.floor(a.y / this.cellSize), 0, this.rows - 1)
      const cell = cy * this.cols + cx
      this.next[i] = this.head[cell]!
      this.head[cell] = i
    }
  }

  query(x: number, y: number, radius: number, out: number[]): number[] {
    out.length = 0
    const cx0 = clamp(Math.floor((x - radius) / this.cellSize), 0, this.cols - 1)
    const cx1 = clamp(Math.floor((x + radius) / this.cellSize), 0, this.cols - 1)
    const cy0 = clamp(Math.floor((y - radius) / this.cellSize), 0, this.rows - 1)
    const cy1 = clamp(Math.floor((y + radius) / this.cellSize), 0, this.rows - 1)
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let idx = this.head[cy * this.cols + cx]!; idx !== -1; idx = this.next[idx]!) {
          out.push(idx)
        }
      }
    }
    return out
  }
}

const CELL_FREE = 0
const CELL_BLOCKED = 1
const CELL_CLOSED_DOOR = 2
const CELL_OPEN_WINDOW = 3
const CELL_BARRICADED = 4

/**
 * 8-connected A* navigation grid with portal support (open/closed/barricaded doors and open windows).
 */
export class GridNav {
  readonly cell: number
  readonly w: number
  readonly h: number
  readonly grid: Uint8Array
  private readonly g: Float32Array
  private readonly came: Int32Array
  private readonly seen: Uint32Array
  private stamp = 0
  private readonly heap = new NavHeap()

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

  private idx(p: Vec): number {
    const cx = clamp(Math.floor(p.x / this.cell), 0, this.w - 1)
    const cy = clamp(Math.floor(p.y / this.cell), 0, this.h - 1)
    return cy * this.w + cx
  }

  private center(i: number): Vec {
    return { x: ((i % this.w) + 0.5) * this.cell, y: (Math.floor(i / this.w) + 0.5) * this.cell }
  }

  walkable(p: Vec): boolean {
    return this.grid[this.idx(p)] !== CELL_BLOCKED
  }

  nearest(p: Vec): Vec {
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
    for (let k = 1; k <= n; k++) {
      const t = k / n
      const code = this.grid[this.idx({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })]
      if (code !== CELL_FREE) return false
    }
    return true
  }

  path(from: Vec, to: Vec, maxSteps = 2800): Vec[] | null {
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
      if (next && curCode === CELL_FREE && this.straightFree(anchor, next)) continue
      out.push(cells[i]!)
      anchor = cells[i]!
    }
    return out
  }
}

class NavHeap {
  private ids: number[] = []
  private keys: number[] = []

  get size(): number {
    return this.ids.length
  }

  clear(): void {
    this.ids.length = 0
    this.keys.length = 0
  }

  push(id: number, key: number): void {
    this.ids.push(id)
    this.keys.push(key)
    let i = this.ids.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (this.keys[p]! <= key) break
      this.swap(i, p)
      i = p
    }
  }

  pop(): number {
    const top = this.ids[0]!
    const lastId = this.ids.pop()!
    const lastKey = this.keys.pop()!
    if (this.ids.length) {
      this.ids[0] = lastId
      this.keys[0] = lastKey
      let i = 0
      for (;;) {
        const l = i * 2 + 1
        const r = l + 1
        let m = i
        if (l < this.ids.length && this.keys[l]! < this.keys[m]!) m = l
        if (r < this.ids.length && this.keys[r]! < this.keys[m]!) m = r
        if (m === i) break
        this.swap(i, m)
        i = m
      }
    }
    return top
  }

  private swap(a: number, b: number): void {
    ;[this.ids[a], this.ids[b]] = [this.ids[b]!, this.ids[a]!]
    ;[this.keys[a], this.keys[b]] = [this.keys[b]!, this.keys[a]!]
  }
}

/** Creates a deterministic AIAgent with seeded individual speed, perception, aggression, and rig variation. */
export function createAIAgent(id: number, seed: number, x: number, y: number, aim?: number): AIAgent {
  const rng = new Rng((seed ^ Math.imul(id + 1, 0x9e3779b9)) >>> 0)
  const initialAim = aim ?? rng.range(-Math.PI, Math.PI)
  const wAngle = initialAim + rng.range(-0.9, 0.9)
  const wDist = rng.range(3.5, 9.0)
  return {
    id,
    seed: (seed ^ Math.imul(id + 17, 0x85ebca6b)) >>> 0,
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
  }
}

export type AIWorldContext = {
  time: number
  tick: number
  dt: number
  worldSize: number
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
}

export type AIStepResult = {
  bashes: PortalBashEvent[]
  attacks: AgentAttackEvent[]
}

const neighborScratch: number[] = []

function pickWanderPoint(agent: AIAgent, nav: GridNav, worldSize: number, tick: number): void {
  const rng = new Rng((agent.seed ^ Math.imul(tick + 1, 0x27d4eb2d)) >>> 0)
  for (let attempt = 0; attempt < 6; attempt++) {
    const anchorX = attempt < 3 ? (agent.x * 0.65 + agent.homeX * 0.35) : agent.x
    const anchorY = attempt < 3 ? (agent.y * 0.65 + agent.homeY * 0.35) : agent.y
    const ang = rng.range(-Math.PI, Math.PI)
    const dist = rng.range(4.0, 11.5)
    const wx = clamp(anchorX + Math.cos(ang) * dist, 2, worldSize - 2)
    const wy = clamp(anchorY + Math.sin(ang) * dist, 2, worldSize - 2)
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
  for (let i = 0; i < portals.length; i++) {
    const p = portals[i]!
    const d = distToRect(agent.x, agent.y, p.rect)
    if (d > bestDist) continue
    const cx = (p.rect[0] + p.rect[2]) * 0.5
    const cy = (p.rect[1] + p.rect[3]) * 0.5
    const toPortalX = cx - agent.x
    const toPortalY = cy - agent.y
    const toLen = Math.hypot(toPortalX, toPortalY) || 1
    const dot = (toPortalX / toLen) * moveDirX + (toPortalY / toLen) * moveDirY
    if (dot < 0.15 && d > 0.55) continue
    const barricaded = (p.barricadePlanks ?? 0) > 0
    if (p.kind === "door" && (!p.open || barricaded)) {
      bestDist = d
      best = p
    } else if (p.kind === "window" && (p.open || barricaded)) {
      bestDist = d
      best = p
    }
  }
  return best
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

/**
 * Advances the entire AI crowd for one fixed tick.
 * Uses spatial hashing and staggered perception/repath updates to stay well under 1 ms for 50–100 agents.
 */
export function stepAICrowd(agents: AIAgent[], ctx: AIWorldContext): AIStepResult {
  const { dt, time, tick, worldSize, nightFactor, solids, walls, closedDoors, sightBlockers, portals, nav, spatial, noiseBus, config, targets } = ctx
  const bashes: PortalBashEvent[] = []
  const attacks: AgentAttackEvent[] = []

  noiseBus.prune(time)
  spatial.rebuild(agents)

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

  for (let i = 0; i < agents.length; i++) {
    const a = agents[i]!
    if (a.state === "dead") {
      a.vx = 0
      a.vy = 0
      a.hitFlash = Math.max(0, a.hitFlash - dt * 4)
      continue
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

    // Handle stagger state (from bullet hits or melee shove)
    if (a.state === "stagger") {
      a.timer -= dt
      a.x += a.staggerVx * dt
      a.y += a.staggerVy * dt
      const damp = Math.exp(-dt * 9)
      a.staggerVx *= damp
      a.staggerVy *= damp
      pushOut(a, 0.28, solids)
      a.x = clamp(a.x, 0.5, worldSize - 0.5)
      a.y = clamp(a.y, 0.5, worldSize - 0.5)
      a.vx = dt > 0 ? (a.x - prevX) / dt : 0
      a.vy = dt > 0 ? (a.y - prevY) / dt : 0
      if (a.timer <= 0) {
        a.state = a.awareness >= 0.55 ? "chase" : "investigate"
        a.stateTime = 0
        a.repathAt = 0
      }
      continue
    }

    // Staggered perception cadence: engaged zombies check every 2 ticks, idle wanderers every 4 ticks
    const scheduledTick = (a.id + tick) % (a.state === "chase" || a.state === "alert" ? 2 : 4) === 0
    const shouldSense = scheduledTick || tick === 0
    const senseDt = dt * (scheduledTick ? (a.state === "chase" || a.state === "alert" ? 2 : 4) : 1)

    if (shouldSense && targets.length > 0) {
      const target = targets[0]!
      const effectivePerceptionAgent = {
        x: a.x,
        y: a.y,
        aim: a.aim,
        perceptionScale: a.perceptionScale * Math.sqrt(nightFactor),
      }
      const sight = evaluateSight(effectivePerceptionAgent, target, sightBlockers, config)
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
      let bestNoiseScore = 0
      let bestNoise: NoiseEvent | null = null
      for (let eIdx = 0; eIdx < noiseBus.events.length; eIdx++) {
        const ev = noiseBus.events[eIdx]!
        if (ev.sourceId === `zombie-${a.id}`) continue
        // Groans from other zombies only pull wanderers/searchers, not already-chasing zombies
        if (ev.kind === "groan" && (a.state === "chase" || a.state === "alert" || a.state === "bash")) continue
        const att = attenuateNoise(
          ev.x,
          ev.y,
          ev.radius,
          ev.loudness,
          a.x,
          a.y,
          walls,
          closedDoors,
          config,
          a.perceptionScale * Math.sqrt(nightFactor),
        )
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
            ? Math.min(0.38, bestNoiseScore * 0.55)
            : Math.max(0.38, bestNoiseScore * 0.78)
          : bestNoiseScore * (isGroan ? 0.25 : 0.75) * senseDt
        const maxAudioAwareness = isGroan ? 0.52 : 1.0
        a.awareness = clamp(Math.min(maxAudioAwareness, a.awareness + audioGain), 0, 1)
        a.lastHeardNoiseId = bestNoise.id
        if (!a.seesTarget) {
          a.targetX = bestNoise.x
          a.targetY = bestNoise.y
          a.targetKind = "noise"
          if (isNewImpulse && bestNoiseScore > 0.35) {
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
          sourceId: `zombie-${a.id}`,
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
          sourceId: `zombie-${a.id}`,
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
    } else if (a.state === "chase") {
      if (a.seesTarget && targets[0]) {
        a.targetX = targets[0].x
        a.targetY = targets[0].y
      } else if (Math.hypot(a.targetX - a.x, a.targetY - a.y) < 0.95 || a.stateTime > 8.0) {
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
        a.state = a.awareness >= 0.5 ? "chase" : "investigate"
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
            sourceId: `zombie-${a.id}`,
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
        pickWanderPoint(a, nav, worldSize, tick)
      }
    }

    // Movement & steering per state
    let moveDirX = 0
    let moveDirY = 0
    let desiredSpeed = 0

    if (a.state === "wander") {
      a.timer -= dt
      if (a.timer <= 0 || Math.hypot(a.wanderX - a.x, a.wanderY - a.y) < 0.85) {
        pickWanderPoint(a, nav, worldSize, tick)
        a.timer = 3.0 + ((a.id * 17 + tick) % 5)
      }
      const dx = a.wanderX - a.x
      const dy = a.wanderY - a.y
      const d = Math.hypot(dx, dy)
      if (d > 0.2) {
        moveDirX = dx / d
        moveDirY = dy / d
        desiredSpeed = config.walkSpeed * a.speedScale * (0.9 + 0.1 * nightFactor)
      }
    } else if (a.state === "investigate" || a.state === "chase") {
      const goalX = a.targetX
      const goalY = a.targetY
      const distToGoal = Math.hypot(goalX - a.x, goalY - a.y)

      // Check close-range attack against survivor when chasing
      if (a.state === "chase" && a.seesTarget && targets[0] && distToGoal <= 0.92) {
        const want = Math.atan2(targets[0].y - a.y, targets[0].x - a.x)
        a.aim += clamp(angleDiff(want, a.aim), -dt * 10, dt * 10)
        if (a.attackCooldown <= 0) {
          a.attackCooldown = 1.05 / Math.max(0.5, a.aggression * config.aggression)
          attacks.push({
            agentId: a.id,
            targetId: targets[0].id,
            x: a.x,
            y: a.y,
            damage: 20 * config.aggression,
          })
        }
        desiredSpeed = config.walkSpeed * 0.25
      } else {
        const canWalkStraight = a.seesTarget && nav.straightFree(a, { x: goalX, y: goalY })
        if (canWalkStraight) {
          a.path.length = 0
          moveDirX = (goalX - a.x) / (distToGoal || 1)
          moveDirY = (goalY - a.y) / (distToGoal || 1)
        } else {
          if (time >= a.repathAt || a.path.length === 0) {
            a.path = nav.path(a, { x: goalX, y: goalY }) ?? [{ x: goalX, y: goalY }]
            a.repathAt = time + (a.state === "chase" ? 0.45 : 0.85) + (a.id % 5) * 0.08
          }
          while (a.path.length > 0 && Math.hypot(a.path[0]!.x - a.x, a.path[0]!.y - a.y) < 0.38) {
            a.path.shift()
          }
          const wp = a.path[0] ?? { x: goalX, y: goalY }
          const wdx = wp.x - a.x
          const wdy = wp.y - a.y
          const wd = Math.hypot(wdx, wdy) || 1
          moveDirX = wdx / wd
          moveDirY = wdy / wd
        }

        const baseSpeed = a.state === "chase" ? config.chaseSpeed : config.walkSpeed * 1.32
        desiredSpeed = baseSpeed * a.speedScale * (0.92 + 0.08 * nightFactor)

        // Check if a closed door, barricaded opening, or open window is right in front of the agent
        const portal = findBlockingPortal(a, moveDirX, moveDirY, portals)
        if (portal) {
          const barricaded = (portal.barricadePlanks ?? 0) > 0
          if (portal.kind === "window" && portal.open && !barricaded) {
            const dest = computeWindowClamberDest(portal, a.x, a.y)
            a.clamberWindowId = portal.id
            a.clamberFromX = a.x
            a.clamberFromY = a.y
            a.clamberToX = dest.toX
            a.clamberToY = dest.toY
            a.clamberElapsed = 0
            a.clamberDuration = 0.52 / Math.max(0.7, a.speedScale)
            desiredSpeed = 0
          } else if ((portal.kind === "door" && (!portal.open || barricaded)) || (portal.kind === "window" && barricaded)) {
            a.state = "bash"
            a.stateTime = 0
            a.activePortalId = portal.id
            a.timer = config.bashInterval * 0.45
            desiredSpeed = 0
          }
        }
      }
    } else if (a.state === "search") {
      const searchAngle = a.seed * 0.001 + a.searchIndex * 2.1
      const sx = a.targetX + Math.cos(searchAngle) * 2.2
      const sy = a.targetY + Math.sin(searchAngle) * 2.2
      const d = Math.hypot(sx - a.x, sy - a.y)
      if (d < 0.55) {
        a.searchIndex++
      } else {
        moveDirX = (sx - a.x) / d
        moveDirY = (sy - a.y) / d
        desiredSpeed = config.walkSpeed * a.speedScale * 0.85
      }
    }

    // Apply local Boids flocking (strong separation for all living agents; mild cohesion/alignment for wanderers)
    const neighbors = spatial.query(a.x, a.y, 4.5, neighborScratch)
    let sepX = 0
    let sepY = 0
    let cohX = 0
    let cohY = 0
    let alignX = 0
    let alignY = 0
    let flockCount = 0

    for (let k = 0; k < neighbors.length; k++) {
      const j = neighbors[k]!
      if (j === i) continue
      const b = agents[j]!
      const dx = a.x - b.x
      const dy = a.y - b.y
      const d2 = dx * dx + dy * dy
      if (d2 < 1e-6) {
        sepX += (a.id > b.id ? 1 : -1) * 0.5
        continue
      }
      const d = Math.sqrt(d2)
      if (d < 1.15) {
        const push = (1.15 - d) / 1.15
        sepX += (dx / d) * push * 1.45
        sepY += (dy / d) * push * 1.45
      }
      if (a.state === "wander" && b.state === "wander" && d < 4.5) {
        cohX += b.x
        cohY += b.y
        alignX += Math.cos(b.aim)
        alignY += Math.sin(b.aim)
        flockCount++
      }
    }

    if (flockCount > 0 && a.state === "wander") {
      const cx = cohX / flockCount - a.x
      const cy = cohY / flockCount - a.y
      const cl = Math.hypot(cx, cy) || 1
      moveDirX += (cx / cl) * 0.18 + (alignX / flockCount) * 0.14
      moveDirY += (cy / cl) * 0.18 + (alignY / flockCount) * 0.14
    }

    moveDirX += sepX
    moveDirY += sepY
    const moveLen = Math.hypot(moveDirX, moveDirY)
    if (moveLen > 1e-4 && desiredSpeed > 0) {
      const ux = moveDirX / moveLen
      const uy = moveDirY / moveLen
      a.x += ux * desiredSpeed * dt
      a.y += uy * desiredSpeed * dt
      const wantAim = a.seesTarget && targets[0] ? Math.atan2(targets[0].y - a.y, targets[0].x - a.x) : Math.atan2(uy, ux)
      const turnRate = (a.state === "chase" ? 7.5 : 4.2) * dt
      a.aim += clamp(angleDiff(wantAim, a.aim), -turnRate, turnRate)
    }

    pushOut(a, 0.28, solids)
    a.x = clamp(a.x, 0.5, worldSize - 0.5)
    a.y = clamp(a.y, 0.5, worldSize - 0.5)

    // Redirect wander waypoint if agent got stuck against an obstacle
    const actualMoved = Math.hypot(a.x - prevX, a.y - prevY)
    if (a.state === "wander" && desiredSpeed > 0.3 && actualMoved < desiredSpeed * dt * 0.15) {
      pickWanderPoint(a, nav, worldSize, tick + 7)
    }

    a.vx = dt > 0 ? (a.x - prevX) / dt : 0
    a.vy = dt > 0 ? (a.y - prevY) / dt : 0
  }

  return { bashes, attacks }
}
