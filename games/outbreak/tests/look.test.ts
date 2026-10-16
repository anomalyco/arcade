import { describe, expect, test } from "bun:test"
import { createLookSettings } from "@arcade/kit/look"
import { flashlightColor } from "../shared/flashlight"
import { OUTBREAK_HERO_UNIFORM_OFFSET, packOutbreakLightingUniforms } from "../src/lighting"
import { DEFAULT_HERO_LOOK, heroLookControls, heroShape, heroTint, HERO_STYLE_SURFACES, HERO_STYLES } from "../src/look/hero"
import { applyLookPreset } from "../src/look/index"
import { OUTBREAK_LOOK_PRESETS } from "../src/look/presets"
import { DEFAULT_LOOK_TRIMS, lightRuleWeight, lookTrimControls, trimLighting, trimLook } from "../src/look/world"
import { createOutbreakSettings, createOutbreakSubsystemDefaults } from "../src/settings"
import { Survivor } from "../src/survivor"

const frame = (settings: ReturnType<typeof createOutbreakSettings>) => ({
  settings,
  playerX: 27.7,
  playerY: 41,
  playerH: 0,
  playerAim: -Math.PI / 2,
  flashlightOutput: 1,
  flashlightSlot: 1,
  inInteriorView: false,
  streetHead: [36.86, 6.18, 47.49] as const,
  zombies: [-999, -999, -999, -999] as const,
})

