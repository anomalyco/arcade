import { expect, test } from "bun:test"
import { demoForestWorld } from "../sim/forest-demo"
import { loadForestModels } from "./assets"
import { buildForest, clampedGridHeight, forestHeightGrid, type ForestBuild } from "./build"
import { buildTransfers } from "./build-worker"

const root = new URL("./assets/", import.meta.url).pathname
async function models() {
  const fetch0 = globalThis.fetch
  globalThis.fetch = (async (url: string) => new Response(Bun.file(url))) as unknown as typeof fetch
  try { return await loadForestModels(root) } finally { globalThis.fetch = fetch0 }
}

test("the build worker's world (the height grid, no height function) builds byte for byte the page's forest", async () => {
  const world = demoForestWorld(7, 60)
  const m = await models()
  const opts = { scatter: 1, fernDensity: 1, litter: 1 }
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
