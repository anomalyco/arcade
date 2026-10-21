import { NodeIO, type Node } from "@gltf-transform/core"
import { ALL_EXTENSIONS } from "@gltf-transform/extensions"
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js"
import { resolve } from "node:path"
import { mkdir } from "node:fs/promises"
import { sourceDecoder, png } from "./decode-source"

const source=resolve(process.argv[2] ?? "../afterhours-preview/games/afterhours")
const out=resolve(import.meta.dir,"../public/ashwood/models")
await mkdir(out,{recursive:true})
const scene=await Bun.file(resolve(import.meta.dir,"../public/ashwood/scene.json")).json()
for(const p of scene.props) if(p.included && p.name!=="car_wagon" && p.license!=="CC0-1.0") throw new Error(`Unapproved prop licence: ${p.name} (${p.license})`)
const decode=await sourceDecoder(source)
await MeshoptDecoder.ready
const io=new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({"meshopt.decoder":MeshoptDecoder})
const sources:Record<string,unknown>={}
for(const name of new Set<string>(scene.props.filter((p:any)=>p.included && p.name!=="car_wagon").map((p:any)=>p.name))) {
  const bytes=await Bun.file(`${source}/public/models/${name}.glb`).bytes()
  const doc=await io.readBinary(bytes)
  // The source puts both LODs in its GLB; loading both would cause z-fighting.
  for(const node of doc.getRoot().listNodes()) if(node.getName()==="lod1") {
    node.traverse(n=>n.setMesh(null))
    node.dispose()
  }
  for(const texture of doc.getRoot().listTextures()) {
    if(texture.getMimeType()!=="image/ktx2") continue
    const image=decode(texture.getImage()!)
    texture.setImage(await png(image.data,image.width,image.height)).setMimeType("image/png")
  }
  for(const ext of doc.getRoot().listExtensionsUsed()) if(ext.extensionName==="KHR_texture_basisu" || ext.extensionName==="EXT_meshopt_compression") ext.dispose()
  const target=doc.getRoot().getDefaultScene()!
  const templates=target.listChildren()
  for(const node of templates) target.removeChild(node)
  const clone=(node:Node):Node=>{
    const next=doc.createNode(node.getName()).setMatrix(node.getMatrix()).setMesh(node.getMesh())
    for(const child of node.listChildren()) next.addChild(clone(child))
    return next
  }
  for(const p of scene.props.filter((p:any)=>p.name===name && p.included)) {
    const parent=doc.createNode(name+" placement").setTranslation(p.position).setRotation([0,Math.sin(p.yaw/2),0,Math.cos(p.yaw/2)])
    const tilt=doc.createNode("source tilt").setMatrix(p.tilt)
    for(const node of templates) tilt.addChild(clone(node))
    target.addChild(parent.addChild(tilt))
  }
  await Bun.write(`${out}/${name}.glb`,await io.writeBinary(doc))
  sources[name]={license:"CC0-1.0",sourceSha256:new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}
  console.log("Prop",name)
}
await Bun.write(`${out}/sources.json`,JSON.stringify(sources,null,2))
const credits=await Bun.file(`${source}/public/models/CREDITS.md`).text()
await Bun.write(`${out}/CREDITS.md`,"# Imported CC0 props\n\nSource atlases decoded to PNG; source metre normalization retained; LOD0 only.\n\n"+credits.split("\n").filter(l=>l.startsWith("| File") || l.startsWith("| ---") || [...Object.keys(sources)].some(n=>l.startsWith(`| \`${n}.glb\``))).join("\n"))
