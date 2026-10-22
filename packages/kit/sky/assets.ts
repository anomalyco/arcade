import { decodeCatalogue, type CatalogueStar } from "./catalogue"
import { imageMipChain } from "../gpu/image-mips"
import { skyAssetCache } from "./resources"

/** Bundler-owned local URLs: no game prefix assumptions and no third-party runtime requests. */
export const SKY_ASSET_URLS = {
  stars: new URL("./assets/stars.bin", import.meta.url).href,
  moon: new URL("./assets/moon.webp", import.meta.url).href,
  credits: new URL("./assets/CREDITS.md", import.meta.url).href,
}
export type SkyAssets = { stars: CatalogueStar[]; moon: GPUTexture; credits: string; dispose(): void }
export const acquireSkyAssets = skyAssetCache(loadSkyAssets)
export async function loadSkyAssets(device: GPUDevice, urls = SKY_ASSET_URLS): Promise<SkyAssets> {
  const responses = await Promise.all([fetch(urls.stars), fetch(urls.moon)])
  for (const response of responses) if (!response.ok) throw new Error(`Sky asset HTTP ${response.status}: ${response.url}`)
  const [buffer, blob] = await Promise.all([responses[0]!.arrayBuffer(), responses[1]!.blob()])
  const stars = decodeCatalogue(buffer)
  const bitmap = await createImageBitmap(blob, { colorSpaceConversion: "none" })
  const { width, height } = bitmap
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext("2d", { willReadFrequently: true })!
  try { context.drawImage(bitmap, 0, 0) } finally { bitmap.close() }
  const mips = imageMipChain(width, height, context.getImageData(0, 0, width, height).data, true)
  const moon = device.createTexture({ label: "NASA CGI moon colour", size: [width, height], mipLevelCount: mips.length, format: "rgba8unorm-srgb", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST })
  try {
    for (const [mipLevel, mip] of mips.entries()) device.queue.writeTexture({ texture: moon, mipLevel }, mip.data, { bytesPerRow: mip.width * 4 }, [mip.width, mip.height])
  }
  catch (error) { moon.destroy(); throw error }
  return { stars, moon, credits: urls.credits, dispose() { moon.destroy() } }
}
