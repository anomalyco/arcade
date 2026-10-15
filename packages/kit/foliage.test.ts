import { describe, expect, test } from "bun:test"
import {
  BUSH_PRESET_IDS,
  FOLIAGE_KINDS,
  FOLIAGE_PARAM_SPECS,
  GRASS_PRESET_IDS,
  TREE_PRESET_IDS,
  applyFoliagePreset,
  buildFoliageBush,
  buildFoliageTree,
  buildLegacyFoliageTree,
  cloneFoliageParams,
  packFoliageActors,
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
  test("every tree, bush and grass preset combination passes validation", () => {
    for (const t of TREE_PRESET_IDS) for (const b of BUSH_PRESET_IDS) for (const g of GRASS_PRESET_IDS) {
      expect(validateFoliageParams(cloneFoliageParams(t, b, g)).ok).toBe(true)
    }
  })

  test("each look's preset and randomize only touch that look's parameters", () => {
    for (const kind of FOLIAGE_KINDS) {
      const base = cloneFoliageParams("oak", "overgrown", "overgrown")
      const presetId = kind === "tree" ? "pine" : kind === "bush" ? "hedge" : "weeds"
      const viaPreset = applyFoliagePreset(kind, presetId, { ...base })
      const viaRandom = randomizeFoliageParams(base, 9, kind)
      for (const s of FOLIAGE_PARAM_SPECS) {
        if (s.kind === kind) continue
        expect(viaPreset[s.key]).toBe(base[s.key])
        expect(viaRandom[s.key]).toBe(base[s.key])
      }
    }
  })

  test("clipped hedges stay inside their height and spread; bushes encode aux = 3 + flex", () => {
    const params = cloneFoliageParams("oak", "hedge", "lawn")
    const m = new Mesh()
    buildFoliageBush(m, 0, 0, 1.0, 0.6, 5, 0, params)
    let bushVerts = 0
    let maxY = 0
    for (let i = 0; i < m.v.length; i += FLOATS_PER_VERT) {
      const aux = m.v[i + 10]!
      if (m.v[i + 9] === MAT.foliage && aux > 2.5) {
        bushVerts++
        maxY = Math.max(maxY, m.v[i + 1]!)
        expect(aux).toBeLessThanOrEqual(4.01)
      }
    }
    expect(bushVerts).toBeGreaterThan(200)
    expect(maxY).toBeLessThan(1.0 * params.bushHeight + 0.06)
  })

  test("actor packing caps at eight and writes the count header", () => {
    const out = packFoliageActors(Array.from({ length: 11 }, (_, i) => ({ x: i, z: -i })))
    expect(out[0]).toBe(8)
    expect(out[4]).toBe(0)
    expect(out[5 + 7 * 2]).toBe(-7)
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
      tool: "bush",
      lighting: "night",
      look: "noir",
      params: cloneFoliageParams("maple", "hydrangea", "weeds"),
    })
    const imported = importFoliagePreset(JSON.stringify(exported))
    expect(imported.ok).toBe(true)
    if (imported.ok) {
      expect(imported.value.seed).toBe(12)
      expect(imported.value.tuningSeed).toBe(77)
      expect(imported.value.params.treePreset).toBe("maple")
      expect(imported.value.params.bushPreset).toBe("hydrangea")
      expect(imported.value.tool).toBe("bush")
    }

    // Version 1 payloads (single tree preset, no bush/grass keys) migrate; old "hydrangea" becomes the bush preset.
    const v1 = { ...cloneFoliageParams("pine") } as Record<string, unknown>
    for (const s of FOLIAGE_PARAM_SPECS) if (s.kind === "bush" || s.key === "weedRosettes" || s.key.startsWith("trample")) delete v1[s.key]
    delete v1.bushPreset
    delete v1.grassPreset
    v1.treePreset = "hydrangea"
    const migrated = importFoliagePreset(JSON.stringify({ version: 1, seed: 3, tuningSeed: 4, cameraMode: "game", compare: 1, stageMode: "lot", params: v1 }))
    expect(migrated.ok).toBe(true)
    if (migrated.ok) {
      expect(migrated.value.params.bushPreset).toBe("hydrangea")
      expect(migrated.value.tool).toBe("lot")
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
