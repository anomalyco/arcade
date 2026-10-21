import { describe, expect, test } from "bun:test"
import { FOREST_PRESETS, ForestGrid, forestBands, forestLists, type ForestModel, type ForestTrees } from "./forest"

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
