import type { SkyAssets } from "./assets"

/** Keep both acquisitions alive until settled, including a resource arriving after code failed. */
export async function loadSkyResources<T>(code: Promise<T>, resource: Promise<SkyAssets>): Promise<[T, SkyAssets]> {
  const [module, assets] = await Promise.allSettled([code, resource])
  if (module.status === "rejected") {
    if (assets.status === "fulfilled") assets.value.dispose()
    throw module.reason
  }
  if (assets.status === "rejected") throw assets.reason
  return [module.value, assets.value]
}

/** One load/upload per device with independent attachment lifetimes. Failed loads are evicted. */
export function skyAssetCache(load: (device: GPUDevice) => Promise<SkyAssets>) {
  const shared = new WeakMap<GPUDevice, { pending: Promise<SkyAssets>; users: number }>()
  return async (device: GPUDevice): Promise<SkyAssets> => {
    let entry = shared.get(device)
    if (!entry) {
      entry = { pending: load(device), users: 0 }
      shared.set(device, entry)
    }
    const owner = entry
    owner.users++
    let assets: SkyAssets
    try { assets = await owner.pending }
    catch (error) {
      owner.users--
      if (shared.get(device) === owner) shared.delete(device)
      throw error
    }
    let released = false
    return { ...assets, dispose() {
      if (released) return
      released = true
      if (--owner.users === 0) {
        if (shared.get(device) === owner) shared.delete(device)
        assets.dispose()
      }
    } }
  }
}
