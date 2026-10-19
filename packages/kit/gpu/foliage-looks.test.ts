import { describe, expect, test } from "bun:test"
import { FOLIAGE_BUILD_LIVELY, FOLIAGE_LIMB_AUX, buildFoliageTree, cloneFoliageParams } from "./foliage"
import { buildTreeLook, TREE_LOOK_OPTIONS, TREE_LOOK_SHADE } from "./foliage-looks"
import { MAT, Mesh } from "./mesh"

const params = cloneFoliageParams()
const seeds = Array.from({ length: 24 }, (_, i) => Math.floor(((i * 0.618034) % 1) * 1e6))
const build = (look: number, seed: number, x = 5, opts = FOLIAGE_BUILD_LIVELY) => {
  const m = new Mesh()
  if (look === 0) buildFoliageTree(m, x, 5, 5.4, 2.4, seed, 0.05, params, undefined, opts)
  else buildTreeLook(m, look, x, 5, 5.4, 2.4, seed, 0.05, { ...opts, treeLook: look })
  return m.v
}
const parts = (v: number[]) => {
  let leaves = 0
  let limbs = 0
  let bad = 0
  for (let i = 0; i < v.length; i += 11) {
    const mat = v[i + 9]!
    const aux = v[i + 10]!
    if (mat === MAT.foliage) {
      leaves++
      if (!(aux > 0 && aux <= 1)) bad++
    } else if (mat === MAT.timber) {
      limbs++
      if (!(aux >= FOLIAGE_LIMB_AUX && aux <= FOLIAGE_LIMB_AUX + 1)) bad++
    } else bad++
    for (let k = 0; k < 9; k++) if (!Number.isFinite(v[i + k]!)) bad++
  }
  return { leaves, limbs, bad }
}

describe("tree looks (D-41)", () => {
  test("options and shade line up: Today, A, B, C; only A and C sink outside light", () => {
    expect(TREE_LOOK_OPTIONS.map((o) => o.value)).toEqual([0, 1, 2, 3])
    expect(TREE_LOOK_SHADE[0]).toBe(0)
    expect(TREE_LOOK_SHADE[2]).toBe(0)
    expect(TREE_LOOK_SHADE[1]!).toBeGreaterThan(0)
    expect(TREE_LOOK_SHADE[3]!).toBeGreaterThan(TREE_LOOK_SHADE[1]!)
  })

  for (const look of [1, 2, 3]) {
    test(`look ${look}: deterministic per seed, varied across seeds, swaying limbs and canopy flex in range`, () => {
      expect(build(look, 4242)).toEqual(build(look, 4242))
      const shapes = new Set(seeds.map((s) => build(look, s).slice(-330).map((x) => x.toFixed(3)).join()))
      expect(shapes.size).toBe(seeds.length)
      for (const s of seeds) expect(parts(build(look, s)).bad).toBe(0)
      expect(seeds.some((s) => parts(build(look, s)).leaves > 0)).toBe(true)
    })
  }

  test("bare variants: Deadwood is often bare, every look honours the bare share", () => {
    const bare = (look: number, deadTrees: number) => seeds.filter((s) => parts(build(look, s, 5, { ...FOLIAGE_BUILD_LIVELY, deadTrees })).leaves === 0).length / seeds.length
    expect(bare(1, 0.14)).toBeGreaterThan(0.2)
    expect(bare(2, 0)).toBe(0)
    expect(bare(3, 0)).toBe(0)
    expect(bare(2, 0.5)).toBeGreaterThan(0.2)
    expect(bare(3, 0.5)).toBeGreaterThan(0.2)
  })

  test("cost stays near the lively tree: under 1.6x its vertices on average, hero and outer", () => {
    for (const x of [5, 70]) {
      const mean = (look: number) => seeds.reduce((a, s) => a + build(look, s, x).length, 0) / seeds.length
      const today = mean(0)
      for (const look of [1, 2, 3]) expect({ look, x, ratio: mean(look) / today < 1.6 }).toEqual({ look, x, ratio: true })
    }
  })
})
