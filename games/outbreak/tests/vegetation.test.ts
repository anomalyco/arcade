import { describe, expect, test } from "bun:test"
import { FOLIAGE_BUILD_TODAY, FOLIAGE_GUST_OFF } from "@arcade/kit/gpu/foliage"
import { createOutbreakSettings } from "../src/settings"
import {
  DEFAULT_VEGETATION_SETTINGS,
  syncVegetationBuild,
  vegetationBuild,
  vegetationControls,
  vegetationGust,
  vegetationSignature,
} from "../src/vegetation/settings"

describe("Outbreak vegetation settings", () => {
  test("Lively is the default and Today is one setting away", () => {
    const s = { ...DEFAULT_VEGETATION_SETTINGS }
    syncVegetationBuild(s)
    expect(vegetationBuild.lively).toBe(true)
    expect(vegetationGust(s).on).toBe(1)
    const lively = vegetationSignature()
    expect(syncVegetationBuild({ ...s, vegLook: 0 })).toBe(true)
    expect({ ...vegetationBuild }).toEqual({ ...FOLIAGE_BUILD_TODAY })
    expect(vegetationGust({ ...s, vegLook: 0 })).toBe(FOLIAGE_GUST_OFF)
    expect(vegetationSignature()).not.toBe(lively)
    expect(syncVegetationBuild(s)).toBe(true)
    expect(vegetationSignature()).toBe(lively)
  })

  test("only structural settings rebuild; wind settings are live", () => {
    const s = { ...DEFAULT_VEGETATION_SETTINGS }
    syncVegetationBuild(s)
    expect(syncVegetationBuild({ ...s, vegWind: 2, vegGustScale: 40, vegBranchSway: 0.2 })).toBe(false)
    expect(syncVegetationBuild({ ...s, vegQuality: 2 })).toBe(true)
    expect(syncVegetationBuild({ ...s, vegQuality: 2 })).toBe(false)
    expect(syncVegetationBuild({ ...s, vegDeadTrees: 0.3 })).toBe(true)
    syncVegetationBuild(s)
  })

  test("the wind direction is a unit vector and the gust object is reused", () => {
    const a = vegetationGust({ ...DEFAULT_VEGETATION_SETTINGS, vegWindDir: 90 })
    expect(a.dirX).toBeCloseTo(0, 6)
    expect(a.dirZ).toBeCloseTo(1, 6)
    expect(vegetationGust(DEFAULT_VEGETATION_SETTINGS)).toBe(a)
  })

  test("every control is bound to the vegetation subsystem", () => {
    const settings = createOutbreakSettings()
    for (const c of vegetationControls) expect({ key: c.key, bound: c.key in settings.vegetation }).toEqual({ key: c.key, bound: true })
    expect(settings.vegetation).toEqual(DEFAULT_VEGETATION_SETTINGS)
  })
})
