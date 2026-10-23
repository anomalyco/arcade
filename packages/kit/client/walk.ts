import type { FootEvent } from "../audio/footsteps"
/** Distance-driven gait. Camera and contacts share this clock, including at low speed. */
export type FoleyEvent = FootEvent
export type WalkInput = { dx:number; dz:number; yaw:number; dt:number; active:boolean; amount:number; reduced:boolean; stride:number; settling:number; bump?:boolean; airborne?:boolean }
type Spring={x:number;v:number}
// Exact critically damped solution, duration in Kit's 2π/ω convention, bounce = 0.
function settle(s:Spring,target:number,dt:number,duration:number){
  const w=2*Math.PI/duration,e=Math.exp(-w*dt),d=s.x-target,c=s.v+w*d
  s.x=target+(d+c*dt)*e;s.v=(s.v-w*c*dt)*e
}
const clamp=(x:number,a:number,b:number)=>Math.max(a,Math.min(b,x))
export class Walk {
  time=0
  phase=.5
  speed=0
  lateral=0
  vertical=0
  roll=0
  events:FoleyEvent[]=[]
  private amplitude:Spring={x:0,v:0}
  private enabled:Spring={x:0,v:0}
  private lean:Spring={x:0,v:0}
  private side:Spring={x:0,v:0}
  private rise:Spring={x:0,v:0}
  private yaw?:number
  private wasMoving=false
  private scuffAt=-10
  private bumpAt=-10
  private touching=false
  private creakAt=12
  private serial=0
  constructor(private creaks=false){}
  /** Both feet coming down together after a jump: two soft contacts a beat apart and cloth; `impact` 0..1. */
  land(impact:number){
    const g=clamp(impact,0,1),at=this.time+.03
    // The landing is the contact: the next step comes half a stride later, never on top of it.
    this.phase=Math.floor(this.phase)+.5
    this.events.push({kind:"step",time:at,gain:.05+.15*g,pan:-.12,seed:++this.serial},{kind:"step",time:at+.028,gain:.04+.12*g,pan:.12,seed:++this.serial},{kind:"cloth",time:at+.04,gain:.07+.07*g,pan:0,seed:++this.serial})
  }
  update(i:WalkInput){
    const dt=clamp(i.dt,0,.05),start=this.time;this.time+=dt;this.events=[]
    if(dt===0)return
    const distance=Math.hypot(i.dx,i.dz),speed=distance/dt
    // Camera cuts/collision recovery must not emit a burst of steps.
    const moving=i.active&&!i.airborne&&distance<.25&&speed>.03
    const turn=this.yaw===undefined?0:clamp(Math.atan2(Math.sin(i.yaw-this.yaw),Math.cos(i.yaw-this.yaw))/dt,-3,3)
    this.yaw=i.yaw;this.speed=moving?speed:0
    const power=clamp(this.speed/1.7,0,1.35),before=this.phase
    if(moving)this.phase+=distance/clamp(i.stride,.45,1.1)
    const emit=(kind:FoleyEvent["kind"],gain:number,pan=0,time=this.time)=>this.events.push({kind,time,gain,pan,seed:++this.serial})
    for(let step=Math.floor(before)+1;step<=Math.floor(this.phase);step++){
      // Match the ~30 ms group delay of the critically damped 0.10 s pose spring.
      const at=start+dt*(step-before)/(this.phase-before)+.03,pan=step%2?.14:-.14
      emit("step",.025+.175*Math.min(power,1)**1.6,pan,at);emit("cloth",.06+.08*power,-pan,at+.035)
    }
    // No feet on the floor, no scuff: neither leaving it mid-stride nor turning in the air.
    if(i.active&&!i.airborne&&this.time-this.scuffAt>.65&&((this.wasMoving&&!moving)||(Math.abs(turn)>1.1&&this.speed<.8))){
      emit("scuff",this.wasMoving?.12:.06,turn*.06);this.scuffAt=this.time
    }
    if(i.active&&i.bump&&!this.touching&&this.time-this.bumpAt>.8){emit("bump",.65);this.bumpAt=this.time}
    this.touching=i.active&&!!i.bump
    if(this.creaks&&this.time>=this.creakAt){if(i.active)emit("creak",.18,Math.sin(this.creakAt)*.7);this.creakAt=this.time+17+(this.serial%7)}
    // A hop doesn't end a walk: whether you were walking carries across it.
    if(!i.airborne)this.wasMoving=moving
    settle(this.amplitude,Math.min(power,1),dt,i.settling)
    settle(this.enabled,i.active&&!i.reduced?clamp(i.amount,0,1):0,dt,.3)
    const strafe=dt>0?(i.dx*Math.cos(i.yaw)-i.dz*Math.sin(i.yaw))/dt:0
    settle(this.lean,i.active?clamp(-turn*.0012-strafe*.0015,-.0045,.0045):0,dt,i.settling)
    const phase=this.phase*2*Math.PI,a=this.amplitude.x*this.enabled.x
    // Cap the head's amplitude at walking speed; sprinting raises cadence, not shake.
    // 8 mm bob plus a smooth 1.5 mm heel-compression dip at the shared contact phase.
    const vertical=a*(-.008*Math.cos(phase)-.0015*Math.pow((1+Math.cos(phase))/2,8))
      +this.enabled.x*.0007*Math.sin(this.time*2*Math.PI*.23)/(1+this.amplitude.x*4)
    settle(this.rise,vertical,dt,.1);settle(this.side,a*.004*Math.sin(phase*.5),dt,.1)
    this.vertical=this.rise.x;this.lateral=this.side.x
    this.roll=this.lean.x*this.enabled.x
  }
}
