import { expect, test } from "bun:test"
import { FlashLimiter, boltShape, makeStrike, pickStrikeLights, strikeLight, strokeSchedule, type Strike } from "../src/weather/bolt"
import { SHELTER, sheltered } from "../src/weather/shelter"
import { lotWeatherDefaults } from "../src/weather/settings"

test("a strike is the same channel and strokes for the same seed", () => {
  const a = boltShape(7, [0, 210, 0], [40, 0, -300]), b = boltShape(7, [0, 210, 0], [40, 0, -300])
  expect(a.count).toBe(b.count)
  expect([...a.segments]).toEqual([...b.segments])
  expect(a.count).toBeGreaterThan(100)
  expect(a.count).toBeLessThanOrEqual(2048)
  expect(boltShape(8, [0, 210, 0], [40, 0, -300]).segments).not.toEqual(a.segments)
})

test("ground strikes restrike 2–4 times inside half a second", () => {
  for (let seed = 1; seed < 200; seed++) {
    const s = strokeSchedule(seed, "ground")
    expect(s.length).toBeGreaterThanOrEqual(3)
    expect(s.length).toBeLessThanOrEqual(5)
    expect(s.at(-1)!.at).toBeLessThanOrEqual(0.5)
    expect(s.slice(1).every(k => !k.branches)).toBe(true)
  }
})

test("scene flashes never exceed three in any second (WCAG 2.3.1), even with strikes overlapping", () => {
  const limiter = new FlashLimiter(), strikes: Strike[] = []
  for (let i = 0; i < 40; i++) strikes.push(makeStrike({ seed: i + 1, kind: "ground", bearing: 0, distance: 300, power: 1 }, i * 0.15, 0, 0, 0, 210, limiter, 3))
  const pulses = strikes.flatMap(s => s.scenePulses.map(p => s.t + s.strokes[p]!.at)).sort((a, b) => a - b)
  for (let i = 3; i < pulses.length; i++) expect(pulses[i]! - pulses[i - 3]!).toBeGreaterThan(1 - 1e-6)
})

test("Reduced is one soft swell: the scene light never dips and rises again", () => {
  const s = makeStrike({ seed: 3, kind: "ground", bearing: 0, distance: 300, power: 1 }, 1, 0, 0, 0, 210, new FlashLimiter(), 1)
  let peaked = false, last = 0
  for (let t = 1; t < 3; t += 1 / 240) {
    const v = strikeLight(s, t, true).scene
    if (v < last - 1e-9) peaked = true
    else if (peaked) expect(v).toBeLessThanOrEqual(last + 1e-9)
    last = v
  }
  expect(peaked).toBe(true)
})

test("Today is the default and the deep link picks a mode", () => {
  expect(lotWeatherDefaults().weather).toBe("today")
  expect(lotWeatherDefaults(new URLSearchParams("weather=storm")).weather).toBe("storm")
  expect(lotWeatherDefaults(new URLSearchParams("weather=snow")).weather).toBe("today")
})

test("the booth roof and canopy shelter what is under them", () => {
  expect(sheltered(9, 127.5, SHELTER.booth)).toBe(true)
  expect(sheltered(0, 24, SHELTER.canopy)).toBe(true)
  expect(sheltered(0, 30, SHELTER.canopy)).toBe(false)
})

/** Flash onsets in a sampled scene-light signal: a rise of more than 10 % of its peak from the lowest point since the last onset. */
function onsets(signal: number[], dt: number) {
  const peak = Math.max(...signal), out: number[] = []
  let low = Infinity, high = -Infinity, armed = true
  signal.forEach((v, i) => {
    if (armed) { low = Math.min(low, v); if (v > low + 0.1 * peak) { out.push(i * dt); armed = false; high = v } }
    else { high = Math.max(high, v); if (v < high - 0.1 * peak) { armed = true; low = v } }
  })
  return out
}

/** The storm's own path: strikes made on a shared limiter, then the frame's scene light from pickStrikeLights. */
function sceneLight(times: number[], smooth: boolean, kinds: ("ground" | "cloud")[] = ["ground"]) {
  const limiter = new FlashLimiter(), strikes = times.map((t, i) => makeStrike({ seed: 101 + i * 7, kind: kinds[i % kinds.length]!, bearing: 0, distance: 200 + 37 * (i % 9), power: 1 }, t + 0.1, 0, 0, 0, 210, limiter, 1, smooth ? 3 : 0))
  const dt = 1 / 1000, signal: number[] = []
  for (let t = 0; t < times.at(-1)! + 4; t += dt) signal.push(pickStrikeLights(strikes.filter(k => k.t - k.leader <= t), t, smooth).sceneLight)
  return { signal, dt, strikes }
}

const spam = Array.from({ length: 60 }, (_, i) => i * 0.05)
const overlapping = [0, 0.12, 0.2, 0.33, 0.41, 0.6, 0.7, 0.75, 1.1, 1.15, 2.4, 2.45]

for (const [name, times] of [["Strike-now spam (20 a second)", spam], ["overlapping strikes", overlapping]] as const) {
  test(`Full: ${name} light the scene at most three times in any second`, () => {
    const { signal, dt, strikes } = sceneLight([...times], false, ["ground", "cloud", "ground"])
    const flashes = onsets(signal, dt)
    expect(flashes.length).toBeGreaterThan(2)
    expect(strikes.some(k => k.scenePulses.length === 0)).toBe(true)
    for (let i = 3; i < flashes.length; i++) expect(flashes[i]! - flashes[i - 3]!).toBeGreaterThan(1)
  })
  test(`Reduced: ${name} make single swells that never dip and rise again inside 3 s`, () => {
    const { signal, dt } = sceneLight([...times], true)
    const flashes = onsets(signal, dt)
    expect(flashes.length).toBeGreaterThan(0)
    for (let i = 1; i < flashes.length; i++) expect(flashes[i]! - flashes[i - 1]!).toBeGreaterThanOrEqual(3 - 1e-6)
  })
}
