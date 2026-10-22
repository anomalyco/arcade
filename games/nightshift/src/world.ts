import { Mesh, MAT, packVerts, hex, type Rgb } from "@arcade/kit/gpu/mesh"
import type { Rect } from "@arcade/kit/sim/geom"
import type { MovingMesh } from "./polish/moving-mesh"
import { buildElevator } from "./elevator"

// Metres. Surface IDs are carried in aux; the scene owns the material recipes.
export const SURFACE = { plastic: 0, fabric: 1, carpet: 2, laminate: 3, ceiling: 4, metal: 5, paper: 6, tube: 7, crt: 8, led: 9, wood: 10, deadTube: 15, carSteel: 20, carWood: 21, carLight: 22, hallScreen: 23, doorGlow: 24 }
export const PHONE = { x: 0.12, y: 0.82, z: -5.4 }
export const START = { x: -0.2, z: 5.7, yaw: -0.025, pitch: -0.025 }
export const CLOSE = { x: -0.08, z: -4.82, yaw: -0.30, pitch: -0.95 }
export const OFFICE = { x: 3.9, z: -7.15 }
export const BLINDS = { x: -3.72, bottom: .94, pitch: .066, count: 24, width: 2.28 }
export const RECEIVER_PAD = .10
export const CRADLE = [PHONE.x-0.102*1.3,PHONE.y+0.10,PHONE.z+.06]
export const CORD_END = [CRADLE[0],CRADLE[1],CRADLE[2]+RECEIVER_PAD]
export const PHONE_INDICATOR = [PHONE.x+.16,PHONE.z-.14]
export const walls: Rect[] = []
/** Light blockers with heights (partitions, walls, furniture) for the look's bounced-light grid. */
export const occluders: { rect: Rect; h: number }[] = []
export const partitions: { x: number; z: number; w: number; d: number; h: number }[] = []
export type ChairRect=[number,number,number,number]
export const chairs: ChairRect[] = []
export const movingMeshes:MovingMesh[]=[]
let moveEnabled=true
function moving(m:Mesh,first:number,kind:MovingMesh["kind"],x:number,z:number){if(moveEnabled)movingMeshes.push({kind,x,z,data:packVerts(m.v.splice(first))})}
export const COLLEAGUES=[-2,1,4].flatMap(z=>[-1.95,2.4].map(x=>({x,z:z-.35})))
export const CONTINUITY_MONITOR=COLLEAGUES.find(c=>c.x>0&&c.z<0)!
type Range={first:number;count:number}
export const stackContacts:{id:string;support:Range;prop:Range}[]=[]
function range(m:Mesh,first:number):Range{return {first:first/11,count:(m.v.length-first)/11}}
function top(m:Mesh,r:Range){let y=-Infinity;for(let i=r.first*11;i<(r.first+r.count)*11;i+=11)y=Math.max(y,m.v[i+1]);return y}
/** Fit the built geometry, including bevels and lids, onto its supporting geometry. */
function stack(m:Mesh,id:string,support:Range,build:()=>void):Range{
  const from=m.v.length;build();let bottom=Infinity
  for(let i=from;i<m.v.length;i+=11)bottom=Math.min(bottom,m.v[i+1])
  const dy=top(m,support)-bottom
  for(let i=from;i<m.v.length;i+=11)m.v[i+1]+=dy
  const prop=range(m,from);stackContacts.push({id,support,prop});return prop
}
const beige = hex(0xaaa28a), edge = hex(0x6c6d60), dark = hex(0x242c29), paper = hex(0xb7b5a0)

