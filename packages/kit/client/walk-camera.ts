import { FirstPerson } from "./first-person"
import type { Rect } from "../sim/geom"
import { Walk } from "./walk"
import { startHop, stepHop } from "../sim/hop"
export type WalkCameraSettings={cameraMotion:number;reduceMotion:boolean;stepLength:number;walkSettle:number;jumpHeight?:number;landDip?:number}
/** `jump` lets `jump()` hop (opt-in: a game without it keeps Space for its own use). */
export type WalkCameraOptions={creaks?:boolean;bump?:(x:number,z:number)=>boolean;jump?:boolean}
type Spring={x:number;v:number}
/** Seconds the landing dip takes to come back (critically damped, Kit's 2π/ω convention). */
const DIP_SETTLE=.3
function settle(s:Spring,target:number,dt:number,duration:number){
  const w=2*Math.PI/duration,e=Math.exp(-w*dt),d=s.x-target,c=s.v+w*d
  s.x=target+(d+c*dt)*e;s.v=(s.v-w*c*dt)*e
}

/** Presentation-only offsets after the shared collision controller; input yaw/pitch stay 1:1. */
export class WalkCamera extends FirstPerson {
  walk:Walk
  /** The jump's rise above the floor (m) and its vertical speed; a hop, not a climb: collision stays on the floor plan. */
  readonly air={y:0,v:0,airborne:false}
  private dip:Spring={x:0,v:0}
  constructor(canvas:HTMLCanvasElement,blocked:()=>boolean,private settings:WalkCameraSettings,private active:()=>boolean,private options:WalkCameraOptions={}){super(canvas,blocked);this.walk=new Walk(options.creaks)}
  resetWalk(){this.walk=new Walk(this.options.creaks);Object.assign(this.air,{y:0,v:0,airborne:false});this.dip.x=this.dip.v=0}
  /** Starts a jump from the floor; false while already in the air or without `options.jump`. */
  jump(){
    return !!this.options.jump&&startHop(this.air,this.settings.jumpHeight??.3)
  }
  override update(dt:number,aspect:number,walls:readonly Rect[]){
    const x=this.body.x,z=this.body.y
    super.update(dt,aspect,walls)
    const dx=this.body.x-x,dz=this.body.y-z,travel=Math.hypot(dx,dz)
    const collision=Math.hypot(this.body.vx,this.body.vy)*Math.min(dt,.05)-travel>.002
    const step=Math.min(Math.max(dt,0),.05),air=this.air
    const landed=stepHop(air,step,this.settings.jumpHeight??.3)
    // The landing frame still counts as air, so the gait can't add a step on top of `land()`.
    this.walk.update({dx,dz,yaw:this.yaw,dt,active:this.active(),amount:this.settings.cameraMotion,reduced:this.settings.reduceMotion,stride:this.settings.stepLength,settling:this.settings.walkSettle,bump:collision&&this.options.bump?.(this.body.x,this.body.y),airborne:air.airborne||landed>=0})
    if(landed>=0){
      this.walk.land(landed)
      // The knees take the landing: a dip that peaks at `landDip` for a full hop. Reduce camera motion leaves it out.
      const amount=this.settings.reduceMotion?0:Math.max(0,Math.min(1,this.settings.cameraMotion))
      this.dip.v-=landed*amount*(this.settings.landDip??.035)*Math.E*2*Math.PI/DIP_SETTLE
    }
    settle(this.dip,0,step,DIP_SETTLE)
    const w=this.walk,c=Math.cos(this.yaw),s=Math.sin(this.yaw)
    this.eye[0]+=w.lateral*c;this.eye[1]+=w.vertical+air.y+this.dip.x;this.eye[2]-=w.lateral*s
    return this.compose(aspect,w.roll)
  }
}
