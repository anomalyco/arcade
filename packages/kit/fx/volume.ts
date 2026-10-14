import { smokeSettings, type SmokeSettings } from "./volume-settings"
/** World X/Z rectangles sealing the shallow layer. */
export type Wall = readonly [number, number, number, number]
export const GRID = 48
export const VOLUMES = 4
const CELLS = GRID * GRID
// 16-direction chamfer metric: maximum unobstructed angular error 2.75%.
const DX = [-1,1,0,0,-1,1,-1,1,-2,-2,2,2,-1,1,-1,1]
const DZ = [0,0,-1,1,-1,-1,1,1,-1,1,-1,1,-2,-2,2,2]

/** Bounded shallow gas approximation, not an incompressible fluid simulation.
 * Weighted travel and conservative supercover prevent diagonal corner cutting.
 * Allocation-free updates; presentation evaluates at the caller's continuous time.
 */
export class SmokeVolumes {
  readonly settings: SmokeSettings
  readonly density = new Float32Array(CELLS * VOLUMES)
  readonly solid = new Uint8Array(CELLS * VOLUMES)
  /** RG16F upload: continuous density, independent nearest-sampled geometry. */
  readonly field = new Uint16Array(CELLS * VOLUMES * 2)
  readonly bounds = new Float32Array(VOLUMES * 8)
  readonly advection = new Float32Array(3)
  private readonly arrival = new Float32Array(CELLS * VOLUMES)
  private readonly holes = new Float32Array(CELLS * VOLUMES)
  private readonly queue = new Int32Array(CELLS)
  private readonly positions = new Int32Array(CELLS)
  private readonly age = new Float64Array(VOLUMES)
  private readonly life = new Float32Array(VOLUMES)
  private readonly radius = new Float32Array(VOLUMES)
  private readonly power = new Float32Array(VOLUMES)
  private readonly fadeTime = new Float32Array(VOLUMES)
  private readonly growthTime = new Float32Array(VOLUMES)
  private walls: readonly Wall[] = []
  count = 0
  time = 0
  colorShift = 0.75
  coreGlow = 1
  constructor(settings: Partial<SmokeSettings> = {}) { this.settings = smokeSettings(settings) }
  sustain(x: number, z: number) {
    for (let s = 0; s < VOLUMES; s++) if (this.life[s] && Math.hypot(x-this.bounds[s*8+4],z-this.bounds[s*8+5]) < 2) {
      this.age[s] = Math.min(this.age[s], Math.max(0,this.life[s]-this.fadeTime[s]-0.1)); return
    }
    this.spawn(x,z,2.2,5,0.65,0.8)
  }
  reset(walls: readonly Wall[] = this.walls, seed = 7) {
    this.walls=walls;this.life.fill(0);this.bounds.fill(0);this.density.fill(0);this.solid.fill(0)
    this.field.fill(0);this.holes.fill(0);this.age.fill(0);this.advection.fill(0);this.count=0;this.time=0
    for(let i=0;i<3;i++){seed=Math.imul(seed,1664525)+1013904223|0;this.advection[i]=(seed>>>0)/4294967296*28}
  }
  spawn(x: number, z: number, radius = this.settings.radius, life = this.settings.growthTime+this.settings.hold+this.settings.fade, power = 1, soot = 0, growthTime = soot > 0 ? Math.min(0.75, this.settings.growthTime * 0.42) : this.settings.growthTime) {
    if (![x,z,radius,life,power,soot,growthTime].every(Number.isFinite)) return false
    let slot = -1
    for (let s=0;s<VOLUMES;s++) if (!this.life[s]) {slot=s;break}
    if (slot<0) return false
    const b=slot*8,start=slot*CELLS
    // Put the source exactly at a cell centre, rather than snapping it to a cell corner.
    this.bounds[b]=x-12.25;this.bounds[b+1]=z-12.25
    this.bounds[b+2]=24;this.bounds[b+3]=0;this.bounds[b+4]=x;this.bounds[b+5]=z
    this.bounds[b+6]=Math.max(0,Math.min(1,soot));this.bounds[b+7]=0
    this.age[slot]=0;this.life[slot]=Math.max(0.1,life);this.radius[slot]=Math.max(0.1,Math.min(10,radius));this.power[slot]=Math.max(0,Math.min(2,power))
    this.fadeTime[slot]=Math.min(this.life[slot],soot>0?Math.min(this.life[slot]*0.55,this.settings.fade):this.settings.fade)
    this.growthTime[slot]=Math.max(0.08,growthTime)
    this.arrival.fill(Infinity,start,start+CELLS);this.holes.fill(0,start,start+CELLS)
    this.solid.fill(0,start,start+CELLS);this.density.fill(0,start,start+CELLS);this.field.fill(0,start*2,(start+CELLS)*2)
    // Conservative rasterization includes thin walls between cell centres.
    for (const w of this.walls) {
      const x0=Math.max(0,Math.floor((w[0]-this.bounds[b])*2)),x1=Math.min(GRID-1,Math.floor((w[2]-this.bounds[b])*2))
      const z0=Math.max(0,Math.floor((w[1]-this.bounds[b+1])*2)),z1=Math.min(GRID-1,Math.floor((w[3]-this.bounds[b+1])*2))
      for(let iz=z0;iz<=z1;iz++)for(let ix=x0;ix<=x1;ix++)this.solid[start+iz*GRID+ix]=1
    }
    const root=24*GRID+24
    if(this.solid[start+root]){this.life[slot]=0;return false}
    this.positions.fill(-1);this.queue[0]=root;this.arrival[start+root]=0;this.positions[root]=0
    let size=1
    while(size){
      const i=this.queue[0],last=this.queue[--size]
      this.positions[i]=-2
      if(size){
        let p=0
        while(p*2+1<size){
          let child=p*2+1
          if(child+1<size&&this.arrival[start+this.queue[child+1]]<this.arrival[start+this.queue[child]])child++
          if(this.arrival[start+last]<=this.arrival[start+this.queue[child]])break
          this.queue[p]=this.queue[child];this.positions[this.queue[p]]=p;p=child
        }
        this.queue[p]=last;this.positions[last]=p
      }
      const ix=i%GRID,iz=Math.floor(i/GRID)
      for(let d=0;d<DX.length;d++){
        const dx=DX[d],dz=DZ[d],nx=ix+dx,nz=iz+dz,n=nz*GRID+nx
        if(nx<0||nx>=GRID||nz<0||nz>=GRID||this.positions[n]===-2)continue
        // Short move rectangle is stricter than a line at narrow/diagonal corners.
        let blocked=false
        for(let z=Math.min(iz,nz);z<=Math.max(iz,nz);z++)for(let x=Math.min(ix,nx);x<=Math.max(ix,nx);x++)if(this.solid[start+z*GRID+x])blocked=true
        if(blocked)continue
        const distance=this.arrival[start+i]+Math.hypot(dx,dz)*0.5
        if(distance>=this.arrival[start+n])continue
        this.arrival[start+n]=distance
        let p=this.positions[n]
        if(p<0)p=size++
        while(p>0){const parent=(p-1)>>1;if(this.arrival[start+this.queue[parent]]<=distance)break;this.queue[p]=this.queue[parent];this.positions[this.queue[p]]=p;p=parent}
        this.queue[p]=n;this.positions[n]=p
      }
    }
    this.count++
    return true
  }
  /** Temporary cylinder carve, refilling in about 0.7s. */
  carve(ax:number,az:number,bx:number,bz:number,radius=0.35){
    const dx=bx-ax,dz=bz-az,length2=dx*dx+dz*dz
    for(let s=0;s<VOLUMES;s++){
      if(!this.life[s])continue
      for(let i=0;i<CELLS;i++){
        const x=this.bounds[s*8]+(i%GRID+0.5)*0.5,z=this.bounds[s*8+1]+(Math.floor(i/GRID)+0.5)*0.5
        const t=length2?Math.max(0,Math.min(1,((x-ax)*dx+(z-az)*dz)/length2)):0
        if((x-ax-dx*t)**2+(z-az-dz*t)**2<radius*radius)this.holes[s*CELLS+i]=1
      }
    }
  }
  update(dt:number){
    dt=Number.isFinite(dt)?Math.max(0,dt):0;this.time+=dt;this.count=0
    this.advection[0]-=dt*this.settings.wind;this.advection[1]-=dt*this.settings.rise;this.advection[2]+=dt*this.settings.wind*0.55
    for(let s=0;s<VOLUMES;s++){
      const start=s*CELLS
      if(!this.life[s])continue
      this.age[s]+=dt
      if(this.age[s]>=this.life[s]){this.life[s]=0;this.bounds[s*8+7]=0;this.density.fill(0,start,start+CELLS);this.field.fill(0,start*2,(start+CELLS)*2);continue}
      this.count++
      const age=this.age[s],soot=this.bounds[s*8+6],u=Math.min(1,age/this.growthTime[s])
      const progress=soot>0?0.64*(1-Math.pow(1-u,2.8))+0.36*(1-Math.exp(-age/(this.growthTime[s]*1.4))):u
      const reach=this.radius[s]*progress
      this.bounds[s*8+3]=reach
      const fade=Math.min(1,age*(soot>0?12:5))*Math.min(1,(this.life[s]-age)/this.fadeTime[s])
      this.bounds[s*8+7]=soot>0?Math.max(0.001,Math.min(1,age/this.life[s])):fade
      const soft=soot>0?Math.max(this.settings.softness,Math.min(2.6,this.radius[s]*0.52)):this.settings.softness
      for(let i=0;i<CELLS;i++){
        const at=start+i,distance=this.arrival[at]
        this.holes[at]=Math.max(0,this.holes[at]-dt*1.5)
        const edge=Math.max(0,Math.min(1,(reach-distance)/soft))
        // Keep the central fireball zone clear of low-res volumetric fog while the high-res fireball billows burn (0..0.42s),
        // then fill the rising column with dense soot as the fireball crusts over.
        const coreClear=soot>0&&age<0.44?Math.min(1,Math.max(0.08,Math.pow(age/0.44,1.8)+Math.max(0,(distance-1.15)/1.45))):1
        const d=this.solid[at]?0:fade*coreClear*edge*edge*(3-2*edge)*this.power[s]*(1-this.holes[at])
        this.density[at]=d;this.field[at*2]=half(d);this.field[at*2+1]=this.solid[at]?0x3c00:0
      }
    }
  }
}
const bits=new Uint32Array(1),floats=new Float32Array(bits.buffer)
function half(value:number){
  floats[0]=value
  const n=bits[0],e=((n>>>23)&255)-127+15
  if(e<=0)return Math.round(value*16777216)
  return (e<<10)+(((n&0x7fffff)+0x1000)>>13)
}
