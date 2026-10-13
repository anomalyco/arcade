import type { Wall } from "./volume"

export const PARTICLE_CAPACITY = 2048
export const PARTICLE_STRIDE = 24
export type ParticleKind = "soft" | "spark" | "debris" | "water" | "fire"
export type ParticleSpec = {
  kind: ParticleKind; life: number; size: number; growth: number; gravity: number; drag: number
  bounce: number; r: number; g: number; b: number; alpha: number
}
const kinds: Record<ParticleKind,number> = {soft:0,spark:1,debris:2,water:3,fire:4}

/** Packed, bounded storage. Collision/ground callbacks remain owned by the game. */
export class Particles {
  readonly data = new Float32Array(PARTICLE_CAPACITY*PARTICLE_STRIDE)
  readonly instances = new Float32Array(PARTICLE_CAPACITY*16)
  count = 0
  dropped = 0
  reset(){this.count=this.dropped=0}
  spawn(spec:ParticleSpec,x:number,y:number,z:number,vx=0,vy=0,vz=0,seed=0) {
    if(this.count===PARTICLE_CAPACITY){this.dropped++;return false}
    const p=this.data,i=this.count++*PARTICLE_STRIDE
    p[i]=x;p[i+1]=y;p[i+2]=z;p[i+3]=spec.size
    p[i+4]=vx;p[i+5]=vy;p[i+6]=vz;p[i+7]=0
    p[i+8]=spec.life;p[i+9]=spec.growth;p[i+10]=spec.gravity;p[i+11]=spec.drag
    p[i+12]=spec.r;p[i+13]=spec.g;p[i+14]=spec.b;p[i+15]=spec.alpha
    p[i+16]=kinds[spec.kind];p[i+17]=spec.bounce;p[i+18]=seed
    return true
  }
  update(dt:number,walls:readonly Wall[]=[],ground:(x:number,z:number)=>number=flatGround) {
    dt=Math.max(0,Math.min(dt,0.05))
    const p=this.data;let count=0
    for(let n=0;n<this.count;n++) {
      const i=n*PARTICLE_STRIDE
      p[i+7]+=dt;if(p[i+7]>=p[i+8])continue
      const drag=Math.exp(-p[i+11]*dt),ox=p[i],oz=p[i+2]
      p[i+4]*=drag;p[i+5]=p[i+5]*drag-p[i+10]*dt;p[i+6]*=drag
      p[i]+=p[i+4]*dt;p[i+1]+=p[i+5]*dt;p[i+2]+=p[i+6]*dt
      const floor=ground(p[i],p[i+2])+0.04
      if(p[i+1]<floor){p[i+1]=floor;p[i+5]=Math.abs(p[i+5])*p[i+17];p[i+4]*=0.8;p[i+6]*=0.8}
      for(const w of walls) if(p[i]>=w[0]&&p[i]<=w[2]&&p[i+2]>=w[1]&&p[i+2]<=w[3]) {
        p[i]=ox;p[i+2]=oz;p[i+4]*=-p[i+17];p[i+6]*=-p[i+17];break
      }
      if(count!==n)p.copyWithin(count*PARTICLE_STRIDE,i,i+PARTICLE_STRIDE)
      count++
    }
    this.count=count
  }
  prepare(){
    const p=this.data,o=this.instances
    for(let n=0;n<this.count;n++) {
      const i=n*PARTICLE_STRIDE,k=n*16,t=p[i+7]/p[i+8]
      o[k]=p[i];o[k+1]=p[i+1];o[k+2]=p[i+2];o[k+3]=Math.max(0.01,p[i+3]+p[i+9]*p[i+7])
      o[k+4]=p[i+12];o[k+5]=p[i+13];o[k+6]=p[i+14];o[k+7]=p[i+15]*Math.min(1,(1-t)*4)
      o[k+8]=p[i+4];o[k+9]=p[i+5];o[k+10]=p[i+6];o[k+11]=p[i+16]
      o[k+12]=p[i+18]+p[i+7]*2;o[k+13]=t;o[k+14]=0;o[k+15]=0
    }
  }
}
const flatGround=()=>0

/** Rate or distance emission with fractional carry and teleport rejection. Bounded to 128 births per step. */
export class Emitter {
  private remainder=0
  private x=0;private y=0;private z=0;private active=false
  reset(){this.remainder=0;this.active=false}
  step(x:number,y:number,z:number,dt:number,amount:number,mode:"rate"|"distance",emit:(x:number,y:number,z:number)=>void) {
    let distance=Math.hypot(x-this.x,y-this.y,z-this.z)
    if(!this.active||distance>20){this.x=x;this.y=y;this.z=z;this.active=true;this.remainder=0;distance=0}
    const quantity=Math.max(0,(mode==="rate"?dt:distance)*amount)
    const births=Math.min(128,Math.floor(this.remainder+quantity))
    for(let n=0;n<births;n++) {
      const t=quantity?Math.min(1,(n+1-this.remainder)/quantity):1
      emit(this.x+(x-this.x)*t,this.y+(y-this.y)*t,this.z+(z-this.z)*t)
    }
    this.remainder=(this.remainder+quantity)%1;this.x=x;this.y=y;this.z=z
  }
}