describe("Outbreak look", () => {
  test("today's look is the identity apart from the light-colour rule, which holds at night and not by day", () => {
    const base = createLookSettings("noir")
    expect(trimLook(base, { ...DEFAULT_LOOK_TRIMS, lightColour: 0 }, createLookSettings("current"))).toEqual(base)
    expect(trimLook(base, DEFAULT_LOOK_TRIMS, createLookSettings("current"), 0)).toEqual(base)
    const night = trimLook(base, DEFAULT_LOOK_TRIMS, createLookSettings("current"), 1)
    expect(night).toEqual({
      ...base,
      saturation: DEFAULT_LOOK_TRIMS.worldSaturation,
      selectiveColor: DEFAULT_LOOK_TRIMS.litColour,
      practicalWarmth: 0,
    })
    expect(lightRuleWeight(DEFAULT_LOOK_TRIMS, 0.5)).toBeCloseTo(0.5)
    const settings = createOutbreakSettings()
    expect(trimLighting(settings.lighting, settings.look)).toMatchObject({
      skyFill: settings.lighting.skyFill,
      roomPower: settings.lighting.roomPower,
      practicalWarmth: settings.lighting.practicalWarmth,
    })
    const packed = packOutbreakLightingUniforms(frame(settings), flashlightColor(0.92))
    const untrimmed = packOutbreakLightingUniforms(frame({ ...settings, look: undefined } as never), flashlightColor(0.92))
    expect([...packed]).toEqual([...untrimmed])
    expect(settings.survivor.heroStyle).toBe(0)
  })

  test("every preset sets every knob, so presets never leak into each other, and today restores the defaults", () => {
    const keys = [...lookTrimControls, ...heroLookControls].map(c => c.key).sort()
    for (const preset of OUTBREAK_LOOK_PRESETS) {
      expect(Object.keys(preset.knobs).sort()).toEqual(keys)
      expect(preset.version).toBeGreaterThanOrEqual(1)
      for (const c of [...lookTrimControls, ...heroLookControls]) {
        const v = preset.knobs[c.key as keyof typeof preset.knobs]
        if ("min" in c) expect({ preset: preset.id, key: c.key, ok: v >= c.min && v <= c.max }).toEqual({ preset: preset.id, key: c.key, ok: true })
      }
    }
    const settings = createOutbreakSettings()
    applyLookPreset(settings, "big-walk")
    expect(settings.look.lookIdea).toBe("big-walk")
    expect(settings.survivor.heroStyle).toBe(2)
    expect(settings.look.lookSaturation).toBeGreaterThan(1)
    applyLookPreset(settings, "today")
    const defaults = createOutbreakSubsystemDefaults()
    expect(settings.look).toEqual(defaults.look)
    expect(settings.survivor).toEqual(defaults.survivor)
    expect(applyLookPreset(settings, "nope")).toBe(false)
  })

  test("trims scale the hour's grade and lights and pack the hero surface", () => {
    const settings = createOutbreakSettings()
    applyLookPreset(settings, "warm-practicals")
    const base = createLookSettings("noir")
    const graded = trimLook(base, settings.look, createLookSettings("noir"), 0)
    expect(graded.practicalWarmth).toBeCloseTo(base.practicalWarmth + 0.9)
    expect(graded.saturation).toBeCloseTo(base.saturation * 1.3)
    const lit = trimLighting(settings.lighting, settings.look)
    expect(lit.roomPower).toBeCloseTo(settings.lighting.roomPower * 1.5 * 1.6)
    applyLookPreset(settings, "big-walk")
    const packed = packOutbreakLightingUniforms(frame(settings), flashlightColor(0.92))
    const s = HERO_STYLE_SURFACES[2]!
    expect([...packed.slice(OUTBREAK_HERO_UNIFORM_OFFSET, OUTBREAK_HERO_UNIFORM_OFFSET + 4)].map(v => +v.toFixed(4))).toEqual([
      s.heroRim, s.heroRimTight, s.heroFlat, +s.heroSaturation.toFixed(4),
    ])
  })

  test("survivor styles: today keeps its boxes; simple styles draw their own tinted figure with the same rig", () => {
    expect(HERO_STYLES.map(s => heroShape(HERO_STYLES.indexOf(s)))).toEqual([0, 1, 1, 2])
    let next = 0
    const s = new Survivor({ addModel: () => next++ })
    const pose = { x: 27.7, y: 41, vx: 1.4, vy: 0, aim: 0 }
    const ids = (style: number) => {
      const batches = s.draw(pose, 1 / 60, 0, () => 0, { heroStyle: style })
      return { models: batches.map(b => b.model), tint: [...batches[0]!.data.slice(4, 7)] }
    }
    const today = ids(0)
    const mannequin = ids(1)
    const capsule = ids(3)
    expect(today.tint).toEqual([1, 1, 1])
    expect(mannequin.models).not.toEqual(today.models)
    expect(capsule.models).not.toEqual(mannequin.models)
    expect(ids(2).models).toEqual(mannequin.models)
    const tint = heroTint(DEFAULT_HERO_LOOK, null)
    expect(mannequin.tint.map(v => +v.toFixed(4))).toEqual(tint.map(v => +Math.fround(v).toFixed(4)))
    // Same rig: two survivors walking the same path put every part in the same place whatever their style.
    const a = new Survivor({ addModel: () => 0 })
    const b = new Survivor({ addModel: () => 0 })
    for (let n = 0; n < 90; n++) {
      const p = { ...pose, x: 27.7 + n * 1.4 / 60 }
      const fa = a.draw(p, 1 / 60, n / 60, () => 0, { heroStyle: 0 }).map(x => [...x.data.slice(0, 4), ...x.data.slice(8, 10)])
      const fb = b.draw(p, 1 / 60, n / 60, () => 0, { heroStyle: 3 }).map(x => [...x.data.slice(0, 4), ...x.data.slice(8, 10)])
      expect(fb).toEqual(fa)
    }
  })

  test("co-op seats tint the simple figure a little toward their jacket", () => {
    const own = heroTint(DEFAULT_HERO_LOOK, null)
    const seat = heroTint(DEFAULT_HERO_LOOK, [0.8, 0.1, 0.1])
    expect(seat[0]).toBeGreaterThan(own[0])
    expect(seat[2]).toBeLessThan(own[2])
  })
})
