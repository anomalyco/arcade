import { describe, expect, test } from "bun:test"
import { CUSTOM_UNIFORM_BYTES } from "@arcade/kit/gpu/renderer"
import { LIGHT_RAMP_FLOATS } from "../src/light-ramps"
import { Vision } from "../shared/vision"
import {
  DEFAULT_OUTBREAK_LIGHTING,
  OUTBREAK_LIGHTING_UNIFORM_FLOATS,
  OUTBREAK_UNSEEN_UNIFORM_OFFSET,
  packOutbreakLightingUniforms,
} from "../src/lighting"
import { createOutbreakSettings, resolveOutbreakSettingTarget } from "../src/settings"
import { shaders } from "../src/shaders"
import {
  applyUnseenModePreset,
  DEFAULT_UNSEEN_SETTINGS,
  evaluateUnseenFrame,
  outbreakUnseenFieldWgsl,
  outbreakUnseenPostWgsl,
  outbreakUnseenSceneWgsl,
  syncUnseenSettingChange,
  UNSEEN_MODE_OPTIONS,
  UNSEEN_PRESETS,
  unpackUnseenPostParams,
  unseenControls,
  unseenUniformsStruct,
} from "../src/unseen"

describe("outbreak unseen visibility & post-process", () => {
  test("defaults to Shroud blend (mode 10) and exposes all 13 Lab controls in the Unseen group", () => {
    expect(DEFAULT_UNSEEN_SETTINGS.unseenMode).toBe(10)
    expect(DEFAULT_UNSEEN_SETTINGS.unseenShroud).toBe(UNSEEN_PRESETS[10].shroud)
    expect(DEFAULT_UNSEEN_SETTINGS.unseenNoise).toBe(UNSEEN_PRESETS[10].noise)
    expect(DEFAULT_UNSEEN_SETTINGS.unseenWarp).toBe(UNSEEN_PRESETS[10].warp)
    expect(DEFAULT_UNSEEN_SETTINGS.hideUnseenZombies).toBe(true)
    expect(UNSEEN_MODE_OPTIONS.map((o) => o.value)).toEqual([10, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(unseenControls.every((c) => c.group === "Unseen")).toBe(true)
    expect(unseenControls.map((c) => c.key)).toEqual([
      "unseenMode",
      "unseenStrength",
      "unseenGlitch",
      "unseenGlitchEdge",
      "unseenWarp",
      "unseenShroud",
      "unseenMemory",
      "unseenNoise",
      "unseenNightScale",
      "unseenEdgeSoftness",
      "unseenDepthCurve",
      "unseenUpdateRate",
      "hideUnseenZombies",
    ])

    const settings = createOutbreakSettings()
    expect(settings.unseen).toEqual(DEFAULT_UNSEEN_SETTINGS)
    for (const c of unseenControls) {
      expect(resolveOutbreakSettingTarget(c.key)?.subsystem).toBe("unseen")
      expect(resolveOutbreakSettingTarget(`unseen.${c.key}`)?.subsystem).toBe("unseen")
    }
  })

  test("scales effective strength with darkness (stronger at night, subtle by day) and low-HP panic", () => {
    const offEval = evaluateUnseenFrame({ unseenMode: 0, unseenStrength: 1.2 }, 1.0, 100, 100)
    expect(offEval.mode).toBe(0)
    expect(offEval.active).toBe(false)
    expect(offEval.effectiveStrength).toBe(0)
    expect(offEval.postParams).toEqual([0, 0, 0])

    const nightEval = evaluateUnseenFrame({ unseenMode: 1, unseenStrength: 1.0, unseenNightScale: 0.75 }, 1.0, 100, 100)
    const dayEval = evaluateUnseenFrame({ unseenMode: 1, unseenStrength: 1.0, unseenNightScale: 0.75 }, 0.0, 100, 100)
    expect(nightEval.nightFactor).toBe(1.0)
    expect(nightEval.effectiveStrength).toBe(1.0)
    expect(nightEval.layers.glitch).toBe(1.0)
    expect(dayEval.nightFactor).toBeCloseTo(0.46, 2)
    expect(dayEval.effectiveStrength).toBeLessThan(nightEval.effectiveStrength * 0.5)

    const panicEval = evaluateUnseenFrame({ unseenMode: 2, unseenStrength: 1.0, unseenNightScale: 0.75 }, 1.0, 20, 100)
    expect(panicEval.panicBoost).toBeGreaterThan(0.25)
    expect(panicEval.effectiveStrength).toBeGreaterThan(nightEval.effectiveStrength)
    expect(panicEval.layers.warp).toBeCloseTo(panicEval.effectiveStrength, 3)
  })

  test("combines multiple layers, syncs preset sliders with custom edits, and round-trips postParams", () => {
    const s = { ...DEFAULT_UNSEEN_SETTINGS }
    s.unseenMode = 8 as typeof s.unseenMode
    syncUnseenSettingChange(s, "unseenMode")
    expect(s.unseenGlitch).toBe(UNSEEN_PRESETS[8].glitch)
    expect(s.unseenGlitchEdge).toBe(UNSEEN_PRESETS[8].glitchEdge)
    expect(s.unseenShroud).toBe(UNSEEN_PRESETS[8].shroud)
    expect(s.unseenNoise).toBe(UNSEEN_PRESETS[8].noise)

    const comboEval = evaluateUnseenFrame(s, 1.0, 100, 100)
    expect(comboEval.active).toBe(true)
    const unpacked = unpackUnseenPostParams(comboEval.postParams)
    expect(unpacked.layers.glitch).toBeCloseTo(1.0, 2)
    expect(unpacked.layers.glitchEdge).toBeCloseTo(0.85, 2)
    expect(unpacked.layers.shroud).toBeCloseTo(0.85, 2)
    expect(unpacked.layers.noise).toBeCloseTo(0.35, 2)
    expect(unpacked.updateRate).toBe(10)

    // Adjusting an individual layer slider promotes unseenMode to 9 ("Custom layers")
    s.unseenWarp = 0.55
    syncUnseenSettingChange(s, "unseenWarp")
    expect(s.unseenMode as number).toBe(9)
    const customEval = evaluateUnseenFrame(s, 1.0, 100, 100)
    const customUnpacked = unpackUnseenPostParams(customEval.postParams)
    expect(customUnpacked.layers.warp).toBeCloseTo(0.55, 2)
    expect(customUnpacked.layers.glitch).toBeCloseTo(1.0, 2)

    // Returning to Off zeroes the layer sliders
    applyUnseenModePreset(s, 0)
    expect(s.unseenGlitch).toBe(0)
    expect(s.unseenWarp).toBe(0)
    expect(s.unseenShroud).toBe(0)
    expect(s.unseenMemory).toBe(0)
    expect(s.unseenNoise).toBe(0)
  })

  test("packs UnseenUniforms (8 floats / 32 bytes) into OutbreakLightingUniforms after interior uniforms", () => {
    expect(unseenUniformsStruct.floatCount).toBe(8)
    expect(unseenUniformsStruct.byteSize).toBe(32)
    expect(OUTBREAK_UNSEEN_UNIFORM_OFFSET).toBe(212)
    // The falloff curves' flags and tables follow the unseen block (see light-ramps.ts).
    // Then the simple survivor's surface (one vec4f).
    expect(OUTBREAK_LIGHTING_UNIFORM_FLOATS).toBe(220 + LIGHT_RAMP_FLOATS + 4)
    expect(OUTBREAK_LIGHTING_UNIFORM_FLOATS * 4).toBeLessThanOrEqual(CUSTOM_UNIFORM_BYTES)

    const settings = createOutbreakSettings()
    settings.unseen.unseenMode = 1
    settings.unseen.unseenStrength = 1.25
    settings.unseen.unseenEdgeSoftness = 0.95
    settings.unseen.unseenUpdateRate = 12
    settings.unseen.hideUnseenZombies = false
    const unseenEval = evaluateUnseenFrame(settings.unseen, 1.0, 100, 100)

    const buf = packOutbreakLightingUniforms(
      {
        settings: {
          ...DEFAULT_OUTBREAK_LIGHTING,
          flashlightIntensity: 1.0,
          flashlightRange: 14,
          flashlightCone: 60,
          flashlightWarmth: 0.5,
        },
        playerX: 28,
        playerY: 38,
        playerH: 0,
        playerAim: 0,
        flashlightOutput: 1,
        flashlightSlot: 1,
        inInteriorView: false,
        streetHead: [38, 6, 47],
        zombies: [-999, -999, -999, -999],
        unseen: unseenEval,
      },
      [1, 0.9, 0.7],
    )

    expect(buf[OUTBREAK_UNSEEN_UNIFORM_OFFSET + 0]).toBe(1)
    expect(buf[OUTBREAK_UNSEEN_UNIFORM_OFFSET + 1]).toBeCloseTo(1.25, 4)
    expect(buf[OUTBREAK_UNSEEN_UNIFORM_OFFSET + 2]).toBeCloseTo(0.95, 4)
    expect(buf[OUTBREAK_UNSEEN_UNIFORM_OFFSET + 3]).toBe(12)
    expect(buf[OUTBREAK_UNSEEN_UNIFORM_OFFSET + 4]).toBe(1)
    expect(buf[OUTBREAK_UNSEEN_UNIFORM_OFFSET + 5]).toBeCloseTo(Math.cos((60 * Math.PI) / 360), 4)
    expect(buf[OUTBREAK_UNSEEN_UNIFORM_OFFSET + 6]).toBe(1)
    expect(buf[OUTBREAK_UNSEEN_UNIFORM_OFFSET + 7]).toBe(0)
  })

  test("resolves typed WGSL snippets into visibilityField, lookScene, and lookPost shaders", () => {
    expect(outbreakUnseenFieldWgsl).toContain("fn evalUnseenFlashCone")
    expect(outbreakUnseenFieldWgsl).toContain("fn evalUnseenEdgeDepth")
    expect(outbreakUnseenSceneWgsl).toContain("fn applyOutbreakUnseenScene")
    expect(outbreakUnseenSceneWgsl).toContain("fn applyOutbreakUnseenActor")
    expect(outbreakUnseenPostWgsl).toContain("fn applyOutbreakUnseenPost")

    expect(shaders.visField.code).toContain("evalUnseenEdgeDepth")
    expect(shaders.lookScene).toContain("applyOutbreakUnseenScene")
    expect(shaders.lookPost).toContain("applyOutbreakUnseenPost")
    expect(shaders.lookPostVariant("noir")).toContain("applyOutbreakUnseenPost")
  })

  test("counts unoccluded active flashlight cone as seen in Vision while respecting wall blockers", () => {
    const v = new Vision()
    const wall: [number, number, number, number] = [20, 8, 21, 14]
    // Narrow 60-deg vision cone facing East (0 rad), but active flashlight pointing North-East (0.75 rad)
    v.update(
      10,
      10,
      0,
      [wall],
      { range: 12, cone: 60, awareness: 2.0 },
      null,
      { active: true, range: 16, cone: 50, aim: 0.75 },
    )
    // Point at angle 0.75 rad, distance 10m is outside the 60-deg East vision cone, but inside the flashlight cone
    const fx = 10 + Math.cos(0.75) * 10
    const fy = 10 + Math.sin(0.75) * 10
    expect(v.visible(fx, fy)).toBe(true)
    expect(v.actorVisible(fx, fy)).toBeGreaterThan(0.8)

    // Point behind the wall (23, 10) is blocked even inside the cone
    expect(v.visible(23, 10)).toBe(false)
    expect(v.actorVisible(23, 10)).toBe(0)
  })
})
