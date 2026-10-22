import { aabbInFrustum, extractFrustumPlanes } from "@arcade/kit/gpu/cull"
import { hash01 } from "@arcade/kit/gpu/lights/flicker"
import type { PolishSettings } from "./settings"

export type Bounds=readonly [number,number,number,number,number,number]
export type ChangeKind="chair"|"drawer"|"mug"|"monitor"
export type ContinuityTarget={kind:ChangeKind;bounds:Bounds;lastSeen:number;value:number;visible:boolean}
export class Continuity {
  readonly targets:ContinuityTarget[]=[
    {kind:"chair",bounds:[2.6,0,.8,4,1.1,2.1],lastSeen:0,value:0,visible:false},
    {kind:"drawer",bounds:[.9,0,3.45,2.4,.5,4.3],lastSeen:0,value:0,visible:false},
    {kind:"mug",bounds:[.4,.77,-5.7,.95,1,-5.1],lastSeen:0,value:0,visible:false},
    {kind:"monitor",bounds:[3.75,.79,-2.7,4.45,1.5,-2.2],lastSeen:0,value:0,visible:false},
  ]
  readonly events:{time:number;kind:ChangeKind;value:number;lastSeen:number;visible:boolean}[]=[]
  private planes=new Float32Array(24)
  private next=0
  private sequence=0
  private seed=0
  step(time:number,vp:Float32Array,afterCall:boolean,s:PolishSettings,chairBounds?:Bounds,allowChanges=true) {
    if(s.continuitySeed!==this.seed){this.seed=s.continuitySeed;this.sequence=0;this.next=time+s.changeInterval;this.events.length=0;for(const t of this.targets){t.value=0;t.lastSeen=time}}
    if(chairBounds)this.targets[0].bounds=chairBounds
    extractFrustumPlanes(vp,0,this.planes)
    // Swept bounds cover BOTH poses, with extra margin. Occlusion never excuses a frustum hit.
    for(const t of this.targets){t.visible=aabbInFrustum(this.planes,...t.bounds);if(t.visible)t.lastSeen=time}
    if(!s.polish||!s.continuity){for(const t of this.targets)t.value=0;this.next=time+s.changeInterval;return}
    const interval=afterCall?s.afterCallInterval:s.changeInterval
    if(!allowChanges){this.next=time+interval;return}
    this.next=Math.min(this.next,time+interval)
    if(time<this.next)return
    const start=Math.floor(hash01(this.seed,++this.sequence)*4)
    for(let j=0;j<4;j++){
      const t=this.targets[(start+j)%4]
      if(t.visible||time-t.lastSeen<s.unseenDelay)continue
      t.value=1-t.value
      this.events.push({time,kind:t.kind,value:t.value,lastSeen:t.lastSeen,visible:t.visible})
      break
    }
    this.next=time+interval*(.8+hash01(this.seed,this.sequence+999)*.8)
  }
  value(kind:ChangeKind){return this.targets.find(t=>t.kind===kind)!.value}
}
