import { describe, expect, test } from "bun:test"
import { createAIAgent, type AIAgent } from "../shared/ai"
import { TICK_DT } from "../shared/clock"
import { CoopSim } from "../shared/coop-sim"
import { addHorde, HORDE_GOAL_NOISE } from "../shared/hordes/index"
import { sightRects } from "../shared/map"
import { decodeShared, encodeShared } from "../shared/net-protocol"
import {
  DEFAULT_SPECIALS_TUNING,
  encodeSpecialSeed,
  ordinarySeed,
  specialChance,
  specialKindOf,
  SPECIAL_BLOATER,
  SPECIAL_BRUTE,
  SPECIAL_LURKER,
  SPECIAL_NONE,
  SPECIAL_RIOT,
  SPECIAL_RUNNER,
  SPECIAL_SCREAMER,
  type SpecialsTuning,
} from "../shared/specials/kinds"
import { classifySpecials, spawnSpecial, specialsOf } from "../shared/specials/specials"
import { supportHeight } from "../shared/terrain"
import type { PistolAmmo } from "../shared/types"
import { Vision } from "../shared/vision"
import { SoundDirector, type SoundEvent } from "../src/audio/director"
import { soundWorld } from "../src/audio/world"
import { specialAccessoryMeshes, SPECIAL_LOOKS } from "../src/specials/figure"
import { zombieTuning } from "../src/zombie-profile"
import { ZombieCrowdRenderer } from "../src/zombies"

const idle = { mx: 0, my: 0, aim: 0, interact: false }

function world(hour = 23): CoopSim {
  const sim = new CoopSim(7, 7, 0.22, { zombieCount: 0, directorPacing: 0, startHour: hour })
  sim.addSurvivor("player", 0)
  Object.assign(sim.slots[0]!.survivor, { x: 45, y: 46, aim: 0, flashlightOn: false, flashlightOutput: 0 })
  sim.ai.agents.length = 0
  return sim
}

function step(sim: CoopSim, seconds: number, tuning?: { specials?: Partial<SpecialsTuning> }, each?: () => void): void {
  const slot = sim.slots[0]!
  for (let i = 0; i < Math.round(seconds / TICK_DT); i++) {
    slot.survivor.health = slot.survivor.maxHealth
    each?.()
    sim.stepSurvivor(slot, { ...idle, aim: slot.survivor.aim }, TICK_DT)
    sim.stepWorld(TICK_DT, 1, tuning as never)
  }
}

/** `n` street zombies on walkable ground, ids from `idBase`, rolled as they would be on appearing now. */
function crowd(sim: CoopSim, n: number, idBase = 1): AIAgent[] {
  const out: AIAgent[] = []
  for (let id = idBase; out.length < n; id++) {
    const x = 6 + ((id * 37) % 84)
    const y = 6 + ((id * 53) % 84)
    if (!sim.ai.nav.walkable({ x, y })) continue
    const a = createAIAgent(id, sim.town.seed, x, y)
    sim.ai.agents.push(a)
    out.push(a)
  }
  return out
}

function kinds(agents: readonly AIAgent[]): number[] {
  return agents.map((a) => specialKindOf(a.seed))
}

const ammo = (): PistolAmmo => ({ loaded: 8, capacity: 8, reserve: 0, spend: () => true, reload: () => true, fill() {} })

function armed(sim: CoopSim, x: number, y: number, aim: number) {
  const p = sim.slots[0]!.survivor
  Object.assign(p, { x, y, aim, equippedItem: "pistol", fireCooldown: 0, reloadRemaining: 0, shoveCooldown: 0 })
  return p
}

