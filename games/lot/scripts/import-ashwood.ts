import { plugin } from "bun"
import { mkdir, readFile, readdir, unlink } from "node:fs/promises"
import { resolve } from "node:path"
import * as THREE from "three"
import { packVerts, MAT } from "@arcade/kit/gpu/mesh"
import { packTexturedVerts } from "@arcade/kit/gpu/textured-mesh"
import { windowAux, type RoomKind } from "@arcade/kit/gpu/materials/rooms"
import { recipes } from "./surface-recipes"

// Offline conversion of Aiden's actual builders, not a second runtime renderer.
// Usage: bun scripts/import-ashwood.ts /path/to/afterhours
// The source checkout is read-only. Provenance records every loaded source hash.
const source = resolve(process.argv[2] ?? "../afterhours-preview/games/afterhours")
const out = resolve(import.meta.dir, "../public/ashwood")
await mkdir(out, { recursive: true })
const sources: Record<string, string> = {}
const materials = resolve(import.meta.dir, "ashwood-materials.ts")
const forest = resolve(import.meta.dir, "ashwood-forest.ts")
const threeRoot = resolve(import.meta.resolve("three").replace("file://", ""), "../..")
const modelSource=await readFile(resolve(source,"src/render/models.ts"),"utf8")
const modelBlock=modelSource.match(/export const MODELS = (\{[\s\S]*?\n\}) as const/)?.[1]
if(!modelBlock) throw new Error("Missing source model metadata")
const modelInfo=Function(`return (${modelBlock})`)() as Record<string,{size:number[];licence:string}>
const modelStub=`export const MODELS=${JSON.stringify(modelInfo)}; export const yawToward=(x,z)=>Math.atan2(-x,-z);
export const modelCollider=(name,p,inset=0)=>{const [w,h,d]=MODELS[name].size;const c=Math.abs(Math.cos(p.yaw??0)),s=Math.abs(Math.sin(p.yaw??0));const x=(w*c+d*s)/2-inset,z=(w*s+d*c)/2-inset;return {min:[p.position[0]-x,p.position[1],p.position[2]-z],max:[p.position[0]+x,p.position[1]+h,p.position[2]+z]}};
export const loadModel=()=>{throw new Error('Models are exported separately')};`
plugin({ name: "ashwood-offline", setup(b) {
  b.onResolve({ filter: /^three(?:\/.*)?$/ }, args => ({ path: resolve(threeRoot,
    args.path === "three" ? "build/three.module.js" : args.path === "three/webgpu" ? "build/three.webgpu.js" : args.path === "three/tsl" ? "build/three.tsl.js" : args.path.replace("three/addons/", "examples/jsm/")) }))
  b.onLoad({ filter: /afterhours\/src\/.*\.ts$/ }, async args => {
    let text = await readFile(args.path, "utf8")
    sources[args.path.slice(source.length + 1)] = new Bun.CryptoHasher("sha256").update(text).digest("hex")
    if (args.path.endsWith("/render/materials.ts")) return { contents: `export * from ${JSON.stringify(materials)}`, loader: "ts" }
    if (args.path.endsWith("/render/models.ts")) return { contents: modelStub, loader: "ts" }
    if (args.path.endsWith("/compound/models.ts")) text=text.replace("function items()", "export function items()")
    // Canvas lettering on the distant north-gate sign is not part of the static mesh adapter.
    if (args.path.endsWith("/compound/north.ts")) text=text.replace("if (signMat) return signMat", 'return material("metal_painted")')
    if (args.path.endsWith("/facility/props.ts")) text=text.replace("contactShadows(root, blobs)", "return [...lists].flatMap(([name,items])=>items.map(item=>({name,...item})))")
    if (args.path.endsWith("/world/forest/render.ts")) return { contents: `export * from ${JSON.stringify(forest)}`, loader: "ts" }
    if (args.path.endsWith("/render/shared.ts")) return { contents: "export const renderState={lamps:[]}; export function addControls(){}; export function num(){return 1}", loader: "ts" }
    // Bun resolves dependencies of a source checkout outside this workspace before
    // onResolve in some versions. Bind its Three imports to our build-time dependency.
    const contents=text.replace(/(["'])three(?:\/([^"']+))?\1/g, (_match, _quote, subpath) => JSON.stringify(resolve(threeRoot,
      !subpath ? "build/three.module.js" : subpath==="webgpu" ? "build/three.webgpu.js" : subpath==="tsl" ? "build/three.tsl.js" : subpath.replace("addons/","examples/jsm/"))))
    return { contents, loader: "ts" }
  })
} })
const mod = (path: string): Promise<any> => import(resolve(source, "src", path))
const root = new THREE.Group()
const ctx: any = { scene: root, settings: {}, lamps: [], colliders: [], floors: [], ladders: [], renderer: { reversedDepthBuffer: false, getDrawingBufferSize: (v: THREE.Vector2) => v.set(1920,1080) },
  doors: { add(p: any) { if (p.leaf) { p.leaf.position.set(...p.hinge); p.leaf.rotation.y += (p.startOpen ?? 0) * p.openAngle }; return { isOpen: false, amount: 0, open() {}, close() {} } } } }
