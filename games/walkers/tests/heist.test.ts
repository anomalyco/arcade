import { describe, expect, test } from "bun:test"
import { mulberry32 } from "@arcade/kit/sim/rng"
import { DEFAULT_REWARD, Episode, LASER_RAYS, TRIP_STEPS, observationSize, policyShape, RAY_RANGE, WHISKERS } from "../shared/episode"
import { CREATURES } from "../shared/creatures"
import { beamContact, beamsAt, conesAt, inCone, type Beam, type BeamContact } from "../shared/hazards"
import { courseLevel, HEIST_MAX_STAGE, heistLevel } from "../shared/level"
import { makeCapsule, segSegDist2 } from "../shared/physics"
import { initParams, Policy } from "../shared/policy"
import { envFor } from "../shared/tasks"
import { Trainer } from "../shared/trainer"

const heist = (stage: number) => envFor("heist", { stage })
const beam = (x1: number, y1: number, x2: number, y2: number): Beam => ({ x1, y1, x2, y2, active: true, phase: -1, flip: Infinity, kind: "beam" })

describe("lasers", () => {
  test("segment distance", () => {
    expect(segSegDist2(0, 0, 1, 0, 0, 1, 1, 1)).toBeCloseTo(1, 12)
    expect(segSegDist2(0, 0, 1, 1, 0, 1, 1, 0)).toBe(0)
    expect(segSegDist2(0, 0, 1, 0, 2, 0, 3, 0)).toBeCloseTo(1, 12)
    expect(segSegDist2(0, 0, 0, 0, 3, 4, 3, 4)).toBeCloseTo(25, 12)
  })

  test("a beam trips a capsule it touches and clears one it misses", () => {
    const leg = makeCapsule(0, 0.3, Math.PI / 2, 0.2, 0.05, 1)
    const out: BeamContact = { clearance: 0, touching: 0, near: 0, mask: 0 }
    const hit = beamContact([beam(1, 0.9, 2, 0.9), beam(-1, 0.3, 1, 0.3)], [leg], 1, out)
    expect(hit.clearance).toBeLessThan(0)
    expect(hit.touching).toBe(1)
    expect(hit.mask).toBe(2)
    expect(hit.near).toBe(1)
    const miss = beamContact([beam(-1, 0.6, 1, 0.6)], [leg], 1, out)
    expect(miss.clearance).toBeCloseTo(0.6 - 0.5 - 0.05, 9)
    expect(miss.mask).toBe(0)
    expect(miss.near).toBe(0)
    expect(beamContact([beam(-1, 0.57, 1, 0.57)], [leg], 1, out).near).toBeCloseTo(0.5, 9)
    expect(beamContact([{ ...beam(-1, 0.3, 1, 0.3), active: false }], [leg], 1, out).clearance).toBe(Infinity)
  })

  test("pulsing beams follow their timer, the grid dies with the plate, the sweeper scans up and down", () => {
    const lv = heistLevel({ stage: HEIST_MAX_STAGE, laserSpeed: 1 })
    const pulse = lv.lasers.findIndex((l) => l.kind === "beam" && l.on !== undefined)
    const def = lv.lasers[pulse] as { on: number; off: number }
    const out: Beam[] = []
    expect(beamsAt(lv, 0.01, false, out)[pulse]!.active).toBe(true)
    expect(beamsAt(lv, def.on + 0.01, false, out)[pulse]!.active).toBe(false)
    expect(out[pulse]!.flip).toBeCloseTo(def.off - 0.01, 9)
    expect(beamsAt(lv, def.on + def.off + 0.01, false, out)[pulse]!.active).toBe(true)
    const grid = lv.lasers.map((l, i) => (l.kind === "beam" && l.grid ? i : -1)).filter((i) => i >= 0)
    expect(grid.length).toBeGreaterThan(2)
    for (const i of grid) expect(beamsAt(lv, 0, false, out)[i]!.active).toBe(true)
    for (const i of grid) expect(beamsAt(lv, 0, true, out)[i]!.active).toBe(false)
    const sweep = lv.lasers.findIndex((l) => l.kind === "sweep")
    const def2 = lv.lasers[sweep] as { y: number; amp: number; period: number }
    const ys = Array.from({ length: 40 }, (_, i) => beamsAt(lv, (i * def2.period) / 40, false, out)[sweep]!.y1)
    expect(Math.max(...ys)).toBeCloseTo(def2.y + def2.amp, 2)
    expect(Math.min(...ys)).toBeCloseTo(def2.y - def2.amp, 2)
  })

  test("camera cones see what is inside them only", () => {
    const lv = heistLevel({ stage: HEIST_MAX_STAGE, laserSpeed: 1 })
    const [c] = conesAt(lv, 0, [])
    expect(inCone(c!, c!.x + c!.dx * 1.5, c!.y + c!.dy * 1.5)).toBe(true)
    expect(inCone(c!, c!.x + c!.dx * (c!.range + 0.1), c!.y + c!.dy * (c!.range + 0.1))).toBe(false)
    expect(inCone(c!, c!.x - c!.dy * 1.5, c!.y + c!.dx * 1.5)).toBe(false)
  })
})

