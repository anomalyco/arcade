import type { Wall } from "../fx/volume"

/**
 * Coherent 72m × 76m vehicle & effect proving yard:
 * - Perimeter walls [-36..36, -42..34]
 * - Effect test alcove [-22..-10, -14..-4] with doorway and glass window [-16.5..-10, -4.3]
 * - Lane divider bollards separating the central acceleration/braking lane from the west skid pad
 */
export const yardWalls:readonly Wall[]=[
  [-36,-42,36,-41],
  [-36,-42,-35,34],
  [35,-42,36,34],
  [-36,33,36,34],
  [-22,-14,-10,-13.4],
  [-22,-14,-21.4,-4],
  [-22,-4.6,-16.5,-4],
  [-6.5,-24,-5.7,-20],
  [-6.5,2,-5.7,6],
]

export type YardRampSpec = { x:number; z:number; h:number; width:number; length:number; height:number; peak:number }

export const yardRamp:YardRampSpec={x:10,z:-3,h:Math.PI,width:5,length:8,height:1.3,peak:0.72}
export const yardRamps:readonly YardRampSpec[]=[
  yardRamp,
  {x:18,z:-18,h:Math.PI,width:5.5,length:10,height:1.15,peak:0.68},
  {x:18,z:10,h:Math.PI,width:4.5,length:7,height:0.22,peak:0.5},
]

export function yardGround(x:number,z:number){
  for(const r of yardRamps){
    const along=-(z-r.z)+r.length/2
    if(Math.abs(x-r.x)<=r.width/2&&along>=0&&along<=r.length){
      const crest=r.length*r.peak
      return along<crest?r.height*along/crest:r.height*(r.length-along)/(r.length-crest)
    }
  }
  return 0
}

/** Ramps, suspension steps, painted acceleration-lane scale ticks, and west skid-pad drift rings. */
export function rampVertices(){
  const out:number[]=[]
  const tri=(a:number[],b:number[],c:number[],col:readonly [number,number,number]=[.25,.29,.32],em=0)=>{
    const u=b.map((n,i)=>n-a[i]!),v=c.map((n,i)=>n-a[i]!),n=[u[1]!*v[2]!-u[2]!*v[1]!,u[2]!*v[0]!-u[0]!*v[2]!,u[0]!*v[1]!-u[1]!*v[0]!],len=Math.hypot(...n)||1
    for(const p of [a,b,c])out.push(p[0]!,p[1]!,p[2]!,n[0]!/len,n[1]!/len,n[2]!/len,col[0],col[1],col[2],em)
  }
  const quadXZ=(x0:number,z0:number,x1:number,z1:number,y:number,col:readonly [number,number,number],em=0)=>{
    tri([x0,y,z0],[x0,y,z1],[x1,y,z1],col,em)
    tri([x0,y,z0],[x1,y,z1],[x1,y,z0],col,em)
  }
  for(const r of yardRamps){
    const x0=r.x-r.width/2,x1=r.x+r.width/2,z0=r.z+r.length/2,z1=z0-r.length*r.peak,z2=z0-r.length
    const col:readonly [number,number,number]=r.height<0.4?[.32,.36,.40]:[.25,.29,.32]
    const a=[x0,0,z0],b=[x1,0,z0],c=[x0,r.height,z1],d=[x1,r.height,z1],e=[x0,0,z2],f=[x1,0,z2]
    tri(a,b,c,col);tri(b,d,c,col);tri(c,d,e,col);tri(d,f,e,col);tri(a,c,e,col);tri(b,f,d,col)
    // Edge stripes on ramps
    quadXZ(x0+0.08,z2,x0+0.22,z0,r.height+0.01,[.75,.58,.18])
    quadXZ(x1-0.22,z2,x1-0.08,z0,r.height+0.01,[.75,.58,.18])
  }
  // Straight acceleration & braking lane scale markers along x = [-3.4, 3.4], z = [-34..22]
  const paint:readonly [number,number,number]=[.38,.44,.50]
  const startPaint:readonly [number,number,number]=[.68,.54,.22]
  quadXZ(-3.2,7.85,3.2,8.15,0.008,startPaint)
  for(let z=-32;z<=20;z+=4){
    quadXZ(-3.4,z, -3.22,z+1.8,0.006,paint)
    quadXZ(3.22,z, 3.4,z+1.8,0.006,paint)
  }
  for(const z of [0,-10,-20,-30]){
    quadXZ(-3.1,z-0.08,-2.1,z+0.08,0.007,paint)
    quadXZ(2.1,z-0.08,3.1,z+0.08,0.007,paint)
  }
  // West Skid Pad drift circle reference rings centered at (-19, 10)
  const cx=-19,cz=10
  for(const radius of [4.5,9.0]){
    const segs=24
    for(let i=0;i<segs;i+=2){
      const a0=(i/segs)*Math.PI*2,a1=((i+1)/segs)*Math.PI*2
      const r0=radius-0.1,r1=radius+0.1
      const p0=[cx+Math.cos(a0)*r0,0.007,cz+Math.sin(a0)*r0]
      const p1=[cx+Math.cos(a0)*r1,0.007,cz+Math.sin(a0)*r1]
      const p2=[cx+Math.cos(a1)*r1,0.007,cz+Math.sin(a1)*r1]
      const p3=[cx+Math.cos(a1)*r0,0.007,cz+Math.sin(a1)*r0]
      tri(p0,p1,p2,paint);tri(p0,p2,p3,paint)
    }
  }
  // Alcove window sill [-16.5..-10, -4.4..-4.1]
  quadXZ(-16.5,-4.45,-10,-4.15,0.85,[.28,.32,.36])
  return out
}

/** Translucent glass pane in the yard's effect test alcove [-16.5..-10, -4.3]. */
export function yardGlassVertices(){
  const out:number[]=[]
  const x0=-16.5,x1=-10,y0=0.85,y1=2.35,z=-4.3
  const face=(nx:number,nz:number)=>{
    const pts=[[x0,y0,z],[x1,y0,z],[x1,y1,z],[x0,y0,z],[x1,y1,z],[x0,y1,z]]
    for(const p of pts)out.push(p[0]!,p[1]!,p[2]!,nx,0,nz,.65,.88,.96,0.25)
  }
  face(0,1);face(0,-1)
  return out
}
