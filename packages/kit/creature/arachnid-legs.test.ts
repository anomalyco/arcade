import { describe, expect, test } from "bun:test"
import { CREATURE_STEP, SecondOrder, cloneCreatureMotion, createCreatureMotion, stepCreatureMotion, unitDt, unitSurface, type CreatureIntent, type CreatureMotion, type CreatureSurface, type CreatureTurn } from "../sim/creature-motion"
import { ArachnidLegs, HARVESTMAN_SHAPE, SPIDER_SHAPE, legLengths, type ArachnidPose, type ArachnidShape } from "./arachnid-legs"

// Lamplight's invariants (`tests/arachnid.rs`, `motion.rs` tests), ported to the TypeScript source.

const plane: CreatureSurface = { heightAt: () => 0 }
const HARVESTMAN = HARVESTMAN_SHAPE
/** A rolling forest floor with trunks, in metres, for a creature 8.75 m per unit. */
const TRUNKS = [[6, 3, 0.45], [14, -4, 0.6], [22, 2, 0.5], [9, -9, 0.4], [30, -3, 0.55], [18, 8, 0.5]] as const
const forest: CreatureSurface = {
  heightAt: (x, z) => 0.5 * Math.sin(x * 0.15) * Math.cos(z * 0.11) + 0.25 * Math.sin(x * 0.37 + z * 0.21),
  walkable: (x, z) => TRUNKS.every(([tx, tz, r]) => Math.hypot(x - tx, z - tz) > r),
}
const walk = (dx: number, dz = 0, pace: CreatureIntent["pace"] = "walk"): CreatureIntent => ({ dx, dz, pace })
const still = walk(0)

type Rig = { motion: CreatureMotion; legs: ArachnidLegs; ground: CreatureSurface; size: number }
function rig(world: CreatureSurface, size = 1, shape: ArachnidShape = SPIDER_SHAPE, x = 0, z = 0, heading = 0): Rig {
  const ground = size === 1 ? world : unitSurface(world, size)
  const motion = createCreatureMotion(x / size, z / size, heading)
  return { motion, legs: new ArachnidLegs(motion, ground, size, shape), ground, size }
}
/** One world tick of 1/60 s. */
function tick(r: Rig, intent: CreatureIntent): void {
  const dt = unitDt(CREATURE_STEP, r.size)
  stepCreatureMotion(r.motion, intent, dt, r.ground)
  r.legs.step(r.motion, r.ground, dt)
}

type Check = { slides: number; minSupports: number; stretch: number; finite: boolean; swingBelow: number; kneeBelow: number; inTrunk: number }
function checked(r: Rig, script: [CreatureIntent, number][], world: CreatureSurface): Check & { poses: ArachnidPose[] } {
  const c: Check & { poses: ArachnidPose[] } = { slides: 0, minSupports: 8, stretch: 0, finite: true, swingBelow: -Infinity, kneeBelow: -Infinity, inTrunk: 0, poses: [] }
  for (const [intent, frames] of script) for (let f = 0; f < frames; f++) {
    const before = r.legs.pose()
    tick(r, intent)
    const after = r.legs.pose()
    c.poses.push(after)
    c.minSupports = Math.min(c.minSupports, after.legs.filter(l => l.planted).length)
    after.legs.forEach((leg, i) => {
      const prev = before.legs[i]!
      if (prev.planted && leg.planted && leg.joints[3].some((v, k) => v !== prev.joints[3][k])) c.slides++
      if (!leg.joints.every(p => p.every(Number.isFinite))) c.finite = false
      const lengths = legLengths(i)
      for (let s = 0; s < 3; s++) {
        const a = leg.joints[s]!, b = leg.joints[s + 1]!
        c.stretch = Math.max(c.stretch, Math.abs(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) / r.size - lengths[s]!))
      }
      const [, knee, , foot] = leg.joints
      // A foot clears the ground plus its own radius (FOOT = 0.018 units) throughout a swing.
      c.swingBelow = Math.max(c.swingBelow, world.heightAt(foot[0], foot[2]) + 0.018 * r.size - foot[1] - 1e-6 * r.size)
      c.kneeBelow = Math.max(c.kneeBelow, world.heightAt(knee[0], knee[2]) - knee[1])
      if (leg.planted && world.walkable && !world.walkable(foot[0], foot[2])) c.inTrunk++
    })
  }
  return c
}

