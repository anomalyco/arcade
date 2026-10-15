import {
  DEFAULT_TEXTURE_MANIFEST,
  TEXTURE_ARRAY_LAYERS,
  TEXTURE_ARRAY_SIZE,
  TEXTURE_LAYER,
  defaultTextureBaseUrl,
  type TextureAssetMeta,
} from "./manifest"

const SRGB_DECODE = new Float32Array(256)
for (let i = 0; i < 256; i++) {
  const v = i / 255
  SRGB_DECODE[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}

export function srgbByteToLinear(byte: number): number {
  return SRGB_DECODE[Math.max(0, Math.min(255, byte | 0))]!
}

export function linearToSrgbByte(linear: number): number {
  const v = Math.max(0, Math.min(1, linear))
  const s = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055
  return Math.max(0, Math.min(255, Math.round(s * 255)))
}

export type MipLevelData = {
  width: number
  height: number
  data: Uint8Array<ArrayBuffer>
}

/**
 * Generates a full linear-light mipmap chain (matching Lamplight's src/renderer/material_maps.rs):
 * - RGB channels are decoded from sRGB to linear light, box-filtered 2x2 in linear light, and re-encoded to sRGB.
 * - Alpha channel (authored roughness estimate or derived height) is stored and filtered linearly.
 */
export function buildLinearMipChain(mip0: Uint8Array, width: number, height: number): MipLevelData[] {
  const levels: MipLevelData[] = []
  const copy0 = new Uint8Array(new ArrayBuffer(mip0.byteLength))
  copy0.set(mip0)
  levels.push({ width, height, data: copy0 })

  let curW = width
  let curH = height
  let cur = copy0

  while (curW > 1 || curH > 1) {
    const nextW = Math.max(1, curW >> 1)
    const nextH = Math.max(1, curH >> 1)
    const next = new Uint8Array(new ArrayBuffer(nextW * nextH * 4))

    for (let y = 0; y < nextH; y++) {
      const y0 = y * 2
      const y1 = Math.min(curH - 1, y0 + 1)
      for (let x = 0; x < nextW; x++) {
        const x0 = x * 2
        const x1 = Math.min(curW - 1, x0 + 1)
        const i00 = (y0 * curW + x0) * 4
        const i10 = (y0 * curW + x1) * 4
        const i01 = (y1 * curW + x0) * 4
        const i11 = (y1 * curW + x1) * 4

        const outIdx = (y * nextW + x) * 4
        for (let c = 0; c < 3; c++) {
          const avgLinear =
            0.25 *
            (SRGB_DECODE[cur[i00 + c]!]! +
              SRGB_DECODE[cur[i10 + c]!]! +
              SRGB_DECODE[cur[i01 + c]!]! +
              SRGB_DECODE[cur[i11 + c]!]!)
          next[outIdx + c] = linearToSrgbByte(avgLinear)
        }
        next[outIdx + 3] = Math.round(
          0.25 * (cur[i00 + 3]! + cur[i10 + 3]! + cur[i01 + 3]! + cur[i11 + 3]!),
        )
      }
    }

    levels.push({ width: nextW, height: nextH, data: next })
    curW = nextW
    curH = nextH
    cur = next
  }

  return levels
}

/**
 * Inspects a WebP or PNG byte buffer header for width and height without DOM dependencies (used in unit tests).
 */
export function parseImageDimensions(bytes: Uint8Array): { width: number; height: number; format: "webp" | "png" } {
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return {
      width: view.getUint32(16, false),
      height: view.getUint32(20, false),
      format: "png",
    }
  }
  // RIFF....WEBP
  if (
    bytes.length >= 30 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    const chunk = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!)
    if (chunk === "VP8X") {
      const width = 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16))
      const height = 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16))
      return { width, height, format: "webp" }
    }
    if (chunk === "VP8L") {
      const b0 = bytes[21]!
      const b1 = bytes[22]!
      const b2 = bytes[23]!
      const b3 = bytes[24]!
      const width = 1 + (((b1 & 0x3f) << 8) | b0)
      const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6))
      return { width, height, format: "webp" }
    }
    if (chunk === "VP8 ") {
      const width = (bytes[26]! | (bytes[27]! << 8)) & 0x3fff
      const height = (bytes[28]! | (bytes[29]! << 8)) & 0x3fff
      return { width, height, format: "webp" }
    }
  }
  throw new Error("Unsupported image header")
}

/**
 * Creates a repeating anisotropic sampler for projected material textures.
 */
export function createMaterialSampler(device: GPUDevice): GPUSampler {
  return device.createSampler({
    label: "material-anisotropic-sampler",
    addressModeU: "repeat",
    addressModeV: "repeat",
    magFilter: "linear",
    minFilter: "linear",
    mipmapFilter: "linear",
    maxAnisotropy: 2,
  })
}

/**
 * Creates a 1x1xN fallback 2D array texture so shaders can bind and sample before async assets resolve.
 */