function tag(mesh: Mesh, from: number, surface: number) { for(let i=from+10;i<mesh.v.length;i+=11) mesh.v[i]=surface }
export function box(m: Mesh, x:number,y:number,z:number,w:number,h:number,d:number,c:Rgb,s=0,b=0) {
  const from=m.v.length
  if(b) m.bevelBox(x-w/2,y,z-d/2,x+w/2,y+h,z+d/2,b,c,c)
  else m.box(x-w/2,y,z-d/2,x+w/2,y+h,z+d/2,c,MAT.lit,0,undefined,true)
  tag(m,from,s)
}
export function tube(m:Mesh,a:number[],b:number[],r:number,c:Rgb,s=0,sides=8) {
  const d=b.map((v,i)=>v-a[i]), len=Math.hypot(...d), n=d.map(v=>v/len)
  const ref=Math.abs(n[1])<0.9?[0,1,0]:[1,0,0]
  const cross=(u:number[],v:number[])=>[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]]
  const q=cross(n,ref), ql=Math.hypot(...q), u=q.map(v=>v/ql), v=cross(n,u)
  const point=(p:number[],t:number)=>p.map((k,i)=>k+r*(u[i]*Math.cos(t)+v[i]*Math.sin(t)))
  for(let i=0;i<sides;i++) { const t=i/sides*Math.PI*2, t1=(i+1)/sides*Math.PI*2; m.quadAuto(point(a,t),point(b,t),point(b,t1),point(a,t1),c,MAT.lit,s) }
}
function ring(m:Mesh,x:number,y:number,z:number,r:number,thick:number,c:Rgb,s=0,vertical=false) {
  for(let i=0;i<48;i++) {
    const p=(t:number)=>vertical?[x+Math.cos(t)*r,y+Math.sin(t)*r,z]:[x+Math.cos(t)*r,y,z+Math.sin(t)*r]
    tube(m,p(i/48*Math.PI*2),p((i+1)/48*Math.PI*2),thick,c,s,6)
  }
}
function rotate(m:Mesh,from:number,x:number,z:number,yaw:number) {
  const c=Math.cos(yaw),s=Math.sin(yaw)
  for(let i=from;i<m.v.length;i+=11) {
    const dx=m.v[i]-x,dz=m.v[i+2]-z,nx=m.v[i+3],nz=m.v[i+5]
    m.v[i]=x+c*dx+s*dz;m.v[i+2]=z-s*dx+c*dz
    m.v[i+3]=c*nx+s*nz;m.v[i+5]=-s*nx+c*nz
  }
}
function partition(m:Mesh,x:number,z:number,w:number,d:number,h=1.47) {
  box(m,x,0,z,w,h,d,hex(0x777665),1,0.02)
  box(m,x,h-0.025,z,w+0.018,0.035,d+0.018,edge,5,0.008)
  for(const side of [-1,1]) {
    if(w>=d)box(m,x+side*w/2,0,z,0.05,h+0.012,d+0.018,edge,5,0.008)
    else box(m,x,0,z+side*d/2,w+0.018,h+0.012,0.05,edge,5,0.008)
  }
  box(m,x,0.02,z,w+0.025,0.075,d+0.025,hex(0x474c44),5)
  walls.push([x-w/2,z-d/2,x+w/2,z+d/2]);occluders.push({rect:[x-w/2,z-d/2,x+w/2,z+d/2],h});partitions.push({x,z,w,d,h})
}
function cabinet(m:Mesh,x:number,z:number,w=0.5,h=0.72) {
  const first=m.v.length
  walls.push([x-w/2,z-0.325,x+w/2,z+0.325]);occluders.push({rect:[x-w/2,z-0.325,x+w/2,z+0.325],h:h+.04})
  box(m,x,0.04,z,w,h,0.65,hex(0x777a6b),5,0.015)
  const shell=range(m,first)
  for(let i=0;i<3;i++) {
    const from=m.v.length
    const y=0.065+i*h/3
    box(m,x,y,z+0.333,w-0.035,h/3-0.028,0.018,hex(0x848371),5,0.004)
    box(m,x,y+h/6,z+0.351,0.15,0.026,0.025,dark,5,0.003)
    box(m,x,y+h/6+0.055,z+0.347,0.13,0.036,0.005,paper,6)
    if(x===1.65&&z===3.48&&i===0){
      box(m,x,y,z+.16,w-.06,.012,.31,dark,5)
      for(const side of [-1,1])box(m,x+side*(w/2-.035),y,z+.16,.014,h/3-.04,.31,edge,5)
      moving(m,from,"drawer",x,z)
    }
  }
  return shell
}
function archiveBox(m:Mesh,x:number,y:number,z:number,w=.38) {
  box(m,x,y,z,w,.23,.32,hex(0x8b8064),6,.005)
  box(m,x,y+.23,z,w+.014,.025,.334,hex(0x9d9278),6,.003)
  box(m,x,y+.12,z+.163,w*.36,.047,.003,paper,6)
  box(m,x,y+.183,z+.165,.09,.016,.004,dark)
}
function foregroundStorage(m:Mesh) {
  // Low left credenza with an open book bay and two enclosed doors.
  const x=-2.13,z=3.48,w=2.55
  walls.push([x-w/2,z-.29,x+w/2,z+.29])
  box(m,x,.07,z,w,.72,.55,hex(0x48544d),5,.012)
  const lid=m.v.length
  box(m,x,.80,z,w+.04,.042,.59,hex(0x746750),10,.007)
  const credenza=range(m,lid)
  for(const dx of [-.36,.43]) {
    box(m,x+dx,.10,z+.282,.75,.67,.018,hex(0x657065),5,.006)
    box(m,x+dx+.25,.69,z+.296,.07,.014,.012,dark,5)
  }
  box(m,x-1.0,.10,z+.284,.43,.66,.02,hex(0x202b29))
  box(m,x-1.0,.40,z+.31,.45,.018,.12,hex(0x766b53),10)
  binders(m,x-1.17,.115,z+.28,5);binders(m,x-1.17,.42,z+.28,5)
  const carton=stack(m,"left lower box",credenza,()=>archiveBox(m,-2.25,0,z,.42))
  stack(m,"left upper box",carton,()=>archiveBox(m,-2.25,0,z,.34))
  stack(m,"credenza binders",credenza,()=>binders(m,-1.89,0,z,9))
  stack(m,"credenza plant",credenza,()=>plant(m,-1.02,0,z))
  // Broad lateral drawers, rather than a row of narrow pedestal cabinets.
  const left=cabinet(m,1.65,3.48,1.36,1.10),right=cabinet(m,3.06,3.48,1.36,1.10)
  let support=left
  for(let i=0;i<3;i++) {
    const px=1.44,pz=3.48
    let floor:Range={first:0,count:0}
    support=stack(m,`tray ${i}`,support,()=>{
      const first=m.v.length;box(m,px,0,pz,.48,.012,.36,dark,5,.003);floor=range(m,first)
      for(const s of [-1,1])box(m,px+s*.24,0,pz,.012,.073,.36,edge,5)
      box(m,px,0,pz-.174,.48,.073,.012,edge,5)
    })
    stack(m,`tray ${i} paper`,floor,()=>box(m,px,0,pz,.41,.024,.30,paper,6))
  }
  stack(m,"right file box A",left,()=>archiveBox(m,2.08,0,3.48,.41))
  stack(m,"right file box B",right,()=>archiveBox(m,2.77,0,3.50,.44))
}
function windowBlinds(m:Mesh,z:number) {
  const {x,bottom,pitch,count,width}=BLINDS
  // Opaque night glass is dark; only the narrow blade edges emit sodium light.
  box(m,x-.15,.87,z,.025,1.78,2.4,hex(0x0b1618),13)
  for(const side of [-1,1])box(m,x-.06,.85,z+side*1.20,.17,1.82,.055,edge,5,.004)
  box(m,x,2.57,z,.12,.075,2.39,hex(0x62685e),5,.009)
  box(m,x+.01,.85,z,.27,.045,2.47,beige,0,.005)
  box(m,x+.015,.925,z,.085,.018,width,edge,5,.005)
  for(let i=0;i<count;i++) {
    const y=bottom+i*pitch
    // A bowed metal strip, tilted about its long axis; each side has real thickness.
    for(let j=0;j<6;j++) {
      const point=(k:number,side:number,end:number)=>{
        const t=k/6-.5
        return [x+t*.061,y-t*.043+.007*(1-4*t*t)+side*.0007,z+end*width/2]
      }
      for(const side of [-1,1]) {
        const a=point(j,side,-1),b=point(j+1,side,-1),c=point(j+1,side,1),d=point(j,side,1)
        m.quadAuto(...(side===1?[a,b,c,d]:[d,c,b,a]) as [number[],number[],number[],number[]],hex(side===1?0x575b50:0x303a35),MAT.lit,5)
      }
    }
    tube(m,[x+.031,y-.021,z-width/2],[x+.031,y-.021,z+width/2],.0012,hex(0xb29764),11,5)
    for(const dz of [-.75,.75])tube(m,[x-.032,y+.023,z+dz],[x+.035,y-.021,z+dz],.0016,hex(0x8c836b))
  }
  for(const dz of [-.75,.75])for(const dx of [-.037,.038])tube(m,[x+dx,.92,z+dz],[x+dx,2.57,z+dz],.0018,hex(0x817c69))
  tube(m,[x+.07,2.57,z+1.08],[x+.07,1.1,z+1.08],.002,beige)
  box(m,x+.07,1.06,z+1.08,.012,.04,.012,beige,0,.004)
}
function desk(m:Mesh,x:number,z:number,w=2.25) {
  box(m,x,0.745,z,w,0.045,0.88,hex(0xa3a18b),3,0.012)
  box(m,x,0.727,z,w+0.006,0.019,0.885,hex(0x53574d),5,0.003)
  cabinet(m,x+w/2-0.29,z,0.48,0.67)
  for(const side of [-1,1]) box(m,x-w/2+0.055,0.02,z+side*0.35,0.038,0.72,0.038,edge,5)
  walls.push([x-w/2,z-0.44,x+w/2,z+0.44]);occluders.push({rect:[x-w/2,z-0.44,x+w/2,z+0.44],h:.79})
}
function binders(m:Mesh,x:number,y:number,z:number,count=7) {
  for(let i=0;i<count;i++) {
    const w=0.045+(i%3)*0.009, cx=x+i*0.065
    box(m,cx,y,z,w,0.28+(i%2)*0.025,0.22,hex([0x525c57,0x7a7563,0x363e3b,0x81765f][i%4]),0,0.003)
    box(m,cx,y+0.15,z+0.113,w*0.6,0.075,0.003,paper,6)
    ring(m,cx,y+0.055,z+0.115,0.009,0.002,edge,5,true)
  }
}
function crt(m:Mesh,x:number,y:number,z:number,on:boolean) {
  box(m,x,y,z,0.52,0.095,0.51,beige,0,0.014)
  box(m,x,y+0.095,z-0.03,0.44,0.05,0.35,edge,0,0.012)
  box(m,x,y+0.145,z-0.08,0.48,0.37,0.4,beige,0,0.035)
  box(m,x,y+0.167,z+0.131,0.417,0.312,0.018,hex(0x343f35),0,0.022)
  box(m,x,y+0.19,z+0.144,0.366,0.266,0.019,on?hex(0x65b48c):hex(0x19241f),on?8:0,0.021)
  box(m,x+0.19,y+0.014,z+0.261,0.009,0.006,0.004,on?hex(0x46d67b):dark,on?8:0)
  box(m,x-0.08,y+0.027,z+0.26,0.22,0.008,0.008,dark)
  for(let i=0;i<10;i++) box(m,x+0.244,y+0.22+i*0.018,z-0.12,0.004,0.006,0.19,dark)
  keyboard(m,x,y,z+.53)
}
function keyboard(m:Mesh,x:number,y:number,z:number) {
  // Separate dished keycaps, staggered rows, function keys and numeric keypad.
  const first=m.v.length
  box(m,x,y,z,.54,.031,.20,beige,0,.012)
  box(m,x,y+.028,z,.51,.004,.17,dark,0,.006)
  for(let row=0;row<5;row++)for(let col=0;col<17;col++) {
    if(row===4&&col>2&&col<9)continue
    const px=x-.239+col*.029+(row%2)*.004,pz=z-.068+row*.029
    box(m,px,y+.032,pz,.024,.013,.023,hex(col>12?0x8b8c7c:0xb0ac96),0,.003)
    box(m,px,y+.0451,pz,.016,.0007,.014,hex(0x9c9b87),0,.002)
    // Tiny inset strokes read as legends rather than a blank keyboard slab.
    if(row!==4)for(let k=0;k<2+(col%2);k++)box(m,px-.004+k*.003,y+.046,pz-.003,.001,.0005,.004,dark,6)
  }
  box(m,x-.075,y+.032,z+.048,.19,.013,.024,beige,0,.003)
  rotate(m,first,x,z,.045)
}
function chair(m:Mesh,x:number,z:number) {
  const from=m.v.length
  const collider:ChairRect=[x-0.28,z-0.28,x+0.28,z+0.28];walls.push(collider);chairs.push(collider)
  const cloth=hex(0x46534d)
  box(m,x,0.43,z,0.46,0.075,0.44,cloth,1,0.032)
  box(m,x,0.52,z+0.2,0.43,0.43,0.075,cloth,1,0.035)
  tube(m,[x,0.09,z],[x,0.43,z],0.032,edge,5)
  for(let i=0;i<5;i++) {
    const a=i/5*Math.PI*2, px=x+Math.cos(a)*0.29,pz=z+Math.sin(a)*0.29
    tube(m,[x,0.12,z],[px,0.07,pz],0.022,dark,5)
    box(m,px,0.015,pz,0.075,0.055,0.045,dark,0,0.012)
  }
  for(const s of [-1,1]) { tube(m,[x+s*0.27,0.46,z+0.1],[x+s*0.27,0.65,z+0.1],0.013,edge,5);box(m,x+s*0.27,0.65,z,0.045,0.03,0.3,dark,0,0.01) }
  moving(m,from,"chair",x,z)
}
function plant(m:Mesh,x:number,y:number,z:number) {
  m.prism(x,z,0.12,0.16,y,y+0.22,24,hex(0x73766a));m.prism(x,z,0.147,0.147,y+0.215,y+0.22,24,hex(0x292d23))
  for(let i=0;i<9;i++) {
    const a=i*2.4,h=0.4+(i%3)*0.09,dx=Math.cos(a)*0.18,dz=Math.sin(a)*0.18
    const tip=[x+dx,y+0.22+h,z+dz],end=[x+dx*1.4,y+0.15+h*0.45,z+dz*1.4]
    tube(m,[x,y+0.2,z],tip,0.004,hex(0x393d27));tube(m,tip,end,0.003,hex(0x514b2b))
    m.facet(tip,[end[0]+0.035,end[1]+0.09,end[2]],end,hex(0x494d2c));m.facet(end,[end[0]+0.035,end[1]+0.09,end[2]],tip,hex(0x494d2c))
  }
}
function phone(m:Mesh) {
  const {x,y,z}=PHONE
  // One cord from the base to the receiver. Negative aux stores arc position;
  // the vertex shader lifts its free end with the handset, keeping the base fixed.
  const a=[x+0.17,y+0.01,z+0.12],b=[x+0.2,0.798,z+0.31],c=[x-0.28,0.798,z+0.31]
  const p=(k:number)=>{const t=k/850,u=1-t,ph=t*Math.PI*2*48,r=0.009*Math.sin(Math.PI*t);return a.map((v,i)=>u*u*u*v+3*u*u*t*b[i]+3*u*t*t*c[i]+t*t*t*CORD_END[i]+(i===0?Math.cos(ph):i===1?Math.sin(ph):0)*r)}
  for(let i=0;i<850;i++) {
    const a=p(i),b=p(i+1),first=m.v.length
    tube(m,a,b,0.0035,hex(0x343d30),-1,5)
    for(let j=first;j<m.v.length;j+=11) {
      const da=Math.hypot(...a.map((v,k)=>v-m.v[j+k])),db=Math.hypot(...b.map((v,k)=>v-m.v[j+k]))
      m.v[j+10]=-1-100*(i+(db<da?1:0))/850
    }
  }
}
export function handset() {
  const m=new Mesh(),c=hex(0xa6a38a)
  // One smooth molded shell, scaled to the base's two actual support pads.
  const rings=[[-.218,.035,.020,.006],[-.208,.052,.029,.006],[-.185,.056,.031,.006],[-.169,.056,.031,.006],[-.145,.052,.029,.009],[-.11,.043,.022,.022],[-.06,.039,.021,.026],[0,.038,.021,.027],[.06,.039,.021,.026],[.11,.043,.022,.022],[.145,.052,.029,.009],[.169,.056,.031,.006],[.185,.056,.031,.006],[.208,.052,.029,.006],[.218,.035,.020,.006]]
  const point=(r:number[],a:number)=>[r[1]*Math.sign(Math.cos(a))*Math.abs(Math.cos(a))**.45,r[3]+r[2]*Math.sign(Math.sin(a))*Math.abs(Math.sin(a))**.45,r[0]]
  const normal=(i:number,a:number)=>{
    const a0=point(rings[i],a-.001),a1=point(rings[i],a+.001),b0=point(rings[Math.max(0,i-1)],a),b1=point(rings[Math.min(rings.length-1,i+1)],a)
    const u=a1.map((v,k)=>v-a0[k]),v=b1.map((v,k)=>v-b0[k]),n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]],d=Math.hypot(...n)
    return n.map(v=>v/d)
  }
  for(let i=0;i<rings.length-1;i++)for(let j=0;j<32;j++) {
    const a=j*Math.PI/16,b=(j+1)*Math.PI/16
    for(const [r,t] of [[i,a],[i,b],[i+1,b],[i,a],[i+1,b],[i+1,a]])m.vert(point(rings[r],t),normal(r,t),c,MAT.lit)
  }
  for(const i of [0,rings.length-1])for(let j=0;j<32;j++) {
    const n=[0,0,i===0?-1:1],a=point(rings[i],j*Math.PI/16),b=point(rings[i],(j+1)*Math.PI/16)
    for(const p of [[0,rings[i][3],rings[i][0]],...(i===0?[b,a]:[a,b])])m.vert(p,n,c,MAT.lit)
  }
  for(const z of [-.169,.169])for(let i=0;i<5;i++)for(let j=0;j<4;j++)box(m,-.024+i*.012,-.0255,z-.018+j*.012,.002,.001,.002,dark)
  for(let i=0;i<m.v.length;i+=11) {
    m.v[i+2]*=RECEIVER_PAD/.169
    const n=[m.v[i+3],m.v[i+4],m.v[i+5]*.169/RECEIVER_PAD],length=Math.hypot(...n)
    for(let j=0;j<3;j++)m.v[i+3+j]=n[j]/length
  }
  return m
}
export function phoneIndicator() {
  const m=new Mesh()
  box(m,0,0,0,.014,.003,.010,hex(0xff3d21),9,.001)
  return m
}
export function buildWorld(movable=true) {
  moveEnabled=movable
  walls.length=0
  chairs.length=0;stackContacts.length=0;movingMeshes.length=0;occluders.length=0;partitions.length=0
  const m=new Mesh()
  // The PBR carpet plane in props.ts owns y=0; slab top stays below it.
  box(m,0,-0.12,0,12,0.11,18,hex(0x565548),2)
  box(m,0,2.95,0,12,0.14,18,hex(0x88897a),4)
  // The acoustic grid is real geometry with inset tiles.
  for(let x=-6;x<=6;x+=0.6) box(m,x,2.928,0,0.014,0.025,18,hex(0x5b6159),5)
  for(let z=-9;z<=9;z+=1.2) box(m,0,2.928,z,12,0.025,0.014,hex(0x5b6159),5)
  for(const x of [-4,6]) {box(m,x,0,0,0.18,3,18,hex(0x6b766c),0);walls.push([x-0.1,-9,x+0.1,9]);occluders.push({rect:[x-0.1,-9,x+0.1,9],h:3})}
  box(m,0,0,-9,12,3,.18,hex(0x6b766c));walls.push([-6,-9.1,6,-8.9]);occluders.push({rect:[-6,-9.1,6,-8.9],h:3})
  for(const [a,b] of [[-6,-1],[1,6]]){box(m,(a+b)/2,0,9,b-a,3,.18,hex(0x6b766c));walls.push([a,8.9,b,9.1]);occluders.push({rect:[a,8.9,b,9.1],h:3})}
  box(m,0,2.65,9,2,.35,.18,hex(0x6b766c));buildElevator(m,walls)
  // Blinds: thin metal blades, ladder cords and a deep reveal, on the left exterior wall.
  for(const z of [4,0,-4,-7])windowBlinds(m,z)
  // Repeated dark work stations frame one uninterrupted centre aisle.
  for(const z of [4,1,-2]) for(const side of [-1,1]) {
    partition(m,side===-1?-2.4:3.45,z+.1,side===-1?3.0:4.7,.09,.95)
    if(z!==4) partition(m,side*1.18,z,.09,1.8,1.05)
    desk(m,side===-1?-2.6:3.4,z-0.4,side===-1?2.0:2.6);binders(m,side===-1?-2.6:3.4,0.8,z-0.55,6)
    const x=side===-1?-1.95:2.4,first=m.v.length
    crt(m,x,.795,z-.35,false);rotate(m,first,x,z-.35,Math.PI)
    chair(m,x+side*.35,z-1.3)
  }
  foregroundStorage(m)
  for(const x of [-3.2,3.2]) box(m,x,0,-5.8,0.36,2.94,0.36,hex(0x67766c),0,0.012)
  partition(m,0,-6.4,3.4,0.09,1.48)
  for(const x of [-1.7,1.7]) partition(m,x,-5.35,0.09,2.2,1.48)
  desk(m,0,-5.55,3.25)
  keyboard(m,-.74,.795,-5.15)
  phone(m);binders(m,0.65,0.795,-5.82,9)
  const heroChair:ChairRect=[.34,-4.85,.96,-4.25];walls.push(heroChair);chairs.push(heroChair)
   // Flat, broken dried stain rather than a raised torus.
   for(let i=0;i<60;i++) {
     if(i%13===0||i%17===0)continue
     const a=i/60*Math.PI*2,b=(i+1)/60*Math.PI*2,r=.068+Math.sin(i*2.3)*.0015
     m.quadAuto([-.24+Math.cos(a)*r,.791,-5.2+Math.sin(a)*r],[-.24+Math.cos(b)*r,.791,-5.2+Math.sin(b)*r],[-.24+Math.cos(b)*(r+.0025),.791,-5.2+Math.sin(b)*(r+.0025)],[-.24+Math.cos(a)*(r+.0025),.791,-5.2+Math.sin(a)*(r+.0025)],hex(0x756d4b),MAT.lit,6)
   }
  // Notebook and yellow memo; the rolodex is a separate textured prop.
  box(m,0.54,0.792,-5.2,0.14,0.001,0.13,hex(0xb3ac62),6)
  for(let i=0;i<4;i++) box(m,0.54,0.794,-5.235+i*0.016,0.08-i*0.012,0.001,0.0018,hex(0x5e6143),6)
  box(m,1.4,0.795,-5.3,0.22,0.016,0.27,hex(0x576250),0,0.006)
  box(m,1.4,0.813,-5.3,0.20,0.002,0.25,paper,6)
  for(let i=0;i<13;i++) box(m,1.4,0.816,-5.4+i*0.016,0.175,0.001,0.0008,hex(0x667e77),6)
  tube(m,[1.33,0.825,-5.41],[1.46,0.825,-5.25],0.003,dark)
  plant(m,-2.2,0,-5.5)
  // Overlapping, turned paperwork; each sheet has distinct age and line lengths.
  for(let i=0;i<7;i++) {
    const x=-1.28+(i%3)*.16,z=-5.25-Math.floor(i/3)*.09,first=m.v.length,y=.792+i*.0015
    box(m,x,y,z,.21,.001,.28,hex(i%2?0xb6ae94:0x969a86),6)
    for(let j=0;j<9;j++)box(m,x-.01,y+.0011,z-.10+j*.022,.11+(j%3)*.018,.0003,.001,hex(0x717466),6)
    rotate(m,first,x,z,Math.sin(i*4.7)*.38)
    moving(m,first,"paper",x,z)
  }
  // Jay's corner office: a usable doorway, ajar slab, and a warm reading lamp.
  partition(m,2.05,-7.65,.12,2.55,2.75)
  partition(m,2.50,-6.4,1.0,.12,2.75)
  partition(m,5.30,-6.4,1.4,.12,2.75)
  box(m,3.80,2.23,-6.4,1.6,.5,.13,hex(0x667267),0)
  const door=m.v.length
  box(m,3.47,0,-6.43,.94,2.2,.065,hex(0x75624b),10,.012)
  box(m,3.82,1.0,-6.38,.12,.025,.035,hex(0x9a8765),5,.006)
  rotate(m,door,3.0,-6.43,1.15)
  walls.push([2.95,-7.32,3.42,-6.4])
  desk(m,4.5,-8.12,2.1);chair(m,4.6,-8.65)
  box(m,3.74,.79,-8.1,.24,.035,.22,dark,5,.02)
  tube(m,[3.74,.81,-8.1],[3.74,1.25,-8.1],.014,hex(0x897959),5)
  const lamp=m.v.length
  m.prism(3.74,-8.1,.19,.10,1.15,1.43,32,hex(0xbaa06b))
  tag(m,lamp,12)
  binders(m,4.8,.80,-8.3,4)
  const officeWindow=m.v.length
  windowBlinds(m,0)
  rotate(m,officeWindow,0,0,-Math.PI/2)
  for(let i=officeWindow;i<m.v.length;i+=11){m.v[i]+=4.35;m.v[i+2]-=5.12}
  // Low modesty panel and a closed file anchor the otherwise empty encounter.
  box(m,4.5,.16,-7.77,1.92,.57,.025,hex(0x71674f),10,.006)
  box(m,4.45,.795,-8.01,.31,.018,.23,hex(0x776744),6,.003)
  box(m,4.46,.814,-8.01,.28,.002,.21,paper,6)
  box(m,5.69,.08,-7.65,.35,2.30,1.24,hex(0x605845),10,.007)
  for(let i=0;i<4;i++) {
    const first=m.v.length
    binders(m,-.48,.15+i*.52,0,13)
    rotate(m,first,0,0,-Math.PI/2)
    for(let j=first;j<m.v.length;j+=11){m.v[j]+=5.48;m.v[j+2]-=7.65}
    box(m,5.50,.125+i*.52,-7.65,.42,.025,1.25,hex(0x827254),10)
  }
  // Troffers: reflectors, dark housings, louvres. Only one tube is alive in each lit unit.
  for(const z of [5,0,-4,-7]) for(const x of [0,3.6,-3.6]) {
    box(m,x,2.87,z,0.36,0.06,1.12,hex(0x505a53),5)
    box(m,x,2.866,z,0.29,0.006,1.02,hex(0x888b79),5)
    for(const side of [-1,1]) box(m,x+side*0.085,2.80,z,0.035,0.025,0.95,hex(0xb6c3a8),x===0&&z===0&&side===1?7:x===-3.6&&z===-4&&side===1?7:15,0.01)
    for(let i=0;i<5;i++) box(m,x,2.83,z-0.49+i*0.24,0.31,0.028,0.008,hex(0x59645a),5)
  }
  return { data: packVerts(m.v), vertices: m.v.length/11 }
}
