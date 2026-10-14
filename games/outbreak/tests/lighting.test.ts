import { describe, expect, test } from "bun:test"
import { flashlightColor } from "../shared/flashlight"
import { makeTown } from "../shared/map"
import {
  DEFAULT_OUTBREAK_LIGHTING,
  OUTBREAK_LIGHTING_UNIFORM_FLOATS,
  outbreakLightingControls,
  packOutbreakLightingUniforms,
  resolveLampLight,
} from "../src/lighting"

describe("Outbreak lighting module & Lab controls", () => {
  test("every lighting setting has a corresponding shared Lab control with explicit unit and valid default", () => {
    const keys = Object.keys(DEFAULT_OUTBREAK_LIGHTING).sort()
    const controlKeys = outbreakLightingControls.map((c) => String(c.key)).sort()
    expect(controlKeys).toEqual(keys)
    for (const control of outbreakLightingControls) {
      expect("unit" in control && typeof control.unit === "string").toBe(true)
      if ("min" in control && "max" in control) {
        const def = DEFAULT_OUTBREAK_LIGHTING[control.key as keyof typeof DEFAULT_OUTBREAK_LIGHTING]
        expect(def).toBeGreaterThanOrEqual(control.min)
        expect(def).toBeLessThanOrEqual(control.max)
      }
    }
  })

  test("selective practicals keep NW bedside lamp shadow-casting while tightening porch, window, and accent lamps", () => {
    const town = makeTown(7)
    const porch = town.lamps.find((l) => l.kind === "porch")!
    const win = town.lamps.find((l) => l.kind === "window")!
    const street = town.lamps.find((l) => l.kind === "street")!
    const rooms = town.lamps.filter(
      (l) =>
        l.kind === "room" &&
        l.x >= town.buildings[0]!.rect[0] &&
        l.x <= town.buildings[0]!.rect[2] &&
        l.y >= town.buildings[0]!.rect[1] &&
        l.y <= town.buildings[0]!.rect[3],
    )

    const resPorchExt = resolveLampLight(porch, town.buildings, 1, DEFAULT_OUTBREAK_LIGHTING, false)
    const resPorchInt = resolveLampLight(porch, town.buildings, 1, DEFAULT_OUTBREAK_LIGHTING, true)
    expect(resPorchExt.r).toBeLessThan(porch.radius)
    expect(resPorchInt.power).toBeLessThan(resPorchExt.power)
    expect(resPorchExt.castShadows).toBe(true)

    const resWin = resolveLampLight(win, town.buildings, 1, DEFAULT_OUTBREAK_LIGHTING, false)
    expect(resWin.r).toBeLessThan(win.radius)

    const resStreet = resolveLampLight(street, town.buildings, 1, DEFAULT_OUTBREAK_LIGHTING, false)
    expect(resStreet.power).toBeLessThan(street.power)

    const resolvedRooms = rooms.map((l) => resolveLampLight(l, town.buildings, 1, DEFAULT_OUTBREAK_LIGHTING, true))
    expect(resolvedRooms).toHaveLength(4)
    // Primary NW bedside lamp casts shadows and is the strongest interior practical
    expect(resolvedRooms[0]!.castShadows).toBe(true)
    expect(resolvedRooms[0]!.power).toBeGreaterThan(resolvedRooms[1]!.power)
    expect(resolvedRooms[0]!.power).toBeGreaterThan(resolvedRooms[2]!.power)
    expect(resolvedRooms[1]!.castShadows).toBe(false)
    expect(resolvedRooms[2]!.castShadows).toBe(false)
    expect(resolvedRooms[3]!.castShadows).toBe(false)
  })

  test("packs 32-float custom uniform buffer and follows active aim outside north rest pose", () => {
    const rgb = flashlightColor(0.92)
    const restBuf = packOutbreakLightingUniforms(
      {
        settings: {
          ...DEFAULT_OUTBREAK_LIGHTING,
          flashlightIntensity: 0.48,
          flashlightRange: 19,
          flashlightCone: 56,
          flashlightWarmth: 0.92,
        },
        playerX: 30,
        playerY: 41,
        playerH: 0,
        playerAim: -Math.PI / 2,
        flashlightOutput: 1,
        flashlightSlot: 1,
        inInteriorView: false,
      },
      rgb,
    )
    const aimedBuf = packOutbreakLightingUniforms(
      {
        settings: {
          ...DEFAULT_OUTBREAK_LIGHTING,
          flashlightIntensity: 0.48,
          flashlightRange: 19,
          flashlightCone: 56,
          flashlightWarmth: 0.92,
        },
        playerX: 30,
        playerY: 41,
        playerH: 0,
        playerAim: 0,
        flashlightOutput: 1,
        flashlightSlot: 1,
        inInteriorView: false,
      },
      rgb,
    )
    expect(restBuf.length).toBe(OUTBREAK_LIGHTING_UNIFORM_FLOATS)
    // Beam follows playerAim (-PI/2 -> dirX ~ 0, dirY ~ -1; 0 -> dirX ~ 1, dirY ~ 0)
    expect(restBuf[14]).toBeCloseTo(0, 4)
    expect(restBuf[15]).toBeCloseTo(-1, 4)
    expect(aimedBuf[14]).toBeCloseTo(1, 5)
    expect(aimedBuf[15]).toBeCloseTo(0, 5)
  })
})
