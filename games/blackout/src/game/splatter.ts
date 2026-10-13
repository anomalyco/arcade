import { SplatterSurfaces, type SplatterMaterial } from "@arcade/kit/fx/splatter-surfaces"
import { splatterPresets } from "@arcade/kit/fx/splatter"
import type { LevelData } from "../render/level-mesh"

/** Review opt-in: the original blood remains the shipped default. Cosmetic settings never enter shared simulation. */
export const bloodSplatterSettings={style:0,...splatterPresets.blood}
const half=(h:number)=>{const s=h&0x8000?-1:1,e=h>>10&31,m=h&1023;return s*(e?2**(e-15)*(1+m/1024):2**-14*m/1024)}

/** Exact visible triangles include desk tops/legs, walls, raised pavements and glass blockers. */
export function blackoutSplatterSurfaces(level:LevelData){
  const triangles:number[]=[]
  for(const chunks of [level.chunks,level.glass])for(const chunk of chunks){
    const p=new DataView(chunk.data)
    for(let i=0;i<chunk.data.byteLength;i+=72){
      const mat=half(p.getUint16(i+20,true)),floor=half(p.getUint16(i+22,true))
      if(mat===7||mat===11||mat===13)continue
      const material:SplatterMaterial=mat===6||mat===2||mat===3?3:mat===10?2:mat===1&&[0,2,8].includes(floor)?1:0
      for(let v=0;v<3;v++)for(let c=0;c<3;c++)triangles.push(p.getFloat32(i+v*24+c*4,true))
      triangles.push(material)
    }
  }
  return new SplatterSurfaces(triangles)
}
