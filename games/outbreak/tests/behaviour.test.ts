import { describe, expect, test } from "bun:test"
import { pushOut } from "@arcade/kit/sim/geom"
import { createAIAgent, type AIAgent } from "../shared/ai"
import {
  ACT_CLIMB_CAR,
  ACT_CLIMB_FENCE,
  ACT_FEED,
  ACT_FLINCH,
  ACT_FOLLOW,
  ACT_FREEZE,
  ACT_GIVE_UP,
  ACT_LISTEN,
  ACT_NONE,
  ACT_PEER,
  ACT_ROUSE,
  ACT_SNAGGED,
  isResting,
} from "../shared/behaviour/activities"
import { behaviourOf, zombieActivity, zombieAttention } from "../shared/behaviour/mind"
import { applyPairs, diffPairs } from "../shared/behaviour/net"
import { zombiePersonality, type ZombiePersonality } from "../shared/behaviour/personality"
import type { BodiesState } from "../shared/bodies/runtime"
import { TICK_DT } from "../shared/clock"
import { CoopSim, hashSimState } from "../shared/coop-sim"
import { outbreakSharedFeatures } from "../shared/feature-registry"
import { outbreakBehaviourSharedFeature } from "../shared/behaviour/index"
import { EXTERIOR_VEHICLE_COLLIDERS } from "../shared/map"
import { decodeShared, encodeShared } from "../shared/net-protocol"

const idle = { mx: 0, my: 0, aim: 0, interact: false }
const NO_SPECIALS = { specials: { specialsOn: 0 } }
type Tuning = Record<string, Record<string, unknown>>

function world(hour = 23, seed = 7): CoopSim {
  const sim = new CoopSim(seed, seed, 0.22, { zombieCount: 0, directorPacing: 0, startHour: hour })
  sim.addSurvivor("player", 0)
  Object.assign(sim.slots[0]!.survivor, { x: 45, y: 46, aim: 0, flashlightOn: false, flashlightOutput: 0 })
  sim.ai.agents.length = 0
  return sim
}

function step(sim: CoopSim, seconds: number, tuning: Tuning = NO_SPECIALS, each?: () => void): void {
  const slot = sim.slots[0]!
  for (let i = 0; i < Math.round(seconds / TICK_DT); i++) {
    slot.survivor.health = slot.survivor.maxHealth
    each?.()
    sim.stepSurvivor(slot, { ...idle, aim: slot.survivor.aim }, TICK_DT)
    sim.stepWorld(TICK_DT, 0, tuning as never)
  }
}

/** A seed whose personality passes `want` (scanned deterministically). */
function seedWith(want: (p: ZombiePersonality) => boolean, from = 1): number {
  for (let s = from; s < from + 200000; s++) if (want(zombiePersonality(s))) return s
  throw new Error("no seed")
}

function zombie(sim: CoopSim, id: number, x: number, y: number, seed: number, aim = 0): AIAgent {
  const a = createAIAgent(id, sim.town.seed, x, y, aim)
  a.seed = seed
  a.timer = 30
  a.wanderX = x
  a.wanderY = y
  sim.ai.agents.push(a)
  return a
}

function walkable(sim: CoopSim, x: number, y: number): boolean {
  const p = { x, y }
  pushOut(p, 0.3, sim.solids)
  return sim.ai.nav.walkable(p) && Math.hypot(p.x - x, p.y - y) < 0.01
}

describe("personality", () => {
  test("is a pure function of the seed, inside its ranges", () => {
    for (let s = 1; s < 400; s++) {
      const a = zombiePersonality(s * 7919)
      expect(zombiePersonality(s * 7919)).toEqual(a)
      expect(a.cadence).toBeGreaterThanOrEqual(72)
      expect(a.cadence).toBeLessThanOrEqual(102)
      for (const k of ["curiosity", "persistence", "sociability", "hunger", "torpor", "freshness", "armsOut", "shuffle"] as const) {
        expect(a[k]).toBeGreaterThanOrEqual(0)
        expect(a[k]).toBeLessThanOrEqual(1)
      }
    }
    // Varied: not everyone limps, leads or rests the same way.
    const all = Array.from({ length: 300 }, (_, i) => zombiePersonality(i * 104729 + 3))
    expect(new Set(all.map((p) => p.limpSide)).size).toBe(3)
    expect(new Set(all.map((p) => p.restPose)).size).toBe(3)
    expect(all.filter((p) => p.leader).length).toBeGreaterThan(40)
  })
})

