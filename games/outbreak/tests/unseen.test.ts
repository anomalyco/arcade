import { describe, expect, test } from "bun:test"
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
  DEFAULT_UNSEEN_SETTINGS,
  evaluateUnseenFrame,
  outbreakUnseenFieldWgsl,
  outbreakUnseenPostWgsl,
  outbreakUnseenSceneWgsl,
  UNSEEN_MODE_OPTIONS,
  unseenControls,
  unseenUniformsStruct,
} from "../src/unseen"

describe("outbreak unseen visibility & post-process", () => {
  test("defaults to Off (mode 0) and exposes all 6 Lab controls in the Unseen group", () => {
    expect(DEFAULT_UNSEEN_SETTINGS.unseenMode).toBe(0)
    expect(DEFAULT_UNSEEN_SETTINGS.hideUnseenZombies).toBe(true)
    expect(UNSEEN_MODE_OPTIONS.map((o) => o.value)).toEqual([0, 1, 2, 3, 4, 5])
    expect(unseenControls.every((c) => c.group === "Unseen")).toBe(true)
    expect(unseenControls.map((c) => c.key)).toEqual([
      "unseenMode",
      "unseenStrength",
      "unseenNightScale",
      "unseenEdgeSoftness",
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
    expect(offEval.effectiveStrength).toBe(0)
    expect(offEval.postParams).toEqual([0, 0, 10])

    const nightEval = evaluateUnseenFrame({ unseenMode: 1, unseenStrength: 1.0, unseenNightScale: 0.75 }, 1.0, 100, 100)
    const dayEval = evaluateUnseenFrame({ unseenMode: 1, unseenStrength: 1.0, unseenNightScale: 0.75 }, 0.0, 100, 100)
    expect(nightEval.nightFactor).toBe(1.0)
    expect(nightEval.effectiveStrength).toBe(1.0)
    expect(dayEval.nightFactor).toBeCloseTo(0.46, 2)
    expect(dayEval.effectiveStrength).toBeLessThan(nightEval.effectiveStrength * 0.5)

    const panicEval = evaluateUnseenFrame({ unseenMode: 2, unseenStrength: 1.0, unseenNightScale: 0.75 }, 1.0, 20, 100)
    expect(panicEval.panicBoost).toBeGreaterThan(0.25)
    expect(panicEval.effectiveStrength).toBeGreaterThan(nightEval.effectiveStrength)
  })

  test("packs UnseenUniforms (8 floats / 32 bytes) into OutbreakLightingUniforms at offset 164", () => {
    expect(unseenUniformsStruct.floatCount).toBe(8)
    expect(unseenUniformsStruct.byteSize).toBe(32)
    expect(OUTBREAK_UNSEEN_UNIFORM_OFFSET).toBe(164)
    expect(OUTBREAK_LIGHTING_UNIFORM_FLOATS).toBe(172)

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
