import { expect, test } from "bun:test"
import { NodeIO } from "@gltf-transform/core"
import { ALL_EXTENSIONS } from "@gltf-transform/extensions"
import { vec3 } from "wgpu-matrix"
import { Mesh, MAT, packVerts } from "@arcade/kit/gpu/mesh"
import { packTexturedVerts } from "@arcade/kit/gpu/textured-mesh"
import type { SourceScene } from "../src/world"

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

test("baked exterior ships complete, finite, triangle-aligned geometry within hosting limits", async () => {
  const base = new URL("../public/ashwood/", import.meta.url)
  const scene: SourceScene = await Bun.file(new URL("scene.json", base)).json()
  expect(scene.version).toBe(2)
  expect(scene.treeCount).toBeGreaterThan(100)
  for (const kind of ["solid", "surface-asphalt", "surface-gravel", "surface-forest_floor", "surface-concrete_wall", "fence", "glass", "stain", "undergrowth"]) {
    expect(scene.files[kind].length).toBeGreaterThan(0)
    for (const name of scene.files[kind]) {
      const file = Bun.file(new URL(name, base))
      expect(file.size).toBeLessThan(25 * 1024 * 1024)
      const bytes = Bun.gunzipSync(new Uint8Array(await file.arrayBuffer()))
      const stride = kind === "solid" ? 24 : 32
      expect(bytes.byteLength).toBeGreaterThan(0)
      expect(bytes.byteLength % (stride * 3)).toBe(0)
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      let finite = true
      for (let offset = 0; offset < bytes.byteLength; offset += stride) {
        for (const component of [0, 4, 8]) finite &&= Number.isFinite(view.getFloat32(offset + component, true))
      }
      expect(finite).toBe(true)
    }
  }
  expect(await Bun.file(new URL("paint.js", base)).exists()).toBe(true)
})

test("forest templates and instances match their manifest", async () => {
  const base = new URL("../public/ashwood/", import.meta.url)
  const scene: SourceScene = await Bun.file(new URL("scene.json", base)).json()
  const gunzip = async (name: string) => Bun.gunzipSync(new Uint8Array(await Bun.file(new URL(name, base)).arrayBuffer()))
  const models = await gunzip("forest-models.bin.gz"), trees = new Float32Array((await gunzip("forest-trees.bin.gz")).buffer)
  const n = scene.forest.trees
  expect(n).toBe(scene.treeCount)
  expect(trees.length).toBe(n * 8)
  expect(trees.every(Number.isFinite)).toBe(true)
  const variants = trees.subarray(7 * n)
  expect(Math.max(...variants)).toBe(scene.forest.models.length - 1)
  let end = 0
  for (const m of scene.forest.models) for (const lod of m.lods) for (const [offset, bytes] of [lod.trunk, lod.foliage]) {
    expect(offset).toBe(end)
    expect(bytes % 96).toBe(0)
    end = offset! + bytes!
  }
  for (const plant of Object.values(scene.forest.plants)) {
    expect(plant.range[0]).toBe(end)
    expect(plant.range[1] % 96).toBe(0)
    end = plant.range[0] + plant.range[1]
  }
  expect(end).toBe(models.byteLength)
  // Foliage cards carry the inner-crown depth in aux (float16 at byte 22), 0 at the trunk to 1 at the limb tip.
  const [offset, bytes] = scene.forest.models[0]!.lods[0]!.foliage
  const view = new DataView(models.buffer, models.byteOffset + offset!, bytes!)
  let lo = Infinity, hi = -Infinity
  for (let o = 0; o < bytes!; o += 32) { const a = view.getFloat16(o + 22, true); lo = Math.min(lo, a); hi = Math.max(hi, a) }
  expect(lo).toBeGreaterThanOrEqual(0)
  expect(hi).toBeLessThanOrEqual(1)
  expect(hi - lo).toBeGreaterThan(0.3)
})

test("source layout includes the roadside cabinet and access-road lamp with licensed texture sets", async () => {
  const base = new URL("../public/ashwood/", import.meta.url)
  const scene = await Bun.file(new URL("scene.json", base)).json()
  expect(scene.lamps.some((l:any)=>l.kind==="sodium" && l.position[2]>200 && l.position[2]<215)).toBe(true)
  expect(scene.props.some((p:any)=>p.name==="utility_box_b" && p.position[2]>130 && p.included)).toBe(true)
  for(const p of scene.props) if(p.included && p.name!=="car_wagon") {
    expect(p.license).toBe("CC0-1.0")
    expect(await Bun.file(new URL(`models/${p.name}.glb`,base)).exists()).toBe(true)
  }
  for(const [name,files] of Object.entries(scene.files) as [string,string[]][]) if(name.startsWith("surface-") && files.length) {
    for(const map of ["base","normal","orm"]) expect(await Bun.file(new URL(`surfaces/${name.slice(8)}-${map}.png`,base)).exists()).toBe(true)
  }
})

test("stairwell glow and opaque backing remain separated at distant depth24 precision", async () => {
  const base = new URL("../public/ashwood/", import.meta.url)
  const scene: SourceScene = await Bun.file(new URL("scene.json", base)).json()
  let backing=-Infinity, glow=Infinity
  for(const file of scene.files.solid) {
    const bytes=Bun.gunzipSync(await Bun.file(new URL(file,base)).bytes())
    const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength)
    for(let o=0;o<bytes.length;o+=24) {
      const x=view.getFloat32(o,true),z=view.getFloat32(o+8,true)
      if(x< -42.3 || x> -40.5 || z<24.8 || z>25.03) continue
      if(bytes[o+16]===5 && bytes[o+17]===8 && bytes[o+18]===7) backing=Math.max(backing,z)
      if(view.getFloat16(o+20,true)===MAT.glow) glow=Math.min(glow,z)
    }
  }
  expect(Number.isFinite(backing) && Number.isFinite(glow)).toBe(true)
  expect(glow-backing).toBeGreaterThan(0.07)
  const depth=(distance:number)=>Math.round((1200/(1200-0.15)-1200*0.15/((1200-0.15)*distance))*0xffffff)
  for(const cameraZ of [145,158.465,200]) expect(depth(cameraZ-backing)-depth(cameraZ-glow)).toBeGreaterThan(3)
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