describe("special zombie kinds", () => {
  test("the kind rides in the seed, and ordinary seeds never read as special", () => {
    for (let k = SPECIAL_RUNNER; k <= SPECIAL_LURKER; k++) {
      for (const seed of [0, 1, 0xdeadbeef, 123456789, 0xffffffff]) {
        expect(specialKindOf(encodeSpecialSeed(seed, k as 1)) as number).toBe(k)
      }
    }
    let accidental = 0
    for (let s = 0; s < 200_000; s++) {
      const seed = Math.imul(s + 1, 0x9e3779b1) >>> 0
      if (specialKindOf(seed) !== SPECIAL_NONE) {
        accidental++
        expect(specialKindOf(ordinarySeed(seed))).toBe(SPECIAL_NONE)
      }
    }
    expect(accidental).toBeLessThan(60)
  })

  test("rolls are deterministic from the town seed and zombie id", () => {
    const roll = () => {
      const sim = world(23)
      const agents = crowd(sim, 600)
      classifySpecials(sim, specialsOf(sim), { ...DEFAULT_SPECIALS_TUNING, specialNightChance: 0.2, specialMaxChance: 1 })
      return agents.map((a) => [a.id, a.seed, a.x, a.y])
    }
    expect(roll()).toEqual(roll())
  })

  test("specials are rare, rarer by day, never Runners by day, and grow with the nights", () => {
    const rate = (hour: number, night: number) => {
      const sim = world(hour)
      const st = specialsOf(sim)
      st.night = night
      const agents = crowd(sim, 3000)
      classifySpecials(sim, st, DEFAULT_SPECIALS_TUNING)
      const ks = kinds(agents)
      return { rate: ks.filter((k) => k !== SPECIAL_NONE).length / ks.length, runners: ks.filter((k) => k === SPECIAL_RUNNER).length }
    }
    const day = rate(12, 1)
    const night1 = rate(23, 1)
    const night4 = rate(23, 4)
    expect(day.runners).toBe(0)
    expect(day.rate).toBeLessThan(0.012)
    expect(night1.rate).toBeGreaterThan(0.012)
    expect(night1.rate).toBeLessThan(0.045)
    expect(night1.runners).toBeGreaterThan(0)
    expect(night4.rate).toBeGreaterThan(night1.rate)
    expect(night4.rate).toBeLessThanOrEqual(DEFAULT_SPECIALS_TUNING.specialMaxChance + 0.02)
    expect(specialChance({ ...DEFAULT_SPECIALS_TUNING, specialsOn: 0 }, { darkness: 1, night: 5 })).toBe(0)
  })

  test("Lurkers are placed in unlit rooms, out of the start house", () => {
    const sim = world(23)
    const agents = crowd(sim, 2000)
    classifySpecials(sim, specialsOf(sim), {
      ...DEFAULT_SPECIALS_TUNING,
      specialNightChance: 1,
      specialMaxChance: 1,
      runnerWeight: 0,
      bruteWeight: 0,
      screamerWeight: 0,
      bloaterWeight: 0,
      riotWeight: 0,
    })
    const lurkers = agents.filter((a) => specialKindOf(a.seed) === SPECIAL_LURKER)
    expect(lurkers.length).toBeGreaterThan(20)
    for (const a of lurkers) {
      expect(sim.town.buildings.some((b) => a.x >= b.rect[0] && a.x <= b.rect[2] && a.y >= b.rect[1] && a.y <= b.rect[3])).toBe(true)
      expect(a.x >= 22 && a.x <= 37 && a.y >= 24 && a.y <= 35.5).toBe(false)
    }
  })
})

