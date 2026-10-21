import { MAT, Mesh, packVerts } from "@arcade/kit/gpu/mesh"
import type { ForestModel, ForestTrees } from "@arcade/kit/gpu/forest"
import type { Ground } from "./dressing"
import type { Rect } from "@arcade/kit/sim/geom"
import { meshBytes } from "./mesh-bytes"

// Ashwood shell/play.ts drift, frozen at t=8 s. Its screenshot did not persist the exact capture clock.
const t = 8
export const START = { x: -2.5 + 2.2 * Math.sin(t * 0.021), z: 154 + 5 * Math.sin(t * 0.013 + 1),
  height: 1.9 + 0.15 * Math.sin(t * 0.031), yaw: -0.05 + 0.05 * Math.sin(t * 0.017 + 0.5), pitch: 0.035 + 0.008 * Math.sin(t * 0.027) }
export const CAR = { x: -8.2, z: 137.8, yaw: -Math.PI / 2 - 0.04 }
export type SourceLamp = { kind: string; position: [number,number,number]; direction?: [number,number,number]; color: [number,number,number]; intensity: number; range: number; angle?: number; penumbra?: number; shadow?: boolean; size?: number }
type Range = [offset: number, bytes: number]
export type SourceForest = { models: { kind: string; sapling: boolean; impostor: { w: number; h: number }; colour: [number,number,number]; lods: { trunk: Range; foliage: Range }[] }[]; trees: number; impostorGrid: [number, number]; plants: Record<PlantName, { range: Range }> }
export type PlantName = "fern" | "grass" | "salal" | "twigs"
export type SourceScene = { version: number; files: Record<"solid"|"ground"|"fence"|"glass"|"undergrowth", string[]>; forest: SourceForest; ground: Ground; lamps: SourceLamp[]; colliders: { min: number[]; max: number[] }[]; treeCount: number }
export const walls: Rect[] = []

export async function buildWorld() {
  const base=import.meta.env.BASE_URL+"ashwood/"
  const get=async (file:string) => { const r=await fetch(base+file); if(!r.ok) throw new Error(`${file}: ${r.status}`); return r }
  const scene: SourceScene=await (await get("scene.json")).json()
  if(scene.version!==1) throw new Error("Unsupported exterior mesh version")
  const load=async (kind:keyof SourceScene["files"])=>Promise.all(scene.files[kind].map(async file=>{
    const response=await get(file)
    return meshBytes(response)
  }))
  const [solid,ground,fence,glass,undergrowth,forestBytes,treeBytes]=await Promise.all([load("solid"),load("ground"),load("fence"),load("glass"),load("undergrowth"),
    get("forest-models.bin.gz").then(meshBytes),get("forest-trees.bin.gz").then(meshBytes)])
  walls.push(...scene.colliders.filter(b=>b.max[1]>0.5 && b.min[1]<1.5).map(b=>[b.min[0]!,b.min[2]!,b.max[0]!,b.max[2]!] as Rect))
  // Exterior prototype: the facility is a closed mass, rather than the source's playable interior.
  walls.push([-55,-22,35,22],[-10.9,136.6,-5.5,139])
  const extra=new Mesh(), sky=new Mesh()
  extra.box(-700,-0.3,-700,700,-0.02,700,[0.12,0.15,0.12])
  sky.box(-699,-30,-699,699,300,699,[1,1,1],MAT.glow,-1,undefined,true)
  for(let i=0;i<sky.v.length;i+=33) for(const k of [2,1,0]) extra.v.push(...sky.v.slice(i+k*11,i+(k+1)*11))
  return { scene,solid,ground,fence,glass,undergrowth,forest:forest(scene.forest,forestBytes,treeBytes),extra:packVerts(extra.v) }
}

/** Per-variant templates and one instance per tree, for the kit's instanced forest. */
function forest(source: SourceForest, models: ArrayBuffer, trees: ArrayBuffer) {
  const n=source.trees, f=new Float32Array(trees), column=(k:number)=>f.subarray(k*n,(k+1)*n)
  if(f.length!==n*8) throw new Error(`Forest trees: expected ${n*8} floats, got ${f.length}`)
  const part=([offset,bytes]:Range)=>models.slice(offset,offset+bytes)
  return {
    models:source.models.map((m):ForestModel=>{
      const lod=(i:number)=>({trunk:part(m.lods[i]!.trunk),foliage:part(m.lods[i]!.foliage)})
      return { sapling:m.sapling, impostor:m.impostor, colour:m.colour, lods:[lod(0),lod(1)] }
    }),
    trees:{ count:n, x:column(0), y:column(1), z:column(2), scale:column(3), yaw:column(4), tint:column(5), seed:column(6), variant:Uint8Array.from(column(7)) } satisfies ForestTrees,
    impostorGrid:source.impostorGrid,
    plants:Object.fromEntries(Object.entries(source.plants).map(([name,p])=>[name,part(p.range)])) as Record<PlantName,ArrayBuffer>,
  }
}
