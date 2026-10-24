import { Color, MeshStandardMaterial, type Material, type Texture } from "three/webgpu"
import { imageTexture } from "@arcade/kit/gpu/gltf"
import type { BridgeSurface } from "./world-bridge"

/** Standard PBR assets and authored interactive props. Register Ashwood's packed/TSL recipes by material name. */
export class BridgeMaterials {
  private readonly owned = new Set<GPUTexture>()
  private readonly textures = new Map<string, Promise<GPUTexture>>()
  private readonly recipes = new Map<string, (material: Material) => Promise<BridgeSurface>>()
  private readonly white: GPUTexture
  private readonly flatNormal: GPUTexture

  constructor(private readonly device: GPUDevice) {
    this.white = this.solid([255, 255, 255, 255])
    this.flatNormal = this.solid([128, 128, 255, 255])
  }

  register(name: string, recipe: (material: Material) => Promise<BridgeSurface>): void { this.recipes.set(name, recipe) }

  private solid(rgba: number[]): GPUTexture {
    const texture = this.device.createTexture({ size: [1, 1], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST })
    this.device.queue.writeTexture({ texture }, new Uint8Array(rgba), {}, [1, 1])
    this.owned.add(texture)
    return texture
  }

  private texture(texture: Texture | null, srgb: boolean, fallback: GPUTexture, normal = false): Promise<GPUTexture> {
    if (!texture) return Promise.resolve(fallback)
    const key = `${texture.uuid}:${srgb}:${normal}`
    const cached = this.textures.get(key)
    if (cached) return cached
    const load = async () => {
      if (texture.offset.length() || texture.repeat.x !== 1 || texture.repeat.y !== 1 || texture.rotation) throw new Error(`Bake UV transforms before bridging ${texture.name || texture.uuid}`)
      const source = texture.image
      if (!(source instanceof HTMLImageElement || source instanceof HTMLCanvasElement || source instanceof ImageBitmap || source instanceof OffscreenCanvas) || !source.width || !source.height) throw new Error(`Map needs an image recipe: ${texture.name || texture.uuid}`)
      const canvas = new OffscreenCanvas(source.width, source.height), ctx = canvas.getContext("2d")!
      // glTF-style native UVs and Three's flipY convention differ; bake the source orientation once.
      if (texture.flipY) { ctx.translate(0, source.height); ctx.scale(1, -1) }
      ctx.drawImage(source, 0, 0)
      const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer())
      const result = await imageTexture(this.device, bytes, srgb, "image/png", undefined, normal)
      this.owned.add(result)
      return result
    }
    const promise = load()
    this.textures.set(key, promise)
    return promise
  }

  resolve = async (material: Material): Promise<BridgeSurface> => {
    const recipe = this.recipes.get(material.name)
    if (recipe) return recipe(material)
    if (!(material instanceof MeshStandardMaterial) || "isNodeMaterial" in material) throw new Error(`Native material recipe required: ${material.name || material.type}`)
    if (material.emissiveIntensity && material.emissive.getHex() !== 0) throw new Error(`Emissive recipe required: ${material.name}`)
    if (material.roughnessMap && material.metalnessMap && material.roughnessMap !== material.metalnessMap) throw new Error(`Pack roughness/metalness for ${material.name}`)
    const [base, normal, orm, ao] = await Promise.all([
      this.texture(material.map, true, this.white), this.texture(material.normalMap, false, this.flatNormal, true),
      this.texture(material.roughnessMap ?? material.metalnessMap, false, this.white), this.texture(material.aoMap, false, this.white),
    ])
    const color = new Color().copy(material.color).convertLinearToSRGB()
    return { base, normal, orm, ao, color: [color.r, color.g, color.b, material.opacity], roughness: material.roughness, metalness: material.metalness,
      normalScale: material.normalScale.x, aoStrength: material.aoMap ? material.aoMapIntensity : 0, alphaCutoff: material.alphaTest, blend: material.transparent }
  }

  dispose(): void { this.owned.forEach(t => t.destroy()); this.owned.clear(); this.textures.clear() }
}
