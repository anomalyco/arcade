import { SplatterSurfaces, newSurfaceHit } from "./splatter-surfaces"

export const SPLATTER_PARTICLES=256,SPLATTER_DECALS=256,SPLATTER_RECEIVERS=12
export const PARTICLE_STRIDE=24,DECAL_STRIDE=24
export type SplatterSettings={amount:number;impulse:number;spread:number;sizeMin:number;sizeMax:number;drag:number;gravity:number;r:number;g:number;b:number;opacity:number;decalSize:number;persistence:number;pooling:number;budget:number}
export const splatterPresets={
  blood:{amount:32,impulse:6.2,spread:.60,sizeMin:.028,sizeMax:.118,drag:.82,gravity:11.0,r:.15,g:.004,b:.006,opacity:.92,decalSize:3.7,persistence:26,pooling:.46,budget:192},
  zombieBlood:{amount:34,impulse:6.6,spread:.56,sizeMin:.030,sizeMax:.126,drag:.85,gravity:11.2,r:.12,g:.0035,b:.0055,opacity:.93,decalSize:3.9,persistence:30,pooling:.52,budget:224},
  survivorBlood:{amount:28,impulse:5.8,spread:.64,sizeMin:.028,sizeMax:.112,drag:.8,gravity:11.0,r:.20,g:.006,b:.008,opacity:.92,decalSize:3.5,persistence:24,pooling:.42,budget:192},
  ink:{amount:28,impulse:4.8,spread:.7,sizeMin:.03,sizeMax:.1,drag:1,gravity:9.8,r:.012,g:.017,b:.035,opacity:.94,decalSize:5,persistence:28,pooling:.6,budget:192},
  slime:{amount:22,impulse:3.8,spread:.55,sizeMin:.045,sizeMax:.15,drag:2,gravity:7,r:.055,g:.22,b:.012,opacity:.9,decalSize:4,persistence:25,pooling:.3,budget:192},
  oil:{amount:24,impulse:4,spread:.5,sizeMin:.03,sizeMax:.12,drag:1.6,gravity:9.8,r:.014,g:.011,b:.009,opacity:.94,decalSize:5,persistence:35,pooling:.7,budget:192},
  potion:{amount:34,impulse:5,spread:.8,sizeMin:.025,sizeMax:.095,drag:.9,gravity:9.8,r:.12,g:.025,b:.22,opacity:.86,decalSize:4,persistence:16,pooling:.45,budget:192},
} satisfies Record<string,SplatterSettings>
/** Cosmetic event identity is caller-owned. Detachment supplies a stable limb ID and world pose/velocity. */
export type SplatterImpact={id:number;limbId?:number;seed:number;x:number;y:number;z:number;dx:number;dy:number;dz:number;vx?:number;vy?:number;vz?:number;amount?:number}
const clamp=(n:number,a:number,b:number)=>Math.max(a,Math.min(b,n))

