import { afterEach, describe, expect, test } from "bun:test"
import type { AIAgent } from "../shared/ai"
import {
  BASE_CALLINGS,
  CALLING_IDS,
  callingIndex,
  callingIndexOf,
  seedForCalling,
  turnedAgo,
  walksEmptyLeash,
} from "../shared/characters/callings"
import { bodyLoot, bodySites } from "../shared/bodies/bodies"
import { DEFAULT_CHARACTERS_TUNING, startHabit, stepHabits, type CharactersState } from "../shared/characters/habits"
import { HabitSiteIndex, habitSites, siteCalling, type HabitSite } from "../shared/characters/sites"
import { TICK_DT } from "../shared/clock"
import { CoopSim } from "../shared/coop-sim"
import { outbreakSharedFeatures } from "../shared/feature-registry"
import { inBuildingFootprint, sightRects } from "../shared/map"
import { encodeSpecialSeed, specialKindOf, SPECIAL_BRUTE, SPECIAL_NONE } from "../shared/specials/kinds"
import { supportHeight } from "../shared/terrain"
import { Vision } from "../shared/vision"
import { clearAmbientCalls } from "../src/audio/soundscape/hooks"
import { characterFrame, type CharacterBeat } from "../src/characters/frame"
import { DEFAULT_CHARACTER_SETTINGS } from "../src/characters/settings"
import { earbudLeak } from "../src/characters/sounds"
import { zombieArchetypeIndex } from "../src/look/refined-figure"
import { zombieTuning } from "../src/zombie-profile"
import { ZombieCrowdRenderer } from "../src/zombies"

const idle = { mx: 0, my: 0, aim: 0, interact: false }
/** Every site in use, so a test can count on the one it set up. */
const ALL_SITES = { characters: { chHabitShare: 50 } }

function world(hour = 14): CoopSim {
  const sim = new CoopSim(7, 7, 0.22, { zombieCount: 0, directorPacing: 0, startHour: hour })
  sim.addSurvivor("player", 0)
  sim.ai.agents.length = 0
  return sim
}

function step(sim: CoopSim, seconds: number, tuning?: object): void {
  const slot = sim.slots[0]!
  for (let i = 0; i < Math.round(seconds / TICK_DT); i++) {
    slot.survivor.health = slot.survivor.maxHealth
    sim.stepSurvivor(slot, { ...idle, aim: slot.survivor.aim }, TICK_DT)
    sim.stepWorld(TICK_DT, 1, tuning as never)
  }
}

const charactersOf = (sim: CoopSim) => sim.getFeatureState<CharactersState>("characters")!

function placeFar(sim: CoopSim, x: number, y: number): void {
  Object.assign(sim.slots[0]!.survivor, { x, y })
}

describe("callings", () => {
  test("are read from seed and id, the same everywhere; Today keeps the six old outfits", () => {
    const counts = new Array(CALLING_IDS.length).fill(0)
    for (let id = 1; id <= 4000; id++) {
      const seed = Math.imul(id, 2654435761) >>> 0
      const c = callingIndex(seed, id)
      expect(callingIndex(seed, id)).toBe(c)
      counts[c]++
      expect(callingIndex(seed, id, false)).toBe(zombieArchetypeIndex(seed, id))
      expect(callingIndex(seed, id, false)).toBeLessThan(BASE_CALLINGS)
      const ago = turnedAgo(seed, id)
      expect(ago).toBeGreaterThanOrEqual(0)
      expect(ago).toBeLessThanOrEqual(1)
    }
    // Every calling turns up; the six old outfits are still most of the town; brides and grooms are rare.
    for (const n of counts) expect(n).toBeGreaterThan(0)
    expect(counts.slice(0, BASE_CALLINGS).reduce((a, b) => a + b, 0) / 4000).toBeGreaterThan(0.6)
    expect(counts[callingIndexOf("bride")]! / 4000).toBeLessThan(0.01)
  })

  test("a special keeps its own silhouette; seedForCalling gives an ordinary seed of the asked calling", () => {
    const brute = encodeSpecialSeed(0x12345678, SPECIAL_BRUTE)
    expect(callingIndex(brute, 9)).toBeLessThan(BASE_CALLINGS)
    expect(walksEmptyLeash(brute, 9)).toBe(false)
    for (const calling of CALLING_IDS) {
      const s = seedForCalling(0xabcdef, 42, callingIndexOf(calling))
      expect(CALLING_IDS[callingIndex(s, 42)]).toBe(calling)
      expect(specialKindOf(s)).toBe(SPECIAL_NONE)
    }
  })
})