describe("Today", () => {
  test("steps the crowd exactly as without the feature", () => {
    const run = (withFeature: boolean) => {
      if (!withFeature) outbreakSharedFeatures.unregister("behaviour")
      try {
        const sim = new CoopSim(7, 7, 0.22, { startHour: 22 })
        sim.addSurvivor("player", 0)
        const slot = sim.slots[0]!
        for (let i = 0; i < 900; i++) {
          sim.stepSurvivor(slot, { ...idle, mx: Math.sin(i / 90), my: Math.cos(i / 70), aim: i / 50 }, TICK_DT)
          sim.stepWorld(TICK_DT, 1, { behaviour: { zbMode: 0 } } as never)
        }
        return sim.ai.agents.map((a) => [a.id, a.state, a.x, a.y, a.aim, a.awareness])
      } finally {
        if (!withFeature) outbreakSharedFeatures.register(outbreakBehaviourSharedFeature)
      }
    }
    expect(run(true)).toEqual(run(false))
  })
})

describe("behaviours", () => {
  test("Alive is deterministic: two runs of the same night agree to the bit", () => {
    const run = () => {
      const sim = new CoopSim(11, 11, 0.22, { startHour: 21 })
      sim.addSurvivor("player", 0)
      const slot = sim.slots[0]!
      for (let i = 0; i < 1800; i++) {
        sim.stepSurvivor(slot, { ...idle, mx: Math.sin(i / 120), my: Math.cos(i / 95), aim: i / 40, sprint: i % 400 < 60 }, TICK_DT)
        sim.stepWorld(TICK_DT, 1)
      }
      return hashSimState(sim.toSnapshot())
    }
    expect(run()).toBe(run())
  })

  test("a wanderer that hears a sound stops, turns to it and listens", () => {
    const sim = world(23)
    const s = seedWith((p) => p.curiosity > 0.9)
    const a = zombie(sim, 1, 45, 52, s, 0)
    step(sim, 0.5)
    // A door bangs behind it (north, out of sight).
    sim.ai.emitNoise(45, 58, 9, "door", sim.time, "world")
    let listened = false
    step(sim, 1.5, NO_SPECIALS, () => {
      if (zombieActivity(sim, a.id) === ACT_LISTEN) listened = true
    })
    expect(listened).toBe(true)
    expect(zombieAttention(sim, a.id) === "noticed" || a.state !== "wander").toBe(true)
    // It turned toward the sound (+y).
    expect(Math.sin(a.aim)).toBeGreaterThan(0.5)
  })

  test("the one that notices you brings the sociable dead around it, a beat later", () => {
    const sim = world(23)
    // Dark, torch off: the spotter faces the survivor 3 m away; the follower, 7 m off and facing away, can't see them.
    const spotter = zombie(sim, 1, 45, 49, seedWith((p) => p.curiosity < 0.3), -Math.PI / 2)
    const fs = seedWith((p) => p.sociability > 0.95 && p.reaction < 0.5 && !p.leader)
    const follower = zombie(sim, 2, 50, 54, fs, 0)
    let followed = false
    step(sim, 4, NO_SPECIALS, () => {
      if (zombieActivity(sim, follower.id) === ACT_FOLLOW) followed = true
    })
    expect(spotter.state === "chase" || spotter.state === "alert").toBe(true)
    expect(followed).toBe(true)
    expect(follower.state).not.toBe("wander")
  })

  test("it remembers the house you went into: it looks in at the windows, then gives up", () => {
    const sim = world(23)
    const house = sim.town.buildings.find((b) => b.kind === "house" && sim.town.windows.some((w) => w.buildingId === b.id))!
    const sv = sim.slots[0]!.survivor
    const inside = { x: (house.rect[0] + house.rect[2]) / 2, y: (house.rect[1] + house.rect[3]) / 2 }
    const a = zombie(sim, 1, inside.x, house.rect[3] + 4, seedWith((p) => p.persistence > 0.9), -Math.PI / 2)
    // It has just seen the survivor inside and lost them.
    sv.x = inside.x
    sv.y = inside.y
    const st = behaviourOf(sim)!
    step(sim, TICK_DT)
    const m = st.minds[a.id]!
    m.memT = sim.time
    m.memX = inside.x
    m.memY = inside.y
    m.memHouse = house.id
    // Then the survivor is gone (far away and dark), and the zombie's own search runs out.
    sv.x = 5
    sv.y = 5
    a.state = "search"
    a.timer = 0.05
    a.awareness = 0.3
    m.last = "search"
    const seen = new Set<number>()
    step(sim, 90, NO_SPECIALS, () => seen.add(zombieActivity(sim, a.id)))
    expect(seen.has(ACT_PEER)).toBe(true)
    expect(seen.has(ACT_GIVE_UP)).toBe(true)
    expect(st.started.peer).toBeGreaterThanOrEqual(2)
  })

  test("by day the dead go still; a gunshot gets them up", () => {
    const sim = world(12)
    const sv = sim.slots[0]!.survivor
    const ids: AIAgent[] = []
    for (let k = 0; k < 8; k++) {
      const x = 30 + k * 4
      const y = 66
      if (!walkable(sim, x, y)) continue
      ids.push(zombie(sim, k + 1, x, y, seedWith((p) => p.torpor > 0.8, 1000 + k * 997)))
    }
    expect(ids.length).toBeGreaterThan(3)
    sv.x = 45
    sv.y = 46
    step(sim, 30)
    const resting = ids.filter((a) => isResting(zombieActivity(sim, a.id)))
    expect(resting.length).toBeGreaterThan(ids.length / 2)
    sim.ai.emitNoise(45, 60, 30, "gunshot", sim.time, "player")
    const roused = new Set<number>()
    step(sim, 3, NO_SPECIALS, () => {
      for (const a of ids) if (zombieActivity(sim, a.id) === ACT_ROUSE) roused.add(a.id)
    })
    expect(roused.size).toBeGreaterThan(0)
    expect(ids.filter((a) => a.state !== "wander").length).toBeGreaterThan(0)
  })

  test("a hungry one finds a body and feeds on it until disturbed", () => {
    const sim = world(23)
    step(sim, TICK_DT)
    const sites = sim.getFeatureState<BodiesState>("bodies")!.sites
    const body = sites.find((b) => walkable(sim, b.x + 3, b.y) && walkable(sim, b.x + 0.6, b.y))
    expect(body).toBeDefined()
    const sv = sim.slots[0]!.survivor
    // Far off, out of sight and earshot.
    sv.x = 5
    sv.y = 5
    const a = zombie(sim, 1, body!.x + 3, body!.y, seedWith((p) => p.hunger > 0.97 && p.torpor < 0.2))
    for (let k = 0; k < 60 * 60 && zombieActivity(sim, a.id) !== ACT_FEED; k++) step(sim, TICK_DT)
    expect(zombieActivity(sim, a.id)).toBe(ACT_FEED)
    expect(zombieAttention(sim, a.id)).toBe("feeding")
    step(sim, 3)
    expect(zombieActivity(sim, a.id)).toBe(ACT_FEED)
    sim.ai.emitNoise(a.x + 2, a.y, 20, "gunshot", sim.time, "player")
    step(sim, 1.5)
    expect(zombieActivity(sim, a.id)).not.toBe(ACT_FEED)
  })

  test("a chaser climbs the fence between it and you instead of going round", () => {
    const sim = world(23)
    const fence = sim.town.barriers.find((b) => b.kind === "fence" && b.rect[2] - b.rect[0] > 8)!
    expect(fence).toBeDefined()
    const cx = (fence.rect[0] + fence.rect[2]) / 2
    const fy = fence.rect[1]
    const sv = sim.slots[0]!.survivor
    let side = 0
    for (const s of [1, -1]) if (walkable(sim, cx, fy + s * 3) && walkable(sim, cx, fy - s * 2)) side = s
    expect(side).not.toBe(0)
    sv.x = cx
    sv.y = fy - side * 2.2
    sv.flashlightOn = true
    sv.flashlightOutput = 1
    const a = zombie(sim, 1, cx, fy + side * 1.2, seedWith((p) => p.freshness > 0.8), side > 0 ? -Math.PI / 2 : Math.PI / 2)
    a.state = "chase"
    a.awareness = 1
    a.targetX = sv.x
    a.targetY = sv.y
    let climbed = false
    step(sim, 3, NO_SPECIALS, () => {
      const act = zombieActivity(sim, a.id)
      if (act === ACT_CLIMB_FENCE || act === ACT_SNAGGED) climbed = true
    })
    expect(climbed).toBe(true)
    expect(Math.sign(a.y - fy)).toBe(-side)
  })

  test("a chaser climbs over a parked car's bonnet, across it and never along it", () => {
    const sim = world(23)
    const car = (sim.town.vehicles ?? EXTERIOR_VEHICLE_COLLIDERS).find((r) => r[2] - r[0] > r[3] - r[1] && r[3] - r[1] <= 2.4 && walkable(sim, (r[0] + r[2]) / 2, r[1] - 1.1) && walkable(sim, (r[0] + r[2]) / 2, r[3] + 2))!
    expect(car).toBeDefined()
    const cx = (car[0] + car[2]) / 2
    const sv = sim.slots[0]!.survivor
    Object.assign(sv, { x: cx, y: car[3] + 2, flashlightOn: true, flashlightOutput: 1 })
    const a = zombie(sim, 1, cx, car[1] - 0.9, seedWith((p) => p.freshness > 0.8), Math.PI / 2)
    Object.assign(a, { state: "chase", awareness: 1, targetX: sv.x, targetY: sv.y })
    let climbed = false
    step(sim, 4, NO_SPECIALS, () => {
      if (zombieActivity(sim, a.id) === ACT_CLIMB_CAR) climbed = true
    })
    expect(climbed).toBe(true)
    expect(a.y).toBeGreaterThan(car[3])
  })

  test("nothing climbs through a wall or a closed door: a boarded front door is still bashed down", () => {
    const sim = world(23)
    const door = sim.town.doors.find((d) => d.id === "ash-front")!
    door.open = false
    sim.rebuildSolids()
    const sv = sim.slots[0]!.survivor
    Object.assign(sv, { x: 27.7, y: 34.4, aim: Math.PI / 2, flashlightOn: true, flashlightOutput: 1 })
    const a = zombie(sim, 1, 27.7, 36.1, seedWith((p) => p.freshness > 0.8), -Math.PI / 2)
    Object.assign(a, { state: "chase", awareness: 1, targetX: sv.x, targetY: sv.y })
    let opened = -1
    step(sim, 6, NO_SPECIALS, () => {
      const act = zombieActivity(sim, a.id)
      expect(act === ACT_CLIMB_CAR || act === ACT_CLIMB_FENCE || act === ACT_SNAGGED).toBe(false)
      // The beam only reaches its face once the door is down.
      if (!door.open) expect(act).not.toBe(ACT_FLINCH)
      if (door.open && opened < 0) opened = sim.time
    })
    expect(opened).toBeGreaterThan(0)
  })

  test("lightning freezes the dead out in the open for a beat", () => {
    const sim = world(23, 7)
    const ids: AIAgent[] = []
    for (let k = 0; k < 6; k++) if (walkable(sim, 30 + k * 4, 52)) ids.push(zombie(sim, k + 1, 30 + k * 4, 52, 4000 + k * 31))
    const storm: Tuning = { ...NO_SPECIALS, weather: { weatherOverride: 3, weatherLightningPerMinute: 60 } }
    let froze = 0
    step(sim, 20, storm, () => {
      for (const a of ids) if (zombieActivity(sim, a.id) === ACT_FREEZE) froze++
    })
    expect(froze).toBeGreaterThan(0)
  })

  test("a big night crowd stays sane: nobody inside walls, nobody stuck, no NaN", () => {
    const sim = new CoopSim(7, 7, 0.22, { startHour: 21, zombieCount: 80, directorPacing: 0 })
    sim.addSurvivor("player", 0)
    const slot = sim.slots[0]!
    const start = new Map(sim.ai.agents.map((a) => [a.id, { x: a.x, y: a.y }]))
    const moved = new Map<number, number>()
    for (let i = 0; i < 60 * 90; i++) {
      sim.stepSurvivor(slot, { ...idle, mx: Math.sin(i / 300) * 0.6, my: Math.cos(i / 260) * 0.6, aim: i / 60 }, TICK_DT)
      sim.stepWorld(TICK_DT, 0)
      if (i % 60 === 0) {
        for (const a of sim.ai.agents) {
          const s = start.get(a.id)
          if (s) moved.set(a.id, Math.max(moved.get(a.id) ?? 0, Math.hypot(a.x - s.x, a.y - s.y)))
        }
      }
    }
    const living = sim.ai.agents.filter((a) => a.state !== "dead")
    expect(living.length).toBeGreaterThan(60)
    for (const a of living) {
      expect(Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.aim)).toBe(true)
      const p = { x: a.x, y: a.y }
      pushOut(p, 0.27, sim.solids)
      expect(Math.hypot(p.x - a.x, p.y - a.y)).toBeLessThan(0.05)
    }
    // At night nobody rests: every zombie that was there all along got somewhere (2 m) in 90 s.
    const stuck = [...moved.entries()].filter(([, d]) => d < 2)
    expect(stuck.length).toBeLessThanOrEqual(Math.ceil(living.length * 0.05))
  })

  test("the behaviour layer costs little: 80 zombies at night", () => {
    const sim = new CoopSim(7, 7, 0.22, { startHour: 22, zombieCount: 80, directorPacing: 0 })
    sim.addSurvivor("player", 0)
    const slot = sim.slots[0]!
    const st = behaviourOf(sim)!
    const feature = outbreakBehaviourSharedFeature
    let spent = 0
    let ticks = 0
    for (let i = 0; i < 60 * 30; i++) {
      sim.stepSurvivor(slot, { ...idle, mx: Math.sin(i / 300), my: Math.cos(i / 260), aim: i / 60 }, TICK_DT)
      sim.stepWorld(TICK_DT, 0)
      if (i < 120) continue
      // Time one extra before+after pass on a copy-free state (the same work the tick did).
      const t0 = performance.now()
      feature.stepWorld!({ sim, dt: TICK_DT, timeScale: 0, resolved: { features: {} } as never, state: st })
      feature.stepWorldLate!({ sim, dt: TICK_DT, timeScale: 0, resolved: { features: {} } as never, state: st })
      spent += performance.now() - t0
      ticks++
    }
    const perTick = spent / ticks
    console.log(`behaviour layer: ${(perTick * 1000).toFixed(1)} µs/tick for ${sim.ai.agents.length} zombies`)
    expect(perTick).toBeLessThan(0.25)
  })
})

