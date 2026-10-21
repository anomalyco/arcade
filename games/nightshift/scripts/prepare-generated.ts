/** Preserve generated geometry; encode 1K colour/ORM maps into separate runtime GLBs. */
import { NodeIO } from "@gltf-transform/core"
import { EXTTextureWebP } from "@gltf-transform/extensions"
import { mkdir, readdir } from "node:fs/promises"
import { createHash } from "node:crypto"
import { resolve } from "node:path"

const source=process.argv[2]&&resolve(process.argv[2]),out=process.argv[3]&&resolve(process.argv[3]),only=process.argv[4]
if(!source||!out||source===out)throw new Error("Usage: prepare-generated.ts RAW_DIR OUTPUT_DIR (different directories)")
await mkdir(out,{recursive:true})
const io=new NodeIO().registerExtensions([EXTTextureWebP]),report=[]
for(const file of (await readdir(source)).filter(f=>f.endsWith(".glb")&&(!only||f===`${only}.glb`))) {
  const input=await Bun.file(resolve(source,file)).bytes(),doc=await io.readBinary(input)
  let screen:unknown
  if(file==="crt.glb") {
    const mesh=doc.getRoot().listMeshes()[0],p=mesh.listPrimitives()[0],texture=p.getMaterial()!.getBaseColorTexture()!
    const maskProcess=Bun.spawn(["uv","run","--with","pillow","python","-c",`
import io,sys
from PIL import Image
image=Image.open(io.BytesIO(sys.stdin.buffer.read())).convert("RGB")
sys.stdout.buffer.write(bytes(255 if g>r*1.08 and g>b*1.2 and 25<g<100 else 0 for r,g,b in image.getdata()))
`],{stdin:"pipe",stdout:"pipe",stderr:"inherit"})
    maskProcess.stdin.write(texture.getImage()!);maskProcess.stdin.end()
    const mask=await new Response(maskProcess.stdout).bytes()
    if(await maskProcess.exited!==0)throw new Error("CRT segmentation failed")
    const [width,height]=texture.getSize()!,uv=p.getAttribute("TEXCOORD_0")!,indices=p.getIndices()!,normal=p.getAttribute("NORMAL")!
    const body:number[]=[],glass:number[]=[],direction=[0,0,0]
    for(let i=0;i<indices.getCount();i+=3) {
      const face=[0,1,2].map(k=>indices.getScalar(i+k)),coords=face.map(v=>uv.getElement(v,[]))
      const u=coords.reduce((n,v)=>n+v[0],0)/3,v=coords.reduce((n,v)=>n+v[1],0)/3
      const green=mask[Math.min(height-1,Math.max(0,Math.floor(v*height)))*width+Math.min(width-1,Math.max(0,Math.floor(u*width)))]>0
      ;(green?glass:body).push(...face)
      if(green)for(const index of face){const n=normal.getElement(index,[]);for(let k=0;k<3;k++)direction[k]+=n[k]}
    }
    if(glass.length<300||glass.length>indices.getCount()*.3)throw new Error(`Unexpected CRT screen segmentation: ${glass.length/3} triangles`)
    const index=(name:string,values:number[])=>doc.createAccessor(name).setType("SCALAR").setArray(new Uint32Array(values)).setBuffer(indices.getBuffer()!)
    const material=p.getMaterial()!.clone().setName("Phosphor glass").setBaseColorFactor([.03,.6,.8,1]).setRoughnessFactor(.17).setMetallicFactor(0)
    const screenPrimitive=p.clone().setIndices(index("screen",glass)).setMaterial(material)
    p.setIndices(index("body",body));mesh.addPrimitive(screenPrimitive)
    const length=Math.hypot(...direction)
    screen={triangles:glass.length/3,frontNormal:direction.map(n=>n/length)}
  }
  const colour=new Set(doc.getRoot().listMaterials().map(m=>m.getBaseColorTexture()))
  for(const texture of doc.getRoot().listTextures()) {
    const encode=Bun.spawn(["uv","run","--with","pillow","python","-c",`
import io,sys
from PIL import Image
image=Image.open(io.BytesIO(sys.stdin.buffer.read())).convert("RGB")
image.thumbnail((1024,1024),Image.Resampling.LANCZOS)
image.save(sys.stdout.buffer,"WEBP",quality=92,lossless=${colour.has(texture)?"False":"True"})
`],{stdin:"pipe",stdout:"pipe",stderr:"inherit"})
    encode.stdin.write(texture.getImage()!);encode.stdin.end()
    const image=new Uint8Array(await new Response(encode.stdout).arrayBuffer())
    if(await encode.exited!==0)throw new Error(`Texture encoding failed: ${file}`)
    texture.setImage(image).setMimeType("image/webp")
  }
  doc.createExtension(EXTTextureWebP).setRequired(true)
  await io.write(resolve(out,file),doc)
  report.push({file,sourceSha256:createHash("sha256").update(input).digest("hex"),sourceBytes:input.length,runtimeBytes:Bun.file(resolve(out,file)).size,screen,
    triangles:doc.getRoot().listMeshes().flatMap(m=>m.listPrimitives()).reduce((n,p)=>n+(p.getIndices()?.getCount()??p.getAttribute("POSITION")!.getCount())/3,0)})
}
await Bun.write(resolve(out,only?`${only}-generation.json`:"generation.json"),JSON.stringify({source:"Original gpt-image-2 product shots → TRELLIS.2, textured 512 pipeline",textureSize:1024,assets:report},null,2))
console.log(JSON.stringify(report,null,2))
