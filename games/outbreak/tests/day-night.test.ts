import { describe, expect, test } from "bun:test"
import { LOOK_PRESETS, blendLookSettings, blendLookSettings3, packLookUniforms } from "@arcade/kit/look"
import { OutbreakAISubsystem } from "../shared/ai"
import { dayCycle } from "../shared/day-cycle"
import { makeTown } from "../shared/map"
import { DEFAULT_OUTBREAK_LIGHTING, OUTBREAK_LOOK_LIGHTING_PRESETS, resolveLampLight } from "../src/lighting"
import {
  OUTBREAK_DAY_LOOK,
  OUTBREAK_DUSK_LOOK,
  OUTBREAK_NIGHT_LOOK,
  applyOutbreakDayNight,
  DAY_NIGHT_CURVE_KEYS,
  DAY_NIGHT_CURVES,
  DEFAULT_DAY_NIGHT_CURVES,
  dayNightCurveOverrides,
  evaluateOutbreakDayNight,
} from "../src/day-night"
import { curveText, sampleCurve } from "@arcade/kit/ramps"

describe("Outbreak Day -> Dusk -> Noir Night look & threat cycle", () => {
  test("blendLookSettings and blendLookSettings3 hit exact anchors and pack interpolated palettes", () => {
    const mid = blendLookSettings(LOOK_PRESETS.cozy_golden_hour.defaults, LOOK_PRESETS.noir.defaults, 0.5)
    expect(mid.saturation).toBeCloseTo(
      (LOOK_PRESETS.cozy_golden_hour.defaults.saturation + LOOK_PRESETS.noir.defaults.saturation) * 0.5,
      5,
    )
    expect(mid.selectiveColor).toBeCloseTo(
      (LOOK_PRESETS.cozy_golden_hour.defaults.selectiveColor + LOOK_PRESETS.noir.defaults.selectiveColor) * 0.5,
      5,
    )
    const u = packLookUniforms(mid)
    expect(u[48]).toBeCloseTo(
      (LOOK_PRESETS.cozy_golden_hour.palette.wall[0] + LOOK_PRESETS.noir.palette.wall[0]) * 0.5,
      5,
    )

    const d0 = blendLookSettings3(OUTBREAK_DAY_LOOK, OUTBREAK_DUSK_LOOK, OUTBREAK_NIGHT_LOOK, 0)
    const dHalf = blendLookSettings3(OUTBREAK_DAY_LOOK, OUTBREAK_DUSK_LOOK, OUTBREAK_NIGHT_LOOK, 0.5)
    const d1 = blendLookSettings3(OUTBREAK_DAY_LOOK, OUTBREAK_DUSK_LOOK, OUTBREAK_NIGHT_LOOK, 1)

    expect(d0.saturation).toBeCloseTo(OUTBREAK_DAY_LOOK.saturation, 6)
    expect(d0.selectiveColor).toBeCloseTo(0, 6)
    expect(dHalf.saturation).toBeCloseTo(OUTBREAK_DUSK_LOOK.saturation, 6)
    expect(dHalf.selectiveColor).toBeCloseTo(OUTBREAK_DUSK_LOOK.selectiveColor, 6)
    expect(d1.saturation).toBeCloseTo(OUTBREAK_NIGHT_LOOK.saturation, 6)
    expect(d1.selectiveColor).toBeCloseTo(OUTBREAK_NIGHT_LOOK.selectiveColor, 6)
  })

  test("evaluateOutbreakDayNight transitions smoothly from calm day (13:00) through dusk (17:00) to Noir night (22:00) with zero pops", () => {
    const day = evaluateOutbreakDayNight(13)
    const dusk = evaluateOutbreakDayNight(17)
    const night = evaluateOutbreakDayNight(22)

    expect(day.phase).toBe("day")
    expect(day.darkness).toBe(0)
    expect(day.threat).toBe(0)
    expect(day.look.saturation).toBeCloseTo(0.96, 3)
    expect(day.look.selectiveColor).toBeCloseTo(0.0, 3)
    expect(day.fog.fogMemoryDim).toBeCloseTo(0.72, 3)

    expect(dusk.phase).toBe("dusk")
    expect(dusk.darkness).toBeGreaterThan(0.4)
    expect(dusk.darkness).toBeLessThan(0.6)
    expect(dusk.twilight).toBeGreaterThan(0.95)
    expect(dusk.look.saturation).toBeGreaterThan(0.35)
    expect(dusk.look.saturation).toBeLessThan(0.65)
    expect(dusk.look.selectiveColor).toBeGreaterThan(0.55)
    expect(dusk.look.selectiveColor).toBeLessThan(0.8)
    expect(dusk.lighting.practicalWarmth).toBeGreaterThan(0.5)

    expect(night.phase).toBe("night")
    expect(night.darkness).toBe(1)
    expect(night.threat).toBe(1)
    expect(night.look.saturation).toBeCloseTo(LOOK_PRESETS.noir.defaults.saturation, 3)
    expect(night.look.selectiveColor).toBeCloseTo(LOOK_PRESETS.noir.defaults.selectiveColor, 3)
    expect(night.lighting.practicalWarmth).toBeCloseTo(OUTBREAK_LOOK_LIGHTING_PRESETS.noir.practicalWarmth!, 3)
    expect(night.fog.fogMemoryDim).toBeCloseTo(0.5, 3)
    expect(night.look.grain).toBe(0)
    expect("fogSoundCues" in night.fog).toBe(false)

    // Verify C1 continuity (no pops) across all 240 steps of a 24-hour cycle including 23.9 -> 0.0 wrap
    let prev = evaluateOutbreakDayNight(23.9)
    for (let i = 0; i <= 240; i++) {
      const h = (i * 0.1) % 24
      const cur = evaluateOutbreakDayNight(h)
      expect(Math.abs(cur.look.saturation - prev.look.saturation)).toBeLessThan(0.09)
      expect(Math.abs(cur.look.selectiveColor - prev.look.selectiveColor)).toBeLessThan(0.11)
      expect(Math.abs(cur.look.exposure - prev.look.exposure)).toBeLessThan(0.03)
      expect(Math.abs(cur.lighting.skyFill - prev.lighting.skyFill)).toBeLessThan(0.07)
      expect(Math.abs(cur.fog.fogMemoryDim - prev.fog.fogMemoryDim)).toBeLessThan(0.04)
      expect(cur.look.tonemap).toBe(1)
      prev = cur
    }

    const lookTarget = { ...OUTBREAK_NIGHT_LOOK }
    const settingsTarget: Record<string, any> = { fogStyle: 2 }
    applyOutbreakDayNight(13, lookTarget, settingsTarget)
    expect(settingsTarget.fogStyle).toBe(2)
    expect(settingsTarget.fogMemoryDim).toBeCloseTo(0.72, 3)
    expect(lookTarget.saturation).toBeCloseTo(0.96, 3)
  })

  test("dayCycle threat drives zombie AI nocturnal perception and aggression", () => {
    const town = makeTown(7, 7, 0.22)
    // openingCalm 0: this compares hours alone, without the first-night opening easing the threat in
    const aiDay = new OutbreakAISubsystem(town, 27.7, 41, { zombieCount: 0, nightMultiplier: 1.5, openingCalm: 0 })
    const aiNight = new OutbreakAISubsystem(town, 27.7, 41, { zombieCount: 0, nightMultiplier: 1.5, openingCalm: 0 })

    const zDay = aiDay.spawnZombie(town, 33.5, 41, "wander", 0)
    const zNight = aiNight.spawnZombie(town, 33.5, 41, "wander", 0)

    const survivor = {
      x: 27.7,
      y: 41,
      vx: 0,
      vy: 0,
      aim: 0,
      noise: 7.5,
      flashlightOn: false,
      battery: 1,
      batteryDepleted: false,
      batteryCooldown: 0,
      flashlightOutput: 0,
      lightSignature: 0,
    }

    aiDay.emitNoise(27.7, 41, 10, "footstep", 0)
    aiNight.emitNoise(27.7, 41, 10, "footstep", 0)
    for (let i = 0; i < 6; i++) {
      aiDay.step(town, survivor, 13, i / 60, 1 / 60)
      aiNight.step(town, survivor, 22, i / 60, 1 / 60)
    }

    expect(dayCycle(13).threat).toBe(0)
    expect(dayCycle(22).threat).toBe(1)
    expect(aiDay.threat).toBe(0)
    expect(aiNight.threat).toBe(1)
    expect(zNight.awareness).toBeGreaterThan(zDay.awareness)
  })
})