/** Fixed 120 Hz visual simulation. Births recycle bounded ring slots; no gameplay state or random globals. */
export class Splatter {
  readonly particles=new Float32Array(SPLATTER_PARTICLES*PARTICLE_STRIDE)
  readonly decals=new Float32Array(SPLATTER_DECALS*DECAL_STRIDE)
  readonly receivers=new Int32Array(SPLATTER_DECALS*SPLATTER_RECEIVERS)
  readonly receiverCounts=new Uint8Array(SPLATTER_DECALS)
  private readonly seen=new Float64Array(128).fill(NaN)
  private readonly limbs=new Int32Array(128).fill(-1)
  private readonly hit=newSurfaceHit()
  private seenAt=0;private particleAt=0;private decalAt=0;private randomState=1;private accumulator=0
  time=0
  constructor(readonly surfaces:SplatterSurfaces){}
  reset(){this.particles.fill(0);this.decals.fill(0);this.receiverCounts.fill(0);this.seen.fill(NaN);this.limbs.fill(-1);this.time=this.accumulator=this.particleAt=this.decalAt=this.seenAt=0}
  private random(){let t=this.randomState=(this.randomState+0x6D2B79F5)|0;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return((t^t>>>14)>>>0)/4294967296}
  emit(e:SplatterImpact,s:SplatterSettings):boolean {
    if(!Number.isFinite(e.x+e.y+e.z+e.dx+e.dy+e.dz+e.id+e.seed))return false
    const limb=e.limbId??-1
    for(let i=0;i<128;i++)if(this.seen[i]===e.id&&this.limbs[i]===limb)return false
    this.seen[this.seenAt]=e.id;this.limbs[this.seenAt]=limb;this.seenAt=(this.seenAt+1)%128
    this.randomState=e.seed^Math.imul(limb+2,81799)
    const budget=Math.floor(clamp(s.budget,1,SPLATTER_PARTICLES)),n=Math.floor(clamp(s.amount*(e.amount??1),0,budget)),length=Math.hypot(e.dx,e.dy,e.dz)||1
    for(let i=budget;i<SPLATTER_PARTICLES;i++){this.particles[i*PARTICLE_STRIDE+7]=0;this.decals[i*DECAL_STRIDE+7]=0}
    const dx=e.dx/length,dy=e.dy/length,dz=e.dz/length
    for(let i=0;i<n;i++){
      const o=(this.particleAt++%budget)*PARTICLE_STRIDE,p=this.particles
      const poolDrop=s.spread>0&&i<5,floorFan=s.spread>0&&i>=5&&i<Math.floor(n*.62)
      const size=poolDrop?s.sizeMax*(.88+this.random()*.22):floorFan?s.sizeMin+(s.sizeMax-s.sizeMin)*(.38+this.random()*.45):s.sizeMin+(s.sizeMax-s.sizeMin)*(.32+this.random()*.52)
      const speed=poolDrop?s.impulse*(.24+this.random()*.28):floorFan?s.impulse*(.52+this.random()*.52):s.impulse*(.92+this.random()*.68)
      const latSpread=floorFan?s.spread*.62:s.spread*.78
      const yBias=poolDrop?-(.52+this.random()*.45)*s.spread:floorFan?-(.22+this.random()*.32)*s.spread:(.06+this.random()*.24)*s.spread
      const sx=dx+(this.random()-.5)*latSpread,sy=dy+yBias,sz=dz+(this.random()-.5)*latSpread,l=Math.hypot(sx,sy,sz)||1
      p[o]=e.x;p[o+1]=e.y;p[o+2]=e.z;p[o+3]=size
      p[o+4]=sx/l*speed+clamp(e.vx??0,-30,30);p[o+5]=sy/l*speed+clamp(e.vy??0,-30,30);p[o+6]=sz/l*speed+clamp(e.vz??0,-30,30);p[o+7]=2.5
      p[o+8]=s.r;p[o+9]=s.g;p[o+10]=s.b;p[o+11]=s.opacity
      p[o+12]=this.random()*100;p[o+13]=s.drag;p[o+14]=s.gravity;p[o+15]=s.decalSize
      p[o+16]=s.persistence;p[o+17]=s.pooling*(poolDrop?1.35:1);p[o+18]=budget
    }
    return true
  }
  update(dt:number){
    this.accumulator+=clamp(dt,0,.1)
    while(this.accumulator+1e-9>=1/120){this.accumulator-=1/120;this.step(1/120)}
  }
  private step(dt:number){
    this.time+=dt
    const p=this.particles,d=this.decals
    for(let i=0;i<SPLATTER_DECALS;i++){const o=i*DECAL_STRIDE;if(d[o+7]>0){d[o+7]=Math.max(0,d[o+7]-dt);d[o+15]+=dt}}
    for(let i=0;i<SPLATTER_PARTICLES;i++){
      const o=i*PARTICLE_STRIDE;if(p[o+7]<=0)continue
      p[o+7]=Math.max(0,p[o+7]-dt);const drag=Math.exp(-p[o+13]*dt)
      p[o+4]*=drag;p[o+5]=p[o+5]*drag-p[o+14]*dt;p[o+6]*=drag
      const dx=p[o+4]*dt,dy=p[o+5]*dt,dz=p[o+6]*dt
      if(this.surfaces.sweep(p[o],p[o+1],p[o+2],dx,dy,dz,this.hit)){
        if(this.surfaces.triangles[this.hit.triangle*16+3]!==3)this.deposit(o)
        p[o+7]=0
      }else{p[o]+=dx;p[o+1]+=dy;p[o+2]+=dz}
    }
  }
  private deposit(o:number){
    const p=this.particles,d=this.decals,h=this.hit,material=this.surfaces.triangles[h.triangle*16+3]
    const budget=Math.floor(p[o+18]),dot=p[o+4]*h.nx+p[o+5]*h.ny+p[o+6]*h.nz,speed=Math.hypot(p[o+4],p[o+5],p[o+6])||1
    let tx=p[o+4]-dot*h.nx,ty=p[o+5]-dot*h.ny,tz=p[o+6]-dot*h.nz,l=Math.hypot(tx,ty,tz)
    if(l<.001){tx=h.ny;ty=-h.nx;tz=0;l=Math.hypot(tx,ty);if(l<.001){tx=1;ty=0;l=1}}
    const stretch=1+(1-Math.min(1,Math.abs(dot)/speed))*(material===2?2.6:1.8),radius=clamp(p[o+3]*p[o+15],.025,.82)*(material===1?.8:1)
    // Layering LOD: when over 70% of the decal budget is active, coalesce nearly-identical micro-impacts into an existing deposit.
    if(budget>=64&&this.decalAt>=Math.floor(budget*.7)){
      for(let i=0;i<budget;i++){
        const ek=i*DECAL_STRIDE
        if(d[ek+7]<=0||d[ek+15]>.35)continue
        const ndot=d[ek+8]*h.nx+d[ek+9]*h.ny+d[ek+10]*h.nz
        if(ndot>.98&&Math.hypot(d[ek]-h.x,d[ek+1]-h.y,d[ek+2]-h.z)<.055&&d[ek+3]<.58){
          d[ek+3]=Math.min(.68,d[ek+3]*1.06)
          d[ek+11]=Math.min(.52,d[ek+11]*1.05)
          d[ek+7]=Math.max(d[ek+7],p[o+16]*(material===1?.65:1))
          return
        }
      }
    }
    const id=this.decalAt++%budget,k=id*DECAL_STRIDE
    d[k]=h.x;d[k+1]=h.y;d[k+2]=h.z;d[k+3]=radius*stretch
    d[k+4]=tx/l;d[k+5]=ty/l;d[k+6]=tz/l;d[k+7]=p[o+16]*(material===1?.65:1)
    d[k+8]=h.nx;d[k+9]=h.ny;d[k+10]=h.nz;d[k+11]=radius/Math.sqrt(stretch)
    d[k+12]=p[o+8];d[k+13]=p[o+9];d[k+14]=p[o+10];d[k+15]=0
    d[k+16]=p[o+11];d[k+17]=p[o+12];d[k+18]=d[k+7];d[k+19]=p[o+17]*(h.ny>.7?1:.22)*(material===1?.35:1)
    this.receiverCounts[id]=this.surfaces.receivers(h,d[k+3]*(1+d[k+19]),this.receivers,id*SPLATTER_RECEIVERS,SPLATTER_RECEIVERS)
  }
  inspect(){let particles=0,decals=0,walls=0;for(let i=0;i<SPLATTER_PARTICLES;i++)if(this.particles[i*PARTICLE_STRIDE+7]>0)particles++;for(let i=0;i<SPLATTER_DECALS;i++)if(this.decals[i*DECAL_STRIDE+7]>0){decals++;if(Math.abs(this.decals[i*DECAL_STRIDE+9])<.7)walls++}return{particles,decals,walls,time:this.time}}
}
