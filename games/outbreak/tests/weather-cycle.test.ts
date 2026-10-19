import { describe, expect, test } from "bun:test"
import { CoopSim } from "../shared/coop-sim"
import { dayCycle } from "../shared/day-cycle"
import { LIGHTNING_LIFE, lightningAt, strikeFlash, strikesBetween, thunderDelay } from "../shared/weather/lightning"
import { DEFAULT_WEATHER_TUNING, sampleWeather, wetnessAt, type WeatherTuning } from "../shared/weather/schedule"
import { puddleMaskAt } from "../src/weather/puddles"

const T = DEFAULT_WEATHER_TUNING
/** Hour at sim time t at the default clock (17:30 start, 120× time). */
const hourAt = (t: number) => (17.5 + (t * 120) / 3600) % 24

describe("weather cycle (AR-71)", () => {
  test("is a pure function of seed, time and hour", () => {
    expect(sampleWeather(9, 1234, 22)).toEqual(sampleWeather(9, 1234, 22))
    expect(sampleWeather(9, 1234, 22, T, sampleWeather(1, 1, 1))).toEqual(sampleWeather(9, 1234, 22))
  })

  test("Today is always clear and dry, and the opening is dry", () => {
    const today: WeatherTuning = { ...T, weatherCycle: 0 }
    for (const t of [0, 400, 1800, 3000]) expect(sampleWeather(3, t, hourAt(t), today).state).toBe("clear")
    for (let seed = 1; seed <= 30; seed++) expect(sampleWeather(seed, 150, hourAt(150)).rain).toBe(0)
  })

  test("over a run: mostly clear, some rain, a few storms, and storms only in the dark", () => {
    const runs = 30
    const time: Record<string, number> = { clear: 0, drizzle: 0, rain: 0, storm: 0 }
    let storms = 0
    for (let seed = 1; seed <= runs; seed++) {
      let prev = "clear"
      for (let t = 0; t < 3600; t += 2) {
        const h = hourAt(t)
        const s = sampleWeather(seed, t, h)
        time[s.state]! += 2
        if (s.state === "storm") {
          expect(dayCycle(h).darkness).toBeGreaterThan(0.5)
          if (prev !== "storm") storms++
        }
        prev = s.state
      }
    }
    const total = runs * 3600
    expect(time.clear! / total).toBeGreaterThan(0.45)
    expect((time.rain! + time.storm!) / total).toBeGreaterThan(0.1)
    expect(time.storm! / total).toBeLessThan(0.15)
    // "A few per run": one to three an hour on average.
    expect(storms / runs).toBeGreaterThan(1)
    expect(storms / runs).toBeLessThan(3)
  })

  test("changes gradually: rain never jumps more than a little per second", () => {
    for (let seed = 1; seed <= 10; seed++) {
      let prev = sampleWeather(seed, 0, hourAt(0)).rain
      for (let t = 1; t < 3600; t++) {
        const r = sampleWeather(seed, t, hourAt(t)).rain
        expect(Math.abs(r - prev)).toBeLessThan(0.03)
        prev = r
      }
    }
  })

  test("wetness soaks in under rain and dries after", () => {
    const held = (override: number): WeatherTuning => ({ ...T, weatherOverride: override })
    expect(wetnessAt(1, 500, held(0))).toBe(0)
    expect(wetnessAt(1, 500, held(2))).toBeGreaterThan(0.9)
    expect(wetnessAt(1, 500, held(1))).toBeGreaterThan(0.6)
    // Find a rainy spell on some seed and check the ground lags the rain both ways.
    for (let seed = 1; seed <= 40; seed++) {
      let start = -1
      for (let t = 200; t < 3000; t += 5) {
        if (sampleWeather(seed, t, 12).rain > 0.6) {
          start = t
          break
        }
      }
      if (start < 0) continue
      const before = wetnessAt(seed, start - 120, T)
      const during = wetnessAt(seed, start + 60, T)
      expect(during).toBeGreaterThan(before)
      return
    }
    throw new Error("no rainy spell found")
  })

  test("rain masks noise and shortens the dead's sight; dry weather changes nothing", () => {
    const storm = sampleWeather(1, 600, 23, { ...T, weatherOverride: 3 })
    expect(storm.state).toBe("storm")
    expect(storm.hearing).toBeCloseTo(1 - T.rainHearingMask, 5)
    expect(storm.sight).toBeCloseTo(1 - T.rainSightLoss, 5)
    const clear = sampleWeather(1, 600, 23, { ...T, weatherOverride: 0 })
    expect(clear.hearing).toBe(1)
    expect(clear.sight).toBe(1)
  })

  test("the sim hands the crowd the weather's senses each tick", () => {
    const sim = new CoopSim(7, 7, 0.22)
    sim.addSurvivor("player", 0)
    sim.stepWorld(1 / 20, 120, { weather: { weatherOverride: 3 } } as never)
    expect(sim.ai.weatherSense.hearing).toBeCloseTo(1 - T.rainHearingMask, 5)
    sim.stepWorld(1 / 20, 120, { weather: { weatherCycle: 0 } } as never)
    expect(sim.ai.weatherSense.hearing).toBe(1)
    expect(sim.ai.weatherSense.sight).toBe(1)
  })

  test("lightning: storms strike now and then, each flash is short, thunder comes late with distance", () => {
    const storm: WeatherTuning = { ...T, weatherOverride: 3 }
    let count = 0
    for (let t = 0; t < 600; t += 1.5) count += strikesBetween(4, t, t + 1.5, 23, storm).length
    // About weatherLightningPerMinute a minute at full storm.
    expect(count).toBeGreaterThan(T.weatherLightningPerMinute * 10 * 0.5)
    expect(count).toBeLessThan(T.weatherLightningPerMinute * 10 * 1.6)
    const s = strikesBetween(4, 0, 600, 23, storm)
    expect(s.length).toBeLessThanOrEqual(5) // a long jump only replays the last two seconds
    let any = false
    for (let t = 0; t < 600 && !any; t += 0.5) {
      for (const k of strikesBetween(4, t, t + 0.5, 23, storm)) {
        any = true
        expect(strikeFlash(k, 0.03)).toBeGreaterThan(0.2)
        expect(strikeFlash(k, LIGHTNING_LIFE + 0.01)).toBe(0)
        expect(lightningAt(4, k.t + 0.02, 23, storm)).toBeGreaterThan(0)
      }
    }
    expect(any).toBe(true)
    expect(strikesBetween(4, 0, 600, 23, { ...T, weatherOverride: 2 }).length).toBe(0)
    expect(thunderDelay(343)).toBeCloseTo(1, 6)
    expect(thunderDelay(1715, 0.5)).toBeCloseTo(2.5, 6)
  })

  test("puddles: none when dry, they spread as standing water rises, gutters fill first", () => {
    let low = 0
    let high = 0
    let gutter = 0
    let crown = 0
    for (let i = 0; i < 400; i++) {
      const x = (i * 7.31) % 96
      const z = (i * 3.17) % 96
      expect(puddleMaskAt(x, z, 0, true)).toBe(0)
      low += puddleMaskAt(x, z, 0.3, false)
      high += puddleMaskAt(x, z, 1, false)
      gutter += puddleMaskAt(x, 40.3, 0.6, true)
      crown += puddleMaskAt(x, 44, 0.6, true)
    }
    expect(high).toBeGreaterThan(low)
    expect(gutter).toBeGreaterThan(crown)
  })
})