for (const [path, fn] of [["compound/booth.ts", "buildBooth"], ["compound/fence.ts", "buildFence"], ["compound/gate.ts", "buildGate"], ["compound/north.ts", "buildNorth"], ["compound/lot.ts", "buildLot"], ["compound/props.ts", "buildProps"], ["facility/shell.ts", "buildShell"]]) {
  console.log("Bake", path)
  ;(await mod("world/" + path))[fn!](ctx, root,0.03)
}
const geo = await mod("world/facility/geo.ts")
const dishBatch = new geo.Batch()
const dish=(await mod("world/facility/dish.ts")).buildDish(ctx, root, dishBatch)
const facilitySource=await readFile(resolve(source,"src/world/facility.ts"),"utf8")
sources["src/world/facility.ts"]=new Bun.CryptoHasher("sha256").update(facilitySource).digest("hex")
const defaultsBlock=facilitySource.match(/const DEFAULTS = (\{[\s\S]*?\n\})/)?.[1]
if(!defaultsBlock) throw new Error("Missing facility defaults")
const facilityDefaults=JSON.parse(defaultsBlock.replace(/,\s*}/g,"}"))
dish.update(0,{tilt:facilityDefaults["facility.dishTilt"],yaw:facilityDefaults["facility.dishYaw"]},facilityDefaults["facility.beaconPeriod"])
dishBatch.flush(root)
const grounds = new geo.Batch()
;(await mod("world/facility/grounds.ts")).buildGrounds(ctx, grounds, root)
;(await mod("world/facility/roof.ts")).buildRoof(ctx, grounds)
;(await mod("world/facility/dock.ts")).buildDock(ctx, grounds, root)
;(await mod("world/facility/annex.ts")).buildAnnex(ctx, grounds)
grounds.flush(root)
await geo.flushWorld()
const layout = await mod("world/layout.ts")
const road = await mod("world/roads/util.ts")
const surface = await mod("world/roads/surface.ts")
const access = new road.Line(layout.accessRoadSamples(1)), county = new road.Line(layout.countyRoadSamples(-700,700,1))
const junction = surface.junctionFor(access, county)
surface.buildSurface(root, access, county, junction)
const parts = new road.Parts()
const wires = new (await mod("world/roads/wires.ts")).Wires()
const power=(await mod("world/roads/power.ts")).buildPower(ctx, parts, wires, access, junction)
;(await mod("world/roads/lights.ts")).buildLights(ctx,parts,wires,access,county,junction,power.corner,power.countyPoles)
;(await mod("world/roads/furniture.ts")).buildFurniture(ctx,parts,access,county,junction,power.accessPoles)
parts.build(root, "power", { castShadow: true }); wires.build(root, ctx.renderer)
const height=await mod("world/height.ts")
const last=power.accessPoles.at(-1)
const propItems=[...(await mod("world/compound/models.ts")).items(),...(await mod("world/facility/props.ts")).buildProps({...ctx,colliders:[]},root),
  {name:"utility_box_b",position:[last.x+0.75,height.heightAt(last.x+0.75,last.z),last.z+0.2],yaw:Math.PI/2,inset:0}]