describe("arachnid legs", () => {
  test("walk, run, reverse and stop: planted feet never slide, four always down, legs keep their length", () => {
    const r = rig(plane)
    const c = checked(r, [[walk(1), 180], [walk(1, 0, "run"), 180], [walk(-1, 0, "run"), 240], [still, 180]], plane)
    expect(c.slides).toBe(0)
    expect(c.minSupports).toBeGreaterThanOrEqual(4)
    expect(c.finite).toBe(true)
    expect(c.stretch).toBeLessThan(0.025)
    expect(c.swingBelow).toBeLessThanOrEqual(0)
    expect(c.kneeBelow).toBeLessThan(0)
    const stopped = r.legs.pose()
    expect(stopped.legs.every(l => l.planted)).toBe(true)
    for (let i = 0; i < 120; i++) tick(r, still)
    expect(r.legs.pose().legs.map(l => l.joints[3])).toEqual(stopped.legs.map(l => l.joints[3]))
  })

  test("gait metrics on level ground match lamplight's (duty, swing time)", () => {
    const duties: number[] = []
    for (const pace of ["walk", "run"] as const) {
      const r = rig(plane)
      for (let i = 0; i < 120; i++) tick(r, walk(1, 0, pace))
      let planted = 0
      const swings: number[] = [], run = new Array(8).fill(0)
      for (let f = 0; f < 600; f++) {
        tick(r, walk(1, 0, pace))
        r.legs.pose().legs.forEach((l, i) => {
          if (l.planted) { planted++; if (run[i] > 0) { swings.push(run[i]); run[i] = 0 } } else run[i]++
        })
      }
      const duty = planted / (600 * 8)
      const swing = (swings.reduce((a, b) => a + b, 0) / swings.length) * CREATURE_STEP
      // Lamplight measured 0.656 and 0.514; eased spring targets leave the run at 0.500.
      expect(duty).toBeGreaterThan(pace === "walk" ? 0.63 : 0.49)
      expect(duty).toBeLessThan(pace === "walk" ? 0.68 : 0.55)
      expect(swing).toBeGreaterThan(0.14)
      expect(swing).toBeLessThan(0.16)
      duties.push(duty)
    }
    expect(duties[1]!).toBeLessThan(duties[0]!)
  })

  test("harvestman on a rolling forest floor among trunks: same invariants at 8.75 m per unit", () => {
    const size = 8.75
    const r = rig(forest, size, HARVESTMAN, -6, 0)
    const c = checked(r, [[walk(0.45), 600], [walk(0.3, -0.35), 300], [walk(-0.5, 0.1), 600], [walk(0.4, 0.4), 300], [still, 240]], forest)
    expect(c.slides).toBe(0)
    expect(c.minSupports).toBeGreaterThanOrEqual(4)
    expect(c.finite).toBe(true)
    expect(c.stretch).toBeLessThan(0.025)
    expect(c.swingBelow).toBeLessThanOrEqual(0)
    expect(c.kneeBelow).toBeLessThan(0)
    expect(c.inTrunk).toBe(0)
    // It actually went somewhere, and its body rides high: canopy-underside height, knees above it.
    const body = c.poses.map(p => p.body[1] - forest.heightAt(p.body[0], p.body[2]))
    expect(Math.min(...body)).toBeGreaterThan(2.5)
    const knees = c.poses.flatMap(p => p.legs.map(l => l.joints[1][1] - p.body[1]))
    expect(Math.max(...knees)).toBeGreaterThan(1)
  })

  test("a swing lifts clear of the ground over a bump", () => {
    const bump: CreatureSurface = { heightAt: x => (Math.abs(x - 0.9) < 0.25 ? 0.08 : 0) }
    const r = rig(bump)
    let apex = 0
    const c = checked(r, [[walk(0.8), 240]], bump)
    for (const p of c.poses) for (const l of p.legs) if (!l.planted) apex = Math.max(apex, l.joints[3][1] - bump.heightAt(l.joints[3][0], l.joints[3][2]))
    expect(c.swingBelow).toBeLessThanOrEqual(0)
    expect(apex).toBeGreaterThan(0.055)
  })

  test("every touchdown is reported once, at the foot's planted spot", () => {
    const r = rig(plane)
    let touchdowns = 0, reported = 0
    for (let f = 0; f < 300; f++) {
      const before = r.legs.pose()
      tick(r, walk(1))
      const after = r.legs.pose()
      for (let i = 0; i < 8; i++) if (!before.legs[i]!.planted && after.legs[i]!.planted) touchdowns++
      for (const c of r.legs.contacts) {
        reported++
        expect([c.x, c.y, c.z]).toEqual(after.legs[c.leg]!.joints[3])
      }
    }
    expect(touchdowns).toBeGreaterThan(20)
    expect(reported).toBe(touchdowns)
  })
})

