import {
  createAIAgent,
  DEFAULT_AI_CONFIG,
  GridNav,
  NoiseBus,
  SpatialHash,
  stepAICrowd,
  type AIAgent,
  type AIConfig,
  type AIState,
  type FlashlightState,
  type NavPortal,
  type NoiseEvent,
  type NoiseKind,
  type PerceptionTarget,
} from "@arcade/kit/sim/ai"
import { distToRect, type Rect } from "@arcade/kit/sim/geom"
import { Rng } from "@arcade/kit/sim/rng"
import { dayCycle } from "./day-cycle"
import { propShape, sightRects, SIZE, solidRects, type Town } from "./map"

export {
  createAIAgent,
  DEFAULT_AI_CONFIG,
  NoiseBus,
  type AIAgent,
  type AIConfig,
  type AIState,
  type FlashlightState,
  type NoiseEvent,
  type NoiseKind,
}

export const aiControls = [
  { key: "aiDebugOverlay", label: "Debug overlay", group: "AI" },
  { key: "zombieCount", label: "Population", group: "AI", min: 0, max: 100, step: 1, unit: "" },
  { key: "sightRange", label: "Sight range", group: "AI", min: 6, max: 36, step: 1, unit: "m" },
  { key: "sightCone", label: "Sight cone", group: "AI", min: 45, max: 180, step: 5, unit: "deg" },
  { key: "hearingScale", label: "Hearing scale", group: "AI", min: 0, max: 2.5, step: 0.1, unit: "×" },
  { key: "walkSpeed", label: "Wander speed", group: "AI", min: 0.4, max: 2.2, step: 0.05, unit: "m/s" },
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
  minClearance = 8.5,
): AIAgent[] {
  const rng = new Rng((town.seed ^ 0x7a4f9b13) >>> 0)
  const agents: AIAgent[] = []
  if (count <= 0) return agents

  // Curated street & yard anchor zones so nearby streets immediately feel inhabited
  const anchors: [number, number][] = [
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
    const groupSize = aIdx < 5 ? 2 + (aIdx % 2) : 2 + rng.int(3)
    for (let m = 0; m < groupSize && agents.length < count; m++) {
      const offsetAngle = rng.range(-Math.PI, Math.PI)
      const offsetDist = m === 0 ? rng.range(0, 1.2) : rng.range(1.2, 3.8)
      const candidate = nav.nearest({
        x: Math.max(3, Math.min(SIZE - 3, ax + Math.cos(offsetAngle) * offsetDist)),
        y: Math.max(3, Math.min(SIZE - 3, ay + Math.sin(offsetAngle) * offsetDist)),
      })
      if (Math.hypot(candidate.x - avoidX, candidate.y - avoidY) < minClearance) continue
      // Avoid spawning inside locked/closed houses initially unless overflowed
      const insideHouse = town.buildings.some(
        (b) => candidate.x > b.rect[0] + 0.2 && candidate.x < b.rect[2] - 0.2 && candidate.y > b.rect[1] + 0.2 && candidate.y < b.rect[3] - 0.2,
      )
      if (insideHouse) continue
      agents.push(createAIAgent(nextId++, town.seed, candidate.x, candidate.y, rng.range(-Math.PI, Math.PI)))
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
      (b) => candidate.x > b.rect[0] + 0.2 && candidate.x < b.rect[2] - 0.2 && candidate.y > b.rect[1] + 0.2 && candidate.y < b.rect[3] - 0.2,
    )
    if (insideHouse) continue
    agents.push(createAIAgent(nextId++, town.seed, candidate.x, candidate.y, rng.range(-Math.PI, Math.PI)))
  }

  return agents
}

export class OutbreakAISubsystem {
  readonly nav = new GridNav(SIZE, SIZE, 0.5)
  readonly spatial = new SpatialHash(SIZE, SIZE, 4)
  readonly noiseBus = new NoiseBus(64)
  readonly portalStates = new Map<string, PortalState>()
  agents: AIAgent[] = []
  config: AIConfig = { ...DEFAULT_AI_CONFIG }
  tick = 0
  private nextAgentId = 1
  private walls: Rect[] = []
  private closedDoors: Rect[] = []
  private sightBlockers: Rect[] = []
  private solids: Rect[] = []
  private portals: NavPortal[] = []
  private directorWaveCooldown = 18