const props=propItems.map((p:any)=>{
  const pivot=new THREE.Group(); p.tilt?.(pivot); pivot.updateMatrix()
  return {name:p.name,position:p.position,yaw:p.yaw ?? 0,tilt:pivot.matrix.toArray(),license:modelInfo[p.name]!.licence,
    included:p.name==="car_wagon" || modelInfo[p.name]!.licence==="CC0-1.0"}
})
for(const p of propItems) if(modelInfo[p.name]!.licence==="CC0-1.0" && p.inset!==undefined) {
  const [w,h,d]=modelInfo[p.name]!.size, c=Math.abs(Math.cos(p.yaw??0)),s=Math.abs(Math.sin(p.yaw??0))
  const x=(w!*c+d!*s)/2-p.inset,z=(w!*s+d!*c)/2-p.inset
  ctx.colliders.push({min:[p.position[0]-x,p.position[1],p.position[2]-z],max:[p.position[0]+x,p.position[1]+h!,p.position[2]+z]})
}

// Main-block windows are backed by actual room state in Ashwood. Bake those very same bays/tints.
const state = await mod("world/interior/lighting-state.ts")
const windowPanes: { obj: THREE.Mesh; kind: RoomKind; brightness: number; tint: THREE.Color }[] = []
for (const w of state.litWindows()) {
  const g = new THREE.PlaneGeometry(w.u1-w.u0-0.12, w.head-w.sill-0.12)
  const m = new THREE.MeshStandardMaterial({ color: 0, emissive: new THREE.Color(w.tint[0],w.tint[1],w.tint[2]), emissiveIntensity: w.strength * 0.6 })
  m.name = "window-proxy"
  const obj = new THREE.Mesh(g,m), u=(w.u0+w.u1)/2
  obj.position.y=0.15+w.storey*3.8+(w.sill+w.head)/2
  if (w.face === "south") obj.position.set(u,obj.position.y,21.9)
  if (w.face === "north") { obj.position.set(u,obj.position.y,-21.9); obj.rotation.y=Math.PI }
  if (w.face === "west") { obj.position.set(-54.9,obj.position.y,u); obj.rotation.y=-Math.PI/2 }
  if (w.face === "east") { obj.position.set(34.9,obj.position.y,u); obj.rotation.y=Math.PI/2 }
  root.add(obj)
  // The same pane for the interior-mapped window pass (Lot › Glass › Lit windows), 3 cm proud of the flat proxy so
  // Today (the proxy alone) stays exact. Kind follows Ashwood's room state.
  const pane = new THREE.Mesh(g.clone(), m)
  pane.position.copy(obj.position); pane.rotation.copy(obj.rotation); pane.translateZ(0.03)
  const kind: RoomKind = w.lit==="full" ? (w.storey===2 ? "lab" : (w.room.charCodeAt(w.room.length-1)%3===0 ? "conference" : "office")) : w.lit
  windowPanes.push({ obj: pane, kind, brightness: w.strength * 0.6, tint: new THREE.Color(w.tint[0],w.tint[1],w.tint[2]) })
}
// Dark bays get the same front glass (sky reflection, mullions) over their dark backing, with no room light.
const plan = await mod("world/interior/plan.ts")
for (let storey=0; storey<5; storey++) for (const face of ["north","south","west","east"] as const) for (const w of plan.WINDOWS(storey, face)) {
  if (state.windowLight(storey, face, (w.u0+w.u1)/2)) continue
  const pane = new THREE.Mesh(new THREE.PlaneGeometry(w.u1-w.u0-0.12, w.head-w.sill-0.12)), u=(w.u0+w.u1)/2, y=0.15+storey*3.8+(w.sill+w.head)/2
  if (face === "south") pane.position.set(u,y,21.9)
  if (face === "north") { pane.position.set(u,y,-21.9); pane.rotation.y=Math.PI }
  if (face === "west") { pane.position.set(-54.9,y,u); pane.rotation.y=-Math.PI/2 }
  if (face === "east") { pane.position.set(34.9,y,u); pane.rotation.y=Math.PI/2 }
  pane.translateZ(0.03)
  windowPanes.push({ obj: pane, kind: "office", brightness: 0, tint: new THREE.Color(1,1,1) })
}