describe("special zombie behaviours", () => {
  test("a Brute shrugs off a shove; an ordinary zombie staggers", () => {
    const sim = world(23)
    const p = armed(sim, 45, 46, 0)
    const brute = spawnSpecial(sim, SPECIAL_BRUTE, 46.2, 46, Math.PI)!
    expect(brute.hp).toBe(DEFAULT_SPECIALS_TUNING.bruteHp)
    sim.combat.meleeShove(p, sim.ai, sightRects(sim.town), sim.time)
    expect(brute.state).not.toBe("stagger")
    sim.ai.agents.length = 0
    const plain = sim.ai.spawnZombie(sim.town, 46.2, 46, "wander", Math.PI)
    p.shoveCooldown = 0
    sim.combat.meleeShove(p, sim.ai, sightRects(sim.town), sim.time)
    expect(plain.state).toBe("stagger")
  })

  test("a Brute beats down a barricade faster", () => {
    const bashTime = (kind: number) => {
      const sim = world(23)
      const door = sim.town.doors[0]!
      sim.ai.addBarricadePlank(door.id)
      sim.ai.addBarricadePlank(door.id)
      sim.rebuildCollision()
      const cx = (door.rect[0] + door.rect[2]) / 2
      const cy = (door.rect[1] + door.rect[3]) / 2
      const a = kind ? spawnSpecial(sim, kind as 2, cx, cy)! : sim.ai.spawnZombie(sim.town, cx, cy)
      Object.assign(a, { state: "bash", activePortalId: door.id, timer: 0.9, x: cx, y: cy + 0.6, aggression: 1 })
      let t = 0
      while (sim.ai.getBarricadePlanks(door.id) > 0 && t < 60) {
        a.state = a.state === "dead" ? "dead" : "bash"
        a.activePortalId = door.id
        a.x = cx
        a.y = cy + 0.6
        step(sim, TICK_DT)
        t += TICK_DT
      }
      return t
    }
    const plain = bashTime(0)
    const brute = bashTime(SPECIAL_BRUTE)
    expect(brute).toBeLessThan(plain / 2)
  })

  test("a Riot cop's shield soaks shots and shoves from the front, not from behind", () => {
    const sim = world(23)
    const p = armed(sim, 45, 46, 0)
    const riot = spawnSpecial(sim, SPECIAL_RIOT, 49, 46, Math.PI)!
    riot.aim = Math.PI
    const full = DEFAULT_SPECIALS_TUNING.riotHp
    sim.combat.firePistol(p, sim.ai, sightRects(sim.town), sim.time, ammo(), "player")
    expect(riot.hp).toBeGreaterThan(full - 10)
    expect(riot.state).toBe("wander")
    expect(sim.combat.hitRule!(riot, { kind: "shove", fromX: 45, fromY: 46, damage: 15, heavy: false })).toEqual({ damage: 0, react: false })
    riot.aim = 0
    p.fireCooldown = 0
    const before = riot.hp
    sim.combat.firePistol(p, sim.ai, sightRects(sim.town), sim.time, ammo(), "player")
    expect(before - riot.hp).toBeGreaterThanOrEqual(42)
  })

  test("a Bloater bursts into gas that hurts survivors and zombies inside", () => {
    const sim = world(23)
    const bloater = spawnSpecial(sim, SPECIAL_BLOATER, 47, 46, Math.PI)!
    const bystander = sim.ai.spawnZombie(sim.town, 47.6, 46.4)
    bloater.hp = 0
    bloater.state = "dead"
    const slot = sim.slots[0]!
    Object.assign(slot.survivor, { x: 46.5, y: 46 })
    sim.stepSurvivor(slot, idle, TICK_DT)
    sim.stepWorld(TICK_DT, 1)
    const st = specialsOf(sim)
    expect(st.clouds.length).toBe(1)
    expect(st.bursts).toBe(1)
    const hp0 = slot.survivor.health
    const z0 = bystander.hp
    for (let i = 0; i < 60; i++) {
      Object.assign(slot.survivor, { x: 46.5, y: 46 })
      sim.stepSurvivor(slot, idle, TICK_DT)
      sim.stepWorld(TICK_DT, 1)
    }
    expect(hp0 - slot.survivor.health).toBeGreaterThan(DEFAULT_SPECIALS_TUNING.gasDamage * 0.7)
    expect(bystander.hp).toBeLessThan(z0)
    for (let i = 0; i < Math.round((DEFAULT_SPECIALS_TUNING.gasTime + 1) / TICK_DT); i++) sim.stepWorld(TICK_DT, 1)
    expect(st.clouds.length).toBe(0)
    expect(st.bursts).toBe(1)
  })

  test("a Screamer that spots a survivor shrieks and pulls a horde to it", () => {
    const sim = world(23)
    Object.assign(sim.slots[0]!.survivor, { x: 45, y: 46, aim: 0, flashlightOn: true, flashlightOutput: 1 })
    const screamer = spawnSpecial(sim, SPECIAL_SCREAMER, 48, 46, Math.PI)!
    const horde = addHorde(sim, 45, 4, 30)
    step(sim, 3)
    const st = specialsOf(sim)
    expect(st.shrieks).toBeGreaterThanOrEqual(1)
    expect(horde.goal).toBe(HORDE_GOAL_NOISE)
    expect(Math.hypot(horde.goalX - screamer.x, horde.goalY - screamer.y)).toBeLessThan(4)
  })

  test("a Screamer staggered mid-shriek never lands it", () => {
    const sim = world(23)
    const p = sim.slots[0]!.survivor
    Object.assign(p, { x: 45, y: 46, aim: 0, flashlightOn: true, flashlightOutput: 1 })
    const screamer = spawnSpecial(sim, SPECIAL_SCREAMER, 46.4, 46, Math.PI)!
    let shoved = false
    step(sim, 1.2, undefined, () => {
      if (!shoved && screamer.state === "alert") {
        shoved = true
        p.shoveCooldown = 0
        sim.combat.meleeShove(p, sim.ai, sightRects(sim.town), sim.time)
      }
    })
    expect(shoved).toBe(true)
    expect(specialsOf(sim).shrieks).toBe(0)
  })

  test("a Lurker sleeps in the dark and wakes when the light hits it", () => {
    const sim = world(23)
    const p = sim.slots[0]!.survivor
    Object.assign(p, { x: 45, y: 46, aim: Math.PI, flashlightOn: false, flashlightOutput: 0 })
    const lurker = spawnSpecial(sim, SPECIAL_LURKER, 51, 46, Math.PI)!
    const at = [lurker.x, lurker.y]
    step(sim, 2)
    const rt = specialsOf(sim).live[lurker.id]!
    expect(rt.dormant).toBe(true)
    expect(lurker.state).toBe("wander")
    expect(Math.hypot(lurker.x - at[0]!, lurker.y - at[1]!)).toBeLessThan(0.05)
    Object.assign(p, { aim: 0, flashlightOn: true, flashlightOutput: 1 })
    step(sim, 0.5)
    expect(rt.dormant).toBe(false)
    expect(["alert", "chase"]).toContain(lurker.state)
  })

  test("a Runner sprints only after dark", () => {
    const night = world(23)
    const r = spawnSpecial(night, SPECIAL_RUNNER, 50, 46, Math.PI)!
    const base = specialsOf(night).live[r.id]!.baseSpeed
    r.state = "chase"
    r.awareness = 1
    step(night, TICK_DT)
    expect(r.speedScale).toBeCloseTo(base * DEFAULT_SPECIALS_TUNING.runnerSprint, 5)
    const day = world(12)
    const d = spawnSpecial(day, SPECIAL_RUNNER, 50, 46, Math.PI)!
    d.state = "chase"
    step(day, TICK_DT)
    expect(d.speedScale).toBeCloseTo(specialsOf(day).live[d.id]!.baseSpeed * DEFAULT_SPECIALS_TUNING.runnerDaySpeed, 5)
  })
})

