import { describe, expect, test } from "bun:test"
import { answerCall, createDistant, DISTANT_RULES, distantDread, holdDistant, MIMIC_LINES, stepDistant, triggerUncanny, UNCANNY_FIRST, UNCANNY_SOUNDS, uncannyChance, type DistantEvent } from "../shared/distant"
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

describe("uncanny distant sounds", () => {
  const strange = (events: DistantEvent[]) => events.filter((e) => (UNCANNY_SOUNDS as readonly string[]).includes(e.sound))

  test("none in the first eight minutes, each at most once a night, the same for the same seed", () => {
    let seen = 0
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const odd = strange(run(seed, 45))
      seen += odd.length
      for (const e of odd) expect(e.at).toBeGreaterThanOrEqual(UNCANNY_FIRST)
      expect(new Set(odd.map((e) => e.sound)).size).toBe(odd.length)
    }
    expect(seen).toBeGreaterThan(0)
    expect(strange(run(4, 45))).toEqual(strange(run(4, 45)))
  })

  test("more likely late and far from camp than early near it; off when switched off", () => {
    expect(uncannyChance(distantDread(600, 20))).toBe(0)
    expect(uncannyChance(distantDread(1500, 180))).toBeGreaterThan(0.6)
    const near = (seed: number, on: boolean) => {
      const ds = createDistant(seed), out: DistantEvent[] = []
      for (let i = 0; i <= 45 * 600; i++) { const e = stepDistant(ds, world, [{ x: world.camp.x + 8, z: world.camp.z - 30 }], i / 10, 1, { uncanny: on, uncannyRate: 1 }); if (e) out.push(e) }
      return out
    }
    const countNear = [1, 2, 3, 4, 5, 6].reduce((n, s) => n + strange(near(s, true)).filter((e) => e.at < 1200).length, 0)
    const countFar = [1, 2, 3, 4, 5, 6].reduce((n, s) => n + strange(run(s, 45)).filter((e) => e.at < 1200).length, 0)
    expect(countFar).toBeGreaterThan(countNear)
    expect(strange(near(3, false))).toEqual([])
  })

  test("the mimic answers a call from the far side of whoever was nearest the caller, after the call, once", () => {
    const ds = createDistant(9)
    const me = { x: 100, z: -40 }, caller = { x: 100, z: -120 }
    const t0 = 1500
    expect(answerCall(ds, world, [me], "walt.ask.1", caller, 2, t0, undefined, true)).toBe(false)
    expect(answerCall(ds, world, [me], "walt.call.1", caller, 2.24, t0, undefined, true)).toBe(true)
    let e: DistantEvent | null = null
    for (let t = t0; t < t0 + 15 && !e; t += 0.1) e = stepDistant(ds, world, [me], t)
    expect(e?.sound).toBe("far.mimic")
    expect(e!.take).toBe(MIMIC_LINES.indexOf("walt.call.1"))
    expect(e!.at).toBeGreaterThan(t0 + 80 / 343 + 2.24)
    const d = Math.hypot(e!.x - me.x, e!.z - me.z)
    expect(d).toBeGreaterThanOrEqual(DISTANT_RULES["far.mimic"].near - 1)
    // Away from the caller: on the far side of me.
    expect((e!.x - me.x) * (caller.x - me.x) + (e!.z - me.z) * (caller.z - me.z)).toBeLessThan(0)
    expect(answerCall(ds, world, [me], "walt.call.1", caller, 2.24, t0 + 60)).toBe(false)
  })

  test("an animal is got where the creature last crossed, and the creature is due again soon after", () => {
    const ds = createDistant(11)
    const me = { x: 40, z: -110 }
    ds.creature.last = { x: 40, z: -10, at: 900 }
    ds.creature.next = 5000
    const e = triggerUncanny(ds, world, [me], "far.taken", 1000)!
    expect(e.sound).toBe("far.taken")
    expect(Math.hypot(e.x - 40, e.z + 10)).toBeLessThan(25)
    expect(ds.creature.next).toBeLessThan(1000 + 120)
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
