import { NodeIO } from "@gltf-transform/core"
import { ALL_EXTENSIONS } from "@gltf-transform/extensions"
import { mat4, vec3 } from "wgpu-matrix"
import { gunzipSync } from "node:zlib"
import { mkdir } from "node:fs/promises"

const uid = "aa0becb6e854422596cac6b21bf79787"
const base = "https://huggingface.co/datasets/allenai/objaverse/resolve/main"
const out = new URL("../public/assets/", import.meta.url)
await mkdir(out, { recursive: true })
async function download(url: string) {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${r.status}: ${url}`)
  return new Uint8Array(await r.arrayBuffer())
}
const metadata = JSON.parse(gunzipSync(await download(`${base}/metadata/000-124.json.gz`)).toString())
if (metadata[uid]?.license !== "by") throw new Error(`Unexpected model licence: ${metadata[uid]?.license}`)
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const source = await download(`${base}/glbs/000-124/${uid}.glb`)
const doc = await io.readBinary(source)
const scene = doc.getRoot().getDefaultScene()!
const rotation = mat4.rotationY(-Math.PI / 2)
const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
scene.traverse(node => {
  const world = mat4.multiply(rotation, node.getWorldMatrix())
  for (const p of node.getMesh()?.listPrimitives() ?? []) {
    const a = p.getAttribute("POSITION")!
    for (let i = 0; i < a.getCount(); i++) {
      const v = vec3.transformMat4(a.getElement(i, []), world)
      for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k]!, v[k]!); hi[k] = Math.max(hi[k]!, v[k]!) }
    }
  }
})
const scale = 5.05 / (hi[2]! - lo[2]!)
const root = doc.createNode("Lot: metres, ground-centred, forward -Z")
root.setRotation([0, -Math.SQRT1_2, 0, Math.SQRT1_2]).setScale([scale, scale, scale])
root.setTranslation([-(hi[0]! + lo[0]!) * scale / 2, -lo[1]! * scale, -(hi[2]! + lo[2]!) * scale / 2])
for (const child of scene.listChildren()) root.addChild(child)
scene.addChild(root)
await Bun.write(new URL("wagon.glb", out), await io.writeBinary(doc))
// Original-source, 1k scan. Kept as JPEG/PNG so the first kit importer has no transcoder runtime.
const files = await (await fetch("https://api.polyhaven.com/files/worn_asphalt")).json() as Record<string, Record<string, Record<string, { url: string }>>>
for (const [map, file] of [["Diffuse", "asphalt.jpg"], ["nor_gl", "asphalt-normal.jpg"], ["arm", "asphalt-orm.jpg"]]) {
  const url = files[map!]?.["1k"]?.jpg?.url
  if (!url) throw new Error(`Missing Poly Haven ${map}`)
  await Bun.write(new URL(file!, out), await download(url))
}
await Bun.write(new URL("source-metadata.json", out), JSON.stringify({ wagon: metadata[uid], sourceSha256: new Bun.CryptoHasher("sha256").update(source).digest("hex"), scale, rotatedBounds: { lo, hi }, asphalt: "https://polyhaven.com/a/worn_asphalt" }, null, 2))
console.log("Prepared wagon (5.05 m) and Poly Haven asphalt in", out.pathname)
