import { describe, expect, test } from "bun:test"
import { flashlightColor } from "../shared/flashlight"
import { makeTown } from "../shared/map"
import {
  bakeOutbreakBounce,
  bakeOutbreakMoonMask,
  DEFAULT_FLASHLIGHT_BEAM,
  DEFAULT_OUTBREAK_LIGHTING,
  flashlightBeamControls,
  OUTBREAK_LIGHTING_UNIFORM_FLOATS,
  OUTBREAK_NOIR_UNIFORM_OFFSET,
  outbreakLightingControls,
  packOutbreakLightingUniforms,
  resolveLampLight,
  stampOutbreakVertexTone,
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

  test("every flashlight beam setting has a Lab control with a unit and an in-range default", () => {
    expect(flashlightBeamControls.map((c) => String(c.key)).sort()).toEqual(Object.keys(DEFAULT_FLASHLIGHT_BEAM).sort())
    for (const control of flashlightBeamControls) {
      if ("options" in control) continue
      expect("unit" in control && typeof control.unit === "string").toBe(true)
      if ("min" in control && "max" in control) {
        const def = DEFAULT_FLASHLIGHT_BEAM[control.key as keyof typeof DEFAULT_FLASHLIGHT_BEAM]
        expect(def).toBeGreaterThanOrEqual(control.min)
        expect(def).toBeLessThanOrEqual(control.max)
      }
    }
  })

  test("packs the physical beam: full range, outer cone, downward tilt toward the pool and snapped field blends", () => {
    const settings = { ...DEFAULT_OUTBREAK_LIGHTING, flashlightIntensity: 0.48, flashlightRange: 19, flashlightCone: 56, flashlightWarmth: 0.92 }
    const base = {
      settings,
      playerX: 30,
      playerY: 41,
      playerH: 0,
      playerAim: 0,
      flashlightOutput: 1,
      flashlightSlot: 1,
      flashlightHeight: 1.34,
      inInteriorView: true,
      streetHead: [36.86, 6.18, 47.49] as const,
      zombies: [-999, -999, -999, -999] as const,
    }
    const N = OUTBREAK_NOIR_UNIFORM_OFFSET
    const buf = packOutbreakLightingUniforms({ ...base, frameDt: 1 / 60 }, flashlightColor(0.92))
    // Range is no longer clamped to a few metres indoors; the window in the shader ends it smoothly.
    expect(buf[17]).toBe(19)
    expect(buf[N + 1]).toBeCloseTo(Math.cos((28 * Math.PI) / 180), 5)
    // Axis points down so it meets the ground at the pool distance.
    const tilt = Math.atan2(buf[N + 8]! * -1, buf[N + 9]!)
    expect(Math.tan(tilt) * DEFAULT_FLASHLIGHT_BEAM.beamPoolDistance).toBeCloseTo(1.34, 4)
    expect(buf[N + 18]).toBeGreaterThan(0)
    expect(buf[N + 18]).toBeLessThan(1)
    const snapped = packOutbreakLightingUniforms({ ...base, frameDt: 0 }, flashlightColor(0.92))
    expect(snapped[N + 18]).toBe(1)
    expect(snapped[N + 19]).toBe(1)
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

    const resolvedRooms = rooms.map((l) => resolveLampLight(l, town.buildings, 1, DEFAULT_OUTBREAK_LIGHTING, false))
    expect(resolvedRooms).toHaveLength(4)
    // Primary NW bedside lamp casts shadows and is the strongest interior practical
    expect(resolvedRooms[0]!.castShadows).toBe(true)
    expect(resolvedRooms[0]!.power).toBeGreaterThan(resolvedRooms[1]!.power)
    expect(resolvedRooms[0]!.power).toBeGreaterThan(resolvedRooms[2]!.power)
    expect(resolvedRooms[1]!.castShadows).toBe(false)
    expect(resolvedRooms[2]!.castShadows).toBe(false)
    expect(resolvedRooms[3]!.castShadows).toBe(false)
  })

  test("packs 40-float custom uniform buffer and follows active aim outside north rest pose", () => {
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
        streetHead: [36.86, 6.18, 47.49],
        zombies: [-999, -999, -999, -999],
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
        streetHead: [36.86, 6.18, 47.49],
        zombies: [-999, -999, -999, -999],
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

  test("bakes 192x192 Dijkstra bounceTex, 768x768 soft moonTex, and per-vertex aOpenTone in byte 19", () => {
    const town = makeTown(7)
    const bounce = bakeOutbreakBounce(town)
    expect(bounce.w).toBe(192)
    expect(bounce.h).toBe(192)
    expect(bounce.data.byteLength).toBe(192 * 192 * 4)
    // Non-zero warm indirect bounce inside Ash House NW bedroom (x=25, z=25.5 -> cell (50, 51))
    const nwIdx = (51 * 192 + 50) * 4
    expect(bounce.data[nwIdx]!).toBeGreaterThan(20)
    expect(bounce.data[nwIdx]!).toBeGreaterThan(bounce.data[nwIdx + 2]!)
    expect(bounce.data[nwIdx + 3]).toBe(255)

    const moon = bakeOutbreakMoonMask(town)
    expect(moon.w).toBe(768)
    expect(moon.h).toBe(768)
    expect(moon.data.byteLength).toBe(768 * 768)
    // Open road cell (44, 44 -> (352, 352)) is unoccluded (255); deep interior is sheltered (< 40)
    expect(moon.data[352 * 768 + 352]).toBe(255)
    expect(moon.data[220 * 768 + 220]!).toBeLessThan(40)

    const buf = new ArrayBuffer(48)
    const f32 = new Float32Array(buf)
    const i8 = new Int8Array(buf)
    const u8 = new Uint8Array(buf)
    // Vertex 0: wall base y=0.10, ny=0 -> contact darkened (< 128)
    f32[1] = 0.1
    i8[12] = 127
    i8[13] = 0
    u8[19] = 255
    // Vertex 1: bevel face y=0.65, ny=0.707 -> bevel boosted (> 128)
    f32[6 + 1] = 0.65
    i8[24 + 13] = 90
    u8[24 + 19] = 255
    stampOutbreakVertexTone(buf)
    expect(u8[19]!).toBeLessThan(128)
    expect(u8[24 + 19]!).toBeGreaterThan(128)
  })
})
