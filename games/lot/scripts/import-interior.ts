import { plugin } from "bun"
import { mkdir, readFile } from "node:fs/promises"
import { resolve } from "node:path"
import * as THREE from "three"
import { MAT } from "@arcade/kit/gpu/mesh"
import { packTexturedVerts } from "@arcade/kit/gpu/textured-mesh"

// Read-only, build-time execution of the authored builders. No Three runtime ships.
const source=resolve(process.argv[2] ?? "/Users/kit/worktrees/arcade/afterhours-preview/games/afterhours")
const out=resolve(import.meta.dir,"../public/interior")
await mkdir(out,{recursive:true})
const sources:Record<string,string>={}
const threeRoot=resolve(import.meta.resolve("three").replace("file://",""),"../..")
const adapter=resolve(import.meta.dir,"interior-materials.ts")
const placements:unknown[]=[]
const doors:THREE.Object3D[]=[]
Object.assign(globalThis,{__interiorPlacements:placements})
plugin({name:"interior-offline",setup(b){
  b.onLoad({filter:/afterhours\/src\/.*\.ts$/},async args=>{
    let text=await readFile(args.path,"utf8")
    sources[args.path.slice(source.length+1)]=new Bun.CryptoHasher("sha256").update(text).digest("hex")
    if(args.path.endsWith("/render/materials.ts")) return {contents:`export * from ${JSON.stringify(adapter)}`,loader:"ts"}
    if(args.path.endsWith("/render/signs.ts")) return {contents:`import { materialFor } from ${JSON.stringify(adapter)}; export function exitSignMaterial(){return materialFor("exit",{color:0xffffff,emissive:0xffffff,intensity:0.7,name:"interior_exit_sign"})}`,loader:"ts"}
    if(args.path.endsWith("/render/shared.ts")) return {contents:"export const renderState={lamps:[]}; export const FLASH_REACH_AT=0.01; export function addControls(){}; export function num(){return 1}; export function flag(){return false}",loader:"ts"}
    if(args.path.endsWith("/render/documents.ts")) text=text.replace(/return \(material \?\?= atlasMaterial\([^\n]+/,`return (material ??= new THREE.MeshStandardMaterial({color:0xffffff,name:"interior_documents"}))`)
    if(args.path.endsWith("/world/interior/props.ts")) text=text.replace('if (!props.length) return',`if (!props.length) return; globalThis.__interiorPlacements.push({name,props});
      if(["office_desk","desk_lamp","security_camera","wet_floor_sign","stack_chair"].includes(name)) for(const p of props) {
        if((p.collide??true)&&!p.tilt) b.ctx.colliders.push(modelCollider(name,p,p.inset??0.03));
      }
      return`)
    // The source's TSL glow is represented explicitly in the exported material record.
    if(args.path.endsWith("/world/interior/kit.ts")) text=text.replace('return { material: m, level: u }','m.emissive.setRGB(...tint); m.emissiveIntensity=level*1.6; return { material: m, level: u }')
    text=text.replaceAll("import.meta.env.BASE_URL",'"/"')
    text=text.replace(/(["'])three(?:\/([^"']+))?\1/g,(_m,_q,s)=>JSON.stringify(resolve(threeRoot,!s?"build/three.module.js":s==="webgpu"?"build/three.webgpu.js":s==="tsl"?"build/three.tsl.js":s.replace("addons/","examples/jsm/"))))
    return {contents:text,loader:"ts"}
  })
}})
const mod=(p:string):Promise<any>=>import(resolve(source,"src",p))
const root=new THREE.Group()
const ctx:any={scene:root,params:new URLSearchParams("shot=1"),settings:{},lamps:[],colliders:[],floors:[],ladders:[],doors:{add(p:any){
  if(p.leaf){p.leaf.position.set(...p.hinge);p.leaf.rotation.y+=(p.startOpen??0)*p.openAngle;doors.push(p.leaf)}
  return {isOpen:!!p.startOpen,amount:p.startOpen??0,open(){},close(){}}
}}}
const {Builder}=await mod("world/interior/kit.ts")
const b=new Builder(ctx,"storey-0",0)
await (await mod("world/interior/storeys/s0.ts")).build(b,{storey:0,pause:async()=>{}})
b.flush(root)
root.updateMatrixWorld(true)
for(const leaf of doors){const box=new THREE.Box3().setFromObject(leaf);ctx.colliders.push({min:box.min.toArray(),max:box.max.toArray()})}
const batches=new Map<string,{v:number[];uv:number[];roughness:number;metalness:number;alpha:number;name:string}>()
root.traverse(object=>{
  const o=object as THREE.Mesh
  if(!o.isMesh || !o.geometry.getAttribute("position")) return
  const g=o.geometry, mats=Array.isArray(o.material)?o.material:[o.material]
  const groups=Array.isArray(o.material)?g.groups:[{start:0,count:g.index?.count??g.getAttribute("position").count,materialIndex:0}]
  for(const group of groups){
    const m=mats[group.materialIndex??0] as THREE.MeshStandardMaterial
    if(m.name.includes("contact_blob")) continue
    const pos=g.getAttribute("position"),norm=g.getAttribute("normal"),uv=g.getAttribute("uv"),col=g.getAttribute("color"),rm=g.getAttribute("rm")
    const nm=new THREE.Matrix3().getNormalMatrix(o.matrixWorld)
    const glow=m.emissiveIntensity>0 && m.emissive && m.emissive.r+m.emissive.g+m.emissive.b>0
    for(let start=group.start;start<group.start+group.count;start+=3){
      const idx=[0,1,2].map(j=>g.index?.getX(start+j)??start+j)
      const points=idx.map(k=>new THREE.Vector3().fromBufferAttribute(pos,k).applyMatrix4(o.matrixWorld))
      // Front-of-house only, including security, receiving edges and corridor door reveals.
      if(points.every(p=>p.z < -3.2) || points.every(p=>p.z>22) || points.every(p=>p.y>3.55)) continue
      const rough=rm?rm.getX(idx[0]!):m.roughness??0.8, metal=rm?rm.getY(idx[0]!):m.metalness??0
      const key=`${m.name}:${rough.toFixed(2)}:${metal.toFixed(2)}`
      let batch=batches.get(key)
      if(!batch){batch={v:[],uv:[],roughness:rough,metalness:metal,alpha:m.transparent?m.opacity:1,name:m.name};batches.set(key,batch)}
      for(let j=0;j<3;j++){
        const k=idx[j]!,p=points[j]!,n=new THREE.Vector3().fromBufferAttribute(norm,k).applyMatrix3(nm).normalize()
        const c=(glow?m.emissive:m.color??new THREE.Color(1,1,1)).clone()
        if(col)c.multiply(new THREE.Color(col.getX(k),col.getY(k),col.getZ(k)))
        c.convertLinearToSRGB()
        batch.v.push(p.x,p.y,p.z,n.x,n.y,n.z,c.r,c.g,c.b,glow?MAT.glow:MAT.lit,glow?m.emissiveIntensity:0)
        batch.uv.push(uv?.getX(k)??0,uv?.getY(k)??0)
      }
    }
  }
})
const records:{file:string;name:string;roughness:number;metalness:number;alpha:number;triangles:number}[]=[]
for(const batch of batches.values()){
  if(!batch.v.every(Number.isFinite)||!batch.uv.every(Number.isFinite))throw Error(`Invalid ${batch.name}`)
  const file=`mesh-${records.length}.bin.gz`
  await Bun.write(`${out}/${file}`,Bun.gzipSync(new Uint8Array(packTexturedVerts(batch.v,batch.uv))))
  records.push({file,name:batch.name,roughness:batch.roughness,metalness:batch.metalness,alpha:batch.alpha,triangles:batch.v.length/33})
}
await Bun.write(`${out}/scene.json`,JSON.stringify({version:1,records,lamps:ctx.lamps,colliders:ctx.colliders,floors:ctx.floors,placements,sources},null,2))
console.log(JSON.stringify({materials:records.length,triangles:records.reduce((s,r)=>s+r.triangles,0),lamps:ctx.lamps.length,placements:placements.length}))
