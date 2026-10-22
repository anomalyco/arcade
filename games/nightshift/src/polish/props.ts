import type { Rect } from "@arcade/kit/sim/geom"
import type { PolishSettings } from "./settings"

export type ChairState={x:number;z:number;yaw:number;vx:number;vz:number;spin:number;homeX:number;homeZ:number;collider:[number,number,number,number]}
export class OfficePhysics {
  readonly chairs:ChairState[]
  paper=0;paperVelocity=0
  readonly swing=[0,0,0]
  private swingVelocity=[0,0,0]
  private lastCord?:number[]
  constructor(colliders:[number,number,number,number][]) {
    this.chairs=colliders.map(c=>({x:(c[0]+c[2])/2,z:(c[1]+c[3])/2,homeX:(c[0]+c[2])/2,homeZ:(c[1]+c[3])/2,yaw:0,vx:0,vz:0,spin:0,collider:c}))
  }
  step(dt:number,body:{x:number;y:number;vx:number;vy:number},walls:readonly Rect[],s:PolishSettings) {
    const enabled=s.polish&&s.physicalProps,n=Math.max(1,Math.ceil(dt*120)),h=dt/n
    for(const c of this.chairs) {
      if(!enabled){c.x=c.homeX;c.z=c.homeZ;c.yaw=c.vx=c.vz=c.spin=0}
      else for(let k=0;k<n;k++) {
        const dx=c.x-body.x,dz=c.z-body.y,d=Math.hypot(dx,dz),toward=(body.vx*dx+body.vy*dz)/Math.max(d,.001)
        if(d<.82&&toward>0){
          const force=toward*s.chairPush*Math.max(0,1-d/.82)*25
          c.vx+=dx/Math.max(d,.001)*force*h;c.vz+=dz/Math.max(d,.001)*force*h
          c.spin+=(body.vx*dz-body.vy*dx)*s.chairPush*4*h
        }
        const decay=Math.exp(-s.chairFriction*h);c.vx*=decay;c.vz*=decay;c.spin*=Math.exp(-s.chairFriction*.65*h)
        const x=c.x+c.vx*h,z=c.z+c.vz*h
        // Casters cannot roll through a desk, partition, or another chair.
        const hit=walls.some(w=>w!==c.collider&&x+.32>w[0]&&x-.32<w[2]&&z+.32>w[1]&&z-.32<w[3])
        if(hit){c.vx=c.vz=0}else{c.x=x;c.z=z}
        c.yaw+=c.spin*h
        if(Math.hypot(c.vx,c.vz)<.002)c.vx=c.vz=0
        if(Math.abs(c.spin)<.002)c.spin=0
      }
      const w=(c.collider[2]-c.collider[0])/2,d=(c.collider[3]-c.collider[1])/2
      c.collider[0]=c.x-w;c.collider[2]=c.x+w;c.collider[1]=c.z-d;c.collider[3]=c.z+d
    }
  }
  flutter(dt:number,x:number,z:number,speed:number,s:PolishSettings) {
    const n=Math.max(1,Math.ceil(dt*120)),h=dt/n,distance=Math.hypot(x+1.0,z+5.1)
    const target=s.polish&&s.physicalProps?s.paperFlutter*Math.min(3,speed)*Math.exp(-distance*distance*.8):0
    for(let k=0;k<n;k++){
      this.paperVelocity+=(target-this.paper)*65*h-this.paperVelocity*8*h;this.paper+=this.paperVelocity*h
    }
    if(target===0&&Math.abs(this.paper)<1e-6&&Math.abs(this.paperVelocity)<1e-5)this.paper=this.paperVelocity=0
  }
  cord(dt:number,endpoint:number[],s:PolishSettings) {
    const old=this.lastCord??endpoint;this.lastCord=[...endpoint]
    const n=Math.max(1,Math.ceil(dt*120)),h=dt/n,enabled=s.polish&&s.physicalProps
    for(let i=0;i<3;i++){
      // Endpoint motion injects velocity, not a new position. Ends stay attached in the shader.
      this.swingVelocity[i]-=Math.max(-.06,Math.min(.06,endpoint[i]-old[i]))*5*s.cordSwing
      for(let k=0;k<n;k++){
        this.swingVelocity[i]+=(-35*this.swing[i]-6*this.swingVelocity[i])*h;this.swing[i]+=this.swingVelocity[i]*h
      }
      if(!enabled||Math.abs(this.swing[i])+Math.abs(this.swingVelocity[i])<1e-6)this.swing[i]=this.swingVelocity[i]=0
    }
  }
}