describe("special zombies in co-op", () => {
  test("every zombie reaches clients with its kind, including ones the director spawns mid-step", () => {
    const sim = world(23)
    const tuning = { specials: { specialNightChance: 0.5, specialMaxChance: 1 } }
    crowd(sim, 40, 100)
    // The director spawns during the crowd step; stand in for it.
    const stepSurvivors = sim.ai.stepSurvivors.bind(sim.ai)
    let nextId = 2000
    sim.ai.stepSurvivors = (...args: Parameters<typeof stepSurvivors>) => {
      const res = stepSurvivors(...args)
      if (sim.ai.tick % 4 === 0) sim.ai.agents.push(createAIAgent(nextId++, sim.town.seed, 20 + (nextId % 50), 80))
      return res
    }
    let checked = 0
    let specials = 0
    for (let tick = 1; tick <= 120; tick++) {
      step(sim, TICK_DT, tuning)
      if (tick % 3 !== 0) continue
      const snap = decodeShared(encodeShared(sim, tick, new Map()), sim.town.seed)
      const server = new Map(sim.ai.agents.map((a) => [a.id, specialKindOf(a.seed)]))
      for (const z of snap.zombies) {
        expect(specialKindOf(z.seed)).toBe(server.get(z.id)!)
        if (specialKindOf(z.seed) !== SPECIAL_NONE) specials++
        checked++
      }
    }
    expect(checked).toBeGreaterThan(500)
    expect(specials).toBeGreaterThan(0)
  })
})

