import { imageTexture, loadGltf } from "@arcade/kit/gpu/gltf"
import { bakeScatter } from "@arcade/kit/gpu/scatter-mesh"
import type { TexturedPrimitive } from "@arcade/kit/gpu/textured-mesh"
import { solidTexture } from "../foliage"
import { meshBytes } from "../mesh-bytes"
import type { InteriorScene } from "./types"
import { receptionProps } from "./props"
import { paneUvs } from "./pane-uvs"

const finishes: Record<string, string> = {
  tile_green: "tile", tile_green_dark: "tile", terrazzo: "terrazzo", linoleum: "vinyl",
  painted_wall: "plaster", ceiling_tile: "ceiling", rubber: "vinyl",
  interior_documents: "documents-base", interior_exit_sign: "exit",
}
const cc0 = new Set(["office_desk", "desk_lamp", "security_camera", "wet_floor_sign", "stack_chair"])

export async function loadInterior(device: GPUDevice) {
  const base = import.meta.env.BASE_URL + "interior/"
  const get = async (file: string) => {
    const response = await fetch(base + file)
    if (!response.ok) throw Error(`${file}: ${response.status}`)
    return response
  }
  const scene: InteriorScene = await (await get("scene.json")).json()
  if (scene.version !== 1) throw Error("Unsupported interior mesh version")
  const white = solidTexture(device, [255,255,255,255]), normal = solidTexture(device, [128,128,255,255])
  const maps = new Map<string, Promise<GPUTexture>>()
  const texture = (name: string, srgb: boolean, normalMap = false) => {
    if (!maps.has(name)) maps.set(name, get(name + ".png").then(async r => imageTexture(device, new Uint8Array(await r.arrayBuffer()), srgb, "image/png", undefined, normalMap)))
    return maps.get(name)!
  }
  const primitives = await Promise.all(scene.records.map(async (r): Promise<TexturedPrimitive> => {
    const finish = finishes[r.name], documents = r.name === "interior_documents"
    const [vertices, baseMap, normalMap, orm] = await Promise.all([
      get(r.file).then(meshBytes), finish ? texture(finish, true) : white,
      documents ? texture("documents-normal", false, true) : normal,
      documents ? texture("documents-orm", false) : finish && !["exit"].includes(finish) ? texture(finish + "-orm", false) : white,
    ])
    if(r.name==="interior_glass" || r.name==="interior_glazing") paneUvs(vertices)
    return { vertices, base: baseMap, normal: normalMap, orm, color: [1,1,1,r.alpha], roughness: r.roughness,
      metalness: r.metalness, normalScale: documents ? 0.6 : 0, aoStrength: 1, blend: r.alpha < 1 }
  }))
  for (const name of cc0) {
    const placements = scene.placements.filter(g=>g.name===name).flatMap(g=>g.props)
      .filter(p=>p.position[2]>=-3.2 && p.position[2]<=22)
      // Ashwood uses right-handed Three yaw; kit scatter's plan yaw has the opposite sign.
      .map(p=>({x:p.position[0],y:p.position[1],z:p.position[2],yaw:-(p.yaw??0),scale:p.scale??1}))
    if(!placements.length)continue
    const model=await loadGltf(device,base+name+".glb")
    primitives.push(...model.primitives.map(p=>({...p,vertices:bakeScatter(p.vertices,placements)})))
  }
  primitives.push({ vertices: receptionProps(), base: white, normal, orm: white, color: [1,1,1,1], roughness: 0.48, metalness: 0.15, normalScale: 0, blend: false })
  const colliders = scene.colliders.filter(b => b.max[1]! > 0.5 && b.min[1]! < 1.5 && b.max[2]! >= -3.2 && b.min[2]! <= 22)
  // Upward projector/display beams belong to adjacent rooms whose emitting models are not imported.
  return { scene, primitives, colliders, lamps: scene.lamps.filter(l => l.position[2] >= -3.2 && l.position[2] <= 22 && l.intensity > 0 && (l.direction?.[1] ?? -1) <= 0).map(l => ({ ...l,
    position: [l.position[0], l.angle ? Math.min(l.position[1], 3.02) : l.position[1], l.position[2]] as [number,number,number],
    shadow: !!l.angle,
  })) }
}
