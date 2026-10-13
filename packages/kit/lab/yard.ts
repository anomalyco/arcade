import type { Wall } from "../fx/volume"

export const yardWalls:readonly Wall[]=[[-18,-28,18,-27],[-18,-28,-17,12],[17,-28,18,12]]
export const yardRamp={x:10,z:-3,h:Math.PI,width:5,length:8,height:1.3,peak:0.72}
export function yardGround(x:number,z:number){
  const r=yardRamp,along=-(z-r.z)+r.length/2
  if(Math.abs(x-r.x)>r.width/2||along<0||along>r.length)return 0
  const crest=r.length*r.peak
  return along<crest?r.height*along/crest:r.height*(r.length-along)/(r.length-crest)
}
/** Neutral ramp, same profile used by the adapters' collision/height sampling. */
export function rampVertices(){
  const r=yardRamp,x0=r.x-r.width/2,x1=r.x+r.width/2,z0=r.z+r.length/2,z1=z0-r.length*r.peak,z2=z0-r.length
  const out:number[]=[]
  const tri=(a:number[],b:number[],c:number[])=>{
    const u=b.map((n,i)=>n-a[i]),v=c.map((n,i)=>n-a[i]),n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]],len=Math.hypot(...n)
    for(const p of [a,b,c])out.push(...p,...n.map(x=>x/len),.25,.29,.32,0)
  }
  const a=[x0,0,z0],b=[x1,0,z0],c=[x0,r.height,z1],d=[x1,r.height,z1],e=[x0,0,z2],f=[x1,0,z2]
  tri(a,b,c);tri(b,d,c);tri(c,d,e);tri(d,f,e);tri(a,c,e);tri(b,f,d)
  return out
}
