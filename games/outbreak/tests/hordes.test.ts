import { describe, expect, test } from "bun:test"
import { inRect } from "@arcade/kit/sim/geom"
import { Rng } from "@arcade/kit/sim/rng"
import { createAIAgent, type AIAgent, type AIState } from "../shared/ai"
import { TICK_DT } from "../shared/clock"
import { PISTOL_NOISE } from "../shared/combat"
import { CoopSim, hashSimState } from "../shared/coop-sim"
import {
  addHorde as placeHorde,
  DEFAULT_HORDE_TUNING,
  HORDE_ID_BASE,
  hordesOf,
  materializeHorde,
  type Horde,
} from "../shared/hordes/index"

const HARDWARE = [53, 23, 73, 38] as const

/** Classic town at night with one idle survivor shut inside Elm House, no director, and an empty crowd. */
function hordeWorld(flowFields = 2): CoopSim {
  const sim = new CoopSim(7, 7, 0.22, { zombieCount: 0, directorPacing: 0, startHour: 23, flowFields })
  sim.addSurvivor("player", 0)
  Object.assign(sim.slots[0]!.survivor, { x: 28, y: 57, flashlightOn: false })
  sim.ai.agents.length = 0
  return sim
}

function addHorde(
  sim: CoopSim,
  n: number,
  box: readonly [number, number, number, number],
  state: AIState,
  goal?: readonly [number, number],
  idBase = 1,
): AIAgent[] {
  const rng = new Rng(0x40de ^ idBase)
  const out: AIAgent[] = []
  for (let id = idBase; out.length < n; id++) {
    const x = rng.range(box[0], box[2])
    const y = rng.range(box[1], box[3])
    if (!sim.ai.nav.walkable({ x, y })) continue
    const a = createAIAgent(id, sim.town.seed, x, y)
    a.state = state
    if (goal) {
      a.targetX = goal[0]
      a.targetY = goal[1]
      a.targetKind = "noise"
      a.awareness = 0.6
    }
    sim.ai.agents.push(a)
    out.push(a)
  }
  return out
}

function run(sim: CoopSim, seconds: number, each?: (tick: number) => void): void {
  const slot = sim.slots[0]!
  for (let t = 0; t < Math.round(seconds / TICK_DT); t++) {
    slot.survivor.health = slot.survivor.maxHealth
    sim.stepSurvivor(slot, { mx: 0, my: 0, aim: 0, interact: false }, TICK_DT)
    sim.stepWorld(TICK_DT, 240)
    each?.(t)
  }
}

const dist = (a: AIAgent, g: readonly [number, number]) => Math.hypot(a.x - g[0], a.y - g[1])

/** Keeps a group heading for `goal` the way a horde directive does: idle members are re-sent every second. */
function steer(horde: readonly AIAgent[], goal: readonly [number, number], tick: number): void {
  if (tick % 60 !== 0) return
  for (const a of horde) {
    if (a.state !== "wander" && a.state !== "investigate" && a.state !== "search") continue
    if (dist(a, goal) < 2.5) continue
    a.state = "investigate"
    a.targetX = goal[0]
    a.targetY = goal[1]
    a.targetKind = "noise"
    a.awareness = Math.max(a.awareness, 0.6)
  }
}