describe("Street lamps at night", () => {
  test("lit street lamps light the ground at night: no dimmer than at dusk, at least porch-like, above the sodium pool gate", () => {
    const town = makeTown(7)
    const street = town.lamps.find((l) => l.kind === "street")!
    const porch = town.lamps.find((l) => l.kind === "porch")!
    const at = (hour: number, lamp: typeof street) => {
      const ev = evaluateOutbreakDayNight(hour)
      return resolveLampLight(lamp, town.buildings, ev.lamps, { ...DEFAULT_OUTBREAK_LIGHTING, ...ev.lighting }, false)
    }
    const night = evaluateOutbreakDayNight(22.5)
    // `applySceneLightBounceAndHaze` only draws the sodium ground pool above streetPower × lampsOn 0.2.
    expect(night.lighting.streetPower * night.lamps).toBeGreaterThan(0.2)
    expect(at(22.5, street).power).toBeGreaterThanOrEqual(at(18.5, street).power * 0.95)
    expect(at(22.5, street).power).toBeGreaterThan(at(22.5, porch).power * 0.6)
  })
})

describe("Day-night curves", () => {
  const hours = Array.from({ length: 97 }, (_, i) => i / 4)
  test("untouched curves give exactly the Day/Dusk/Night blend at every hour", () => {
    for (const hour of hours) {
      const plain = evaluateOutbreakDayNight(hour, { ...OUTBREAK_NIGHT_LOOK })
      const curved = evaluateOutbreakDayNight(hour, { ...OUTBREAK_NIGHT_LOOK }, dayNightCurveOverrides({ ...DEFAULT_DAY_NIGHT_CURVES }))
      expect(curved.look).toEqual(plain.look)
      expect(curved.lighting).toEqual(plain.lighting)
    }
    // A default that went through knobs (rounded points, reordered keys) still reads as the default.
    const roundTrip = Object.fromEntries(DAY_NIGHT_CURVE_KEYS.map(k => [k, JSON.stringify(JSON.parse(DEFAULT_DAY_NIGHT_CURVES[k]).map((p: { x: number; y: number }) => ({ y: p.y, x: p.x })))]))
    expect(dayNightCurveOverrides(roundTrip)).toEqual({})
  })
  test("the default curves trace the blend they stand in for", () => {
    for (const key of DAY_NIGHT_CURVE_KEYS) {
      const points = JSON.parse(DEFAULT_DAY_NIGHT_CURVES[key]) as { x: number; y: number }[]
      const { field } = DAY_NIGHT_CURVES[key]
      expect(points[0]!.y).toBeCloseTo(evaluateOutbreakDayNight(12).lighting[field], 4)
      for (const hour of hours) {
        const d = Math.max(0, Math.min(1, dayCycle(hour).darkness))
        const exact = evaluateOutbreakDayNight(hour, { ...OUTBREAK_NIGHT_LOOK })
        const value = exact.lighting[DAY_NIGHT_CURVES[key].field]
        expect(Math.abs(sampleCurve(points, d) - value)).toBeLessThan(0.02)
      }
    }
  })
  test("a reshaped curve drives its value by darkness and leaves the rest of the blend alone", () => {
    const flat = curveText([{ x: 0, y: 0.25 }, { x: 1, y: 0.25 }], { range: DAY_NIGHT_CURVES.streetAirHazeCurve.range })
    const settings = { lighting: {}, fog: {}, vision: {}, dayCycle: { ...DEFAULT_DAY_NIGHT_CURVES, streetAirHazeCurve: flat } }
    for (const hour of [3, 12, 19.5]) {
      const look = { ...OUTBREAK_NIGHT_LOOK }
      const out = applyOutbreakDayNight(hour, look, settings)
      const plain = evaluateOutbreakDayNight(hour, { ...OUTBREAK_NIGHT_LOOK })
      expect(out.lighting.streetAirHaze).toBeCloseTo(0.25, 4)
      expect(out.look).toEqual(plain.look)
      expect(out.lighting.skyFill).toBe(plain.lighting.skyFill)
      expect(out.lighting.moonFill).toBe(plain.lighting.moonFill)
    }
  })
})
