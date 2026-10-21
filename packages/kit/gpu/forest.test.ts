import { describe, expect, test } from "bun:test"
import { FOREST_PRESETS, ForestGrid, forestBands, forestFade, forestLists, forestThin, type ForestModel, type ForestTrees } from "./forest"

const empty = new ArrayBuffer(0)
const model = (sapling = false): ForestModel => ({ lods: [{ trunk: empty, foliage: empty }, { trunk: empty, foliage: empty }], impostor: { w: 6, h: 20 }, colour: [1, 1, 1], sapling })

function trees(n: number): ForestTrees {
  const t: ForestTrees = { count: n, x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n), scale: new Float32Array(n).fill(1),
    yaw: new Float32Array(n), tint: new Float32Array(n).fill(1), seed: new Float32Array(n), variant: new Uint8Array(n) }
  let h = 12345
  const rnd = () => (h = (Math.imul(h, 1103515245) + 12345) >>> 0) / 2 ** 32
  for (let i = 0; i < n; i++) { t.x[i] = (rnd() - 0.5) * 600; t.z[i] = (rnd() - 0.5) * 600; t.seed[i] = rnd(); t.variant[i] = i % 3 }
  return t
}

describe("forest thinning", () => {
  const s = FOREST_PRESETS.massed
  test("near crowns are all kept at their size", () => {
    for (let i = 0; i < 100; i++) expect(forestThin(80, i / 100, s)).toEqual({ keep: true, grow: 1 })
  })
  test("far end removes the configured share and the survivors keep the canopy's coverage", () => {
    const flat = { ...s, crown: 1 }
    let kept = 0
    for (let i = 0; i < 10000; i++) kept += Number(forestThin(s.thinEnd + 10, (i + 0.5) / 10000, flat).keep)
    const { grow } = forestThin(s.thinEnd + 10, 0.5, flat)
    expect(kept / 10000).toBeCloseTo(1 - s.thinFraction, 1)
    expect((kept / 10000) * grow * grow).toBeCloseTo(1, 1)
    expect(forestThin(s.thinEnd + 10, 0.5, s).grow).toBeCloseTo(grow * s.crown, 5)
  })
  test("Today never thins", () => {
    for (let i = 0; i < 100; i++) expect(forestThin(900, i / 100, FOREST_PRESETS.today)).toEqual({ keep: true, grow: 1 })
  })
})

describe("forest cross-fades", () => {
  test("neighbouring levels are exact complements across every band", () => {
    const b = forestBands(FOREST_PRESETS.massed)
    for (let d = 0; d < 140; d += 0.37) {
      const outgoing = forestFade(d, -1e9, b.near, b.fade).fadeOut
      const incoming = forestFade(d, b.near, b.mid, b.fade).fadeIn
      expect(incoming).toBeCloseTo(outgoing, 6)
    }
  })
  test("zero width switches in one step at the band edge", () => {
    const b = forestBands(FOREST_PRESETS.today)
    expect(forestFade(b.near - 0.01, b.near, b.mid, b.fade).fadeIn).toBe(0)
    expect(forestFade(b.near + 0.01, b.near, b.mid, b.fade).fadeIn).toBe(1)
  })
})

describe("forest lists", () => {
  const t = trees(4000), grid = new ForestGrid(t), models = [model(), model(), model(true)]
  const eye = [10, 1.8, -20], s = FOREST_PRESETS.massed, b = forestBands(s)
  const lists = forestLists(grid, models, eye, s)
  const ids = (data: Float32Array) => {
    const out = new Set<string>()
    for (let i = 0; i < data.length; i += 8) out.add(`${data[i]},${data[i + 2]}`)
    return out
  }
  const near = ids(lists.near), mid = ids(lists.mid)
  test("every tree inside a level's visible range is in that level's list", () => {
    for (let k = 0; k < t.count; k++) {
      const d = Math.hypot(t.x[k]! - eye[0]!, t.z[k]! - eye[2]!), id = `${t.x[k]},${t.z[k]}`
      if (d <= b.near + b.fade) expect(near.has(id)).toBe(true)
      if (d >= b.near && d <= b.mid + b.fade) expect(mid.has(id)).toBe(t.variant[k] !== 2)
    }
  })
  test("saplings get no mid-detail instances", () => {
    expect(lists.midCounts[2]).toBe(0)
  })
  test("lists run roughly nearest first", () => {
    const first = Math.hypot(lists.near[0]! - eye[0]!, lists.near[2]! - eye[2]!)
    const n = lists.nearCounts[0]!, lastAt = (n - 1) * 8
    expect(first).toBeLessThan(Math.hypot(lists.near[lastAt]! - eye[0]!, lists.near[lastAt + 2]! - eye[2]!))
  })
})
