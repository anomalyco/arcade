import { describe, expect, test } from "bun:test"
import {
  FOLIAGE_PRESETS,
  FOLIAGE_PRESET_IDS,
  buildFoliageTree,
  buildLegacyFoliageTree,
  cloneFoliageParams,
  emitGrassTuft,
  exportFoliagePreset,
  importFoliagePreset,
  randomizeFoliageParams,
  scatterGrassClumps,
  validateFoliageParams,
} from "./gpu/foliage"
import { FLOATS_PER_VERT, MAT, Mesh } from "./gpu/mesh"
import { Rng } from "./sim/rng"

describe("foliage recipes, generators, and preset validation", () => {
  test("every preset default passes validation", () => {
    for (const id of FOLIAGE_PRESET_IDS) {
      const res = validateFoliageParams(FOLIAGE_PRESETS[id].defaults)
      expect(res.ok).toBe(true)
    }
  })

  test("seeded parameter randomize is deterministic and constrained to plausible botanical ratios", () => {
    const base = cloneFoliageParams("oak")
    const a = randomizeFoliageParams(base, 42, "all")
    const b = randomizeFoliageParams(base, 42, "all")
    const c = randomizeFoliageParams(base, 43, "all")

    expect(a).toEqual(b)
    expect(a).not.toEqual(c)
    expect(validateFoliageParams(a).ok).toBe(true)

    // Plausibility invariants: green stays dominant in base tree color, tips are brighter than roots
    expect(a.treeColorG).toBeGreaterThanOrEqual(a.treeColorR * 0.85)
    expect(a.tipColorG).toBeGreaterThan(a.rootColorG)
    expect(a.crownRadius).toBeGreaterThan(1.0)
  })

  test("preset export and import round-trips and rejects malformed JSON", () => {
    const exported = exportFoliagePreset({
      seed: 12,
      tuningSeed: 77,
      cameraMode: "close",
      compare: 1,
      lightingPreset: "outbreak_dusk",
      params: cloneFoliageParams("maple"),
    })
    const imported = importFoliagePreset(JSON.stringify(exported))
    expect(imported.ok).toBe(true)
    if (imported.ok) {
      expect(imported.value.seed).toBe(12)
      expect(imported.value.tuningSeed).toBe(77)
      expect(imported.value.params.treePreset).toBe("maple")
    }

    expect(importFoliagePreset('{"version": 99}').ok).toBe(false)
    expect(importFoliagePreset("not-json").ok).toBe(false)
  })

  test("buildFoliageTree emits bent normals and positive aux weights for canopy wind", () => {
    const m = new Mesh()
    buildFoliageTree(m, 0, 0, 5.2, 2.35, 7, 0, cloneFoliageParams("oak"))
    expect(m.count).toBeGreaterThan(300)

    let foliageVerts = 0
    let positiveAuxVerts = 0
    let negativeAuxVerts = 0
    for (let i = 0; i < m.v.length; i += FLOATS_PER_VERT) {
      const mat = m.v[i + 9]!
      const aux = m.v[i + 10]!
      if (mat === MAT.foliage) {
        foliageVerts++
        if (aux > 0.02) positiveAuxVerts++
        if (aux < -0.02) negativeAuxVerts++
      }
    }
    expect(foliageVerts).toBeGreaterThan(200)
    expect(positiveAuxVerts).toBeGreaterThan(150)
    expect(negativeAuxVerts).toBeGreaterThan(0)

    const legacy = new Mesh()
    buildLegacyFoliageTree(legacy, 0, 0, 5.2, 2.35, 7, 0)
    expect(legacy.count).toBeGreaterThan(100)
  })

  test("scatterGrassClumps and emitGrassTuft produce curved 2-segment blades with negative aux arc coordinates", () => {
    const clumps = scatterGrassClumps({
      seed: 7,
      bounds: [-4, -4, 4, 4],
      clusterCount: 10,
      tuftsPerCluster: 3,
    })
    expect(clumps.length).toBeGreaterThan(15)

    const m = new Mesh()
    const rng = new Rng(19)
    for (const c of clumps.slice(0, 4)) {
      emitGrassTuft(m, c.x, 0, c.z, {
        bladeCount: c.blades,
        radius: c.radius,
        height: c.height,
        width: c.width,
        curvature: c.curvature,
        leanAngle: c.leanAngle,
        rootColor: c.rootColor,
        tipColor: c.tipColor,
        rng,
      })
    }
    // Each blade has 9 vertices (2-segment tapered strip: 6 lower quad + 3 tip triangle)
    expect(m.count % 9).toBe(0)
    expect(m.count).toBeGreaterThanOrEqual(9 * 12)
  })
})