const streams: Record<string, { v: number[]; uv: number[] }> = Object.fromEntries(["solid","ground","foliage","fence","glass","stain","undergrowth","windows",...Object.keys(recipes).map(n=>`surface-${n}`)].map(k=>[k,{v:[],uv:[]}]))
function emit(g: THREE.BufferGeometry, matrix: THREE.Matrix4, m: THREE.MeshStandardMaterial, kind: string, tint=1, first=0, count=g.index?.count ?? g.getAttribute("position").count) {
  if (!g.getAttribute("normal")) g.computeVertexNormals()
  const p=g.getAttribute("position"), n=g.getAttribute("normal"), uv=g.getAttribute("uv"), vc=g.getAttribute("color"), pane=g.getAttribute("paneA"), flex=g.getAttribute("flex")
  const target=streams[kind]!, v=new THREE.Vector3(), normal=new THREE.Vector3(), nm=new THREE.Matrix3().getNormalMatrix(matrix)
  for(let i=first;i<first+count;i++) {
    const k=g.index?.getX(i) ?? i
    v.fromBufferAttribute(p,k).applyMatrix4(matrix); normal.fromBufferAttribute(n,k).applyMatrix3(nm).normalize()
    // Source stair glow is only 5 mm ahead of transparent glass. Making that glass an
    // opaque backing at 130 m quantizes both depths together in depth24plus. Move the
    // backing into the reveal, not the glow out over the mullions (or disable TAA).
    if(m.name==="window-backing" && v.z>24.9) v.z-=0.08
    const glow=kind!=="glass" && m.emissiveIntensity > 0 && m.emissive && (m.emissive.r+m.emissive.g+m.emissive.b)>0
    const recipe=recipes[m.userData.library]
    let c=(glow?m.emissive:m.color ?? new THREE.Color(0.1,0.1,0.1)).clone(), aux=glow?m.emissiveIntensity:0, mat:number=glow?MAT.glow:m.userData.library?.startsWith("asphalt")?MAT.ground:MAT.lit
    if(pane) { c.setRGB(pane.getX(k),pane.getY(k),pane.getZ(k)); aux=0.6; mat=MAT.glow }
    // Ashwood's card material shades limb and stem bases by this depth (forest/render.ts `vInner`); kit reads it from aux.
    if(flex && mat===MAT.lit && (kind==="foliage" || kind==="undergrowth")) aux=Math.min(1,Math.max(0,flex.getX(k)/1.6))
    if(kind==="stain") {
      const decal=g.getAttribute("decal")
      c.setRGB(decal.getX(k),decal.getY(k),decal.getZ(k)); aux=decal.getW(k); mat=MAT.lit
      v.addScaledVector(normal,0.02)
    }
    if(kind==="solid" && mat===MAT.lit && !pane) {mat=40;aux=Math.round(m.metalness*15)*2+m.roughness}
    if(vc) c.multiply(new THREE.Color(vc.getX(k),vc.getY(k),vc.getZ(k)))
    c.multiplyScalar(tint)
    if(mat===MAT.glow) {
      const peak=Math.max(1,c.r,c.g,c.b)
      c.multiplyScalar(1/peak); aux*=peak
    }
    // Kit vertex colours are sRGB; authored material colours are linear.
    c.convertLinearToSRGB()
    target.v.push(v.x,v.y,v.z,normal.x,normal.y,normal.z,c.r,c.g,c.b,mat,aux)
    // Ashwood's DataTexture atlas already uses top-left UVs (flipY=false).
    target.uv.push((uv?.getX(k) ?? 0)/(recipe?.size ?? 1),(uv?.getY(k) ?? 0)/(recipe?.size ?? 1))
  }
}
function emitObject(object: THREE.Object3D) {
  // Three's WebGPU and standard entry points can have distinct constructor identities.
  const o=object as THREE.Mesh
  if(!o.isMesh || !o.visible || !o.geometry.getAttribute("position")) return
  const materialList=Array.isArray(o.material)?o.material:[o.material]
  const groups=Array.isArray(o.material)?o.geometry.groups:[{start:0,count:o.geometry.index?.count ?? o.geometry.getAttribute("position").count,materialIndex:0}]
  for(const group of groups) {
  let m=materialList[group.materialIndex ?? 0] as THREE.MeshStandardMaterial
   if(m.name.includes("contact_shadow")) return
  // The walkable prototype omits indoor rooms. Back their plain panes with darkness
  // rather than letting the distant sky show through both sides of the empty shell.
  if(m.name==="facility_glass_clear") {
    m=new THREE.MeshStandardMaterial({color:0x050807})
    m.name="window-backing"
  }
   const kind=o.geometry.getAttribute("decal")?"stain":m.name==="chainlink"?"fence":recipes[m.userData.library]?`surface-${m.userData.library}`:m.transparent && m.opacity===0.35?"glass":m.name==="undergrowth"?"undergrowth":"solid"
  if(m.transparent && !m.emissiveIntensity && kind!=="fence" && kind!=="glass" && kind!=="stain" && m.name!=="overhead_wire" && !o.geometry.getAttribute("paneA")) return
  if((o as THREE.InstancedMesh).isInstancedMesh) {
    const mesh=o as THREE.InstancedMesh, matrix=new THREE.Matrix4(), tint=new THREE.Color()
    for(let i=0;i<mesh.count;i++) {
      mesh.getMatrixAt(i,matrix); mesh.getColorAt(i,tint)
      emit(o.geometry,new THREE.Matrix4().multiplyMatrices(o.matrixWorld,matrix),m,kind,tint.r,group.start,group.count)
    }
    continue
  }
  emit(o.geometry,o.matrixWorld,m,kind,1,group.start,group.count)
  }
}
root.updateMatrixWorld(true)
root.traverse(emitObject)
for (const p of windowPanes) {
  p.obj.updateMatrixWorld(true)
  const g=p.obj.geometry.index ? p.obj.geometry.toNonIndexed() : p.obj.geometry
  const pos=g.getAttribute("position"), uv=g.getAttribute("uv"), v=new THREE.Vector3(), n=new THREE.Vector3(0,0,1).transformDirection(p.obj.matrixWorld)
  const peak=Math.max(1,p.tint.r,p.tint.g,p.tint.b), c=p.tint.clone().multiplyScalar(1/peak).convertLinearToSRGB()
  for(let i=0;i<pos.count;i++) {
    v.fromBufferAttribute(pos,i).applyMatrix4(p.obj.matrixWorld)
    streams.windows!.v.push(v.x,v.y,v.z,n.x,n.y,n.z,c.r,c.g,c.b,MAT.lit,windowAux(p.kind,p.brightness*peak))
    streams.windows!.uv.push(uv.getX(i),uv.getY(i))
  }
}
// Source terrain heights and verge weights. A fixed high-detail exterior patch has
// no recenter seam; the outer mesh meets its border exactly rather than overlapping.
const terrainMat=(await import("./ashwood-materials")).material("forest_floor")
for(const [x0,z0,x1,z1,step] of [[-130,-140,130,300,1],[-700,-700,700,-140,10],[-700,300,700,700,10],[-700,-140,-130,300,10],[130,-140,700,300,10]]) {
  const nx=Math.round((x1!-x0!)/step!),nz=Math.round((z1!-z0!)/step!),positions:number[]=[],uvs:number[]=[],colors:number[]=[],indices:number[]=[]
  for(let j=0;j<=nz;j++) for(let i=0;i<=nx;i++) {
    const x=x0!+i*step!,z=z0!+j*step!,roadDistance=height.roadEdgeDistance(x,z),comp=height.compoundDistance(x,z)
    const n=height.microAt(x*0.37+11,z*0.37-7)*6
    const dirt=Math.max(1-height.smoothstep(height.SHOULDER-0.3,height.SHOULDER+0.9+n*0.3,roadDistance),height.ditchAt(roadDistance,comp)/-height.DITCH.depth*0.45)
    const grass=Math.max(height.smoothstep(height.SHOULDER-0.2,height.SHOULDER+1.2,roadDistance)*(1-height.smoothstep(5.5+n,9.5+n*1.5,roadDistance)),1-height.smoothstep(1+n*0.5,7+n,comp))
    positions.push(x,height.heightAt(x,z),z); uvs.push(x,-z)
    for(let k=0;k<3;k++) colors.push((1+([1.35,1.3,0.78][k]!*1.15-1)*grass)*(1-dirt)+[1.25,1.05,0.85][k]!*1.05*dirt)
    if(i<nx && j<nz) {const a=j*(nx+1)+i,b=a+1,c=a+nx+1,d=c+1;indices.push(a,c,b,b,c,d)}
  }
  const g=new THREE.BufferGeometry().setAttribute("position",new THREE.Float32BufferAttribute(positions,3)).setAttribute("uv",new THREE.Float32BufferAttribute(uvs,2)).setAttribute("color",new THREE.Float32BufferAttribute(colors,3)).setIndex(indices)
  emit(g,new THREE.Matrix4(),terrainMat,"surface-forest_floor")
}
console.log("Authored scene triangles",Object.fromEntries(Object.entries(streams).map(([k,s])=>[k,s.v.length/33])))

