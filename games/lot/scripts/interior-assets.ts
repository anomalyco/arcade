import { NodeIO } from "@gltf-transform/core"
import { ALL_EXTENSIONS } from "@gltf-transform/extensions"
import { MeshoptDecoder } from "meshoptimizer"
import { readFile, mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { createRequire } from "node:module"

// Decode CC0 source props and our repository-authored paper atlas offline. Basis never ships in Lot.
const source=resolve(process.argv[2]??"/Users/kit/worktrees/arcade/afterhours-preview/games/afterhours")
const out=resolve(import.meta.dir,"../public/interior")
await mkdir(out,{recursive:true})
const basisDir=resolve(source,"public/textures/basis")
const module={exports:undefined as any}
new Function("module","exports","require","__dirname",await readFile(`${basisDir}/basis_transcoder.js`,"utf8"))(module,{},createRequire(import.meta.url),basisDir)
const basis=await module.exports({wasmBinary:await readFile(`${basisDir}/basis_transcoder.wasm`)})
basis.initializeBasis()
async function png(data:Uint8Array,w:number,h:number){
  const p=Bun.spawn(["magick","-size",`${w}x${h}`,"-depth","8","rgba:-","png:-"],{stdin:data,stdout:"pipe",stderr:"pipe"})
  const bytes=new Uint8Array(await new Response(p.stdout).arrayBuffer())
  if(await p.exited)throw Error(await new Response(p.stderr).text())
  return bytes
}
async function decode(bytes:Uint8Array){
  const f=new basis.KTX2File(bytes)
  try{
    if(!f.isValid()||!f.startTranscoding())throw Error("Invalid KTX2")
    const w=f.getWidth(),h=f.getHeight(),rgba=new Uint8Array(f.getImageTranscodedSizeInBytes(0,0,0,13))
    if(!f.transcodeImage(rgba,0,0,0,13,0,-1,-1))throw Error("Basis RGBA decode failed")
    return await png(rgba,w,h)
  }finally{f.close();f.delete()}
}
const io=new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({"meshopt.decoder":MeshoptDecoder})
const names=["office_desk","desk_lamp","security_camera","wet_floor_sign","stack_chair"]
const credits=await readFile(`${source}/public/models/CREDITS.md`,"utf8")
for(const name of names){
  const doc=await io.read(`${source}/public/models/${name}.glb`)
  for(const t of doc.getRoot().listTextures())if(t.getMimeType()==="image/ktx2")t.setImage(await decode(t.getImage()!)).setMimeType("image/png")
  // Native vertices + PNG maps: remove encoding-only declarations after decode.
  for(const e of doc.getRoot().listExtensionsUsed())if(["KHR_texture_basisu","EXT_meshopt_compression"].includes(e.extensionName))e.dispose()
  await Bun.write(`${out}/${name}.glb`,await io.writeBinary(doc))
  console.log("Decoded CC0 prop",name)
}
for(const kind of ["base","normal","orm"])await Bun.write(`${out}/documents-${kind}.png`,await decode(await readFile(`${source}/public/models/documents/${kind}.ktx2`)))
const rows=credits.split("\n").filter(line=>names.some(name=>line.startsWith(`| \`${name}.glb\``)))
await Bun.write(`${out}/PROP-CREDITS.md`,[
  "# Lot interior props", "", "All five imported props are CC0 1.0, from Poly Haven (https://polyhaven.com/license).",
  "Source-normalized meshes retain metre scale and transforms; Basis textures are decoded offline to PNG.",
  "The CRT, telephone, office chair and filing cabinets are authored in src/interior/props.ts.", "",
  "| File | Asset | Author / site | Licence | Tris | Source size | Use |", "| --- | --- | --- | --- | --- | --- | --- |", ...rows, "",
].join("\n"))
await Bun.write(`${out}/DOCUMENT-CREDITS.md`,await readFile(`${source}/public/models/documents/CREDITS.md`))

// Seeded, authored grayscale finish maps. Colour stays in the exported material/vertex data.
let seed=71
const rnd=()=>((seed=Math.imul(seed,1664525)+1013904223>>>0)/4294967296)
for(const kind of ["tile","terrazzo","vinyl","plaster","ceiling"]){
  const size=256,data=new Uint8Array(size*size*4),orm=new Uint8Array(data.length)
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const i=(y*size+x)*4,n=rnd(),line=kind==="tile"?(x%64<2||y%64<2):(kind==="terrazzo"||kind==="vinyl")&&(x<2||y<2)
    const grain=kind==="terrazzo"?(n<0.16?0.48:n<0.34?0.76:0.94):kind==="ceiling"?(n<0.06?0.65:0.94):0.94+n*0.06
    const c=Math.round(255*(line?0.47:grain))
    data.set([c,c,c,255],i);orm.set([255,Math.round(line?255:220+n*35),255,255],i)
  }
  await Bun.write(`${out}/${kind}.png`,await png(data,size,size))
  await Bun.write(`${out}/${kind}-orm.png`,await png(orm,size,size))
}
// Own typographic sign, no external font asset embedded.
const sign=Bun.spawn(["magick","-size","512x200","xc:#310704","-fill","#ffccac","-font","/System/Library/Fonts/Supplemental/Arial Bold.ttf","-pointsize","128","-gravity","center","-annotate","+0+0","EXIT",`${out}/exit.png`],{stdout:"ignore",stderr:"inherit"})
if(await sign.exited)throw Error("Exit sign generation failed")