  constructor(town: Town, initialPlayerX = 27.7, initialPlayerY = 41, config: Partial<AIConfig> = {}) {
    Object.assign(this.config, config)
    this.initPortals(town)
    this.rebuildTopology(town)
    this.agents = spawnTownZombies(town, this.nav, this.config.zombieCount, initialPlayerX, initialPlayerY)
    this.nextAgentId = this.agents.reduce((m, a) => Math.max(m, a.id), 0) + 1
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

  rebuildTopology(town: Town): void {
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

    const navObstacleRects = [
      ...town.barriers.map((b) => b.rect),
      ...town.props.flatMap((p) => {
        const s = propShape(p)
        return s ? [s.rect] : []
      }),
    ]
    this.nav.rebuild(navObstacleRects, this.portals, 0.28)
  }

  syncPopulation(town: Town, avoidX: number, avoidY: number): void {
    const desired = Math.max(0, Math.min(100, Math.round(this.config.zombieCount)))
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
    const extra = spawnTownZombies(town, this.nav, desired - living.length + 8, avoidX, avoidY, 7.0)
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

  addBarricadePlank(portalId: string): boolean {
    const st = this.portalStates.get(portalId)
    if (!st || st.barricadePlanks >= 3) return false
    st.barricadePlanks++
    st.barricadeHp = st.barricadePlanks * 100
    return true
  }

  getBarricadePlanks(portalId: string): number {
    return this.portalStates.get(portalId)?.barricadePlanks ?? 0
  }

  step(
    town: Town,
    player: {
      x: number
      y: number
      vx: number
      vy: number
      aim: number
      noise: number
      flashlightOn?: boolean
    },
    hour: number,
    time: number,
    dt: number,
  ): { topologyChanged: boolean; playerDamage: number } {
    this.tick++
    const day = dayCycle(hour)
    const darkness = 1 - day.sun
    const nightFactor = 1 + darkness * (this.config.nightMultiplier - 1)
    const lightLevel = samplePointLightLevel(town, hour, player.x, player.y, 1)
    const flashlight: FlashlightState | null = player.flashlightOn
      ? {
          on: true,
          x: player.x,
          y: player.y,
          aim: player.aim,
          range: 15.5,
          halfAngle: 0.42,
        }
      : null

    const target: PerceptionTarget = {
      id: "player",
      x: player.x,
      y: player.y,
      vx: player.vx,
      vy: player.vy,
      lightLevel,
      continuousNoiseRadius: player.noise,
      flashlight,
    }

    // Optional AI Director pacing: at night or after quiet stretches, gently drift 1-2 distant idle roamers toward active street corridors
    if (this.config.directorPacing > 0) {
      this.directorWaveCooldown -= dt * nightFactor
      if (this.directorWaveCooldown <= 0) {
        this.directorWaveCooldown = 14 + (this.tick % 9)
        let nudged = 0
        for (let i = 0; i < this.agents.length && nudged < 2; i++) {
          const a = this.agents[i]!
          if (a.state !== "wander") continue
          const d = Math.hypot(a.x - player.x, a.y - player.y)
          if (d > 22 && d < 52) {
            const ang = Math.atan2(player.y - a.y, player.x - a.x) + ((i % 2 === 0 ? 1 : -1) * 0.35)
            const stepDist = Math.min(14, d - 16)
            const dest = this.nav.nearest({
              x: a.x + Math.cos(ang) * stepDist,
              y: a.y + Math.sin(ang) * stepDist,
            })
            a.wanderX = dest.x
            a.wanderY = dest.y
            a.timer = 6.5
            nudged++
          }
        }
      }
    }

    const res = stepAICrowd(this.agents, {
      time,
      tick: this.tick,
      dt,
      worldSize: SIZE,
      nightFactor,
      solids: this.solids,
      walls: this.walls,
      closedDoors: this.closedDoors,
      sightBlockers: this.sightBlockers,
      portals: this.portals,
      nav: this.nav,
      spatial: this.spatial,
      noiseBus: this.noiseBus,
      config: this.config,
      targets: [target],
    })

    let topologyChanged = false
    for (const bash of res.bashes) {
      const st = this.portalStates.get(bash.portalId)
      if (!st) continue
      st.lastBashTime = time
      if (st.barricadePlanks > 0) {
        st.barricadeHp = Math.max(0, st.barricadeHp - bash.damage)
        const nextPlanks = Math.ceil(st.barricadeHp / 100)
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
      this.rebuildTopology(town)
    }

    let playerDamage = 0
    for (const atk of res.attacks) {
      if (Math.hypot(atk.x - player.x, atk.y - player.y) <= 1.25) {
        playerDamage += atk.damage
      }
    }

    return { topologyChanged, playerDamage }
  }
}