// Exact seeded placement and the source's own tree models, exported as per-variant templates plus one instance per
// tree for the kit's instanced forest (LOD bands, cross-fades and far thinning happen at runtime).
const { placeTrees, VARIANTS }=await mod("world/forest/placement.ts")
const { buildTree, impostorInput, impostorSize }=await mod("world/forest/species.ts")
const trees=placeTrees({seed:1984,density:1})
const models=VARIANTS.map((v:any)=>buildTree(v.kind,v.seed))
await Bun.write(`${out}/tree-inputs.json`,JSON.stringify(models.map(impostorInput)))
// Ashwood world/forest.ts FOLIAGE_COLOR (linear), applied at runtime so the Lab can compare it with white cards.
const FOLIAGE_COLOR: Record<string,[number,number,number]>={ fir:[0.95,1,0.95], firEdge:[0.95,1,0.95], pine:[1.08,1.05,0.85], young:[1,1.05,0.95], sapling:[1.05,1.08,0.95], snag:[0.9,0.85,0.8] }
const bark=new THREE.MeshStandardMaterial({color:0x352e24}), leaf=new THREE.MeshStandardMaterial({color:0xffffff})
const templateBytes: Uint8Array[]=[]
let templateOffset=0
const template=(g: THREE.BufferGeometry, m: THREE.MeshStandardMaterial, kind: "solid"|"foliage"|"undergrowth")=>{
  const before={v:streams[kind]!.v.length,uv:streams[kind]!.uv.length}
  emit(g,new THREE.Matrix4(),m,kind)
  const v=streams[kind]!.v.splice(before.v), uv=streams[kind]!.uv.splice(before.uv)
  const bytes=new Uint8Array(packTexturedVerts(v,uv))
  templateBytes.push(bytes)
  const range=[templateOffset,bytes.byteLength]
  templateOffset+=bytes.byteLength
  return range
}
const forestModels=models.map((tree:any)=>({kind:tree.kind,sapling:tree.kind==="sapling",impostor:impostorSize(tree),colour:FOLIAGE_COLOR[tree.kind] ?? [1,1,1],
  lods:[tree.lod0,tree.lod1].map((lod:any)=>({trunk:template(lod.trunk,bark,"solid"),foliage:template(lod.foliage,leaf,"foliage")}))}))
