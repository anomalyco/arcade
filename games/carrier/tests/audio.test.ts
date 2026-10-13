import { describe, expect, test } from "bun:test"
import {
  FLYBY,
  FlybyWatch,
  SPEED_OF_SOUND,
  VelocityTracker,
  airCutoff,
  alignPeak,
  closestApproach,
  distanceGain,
  dopplerRatio,
  flybyKind,
  jetCone,
  makeApproach,
  makeFlybyPlan,
  rpmFor,
  spoolStep,
} from "../src/audio/jet-math"

describe("distance and air", () => {
  test("full level inside the reference, inverse distance beyond", () => {
    expect(distanceGain(10, 40)).toBe(1)
    expect(distanceGain(40, 40)).toBe(1)
    expect(distanceGain(400, 40)).toBeCloseTo(40 / 400, 6)
    expect(distanceGain(2000, 40)).toBeLessThan(distanceGain(1000, 40))
  })
  test("air absorption darkens with distance", () => {
    expect(airCutoff(0)).toBe(20000)
    expect(airCutoff(1000)).toBeGreaterThan(3000)
    expect(airCutoff(1000)).toBeLessThan(4500)
    expect(airCutoff(3000)).toBeLessThan(airCutoff(1000))
    expect(airCutoff(1e6)).toBe(250)
  })
})

describe("doppler", () => {
  test("approaching is higher, receding lower, crossing none", () => {
    // Source 500 m ahead (+x) coming at 100 m/s.
    const up = dopplerRatio(500, 0, 0, -100, 0, 0)
    expect(up).toBeCloseTo(SPEED_OF_SOUND / (SPEED_OF_SOUND - 100), 6)
    const down = dopplerRatio(500, 0, 0, 100, 0, 0)
    expect(down).toBeCloseTo(SPEED_OF_SOUND / (SPEED_OF_SOUND + 100), 6)
    expect(dopplerRatio(500, 0, 0, 0, 0, 200)).toBeCloseTo(1, 6)
  })
  test("the amount compresses toward 1, and the ratio stays bounded", () => {
    const full = dopplerRatio(500, 0, 0, -250, 0, 0, 1)
    const soft = dopplerRatio(500, 0, 0, -250, 0, 0, 0.6)
    expect(soft).toBeGreaterThan(1)
    expect(soft).toBeLessThan(full)
    expect(dopplerRatio(500, 0, 0, -2000, 0, 0)).toBeLessThanOrEqual(3)
    expect(dopplerRatio(500, 0, 0, 2000, 0, 0)).toBeGreaterThanOrEqual(0.35)
    expect(dopplerRatio(0.2, 0, 0, -300, 0, 0)).toBe(1)
  })
  test("a flyby sweeps down monotonically through the pass", () => {
    let prev = Number.POSITIVE_INFINITY
    for (let t = -4; t <= 4; t += 0.25) {
      // Along x at 220 m/s, 40 m off to the side.
      const r = dopplerRatio(220 * t, 0, 40, 220, 0, 0, 0.7)
      expect(r).toBeLessThanOrEqual(prev + 1e-12)
      prev = r
    }
  })
})

describe("cone", () => {
  test("whine ahead, roar behind, quieter on approach", () => {
    // Nose along +z; listener dead ahead, then dead astern, then 140° off the nose.
    const ahead = jetCone(0, 0, 1, 0, 0, 1)
    const astern = jetCone(0, 0, 1, 0, 0, -1)
    const a140 = (140 * Math.PI) / 180
    const lobe = jetCone(0, 0, 1, Math.sin(a140), 0, Math.cos(a140))
    const side = jetCone(0, 0, 1, 1, 0, 0)
    expect(ahead.front).toBeGreaterThan(0.95)
    expect(astern.front).toBeLessThan(0.3)
    expect(lobe.rear).toBeGreaterThan(0.95)
    expect(lobe.rear).toBeGreaterThanOrEqual(astern.rear)
    expect(astern.rear).toBeGreaterThan(side.rear)
    expect(ahead.rear).toBeLessThan(0.45)
    expect(ahead.level).toBeLessThan(astern.level)
    for (const c of [ahead, astern, lobe, side]) for (const v of [c.front, c.rear, c.level]) expect(v).toBeGreaterThan(0.2)
  })
})

