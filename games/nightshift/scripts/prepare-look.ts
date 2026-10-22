/**
 * Office look assets (AR-129) from the vetted Night Shift prop library (CC0, CC BY 4.0 and Kit-owned; see CREDITS.md):
 * - `public/look/surfaces.webp`: four 512² scanned layers side by side (partition fabric, ceiling tile, dirty carpet,
 *   rough beige plastic), packed r = albedo detail (mean 0.5), gb = OpenGL normal xy, a = 0.5 + roughness / 2.
 * - `public/look/props/*.glb`: the dressing props with their textures downsized to WebP.
 * Usage: bun scripts/prepare-look.ts <models dir> (the gallery's nightshift-2026-10-20/models).
 */
import { NodeIO } from "@gltf-transform/core"
import { EXTTextureWebP, ALL_EXTENSIONS } from "@gltf-transform/extensions"
import { mkdir } from "node:fs/promises"
import { createHash } from "node:crypto"
import { resolve } from "node:path"
import { LOOK_PROP_FILES } from "../src/look/props-list"

const source = process.argv[2] && resolve(process.argv[2])
if (!source) throw Error("Usage: prepare-look.ts <models dir>")
const out = resolve(import.meta.dir, "../public/look")
await mkdir(resolve(out, "props"), { recursive: true })

const py = async (code: string, input?: Uint8Array) => {
  const p = Bun.spawn(["uv", "run", "--quiet", "--with", "pillow", "--with", "numpy", "python", "-c", code], { stdin: input ? "pipe" : "ignore", stdout: "pipe", stderr: "inherit" })
  if (input && p.stdin) { p.stdin.write(input); p.stdin.end() }
  const bytes = new Uint8Array(await new Response(p.stdout).arrayBuffer())
  if (await p.exited !== 0) throw Error("python failed")
  return bytes
}

const layers = ["fabric-partition", "ceiling-tile-fissured", "carpet-dirty", "plastic-beige-rough"]
await py(`
import numpy as np
from PIL import Image
S=512
root=${JSON.stringify(resolve(source, "materials"))}
tiles=[]
for name in ${JSON.stringify(layers)}:
    def load(kind, mode):
        return Image.open(f"{root}/{name}/{name}_{kind}.webp").convert(mode).resize((S,S),Image.Resampling.LANCZOS)
    base=np.asarray(load("basecolor","L"),dtype=np.float32)
    detail=np.clip(base/max(base.mean(),1)*0.5,0,1)
    nrm=np.asarray(load("normal-gl","RGB"),dtype=np.float32)/255
    rough=np.asarray(load("roughness","L"),dtype=np.float32)/255
    tile=np.stack([detail,nrm[...,0],nrm[...,1],0.5+0.5*rough],-1)
    tiles.append((tile*255+0.5).astype(np.uint8))
Image.fromarray(np.concatenate(tiles,1),"RGBA").save(${JSON.stringify(resolve(out, "surfaces.webp"))},"WEBP",quality=90,alpha_quality=100,method=6)
`)

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const report: unknown[] = []
for (const { file, texture } of LOOK_PROP_FILES) {
  const input = await Bun.file(resolve(source, "glb", `${file}.glb`)).bytes(), doc = await io.readBinary(input)
  for (const t of doc.getRoot().listTextures()) {
    const image = await py(`
import io,sys
from PIL import Image
im=Image.open(io.BytesIO(sys.stdin.buffer.read()))
im=im.convert("RGBA" if im.mode in ("RGBA","LA","P") else "RGB")
im.thumbnail((${texture},${texture}),Image.Resampling.LANCZOS)
im.save(sys.stdout.buffer,"WEBP",quality=86,method=6)
`, t.getImage()!)
    t.setImage(image).setMimeType("image/webp")
  }
  // Some library props were cut from one shared scene and keep its offsets: centre every footprint on the origin.
  const positions = new Set(doc.getRoot().listMeshes().flatMap(m => m.listPrimitives().map(p => p.getAttribute("POSITION")!)))
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
  for (const a of positions) { const min = a.getMin([]), max = a.getMax([]); for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i]!, min[i]!); hi[i] = Math.max(hi[i]!, max[i]!) } }
  const shift = [(lo[0]! + hi[0]!) / 2, lo[1]!, (lo[2]! + hi[2]!) / 2]
  for (const a of positions) {
    const v = a.getArray()!
    for (let i = 0; i < v.length; i += 3) for (let k = 0; k < 3; k++) v[i + k]! -= shift[k]!
    a.setArray(v)
  }
  doc.createExtension(EXTTextureWebP).setRequired(true)
  const target = resolve(out, "props", `${file}.glb`)
  await io.write(target, doc)
  report.push({ file, sourceSha256: createHash("sha256").update(input).digest("hex"), sourceBytes: input.length, runtimeBytes: Bun.file(target).size, texture })
}
await Bun.write(resolve(out, "look-assets.json"), JSON.stringify({ layers, layerSize: 512, props: report }, null, 2))
console.log(JSON.stringify(report))
