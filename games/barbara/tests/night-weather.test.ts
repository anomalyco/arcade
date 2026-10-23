import { expect, test } from "bun:test"
import { FOREST_STORM_DEFAULTS } from "@arcade/kit/forest/storm"
import { FOREST_LOOK_DEFAULTS, type ForestLookSettings } from "@arcade/kit/forest/settings"
import { StormStrikes } from "@arcade/kit/weather/storm"
import { CHANGE, nightProgress, nightSpells, weatherAt } from "../shared/night-weather"
import { blendLooks, LOOKS, lookBase, tonightAt, tonightStrikes, WEATHER_KEEPS, WEATHER_LOOK } from "../src/looks"
import { DawnSky } from "../src/night-view"

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

const gameBase = () => {
  // The game's Today: the catalogue (physical) sky, as `WorldView.create` sets it.
  const targets = { forest: { ...FOREST_LOOK_DEFAULTS, skyMode: "physical" } as Record<string, unknown>, storm: { ...FOREST_STORM_DEFAULTS } as Record<string, unknown>, feel: { ridgeGlow: 1 } as Record<string, unknown> }
  return { targets, base: lookBase(targets) }
}

test("no setting snaps mid-change: any two weathers' Looks agree on everything that isn't a number", () => {
  const { targets, base } = gameBase()
  const ids = [...new Set(Object.values(WEATHER_LOOK))]
  for (const a of ids) for (const b of ids) {
    blendLooks(a, b, 0.49, targets, base, WEATHER_KEEPS)
    const before = JSON.stringify(Object.fromEntries(Object.entries({ ...targets.forest, ...targets.storm, ...targets.feel }).filter(([, v]) => typeof v !== "number")))
    blendLooks(a, b, 0.51, targets, base, WEATHER_KEEPS)
    const after = JSON.stringify(Object.fromEntries(Object.entries({ ...targets.forest, ...targets.storm, ...targets.feel }).filter(([, v]) => typeof v !== "number")))
    expect(`${a}→${b} ${after}`).toBe(`${a}→${b} ${before}`)
  }
})

test("on Tonight the dawn still greys the sky: Tonight writes first each frame and the dawn scales what it wrote", () => {
  const { targets, base } = gameBase()
  const s = targets.forest as unknown as ForestLookSettings
  const dawn = new DawnSky()
  const spells = [{ weather: "clear", at: 0 }, { weather: "starry", at: 0.3 }] as const
  const night = { start: 0, dawn: 100, end: 0 }
  for (let t = 90; t <= 100; t += 0.5) {
    const w = tonightAt(spells, night, t)
    blendLooks(w.a, w.b, w.mix, targets, base, WEATHER_KEEPS)
    const sky = s.sky, skylight = s.skylight
    dawn.apply(s, 1)
    // Full dawn: ×40 sky glow and ×30 skylight over this frame's Tonight values, never compounding.
    expect(s.sky).toBeCloseTo(sky * 40, 9)
    expect(s.skylight).toBeCloseTo(skylight * 30, 9)
  }
  expect(s.sky).toBeCloseTo((LOOKS.newmoon.forest.sky as number) * 40, 9)
})

test("Tonight holds at the night's end (the end card) instead of running on", () => {
  const spells = [{ weather: "clear", at: 0 }, { weather: "brewing", at: 0.5 }] as const
  const ended = { start: 0, dawn: 1000, end: 300 }
  expect(tonightAt(spells, ended, 900)).toEqual(tonightAt(spells, ended, 300))
  expect(tonightAt(spells, { ...ended, end: 0 }, 900).from).toBe("brewing")
})

test("two clients at different frame rates see the same strikes through a change into a storm", () => {
  const { base } = gameBase()
  // Clear until 39% of a 200 s night, brewing from 50%: the change runs 78–100 s.
  const spells = [{ weather: "clear", at: 0 }, { weather: "brewing", at: 0.5 }, { weather: "rain", at: 0.8 }] as const
  const night = { start: 0, dawn: 200, end: 0 }
  const run = (fps: number, start: number) => {
    const strikes = new StormStrikes(1234), out: [number, number, number][] = []
    let t = start
    const dt = 1 / fps
    while (t < 200) {
      t += dt
      // Each frame's own blended settings differ between the clients; only the slot's may decide a strike.
      const w = tonightAt(spells, night, t)
      const v = (k: string) => { const a = (LOOKS[w.a].storm as Record<string, number>)[k] ?? (base.storm[k] as number), b = (LOOKS[w.b].storm as Record<string, number>)[k] ?? (base.storm[k] as number); return a + (b - a) * w.mix }
      const frame = { rate: v("strikes"), cloud: v("strikeCloud"), near: v("strikeNear"), far: v("strikeFar"), flashes: "full" as const }
      const f = strikes.step(dt, frame, [0, 1.7, 0], 0, 0, { time: t, anchor: [5, 5], settingsAt: (k) => tonightStrikes(spells, night, k, base.storm) })
      for (const e of f.thunder) out.push([Math.round(t - (f.time - e.emitted)), Math.round(e.position[0]!), Math.round(e.position[2]!)])
    }
    return out
  }
  // 0.7 fps also jumps several slots in one frame, each still read at its own second.
  const a = run(60, 0), b = run(0.7, 0.013)
  expect(a.filter(([k]) => k >= 78 && k <= 100).length).toBeGreaterThan(0)
  expect(b).toEqual(a)
  expect(a.every(([k]) => k >= 78)).toBe(true)
})

test("a clear spell turning starry fades the moon's light and keeps its phase", () => {
  const { targets, base } = gameBase()
  targets.forest.skyMoon = base.forest.skyMoon = "full"
  const lux = base.forest.skyMoonLux as number
  blendLooks(WEATHER_LOOK.clear, WEATHER_LOOK.starry, 0.5, targets, base, WEATHER_KEEPS)
  expect(targets.forest.skyMoon).toBe("full")
  expect(targets.forest.skyMoonLux).toBeCloseTo(lux / 2)
  blendLooks(WEATHER_LOOK.clear, WEATHER_LOOK.starry, 1, targets, base, WEATHER_KEEPS)
  expect(targets.forest.skyMoonLux).toBe(0)
  expect(targets.forest.darkAdapt).toBe(0)
})
