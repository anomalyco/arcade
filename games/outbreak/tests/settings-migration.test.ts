import { describe, expect, test } from "bun:test"
import { DEFAULT_AI_CONFIG, LEGACY_AI_CONFIG } from "../shared/ai"
import { TICK_DT } from "../shared/clock"
import { COOP_TUNING } from "../shared/coop-config"
import { LocalSession, resolveSessionTuning } from "../shared/session"
import { DEFAULT_STAMINA_TUNING } from "../shared/stamina"
import {
  applyOutbreakPreset,
  createOutbreakSettings,
  exportOutbreakPreset,
  getOutbreakSetting,
  migrateOutbreakLocalStorage,
  migrateOutbreakPreset,
  migrateOutbreakUrlParams,
  OUTBREAK_KNOBS_VARIANTS_KEY,
  OUTBREAK_PRESETS_STORAGE_V1,
  OUTBREAK_PRESETS_STORAGE_V2,
  OUTBREAK_SUBSYSTEM_KEYS,
  setOutbreakSetting,
} from "../src/settings"
import { DAY_NIGHT_CURVES, DEFAULT_DAY_NIGHT_CURVES } from "../src/day-night"
import { curveText } from "@arcade/kit/ramps"

describe("Outbreak subsystem-namespaced settings & migration", () => {
  test("namespaces settings into 18 typed subsystems without walkSpeed collisions", () => {
    const settings = createOutbreakSettings()
    expect(Object.keys(settings)).toEqual([...OUTBREAK_SUBSYSTEM_KEYS])

    // AI walkSpeed (0.95) and survivor stamina walkSpeed (3.4) live in separate namespaces
    expect(settings.ai.walkSpeed).toBe(DEFAULT_AI_CONFIG.walkSpeed)
    expect(settings.stamina.walkSpeed).toBe(DEFAULT_STAMINA_TUNING.walkSpeed)
    expect(settings.ai.walkSpeed).not.toBe(settings.stamina.walkSpeed)

    // Updating one never mutates the other
    setOutbreakSetting(settings, "ai.walkSpeed", 1.55)
    setOutbreakSetting(settings, "walkSpeed", 4.1)
    expect(settings.ai.walkSpeed).toBe(1.55)
    expect(settings.stamina.walkSpeed).toBe(4.1)

    // Legacy key alias routes to settings.ai.walkSpeed
    setOutbreakSetting(settings, "aiWalkSpeed", 1.25)
    expect(settings.ai.walkSpeed).toBe(1.25)
    expect(getOutbreakSetting(settings, "ai.walkSpeed")).toBe(1.25)
    expect(getOutbreakSetting(settings, "aiWalkSpeed")).toBe(1.25)
    expect(settings.stamina.walkSpeed).toBe(4.1)
  })

  test("SessionTuning and CoopSim accept namespaced settings and preserve co-op tuning", () => {
    const settings = createOutbreakSettings()
    settings.ai.walkSpeed = 1.65
    settings.stamina.walkSpeed = 3.9
    const resolved = resolveSessionTuning(settings)
    expect(resolved.ai?.walkSpeed).toBe(1.65)
    expect(resolved.stamina.walkSpeed).toBe(3.9)

    const session = new LocalSession(7, 7, 0.22, settings.ai, settings.progression, "classic")
    session.update(TICK_DT, { mx: 1, my: 0, aim: 0, interact: false }, 0, settings)
    expect(session.ai.config.walkSpeed).toBe(1.65)

    const coopResolved = resolveSessionTuning(COOP_TUNING)
    expect(coopResolved.stamina).toEqual(DEFAULT_STAMINA_TUNING)
    expect(coopResolved.ai).toBeUndefined()
  })

  test("ships the D-22 Balanced Curve and still loads presets saved with the pre-D-22 difficulty", () => {
    const settings = createOutbreakSettings()
    expect(settings.ai.zombieCount).toBe(16)
    expect(settings.ai.maxActiveNearPlayer).toBe(3)
    expect(settings.progression.lootRate).toBe(1.05)

    // A v2 preset exported before D-22 carries every knob explicitly, so it restores the old difficulty.
    const before = createOutbreakSettings()
    Object.assign(before.ai, LEGACY_AI_CONFIG)
    before.progression.lootRate = 1
    const legacyPreset = JSON.parse(JSON.stringify(exportOutbreakPreset(before)))
    const restored = createOutbreakSettings()
    expect(applyOutbreakPreset(restored, legacyPreset).ok).toBe(true)
    for (const key of ["zombieCount", "initialDensity", "rampTime", "safeRadius", "sightRange", "hearingScale", "noiseSensitivity", "chaseSpeed", "aggression", "nightMultiplier", "maxActiveNearPlayer"] as const) {
      expect(restored.ai[key]).toBe(LEGACY_AI_CONFIG[key])
    }
    expect(restored.progression.lootRate).toBe(1)

    // A v1 flat preset with the old values loads the same way.
    const v1 = createOutbreakSettings()
    const res = applyOutbreakPreset(v1, { version: 1, settings: { zombieCount: 28, initialDensity: 0.25, maxActiveNearPlayer: 4, lootRate: 1 } })
    expect(res.ok).toBe(true)
    expect(v1.ai.zombieCount).toBe(28)
    expect(v1.ai.initialDensity).toBe(0.25)
    expect(v1.ai.maxActiveNearPlayer).toBe(4)
    expect(v1.progression.lootRate).toBe(1)
  })

  test("migrates v1 flat presets, unversioned dictionaries, and v2 namespaced presets", () => {
    const v1Raw = JSON.stringify({
      version: 1,
      settings: {
        exposure: 1.24,
        aiWalkSpeed: 1.45,
        walkSpeed: 3.8,
        flashlightIntensity: 0.9,
        wearAmount: 1.35,
        zombieLurch: 0.65,
        hudStyle: 1,
      },
    })
    const migratedV1 = migrateOutbreakPreset(v1Raw)
    expect(migratedV1.ok).toBe(true)
    if (!migratedV1.ok) return
    expect(migratedV1.migratedFrom).toBe(1)
    expect(migratedV1.preset.version).toBe(2)
    expect(migratedV1.preset.subsystems.lighting?.exposure).toBe(1.24)
    expect(migratedV1.preset.subsystems.ai?.walkSpeed).toBe(1.45)
    expect(migratedV1.preset.subsystems.stamina?.walkSpeed).toBe(3.8)
    expect(migratedV1.preset.subsystems.flashlight?.flashlightIntensity).toBe(0.9)
    expect(migratedV1.preset.subsystems.ground?.wearAmount).toBe(1.35)
    expect(migratedV1.preset.subsystems.zombies?.zombieLurch).toBe(0.65)
    expect(migratedV1.preset.subsystems.hud?.hudStyle).toBe(1)

    const settings = createOutbreakSettings()
    const applied = applyOutbreakPreset(settings, migratedV1.preset)
    expect(applied.ok).toBe(true)
    expect(settings.lighting.exposure).toBe(1.24)
    expect(settings.ai.walkSpeed).toBe(1.45)
    expect(settings.stamina.walkSpeed).toBe(3.8)
    expect(settings.ground.wearAmount).toBe(1.35)

    const exported = exportOutbreakPreset(settings)
    expect(exported.version).toBe(2)
    expect(exported.subsystems.ai?.walkSpeed).toBe(1.45)
    expect(exported.subsystems.stamina?.walkSpeed).toBe(3.8)

    // Rejects malformed payloads without mutating state
    const bad = applyOutbreakPreset(settings, { version: 99, settings: {} })
    expect(bad.ok).toBe(false)
    const badType = applyOutbreakPreset(settings, { version: 1, settings: { exposure: "not-a-number" } })
    expect(badType.ok).toBe(false)
    expect(settings.lighting.exposure).toBe(1.24)
  })

  test("day-night curves: old presets load with default curves, knobs Copies and URLs give curve text", () => {
    const settings = createOutbreakSettings()
    expect(settings.dayCycle.streetAirHazeCurve).toBe(DEFAULT_DAY_NIGHT_CURVES.streetAirHazeCurve)
    const edited = curveText([{ x: 0, y: 0.1 }, { x: 1, y: 0.5 }], { range: DAY_NIGHT_CURVES.streetAirHazeCurve.range })
    settings.dayCycle.streetAirHazeCurve = edited

    // A preset saved before the curves existed sets the day cycle without them: it gets the defaults back.
    const old = applyOutbreakPreset(settings, { version: 2, subsystems: { dayCycle: { hour: 18, timeScale: 60, dayNightLook: 1, lookPreset: "noir" } } })
    expect(old.ok).toBe(true)
    expect(settings.dayCycle.streetAirHazeCurve).toBe(DEFAULT_DAY_NIGHT_CURVES.streetAirHazeCurve)
    // One that doesn't touch the day cycle leaves the curves alone.
    settings.dayCycle.streetAirHazeCurve = edited
    expect(applyOutbreakPreset(settings, { version: 2, subsystems: { lighting: { exposure: 1.1 } } }).ok).toBe(true)
    expect(settings.dayCycle.streetAirHazeCurve).toBe(edited)

    // A knobs Copy carries points, not text; both forms land as normalized curve text.
    const copy = migrateOutbreakPreset({ "dayCycle.streetAirHazeCurve": [{ x: 0, y: 0.1 }, { x: 1, y: 0.5 }], skyFillCurve: edited })
    expect(copy.ok).toBe(true)
    if (!copy.ok) return
    expect(copy.preset.subsystems.dayCycle?.streetAirHazeCurve).toBe(edited)
    expect(copy.preset.subsystems.dayCycle?.skyFillCurve).toBe(curveText(JSON.parse(edited), { range: DAY_NIGHT_CURVES.skyFillCurve.range }))
    expect(migrateOutbreakPreset({ "dayCycle.streetAirHazeCurve": "fog" }).ok).toBe(false)
    expect(exportOutbreakPreset(settings).subsystems.dayCycle?.streetAirHazeCurve).toBe(edited)

    const fromUrl = createOutbreakSettings(new URLSearchParams(`dayCycle.streetAirHazeCurve=${encodeURIComponent(edited)}&moonFillCurve=nope`))
    expect(fromUrl.dayCycle.streetAirHazeCurve).toBe(edited)
    expect(fromUrl.dayCycle.moonFillCurve).toBe(DEFAULT_DAY_NIGHT_CURVES.moonFillCurve)
  })

  test("migrates URL parameters and localStorage variants/presets", () => {
    const params = new URLSearchParams("world=classic&peaceful=1&infiniteAmmo=1&aiWalkSpeed=1.3&lighting.exposure=1.18&walkSpeed=3.7")
    const settings = createOutbreakSettings(params)
    expect(settings.world.worldMode).toBe(0)
    expect(settings.ai.zombieCount).toBe(0)
    expect(settings.combat.infiniteAmmo).toBe(1)
    expect(settings.ai.walkSpeed).toBe(1.3)
    expect(settings.lighting.exposure).toBe(1.18)
    expect(settings.stamina.walkSpeed).toBe(3.7)

    const patch = migrateOutbreakUrlParams(new URLSearchParams("ground.wearAmount=1.5&ai.walkSpeed=1.1"))
    expect(patch.ground?.wearAmount).toBe(1.5)
    expect(patch.ai?.walkSpeed).toBe(1.1)

    const store = new Map<string, string>()
    const mockStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v)
      },
    }
    store.set(
      OUTBREAK_KNOBS_VARIANTS_KEY,
      JSON.stringify({
        version: 1,
        controls: "lab:arcade-outbreak",
        variants: [{ id: "night-run", values: { aiWalkSpeed: 1.5, walkSpeed: 3.6 } }],
      }),
    )
    store.set(
      OUTBREAK_PRESETS_STORAGE_V1,
      JSON.stringify({
        customNoir: { version: 1, settings: { exposure: 1.15, aiWalkSpeed: 1.4, wearAmount: 1.25 } },
      }),
    )

    const res = migrateOutbreakLocalStorage(mockStorage)
    expect(res.migratedVariants).toBe(1)
    expect(res.migratedPresets).toBe(1)

    const migratedVariants = JSON.parse(store.get(OUTBREAK_KNOBS_VARIANTS_KEY)!)
    expect(migratedVariants.variants[0].values).toEqual({ "ai.walkSpeed": 1.5, walkSpeed: 3.6 })

    const migratedPresets = JSON.parse(store.get(OUTBREAK_PRESETS_STORAGE_V2)!)
    expect(migratedPresets.customNoir.version).toBe(2)
    expect(migratedPresets.customNoir.subsystems.lighting.exposure).toBe(1.15)
    expect(migratedPresets.customNoir.subsystems.ai.walkSpeed).toBe(1.4)
    expect(migratedPresets.customNoir.subsystems.ground.wearAmount).toBe(1.25)
  })
})