describe("heist", () => {
  test("curriculum stages add hazards one group at a time", () => {
    let prev = -1
    for (let s = 0; s <= HEIST_MAX_STAGE; s++) {
      const lv = heistLevel({ stage: s, laserSpeed: 1 })
      const n = lv.lasers.length + lv.cameras.length + (lv.plate ? 1 : 0)
      expect(n).toBeGreaterThan(prev)
      prev = n
      expect(lv.gem).not.toBeNull()
    }
    expect(heistLevel({ stage: 0, laserSpeed: 1 }).lasers.length).toBe(0)
  })

  test("sensors: sizes, ranges, goal direction and the carrying flag", () => {
    const ep = new Episode("quadruped", heist(1), null)
    const o = ep.observe()
    expect(o.length).toBe(observationSize(CREATURES.quadruped))
    for (const v of o) expect(Number.isFinite(v)).toBe(true)
    const c = CREATURES.quadruped
    const base = 6 + 2 * ep.motors.length + c.feet.length + 2 + 4
    const whiskers = o.subarray(base, base + WHISKERS.length)
    for (const v of whiskers) expect(v).toBeGreaterThanOrEqual(0)
    // Straight down from the head sees the floor close by.
    expect(whiskers[0]!).toBeGreaterThan(1 - 1 / RAY_RANGE)
    const lasers = o.subarray(base + WHISKERS.length, base + WHISKERS.length + LASER_RAYS.length)
    for (const v of lasers) expect(v).toBeGreaterThanOrEqual(0)
    const g = base + WHISKERS.length + LASER_RAYS.length
    expect(o[g]!).toBeGreaterThan(0) // the gem is ahead
    expect(o[g + 2]!).toBe(0)
    ep.carrying = true
    expect(ep.observe()[g + 2]).toBe(1)
  })

  test("reward shaping: grabbing the gem pays, progress past it doesn't count without it, the exit needs it", () => {
    const ep = new Episode("quadruped", heist(0), null)
    const gem = ep.level.gem!
    // Teleport the creature: without the gem, credit stops just past the pedestal.
    const shift = (dx: number) => { for (let i = 0; i < ep.n; i++) ep.world.bodies[i]!.x += dx }
    shift(gem.x + 3 - ep.torso.x)
    ep.step()
    expect(ep.carrying).toBe(false)
    expect(ep.fitness).toBeLessThan((gem.x + 0.5) * (1 + DEFAULT_REWARD.upright))
    const ep2 = new Episode("quadruped", heist(0), null)
    const before = ep2.fitness
    const dx = gem.x - ep2.mouth.x
    for (let i = 0; i < ep2.n; i++) ep2.world.bodies[i]!.x += dx
    const dy = gem.y - ep2.mouth.y
    for (let i = 0; i < ep2.n; i++) ep2.world.bodies[i]!.y += Math.min(0, dy)
    ep2.step()
    expect(ep2.carrying).toBe(true)
    expect(ep2.fitness - before).toBeGreaterThan(DEFAULT_REWARD.gem)
  })

  test("touching a beam sounds an alarm and costs points; with maxAlarms the last one ends the run", () => {
    const place = (ep: Episode) => {
      // Under the high beam, standing tall: the chest touches it.
      const high = ep.level.lasers[1]! as { x1: number; x2: number; y1: number }
      const dx = (high.x1 + high.x2) / 2 - ep.torso.x
      for (let i = 0; i < ep.n; i++) ep.world.bodies[i]!.x += dx
    }
    const clean = new Episode("quadruped", heist(1), null, { ...DEFAULT_REWARD, exposure: 0, alarm: 0 })
    const ep = new Episode("quadruped", heist(1), null)
    place(clean)
    place(ep)
    clean.step()
    ep.step()
    // Debounced: one frame in the beam is not an alarm yet, three are.
    expect(ep.alarms).toBe(0)
    for (let i = 1; i < TRIP_STEPS; i++) {
      clean.step()
      ep.step()
    }
    expect(ep.alarms).toBe(1)
    expect(ep.alarmBy).toBe(1)
    expect(ep.done).toBe(false)
    expect(clean.fitness - ep.fitness).toBeGreaterThan(DEFAULT_REWARD.alarm)
    // Still touching the same beam: no new alarm.
    ep.step()
    ep.step()
    expect(ep.alarms).toBe(1)
    const last = new Episode("quadruped", heist(1), null, { ...DEFAULT_REWARD, maxAlarms: 3 })
    last.alarms = 2
    place(last)
    for (let i = 0; i < TRIP_STEPS; i++) last.step()
    expect(last.outcome).toBe("caught")
  })

  test("a heist replays bit-identically", () => {
    const shape = policyShape("quadruped", 12)
    const params = initParams(shape, mulberry32(4))
    const run = () => {
      const ep = new Episode("quadruped", heist(4), new Policy(shape, params))
      while (!ep.done) ep.step()
      return `${ep.fitness} ${ep.time} ${ep.outcome}`
    }
    expect(run()).toBe(run())
  })

  test("the curriculum moves on once escapes come clean two generations running", async () => {
    let gen = 0
    const fake = async (_job: unknown, _p: Float64Array, rows: number) => {
      gen++
      const outcome = new Uint8Array(rows).fill(gen >= 2 ? 2 : 0)
      return { id: 0, fitness: new Float64Array(rows), distance: new Float64Array(rows), steps: new Float64Array(rows), outcome, gem: new Uint8Array(rows), alarms: new Uint8Array(rows) }
    }
    const t = new Trainer({ creature: "quadruped", env: heist(0), hidden: 4, es: { pairs: 2, sigma: 0.05, lr: 0.01, weightDecay: 0 } }, fake)
    await t.generation()
    await t.generation()
    expect(t.env.stage).toBe(0)
    await t.generation()
    expect(t.env.stage).toBe(1)
  })
})

describe("obstacle course", () => {
  test("is seeded, ends at the goal and uses the room kit", () => {
    expect(JSON.stringify(courseLevel(5))).toBe(JSON.stringify(courseLevel(5)))
    expect(JSON.stringify(courseLevel(5))).not.toBe(JSON.stringify(courseLevel(6)))
    const kinds = new Set<string>()
    for (let s = 1; s <= 30; s++) {
      const lv = courseLevel(s)
      for (const p of lv.props) kinds.add(p.kind)
      if (lv.blocks.length) kinds.add("ceiling")
      for (let i = 1; i < lv.floor.length; i++) expect(lv.floor[i]![0]).toBeGreaterThanOrEqual(lv.floor[i - 1]![0])
      expect(lv.floor[lv.floor.length - 1]![1]).toBe(lv.height)
    }
    expect([...kinds].sort()).toEqual(["ceiling", "crate", "platform", "seesaw"])
  })
})
