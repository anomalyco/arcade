import type { FootSurface } from "@arcade/kit/audio/footsteps"
import { puddleAt } from "@arcade/kit/gpu/reflections/wet-query"
import type { WetSettings } from "@arcade/kit/gpu/reflections/wet"
import type { SurfaceQuery } from "./surface-query"
import { EXTERIOR_WET } from "./surface-materials"

const wetMaterials=new Map(EXTERIOR_WET)

export async function footSurface(query:SurfaceQuery){
  const maps=new Map<string,ImageData>()
  await Promise.all(["asphalt","asphalt_lot"].map(async name=>{
    const response=await fetch(`${import.meta.env.BASE_URL}ashwood/surfaces/${name}-orm.png`)
    if(!response.ok)throw Error(`Foot surface ${name}: ${response.status}`)
    const image=await createImageBitmap(await response.blob(),{colorSpaceConversion:"none"}),canvas=new OffscreenCanvas(image.width,image.height),g=canvas.getContext("2d")!
    g.drawImage(image,0,0);image.close();maps.set(name,g.getImageData(0,0,canvas.width,canvas.height))
  }))
  const ao=(name:string,u:number,v:number)=>{
    const m=maps.get(name);if(!m)return 1
    const x=(u-Math.floor(u))*m.width-.5,y=(v-Math.floor(v))*m.height-.5,ix=Math.floor(x),iy=Math.floor(y),tx=x-ix,ty=y-iy
    const at=(x:number,y:number)=>m.data[(((y+m.height)%m.height)*m.width+(x+m.width)%m.width)*4]!/255
    return at(ix,iy)*(1-tx)*(1-ty)+at(ix+1,iy)*tx*(1-ty)+at(ix,iy+1)*(1-tx)*ty+at(ix+1,iy+1)*tx*ty
  }
  return (x:number,z:number,wet:WetSettings):FootSurface=>{
    if(x> -55&&x<35&&z> -3.2&&z<22)return "tile"
    if(Math.abs(x-9)<1.7&&Math.abs(z-127.5)<1.4)return "wood"
    const s=query.at(x,z,.5)
    if(s.name.startsWith("asphalt"))return puddleAt(x,z,ao(s.name,s.u,s.v),wet,wetMaterials.get(s.name))>.3?"puddle":wet.wetness>.2?"wet-asphalt":"asphalt"
    if(s.name==="gravel")return "gravel"
    if(s.name==="grass")return "grass"
    if(s.name==="dirt"||s.name==="forest_floor")return "dirt"
    if(s.name.startsWith("concrete"))return "concrete"
    return "dirt"
  }
}