describe("habit sites", () => {
  test("are a pure function of the town: knocks inside their own front door, the wedding pair facing each other", () => {
    const sim = world()
    const a = habitSites(sim.town)
    expect(habitSites(sim.town)).toEqual(a)
    expect(a.some((s) => s.kind === "knock")).toBe(true)
    for (const s of a.filter((s) => s.kind === "knock")) {
      const b = sim.town.buildings.find((b) => s.doorId === `${b.id}-front`)!
      expect(inBuildingFootprint(b, s.x, s.y)).toBe(true)
      const door = sim.town.doors.find((d) => d.id === s.doorId)!
      const dx = (door.rect[0] + door.rect[2]) / 2 - s.x
      const dy = (door.rect[1] + door.rect[3]) / 2 - s.y
      // It faces the door.
      expect(Math.cos(Math.atan2(dy, dx) - s.aim)).toBeGreaterThan(0.95)
    }
    for (const s of a) expect(s.callings).toContain(siteCalling(s))
    const index = new HabitSiteIndex()
    index.sync(sim.town)
    for (const s of a) expect(index.at(s.x + 0.1, s.y - 0.1)?.key).toBe(s.key)
  })
})

describe("habit loops", () => {
  function habitWorld() {
    const sim = world()
    const st = charactersOf(sim)
    st.sites = habitSites(sim.town)
    st.dirty = false
    const site = st.sites.find((s) => s.kind === "knock" && sim.ai.nav.walkable({ x: s.x, y: s.y }))!
    return { sim, st, site }
  }

  test("a habit started before the sim has listed its sites (Lab staging after a reset) survives the next step", () => {
    const sim = world()
    const st = charactersOf(sim)
    expect(st.dirty).toBe(true)
    const site = habitSites(sim.town).find((s) => s.kind === "knock" && sim.ai.nav.walkable({ x: s.x, y: s.y }))!
    placeFar(sim, site.x + 20, site.y + 15)
    const z = sim.ai.spawnZombie(sim.town, site.x, site.y, "wander")
    startHabit(sim, st, z, site)
    step(sim, 0.5)
    expect(st.live[z.id]?.key).toBe(site.key)
  })

  test("a new, unaware zombie out of everyone's reach takes a free site, becomes who the place implies, and keeps still", () => {
    const { sim, st, site } = habitWorld()
    // Survivor 25 m off; one zombie appears 8 m from the site.
    placeFar(sim, site.x + 20, site.y + 15)
    for (const s of st.sites) if (s.key !== site.key) st.used[s.key] = 1
    const near = { x: site.x + 6, y: site.y + 5 }
    const spot = sim.ai.nav.nearest(near)
    const z = sim.ai.spawnZombie(sim.town, spot.x, spot.y, "wander")
    step(sim, 0.2, ALL_SITES)
    expect(st.live[z.id]?.key).toBe(site.key)
    expect(Math.hypot(z.x - site.x, z.y - site.y)).toBeLessThan(0.05)
    expect(z.speedScale).toBe(0)
    expect(callingIndex(z.seed, z.id)).toBe(siteCalling(site))
    step(sim, 3, ALL_SITES)
    expect(Math.hypot(z.x - site.x, z.y - site.y)).toBeLessThan(0.05)
    expect(z.aim).toBeCloseTo(site.aim, 5)
  })

  test("never moves one closer to a survivor than it already was", () => {
    const { sim, st, site } = habitWorld()
    for (const s of st.sites) if (s.key !== site.key) st.used[s.key] = 1
    // The survivor is 20 m from the site; the zombie appears 30 m away on the far side.
    placeFar(sim, site.x + 20, site.y)
    const spot = sim.ai.nav.nearest({ x: site.x + 50, y: site.y })
    const z = sim.ai.spawnZombie(sim.town, spot.x, spot.y, "wander")
    step(sim, 0.2, ALL_SITES)
    expect(st.live[z.id]).toBeUndefined()
  })

  test("noticing ends the habit: full senses at once, a beat to turn, then its own pace", () => {
    const { sim, st, site } = habitWorld()
    placeFar(sim, site.x + 60, site.y + 60)
    const z = sim.ai.spawnZombie(sim.town, site.x, site.y, "wander")
    const speed = z.speedScale
    const perception = z.perceptionScale
    startHabit(sim, st, z, site)
    expect(z.perceptionScale).toBeCloseTo(perception * DEFAULT_CHARACTERS_TUNING.chHabitSenses, 6)
    z.state = "alert"
    z.awareness = 1
    stepHabits(sim, st)
    expect(z.perceptionScale).toBeCloseTo(perception, 6)
    expect(z.speedScale).toBe(0)
    sim.time += DEFAULT_CHARACTERS_TUNING.chHabitLetGo * 0.5
    stepHabits(sim, st)
    expect(st.live[z.id]).toBeDefined()
    sim.time += DEFAULT_CHARACTERS_TUNING.chHabitLetGo * 0.6
    stepHabits(sim, st)
    expect(st.live[z.id]).toBeUndefined()
    expect(z.speedScale).toBe(speed)
    expect(st.used[site.key]).toBe(1)
  })

  test("Today and Habit loops off use no sites", () => {
    for (const tuning of [{ characters: { chStyle: 0 } }, { characters: { chHabits: 0 } }]) {
      const { sim, st, site } = habitWorld()
      placeFar(sim, site.x + 60, site.y + 60)
      const spot = sim.ai.nav.nearest({ x: site.x + 4, y: site.y + 4 })
      sim.ai.spawnZombie(sim.town, spot.x, spot.y, "wander")
      step(sim, 0.5, { characters: { ...ALL_SITES.characters, ...tuning.characters } })
      expect(Object.keys(st.live).length).toBe(0)
      expect(Object.keys(st.used).length).toBe(0)
    }
  })

  test("deterministic, forkable, and nothing new on the wire", () => {
    const run = () => {
      const sim = new CoopSim(11, 11)
      sim.addSurvivor("player", 0)
      step(sim, 40)
      return sim
    }
    const a = run()
    const b = run()
    expect(charactersOf(a)).toEqual(charactersOf(b))
    expect(a.ai.agents.map((z) => [z.id, z.seed, z.x, z.y])).toEqual(b.ai.agents.map((z) => [z.id, z.seed, z.x, z.y]))
    expect(outbreakSharedFeatures.get("characters")?.netSection).toBeUndefined()
    const fork = a.clone()
    expect(fork.getFeatureState<CharactersState>("characters")).toEqual(charactersOf(a))
    expect(fork.getFeatureState<CharactersState>("characters")).not.toBe(charactersOf(a))
  })
})

