import { expect, test } from "bun:test"
import { loadSkyResources, skyAssetCache } from "./resources"
import type { SkyAssets } from "./assets"

function asset() {
  let releases = 0
  const value: SkyAssets = { stars: [], moon: {} as GPUTexture, credits: "test", dispose() { releases++ } }
  return { value, get releases() { return releases } }
}

test("late texture acquisition is released after an earlier module failure", async () => {
  const a = asset(), pending = Promise.withResolvers<SkyAssets>()
  const outcome = loadSkyResources(Promise.reject(new Error("module failed")), pending.promise).catch(e => e.message)
  await Promise.resolve()
  expect(a.releases).toBe(0)
  pending.resolve(a.value)
  expect(await outcome).toBe("module failed")
  expect(a.releases).toBe(1)
})

test("two renderers share an upload but release their leases independently", async () => {
  const a = asset(), pending = Promise.withResolvers<SkyAssets>(), device = {} as GPUDevice
  let loads = 0
  const acquire = skyAssetCache(() => { loads++; return pending.promise })
  const p = acquire(device), q = acquire(device)
  expect(loads).toBe(1)
  pending.resolve(a.value)
  const [x, y] = await Promise.all([p, q])
  expect(x.moon).toBe(y.moon)
  x.dispose(); x.dispose()
  expect(a.releases).toBe(0)
  y.dispose()
  expect(a.releases).toBe(1)
})

test("failed asset load is evicted and retry can succeed", async () => {
  const a = asset(), device = {} as GPUDevice
  let attempts = 0
  const acquire = skyAssetCache(async () => { if (++attempts === 1) throw Error("offline"); return a.value })
  await expect(acquire(device)).rejects.toThrow("offline")
  const retry = await acquire(device)
  expect(attempts).toBe(2)
  retry.dispose()
  expect(a.releases).toBe(1)
})
