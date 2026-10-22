import { WalkCamera as SharedWalkCamera } from "@arcade/kit/client/walk-camera"
import type { Settings } from "./settings"
import { chairs } from "./world"

export class WalkCamera extends SharedWalkCamera {
  constructor(canvas:HTMLCanvasElement,blocked:()=>boolean,settings:Settings,active:()=>boolean){
    super(canvas,blocked,settings,active,{creaks:true,jump:true,bump:(x,z)=>chairs.some(r=>Math.hypot(x-Math.max(r[0],Math.min(r[2],x)),z-Math.max(r[1],Math.min(r[3],z)))<.285)})
  }
}
