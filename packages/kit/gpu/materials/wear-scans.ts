import { buildLinearMipChain } from "../../textures/loader"
import type { FinishScanId } from "./wear"

/**
 * URLs of the wear looks' CC0 scans (`scans/`, fetched by `scripts/finish/fetch-scans.ts`, credits in
 * `scans/CREDITS.md`): tiling base colour at 512². Kept apart from `wear.ts` so a game bundles only the scans it imports.
 */
export const FINISH_SCAN_URLS: Record<FinishScanId, () => string> = {
  "worn-metal": () => new URL("./scans/worn-metal.webp", import.meta.url).href,
  "painted-steel": () => new URL("./scans/painted-steel.webp", import.meta.url).href,
  "concrete-block": () => new URL("./scans/concrete-block.webp", import.meta.url).href,
  "old-wood": () => new URL("./scans/old-wood.webp", import.meta.url).href,
  bark: () => new URL("./scans/bark.webp", import.meta.url).href,
  stone: () => new URL("./scans/stone.webp", import.meta.url).href,
}

export type FinishScanArray = {
  texture: GPUTexture
  view: GPUTextureView
  /** Layer of each scan in `view`. */
  layers: Partial<Record<FinishScanId, number>>
}

/**
 * Loads `ids` into one sRGB texture array at `size`² with a linear-light mip chain, for a scene shader that samples
 * the scans through `wearWgsl`'s `sample`/`sampleMean` (bind it with `Renderer.setDetailTextureArray`). Browser only.
 */
export async function loadFinishScans(device: GPUDevice, ids: readonly FinishScanId[], size = 512): Promise<FinishScanArray> {
  const images = await Promise.all(ids.map(async id => {
    const blob = await (await fetch(FINISH_SCAN_URLS[id]())).blob()
    const bitmap = await createImageBitmap(blob, { resizeWidth: size, resizeHeight: size, colorSpaceConversion: "none", premultiplyAlpha: "none" })
    const ctx = new OffscreenCanvas(size, size).getContext("2d")!
    ctx.drawImage(bitmap, 0, 0)
    bitmap.close()
    return buildLinearMipChain(new Uint8Array(ctx.getImageData(0, 0, size, size).data.buffer), size, size)
  }))
  const levels = images[0]?.length ?? 1
  const texture = device.createTexture({
    label: "finish scans",
    size: [size, size, Math.max(1, ids.length)],
    mipLevelCount: levels,
    format: "rgba8unorm-srgb",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  })
  const layers: Partial<Record<FinishScanId, number>> = {}
  images.forEach((mips, layer) => {
    layers[ids[layer]!] = layer
    mips.forEach((m, mipLevel) => device.queue.writeTexture({ texture, mipLevel, origin: [0, 0, layer] }, m.data, { bytesPerRow: m.width * 4 }, [m.width, m.height, 1]))
  })
  return { texture, view: texture.createView({ dimension: "2d-array" }), layers }
}
