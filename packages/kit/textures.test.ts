import { existsSync, readFileSync, statSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, test } from "bun:test"
import {
  DEFAULT_TEXTURE_MANIFEST,
  TEXTURE_ARRAY_LAYERS,
  TEXTURE_ARRAY_SIZE,
  TEXTURE_LAYER,
  TEXTURE_TOTAL_PREPARED_BYTES,
  TEXTURE_TOTAL_SOURCE_BYTES,
  buildLinearMipChain,
  linearToSrgbByte,
  parseImageDimensions,
  srgbByteToLinear,
} from "./textures"
import {
  MATERIAL_RECIPES,
  MATERIAL_RECIPE_IDS,
  SURFACE_TEX_UNIFORM_FLOATS,
  packSurfaceTexUniforms,
  randomizeMaterialTextureParams,
  validateMaterialTextureParams,
} from "./gpu/surface-materials"

const texDir = resolve(import.meta.dir, "textures")

describe("generated material texture pipeline & manifest", () => {
  test("manifest covers all 16 layers with provenance, small byte budget, and matching files on disk", () => {
    expect(DEFAULT_TEXTURE_MANIFEST).toHaveLength(TEXTURE_ARRAY_LAYERS)
    expect(TEXTURE_ARRAY_LAYERS).toBe(16)
    expect(TEXTURE_TOTAL_PREPARED_BYTES).toBeLessThan(1.5 * 1024 * 1024)
    expect(TEXTURE_TOTAL_SOURCE_BYTES).toBeLessThan(1.5 * 1024 * 1024)

    let sumPrepared = 0
    for (let i = 0; i < DEFAULT_TEXTURE_MANIFEST.length; i++) {
      const entry = DEFAULT_TEXTURE_MANIFEST[i]!
      expect(entry.layer).toBe(i)
      expect(Number(TEXTURE_LAYER[entry.id as keyof typeof TEXTURE_LAYER])).toBe(i)
      expect(entry.model).toBe("gpt-image-1.5")
      expect(entry.prompt.length).toBeGreaterThan(40)
      expect(entry.width).toBe(TEXTURE_ARRAY_SIZE)
      expect(entry.height).toBe(TEXTURE_ARRAY_SIZE)
      expect(entry.mipLevels).toBe(9)
      expect(entry.drift.driftScore).toBeLessThan(0.25)

      if (entry.wrapMode === "derived_normal") {
        expect(entry.channelPacking).toContain("derived")
        expect(entry.channelPacking).toContain("not measured")
      } else {
        expect(entry.channelPacking).toContain("authored roughness estimate")
        expect(entry.channelPacking).toContain("not measured")
      }

      const assetPath = resolve(texDir, "assets", entry.url)
      expect(existsSync(assetPath)).toBe(true)
      const stat = statSync(assetPath)
      expect(stat.size).toBe(entry.preparedBytes)
      sumPrepared += stat.size

      const header = parseImageDimensions(new Uint8Array(readFileSync(assetPath)))
      expect(header).toEqual({ width: 256, height: 256, format: "webp" })

      const sourcePath = resolve(texDir, entry.sourceFile)
      expect(existsSync(sourcePath)).toBe(true)
      const sourceHeader = parseImageDimensions(new Uint8Array(readFileSync(sourcePath)))
      expect(sourceHeader).toEqual({ width: 512, height: 512, format: "webp" })
    }
    expect(sumPrepared).toBe(TEXTURE_TOTAL_PREPARED_BYTES)
  })

  test("buildLinearMipChain averages RGB in linear light and Alpha (roughness) linearly down to 1x1", () => {
    const size = 4
    const mip0 = new Uint8Array(size * size * 4)
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const idx = (y * size + x) * 4
        const bright = (x & 1) === 0
        // Checkerboard of sRGB 0 and sRGB 255 in R, constant 128 in G, 64 in B, and linear 100 vs 200 in Alpha
        mip0[idx + 0] = bright ? 255 : 0
        mip0[idx + 1] = 128
        mip0[idx + 2] = 64
        mip0[idx + 3] = bright ? 200 : 100
      }
    }

    const mips = buildLinearMipChain(mip0, size, size)
    expect(mips).toHaveLength(3)
    expect(mips[0]!.width).toBe(4)
    expect(mips[1]!.width).toBe(2)
    expect(mips[2]!.width).toBe(1)

    // In linear light, 0.5 * (0.0 + 1.0) = 0.5, which encodes to sRGB byte 188 (not naive sRGB average 128).
    const expectedLinearHalfSrgb = linearToSrgbByte(0.5)
    expect(expectedLinearHalfSrgb).toBe(188)
    expect(mips[1]!.data[0]).toBe(expectedLinearHalfSrgb)
    expect(mips[2]!.data[0]).toBe(expectedLinearHalfSrgb)

    // Alpha (roughness) is averaged linearly: 0.5 * (200 + 100) = 150.
    expect(mips[1]!.data[3]).toBe(150)
    expect(mips[2]!.data[3]).toBe(150)
    expect(srgbByteToLinear(255)).toBeCloseTo(1, 5)
    expect(srgbByteToLinear(0)).toBe(0)
  })

  test("per-recipe texture parameters validate, randomize deterministically, and pack into uniform buffer", () => {
    const buf = packSurfaceTexUniforms({ enabled: 1, globalScale: 1.2, globalContrast: 1.1 })
    expect(buf).toHaveLength(SURFACE_TEX_UNIFORM_FLOATS)
    expect(buf[0]).toBe(1)
    expect(buf[1]).toBeCloseTo(1.2, 5)
    expect(buf[2]).toBeCloseTo(1.1, 5)

    for (const id of MATERIAL_RECIPE_IDS) {
      const def = MATERIAL_RECIPES[id]
      const valid = validateMaterialTextureParams(id, def.textureDefaults)
      expect(valid.ok).toBe(true)
      const r1 = randomizeMaterialTextureParams(id, 42)
      const r2 = randomizeMaterialTextureParams(id, 42)
      expect(r1).toEqual(r2)
      expect(validateMaterialTextureParams(id, r1).ok).toBe(true)
    }
    expect(validateMaterialTextureParams("wood_planks", { textureLayer: 99 }).ok).toBe(false)
  })
})
