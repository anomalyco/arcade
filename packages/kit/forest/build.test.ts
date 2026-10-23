import { expect, test } from "bun:test"
import { demoForestWorld } from "../sim/forest-demo"
import { loadForestModels } from "./assets"
import { buildForest, clampedGridHeight, forestHeightGrid, type ForestBuild } from "./build"
import { buildTransfers } from "./build-worker"
import { toHalf } from "./mesh"

const root = new URL("./assets/", import.meta.url).pathname
async function models() {
  const fetch0 = globalThis.fetch
  globalThis.fetch = (async (url: string) => new Response(Bun.file(url))) as unknown as typeof fetch
  try { return await loadForestModels(root) } finally { globalThis.fetch = fetch0 }
}

test("the build worker's world (the height grid, no height function) builds byte for byte the page's forest", async () => {
  const world = demoForestWorld(7, 60)
  const m = await models()
  const opts = { scatter: 1, fernDensity: 1, litter: 1, campDetail: true }
  const page = buildForest(world, m, opts)
  const ground = forestHeightGrid(world)
  const { height: _height, ...data } = world
  const worker = buildForest({ ...structuredClone(data), height: clampedGridHeight(ground) }, m, opts, structuredClone(ground))
  const bytes = (b: ForestBuild) => buildTransfers(b).map((x) => Buffer.from(x).toString("base64"))
  expect(bytes(worker)).toEqual(bytes(page))
  expect(worker.stats).toEqual(page.stats)
  expect(worker.logs).toEqual(page.logs)
  expect(worker.campLights).toEqual(page.campLights)
}, 30_000)

test("each chunk's cull box holds all of its static geometry, the dock and buildings that run past the cell included", async () => {
  const world = demoForestWorld(7, 20)
  const build = buildForest(world, await models(), { scatter: 0, fernDensity: 0, litter: 0, campDetail: true })
  const outside: string[] = []
  for (const c of build.chunks) for (const mesh of [c.near.opaque, c.near.masked, c.far.opaque, c.far.masked]) {
    const data = new DataView(mesh)
    for (let o = 0; o < data.byteLength; o += 32) {
      const p = [0, 4, 8].map(k => data.getFloat32(o + k, true))
      if (p.some((v, i) => v < c.box[i]! - 1e-3 || v > c.box[i + 3]! + 1e-3)) { outside.push(`${c.key}: ${p.map(v => v.toFixed(1))}`); break }
    }
  }
  expect(outside).toEqual([])
}, 30_000)

test("smooth trunk rings share normals across adjacent bands and the UV seam", async () => {
  const world = demoForestWorld(7, 20)
  const build = buildForest(world, await models(), { scatter: 0, fernDensity: 0, litter: 0, smoothTrunks: true })
  let checked = 0
  for (const template of build.templates.filter(t => t.kind === "tree")) {
    const data = new DataView(template.near.opaque), normals = new Map<string, string>()
    for (let o = 0; o < data.byteLength; o += 32) {
      if (data.getUint16(o + 20, true) !== toHalf(41) || data.getUint8(o + 18) !== 0) continue
      const key = [0, 4, 8].map(k => data.getFloat32(o + k, true).toFixed(5)).join(",")
      const normal = [12, 13, 14].map(k => data.getInt8(o + k)).join(",")
      if (normals.has(key)) { expect(normal).toBe(normals.get(key)!); checked++ }
      normals.set(key, normal)
    }
  }
  expect(checked).toBeGreaterThan(1000)
}, 30_000)