describe("flow-field hordes", () => {
  test("small crowds keep per-agent A*: flowFields auto is bit-identical to A* below 64 zombies", () => {
    const runOnce = (flowFields: number) => {
      const sim = new CoopSim(7, 7, 0.22, { flowFields })
      sim.addSurvivor("player", 0)
      for (let t = 0; t < 900; t++) {
        const phase = t / 140
        sim.stepSurvivor(sim.slots[0]!, { mx: Math.cos(phase), my: Math.sin(phase), aim: phase, interact: false, fire: t % 90 === 0 }, TICK_DT)
        sim.stepWorld(TICK_DT, 240)
      }
      const snap = sim.toSnapshot()
      delete snap.ai.config.flowFields
      return hashSimState(snap)
    }
    expect(runOnce(1)).toBe(runOnce(0))
  })

  test("a 300-zombie horde in co-op replays bit for bit from a mid-run snapshot", () => {
    const sim = hordeWorld(1)
    sim.addSurvivor("p2", 1)
    Object.assign(sim.slots[1]!.survivor, { x: 47, y: 46, flashlightOn: true })
    addHorde(sim, 300, [4, 4, 92, 92], "wander")
    const step = (s: CoopSim, t: number) => {
      for (const slot of s.slots) {
        slot.survivor.health = slot.survivor.maxHealth
        const ph = t / 120 + slot.index
        s.stepSurvivor(slot, { mx: Math.cos(ph), my: Math.sin(ph), aim: ph, interact: false, sprint: t % 200 < 50 }, TICK_DT)
      }
      if (t % 150 === 75) s.ai.emitNoise(47, 46, PISTOL_NOISE, "gunshot", s.time, "p2", 2.2)
      s.stepWorld(TICK_DT, 240)
    }
    for (let t = 0; t < 300; t++) step(sim, t)
    const mid = sim.toSnapshot()
    expect(mid.ai.flowAnchors?.length).toBeGreaterThan(0)
    for (let t = 300; t < 600; t++) step(sim, t)
    const replay = CoopSim.fromSnapshot(mid)
    for (let t = 300; t < 600; t++) step(replay, t)
    expect(hashSimState(replay.toSnapshot())).toBe(hashSimState(sim.toSnapshot()))
    expect(sim.ai.flow.builds).toBeGreaterThan(0)
  })

  test("a horde splits around a building to reach the far side", () => {
    const sim = hordeWorld()
    const goal = [80, 30.5] as const
    const horde = addHorde(sim, 60, [43, 25, 49, 36], "investigate", goal)
    const north = new Set<number>()
    const south = new Set<number>()
    run(sim, 70, (t) => {
      steer(horde, goal, t)
      for (const a of horde) {
        if (a.x < HARDWARE[0] || a.x > HARDWARE[2]) continue
        if (a.y < HARDWARE[1]) north.add(a.id)
        else if (a.y > HARDWARE[3]) south.add(a.id)
      }
    })
    // Past the building and gathered at the goal (a 60-strong crowd needs a few metres of personal space).
    const arrived = horde.filter((a) => a.x > HARDWARE[2] && dist(a, goal) < 9).length
    expect(arrived).toBeGreaterThanOrEqual(54)
    expect(north.size).toBeGreaterThanOrEqual(10)
    expect(south.size).toBeGreaterThanOrEqual(10)
    expect(horde.every((a) => !inRect(a.x, a.y, HARDWARE, -0.6))).toBe(true)
  })

  test("a horde funnels through an open door into a building", () => {
    const sim = hordeWorld()
    sim.town.doors.find((d) => d.id === "hardware-front")!.open = true
    sim.rebuildCollision()
    const goal = [63, 33] as const
    const horde = addHorde(sim, 40, [48, 43, 72, 50], "investigate", goal)
    const entries: number[] = []
    const lastY = new Map(horde.map((a) => [a.id, a.y]))
    run(sim, 60, (t) => {
      steer(horde, goal, t)
      for (const a of horde) {
        const prev = lastY.get(a.id)!
        if (prev > HARDWARE[3] && a.y <= HARDWARE[3]) entries.push(a.x)
        lastY.set(a.id, a.y)
      }
    })
    const inside = horde.filter((a) => inRect(a.x, a.y, HARDWARE)).length
    expect(inside).toBeGreaterThanOrEqual(32)
    expect(entries.length).toBeGreaterThanOrEqual(inside)
    // Every crossing of the south wall happened in the doorway (58..59.4).
    expect(entries.every((x) => x > 57.4 && x < 60)).toBe(true)
  })

  test("a horde piles on a barricaded door and wears the planks down", () => {
    const sim = hordeWorld()
    for (let i = 0; i < 3; i++) sim.ai.addBarricadePlank("hardware-front")
    sim.rebuildCollision()
    const goal = [63, 33] as const
    const horde = addHorde(sim, 40, [48, 43, 72, 50], "investigate", goal)
    const door = [58.7, 38.6] as const
    let peakPile = 0
    let peakBash = 0
    run(sim, 30, (t) => {
      steer(horde, goal, t)
      peakPile = Math.max(peakPile, horde.filter((a) => dist(a, door) < 3).length)
      peakBash = Math.max(peakBash, horde.filter((a) => a.state === "bash").length)
    })
    expect(peakPile).toBeGreaterThanOrEqual(10)
    expect(peakBash).toBeGreaterThanOrEqual(3)
    const st = sim.ai.portalStates.get("hardware-front")!
    expect(st.barricadePlanks < 3 || st.barricadeHp < 300).toBe(true)
    if (!sim.town.doors.find((d) => d.id === "hardware-front")!.open) {
      expect(horde.filter((a) => inRect(a.x, a.y, HARDWARE)).length).toBe(0)
    }
  })

  // A lone gunshot lures a crowd for a few seconds (awareness decays); horde directives carry them the rest of the way.
  test("a gunshot peels the zombies in earshot off toward it and leaves the far ones wandering", () => {
    const sim = hordeWorld()
    const shot = [84, 16] as const
    const near = addHorde(sim, 30, [80, 30, 88, 37], "wander", undefined, 1)
    const far = addHorde(sim, 30, [78, 80, 90, 90], "wander", undefined, 500)
    run(sim, 1)
    const before = near.reduce((s, a) => s + dist(a, shot), 0) / near.length
    sim.ai.emitNoise(shot[0], shot[1], PISTOL_NOISE, "gunshot", sim.time, "world", 2.2)
    const peeled = new Set<number>()
    const closest = new Map(near.map((a) => [a.id, dist(a, shot)]))
    let farPeeled = 0
    run(sim, 20, () => {
      for (const a of near) {
        if (a.state !== "wander") peeled.add(a.id)
        closest.set(a.id, Math.min(closest.get(a.id)!, dist(a, shot)))
      }
      farPeeled += far.filter((a) => a.state !== "wander").length
    })
    const after = [...closest.values()].reduce((s, d) => s + d, 0) / near.length
    expect(peeled.size).toBeGreaterThanOrEqual(24)
    expect(after).toBeLessThan(before * 0.8)
    expect(farPeeled).toBe(0)
  })

  test("crawlers still crawl when they follow the flow field", () => {
    const sim = hordeWorld()
    const goal = [80, 30.5] as const
    const crawlers = addHorde(sim, 16, [43, 25, 49, 36], "crawler", goal)
    for (const a of crawlers) a.detachedLimbs = ["left.thigh", "right.thigh"]
    const start = crawlers.map((a) => dist(a, goal))
    let fastest = 0
    const last = new Map(crawlers.map((a) => [a.id, [a.x, a.y] as const]))
    run(sim, 40, (t) => {
      if (t % 60 === 0) for (const a of crawlers) Object.assign(a, { targetX: goal[0], targetY: goal[1], awareness: 1 })
      if (t % 30 !== 29) return
      for (const a of crawlers) {
        const [px, py] = last.get(a.id)!
        fastest = Math.max(fastest, Math.hypot(a.x - px, a.y - py) / (30 * TICK_DT))
        last.set(a.id, [a.x, a.y])
      }
    })
    expect(crawlers.every((a) => a.state === "crawler")).toBe(true)
    expect(fastest).toBeLessThan(0.75)
    const progress = crawlers.reduce((s, a, i) => s + (start[i]! - dist(a, goal)), 0) / crawlers.length
    expect(progress).toBeGreaterThan(8)
  })
})

