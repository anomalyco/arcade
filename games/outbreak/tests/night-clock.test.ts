import { describe, expect, test } from "bun:test"
import { dayCycle } from "../shared/day-cycle"
import { countdownText, DAWN_HOUR, DUSK_HOUR, NIGHT_HOURS, nightClockReading } from "../src/night-clock/reading"
import { secondsToLight } from "../src/way-out/hud"

// Playtest (Oct 21, 1:38:07): "I have no concept of how much time is left." Kit: "There should definitely be like a clock."
describe("night clock", () => {
  test("dark runs from about 17:00 to about 07:00, where darkness crosses one half", () => {
    expect(DUSK_HOUR).toBeGreaterThan(16.5)
    expect(DUSK_HOUR).toBeLessThan(17.5)
    expect(DAWN_HOUR).toBeGreaterThan(6.5)
    expect(DAWN_HOUR).toBeLessThan(7.5)
    expect(dayCycle(DUSK_HOUR + 0.01).darkness).toBeGreaterThanOrEqual(0.5)
    expect(dayCycle(DAWN_HOUR + 0.01).darkness).toBeLessThan(0.5)
    expect(NIGHT_HOURS).toBeCloseTo(24 - DUSK_HOUR + DAWN_HOUR)
  })

  test("at night it counts real seconds to dawn, agreeing with the way out's countdown", () => {
    for (const hour of [18, 22, 0.5, 3, 6.5]) {
      const r = nightClockReading(hour, 120, 90)
      expect(r?.mode).toBe("night")
      if (r?.mode !== "night") continue
      expect(Math.abs(r.seconds - secondsToLight(hour, 120))).toBeLessThanOrEqual(30)
    }
    const early = nightClockReading(DUSK_HOUR + 0.05, 120, 90)
    const late = nightClockReading(DAWN_HOUR - 0.05, 120, 90)
    expect(early?.mode === "night" && early.left).toBeGreaterThan(0.95)
    expect(late?.mode === "night" && late.left).toBeLessThan(0.05)
  })

  test("in daylight nothing, except a warning in the last seconds before dark", () => {
    expect(nightClockReading(12, 120, 90)).toBeNull()
    // 120x: 90 real seconds is three game hours.
    const warn = nightClockReading(DUSK_HOUR - 2.5, 120, 90)
    expect(warn?.mode).toBe("dusk")
    expect(warn?.seconds).toBeCloseTo(75, 0)
    expect(nightClockReading(DUSK_HOUR - 2.5, 120, 0)).toBeNull()
  })

  test("a stopped clock still says it is night, with no countdown", () => {
    const r = nightClockReading(23, 0, 90)
    expect(r?.mode).toBe("night")
    expect(countdownText(r!.seconds)).toBe("–:––")
    expect(countdownText(245.2)).toBe("4:06")
    expect(countdownText(0)).toBe("0:00")
  })
})
