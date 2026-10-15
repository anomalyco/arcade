import type { Wall } from "./volume"
import { emitTrailBirth, TrailBirth } from "./projectile-trail"

export const PARTICLE_CAPACITY = 2048
export const PARTICLE_STRIDE = 28
export type ParticleKind = "soft" | "spark" | "debris" | "water" | "fire" | "shock" | "scorch" | "fireball"
export type ParticleSpec = {
  kind: ParticleKind; life: number; size: number; growth: number; gravity: number; drag: number
  bounce: number; r: number; g: number; b: number; alpha: number
  temperature?: number; turbulence?: number; ease?: number
  /** Projectile smoke trail scale in metres (0: none). The particle lays its own thinning smoke trail with a hot spark
   *  at its head, and splashes when it falls below `Particles.water`. See `fx/projectile-trail.ts`. */
  trail?: number
  /** Secondary pop scale in metres (0: none): a small fireball burst where the particle expires. */
  pop?: number
}
const kinds: Record<ParticleKind,number> = {soft:0,spark:1,debris:2,water:3,fire:4,shock:5,scorch:6,fireball:7}

/** Births queued by trailing or popping particles during `update`, spawned once the pool is compacted. */
const BIRTH_CAPACITY = 512
const BIRTH_STRIDE = 9
const births = new Float32Array(BIRTH_CAPACITY*BIRTH_STRIDE)