export function createFallbackMaterialTextureArray(
  device: GPUDevice,
  layers = TEXTURE_ARRAY_LAYERS,
): { texture: GPUTexture; view: GPUTextureView } {
  const texture = device.createTexture({
    label: "material-fallback-array",
    size: [1, 1, layers],
    format: "rgba8unorm-srgb",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  })
  const data = new Uint8Array(layers * 4)
  for (let i = 0; i < layers; i++) {
    const off = i * 4
    if (i === TEXTURE_LAYER.lawn_grass_normal) {
      // Flat normal (0.5, 0.5, 1.0) pre-encoded in sRGB bytes
      data[off + 0] = 188
      data[off + 1] = 188
      data[off + 2] = 255
      data[off + 3] = 128
    } else {
      data[off + 0] = 255
      data[off + 1] = 255
      data[off + 2] = 255
      data[off + 3] = 214
    }
  }
  device.queue.writeTexture({ texture }, data, { bytesPerRow: 4, rowsPerImage: 1 }, [1, 1, layers])
  const view = texture.createView({ dimension: "2d-array", arrayLayerCount: layers })
  return { texture, view }
}

async function decodeBlobToRgba(blob: Blob, expectedSize: number): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(blob, {
    premultiplyAlpha: "none",
    colorSpaceConversion: "none",
  })
  try {
    const w = expectedSize
    const h = expectedSize
    if (typeof OffscreenCanvas !== "undefined") {
      const canvas = new OffscreenCanvas(w, h)
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!
      ctx.drawImage(bitmap, 0, 0, w, h)
      const img = ctx.getImageData(0, 0, w, h)
      return new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength)
    }
    const canvas = document.createElement("canvas")
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!
    ctx.drawImage(bitmap, 0, 0, w, h)
    const img = ctx.getImageData(0, 0, w, h)
    return new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength)
  } finally {
    bitmap.close()
  }
}

export type LoadedMaterialTextures = {
  texture: GPUTexture
  view: GPUTextureView
  loadedLayers: number
}

/**
 * Fetches all manifest textures from `texture-assets/`, builds linear-light mip chains (RGB sRGB-decoded,
 * Alpha linear roughness), and uploads them into a `256x256x16` `rgba8unorm-srgb` 2D array texture.
 */
export async function loadMaterialTextureArray(
  device: GPUDevice,
  entries: readonly TextureAssetMeta[] = DEFAULT_TEXTURE_MANIFEST,
  baseUrl = defaultTextureBaseUrl(),
  fetchImpl: typeof fetch | undefined = typeof fetch !== "undefined" ? fetch : undefined,
): Promise<LoadedMaterialTextures | null> {
  if (!fetchImpl || typeof createImageBitmap === "undefined") return null

  const size = TEXTURE_ARRAY_SIZE
  const layers = Math.max(TEXTURE_ARRAY_LAYERS, entries.length)
  const mipLevelCount = Math.floor(Math.log2(size)) + 1

  const prefix = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`
  const decoded = await Promise.all(
    entries.map(async entry => {
      try {
        const url = entry.url.startsWith("http") || entry.url.startsWith("/") ? entry.url : `${prefix}${entry.url}`
        const res = await fetchImpl(url)
        if (!res.ok) return null
        const blob = await res.blob()
        const rgba = await decodeBlobToRgba(blob, size)
        return { layer: entry.layer, mips: buildLinearMipChain(rgba, size, size) }
      } catch {
        return null
      }
    }),
  )

  const valid = decoded.filter((d): d is NonNullable<typeof d> => d !== null)
  if (valid.length === 0) return null

  const texture = device.createTexture({
    label: "material-texture-array",
    size: [size, size, layers],
    mipLevelCount,
    format: "rgba8unorm-srgb",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  })

  const byLayer = new Map(valid.map(v => [v.layer, v.mips]))
  let neutralMips: MipLevelData[] | undefined

  for (let layer = 0; layer < layers; layer++) {
    let mips = byLayer.get(layer)
    if (!mips) {
      if (!neutralMips) {
        const neutralRgba = new Uint8Array(size * size * 4)
        for (let i = 0; i < size * size * 4; i += 4) {
          neutralRgba[i + 0] = 255
          neutralRgba[i + 1] = 255
          neutralRgba[i + 2] = 255
          neutralRgba[i + 3] = 214
        }
        neutralMips = buildLinearMipChain(neutralRgba, size, size)
      }
      mips = neutralMips
    }
    for (let level = 0; level < mipLevelCount; level++) {
      const m = mips[level]!
      device.queue.writeTexture(
        { texture, mipLevel: level, origin: [0, 0, layer] },
        m.data,
        { bytesPerRow: m.width * 4, rowsPerImage: m.height },
        [m.width, m.height, 1],
      )
    }
  }

  return {
    texture,
    view: texture.createView({ dimension: "2d-array", arrayLayerCount: layers }),
    loadedLayers: valid.length,
  }
}