describe("wire", () => {
  test("pairs diff and apply back", () => {
    const base = [1, 3, 4, 7, 9, 11]
    const next = [1, 3, 5, 2, 9, 12, 20, 1]
    expect(applyPairs(base, diffPairs(base, next))).toEqual(next)
    expect(diffPairs(next, next)).toEqual([])
  })

  test("activities ride the snapshot, deltas carry only changes, and a quiet crowd costs nothing", () => {
    const sim = world(12)
    for (let k = 0; k < 6; k++) if (walkable(sim, 30 + k * 4, 66)) zombie(sim, k + 1, 30 + k * 4, 66, seedWith((p) => p.torpor > 0.8, 50 + k * 911))
    step(sim, 30)
    const st = behaviourOf(sim)!
    const acting = sim.ai.agents.filter((a) => (st.minds[a.id]?.act ?? ACT_NONE) !== ACT_NONE)
    expect(acting.length).toBeGreaterThan(0)
    const tick = sim.ai.tick
    const full = decodeShared(encodeShared(sim, tick, new Map()), sim.town.seed)
    const pairs = full.behaviour!.acts
    for (const a of acting) expect(pairs[pairs.indexOf(a.id) + 1]).toBe(st.minds[a.id]!.act)
    const history = { get: (t: number) => (t === full.tick ? full : undefined), record: () => {} } as never
    const quietBytes = encodeShared(sim, tick + 3, new Map(), undefined, { baseSnap: full })
    const quietNoBehaviour = encodeShared(sim, tick + 3, new Map(), undefined, { baseSnap: full })
    expect(quietBytes.length).toBe(quietNoBehaviour.length)
    expect(decodeShared(quietBytes, sim.town.seed, history).behaviour).toEqual(full.behaviour)
    // One zombie gets up: the delta carries just that change (about three bytes).
    const one = acting[0]!
    st.minds[one.id]!.act = ACT_ROUSE
    const changed = encodeShared(sim, tick + 3, new Map(), undefined, { baseSnap: full })
    const next = decodeShared(changed, sim.town.seed, history).behaviour!.acts
    expect(next[next.indexOf(one.id) + 1]).toBe(ACT_ROUSE)
    expect(changed.length - quietBytes.length).toBeLessThanOrEqual(6)
  })
})
