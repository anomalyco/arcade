import { mat4 } from "wgpu-matrix"
import { lab } from "@arcade/kit/lab/main"
import { MAT } from "./render/mesh"
import { MAT as getaway, SMOKE_MATERIAL } from "../../getaway/src/render/mesh"
import { getawaySpawn } from "../../getaway/src/lab/spawn"
import { blackoutSpawn } from "./lab/spawn"
import { blackoutEffectSection } from "./lab/effects"
import { getawayEffectSection } from "../../getaway/src/lab/effects"
import { fireWaterSection } from "./lab/fire-water"
import { splatterSection } from "./lab/splatter"

void lab({sections:[blackoutEffectSection,getawayEffectSection,fireWaterSection,splatterSection],spawn:context=>{const g=getawaySpawn(context);return {...g,characters:[...g.characters,blackoutSpawn(context)]}},materials:[{game:"Getaway",codes:{...getaway,smoke:SMOKE_MATERIAL}},{game:"Blackout",codes:MAT}],camera:(width,height,vp,inverse,eye,focus)=>{
  eye.set([focus[0],focus[1]+22,focus[2]+23])
  mat4.multiply(mat4.perspective(0.65,width/height,0.1,150),mat4.lookAt(eye,focus,[0,1,0]),vp)
  mat4.inverse(vp,inverse)
}}).catch(error=>{console.error(error);document.body.textContent=String(error)})
