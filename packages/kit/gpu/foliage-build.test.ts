import { describe, expect, test } from "bun:test"
import {
  FOLIAGE_BUILD_LIVELY,
  FOLIAGE_BUILD_TODAY,
  FOLIAGE_GUST_OFF,
  FOLIAGE_LIMB_AUX,
  FoliageGustStruct,
  buildFoliageTree,
  cloneFoliageParams,
  foliageTreeSpecies,
  foliageWindDeclarationsWgsl,
  packFoliageGust,
} from "./foliage"
import { MAT, Mesh } from "./mesh"

const params = cloneFoliageParams()
const tree = (seed: number, opts = FOLIAGE_BUILD_TODAY, h = 5.4, r = 2.4) => {
  const m = new Mesh()
  buildFoliageTree(m, 20, 30, h, r, seed, 0.05, params, undefined, opts)
  return m.v
}
const verts = (v: number[]) => {
  const out: { mat: number; aux: number }[] = []
  for (let i = 0; i < v.length; i += 11) out.push({ mat: v[i + 9]!, aux: v[i + 10]! })
  return out
}

describe("vegetation build options", () => {
  test("Today is the default build, vertex for vertex, with static limbs", () => {
    const m = new Mesh()
    buildFoliageTree(m, 20, 30, 5.4, 2.4, 123, 0.05, params)
    expect(tree(123)).toEqual(m.v)
    expect(verts(m.v).filter(v => v.mat === MAT.timber).every(v => v.aux === 0)).toBe(true)
  })

  test("Lively limbs carry flex for the wind: trunk near 0, bough tips at 1", () => {
    const limbs = verts(tree(123, FOLIAGE_BUILD_LIVELY)).filter(v => v.mat === MAT.timber)
    expect(limbs.length).toBeGreaterThan(0)
    expect(limbs.every(v => v.aux >= FOLIAGE_LIMB_AUX && v.aux <= FOLIAGE_LIMB_AUX + 1)).toBe(true)
    expect(Math.min(...limbs.map(v => v.aux))).toBe(FOLIAGE_LIMB_AUX)
    expect(Math.max(...limbs.map(v => v.aux))).toBe(FOLIAGE_LIMB_AUX + 1)
  })

  test("Lively trees are deterministic per seed and vary across seeds: species and a share of bare trees", () => {
    expect(tree(77, FOLIAGE_BUILD_LIVELY)).toEqual(tree(77, FOLIAGE_BUILD_LIVELY))
    const seeds = Array.from({ length: 200 }, (_, i) => i * 7919 + 13)
    const picks = seeds.map(s => foliageTreeSpecies(s, FOLIAGE_BUILD_LIVELY))
    const species = new Set(picks.map(p => p.species))
    expect(species).toEqual(new Set([null, "oak", "maple", "birch", "pine"]))
    const bare = picks.filter(p => p.dead).length / picks.length
    expect(bare).toBeGreaterThan(0.06)
    expect(bare).toBeLessThan(0.24)
    const deadSeed = seeds.find((_, i) => picks[i]!.dead)!
    const leaves = (v: number[]) => verts(v).filter(x => x.mat === MAT.foliage && x.aux > 0 && x.aux <= 1.45).length
    expect(leaves(tree(deadSeed, FOLIAGE_BUILD_LIVELY))).toBeLessThan(leaves(tree(deadSeed)) * 0.4)
    expect(foliageTreeSpecies(5, FOLIAGE_BUILD_TODAY)).toEqual({ species: null, dead: false })
  })

  test("tree detail scales the lively crown", () => {
    const seed = seedsWithLeaves()
    const count = (quality: number) => tree(seed, { ...FOLIAGE_BUILD_LIVELY, quality }).length
    expect(count(0)).toBeLessThan(count(1))
    expect(count(1)).toBeLessThan(count(2))
  })

  test("lively shrubs are rounder and grow stray shoots; today's shrubs are unchanged", () => {
    const bush = (opts = FOLIAGE_BUILD_TODAY) => {
      const m = new Mesh()
      buildFoliageTree(m, 4, 4, 1.3, 0.9, 99, 0, params, undefined, opts)
      return m.v
    }
    const plain = new Mesh()
    buildFoliageTree(plain, 4, 4, 1.3, 0.9, 99, 0, params)
    expect(bush()).toEqual(plain.v)
    const lively = bush(FOLIAGE_BUILD_LIVELY)
    expect(lively.length).toBeGreaterThan(plain.v.length)
    expect(bush(FOLIAGE_BUILD_LIVELY)).toEqual(lively)
  })
})

describe("the wind field", () => {
  test("packs 12 floats with a normalised direction, and Today is off", () => {
    expect(FoliageGustStruct.floatCount).toBe(12)
    const out = packFoliageGust({ ...FOLIAGE_GUST_OFF, on: 1, dirX: 3, dirZ: 4 })
    expect(out[FoliageGustStruct.offsetOf("on")]).toBe(1)
    expect(out[FoliageGustStruct.offsetOf("dirX")]).toBeCloseTo(0.6, 6)
    expect(out[FoliageGustStruct.offsetOf("dirZ")]).toBeCloseTo(0.8, 6)
    expect(FOLIAGE_GUST_OFF.on).toBe(0)
  })

  test("the shared WGSL declares the field and keeps today's wobble behind it", () => {
    expect(foliageWindDeclarationsWgsl).toContain("struct FoliageGust")
    expect(foliageWindDeclarationsWgsl).toContain("fn applyFoliageWindField(")
    expect(foliageWindDeclarationsWgsl).toMatch(/if \(g\.on < 0\.5\) \{[\s\S]*?return applyFoliageVertexWind\(/)
  })
})

function seedsWithLeaves(): number {
  for (let s = 1; s < 500; s++) {
    const p = foliageTreeSpecies(s, FOLIAGE_BUILD_LIVELY)
    if (!p.dead && (p.species === null || p.species === "oak")) return s
  }
  throw new Error("no leafy oak seed")
}
