import { WebIO, type Node, type Texture } from "@gltf-transform/core"
import { ALL_EXTENSIONS } from "@gltf-transform/extensions"
import { MeshoptDecoder } from "meshoptimizer"
import { mat4, vec3 } from "wgpu-matrix"
import { MAT, Mesh, type Mat } from "./mesh"
import { packTexturedVerts, type TexturedPrimitive } from "./textured-mesh"
import { normalMipChain } from "./normal-mips"
import { imageMipChain } from "./image-mips"

export type DecodedImage = { width: number; height: number; data: Uint8Array<ArrayBuffer> }
export type KtxDecoder = (bytes: Uint8Array) => Promise<DecodedImage>

/** Upload a complete mip chain, including the final 1×1 level. Source images are glTF's unflipped top-left UVs. */
export async function imageTexture(device: GPUDevice, bytes: Uint8Array, srgb: boolean, mime = "image/png", ktx?: KtxDecoder, normalMap = false): Promise<GPUTexture> {
  const canvas = document.createElement("canvas")
  // Normal mips read pixels on the CPU. Avoid a GPU-backed canvas and its synchronous readback at boot.
  const ctx = canvas.getContext("2d", { willReadFrequently: normalMap })!
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
  const { width, height } = canvas, rgba = ctx.getImageData(0, 0, width, height).data
  const mips = normalMap ? normalMipChain(width, height, rgba) : imageMipChain(width, height, rgba, srgb)
  for (const [mipLevel, mip] of mips.entries())
    device.queue.writeTexture({ texture, mipLevel }, mip.data, { bytesPerRow: mip.width * 4 }, [mip.width, mip.height])
  return texture
}

/** One glTF triangle primitive on the CPU: world-space attributes, unindexed, for a game's own vertex layout. */
export type GltfRawPrimitive = {
  node: string
  material: string
  lod: number
  /** Per vertex; `indices` lists the triangles (0, 1, 2, ... when the primitive has none). */
  position: Float32Array
  normal: Float32Array
  indices: Uint32Array
  /** TEXCOORD_0 and TEXCOORD_1 (zeros when absent), COLOR_0 as rgba (null when absent). */
  uv0: Float32Array
  uv1: Float32Array
  color: Float32Array | null
  base: { bytes: Uint8Array; mime: string } | null
  normalMap: { bytes: Uint8Array; mime: string } | null
  orm: { bytes: Uint8Array; mime: string } | null
  occlusion: { bytes: Uint8Array; mime: string } | null
  baseColor: number[]
  roughness: number
  metalness: number
}

/** Every triangle primitive of a static glTF as indexed CPU arrays, with the asset's `extras` (meshopt and quantization decoded). */
export async function readGltfRaw(source: string | Uint8Array, transform = mat4.identity()): Promise<{ primitives: GltfRawPrimitive[]; extras: Record<string, unknown> }> {
  await MeshoptDecoder.ready
  const io = new WebIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.decoder": MeshoptDecoder })
  let bytes: Uint8Array
  if (typeof source === "string") {
    const response = await fetch(source)
    if (!response.ok) throw new Error(`${source}: ${response.status}`)
    bytes = new Uint8Array(await response.arrayBuffer())
  } else bytes = source
  const doc = await io.readBinary(bytes)
  const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0]
  if (!scene) throw new Error("glTF has no scene")
  const image = (t: Texture | null) => (t?.getImage() ? { bytes: t.getImage()!, mime: t.getMimeType() } : null)
  const primitives: GltfRawPrimitive[] = []
  scene.traverse(node => {
    const world = mat4.multiply(transform, node.getWorldMatrix())
    const normalMatrix = mat4.transpose(mat4.inverse(world))
    for (const primitive of node.getMesh()?.listPrimitives() ?? []) {
      if (primitive.getMode() !== 4) throw new Error("Only glTF triangle primitives are supported")
      const position = primitive.getAttribute("POSITION")!, normals = primitive.getAttribute("NORMAL")
      if (!normals) throw new Error("glTF normals required")
      const t0 = primitive.getAttribute("TEXCOORD_0"), t1 = primitive.getAttribute("TEXCOORD_1"), c0 = primitive.getAttribute("COLOR_0")
      const index = primitive.getIndices()
      const count = position.getCount()
      const out = { position: new Float32Array(count * 3), normal: new Float32Array(count * 3), uv0: new Float32Array(count * 2), uv1: new Float32Array(count * 2), color: c0 ? new Float32Array(count * 4) : null }
      const indices = new Uint32Array(index?.getCount() ?? count)
      for (let i = 0; i < indices.length; i++) indices[i] = index ? index.getScalar(i) : i
      // A mirroring transform flips the winding.
      if (mat4.determinant(world) < 0) for (let i = 0; i + 2 < indices.length; i += 3) [indices[i + 1], indices[i + 2]] = [indices[i + 2]!, indices[i + 1]!]
      const e: number[] = []
      for (let i = 0; i < count; i++) {
        out.position.set(vec3.transformMat4(position.getElement(i, e), world), i * 3)
        out.normal.set(vec3.normalize(vec3.transformMat4Upper3x3(normals.getElement(i, e), normalMatrix)), i * 3)
        if (t0) { t0.getElement(i, e); out.uv0[i * 2] = e[0]!; out.uv0[i * 2 + 1] = e[1]! }
        if (t1) { t1.getElement(i, e); out.uv1[i * 2] = e[0]!; out.uv1[i * 2 + 1] = e[1]! }
        if (c0 && out.color) { const c = c0.getElement(i, e); out.color.set([c[0]!, c[1]!, c[2]!, c[3] ?? 1], i * 4) }
      }
      const m = primitive.getMaterial()
      primitives.push({
        node: node.getName(), material: m?.getName() ?? "", lod: nodeLod(node), ...out, indices,
        base: image(m?.getBaseColorTexture() ?? null), normalMap: image(m?.getNormalTexture() ?? null),
        orm: image(m?.getMetallicRoughnessTexture() ?? null), occlusion: image(m?.getOcclusionTexture() ?? null),
        baseColor: m?.getBaseColorFactor() ?? [1, 1, 1, 1], roughness: m?.getRoughnessFactor() ?? 1, metalness: m?.getMetallicFactor() ?? 0,
      })
    }
  })
  return { primitives, extras: (doc.getRoot().getAsset().extras ?? {}) as Record<string, unknown> }
}

