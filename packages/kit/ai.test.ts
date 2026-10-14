import { describe, expect, test } from "bun:test"
import {
  attenuateNoise,
  createAIAgent,
  DEFAULT_AI_CONFIG,
  evaluateSight,
  GridNav,
  NoiseBus,
  SpatialHash,
  stepAICrowd,
  type AIConfig,
  type AIWorldContext,
  type NavPortal,
  type PerceptionTarget,
} from "./sim/ai"
import type { Rect } from "./sim/geom"

describe("AI perception", () => {
  test("sight is blocked by walls and closed doors, and modulated by darkness and flashlight", () => {
    const agent = createAIAgent(1, 7, 10, 10, 0)
    agent.perceptionScale = 1
    const wall: Rect = [14, 6, 14.3, 14]
    const litTarget: PerceptionTarget = {
      id: "player",
      x: 19.5,
      y: 10,
      vx: 0,
      vy: 0,
      lightLevel: 1.0,
      continuousNoiseRadius: 1.2,
    }
    const darkTarget: PerceptionTarget = {
      ...litTarget,
      lightLevel: 0.05,
    }

    // Clear LOS in bright light
    const clearLit = evaluateSight(agent, litTarget, [], DEFAULT_AI_CONFIG)
    expect(clearLit.seesTarget).toBe(true)
    expect(clearLit.visualGain).toBeGreaterThan(1.5)

    // Blocked by a wall
    const blocked = evaluateSight(agent, litTarget, [wall], DEFAULT_AI_CONFIG)
    expect(blocked.seesTarget).toBe(false)
    expect(blocked.visualGain).toBe(0)

    // Target in darkness has shorter effective sight range and lower gain
    const clearDark = evaluateSight(agent, darkTarget, [], DEFAULT_AI_CONFIG)
    expect(clearDark.effectiveSightRange).toBeLessThan(clearLit.effectiveSightRange)
    expect(clearDark.seesTarget).toBe(false) // 8m is beyond dark-adapted sight range (~7.56m)

    // Turning on flashlight in the dark makes target immediately sensed
    const flashlightTarget: PerceptionTarget = {
      ...darkTarget,
      flashlight: {
        on: true,
        x: darkTarget.x,
        y: darkTarget.y,
        aim: Math.PI, // shining toward the zombie at (10, 10)
        range: 16,
        halfAngle: 0.42,
      },
    }
    const withFlashlight = evaluateSight(agent, flashlightTarget, [], DEFAULT_AI_CONFIG)
    expect(withFlashlight.visualGain).toBeGreaterThan(clearLit.visualGain * 0.8)
    expect(withFlashlight.seesTarget || withFlashlight.sensesLight).toBe(true)
  })

  test("proximity senses behind the zombie only when not separated by a wall", () => {
    const agent = createAIAgent(1, 7, 10, 10, 0) // facing +X
    agent.perceptionScale = 1
    const behindTarget: PerceptionTarget = {
      id: "player",
      x: 8.5, // 1.5m behind zombie
      y: 10,
      vx: 0,
      vy: 0,
      lightLevel: 0.2,
      continuousNoiseRadius: 1.2,
    }
    const clearBehind = evaluateSight(agent, behindTarget, [], DEFAULT_AI_CONFIG)
    expect(clearBehind.sensesProximity).toBe(true)
    expect(clearBehind.visualGain).toBeGreaterThan(0.5)

    const wallBetween: Rect = [9.2, 8, 9.4, 12]
    const blockedBehind = evaluateSight(agent, behindTarget, [wallBetween], DEFAULT_AI_CONFIG)
    expect(blockedBehind.sensesProximity).toBe(false)
    expect(blockedBehind.visualGain).toBe(0)
  })

  test("noise attenuation reduces effective radius across walls and closed doors", () => {
    const wall1: Rect = [14, 0, 14.3, 20]
    const door1: Rect = [18, 9, 18.3, 11]

    const open = attenuateNoise(10, 10, 12, 1, 20, 10, [], [], DEFAULT_AI_CONFIG, 1)
    expect(open.audible).toBe(true)
    expect(open.effectiveRadius).toBeCloseTo(12, 5)

    const throughDoor = attenuateNoise(10, 10, 12, 1, 20, 10, [], [door1], DEFAULT_AI_CONFIG, 1)
    expect(throughDoor.doorHits).toBe(1)
    expect(throughDoor.effectiveRadius).toBeLessThan(open.effectiveRadius)

    const throughWallAndDoor = attenuateNoise(10, 10, 12, 1, 20, 10, [wall1], [door1], DEFAULT_AI_CONFIG, 1)
    expect(throughWallAndDoor.wallHits).toBe(1)
    expect(throughWallAndDoor.doorHits).toBe(1)
    expect(throughWallAndDoor.effectiveRadius).toBeLessThan(throughDoor.effectiveRadius)
    expect(throughWallAndDoor.audible).toBe(false) // 12 * 0.52 * 0.72 = 4.49m < 10m distance

    // Gunshot (52m) penetrates wall + door and remains audible at 10m
    const gunshot = attenuateNoise(10, 10, 52, 2.2, 20, 10, [wall1], [door1], DEFAULT_AI_CONFIG, 1)
    expect(gunshot.audible).toBe(true)
    expect(gunshot.perceivedLoudness).toBeGreaterThan(0.3)
  })
})

