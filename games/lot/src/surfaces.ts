import { imageTexture, loadGltf } from "@arcade/kit/gpu/gltf"
import type { TexturedPrimitive } from "@arcade/kit/gpu/textured-mesh"
import type { buildWorld } from "./world"

export async function sourceSurfaces(device: GPUDevice, world: Awaited<ReturnType<typeof buildWorld>>) {
  const base=import.meta.env.BASE_URL+"ashwood/"
  const surfaces=await Promise.all(world.surfaces.map(async s=>{
    const textures=await Promise.all(["base","normal","orm"].map(async kind=>{
      const r=await fetch(`${base}surfaces/${s.name}-${kind}.png`)
      if(!r.ok) throw new Error(`${s.name}/${kind}: ${r.status}`)
      return imageTexture(device,new Uint8Array(await r.arrayBuffer()),kind==="base","image/png",undefined,kind==="normal")
    }))
    return s.vertices.map((vertices):TexturedPrimitive=>({vertices,base:textures[0],normal:textures[1],orm:textures[2],color:[1,1,1,1],roughness:1,metalness:1,normalScale:s.normalScale,blend:false,aoStrength:1}))
  }))
  const names=[...new Set(world.scene.props.filter(p=>p.included && p.name!=="car_wagon").map(p=>p.name))]
  const models=await Promise.all(names.map(name=>loadGltf(device,`${base}models/${name}.glb`)))
  return [...surfaces.flat(),...models.flatMap(m=>m.primitives)]
}
