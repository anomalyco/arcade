import { describe, expect, test } from "bun:test"
import { VERT_BYTES } from "@arcade/kit/gpu/mesh"
import { validateMaterialParams } from "@arcade/kit/gpu/surface-materials"
import {
  buildVignetteLevel,
  kelvinToRgb,
  makeVignetteTown,
  VIGNETTE_CAMERA_PRESETS,
  VIGNETTE_DIRECTION_ORDER,
  VIGNETTE_DIRECTIONS,
  VIGNETTE_SURFACE_IDS,
  VIGNETTE_SURFACES,
} from "../src/vignette"
import { makeTown } from "../shared/map"
import { buildLevel } from "../src/level"

describe("Outbreak vignette scene, presets, and material recipes", () => {
  test("priority order starts with Direction 3 (Noir) first and Direction 2 (Painterly) second, mapped to shared LookPresetIds", () => {
    expect(VIGNETTE_DIRECTION_ORDER[0]).toBe(3)
    expect(VIGNETTE_DIRECTION_ORDER[1]).toBe(2)
    expect(VIGNETTE_DIRECTIONS[3].slug).toBe("noir")
    expect(VIGNETTE_DIRECTIONS[3].lookPreset).toBe("noir")
    expect(VIGNETTE_DIRECTIONS[3].values.flashlightOn).toBe(true)
    expect(VIGNETTE_DIRECTIONS[3].values.flashlightIntensity).toBeGreaterThan(1)
    expect(VIGNETTE_DIRECTIONS[2].slug).toBe("painterly")
    expect(VIGNETTE_DIRECTIONS[2].lookPreset).toBe("painterly")
    expect(VIGNETTE_DIRECTIONS[2].values.diffuseWrap).toBeGreaterThan(0.5)
    expect(VIGNETTE_DIRECTIONS[1].lookPreset).toBe("cinematic_dusk")
    expect(VIGNETTE_DIRECTIONS[5].lookPreset).toBe("sodium_70s")
    expect(VIGNETTE_DIRECTIONS[5].values.streetLampTemp).toBeLessThan(2200)
    expect(VIGNETTE_DIRECTIONS[5].values.windowLightTemp).toBeGreaterThan(2600)
    expect(VIGNETTE_DIRECTIONS[4].lookPreset).toBe("cozy_golden_hour")
    expect(VIGNETTE_DIRECTIONS[4].values.overgrowth).toBeGreaterThan(0.5)
    expect(VIGNETTE_DIRECTIONS[0].lookPreset).toBe("current")
  })

  test("all 7 vignette surface defaults and direction overrides pass shared surface-materials validation", () => {
    expect(VIGNETTE_SURFACE_IDS).toEqual([
      "wood_floor",
      "plaster",
      "siding",
      "shingles",
      "asphalt",
      "concrete",
      "grass",
    ])
    for (const surfaceId of VIGNETTE_SURFACE_IDS) {
      const def = VIGNETTE_SURFACES[surfaceId].defaults
      const valid = validateMaterialParams(def)
      expect(valid.ok).toBe(true)
      for (const dirId of VIGNETTE_DIRECTION_ORDER) {
        const merged = { ...def, ...(VIGNETTE_DIRECTIONS[dirId].surfaces[surfaceId] ?? {}) }
        expect(validateMaterialParams(merged).ok).toBe(true)
      }
    }
  })

  test("single-lot vignette builds one house, one streetlamp, configurable tree slot, and scales interior clutter", () => {
    const sparse = makeVignetteTown({ clutterDensity: 0.2, treeSlot: 0 })
    const standard = makeVignetteTown({ clutterDensity: 1.0, treeSlot: 1 })
    const dense = makeVignetteTown({ clutterDensity: 1.4, treeSlot: 2 })

    expect(standard.buildings).toHaveLength(1)
    expect(standard.buildings[0]!.id).toBe("ash")
    expect(standard.lamps.filter(l => l.kind === "street")).toHaveLength(1)
    expect(standard.lamps.filter(l => l.kind === "porch")).toHaveLength(1)
    expect(sparse.props.filter(p => p.kind === "tree")).toHaveLength(0)
    expect(standard.props.filter(p => p.kind === "tree").length).toBeGreaterThanOrEqual(1)
    expect(dense.props.filter(p => p.kind === "tree").length).toBeGreaterThanOrEqual(1)
    expect(standard.props.length).toBeGreaterThan(sparse.props.length)
    expect(dense.props.length).toBeGreaterThan(standard.props.length)

    const fullLevel = buildLevel(makeTown(7))
    const fullVerts = [...fullLevel.chunks, ...fullLevel.glass].reduce((n, c) => n + c.data.byteLength / VERT_BYTES, 0)
    const vigLevel = buildVignetteLevel(standard)
    const vigVerts = [...vigLevel.chunks, ...vigLevel.glass].reduce((n, c) => n + c.data.byteLength / VERT_BYTES, 0)
    expect(vigVerts).toBeGreaterThan(4000)
    expect(vigVerts).toBeLessThan(fullVerts * 0.65)
  })

  test("kelvinToRgb separates 2050K sodium streetlamp, 2850K tungsten interior, and 5200K flashlight", () => {
    const sodium = kelvinToRgb(2050)
    const tungsten = kelvinToRgb(2850)
    const flashlight = kelvinToRgb(5200)
    expect(sodium[2]).toBeLessThan(tungsten[2])
    expect(tungsten[2]).toBeLessThan(flashlight[2])
    expect(VIGNETTE_CAMERA_PRESETS.game.cutawayMode).toBe(1)
    expect(VIGNETTE_CAMERA_PRESETS.interior.dist).toBeLessThan(VIGNETTE_CAMERA_PRESETS.game.dist)
  })
})