describe("creature root", () => {
  test("replay is byte-identical, legs included, through reversals and stops", () => {
    const run = () => {
      const r = rig(forest, 8.75, HARVESTMAN)
      const states: string[] = []
      for (let f = 0; f < 600; f++) {
        const k = f % 150
        tick(r, k <= 55 ? walk(0.7, 0.2, "run") : k <= 80 && k >= 73 ? still : walk(-0.6, -0.3))
        states.push(JSON.stringify(cloneCreatureMotion(r.motion)))
      }
      return { states, pose: JSON.stringify(r.legs.pose()) }
    }
    const a = run(), b = run()
    expect(a.states).toEqual(b.states)
    expect(a.pose).toBe(b.pose)
  })

  test("running brakes further, then plants and pivots before travelling back", () => {
    const distances: number[] = []
    for (const pace of ["walk", "run"] as const) {
      const m = createCreatureMotion(0, 0)
      for (let i = 0; i < 120; i++) stepCreatureMotion(m, walk(1, 0, pace), CREATURE_STEP, plane)
      expect(m.vx).toBeGreaterThan(pace === "run" ? 2.2 : 1.1)
      const start = { x: m.x, heading: m.heading }
      const phases: CreatureTurn[] = []
      let furthest = m.x, lastYawRate = m.angularVelocity
      for (let i = 0; i < 180; i++) {
        stepCreatureMotion(m, walk(-1, 0, pace), CREATURE_STEP, plane)
        furthest = Math.max(furthest, m.x)
        if (phases.at(-1) !== m.turn) phases.push(m.turn)
        if (m.turn === "braking") expect(Math.abs(m.heading - start.heading)).toBeLessThan(0.01)
        expect(Math.abs(m.angularVelocity - lastYawRate)).toBeLessThanOrEqual(18 * CREATURE_STEP + 1e-9)
        lastYawRate = m.angularVelocity
      }
      expect(phases).toContain("planting")
      expect(phases).toContain("pivoting")
      expect(m.vx).toBeLessThan(-1)
      distances.push(furthest - start.x)
    }
    expect(distances[1]!).toBeGreaterThan(distances[0]! * 2.5)
  })

  test("Froude scaling: a creature S times larger walks √S times faster in metres", () => {
    const small = rig(plane, 1), big = rig(plane, 4)
    for (let i = 0; i < 300; i++) { tick(small, walk(1)); tick(big, walk(1)) }
    const v1 = Math.hypot(small.motion.vx, small.motion.vz), v4 = Math.hypot(big.motion.vx, big.motion.vz) * 4 / Math.sqrt(4)
    expect(v4 / v1).toBeCloseTo(2, 2)
  })
})

describe("second-order response", () => {
  test("anticipates and stays stable under abrupt changes", () => {
    const filter = new SecondOrder()
    let value = filter.step(0, 0, 4, 0.8, -0.8, CREATURE_STEP)
    for (let i = 0; i < 2; i++) value = filter.step(value, 1, 4, 0.8, -0.8, CREATURE_STEP)
    expect(value).toBeLessThan(0)
    for (let i = 0; i < 600; i++) {
      value = filter.step(value, i < 100 ? 1 : 0, 100, 0.65, 1.5, CREATURE_STEP)
      expect(Number.isFinite(value) && Math.abs(value) < 3).toBe(true)
    }
    expect(Math.abs(value)).toBeLessThan(0.0001)
  })

  test("impact velocity scales compression without a position jump", () => {
    const response = (impact: number) => {
      const filter = new SecondOrder()
      filter.speed = -impact * 0.85
      let value = 0, min = 0, max = 0
      for (let i = 0; i < 120; i++) {
        value = filter.step(value, 0, 4.2, 0.55, 0, CREATURE_STEP)
        min = Math.min(min, value)
        max = Math.max(max, value)
      }
      return [min, max] as const
    }
    const soft = response(2), hard = response(4)
    expect(Math.abs(hard[0] / soft[0] - 2)).toBeLessThan(0.001)
    expect(hard[0]).toBeLessThan(-0.06)
    expect(hard[0]).toBeGreaterThan(-0.14)
    expect(hard[1]).toBeGreaterThan(0)
    expect(hard[1]).toBeLessThan(0.03)
  })
})
