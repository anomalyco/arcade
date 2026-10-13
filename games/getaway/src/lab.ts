import { mat4 } from "wgpu-matrix"
import { lab } from "@arcade/kit/lab/main"
import { createAudioLab } from "@arcade/kit/audio/lab"
import { MAT } from "./render/mesh"
import { MAT as blackout } from "../../blackout/src/render/mesh"
import { getawaySpawn } from "./lab/spawn"
import { blackoutSpawn } from "../../blackout/src/lab/spawn"
import { blackoutEffectSection } from "../../blackout/src/lab/effects"
import { getawayEffectSection } from "./lab/effects"
import { fireWaterSection } from "../../blackout/src/lab/fire-water"
import { splatterSection } from "../../blackout/src/lab/splatter"

void lab({sections:[blackoutEffectSection,getawayEffectSection,fireWaterSection,splatterSection,createAudioLab],spawn:context=>{const g=getawaySpawn(context);return {...g,characters:[...g.characters,blackoutSpawn(context)]}},materials:[{game:"Getaway",codes:MAT},{game:"Blackout",codes:blackout}],camera:(width,height,vp,inverse,eye,focus)=>{
  eye.set([focus[0],focus[1]+22,focus[2]+23])
  mat4.multiply(mat4.perspective(0.65,width/height,0.1,150),mat4.lookAt(eye,focus,[0,1,0]),vp)
  mat4.inverse(vp,inverse)
}}).catch(error=>{console.error(error);document.body.textContent=String(error)})
