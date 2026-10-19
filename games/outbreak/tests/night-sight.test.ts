import { describe, expect, test } from "bun:test"
import { makeTown } from "../shared/map"
import { DEFAULT_OUTBREAK_LIGHTING, OUTBREAK_NIGHT_UNIFORM_OFFSET, packOutbreakLightingUniforms, resolveLampLight, windowBuildingBits } from "../src/lighting"
import { windowLampBuilding, windowsLit } from "../src/look/lit-windows"
import { easeNightSight, nightSightRange, nightSightReach, nightSightTarget } from "../src/look/night-sight"
import { DEFAULT_LOOK_TRIMS } from "../src/look/world"

describe("night sight", () => {
  test("only at night, only without a light, and off at 0 (today)", () => {
    const look = DEFAULT_LOOK_TRIMS
    expect(nightSightTarget(look, 0, 0)).toBe(0)
    expect(nightSightTarget(look, 1, 0)).toBe(1)
    expect(nightSightTarget(look, 1, 1)).toBe(0)
    expect(nightSightTarget({ ...look, nightSight: 0 }, 1, 0)).toBe(0)
    const dusk = nightSightTarget(look, 0.5, 0)
    expect(dusk).toBeGreaterThan(0)
    expect(dusk).toBeLessThan(1)
  })

  test("eases toward the target and snaps on a reset", () => {
    expect(easeNightSight(0, 1, 0)).toBe(1)
    const step = easeNightSight(0, 1, 1 / 60)
    expect(step).toBeGreaterThan(0)
    expect(step).toBeLessThan(0.1)
  })

  test("the client's vision stops where night sight goes dark", () => {
    const look = DEFAULT_LOOK_TRIMS
    expect(nightSightRange(27, look, 0)).toBe(27)
    expect(nightSightRange(27, look, 1)).toBeCloseTo(nightSightReach(look) + 1)
    expect(nightSightReach(look)).toBeLessThan(15)
    expect(nightSightRange(5, look, 1)).toBe(5)
  })

  test("packs the weight, radius and fade into the night uniform", () => {
    const town = makeTown(1)
    const out = packOutbreakLightingUniforms(
      {
        settings: { ...DEFAULT_OUTBREAK_LIGHTING, flashlightIntensity: 0.48, flashlightRange: 19, flashlightCone: 56, flashlightWarmth: 0.92 },
        playerX: 0,
        playerY: 0,
        playerH: 0,
        playerAim: 0,
        flashlightOutput: 0,
        flashlightSlot: -1,
        inInteriorView: false,
        streetHead: [0, 0, 0],
        zombies: [0, 0, 0, 0],
        windowBuildings: town.buildings,
        nightSightWeight: 0.75,
      },
      [1, 1, 1],
    )
    expect(out[OUTBREAK_NIGHT_UNIFORM_OFFSET]).toBeCloseTo(0.75)
    expect(out[OUTBREAK_NIGHT_UNIFORM_OFFSET + 1]).toBeCloseTo(DEFAULT_LOOK_TRIMS.nightSightRadius)
    expect(out[OUTBREAK_NIGHT_UNIFORM_OFFSET + 2]).toBeCloseTo(DEFAULT_LOOK_TRIMS.nightSightFalloff)
  })
})

describe("lit windows", () => {
  test("a stable share of buildings keep a lamp on", () => {
    const ids = Array.from({ length: 2000 }, (_, i) => ({ id: `c${i % 40}_${(i / 40) | 0}-house` }))
    const lit = ids.filter(b => windowsLit(b, 0.2)).length / ids.length
    expect(lit).toBeGreaterThan(0.15)
    expect(lit).toBeLessThan(0.25)
    expect(ids.every(b => windowsLit(b, 1))).toBe(true)
    expect(ids.some(b => windowsLit(b, 0))).toBe(false)
    expect(windowsLit({ id: "" }, 1)).toBe(false)
  })

  test("window lamps of dark houses give no light; lit houses keep today's", () => {
    const town = makeTown(3)
    const windows = town.lamps.filter(l => l.kind === "window")
    expect(windows.length).toBeGreaterThan(0)
    for (const lamp of windows) {
      const b = windowLampBuilding(lamp, town.buildings)!
      expect(b).toBeDefined()
      const dark = resolveLampLight(lamp, town.buildings, 1, DEFAULT_OUTBREAK_LIGHTING, false, undefined, 0)
      const all = resolveLampLight(lamp, town.buildings, 1, DEFAULT_OUTBREAK_LIGHTING, false, undefined, 1)
      expect(dark.power).toBe(0)
      expect(all.power).toBeGreaterThan(0)
    }
  })

  test("lit-window bits sit above the plan and kitchen bits", () => {
    const blds = [
      { id: "ash", kind: "house" },
      { id: "c4_2-house", kind: "house" },
    ]
    expect(windowBuildingBits(blds, 0)).toBe(0b11 | (1 << 8))
    expect(windowBuildingBits(blds, 1)).toBe(0b11 | (1 << 8) | (0b11 << 16))
  })
})
