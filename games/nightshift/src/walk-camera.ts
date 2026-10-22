import { mat4 } from "wgpu-matrix"
import { FirstPerson } from "@arcade/kit/client/first-person"
import type { Rect } from "@arcade/kit/sim/geom"
import type { Settings } from "./settings"
import { Walk } from "./walk"
import { chairs } from "./world"

/** Presentation-only offsets after the shared collision controller; input yaw/pitch stay 1:1. */
export class WalkCamera extends FirstPerson {
  walk=new Walk()
  private walkView=mat4.identity()
  private walkProjection=mat4.identity()
  constructor(canvas:HTMLCanvasElement,blocked:()=>boolean,private settings:Settings,private active:()=>boolean){super(canvas,blocked)}
  resetWalk(){this.walk=new Walk()}
  override update(dt:number,aspect:number,walls:readonly Rect[]){
    const x=this.body.x,z=this.body.y
    super.update(dt,aspect,walls)
    const dx=this.body.x-x,dz=this.body.y-z,travel=Math.hypot(dx,dz)
    const collision=Math.hypot(this.body.vx,this.body.vy)*Math.min(dt,.05)-travel>.002
    const nearChair=chairs.some(r=>Math.hypot(this.body.x-Math.max(r[0],Math.min(r[2],this.body.x)),this.body.y-Math.max(r[1],Math.min(r[3],this.body.y)))<.285)
    this.walk.update({dx,dz,yaw:this.yaw,dt,active:this.active(),amount:this.settings.cameraMotion,reduced:this.settings.reduceMotion,stride:this.settings.stepLength,settling:this.settings.walkSettle,bump:collision&&nearChair})
    const w=this.walk,c=Math.cos(this.yaw),s=Math.sin(this.yaw)
    this.eye[0]+=w.lateral*c;this.eye[1]+=w.vertical;this.eye[2]-=w.lateral*s
    // Rotating the up-vector about the unchanged view direction preserves aim.
    const right=[c,0,-s],up=[s*Math.sin(this.pitch),Math.cos(this.pitch),c*Math.sin(this.pitch)]
    mat4.lookAt(this.eye,this.eye.map((v,i)=>v+this.direction[i]!),up.map((v,i)=>v*Math.cos(w.roll)+right[i]!*Math.sin(w.roll)),this.walkView)
    mat4.perspective(this.fov*Math.PI/180,aspect,this.near,this.far,this.walkProjection)
    mat4.multiply(this.walkProjection,this.walkView,this.viewProj)
    return this.viewProj
  }
}
