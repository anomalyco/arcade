import { expect, test } from "bun:test"
import { demoForestWorld } from "../sim/forest-demo"
import { loadForestModels } from "./assets"
import { buildForest, forestHeightGrid, gridHeight, intSeed, TREE_SINK, treePlacement, treeVariant, trunkRings } from "./build"
import { mulberry } from "../sim/forest-demo"
import { readVertex } from "./mesh"
import { drawnGround, drawnTrunk } from "./trunk"

const root = new URL("./assets/", import.meta.url).pathname
async function models() {
  const fetch0 = globalThis.fetch
  globalThis.fetch = (async (url: string) => new Response(Bun.file(url))) as unknown as typeof fetch
  try { return await loadForestModels(root) } finally { globalThis.fetch = fetch0 }
}

const segDist = (p: readonly number[], a: readonly number[], b: readonly number[]) => {
  const dx = b[0]! - a[0]!, dz = b[1]! - a[1]!, k = Math.max(0, Math.min(1, ((p[0]! - a[0]!) * dx + (p[1]! - a[1]!) * dz) / (dx * dx + dz * dz || 1)))
  return Math.hypot(p[0]! - a[0]! - dx * k, p[1]! - a[1]! - dz * k)
}

for (const smooth of [false, true]) test(`drawnTrunk().section is the plane's cut through the trunk the build draws, near and far${smooth ? ", smooth trunks" : ""}`, async () => {
  const world = demoForestWorld(11, 60)
  const build = buildForest(world, await models(), { scatter: 1, fernDensity: 1, litter: 1, smoothTrunks: smooth })
  const H = gridHeight(forestHeightGrid(world), world.height)
  let checked = 0
  for (const tree of world.trees.filter((t) => t.h > 8).slice(0, 12)) {
    const t = { ...tree, seed: intSeed(tree.seed) }
    const p = treePlacement(t)
    const name = `${t.species}-${p.variant}`
    const tpl = build.templates.find((x) => x.name === name)!
    expect(drawnGround(world.height, t.x + 0.3, t.z - 0.7)).toBeCloseTo(H(t.x + 0.3, t.z - 0.7), 5)
    const drawn = drawnTrunk(world.seed, world.height, tree, smooth)
    expect(drawn.base).toBeCloseTo(H(t.x, t.z) - TREE_SINK, 5)
    for (const near of [true, false]) {
      // The trunk is the first rings × sides quads `tree` writes into the opaque mesh.
      const mesh = new DataView((near ? tpl.near : tpl.far!).opaque)
      const variant = treeVariant(world.seed, t.species, p.variant)
      const shape = trunkRings(variant, 0, near, mulberry(variant.seed), near && smooth)
      const verts = shape.rings * shape.sides * 6
      const base = H(t.x, t.z) - TREE_SINK, c = Math.cos(p.yaw), s = Math.sin(p.yaw)
      const toWorld = (q: readonly number[]) => {
        const x = q[0]! * p.trunkScale, z = q[2]! * p.trunkScale
        return [x * c - z * s + t.x, q[1]! * p.heightScale + base, x * s + z * c + t.z]
      }
      for (const y of [0.9, 1.4, 1.43, 2.1]) {
        const wy = base + TREE_SINK + y
        const poly = drawn.section(wy, near)
        // Every triangle edge crossing the plane must land on the section polygon.
        for (let i = 0; i < verts; i += 3) {
          const tri = [0, 1, 2].map((k) => toWorld(readVertex(mesh, i + k).p))
          for (const [a, b] of [[tri[0]!, tri[1]!], [tri[1]!, tri[2]!], [tri[2]!, tri[0]!]] as const) {
            if ((a[1]! - wy) * (b[1]! - wy) >= 0) continue
            const f = (wy - a[1]!) / (b[1]! - a[1]!)
            const q = [a[0]! + (b[0]! - a[0]!) * f, a[2]! + (b[2]! - a[2]!) * f]
            const d = Math.min(...poly.map((e, k) => segDist(q, e, poly[(k + 1) % poly.length]!)))
            expect(d).toBeLessThan(2e-4)
            checked++
          }
        }
      }
    }
  }
  expect(checked).toBeGreaterThan(500)
}, 30_000)