const kept:number[]=[]
for(let i=0;i<trees.count;i++) if(Math.hypot(trees.x[i]+2,trees.z[i]-158)<=1000) kept.push(i)
const treeCount=kept.length
const soa=new Float32Array(treeCount*8)
kept.forEach((i,n)=>{
  // Stable per-tree 0..1 for far thinning (Knuth multiplicative hash of the placement index).
  const seed=(Math.imul(i+1,2654435761)>>>0)/2**32
  ;[trees.x[i],trees.y[i],trees.z[i],trees.scale[i],trees.yaw[i],trees.tint[i],seed,trees.variant[i]].forEach((value,k)=>{ soa[k*treeCount+n]=value })
})
await Bun.write(`${out}/forest-trees.bin.gz`,Bun.gzipSync(new Uint8Array(soa.buffer)))
// Every limb card now belongs to a tree template; undergrowth keeps its own stream.
delete streams.foliage
// The source's own undergrowth clumps as templates for the Lot's rule-placed ground dressing.
const plantNames=["fern","grass","salal","twigs"]
const { layers }=await import(forest)
const underRoot=new THREE.Group()
const under=(await mod("world/forest/undergrowth.ts")).buildUndergrowth({...ctx,scene:underRoot},new THREE.Texture(),trees)
const camera=new THREE.PerspectiveCamera(); camera.position.set(-2.132,1.937,158.465)
under.update(0,8,camera)
underRoot.updateMatrixWorld(true)
underRoot.traverse(emitObject)
const plants=Object.fromEntries(plantNames.map(name=>{
  const mesh=layers.flatMap((l:any)=>l.meshes).find((m:any)=>m.name===`undergrowth-${name}`)
  if(!mesh) throw new Error(`Missing undergrowth template ${name}`)
  const range=template(mesh.geometry,mesh.material,"undergrowth")
  return [name,{range}]
}))
const forestModelBytes=new Uint8Array(templateOffset)
let cursor=0
for(const bytes of templateBytes) { forestModelBytes.set(bytes,cursor); cursor+=bytes.byteLength }
await Bun.write(`${out}/forest-models.bin.gz`,Bun.gzipSync(forestModelBytes))
// Ground height around the gate (1 m grid) and the access road centreline, for runtime dressing placement.
const GROUND={x0:-40,z0:100,step:1,nx:81,nz:81}
const heights:number[]=[]
for(let j=0;j<GROUND.nz;j++) for(let i=0;i<GROUND.nx;i++) heights.push(Math.round(height.heightAt(GROUND.x0+i*GROUND.step,GROUND.z0+j*GROUND.step)*1000)/1000)
const accessRoad=layout.accessRoadSamples(1).map((p:any)=>[Math.round((p.x ?? p[0])*100)/100,Math.round((p.z ?? p[1])*100)/100]).filter(([x,z]:number[])=>Math.abs(x!)<60 && z!>90 && z!<200)
const { ACCESS_ROAD, FENCE, BOOTH }=layout
const ground={...GROUND,heights,accessRoad,roadHalfWidth:ACCESS_ROAD.width/2,shoulder:ACCESS_ROAD.shoulder,fence:FENCE,booth:BOOTH}
const files: Record<string,string[]> = {}
for(const [kind,s] of Object.entries(streams)) {
   if(!s.v.length) { files[kind]=[]; continue }
  const badVertex=s.v.findIndex(n=>!Number.isFinite(n)), badUv=s.uv.findIndex(n=>!Number.isFinite(n))
  if(badVertex>=0 || badUv>=0) throw new Error(`Non-finite ${kind} geometry: vertex component ${badVertex}, UV component ${badUv}`)
  // Triangle-aligned chunks fit both the hosting asset limit and baseline WebGPU buffer limits.
  const stride=kind==="solid"?24:32
  const verticesPerChunk=Math.floor(8*1024*1024/(stride*3))*3
  files[kind]=[]
  for(let first=0;first<s.v.length/11;first+=verticesPerChunk) {
    const verts=s.v.slice(first*11,(first+verticesPerChunk)*11)
    const packed=kind==="solid"?packVerts(verts):packTexturedVerts(verts,s.uv.slice(first*2,(first+verticesPerChunk)*2))
    const name=`${kind}-${files[kind]!.length}.bin.gz`
    await Bun.write(`${out}/${name}`,Bun.gzipSync(new Uint8Array(packed)))
    files[kind]!.push(name)
  }
  console.log(kind,s.v.length/33,"triangles")
}
const paint=await Bun.build({entrypoints:[resolve(source,"src/world/forest/paint.ts")],target:"browser",minify:true})
await Bun.write(`${out}/paint.js`,await paint.outputs[0]!.text())
await Bun.write(`${out}/scene.json`,JSON.stringify({version:2,files,treeCount,forest:{models:forestModels,trees:treeCount,impostorGrid:[8,2],plants},ground,lamps:ctx.lamps,colliders:ctx.colliders,props,surfaces:recipes,sources},null,2))
const used=new Set(Object.values(files).flat())
for(const file of await readdir(out)) if(/^(solid|ground|foliage|fence|glass|stain|undergrowth|impostors|windows|surface-[a-z_]+)-\d+\.bin\.gz$/.test(file) && !used.has(file)) await unlink(resolve(out,file))
console.log("Baked",out,treeCount,"trees")
