import { expect, test } from "bun:test"
import { NodeIO } from "@gltf-transform/core"
import { ALL_EXTENSIONS } from "@gltf-transform/extensions"
import { vec3 } from "wgpu-matrix"
import { Mesh, MAT, packVerts } from "@arcade/kit/gpu/mesh"
import { packTexturedVerts } from "@arcade/kit/gpu/textured-mesh"

test("UV extension preserves the compact ABI, full UV range and vertex alignment", () => {
  const mesh = new Mesh()
  mesh.vert([2, 3, -4], [0, 1, 0], [0.4, 0.2, 1], MAT.ground, 0.25)
  mesh.vert([-7, 8, 9], [-1, 0, 0], [1, 0, 0], MAT.lit)
  const compact = new Uint8Array(packVerts(mesh.v))
  const result = packTexturedVerts(mesh.v, [-12.5, 32.25, 0.125, 1])
  const bytes = new Uint8Array(result), floats = new Float32Array(result)
  expect(bytes.slice(0, 24)).toEqual(compact.slice(0, 24))
  expect(bytes.slice(32, 56)).toEqual(compact.slice(24, 48))
  expect([floats[6], floats[7], floats[14], floats[15]]).toEqual([-12.5, 32.25, 0.125, 1])
  expect(() => packTexturedVerts(mesh.v, [1, 2])).toThrow("UV count")
})

test("shipped wagon is licensed, grounded, metre-scaled and has normals/UVs", async () => {
  const metadata = await Bun.file(new URL("../public/assets/source-metadata.json", import.meta.url)).json()
  expect(metadata.wagon.license).toBe("by")
  expect(metadata.sourceSha256).toMatch(/^[a-f0-9]{64}$/)
  const doc = await new NodeIO().registerExtensions(ALL_EXTENSIONS).read(new URL("../public/assets/wagon.glb", import.meta.url).pathname)
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
  doc.getRoot().getDefaultScene()!.traverse(node => {
    for (const p of node.getMesh()?.listPrimitives() ?? []) {
      expect(p.getAttribute("NORMAL")).not.toBeNull()
      expect(p.getAttribute("TEXCOORD_0")).not.toBeNull()
      const a = p.getAttribute("POSITION")!
      for (let i = 0; i < a.getCount(); i++) {
        const v = vec3.transformMat4(a.getElement(i, []), node.getWorldMatrix())
        for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k]!, v[k]!); hi[k] = Math.max(hi[k]!, v[k]!) }
      }
    }
  })
  expect(hi[2]! - lo[2]!).toBeCloseTo(5.05, 4)
  expect(lo[1]).toBeCloseTo(0, 5)
  expect(hi[0]! + lo[0]!).toBeCloseTo(0, 5)
  expect(hi[2]! + lo[2]!).toBeCloseTo(0, 5)
})
