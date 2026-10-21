import { WebIO, type Texture } from "@gltf-transform/core"
import { ALL_EXTENSIONS } from "@gltf-transform/extensions"
import { MeshoptDecoder } from "meshoptimizer"
import { mat4, vec3 } from "wgpu-matrix"
import { MAT, Mesh } from "./mesh"
import { packTexturedVerts, type TexturedPrimitive } from "./textured-mesh"
import { normalMipChain } from "./normal-mips"

export type DecodedImage = { width: number; height: number; data: Uint8Array<ArrayBuffer> }
export type KtxDecoder = (bytes: Uint8Array) => Promise<DecodedImage>

/** Upload a complete mip chain, including the final 1×1 level. Source images are glTF's unflipped top-left UVs. */
export async function imageTexture(device: GPUDevice, bytes: Uint8Array, srgb: boolean, mime = "image/png", ktx?: KtxDecoder, normalMap = false): Promise<GPUTexture> {
  const canvas = document.createElement("canvas")
  const ctx = canvas.getContext("2d")!
  if (mime === "image/ktx2") {
    if (!ktx) throw new Error("KTX2 texture requires a Basis decoder")
    const image = await ktx(bytes)
    canvas.width = image.width; canvas.height = image.height
    ctx.putImageData(new ImageData(new Uint8ClampedArray(image.data.buffer), image.width, image.height), 0, 0)
  } else {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: mime }), { colorSpaceConversion: "none", premultiplyAlpha: "none" })
    canvas.width = bitmap.width; canvas.height = bitmap.height; ctx.drawImage(bitmap, 0, 0); bitmap.close()
  }
  const levels = 1 + Math.floor(Math.log2(Math.max(canvas.width, canvas.height)))
  const texture = device.createTexture({ size: [canvas.width, canvas.height], mipLevelCount: levels,
    format: srgb ? "rgba8unorm-srgb" : "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT })
  let width = canvas.width, height = canvas.height
  if(normalMap) {
    for(const [mipLevel,mip] of normalMipChain(width,height,ctx.getImageData(0,0,width,height).data).entries())
      device.queue.writeTexture({texture,mipLevel},mip.data,{bytesPerRow:mip.width*4},[mip.width,mip.height])
    return texture
  }
  let source=canvas
  for (let mipLevel = 0; mipLevel < levels; mipLevel++) {
    const mip = document.createElement("canvas"); mip.width = width; mip.height = height
    mip.getContext("2d")!.drawImage(source, 0, 0, width, height)
    device.queue.copyExternalImageToTexture({ source: mip }, { texture, mipLevel }, [width, height])
    source=mip
    width = Math.max(1, width >> 1); height = Math.max(1, height >> 1)
  }
  return texture
}

/** glTF 2 static meshes: node transforms, normalized/quantized accessors, meshopt, PBR textures and optional KTX2.
 * Skins, animation and morph targets deliberately require a different adapter. Caller owns returned textures. */
export async function loadGltf(device: GPUDevice, url: string, transform = mat4.identity(), ktx?: KtxDecoder) {
  await MeshoptDecoder.ready
  const io = new WebIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.decoder": MeshoptDecoder })
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url}: ${response.status}`)
  const doc = await io.readBinary(new Uint8Array(await response.arrayBuffer()))
  const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0]
  if (!scene) throw new Error("glTF has no scene")
  const textures: GPUTexture[] = []
  const cache = new Map<string, Promise<GPUTexture>>()
  const solid = (rgba: number[], srgb: boolean) => {
    const texture = device.createTexture({ size: [1, 1], format: srgb ? "rgba8unorm-srgb" : "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST })
    device.queue.writeTexture({ texture }, new Uint8Array(rgba), {}, [1, 1]); textures.push(texture); return texture
  }
  const white = solid([255, 255, 255, 255], true)
  const normal = solid([128, 128, 255, 255], false)
  const orm = solid([255, 255, 255, 255], false)
  const tex = (t: Texture | null, srgb: boolean, fallback: GPUTexture, normalMap=false) => {
    if (!t) return Promise.resolve(fallback)
    const key = `${doc.getRoot().listTextures().indexOf(t)}:${srgb}:${normalMap}`
    let promise = cache.get(key)
    if (!promise) {
      promise = imageTexture(device, t.getImage()!, srgb, t.getMimeType(), ktx, normalMap).then(t => { textures.push(t); return t })
      cache.set(key, promise)
    }
    return promise
  }
  const jobs: Promise<TexturedPrimitive>[] = []
  try {
    scene.traverse(node => {
      // Common authored LOD convention: load only the full-detail node, never both on top of each other.
      for (let parent = node; parent; parent = parent.getParentNode()!) if (/^lod[1-9]/i.test(parent.getName())) return
      if (node.getSkin()) throw new Error("Static glTF adapter cannot render skins")
      const world = mat4.multiply(transform, node.getWorldMatrix())
      const normalMatrix = mat4.transpose(mat4.inverse(world))
      for (const primitive of node.getMesh()?.listPrimitives() ?? []) {
        if (primitive.getMode() !== 4) throw new Error("Only glTF triangle primitives are supported")
        const position = primitive.getAttribute("POSITION")!, normals = primitive.getAttribute("NORMAL")
        const uv = primitive.getAttribute("TEXCOORD_0"), indices = primitive.getIndices()
        if (!normals) throw new Error("glTF normals required")
        const mesh = new Mesh(), uvs: number[] = []
        const count = indices?.getCount() ?? position.getCount()
        for (let i = 0; i < count; i++) {
          const index = indices?.getScalar(i) ?? i
          const p = vec3.transformMat4(position.getElement(index, []), world)
          const n = vec3.normalize(vec3.transformMat4Upper3x3(normals.getElement(index, []), normalMatrix))
          mesh.vert([p[0]!, p[1]!, p[2]!], [n[0]!, n[1]!, n[2]!], [1, 1, 1], MAT.lit)
          const t = uv?.getElement(index, []) ?? [0, 0]; uvs.push(t[0]!, t[1]!)
        }
        const vertices = packTexturedVerts(mesh.v, uvs)
        const m = primitive.getMaterial()
        jobs.push(Promise.all([tex(m?.getBaseColorTexture() ?? null, true, white), tex(m?.getNormalTexture() ?? null, false, normal, true), tex(m?.getMetallicRoughnessTexture() ?? null, false, orm), tex(m?.getOcclusionTexture() ?? null, false, orm)]).then(([base, normal, orm, ao]) => ({
          vertices, base, normal, orm, ao, aoStrength: m?.getOcclusionTexture() ? m.getOcclusionStrength() : 0,
          alphaCutoff: m?.getAlphaMode() === "MASK" ? m.getAlphaCutoff() : 0,
          color: m?.getBaseColorFactor() ?? [1, 1, 1, 1], roughness: m?.getRoughnessFactor() ?? 1,
          metalness: m?.getMetallicFactor() ?? 0, normalScale: m?.getNormalScale() ?? 1, blend: m?.getAlphaMode() === "BLEND",
        })))
      }
    })
    return { primitives: await Promise.all(jobs), dispose: () => textures.forEach(t => t.destroy()) }
  } catch (e) {
    // Other image decodes may still be running when a primitive or one texture fails.
    // Settle them before destroying the complete allocation set.
    await Promise.allSettled([...cache.values(), ...jobs])
    textures.forEach(t => t.destroy())
    throw e
  }
}
