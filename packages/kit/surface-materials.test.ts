import { describe, expect, test } from "bun:test"
import {
  MATERIAL_PARAM_SPECS,
  MATERIAL_RECIPES,
  MATERIAL_RECIPE_IDS,
  cloneMaterialParams,
  evaluateCobblestoneSample,
  evaluateWoodPlankSample,
  exportMaterialPreset,
  importMaterialPreset,
  packMaterialParams,
  randomizeMaterialParams,
  scatterClusteredGroundCover,
  validateMaterialParams,
} from "./gpu/surface-materials"

describe("shared procedural material recipes", () => {
  test("every recipe default passes validation and wood planks default to matte without specular sheen", () => {
    for (const id of MATERIAL_RECIPE_IDS) {
      const def = MATERIAL_RECIPES[id]
      const res = validateMaterialParams(def.defaults)
      expect(res.ok).toBe(true)
      if (res.ok) {
        expect(res.value).toEqual(def.defaults)
      }
      const packed = packMaterialParams(def.defaults)
      expect(packed).toHaveLength(12)
      expect(packed.every(Number.isFinite)).toBe(true)
    }

    const wood = MATERIAL_RECIPES.wood_planks.defaults
    expect(wood.roughness).toBeGreaterThanOrEqual(0.75)
    expect(wood.roughness).toBeLessThanOrEqual(0.9)
    expect(evaluateWoodPlankSample(1.2, 0.4, wood).specularStrength).toBe(0)
    expect(evaluateWoodPlankSample(1.2, 0.4, { ...wood, roughness: 0.35 }).specularStrength).toBeGreaterThan(0.05)
  })

  test("staggered wood planks vary butt-joint positions across rows and shift per-board warm/cool tint", () => {
    const row0 = evaluateWoodPlankSample(2.1, 0.08)
    const row1 = evaluateWoodPlankSample(2.1, 0.25)
    const row2 = evaluateWoodPlankSample(2.1, 0.42)
    expect(row0.row).not.toBe(row1.row)
    expect(row1.row).not.toBe(row2.row)
    // Butt joints are staggered between adjacent rows rather than aligned on a vertical grid.
    expect(Math.abs(row0.buttDist - row1.buttDist)).toBeGreaterThan(0.05)
    expect(row0.tint).not.toEqual(row1.tint)
  })

  test("irregular Voronoi cobblestone varies stone scale and rounds worn corners compared to gridded pavers", () => {
    const irregular = MATERIAL_RECIPES.cobblestone.defaults
    const gridded = { ...irregular, irregularity: 0, wear: 0 }
    const scales = new Set<number>()
    let jointSamples = 0
    let wornReduced = 0
    for (let i = 0; i < 40; i++) {
      const x = i * 0.19 + 0.07
      const z = (i % 7) * 0.23 + 0.11
      const s = evaluateCobblestoneSample(x, z, irregular)
      scales.add(Number(s.stoneScale.toFixed(3)))
      if (s.inJoint) jointSamples++
      if (s.wornEdge < s.edgeDist) wornReduced++
      const g = evaluateCobblestoneSample(x, z, gridded)
      expect(g.stoneScale).toBeCloseTo(1, 6)
    }
    expect(scales.size).toBeGreaterThan(6)
    expect(jointSamples).toBeGreaterThan(0)
    expect(wornReduced).toBeGreaterThan(10)
  })

  test("seeded recipe randomization is deterministic, respects step/range bounds, and leaves other seeds alone", () => {
    for (const id of MATERIAL_RECIPE_IDS) {
      const a = randomizeMaterialParams(id, 137)
      const b = randomizeMaterialParams(id, 137)
      const c = randomizeMaterialParams(id, 138)
      expect(a).toEqual(b)
      expect(c).not.toEqual(a)
      const valid = validateMaterialParams(a)
      expect(valid.ok).toBe(true)
      for (const spec of MATERIAL_PARAM_SPECS) {
        expect(a[spec.key]).toBeGreaterThanOrEqual(spec.min)
        expect(a[spec.key]).toBeLessThanOrEqual(spec.max)
      }
    }
    for (let seed = 1; seed <= 25; seed++) {
      const wood = randomizeMaterialParams("wood_planks", seed)
      expect(wood.roughness).toBeGreaterThanOrEqual(0.65)
    }
  })

  test("versioned preset export/import validates schema, ranges, and rejects malformed inputs cleanly", () => {
    const params = cloneMaterialParams("cobblestone")
    params.irregularity = 0.88
    const exported = exportMaterialPreset({
      recipe: "cobblestone",
      swatch: "ball",
      compare: 2,
      tuningSeed: 99,
      roomSeed: 12,
      params,
    })
    const imported = importMaterialPreset(JSON.stringify(exported))
    expect(imported.ok).toBe(true)
    if (imported.ok) {
      expect(imported.value).toEqual(exported)
    }

    expect(importMaterialPreset("{bad json").ok).toBe(false)
    expect(importMaterialPreset(JSON.stringify({ ...exported, version: 2 })).ok).toBe(false)
    expect(importMaterialPreset(JSON.stringify({ ...exported, recipe: "unknown" })).ok).toBe(false)
    expect(importMaterialPreset(JSON.stringify({ ...exported, swatch: "cube" })).ok).toBe(false)
    expect(importMaterialPreset(JSON.stringify({ ...exported, compare: 9 })).ok).toBe(false)
    expect(
      importMaterialPreset(
        JSON.stringify({ ...exported, params: { ...params, roughness: 2.5 } }),
      ).ok,
    ).toBe(false)
  })

  test("clustered ground-cover scatter is deterministic and respects exclusion predicates", () => {
    const avoid = (x: number, z: number) => x > 4 && x < 6 && z > 4 && z < 6
    const a = scatterClusteredGroundCover({
      seed: 7,
      bounds: [0, 0, 10, 10],
      clusterCount: 12,
      tuftsPerCluster: 5,
      avoid,
    })
    const b = scatterClusteredGroundCover({
      seed: 7,
      bounds: [0, 0, 10, 10],
      clusterCount: 12,
      tuftsPerCluster: 5,
      avoid,
    })
    expect(a).toEqual(b)
    expect(a.length).toBeGreaterThan(20)
    for (const tuft of a) {
      expect(avoid(tuft.x, tuft.z)).toBe(false)
      expect(tuft.x).toBeGreaterThanOrEqual(0)
      expect(tuft.x).toBeLessThanOrEqual(10)
    }
  })
})
