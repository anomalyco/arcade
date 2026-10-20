import { plugin } from "bun"
import { mkdir, readFile } from "node:fs/promises"
import { resolve } from "node:path"
import * as THREE from "three"
import { packVerts, MAT } from "@arcade/kit/gpu/mesh"
import { packTexturedVerts } from "@arcade/kit/gpu/textured-mesh"

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
plugin({ name: "ashwood-offline", setup(b) {
  b.onResolve({ filter: /^three(?:\/.*)?$/ }, args => ({ path: resolve(threeRoot,
    args.path === "three" ? "build/three.module.js" : args.path === "three/webgpu" ? "build/three.webgpu.js" : args.path === "three/tsl" ? "build/three.tsl.js" : args.path.replace("three/addons/", "examples/jsm/")) }))
  b.onLoad({ filter: /afterhours\/src\/.*\.ts$/ }, async args => {
    const text = await readFile(args.path, "utf8")
    sources[args.path.slice(source.length + 1)] = new Bun.CryptoHasher("sha256").update(text).digest("hex")
    if (args.path.endsWith("/render/materials.ts")) return { contents: `export * from ${JSON.stringify(materials)}`, loader: "ts" }
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
for (const [path, fn] of [["compound/booth.ts", "buildBooth"], ["compound/fence.ts", "buildFence"], ["compound/gate.ts", "buildGate"], ["compound/lot.ts", "buildLot"], ["compound/props.ts", "buildProps"], ["facility/shell.ts", "buildShell"]]) {
  console.log("Bake", path)
  ;(await mod("world/" + path))[fn!](ctx, root)
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
;(await mod("world/roads/power.ts")).buildPower(ctx, parts, wires, access, junction)
parts.build(root, "power", { castShadow: true }); wires.build(root, ctx.renderer)

// Main-block windows are backed by actual room state in Ashwood. Bake those very same bays/tints.
const state = await mod("world/interior/lighting-state.ts")
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
}

const streams: Record<string, { v: number[]; uv: number[] }> = Object.fromEntries(["solid","ground","foliage","fence","glass","undergrowth","impostors"].map(k=>[k,{v:[],uv:[]}]))
function emit(g: THREE.BufferGeometry, matrix: THREE.Matrix4, m: THREE.MeshStandardMaterial, kind: string, tint=1, first=0, count=g.index?.count ?? g.getAttribute("position").count) {
  if (!g.getAttribute("normal")) g.computeVertexNormals()
  const p=g.getAttribute("position"), n=g.getAttribute("normal"), uv=g.getAttribute("uv"), vc=g.getAttribute("color"), pane=g.getAttribute("paneA")
  const target=streams[kind]!, v=new THREE.Vector3(), normal=new THREE.Vector3(), nm=new THREE.Matrix3().getNormalMatrix(matrix)
  for(let i=first;i<first+count;i++) {
    const k=g.index?.getX(i) ?? i
    v.fromBufferAttribute(p,k).applyMatrix4(matrix); normal.fromBufferAttribute(n,k).applyMatrix3(nm).normalize()
    const glow=kind!=="glass" && m.emissiveIntensity > 0 && m.emissive && (m.emissive.r+m.emissive.g+m.emissive.b)>0
    let c=(glow?m.emissive:m.color ?? new THREE.Color(0.1,0.1,0.1)).clone(), aux=glow?m.emissiveIntensity:0, mat=glow?MAT.glow:kind==="ground"?MAT.ground:MAT.lit
    if(pane) { c.setRGB(pane.getX(k),pane.getY(k),pane.getZ(k)); aux=0.6; mat=MAT.glow }
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
    target.uv.push(uv?.getX(k) ?? 0,uv?.getY(k) ?? 0)
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
  if(m.name.includes("decal") || m.name.includes("contact_shadow")) return
  // The walkable prototype omits indoor rooms. Back their plain panes with darkness
  // rather than letting the distant sky show through both sides of the empty shell.
  if(m.name==="facility_glass_clear") {
    m=new THREE.MeshStandardMaterial({color:0x050807})
    m.name="window-backing"
  }
  const kind=m.name==="chainlink"?"fence":m.name.startsWith("asphalt")?"ground":m.transparent && m.opacity===0.35?"glass":m.name==="undergrowth"?"undergrowth":"solid"
  if(m.transparent && !m.emissiveIntensity && kind!=="fence" && kind!=="glass" && m.name!=="overhead_wire" && !o.geometry.getAttribute("paneA")) return
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
console.log("Authored scene triangles",Object.fromEntries(Object.entries(streams).map(([k,s])=>[k,s.v.length/33])))

// Exact seeded placement and limb cards, bounded to the walkable exterior's visible neighbourhood.
const { placeTrees, VARIANTS }=await mod("world/forest/placement.ts")
const { buildTree, impostorInput, impostorSize }=await mod("world/forest/species.ts")
const trees=placeTrees({seed:1984,density:1})
const models=VARIANTS.map((v:any)=>buildTree(v.kind,v.seed))
await Bun.write(`${out}/tree-inputs.json`,JSON.stringify(models.map(impostorInput)))
const bark=new THREE.MeshStandardMaterial({color:0x352e24}), leaf=new THREE.MeshStandardMaterial({color:0xffffff})
let treeCount=0
for(let i=0;i<trees.count;i++) {
  const x=trees.x[i],z=trees.z[i], distance=Math.hypot(x+2,z-158)
  if(distance>1000) continue
  if(distance>107.5) {
    const variant=trees.variant[i], tree=models[variant]
    if(tree.kind==="sapling") continue
    const {w,h}=impostorSize(tree), scale=trees.scale[i], tint=trees.tint[i]
    for(const [u,v] of [[0,0],[1,0],[1,1],[0,0],[1,1],[0,1]]) {
      // Billboard corner + aspect in the normal slot, height in aux; evaluated against the live camera.
      streams.impostors!.v.push(x,trees.y[i]-0.7*scale,z,u!*2-1,v!,w/h,tint,tint,tint,30,h*scale)
      streams.impostors!.uv.push((variant%8+u!)/8,(Math.floor(variant/8)+1-v!)/2)
    }
    treeCount++
    continue
  }
  const tree=models[trees.variant[i]], lod=distance<65?tree.lod0:tree.lod1
  const transform=new THREE.Matrix4().compose(new THREE.Vector3(x,trees.y[i],z),new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),-trees.yaw[i]),new THREE.Vector3().setScalar(trees.scale[i]))
  emit(lod.trunk,transform,bark,"solid",trees.tint[i]); emit(lod.foliage,transform,leaf,"foliage",trees.tint[i]); treeCount++
}
const underRoot=new THREE.Group()
const under=(await mod("world/forest/undergrowth.ts")).buildUndergrowth({...ctx,scene:underRoot},new THREE.Texture(),trees)
const camera=new THREE.PerspectiveCamera(); camera.position.set(-2.132,1.937,158.465)
under.update(0,8,camera)
underRoot.updateMatrixWorld(true)
underRoot.traverse(emitObject)
const files: Record<string,string[]> = {}
for(const [kind,s] of Object.entries(streams)) {
  if(!s.v.length) throw new Error(`Missing ${kind} geometry`)
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
await Bun.write(`${out}/scene.json`,JSON.stringify({version:1,files,treeCount,lamps:ctx.lamps,colliders:ctx.colliders,sources},null,2))
console.log("Baked",out,treeCount,"trees")
