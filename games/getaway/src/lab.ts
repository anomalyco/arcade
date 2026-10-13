import { mat4 } from "wgpu-matrix"
import { lab } from "../../../packages/kit/lab/main"
import { MAT, SMOKE_MATERIAL } from "./render/mesh"
import { MAT as blackout } from "../../blackout/src/render/mesh"

void lab({materials:[{game:"Getaway",codes:{...MAT,smoke:SMOKE_MATERIAL}},{game:"Blackout",codes:blackout}],camera:(width,height,vp,inverse,eye)=>{
  eye.set([8,19,19])
  mat4.multiply(mat4.perspective(0.65,width/height,0.1,100),mat4.lookAt(eye,[0,0,0],[0,1,0]),vp)
  mat4.inverse(vp,inverse)
}}).catch(error=>{console.error(error);document.body.textContent=String(error)})
