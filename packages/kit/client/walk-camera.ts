import { FirstPerson } from "./first-person"
import type { Rect } from "../sim/geom"
import { Walk } from "./walk"
export type WalkCameraSettings={cameraMotion:number;reduceMotion:boolean;stepLength:number;walkSettle:number}
export type WalkCameraOptions={creaks?:boolean;bump?:(x:number,z:number)=>boolean}

/** Presentation-only offsets after the shared collision controller; input yaw/pitch stay 1:1. */
export class WalkCamera extends FirstPerson {
  walk:Walk
  constructor(canvas:HTMLCanvasElement,blocked:()=>boolean,private settings:WalkCameraSettings,private active:()=>boolean,private options:WalkCameraOptions={}){super(canvas,blocked);this.walk=new Walk(options.creaks)}
  resetWalk(){this.walk=new Walk(this.options.creaks)}
  override update(dt:number,aspect:number,walls:readonly Rect[]){
    const x=this.body.x,z=this.body.y
    super.update(dt,aspect,walls)
    const dx=this.body.x-x,dz=this.body.y-z,travel=Math.hypot(dx,dz)
    const collision=Math.hypot(this.body.vx,this.body.vy)*Math.min(dt,.05)-travel>.002
    this.walk.update({dx,dz,yaw:this.yaw,dt,active:this.active(),amount:this.settings.cameraMotion,reduced:this.settings.reduceMotion,stride:this.settings.stepLength,settling:this.settings.walkSettle,bump:collision&&this.options.bump?.(this.body.x,this.body.y)})
    const w=this.walk,c=Math.cos(this.yaw),s=Math.sin(this.yaw)
    this.eye[0]+=w.lateral*c;this.eye[1]+=w.vertical;this.eye[2]-=w.lateral*s
    return this.compose(aspect,w.roll)
  }
}