/** Classic town at night, one idle survivor at `(x, y)`, no director, no crowd. */
function roamWorld(x: number, y: number, ai: Record<string, number> = {}, mode: "classic" | "streaming" = "classic"): CoopSim {
  const sim = new CoopSim(7, 7, 0.22, { zombieCount: 0, directorPacing: 0, startHour: 23, ...ai }, mode)
  sim.addSurvivor("player", 0)
  Object.assign(sim.slots[0]!.survivor, { x, y, flashlightOn: false })
  sim.ai.agents.length = 0
  return sim
}

const members = (sim: CoopSim, h: Horde) => sim.ai.agents.filter((a) => a.hordeId === h.id && a.state !== "dead")

describe("roaming hordes", () => {
  test("a horde out of town hears a gunshot through the walls, walks in and materializes", () => {
    const sim = roamWorld(45, 46)
    const h = placeHorde(sim, -10, 46, 160)
    let materializedAt = -1
    run(sim, 60, (t) => {
      if (t === 60) sim.ai.emitNoise(45, 46, PISTOL_NOISE, "gunshot", sim.time, "player", 2.2)
      if (materializedAt < 0 && h.live > 0) materializedAt = t * TICK_DT
    })
    expect(materializedAt).toBeGreaterThan(10)
    expect(materializedAt).toBeLessThan(35)
    const live = members(sim, h)
    expect(live.length).toBe(160)
    expect(live.filter((a) => Math.hypot(a.x - 45, a.y - 46) < 10).length).toBeGreaterThanOrEqual(120)
  }, 20_000)

  test("a horde too far to hear the shot stays where it is", () => {
    const sim = roamWorld(45, 46)
    const h = placeHorde(sim, -40, 46, 200)
    run(sim, 20, (t) => {
      if (t === 60) sim.ai.emitNoise(45, 46, PISTOL_NOISE, "gunshot", sim.time, "player", 2.2)
    })
    expect(h.goal).toBe(0)
    expect(h.x).toBe(-40)
    expect(h.live).toBe(0)
  })

  test("a quiet horde nobody is near folds back into a point and comes back whole", () => {
    const sim = roamWorld(12, 12)
    const h = placeHorde(sim, 80, 78, 120)
    materializeHorde(sim, h)
    expect(members(sim, h).length).toBe(120)
    run(sim, 1)
    expect(h.live).toBe(0)
    expect(h.pending).toBe(120)
    expect(members(sim, h).length).toBe(0)
    Object.assign(sim.slots[0]!.survivor, { x: 60, y: 62 })
    run(sim, 12)
    expect(h.live + h.pending).toBe(120)
    expect(members(sim, h).length).toBe(120)
  })

  test("streaming: horde members stay out of chunk deltas and fold back when their window unloads", () => {
    const sim = roamWorld(48, 48, {}, "streaming")
    const h = placeHorde(sim, 66, 48, 150)
    materializeHorde(sim, h)
    run(sim, 2)
    expect(h.live).toBe(150)
    for (const chunk of sim.worldStream.activeChunks.values()) {
      sim.worldStream.captureChunkDelta(chunk, sim.town, sim.progression.containers, sim.ai.portalStates, sim.ai.agents)
    }
    Object.assign(sim.slots[0]!.survivor, { x: 48 + 32 * 6, y: 48 })
    run(sim, 1)
    expect(h.live).toBe(0)
    expect(h.pending).toBe(150)
    expect(sim.ai.agents.some((a) => a.hordeId !== undefined)).toBe(false)
    const ids = [...sim.worldStream.deltas.values()].flatMap((d) => Object.keys(d.zombies).map(Number))
    expect(ids.some((id) => id >= HORDE_ID_BASE)).toBe(false)
  })

  test("the director's chaser cap leaves horde members alone", () => {
    const sim = roamWorld(45, 46, { directorPacing: 1, zombieCount: 16, maxActiveNearPlayer: 3 })
    const h = placeHorde(sim, 45, 66, 40, { x: 45, y: 46 })
    materializeHorde(sim, h)
    let peak = 0
    run(sim, 15, () => {
      peak = Math.max(peak, members(sim, h).filter((a) => a.state === "chase" || a.state === "alert").length)
    })
    expect(peak).toBeGreaterThan(sim.ai.pacing.telemetry.effectiveMaxActive + 10)
  })

  test("hordeCount seeds roaming hordes 70–120 m out and the default seeds none", () => {
    const off = roamWorld(28, 57)
    run(off, 1)
    expect(hordesOf(off).hordes.length).toBe(0)
    const on = roamWorld(28, 57)
    const tuning = { hordes: { ...DEFAULT_HORDE_TUNING, hordeCount: 3, hordeSize: 80 } }
    on.stepWorld(TICK_DT, 240, tuning as never)
    const hordes = hordesOf(on).hordes
    expect(hordes.length).toBe(3)
    for (const h of hordes) {
      const d = Math.hypot(h.x - 28, h.y - 57)
      expect(d).toBeGreaterThanOrEqual(70)
      expect(d).toBeLessThanOrEqual(120)
      expect(h.pending).toBe(80)
    }
  })

  test("a live horde and a migrating one replay bit for bit from a mid-run snapshot", () => {
    const sim = roamWorld(45, 46)
    sim.addSurvivor("p2", 1)
    Object.assign(sim.slots[1]!.survivor, { x: 60, y: 60, flashlightOn: true })
    const a = placeHorde(sim, 30, 70, 100, { x: 45, y: 46 })
    materializeHorde(sim, a)
    placeHorde(sim, -8, 50, 120)
    const step = (s: CoopSim, t: number) => {
      for (const slot of s.slots) {
        slot.survivor.health = slot.survivor.maxHealth
        s.stepSurvivor(slot, { mx: 0, my: 0, aim: 0, interact: false }, TICK_DT)
      }
      if (t % 240 === 30) s.ai.emitNoise(45, 46, PISTOL_NOISE, "gunshot", s.time, "player", 2.2)
      s.stepWorld(TICK_DT, 240)
    }
    for (let t = 0; t < 600; t++) step(sim, t)
    const mid = sim.toSnapshot()
    expect((mid.featureStates.hordes as { hordes: Horde[] }).hordes.length).toBe(2)
    for (let t = 600; t < 2100; t++) step(sim, t)
    const replay = CoopSim.fromSnapshot(mid)
    for (let t = 600; t < 2100; t++) step(replay, t)
    expect(hashSimState(replay.toSnapshot())).toBe(hashSimState(sim.toSnapshot()))
    expect(hordesOf(sim).hordes.reduce((s, h) => s + h.live, 0)).toBeGreaterThan(150)
  }, 20_000)
})