describe("spool", () => {
  test("idle to military, up slower than down", () => {
    expect(rpmFor(0)).toBeCloseTo(0.64, 6)
    expect(rpmFor(1)).toBeCloseTo(1, 6)
    let up = rpmFor(0)
    let down = rpmFor(1)
    for (let i = 0; i < 60; i++) {
      up = spoolStep(up, 1, 1 / 60)
      down = spoolStep(down, rpmFor(0), 1 / 60)
    }
    // After a second: up covers less of the way than down.
    expect((up - 0.64) / 0.36).toBeLessThan((1 - down) / 0.36)
    expect(up).toBeGreaterThan(0.8)
  })
})

describe("closest approach and flybys", () => {
  test("predicts the time and miss distance of a straight pass", () => {
    // 600 m ahead along x, 30 m up, coming at 200 m/s.
    const a = closestApproach(600, 30, 0, -200, 0, 0, makeApproach())
    expect(a.t).toBeCloseTo(3, 6)
    expect(a.miss).toBeCloseTo(30, 6)
    expect(a.speed).toBeCloseTo(200, 6)
    const past = closestApproach(-600, 30, 0, -200, 0, 0)
    expect(past.t).toBeLessThan(0)
  })

  test("announces one pass, lead seconds early, then cools down", () => {
    const watch = new FlybyWatch()
    const plan = makeFlybyPlan()
    const a = makeApproach()
    const speed = 210
    let fired: { at: number; t: number } | null = null
    let count = 0
    // A jet flying past 35 m off at 210 m/s, sampled at 60 Hz from 8 s out to 4 s past.
    for (let f = 0; f <= 12 * 60; f++) {
      const now = f / 60
      const x = 1680 - speed * now
      closestApproach(x, 35, 0, -speed, 0, 0, a)
      const p = watch.check(now, a, false, plan)
      if (p) {
        count++
        fired ??= { at: now, t: p.t }
        expect(p.kind).toBe("snap")
        expect(p.gain).toBeGreaterThan(0.4)
      }
    }
    expect(count).toBe(1)
    // The pass is at 8 s; it was announced at most `lead` ahead, and the plan's t lands on it.
    expect(fired!.t).toBeLessThanOrEqual(FLYBY.lead)
    expect(fired!.at + fired!.t).toBeCloseTo(8, 6)
  })

  test("ignores far, slow and receding jets", () => {
    const watch = new FlybyWatch()
    const plan = makeFlybyPlan()
    expect(watch.check(0, closestApproach(300, 400, 0, -200, 0, 0), false, plan)).toBeNull()
    expect(watch.check(0, closestApproach(100, 10, 0, -40, 0, 0), false, plan)).toBeNull()
    expect(watch.check(0, closestApproach(-300, 10, 0, -200, 0, 0), false, plan)).toBeNull()
  })

  test("picks the take for the pass and cracks only on fast close merges", () => {
    expect(flybyKind(130, 200, false)).toBe("high")
    expect(flybyKind(60, 200, true)).toBe("burner")
    expect(flybyKind(25, 230, false)).toBe("snap")
    expect(flybyKind(60, 150, false)).toBe("low")
    const watch = new FlybyWatch()
    const plan = watch.check(0, closestApproach(700, 20, 0, -420, 0, 0), false, makeFlybyPlan())
    expect(plan?.boom).toBe(true)
  })

  test("lines a take's loudest moment up with the pass", () => {
    const early = alignPeak(2.4, 2)
    expect(early.delay).toBeCloseTo(0.4, 9)
    expect(early.offset).toBe(0)
    expect(alignPeak(1, 2)).toEqual({ delay: 0, offset: 1 })
  })
})

describe("listener velocity", () => {
  test("follows steady motion and resets on teleports", () => {
    const v = new VelocityTracker(0.1)
    for (let i = 0; i <= 120; i++) v.update(200 * (i / 60), 0, 0, 1 / 60)
    expect(v.x).toBeCloseTo(200, 0)
    v.update(50000, 0, 0, 1 / 60)
    expect(v.x).toBe(0)
  })
})
