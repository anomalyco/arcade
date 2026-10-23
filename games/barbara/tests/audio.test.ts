import { describe, expect, test } from "bun:test"
import { createDistant, DISTANT_RULES, holdDistant, stepDistant, type DistantEvent } from "../shared/distant"
import { makeWorld } from "../shared/world"
import { gustAt, GUST_SPEED, insectLevel, nearestShore, WIND_DIR, windExposure } from "../src/audio/space"

const world = makeWorld()

/** One walker leaving camp up the trail and wandering out, stepped at 10 Hz for `minutes`. */
function run(seed: number, minutes: number, hold?: (t: number) => number | null) {
  const ds = createDistant(seed)
  const out: DistantEvent[] = []
  const camp = world.camp
  for (let i = 0; i <= minutes * 600; i++) {
    const t = i / 10
    const r = Math.min(170, t * 0.25)
    const p = { x: camp.x + r * 0.3, z: camp.z - r }
    const h = hold?.(t)
    if (h != null) holdDistant(ds, h)
    const e = stepDistant(ds, world, [p], t)
    if (e) out.push(e)
  }
  return out
}

describe("distant events", () => {
  test("the same seed and people give the same events, sound, take, place and time", () => {
    expect(run(7, 30)).toEqual(run(7, 30))
    expect(run(7, 30)).not.toEqual(run(8, 30))
  })

  test("sparse at first, more often later, never two at once, never the same sound twice running", () => {
    const events = run(3, 40)
    expect(events[0]!.at).toBeGreaterThanOrEqual(70)
    for (let i = 1; i < events.length; i++) {
      const a = events[i - 1]!, b = events[i]!
      expect(b.sound).not.toBe(a.sound)
      expect(b.at - a.at).toBeGreaterThan(DISTANT_RULES[a.sound].seconds)
    }
    const early = events.filter((e) => e.at < 600).length, late = events.filter((e) => e.at >= 1800).length
    expect(early).toBeLessThanOrEqual(5)
    expect(late).toBeGreaterThan(early)
  })

  test("a signal holds them off", () => {
    const events = run(3, 20, (t) => (t % 30 === 0 ? t + 25 : null))
    for (const e of events) expect(e.at % 30).toBeGreaterThanOrEqual(25 - 0.11)
  })

  test("each sound is placed where it belongs", () => {
    const events = [...run(1, 40), ...run(2, 40), ...run(5, 40)]
    for (const e of events) {
      const rule = DISTANT_RULES[e.sound]
      if (rule.place === "lake") expect(Math.hypot((e.x - world.lake.x) / world.lake.rx, (e.z - world.lake.z) / world.lake.rz)).toBeLessThan(1)
      if (rule.place === "camp") expect(Math.hypot(e.x - world.camp.x, e.z - world.camp.z)).toBeLessThan(world.camp.radius)
      if (rule.place === "beyond") expect(Math.max(Math.abs(e.x), Math.abs(e.z))).toBeGreaterThan(world.params.half)
    }
    expect(new Set(events.map((e) => e.sound)).size).toBeGreaterThanOrEqual(8)
  })
})

describe("listener space", () => {
  test("wind is stronger on the ridge than in camp's hollow", () => {
    expect(windExposure(world, 62, -175)).toBeGreaterThan(windExposure(world, world.camp.x, world.camp.z) + 0.2)
  })
  test("crickets thin out away from camp", () => {
    expect(insectLevel(world, world.camp.x, world.camp.z)).toBeCloseTo(1, 1)
    expect(insectLevel(world, 120, -150)).toBeLessThan(0.25)
  })
  test("gusts sweep downwind at the gust speed", () => {
    for (let k = 0; k < 20; k++) {
      const x = -100 + k * 9, z = 40 - k * 5, t = k * 3.1
      const v = gustAt(x, z, t)
      expect(v).toBeGreaterThanOrEqual(0.08)
      expect(v).toBeLessThanOrEqual(1)
      expect(gustAt(x + WIND_DIR[0] * GUST_SPEED * 4, z + WIND_DIR[1] * GUST_SPEED * 4, t + 4)).toBeCloseTo(v, 3)
    }
  })
  test("the nearest shore is on the shoreline and nearest", () => {
    const s = nearestShore(world, world.camp.x, world.camp.z)
    expect(Math.hypot((s.x - world.lake.x) / world.lake.rx, (s.z - world.lake.z) / world.lake.rz)).toBeCloseTo(1, 3)
    expect(s.d).toBeLessThan(world.lake.z - world.lake.rz - world.camp.z + 1)
  })
})
