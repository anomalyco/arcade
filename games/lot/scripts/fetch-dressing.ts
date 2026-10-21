import { NodeIO } from "@gltf-transform/core"
import { ALL_EXTENSIONS } from "@gltf-transform/extensions"
import { vec3 } from "wgpu-matrix"

// Original-source CC0 props used by Ashwood's compound/models.ts. Preserve source
// geometry/textures, centre and ground the pivot exactly as its asset pipeline does.
const io=new NodeIO().registerExtensions(ALL_EXTENSIONS)
const out=new URL("../public/assets/",import.meta.url)
const provenance:Record<string,unknown>={}
for(const [id,keep] of [["metal_trash_can",/_rust/],["utility_box_01",null]] as const) {
  const response=await fetch(`https://api.polyhaven.com/files/${id}`)
  if(!response.ok) throw new Error(`${id}: ${response.status}`)
  const files=await response.json()
  const asset=files.gltf["1k"].gltf as {url:string;include:Record<string,{url:string}>}
  const json=await (await fetch(asset.url)).json()
  const resources:Record<string,Uint8Array<ArrayBuffer>>={}
  for(const [name,file] of Object.entries(asset.include)) {
    const r=await fetch(file.url)
    if(!r.ok) throw new Error(`${file.url}: ${r.status}`)
    resources[name]=new Uint8Array(await r.arrayBuffer())
  }
  const doc=await io.readJSON({json,resources})
  const scene=doc.getRoot().getDefaultScene()!
  for(const node of doc.getRoot().listNodes()) if(node.getMesh() && keep && !keep.test(node.getName())) node.dispose()
  const lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity]
  scene.traverse(node=>{
    for(const p of node.getMesh()?.listPrimitives() ?? []) {
      const a=p.getAttribute("POSITION")!
      for(let i=0;i<a.getCount();i++) {
        const v=vec3.transformMat4(a.getElement(i,[]),node.getWorldMatrix())
        for(let k=0;k<3;k++) { lo[k]=Math.min(lo[k]!,v[k]!); hi[k]=Math.max(hi[k]!,v[k]!) }
      }
    }
  })
  if(!lo.every(Number.isFinite)) throw new Error(`No geometry selected: ${id}`)
  const root=doc.createNode("Lot: ground-centred, source metres").setTranslation([-(hi[0]!+lo[0]!)/2,-lo[1]!,-(hi[2]!+lo[2]!)/2])
  for(const child of scene.listChildren()) root.addChild(child)
  scene.addChild(root)
  const bytes=await io.writeBinary(doc)
  await Bun.write(new URL(`${id}.glb`,out),bytes)
  provenance[id]={license:"CC0-1.0",source:`https://polyhaven.com/a/${id}`,download:asset.url,sha256:new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),lo,hi}
  console.log(id,bytes.byteLength)
}
await Bun.write(new URL("dressing-metadata.json",out),JSON.stringify(provenance,null,2))