/** A node's level of detail from the common authored convention: the highest `LOD<n>` prefix on it or an ancestor, else 0. */
function nodeLod(node: Node): number {
  let lod = 0
  for (let n: Node | null = node; n; n = n.getParentNode()) lod = Math.max(lod, Number(/^lod(\d)/i.exec(n.getName())?.[1] ?? 0))
  return lod
}

/** glTF 2 static meshes: node transforms, normalized/quantized accessors, meshopt, PBR textures and optional KTX2.
 * Skins, animation and morph targets deliberately require a different adapter. Caller owns returned textures.
 * `source` is a URL or the already-fetched GLB bytes (for example from a boot screen's progress fetch).
 * Nodes named `LOD<n>` (and their children) load only for `lod` n, or all of them for "all"; `lods` gives each
 * primitive's level. A material's `extras.kit` = `{ mat, aux, color? }` sets its kit surface (`MAT`, default lit) and
 * vertex colour (the hue the forest batch keeps `MAT.retro` and tape at under bright light). */
export async function loadGltf(device: GPUDevice, source: string | Uint8Array, transform = mat4.identity(), ktx?: KtxDecoder, lod: number | "all" = 0) {
  await MeshoptDecoder.ready
  const io = new WebIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.decoder": MeshoptDecoder })
  let bytes: Uint8Array
  if (typeof source === "string") {
    const response = await fetch(source)
    if (!response.ok) throw new Error(`${source}: ${response.status}`)
    bytes = new Uint8Array(await response.arrayBuffer())
  } else bytes = source
  const doc = await io.readBinary(bytes)
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
  const lods: number[] = []
  try {
    scene.traverse(node => {
      // Common authored LOD convention: load one level, never two on top of each other.
      const level = nodeLod(node)
      if (lod !== "all" && level !== lod) return
      if (node.getSkin()) throw new Error("Static glTF adapter cannot render skins")
      const world = mat4.multiply(transform, node.getWorldMatrix())
      const normalMatrix = mat4.transpose(mat4.inverse(world))
      for (const primitive of node.getMesh()?.listPrimitives() ?? []) {
        if (primitive.getMode() !== 4) throw new Error("Only glTF triangle primitives are supported")
        const position = primitive.getAttribute("POSITION")!, normals = primitive.getAttribute("NORMAL")
        const uv = primitive.getAttribute("TEXCOORD_0"), indices = primitive.getIndices()
        if (!normals) throw new Error("glTF normals required")
        const m = primitive.getMaterial()
        const kit = (m?.getExtras() as { kit?: { mat?: number; aux?: number; color?: [number, number, number] } } | undefined)?.kit
        const mat = (kit?.mat ?? MAT.lit) as Mat, aux = kit?.aux ?? 0, tint = kit?.color ?? [1, 1, 1]
        const mesh = new Mesh(), uvs: number[] = []
        const count = indices?.getCount() ?? position.getCount()
        for (let i = 0; i < count; i++) {
          const index = indices?.getScalar(i) ?? i
          const p = vec3.transformMat4(position.getElement(index, []), world)
          const n = vec3.normalize(vec3.transformMat4Upper3x3(normals.getElement(index, []), normalMatrix))
          mesh.vert([p[0]!, p[1]!, p[2]!], [n[0]!, n[1]!, n[2]!], tint, mat, aux)
          const t = uv?.getElement(index, []) ?? [0, 0]; uvs.push(t[0]!, t[1]!)
        }
        const vertices = packTexturedVerts(mesh.v, uvs)
        lods.push(level)
        jobs.push(Promise.all([tex(m?.getBaseColorTexture() ?? null, true, white), tex(m?.getNormalTexture() ?? null, false, normal, true), tex(m?.getMetallicRoughnessTexture() ?? null, false, orm), tex(m?.getOcclusionTexture() ?? null, false, orm)]).then(([base, normal, orm, ao]) => ({
          vertices, base, normal, orm, ao, aoStrength: m?.getOcclusionTexture() ? m.getOcclusionStrength() : 0,
          alphaCutoff: m?.getAlphaMode() === "MASK" ? m.getAlphaCutoff() : 0,
          color: m?.getBaseColorFactor() ?? [1, 1, 1, 1], roughness: m?.getRoughnessFactor() ?? 1,
          metalness: m?.getMetallicFactor() ?? 0, normalScale: m?.getNormalScale() ?? 1, blend: m?.getAlphaMode() === "BLEND",
        })))
      }
    })
    return { primitives: await Promise.all(jobs), lods, dispose: () => textures.forEach(t => t.destroy()) }
  } catch (e) {
    // Other image decodes may still be running when a primitive or one texture fails.
    // Settle them before destroying the complete allocation set.
    await Promise.allSettled([...cache.values(), ...jobs])
    textures.forEach(t => t.destroy())
    throw e
  }
}
