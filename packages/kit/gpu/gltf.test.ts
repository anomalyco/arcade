import { Document, WebIO } from "@gltf-transform/core"
import { expect, test } from "bun:test"
import { loadGltf } from "./gltf"
import { MAT, Mesh, type Mat, type Rgb } from "./mesh"
import { packTexturedVerts } from "./textured-mesh"

/** A GLB with one triangle under `LOD0.car` and one under `LOD1.car`, the LOD0 one on a retro material dyed red. */
async function glb(): Promise<Uint8Array> {
  const doc = new Document(), buffer = doc.createBuffer()
  const scene = doc.createScene()
  for (const lod of [0, 1]) {
    const position = doc.createAccessor().setType("VEC3").setBuffer(buffer).setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, lod]))
    const normal = doc.createAccessor().setType("VEC3").setBuffer(buffer).setArray(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]))
    const material = doc.createMaterial(`m${lod}`)
    if (lod === 0) material.setExtras({ kit: { mat: MAT.retro, aux: 5, color: [1, 0, 0] } })
    const prim = doc.createPrimitive().setAttribute("POSITION", position).setAttribute("NORMAL", normal).setMaterial(material)
    const parent = doc.createNode(`LOD${lod}.car`)
    parent.addChild(doc.createNode(`LOD${lod}.car.part`).setMesh(doc.createMesh().addPrimitive(prim)))
    scene.addChild(parent)
  }
  return new WebIO().writeBinary(doc)
}

Object.assign(globalThis, { GPUTextureUsage: { TEXTURE_BINDING: 4, COPY_DST: 2 } })
const device = {
  createTexture: () => ({ destroy: () => {} }),
  queue: { writeTexture: () => {} },
} as unknown as GPUDevice

/** Colour bytes, then the kit surface (`MAT`) and aux as float16, of a textured vertex. */
const surface = (v: ArrayBuffer) => ({ color: [...new Uint8Array(v, 16, 3)], half: [...new Uint16Array(v, 20, 2)] })
/** What the kit packs for a vertex of colour `c` on surface `mat` with `aux`. */
const expected = (c: Rgb, mat: Mat, aux: number) => {
  const m = new Mesh()
  m.vert([0, 0, 0], [0, 0, 1], c, mat, aux)
  return surface(packTexturedVerts(m.v, [0, 0]))
}

test("loadGltf loads one LOD level (or all, labelled) and applies a material's extras.kit surface and colour", async () => {
  const bytes = await glb()
  const near = await loadGltf(device, bytes)
  expect(near.primitives.length).toBe(1)
  expect(near.lods).toEqual([0])
  expect(surface(near.primitives[0]!.vertices)).toEqual(expected([1, 0, 0], MAT.retro, 5))

  const far = await loadGltf(device, bytes, undefined, undefined, 1)
  expect(far.lods).toEqual([1])
  expect(surface(far.primitives[0]!.vertices)).toEqual(expected([1, 1, 1], MAT.lit, 0))

  const all = await loadGltf(device, bytes, undefined, undefined, "all")
  expect([...all.lods].sort()).toEqual([0, 1])
})
