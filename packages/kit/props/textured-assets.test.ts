import { expect, test } from "bun:test"
import { NodeIO } from "@gltf-transform/core"
import { ALL_EXTENSIONS } from "@gltf-transform/extensions"

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
for (const [id, budget, path] of [
  ["rotary-phone", 3000, "./assets/rotary-phone.glb"],
  ["tv-set", 7000, "./assets/tv-set.glb"],
  ["kitchen-counter", 12000, "./assets/kitchen-counter.glb"],
  ["camp-cooler", 3000, "../../../games/barbara/public/props/camp-cooler.glb"],
] as const) test(`${id}: finite low-poly geometry and three shared WebP PBR maps`, async () => {
  const bytes = new Uint8Array(await Bun.file(new URL(path, import.meta.url)).arrayBuffer())
  expect(bytes.length).toBeLessThan(25 * 1024 * 1024)
  const doc = await io.readBinary(bytes)
  const root = doc.getRoot(), meshes = root.listMeshes()
  expect(meshes).toHaveLength(1)
  const primitives = meshes[0]!.listPrimitives()
  expect(primitives).toHaveLength(1)
  const p = primitives[0]!, positions = p.getAttribute("POSITION")!, uv = p.getAttribute("TEXCOORD_0")!
  expect(p.getIndices()!.getCount() / 3).toBeLessThanOrEqual(budget * 1.02)
  expect(uv.getCount()).toBe(positions.getCount())
  for (const attr of [positions, uv, p.getAttribute("NORMAL")!]) {
    expect(attr).not.toBeNull()
    expect(Array.from(attr.getArray()!).every(Number.isFinite)).toBe(true)
  }
  const material = p.getMaterial()!
  expect(material.getBaseColorTexture()).not.toBeNull()
  expect(material.getNormalTexture()).not.toBeNull()
  expect(material.getMetallicRoughnessTexture()).not.toBeNull()
  expect(material.getOcclusionTexture()).toBe(material.getMetallicRoughnessTexture())
  expect(root.listTextures()).toHaveLength(3)
  for (const texture of root.listTextures()) {
    expect(texture.getMimeType()).toBe("image/webp")
    expect(texture.getSize()).toEqual([512, 512])
  }
})