/** Packed, bounded storage. Collision/ground callbacks remain owned by the game. */
export class Particles {
  readonly data = new Float32Array(PARTICLE_CAPACITY*PARTICLE_STRIDE)
  readonly instances = new Float32Array(PARTICLE_CAPACITY*16)
  count = 0
  dropped = 0
  /** Horizontal wind (m/s) that projectile smoke trails drift with. */
  windX = 0.7
  windZ = 0.25
  /** Water surface height (m) for projectile splashes, or null where there is no water. */
  water: number | null = null
  reset(){this.count=this.dropped=0}
  spawn(spec:ParticleSpec,x:number,y:number,z:number,vx=0,vy=0,vz=0,seed=0) {
    if(this.count===PARTICLE_CAPACITY){this.dropped++;return false}
    const p=this.data,i=this.count++*PARTICLE_STRIDE
    p[i]=x;p[i+1]=y;p[i+2]=z;p[i+3]=spec.size
    p[i+4]=vx;p[i+5]=vy;p[i+6]=vz;p[i+7]=0
    p[i+8]=spec.life;p[i+9]=spec.growth;p[i+10]=spec.gravity;p[i+11]=spec.drag
    p[i+12]=spec.r;p[i+13]=spec.g;p[i+14]=spec.b;p[i+15]=spec.alpha
    p[i+16]=kinds[spec.kind];p[i+17]=spec.bounce;p[i+18]=seed
    p[i+19]=spec.temperature??0;p[i+20]=spec.turbulence??0;p[i+21]=spec.ease??1
    p[i+22]=spec.trail??0;p[i+23]=0;p[i+24]=spec.pop??0;p[i+25]=0
    return true
  }
  update(dt:number,walls:readonly Wall[]=[],ground:(x:number,z:number)=>number=flatGround) {
    dt=Math.max(0,Math.min(dt,0.05))
    const p=this.data,water=this.water;let count=0,queued=0
    const queue=(type:number,x:number,y:number,z:number,vx:number,vy:number,vz:number,scale:number,strength:number)=>{
      if(queued>=BIRTH_CAPACITY)return
      const o=queued++*BIRTH_STRIDE
      births[o]=type;births[o+1]=x;births[o+2]=y;births[o+3]=z;births[o+4]=vx;births[o+5]=vy;births[o+6]=vz;births[o+7]=scale;births[o+8]=strength
    }
    for(let n=0;n<this.count;n++) {
      const i=n*PARTICLE_STRIDE
      p[i+7]+=dt
      if(p[i+7]>=p[i+8]){
        if(p[i+24]>0)queue(TrailBirth.pop,p[i],p[i+1],p[i+2],p[i+4],p[i+5],p[i+6],p[i+24],1)
        continue
      }
      const kind=p[i+16]
      const drag=Math.exp(-p[i+11]*dt),ox=p[i],oy=p[i+1],oz=p[i+2]
      p[i+4]*=drag;p[i+5]=p[i+5]*drag-p[i+10]*dt;p[i+6]*=drag
      if(kind===7){
        const age=p[i+7],seed=p[i+18],turb=p[i+20]||0.7
        p[i]+=Math.sin(age*4.4+seed)*0.32*turb*dt
        p[i+2]+=Math.cos(age*4.1+seed*1.3)*0.32*turb*dt
      }
      p[i]+=p[i+4]*dt;p[i+1]+=p[i+5]*dt;p[i+2]+=p[i+6]*dt
      const trail=p[i+22]
      if(trail>0&&water!==null&&p[i+1]<water){
        queue(TrailBirth.splash,p[i],water,p[i+2],p[i+4],p[i+5],p[i+6],trail,1)
        continue
      }
      const floor=ground(p[i],p[i+2])+(kind===5||kind===6?0.025:0.04)
      if(p[i+1]<floor){p[i+1]=floor;p[i+5]=Math.abs(p[i+5])*p[i+17];p[i+4]*=0.8;p[i+6]*=0.8}
      for(const w of walls) if(p[i]>=w[0]&&p[i]<=w[2]&&p[i+2]>=w[1]&&p[i+2]<=w[3]) {
        p[i]=ox;p[i+2]=oz;p[i+4]*=-p[i+17];p[i+6]*=-p[i+17];break
      }
      if(trail>0){
        // Burning fragments lay puffs by distance travelled, sparser and thinner as they cool, and keep smouldering
        // where they come to rest. The head throws one short hot spark per step while it is still burning.
        const t=p[i+7]/p[i+8],strength=Math.pow(1-t,1.25)
        const dx=p[i]-ox,dy=p[i+1]-oy,dz=p[i+2]-oz,moved=Math.hypot(dx,dy,dz)
        const spacing=trail*(0.42+0.9*(1-strength))
        let carry=p[i+23]+moved+dt*trail*0.9*strength
        while(carry>=spacing&&queued<BIRTH_CAPACITY){
          carry-=spacing
          const k=moved>1e-5?Math.max(0,1-carry/moved):1
          queue(TrailBirth.puff,ox+dx*k,oy+dy*k,oz+dz*k,p[i+4],p[i+5],p[i+6],trail,strength)
        }
        p[i+23]=Math.min(carry,spacing)
        if(strength>0.3)queue(TrailBirth.head,p[i],p[i+1],p[i+2],p[i+4],p[i+5],p[i+6],trail,strength)
      }
      if(count!==n)p.copyWithin(count*PARTICLE_STRIDE,i,i+PARTICLE_STRIDE)
      count++
    }
    this.count=count
    if(queued>0)this.spawnBirths(queued)
  }
  private spawnBirths(queued:number){
    let seed=(this.count*2654435761)>>>0
    const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296}
    for(let n=0;n<queued;n++){
      const o=n*BIRTH_STRIDE
      emitTrailBirth(this,births[o]!,births[o+1]!,births[o+2]!,births[o+3]!,births[o+4]!,births[o+5]!,births[o+6]!,births[o+7]!,births[o+8]!,random)
    }
  }
  prepare(){
    const p=this.data,o=this.instances
    for(let n=0;n<this.count;n++) {
      const i=n*PARTICLE_STRIDE,k=n*16,age=p[i+7],life=p[i+8],t=age/life,kind=p[i+16],ease=p[i+21]||1
      const growthCurve=ease!==1?(1-Math.pow(Math.max(0,1-t),ease))*life:age
      o[k]=p[i];o[k+1]=p[i+1];o[k+2]=p[i+2];o[k+3]=Math.max(0.01,p[i+3]+p[i+9]*growthCurve)
      const fade=kind===6?Math.min(1,t*18)*Math.pow(Math.max(0,1-t),1.35):kind===5?Math.pow(Math.max(0,1-t),1.75):kind===7?Math.min(1,t*18)*Math.min(1,(1-t)*2.35):Math.min(1,(1-t)*4)
      o[k+4]=p[i+12];o[k+5]=p[i+13];o[k+6]=p[i+14];o[k+7]=p[i+15]*fade
      o[k+8]=p[i+4];o[k+9]=p[i+5];o[k+10]=p[i+6];o[k+11]=kind
      o[k+12]=p[i+18]+(kind===5||kind===6?0:age*2);o[k+13]=t;o[k+14]=p[i+19];o[k+15]=p[i+20]
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
