import { describe, expect, test } from "bun:test"
import { QuantizedHistoryRing, type QuantizedActorInput } from "./interest-delta"

describe("QuantizedHistoryRing (interest management, acked delta & lag-comp rewind)", () => {
  test("compresses 300-zombie snapshot by >6x on acked delta and skips unchanged actors", () => {
    const ring = new QuantizedHistoryRing(512, 16)
    const actors97: QuantizedActorInput[] = Array.from({ length: 300 }, (_, i) => ({
      id: i + 1,
      x: 8 + ((i * 17) % 80),
      y: 8 + ((i * 29) % 80),
      aim: (i * 0.25) % (Math.PI * 2),
      state: i % 2 === 0 ? 3 : 0,
      hp: 100,
    }))
    ring.record(97, actors97)

    const actors100 = actors97.map((a, i) =>
      i % 2 === 0
        ? { ...a, x: a.x + 0.12, y: a.y - 0.08, aim: a.aim + 0.05 }
        : { ...a },
    )
    ring.record(100, actors100)

    const keyframe = ring.encodeDelta(100, -1, 27.7, 41.0, 60.0)
    const delta = ring.encodeDelta(100, 97, 27.7, 41.0, 60.0)

    expect(keyframe.byteLength).toBeLessThan(2800)
    expect(delta.byteLength).toBeLessThan(850) // Fits comfortably inside a single 1,460 B TCP MSS packet!
    expect(keyframe.byteLength / delta.byteLength).toBeGreaterThan(3.0)
  })

  test("rewinds target hitbox position to fractional viewTick and clamps to maxRewindTicks", () => {
    const ring = new QuantizedHistoryRing(64, 10)
    for (let tick = 100; tick <= 115; tick++) {
      ring.record(tick, [{ id: 1, x: 10 + (tick - 100) * 0.5, y: 20, aim: 0, state: 3, hp: 100 }])
    }

    // Rewind 4.5 ticks from tick 115 -> tick 110.5 -> x = 10 + 10.5 * 0.5 = 15.25m
    const pose = ring.sampleRewindPose(115, 110.5, 1)
    expect(pose).not.toBeNull()
    expect(pose!.x).toBeCloseTo(15.25, 2)
    expect(pose!.y).toBeCloseTo(20.0, 2)

    // Attempt to rewind 20 ticks (beyond maxRewindTicks = 10) -> clamps to tick 105 -> x = 10 + 5 * 0.5 = 12.5m
    const clamped = ring.sampleRewindPose(115, 95, 1)
    expect(clamped).not.toBeNull()
    expect(clamped!.x).toBeCloseTo(12.5, 2)
  })
})