describe("GridNav & AI state transitions", () => {
  test("paths through open doors and around walls, and bashes closed doors", () => {
    const walls: Rect[] = [
      [20, 20, 30, 20.25],
      [20, 20, 20.25, 30],
      [29.75, 20, 30, 30],
      [20, 29.75, 24, 30],
      [25.4, 29.75, 30, 30],
    ]
    const closedPortal: NavPortal = {
      id: "front-door",
      kind: "door",
      rect: [24, 29.75, 25.4, 30],
      open: false,
    }
    const nav = new GridNav(64, 64, 0.5)
    nav.rebuild([...walls, closedPortal.rect], [closedPortal])

    const pathThroughClosed = nav.path({ x: 24.7, y: 33 }, { x: 24.7, y: 25 })
    expect(pathThroughClosed).not.toBeNull()
    expect(pathThroughClosed!.length).toBeGreaterThan(0)

    // Put a chasing agent outside the closed door with target inside
    const agent = createAIAgent(0, 42, 24.7, 30.6, -Math.PI / 2)
    agent.state = "chase"
    agent.awareness = 1
    agent.targetX = 24.7
    agent.targetY = 25
    const noiseBus = new NoiseBus()
    const spatial = new SpatialHash(64, 64)
    const config: AIConfig = { ...DEFAULT_AI_CONFIG, bashInterval: 0.3 }
    const ctx: AIWorldContext = {
      time: 0,
      tick: 0,
      dt: 1 / 60,
      worldSize: 64,
      nightFactor: 1,
      solids: [...walls, closedPortal.rect],
      walls,
      closedDoors: [closedPortal.rect],
      sightBlockers: [...walls, closedPortal.rect],
      portals: [closedPortal],
      nav,
      spatial,
      noiseBus,
      config,
      targets: [{ id: "player", x: 24.7, y: 25, vx: 0, vy: 0, lightLevel: 1, continuousNoiseRadius: 1.2 }],
    }

    let bashed = false
    for (let t = 0; t < 45; t++) {
      ctx.tick = t
      ctx.time = t / 60
      const res = stepAICrowd([agent], ctx)
      if (res.bashes.length > 0) bashed = true
    }
    expect(agent.state as string).toBe("bash")
    expect(bashed).toBe(true)
  })

  test("deterministic crowd simulation stays under 1 ms per tick for 80 agents", () => {
    const runSimulation = () => {
      const nav = new GridNav(96, 96, 0.5)
      const walls: Rect[] = [[22, 24, 37, 24.25], [22, 24, 22.25, 35.5]]
      nav.rebuild(walls, [])
      const spatial = new SpatialHash(96, 96)
      const noiseBus = new NoiseBus()
      const agents = Array.from({ length: 80 }, (_, i) =>
        createAIAgent(i, 7, 10 + (i % 10) * 6, 10 + Math.floor(i / 10) * 6),
      )
      const ctx: AIWorldContext = {
        time: 0,
        tick: 0,
        dt: 1 / 60,
        worldSize: 96,
        nightFactor: 1.2,
        solids: walls,
        walls,
        closedDoors: [],
        sightBlockers: walls,
        portals: [],
        nav,
        spatial,
        noiseBus,
        config: DEFAULT_AI_CONFIG,
        targets: [{ id: "player", x: 44, y: 44, vx: 3.4, vy: 0, lightLevel: 0.8, continuousNoiseRadius: 12 }],
      }
      const start = performance.now()
      for (let tick = 0; tick < 120; tick++) {
        ctx.tick = tick
        ctx.time = tick / 60
        if (tick === 20) {
          noiseBus.emit({ x: 44, y: 44, radius: 48, kind: "gunshot", time: ctx.time })
        }
        stepAICrowd(agents, ctx)
      }
      const elapsedMs = performance.now() - start
      return { agents, avgMsPerTick: elapsedMs / 120 }
    }

    const runA = runSimulation()
    const runB = runSimulation()
    expect(runA.agents.map((a) => ({ x: a.x, y: a.y, state: a.state, awareness: a.awareness }))).toEqual(
      runB.agents.map((a) => ({ x: a.x, y: a.y, state: a.state, awareness: a.awareness })),
    )
    expect(runA.avgMsPerTick).toBeLessThan(1.0)
  })
})
