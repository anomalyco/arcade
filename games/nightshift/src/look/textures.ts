import { imageMipChain } from "@arcade/kit/gpu/image-mips"
import { LOOK_LAYER_COUNT, LOOK_LAYER_SIZE, LOOK_LAYERS, LOOK_SCANNED_LAYERS } from "./wgsl"
import { bakeContact } from "./contact"
import { occluders } from "../world"

export const LOOK_SURFACES_PATH = "look/surfaces.webp"

/** The scanned surface strip as a mipmapped 2D array (one layer per material) plus the baked contact layer, for the kit's detail-array binding. */
export async function lookSurfaces(device: GPUDevice, bytes: Uint8Array): Promise<GPUTexture> {
  const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: "image/webp" }), { colorSpaceConversion: "none", premultiplyAlpha: "none" })
  const S = LOOK_LAYER_SIZE
  if (bitmap.width !== S * LOOK_SCANNED_LAYERS || bitmap.height !== S) throw Error(`look surfaces: unexpected ${bitmap.width}×${bitmap.height}`)
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), ctx = canvas.getContext("2d", { willReadFrequently: true })!
  ctx.drawImage(bitmap, 0, 0); bitmap.close()
  const levels = 1 + Math.log2(S)
  const texture = device.createTexture({ label: "look surfaces", size: [S, S, LOOK_LAYER_COUNT], mipLevelCount: levels, format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST })
  for (let layer = 0; layer < LOOK_SCANNED_LAYERS; layer++) {
    const rgba = ctx.getImageData(layer * S, 0, S, S).data
    for (const [mipLevel, mip] of imageMipChain(S, S, rgba, false).entries())
      device.queue.writeTexture({ texture, mipLevel, origin: [0, 0, layer] }, mip.data, { bytesPerRow: mip.width * 4 }, [mip.width, mip.height, 1])
  }
  // Sampled at mip 0 only.
  device.queue.writeTexture({ texture, origin: [0, 0, LOOK_LAYERS.contact] }, bakeContact(occluders, S), { bytesPerRow: S * 4 }, [S, S, 1])
  return texture
}
