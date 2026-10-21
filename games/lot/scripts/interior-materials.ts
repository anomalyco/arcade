import * as THREE from "three"
import { materialFor as baseMaterial } from "./ashwood-materials"
export { decalBias } from "./ashwood-materials"
export const materialFor=baseMaterial
const recipes:Record<string,[THREE.ColorRepresentation,number,number?]>={
  tile_green:[new THREE.Color(0.42,0.53,0.45),0.22],tile_green_dark:[new THREE.Color(0.055,0.12,0.085),0.22],
  terrazzo:[new THREE.Color(0.7,0.7,0.66),1],linoleum:[0x7b7b65,0.14],painted_wall:[0xaaa99b,1],ceiling_tile:[new THREE.Color(0.7,0.69,0.63),1],
  rubber:[0x1c1c1c,0.8],door_steel:[0x3d5a4b,0.3],plastic_orange:[0xb5561a,0.4],
  metal_galvanized:[0x888c88,0.5,1],metal_dark:[0x292e2a,0.55,0.8],concrete_floor:[0x70746e,0.9],
}
const cache=new Map<string,THREE.Material>()
export function material(name:string){
  let m=cache.get(name)
  if(!m){const [color,roughness,metalness=0]=recipes[name]??[0x666a60,0.8];m=baseMaterial(name,{color,roughness,metalness});cache.set(name,m)}
  return m
}
