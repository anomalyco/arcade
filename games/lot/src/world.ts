import { MAT, Mesh, packVerts } from "@arcade/kit/gpu/mesh"
import type { Rect } from "@arcade/kit/sim/geom"

// Ashwood shell/play.ts drift, frozen at t=8 s. Its screenshot did not persist the exact capture clock.
const t = 8
export const START = { x: -2.5 + 2.2 * Math.sin(t * 0.021), z: 154 + 5 * Math.sin(t * 0.013 + 1),
  height: 1.9 + 0.15 * Math.sin(t * 0.031), yaw: -0.05 + 0.05 * Math.sin(t * 0.017 + 0.5), pitch: 0.035 + 0.008 * Math.sin(t * 0.027) }
export const CAR = { x: -8.2, z: 137.8, yaw: -Math.PI / 2 - 0.04 }
export type SourceLamp = { kind: string; position: [number,number,number]; color: [number,number,number]; intensity: number; range: number; angle?: number; penumbra?: number; shadow?: boolean }
export type SourceScene = { version: number; files: Record<"solid"|"ground"|"foliage"|"fence"|"glass"|"undergrowth"|"impostors", string[]>; lamps: SourceLamp[]; colliders: { min: number[]; max: number[] }[]; treeCount: number }
export const walls: Rect[] = []

export async function buildWorld() {
  const base=import.meta.env.BASE_URL+"ashwood/"
  const get=async (file:string) => { const r=await fetch(base+file); if(!r.ok) throw new Error(`${file}: ${r.status}`); return r }
  const scene: SourceScene=await (await get("scene.json")).json()
  if(scene.version!==1) throw new Error("Unsupported exterior mesh version")
  const load=async (kind:keyof SourceScene["files"])=>Promise.all(scene.files[kind].map(async file=>{
    const response=await get(file)
    return new Response(response.body!.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer()
  }))
   const [solid,ground,foliage,fence,glass,undergrowth,impostors]=await Promise.all([load("solid"),load("ground"),load("foliage"),load("fence"),load("glass"),load("undergrowth"),load("impostors")])
  walls.push(...scene.colliders.filter(b=>b.max[1]>0.5 && b.min[1]<1.5).map(b=>[b.min[0]!,b.min[2]!,b.max[0]!,b.max[2]!] as Rect))
  // Exterior prototype: the facility is a closed mass, rather than the source's playable interior.
  walls.push([-55,-22,35,22],[-10.9,136.6,-5.5,139])
  const extra=new Mesh(), sky=new Mesh()
  extra.box(-700,-0.3,-700,700,-0.02,700,[0.12,0.15,0.12])
  sky.box(-699,-30,-699,699,300,699,[1,1,1],MAT.glow,-1,undefined,true)
  for(let i=0;i<sky.v.length;i+=33) for(const k of [2,1,0]) extra.v.push(...sky.v.slice(i+k*11,i+(k+1)*11))
   return { scene,solid,ground,foliage,fence,glass,undergrowth,impostors,extra:packVerts(extra.v) }
}
