import { generateCity } from "../../shared/sim/city"
import { buildCityMesh, partitionCityMesh } from "../render/city-mesh"
import { mulberry32 } from "../../shared/sim/rng"
import type { LabLight } from "../../../../packages/kit/lab/stage"

export const getawayRooms=[{value:"street",label:"Street"},{value:"alley",label:"Alley"},{value:"plaza",label:"Plaza"}]

/** Real city chunks, bounded to the neighborhood around a seeded street/alley/plaza. */
export function getawayEnvironment(kind:string,seed:number){
  const city=generateCity(seed),random=mulberry32(seed),pick=<T>(xs:readonly T[])=>xs[Math.floor(random()*xs.length)]
  let x=city.nodes[0].x,z=city.nodes[0].z
  if(kind==="alley") {const a=pick(city.alleys);if(a){x=(a.x0+a.x1)/2;z=(a.z0+a.z1)/2}}
  else if(kind==="plaza"){const p=pick(city.parks.filter(p=>p.kind==="plaza"))??pick(city.parks);if(p){x=(p.x0+p.x1)/2;z=(p.z0+p.z1)/2}}
  else {const n=pick(city.nodes);x=n.x;z=n.z+10}
  const near=(px:number,pz:number)=>Math.abs(px-x)<40&&Math.abs(pz-z)<40
  const local={...city,boxes:city.boxes.filter(b=>b.x0<x+35&&b.x1>x-35&&b.z0<z+35&&b.z1>z-35),trees:city.trees.filter(t=>near(t.x,t.z)),lamps:city.lamps.filter(l=>near(l.x,l.z)),parks:city.parks.filter(p=>near((p.x0+p.x1)/2,(p.z0+p.z1)/2)),shops:city.shops.filter(s=>near(s.x,s.z)),yards:city.yards.filter(y=>near((y.x0+y.x1)/2,(y.z0+y.z1)/2))}
  const built=buildCityMesh(local),partition=partitionCityMesh(built.mesh,24),vertices:number[]=[]
  for(const chunk of partition.chunks){
    if(chunk.maxX<x-26||chunk.minX>x+26||chunk.maxZ<z-24||chunk.minZ>z+24)continue
    for(let v=chunk.first*12;v<(chunk.first+chunk.count)*12;v+=36){
      const p=partition.data
      if(Math.max(p[v],p[v+12],p[v+24])<x-26||Math.min(p[v],p[v+12],p[v+24])>x+26||Math.max(p[v+2],p[v+14],p[v+26])<z-24||Math.min(p[v+2],p[v+14],p[v+26])>z+24)continue
      for(let j=v;j<v+36;j+=12){for(let k=0;k<12;k++)vertices.push(p[j+k]-(k===0?x:k===2?z:0))}
    }
  }
  const lights:LabLight[]=built.lamps.filter(l=>near(l.x,l.z)).sort((a,b)=>Math.hypot(a.x-x,a.z-z)-Math.hypot(b.x-x,b.z-z)).slice(0,6).map(l=>({x:l.x-x,y:l.y,z:l.z-z,radius:9+random()*5,r:.6+random()*.4,g:.5+random()*.4,b:.3+random()*.5,power:2+random()*3}))
  lights.push({x:-4+random()*8,y:4,z:-4,radius:14,r:1,g:.7,b:.4,power:3})
  return {vertices,lights,city,origin:{x,z}}
}