describe("special zombies, read and heard", () => {
  test("each kind draws with its own scale and accessories", () => {
    const sim = world(23)
    const all = [SPECIAL_RUNNER, SPECIAL_BRUTE, SPECIAL_SCREAMER, SPECIAL_BLOATER, SPECIAL_RIOT, SPECIAL_LURKER] as const
    all.forEach((k, i) => spawnSpecial(sim, k, 40 + i * 2, 50, 0))
    sim.ai.spawnZombie(sim.town, 40, 54)
    let model = 0
    const crowd = new ZombieCrowdRenderer({ addModel: () => model++ })
    const vision = new Vision()
    vision.update(44, 50, 0, sightRects(sim.town), { range: 96, cone: 360, awareness: 96 })
    let batches: ReturnType<ZombieCrowdRenderer["draw"]> = []
    for (let f = 0; f < 3; f++) {
      batches = crowd.draw(sim.ai.agents, TICK_DT, (x, z) => supportHeight(sim.town, x, z), vision, [0, 0, 96, 96], { ...zombieTuning, zombieLook: 1 }, false)
    }
    const scales = new Set<number>()
    for (const b of batches) for (let i = 0; i < b.count; i++) scales.add(Math.round(b.data[i * 12 + 7]! * 100) / 100)
    expect(scales.has(1)).toBe(true)
    for (const k of all) expect(scales.has(Math.round(SPECIAL_LOOKS[k].scale * 100) / 100)).toBe(true)
    const accessoryCount = specialAccessoryMeshes().length
    expect(accessoryCount).toBe(7)
    // Bib, helmet, shield, shoulders, belly, jaw and eyes: one each.
    const accessoryBatches = batches.filter((b) => b.count === 1 && b.model < accessoryCount + 9 && b.model >= 9)
    expect(accessoryBatches.length).toBe(accessoryCount)
  })

  test("a Screamer's shriek, a Bloater's burst and a bullet off a riot shield are heard", () => {
    const sim = world(23)
    const director = new SoundDirector()
    const listener = { x: 45, y: 46 }
    const screamer = spawnSpecial(sim, SPECIAL_SCREAMER, 48, 46, Math.PI)!
    const bloater = spawnSpecial(sim, SPECIAL_BLOATER, 44, 50, 0)!
    const riot = spawnSpecial(sim, SPECIAL_RIOT, 49, 44, Math.PI)!
    director.observe(soundWorld(sim), listener)
    sim.time += 0.1
    screamer.state = "alert"
    bloater.state = "dead"
    riot.aim = Math.PI
    const p = armed(sim, 45, 44, 0)
    sim.combat.firePistol(p, sim.ai, sightRects(sim.town), sim.time, ammo(), "player")
    const events: SoundEvent[] = director.observe(soundWorld(sim), listener)
    const ids = events.map((e) => `${e.id}@${e.rate ?? 1}`)
    expect(ids).toContain("zombie.alert@1.55")
    expect(ids).toContain("zombie.hit@0.5")
    expect(events.some((e) => e.id === "impact.bullet.metal")).toBe(true)
  })
})
