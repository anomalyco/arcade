import { describe, expect, test } from "bun:test"
import {
  LOOK_GROUPS,
  LOOK_PARAM_SPECS,
  LOOK_PRESETS,
  LOOK_PRESET_IDS,
  LOOK_UNIFORM_FLOATS,
  applyLookPreset,
  createLookSettings,
  exportLookPreset,
  importLookPreset,
  isIdentityLook,
  packLookUniforms,
  randomizeLookSettings,
  resolveLookGroup,
  resolveLookPresetId,
  validateLookSettings,
} from "./look"
import { makeLookPostShader, makeLookSceneShader, makeSceneShader, postShader, sceneShader } from "./shaders"

describe("LookSettings & Presets (@arcade/kit/look)", () => {
  test("all 6 presets validate against LOOK_PARAM_SPECS bounds and steps", () => {
    expect(LOOK_PRESET_IDS).toEqual([
      "current",
      "noir",
      "painterly",
      "cinematic_dusk",
      "sodium_70s",
      "cozy_golden_hour",
    ])
    for (const id of LOOK_PRESET_IDS) {
      const settings = createLookSettings(id)
      const res = validateLookSettings(settings)
      expect(res.ok).toBe(true)
      if (res.ok) {
        expect(res.value.preset).toBe(id)
      }
    }
  })

  test("Current preset is strict identity; non-Current presets or parameter edits mark look active", () => {
    expect(isIdentityLook(null)).toBe(true)
    expect(isIdentityLook(undefined)).toBe(true)
    const cur = createLookSettings("current")
    expect(isIdentityLook(cur)).toBe(true)

    const packedCur = packLookUniforms(cur)
    expect(packedCur.length).toBe(LOOK_UNIFORM_FLOATS)
    // u11.w (index 47) is activeFlag: 0 for Current identity
    expect(packedCur[47]).toBe(0)

    for (const id of LOOK_PRESET_IDS) {
      if (id === "current") continue
      const p = createLookSettings(id)
      expect(isIdentityLook(p)).toBe(false)
      const packed = packLookUniforms(p)
      expect(packed[47]).toBe(1)
    }

    const tweaked = createLookSettings("current")
    tweaked.contrast = 1.18
    expect(isIdentityLook(tweaked)).toBe(false)
    expect(packLookUniforms(tweaked)[47]).toBe(1)

    applyLookPreset(tweaked, "current")
    expect(isIdentityLook(tweaked)).toBe(true)
    expect(packLookUniforms(tweaked)[47]).toBe(0)
  })

  test("default sceneShader and postShader remain untouched for pixel-identical Current rendering", () => {
    const baseScene = sceneShader(true, false)
    const baseSceneOff = sceneShader(false, false)
    const basePost = postShader(true, false)
    const basePostOff = postShader(false, false)

    // Baseline shaders must not contain LookUniforms bindings or look-hook branches
    expect(baseScene).not.toContain("LookUniforms")
    expect(baseSceneOff).not.toContain("LookUniforms")
    expect(basePost).not.toContain("LookUniforms")
    expect(basePostOff).not.toContain("LookUniforms")

    // Opt-in Look shaders include LookUniforms, AgX/Filmic tonemappers, Kuwahara, and flashlight cone
    const lookScene = makeLookSceneShader()
    const lookPost = makeLookPostShader({ chromatic: 0, bloom: 0.045, grain: 0.002, vignette: 0.92, diagnostics: true, shadowLift: 0, huePreserve: 0.35 })
    expect(lookScene).toContain("struct LookUniforms")
    expect(lookScene).toContain("lookQuantizeDiffuse")
    expect(lookScene).toContain("lookFlashIrradiance")
    expect(lookPost).toContain("lookTonemapAgX")
    expect(lookPost).toContain("kuwaharaPost")
    expect(lookPost).toContain("flashMask")

    // Noir preset enables light-driven selective colour restoration (u15.w = selectiveColor > 1.0)
    const noir = createLookSettings("noir")
    expect(noir.selectiveColor).toBeGreaterThan(1.0)
    expect(noir.saturation).toBeLessThan(0.15)
    expect(packLookUniforms(noir)[63]).toBeCloseTo(noir.selectiveColor, 5)
  })

  test("deterministic seeded randomization isolates groups and respects bounds", () => {
    const base = createLookSettings("noir")
    const r1 = randomizeLookSettings(base, 404, "Atmosphere & Shafts")
    const r2 = randomizeLookSettings(base, 404, "Atmosphere & Shafts")
    const r3 = randomizeLookSettings(base, 405, "Atmosphere & Shafts")

    expect(r1).toEqual(r2)
    expect(r1).not.toEqual(r3)

    // Non-atmosphere groups remain untouched
    for (const spec of LOOK_PARAM_SPECS) {
      if (spec.group !== "Atmosphere & Shafts") {
        expect(r1[spec.key]).toBe(base[spec.key])
      } else if (spec.type === "range") {
        const val = r1[spec.key as keyof typeof r1] as number
        expect(val).toBeGreaterThanOrEqual(spec.min!)
        expect(val).toBeLessThanOrEqual(spec.max!)
      }
    }
  })

  test("exportLookPreset and importLookPreset round-trip and reject malformed inputs", () => {
    for (const id of LOOK_PRESET_IDS) {
      const s = createLookSettings(id)
      const exported = exportLookPreset(s, { tuningSeed: 321, roomSeed: 19 })
      const imported = importLookPreset(JSON.stringify(exported))
      expect(imported.ok).toBe(true)
      if (imported.ok) {
        expect(imported.value.preset).toBe(id)
        expect(imported.value.tuningSeed).toBe(321)
        expect(imported.value.roomSeed).toBe(19)
        expect(imported.value.settings).toEqual(s)
      }
    }

    expect(importLookPreset("{bad json").ok).toBe(false)
    expect(importLookPreset(JSON.stringify({ version: 2, preset: "noir" })).ok).toBe(false)
    expect(importLookPreset(JSON.stringify({ version: 1, preset: "unknown_style" })).ok).toBe(false)
    expect(importLookPreset(JSON.stringify({ version: 1, preset: "noir", settings: { exposure: 999 } })).ok).toBe(false)
  })

  test("resolveLookPresetId and resolveLookGroup accept human labels and slugs", () => {
    expect(resolveLookPresetId("Noir / Limbo")).toBe("noir")
    expect(resolveLookPresetId("amber-limbo")).toBe("noir")
    expect(resolveLookPresetId("Painterly")).toBe("painterly")
    expect(resolveLookPresetId("70s sodium")).toBe("sodium_70s")
    expect(resolveLookPresetId("Cozy golden hour")).toBe("cozy_golden_hour")
    expect(resolveLookPresetId("Cinematic dusk")).toBe("cinematic_dusk")
    expect(resolveLookPresetId("Current")).toBe("current")

    for (const g of LOOK_GROUPS) {
      expect(resolveLookGroup(g)).toBe(g)
    }
    expect(resolveLookGroup("atmosphere")).toBe("Atmosphere & Shafts")
    expect(resolveLookGroup("painterly")).toBe("Painterly & Ink")
  })
})
