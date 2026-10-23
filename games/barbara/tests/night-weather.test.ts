import { expect, test } from "bun:test"
import { FOREST_STORM_DEFAULTS } from "@arcade/kit/forest/storm"
import { FOREST_LOOK_DEFAULTS } from "@arcade/kit/forest/settings"
import { CHANGE, nightProgress, nightSpells, weatherAt } from "../shared/night-weather"
import { blendLooks, LOOKS, lookBase, WEATHER_KEEPS, WEATHER_LOOK } from "../src/looks"

test("the same seed gives the same night; different seeds differ", () => {
  expect(nightSpells(42)).toEqual(nightSpells(42))
  const nights = new Set(Array.from({ length: 40 }, (_, i) => JSON.stringify(nightSpells(i * 977))))
  expect(nights.size).toBeGreaterThan(20)
})

test("a night starts clear, has 3–5 spells each longer than a change, and only plausible changes", () => {
  const ok: Record<string, string[]> = { clear: ["fog", "brewing", "starry"], starry: ["fog", "clear", "brewing"], fog: ["clear", "brewing", "starry"], brewing: ["rain", "clear"], rain: ["fog", "clear"] }
  for (let s = 0; s < 300; s++) {
    const spells = nightSpells(s)
    expect(spells[0]).toEqual({ weather: "clear", at: 0 })
    expect(spells.length).toBeGreaterThanOrEqual(3)
    expect(spells.length).toBeLessThanOrEqual(5)
    for (let i = 1; i < spells.length; i++) {
      expect(ok[spells[i - 1]!.weather]).toContain(spells[i]!.weather)
      expect(spells[i]!.at - spells[i - 1]!.at).toBeGreaterThan(CHANGE)
    }
  }
})

test("weather changes smoothly over the last CHANGE of a spell and holds otherwise", () => {
  const spells = [{ weather: "clear", at: 0 }, { weather: "fog", at: 0.5 }] as const
  expect(weatherAt(spells, 0.2)).toEqual({ from: "clear", to: "fog", mix: 0 })
  expect(weatherAt(spells, 0.5 - CHANGE / 2).mix).toBeCloseTo(0.5, 6)
  expect(weatherAt(spells, 0.6)).toEqual({ from: "fog", to: "fog", mix: 0 })
  let last = 0
  for (let p = 0.5 - CHANGE; p < 0.5; p += 0.001) { const m = weatherAt(spells, p).mix; expect(m).toBeGreaterThanOrEqual(last - 1e-12); last = m }
})

test("progress runs from the search's start to dawn on the shared clock", () => {
  expect(nightProgress(5, 10, 100)).toBe(0)
  expect(nightProgress(55, 10, 100)).toBeCloseTo(0.5, 9)
  expect(nightProgress(500, 10, 100)).toBe(1)
  expect(nightProgress(5, 0, 0)).toBe(0)
})

test("a blend halfway sits between the two Looks, and the camp's power stays Today's", () => {
  const targets = { forest: { ...FOREST_LOOK_DEFAULTS } as Record<string, unknown>, storm: { ...FOREST_STORM_DEFAULTS } as Record<string, unknown>, feel: { ridgeGlow: 1 } as Record<string, unknown> }
  const base = lookBase(targets)
  blendLooks(WEATHER_LOOK.clear, WEATHER_LOOK.rain, 0.5, targets, base, WEATHER_KEEPS)
  expect(targets.storm.rain).toBeCloseTo((LOOKS.downpour.storm.rain! + FOREST_STORM_DEFAULTS.rain) / 2, 9)
  blendLooks(WEATHER_LOOK.starry, WEATHER_LOOK.starry, 0, targets, base, WEATHER_KEEPS)
  expect(targets.forest.windows).toBe(FOREST_LOOK_DEFAULTS.windows)
  expect(targets.feel.ridgeGlow).toBe(1)
  expect(targets.forest.skyStars).toBe(LOOKS.newmoon.forest.skyStars)
})
