import { expect, test } from "bun:test"
import { loadForestModels } from "./assets"
import { buildForest, treePlacement, intSeed, TREE_SINK } from "./build"
import { poseKey, poseLog, splitTree } from "./posed"
import type { ForestWorld } from "../sim/forest-world"

const root = new URL("./assets/", import.meta.url).pathname
async function models() {
  const fetch0 = globalThis.fetch
  globalThis.fetch = (async (url: string) => new Response(Bun.file(url))) as unknown as typeof fetch
  try { return await loadForestModels(root) } finally { globalThis.fetch = fetch0 }
}

const ys = (buf: ArrayBuffer) => { const f = new Float32Array(buf), out: number[] = []; for (let i = 1; i < f.length; i += 8) out.push(f[i]!); return out }

test("a cut tree splits into a stump below the cut and a log above it, keeping every triangle, and lies along its fall", async () => {
  const tree = { x: 3.25, z: -4.5, species: "spruce" as const, r: 0.25, h: 18, seed: 12345 }
  const world: ForestWorld = { seed: 3, half: 12, height: () => 0, trees: [tree], rocks: [], logs: [] }
  const build = buildForest(world, await models(), { scatter: 0, fernDensity: 0, litter: 0 })
  const variant = treePlacement({ ...tree, seed: intSeed(tree.seed) }).variant
  const template = build.templates.find(t => t.name === `spruce-${variant}`)!
  const cut = 0.55
  const split = splitTree(tree, template, 0, cut)
  const tris = (b: ArrayBuffer) => b.byteLength / 96
  // Clipping keeps every triangle and adds at most two per one the cut crosses.
  expect(tris(split.stump.opaque) + tris(split.log.opaque)).toBeGreaterThanOrEqual(tris(template.near.opaque))
  expect(tris(split.stump.opaque) + tris(split.log.opaque)).toBeLessThan(tris(template.near.opaque) * 1.2)
  expect(tris(split.stump.masked) + tris(split.log.masked)).toBeGreaterThanOrEqual(tris(template.near.masked))
  expect(tris(split.stump.opaque)).toBeGreaterThan(0)
  // The stump's bark reaches the cut, and the fresh face is about the trunk's size there (a little root flare).
  expect(Math.max(...ys(split.stump.opaque))).toBeGreaterThan(cut - 1e-3)
  expect(split.cutRadius).toBeGreaterThan(tree.r * 0.8)
  expect(split.cutRadius).toBeLessThan(tree.r * 2)
  // Stump in world space, at or under the cut; the log in placed space, at or over it.
  expect(Math.max(...ys(split.stump.opaque))).toBeLessThanOrEqual(cut + 1e-4)
  expect(Math.min(...ys(split.log.opaque))).toBeGreaterThanOrEqual(cut + TREE_SINK - 1e-4)
  expect(split.height).toBeCloseTo(18, 3)

  // Upright pose: the log goes back where it stood (its base offset only).
  const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
  const out = new ArrayBuffer(split.log.opaque.byteLength)
  poseLog(split.log.opaque, out, split, { tree: 0, cut, dir: [1, 0], angle: 0 }, world.height, box)
  expect(box[4]!).toBeGreaterThan(15)
  expect(Math.abs((box[0]! + box[3]!) / 2 - tree.x)).toBeLessThan(1.5)

  // Felled towards +x and lying: long along x, low, the tip past the stump by about the tree's height.
  const lying = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
  poseLog(split.log.opaque, out, split, { tree: 0, cut, dir: [1, 0], angle: Math.PI / 2, ground: 0.02 }, world.height, lying)
  expect(lying[3]! - tree.x).toBeGreaterThan(14)
  expect(lying[0]!).toBeGreaterThan(tree.x - 1.5)
  expect(lying[4]!).toBeLessThan(5)
  expect(lying[1]!).toBeGreaterThanOrEqual(0.02 - 1e-4)
  expect(Math.abs((lying[2]! + lying[5]!) / 2 - tree.z)).toBeLessThan(2)

  expect(poseKey({ tree: 0, cut, dir: [1, 0], angle: 1.23456 })).toBe(poseKey({ tree: 0, cut, dir: [1, 0], angle: 1.23458 }))
}, 30_000)