describe("drawing characters", () => {
  // Drawn habits ask the soundscape for their sounds; leave its queue empty for the next file.
  afterEach(() => clearAmbientCalls())
  function scene() {
    const sim = world()
    const st = charactersOf(sim)
    st.sites = habitSites(sim.town)
    st.dirty = false
    const site = st.sites.find((s) => s.kind === "knock" && sim.ai.nav.walkable({ x: s.x, y: s.y }))!
    placeFar(sim, site.x + 60, site.y + 60)
    const z = sim.ai.spawnZombie(sim.town, site.x, site.y, "wander")
    startHabit(sim, st, z, site)
    let model = 0
    const crowd = new ZombieCrowdRenderer({ addModel: () => model++ })
    const vision = new Vision()
    vision.update(site.x, site.y, 0, sightRects(sim.town), { range: 96, cone: 360, awareness: 96 })
    return { sim, site, z, crowd, vision }
  }

  const draw = (crowd: ZombieCrowdRenderer, agents: readonly AIAgent[], vision: Vision, site: HabitSite, time: number) =>
    crowd.draw(agents, 1 / 60, () => 0, vision, [site.x - 20, site.y - 20, site.x + 20, site.y + 20], { ...zombieTuning, zombieLook: 1 }, false, time)

  test("a knocker's run of three knocks is heard once a cycle, even when nobody can see it", () => {
    const { sim, site, crowd } = scene()
    const beats: CharacterBeat[] = []
    const blind = new Vision()
    blind.update(site.x + 80, site.y + 80, 0, sightRects(sim.town), { range: 1, cone: 10, awareness: 1 })
    const onBeat = characterFrame(DEFAULT_CHARACTER_SETTINGS, sim.town, [], [])!.onBeat
    for (let f = 0; f < 60 * 5.4; f++) {
      const frame = characterFrame(DEFAULT_CHARACTER_SETTINGS, sim.town, [], [])!
      frame.onBeat = (b) => beats.push(b)
      crowd.characters = frame
      draw(crowd, sim.ai.agents, blind, site, f / 60)
    }
    characterFrame(DEFAULT_CHARACTER_SETTINGS, sim.town, [], [])!.onBeat = onBeat
    expect(beats.length).toBe(2)
    expect(beats.every((b) => b.kind === "knock" && b.x === site.x)).toBe(true)
  })

  test("the knock reaches the door; Today draws the same instances with no habit", () => {
    const { sim, site, z, crowd, vision } = scene()
    const handReach = (on: boolean) => {
      crowd.characters = on ? characterFrame(DEFAULT_CHARACTER_SETTINGS, sim.town, [], []) : null
      let best = 0
      for (let f = 0; f < 160; f++) {
        draw(crowd, sim.ai.agents, vision, site, f / 60)
        const bones = crowd.getAgentBones(z.id)!.bones
        for (const hand of ["left.foreArm", "right.foreArm"] as const) {
          const p = bones[hand]!.p
          best = Math.max(best, (p[0] - site.x) * Math.cos(site.aim) + (p[2] - site.y) * Math.sin(site.aim))
        }
      }
      return best
    }
    const today = handReach(false)
    const knock = handReach(true)
    expect(knock).toBeGreaterThan(today + 0.15)
  })

  test("an empty lead is drawn from the hand to a collar at a small dog's neck height", () => {
    const sim = world()
    const z = sim.ai.spawnZombie(sim.town, 45, 46, "wander")
    let k = 0
    while (!walksEmptyLeash(z.seed, z.id) && k < 20000) z.seed = seedForCalling((z.seed + ++k * 7919) >>> 0, z.id, callingIndexOf("robe"))
    expect(walksEmptyLeash(z.seed, z.id)).toBe(true)
    let model = 0
    const crowd = new ZombieCrowdRenderer({ addModel: () => model++ })
    const vision = new Vision()
    vision.update(45, 46, 0, sightRects(sim.town), { range: 96, cone: 360, awareness: 96 })
    crowd.characters = characterFrame(DEFAULT_CHARACTER_SETTINGS, sim.town, [], [])
    let batches: ReturnType<ZombieCrowdRenderer["draw"]> = []
    for (let f = 0; f < 30; f++) batches = crowd.draw(sim.ai.agents, 1 / 60, (x, y) => supportHeight(sim.town, x, y), vision, [25, 26, 65, 66], { ...zombieTuning, zombieLook: 1 }, false, f / 60)
    const collar = batches.find((b) => b.count === 1 && b.data[7] === 1 && Math.abs(b.data[1]! - supportHeight(sim.town, b.data[0]!, b.data[2]!) - 0.33) < 0.05)
    expect(collar).toBeDefined()
    expect(batches.some((b) => b.count === 5)).toBe(true)
  })

  test("a bathrobe wears one slipper and one bare foot", () => {
    const sim = world()
    const z = sim.ai.spawnZombie(sim.town, 45, 46, "wander")
    z.seed = seedForCalling(z.seed, z.id, callingIndexOf("robe"))
    let model = 0
    const crowd = new ZombieCrowdRenderer({ addModel: () => model++ })
    const vision = new Vision()
    vision.update(45, 46, 0, sightRects(sim.town), { range: 96, cone: 360, awareness: 96 })
    crowd.characters = characterFrame(DEFAULT_CHARACTER_SETTINGS, sim.town, [], [])
    crowd.draw(sim.ai.agents, 1 / 60, () => 0, vision, [25, 26, 65, 66], { ...zombieTuning, zombieLook: 1 }, false, 0)
    const feet = crowd.partCounts[7]
    expect(feet).toBe(2)
    const footBatch = crowd.batches.find((b) => b.count === 2 && b.model === crowd.batches.find((x) => x === b)!.model && b.data[4] !== b.data[16])
    expect(footBatch).toBeDefined()
  })
})

