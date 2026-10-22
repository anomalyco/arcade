import { decodeCatalogue, type CatalogueStar } from "./catalogue"

/** Bundler-owned local URLs: no game prefix assumptions and no third-party runtime requests. */
export const SKY_ASSET_URLS = {
  stars: new URL("./assets/stars.bin", import.meta.url).href,
  moon: new URL("./assets/moon.webp", import.meta.url).href,
}
export type SkyAssets = { stars: CatalogueStar[]; moon: GPUTexture; dispose(): void }
export async function loadSkyAssets(device: GPUDevice, urls = SKY_ASSET_URLS): Promise<SkyAssets> {
  const responses = await Promise.all([fetch(urls.stars), fetch(urls.moon)])
  for (const response of responses) if (!response.ok) throw new Error(`Sky asset HTTP ${response.status}: ${response.url}`)
  const [buffer, blob] = await Promise.all([responses[0]!.arrayBuffer(), responses[1]!.blob()])
  const stars = decodeCatalogue(buffer)
  const bitmap = await createImageBitmap(blob, { colorSpaceConversion: "none" })
  const moon = device.createTexture({ label: "NASA CGI moon colour", size: [bitmap.width, bitmap.height], format: "rgba8unorm-srgb", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT })
  try { device.queue.copyExternalImageToTexture({ source: bitmap }, { texture: moon }, [bitmap.width, bitmap.height]) }
  catch (error) { moon.destroy(); throw error }
  finally { bitmap.close() }
  return { stars, moon, dispose() { moon.destroy() } }
}