describe("who the bodies were", () => {
  test("someone on their own porch with their car in the drive carries its keys; never at the start house", () => {
    const sim = new CoopSim(1, 1)
    const body = bodySites(sim.town).find((b) => b.key === "porch:elm")!
    expect(body.ownCar).toEqual({ x: 19.32, y: 64.15 })
    expect(bodyLoot(sim.town, body.key, 1, true).some((s) => s.item === "key")).toBe(true)
    expect(bodyLoot(sim.town, body.key, 0.01, true)[0]).toEqual({ item: "key", count: 1 })
    for (let seed = 1; seed <= 40; seed++) {
      for (const b of bodySites(new CoopSim(seed, seed).town)) if (b.key === "porch:ash") expect(b.ownCar).toBeUndefined()
    }
  })
})

test("a jogger's earbuds leak a quiet, tinny, seamless loop", () => {
  const sr = 24000
  const pcm = earbudLeak(sr)
  expect(pcm.length).toBe(Math.round(sr * (60 / 128) * 16))
  let peak = 0
  let low = 0
  for (let i = 0; i < pcm.length; i++) {
    expect(Number.isFinite(pcm[i]!)).toBe(true)
    peak = Math.max(peak, Math.abs(pcm[i]!))
    low += pcm[i]!
  }
  expect(peak).toBeCloseTo(0.5, 5)
  // High-passed: next to no DC or bass left.
  expect(Math.abs(low / pcm.length)).toBeLessThan(0.001)
})
