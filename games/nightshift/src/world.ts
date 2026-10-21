import { Mesh, MAT, packVerts, hex, type Rgb } from "@arcade/kit/gpu/mesh"
import type { Rect } from "@arcade/kit/sim/geom"

// Metres. Surface IDs are carried in aux; the scene owns the material recipes.
export const SURFACE = { plastic: 0, fabric: 1, carpet: 2, laminate: 3, ceiling: 4, metal: 5, paper: 6, tube: 7, crt: 8, led: 9, wood: 10 }
export const PHONE = { x: 0.12, y: 0.82, z: -5.4 }
export const START = { x: -0.2, z: 5.7, yaw: -0.025, pitch: -0.025 }
export const CLOSE = { x: -0.08, z: -4.82, yaw: -0.30, pitch: -0.95 }
export const CRADLE = [PHONE.x-0.102*1.3,PHONE.y+0.10,PHONE.z-0.015*1.3]
export const CORD_END = [CRADLE[0],CRADLE[1],CRADLE[2]+0.169]
export const walls: Rect[] = []
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
function partition(m:Mesh,x:number,z:number,w:number,d:number,h=1.47) {
  box(m,x,0,z,w,h,d,hex(0x777665),1,0.02)
  box(m,x,h-0.025,z,w+0.018,0.035,d+0.018,edge,5,0.008)
  for(const side of [-1,1]) box(m,x+side*(w/2-0.025),0,z,0.05,h+0.012,d+0.018,edge,5,0.008)
  box(m,x,0.02,z,w,0.075,d+0.025,hex(0x474c44),5)
  walls.push([x-w/2,z-d/2,x+w/2,z+d/2])
}
function cabinet(m:Mesh,x:number,z:number,w=0.5,h=0.72) {
  walls.push([x-w/2,z-0.325,x+w/2,z+0.325])
  box(m,x,0.04,z,w,h,0.65,hex(0x777a6b),5,0.015)
  for(let i=0;i<3;i++) {
    const y=0.1+i*h/3
    box(m,x,y,z+0.333,w-0.035,h/3-0.018,0.018,hex(0x848371),5,0.004)
    box(m,x,y+h/6,z+0.351,0.15,0.026,0.025,dark,5,0.003)
    box(m,x,y+h/6+0.055,z+0.347,0.13,0.036,0.005,paper,6)
  }
}
function desk(m:Mesh,x:number,z:number,w=2.25) {
  box(m,x,0.745,z,w,0.045,0.88,hex(0xa3a18b),3,0.012)
  box(m,x,0.727,z,w+0.006,0.019,0.885,hex(0x53574d),5,0.003)
  cabinet(m,x+w/2-0.29,z,0.48,0.67)
  for(const side of [-1,1]) box(m,x-w/2+0.055,0.02,z+side*0.35,0.038,0.72,0.038,edge,5)
  walls.push([x-w/2,z-0.44,x+w/2,z+0.44])
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
  // Separate sculpted keys, not a painted keyboard rectangle.
  box(m,x,y-0.002,z+0.53,0.49,0.035,0.18,beige,0,0.012)
  for(let row=0;row<5;row++) for(let col=0;col<15;col++) {
    if(row===4 && col>3 && col<10) continue
    box(m,x-0.218+col*0.031,y+0.033,z+0.465+row*0.029,0.025,0.012,0.023,hex(0x989a83),0,0.002)
  }
  box(m,x-0.02,y+0.033,z+0.581,0.18,0.012,0.023,beige,0,0.002)
}
function chair(m:Mesh,x:number,z:number) {
  walls.push([x-0.28,z-0.28,x+0.28,z+0.28])
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
  const first=m.v.length
  const {x,y,z}=PHONE
  box(m,x,y-0.03,z,0.32,0.065,0.38,hex(0x696e5d),0,0.016)
  box(m,x,y+0.015,z-0.015,0.31,0.055,0.35,beige,0,0.016)
  // Name/extension card, twelve keypad buttons, six line selectors with inset labels.
  box(m,x+0.037,y+0.072,z-0.108,0.13,0.003,0.087,hex(0x8b927b),6)
  for(let r=0;r<4;r++) for(let c=0;c<3;c++) {
    const px=x-0.017+c*0.037,pz=z-0.025+r*0.035
    box(m,px,y+0.073,pz,0.028,0.011,0.025,hex(0x51594c),0,0.002)
    box(m,px,y+0.084,pz,0.005,0.001,0.009,paper,6)
  }
  for(let i=0;i<7;i++) {
    box(m,x+0.127,y+0.073,z-0.13+i*0.043,0.022,0.008,0.027,i===5?hex(0xff3d21):dark,i===5?9:0,0.002)
    box(m,x+0.1,y+0.073,z-0.13+i*0.043,0.023,0.002,0.027,paper,6)
  }
  for(let i=first;i<m.v.length;i+=11) { m.v[i]=x+(m.v[i]-x)*1.3;m.v[i+2]=z+(m.v[i+2]-z)*1.3 }
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
  box(m,0,0,-0.006,0.065,0.043,0.31,c,0,0.015)
  for(const z of [-0.13,0.13]) {box(m,0,-0.025,z,0.087,0.062,0.074,c,0,0.016);for(let i=0;i<4;i++) for(let j=0;j<4;j++) box(m,-0.021+i*0.014,0.038,z-0.021+j*0.014,0.003,0.001,0.003,dark)}
  for(let i=0;i<m.v.length;i+=11) {m.v[i]*=1.3;m.v[i+2]*=1.3}
  return m
}
export function buildWorld() {
  walls.length=0
  const m=new Mesh()
  box(m,0,-0.12,0,12,0.12,18,hex(0x565548),2)
  box(m,0,2.95,0,12,0.14,18,hex(0x88897a),4)
  // The acoustic grid is real geometry with inset tiles.
  for(let x=-6;x<=6;x+=0.6) box(m,x,2.928,0,0.014,0.025,18,hex(0x5b6159),5)
  for(let z=-9;z<=9;z+=1.2) box(m,0,2.928,z,12,0.025,0.014,hex(0x5b6159),5)
  for(const x of [-6,6]) {box(m,x,0,0,0.18,3,18,hex(0x6b766c),0);walls.push([x-0.1,-9,x+0.1,9])}
  for(const z of [-9,9]) {box(m,0,0,z,12,3,0.18,hex(0x6b766c),0);walls.push([-6,z-0.1,6,z+0.1])}
  // Blinds: thin metal blades, ladder cords and a deep reveal, on the left exterior wall.
  for(const z of [4,0,-4,-7]) {
    box(m,-5.88,0.9,z,0.04,1.65,2.3,hex(0x51412d),0)
    for(const side of [-1,1]) box(m,-5.8,0.85,z+side*1.19,0.17,1.78,0.065,edge,5)
    box(m,-5.77,0.83,z,0.28,0.065,2.45,beige,0)
    for(let i=0;i<24;i++) box(m,-5.72,0.94+i*0.066,z,0.10,0.035,2.28,hex(0x8d8772),5)
    for(const dz of [-0.75,0.75]) tube(m,[-5.65,0.9,z+dz],[-5.65,2.55,z+dz],0.003,hex(0x8d8772))
  }
  // Repeated dark work stations frame one uninterrupted centre aisle.
  for(const z of [4,1,-2]) for(const side of [-1,1]) {
    partition(m,side*3.45,z-0.9,4.7,0.09,z===4?1.75:1.47)
    if(z!==4) partition(m,side*1.18,z,0.09,1.8)
    desk(m,side*3.4,z-0.4,2.6);binders(m,side*3.4,0.8,z-0.55,6)
    crt(m,side*4.1,0.795,z-0.55,false)
    if(side===1) chair(m,3.3,z+0.45)
  }
  plant(m,-2.25,0.79,3.65);binders(m,-2.9,0.795,3.7,6)
  cabinet(m,1.85,3.9,0.65,1.04);cabinet(m,2.55,3.9,0.65,1.04)
  binders(m,1.6,1.09,3.9,5)
  for(let i=0;i<5;i++) box(m,2.3,1.1+i*0.06,3.9,0.62,0.045,0.46,hex(i%2?0x666551:0x8a8067),6,0.005)
  for(const x of [-3.2,3.2]) box(m,x,0,-5.8,0.36,2.94,0.36,hex(0x67766c),0,0.012)
  partition(m,0,-6.4,3.4,0.09,1.48)
  for(const x of [-1.7,1.7]) partition(m,x,-5.35,0.09,2.2,1.48)
  desk(m,0,-5.55,3.25)
  crt(m,-0.74,0.795,-5.72,true);phone(m);binders(m,0.65,0.795,-5.82,9)
  chair(m,0.9,-4.58)
  // Mug: hollow lip, dark coffee, ceramic handle and a separate old coffee ring.
  m.prism(0.62,-5.48,0.055,0.064,0.792,0.94,32,hex(0x87816a),MAT.lit,0,false)
  m.prism(0.62,-5.48,0.055,0.055,0.928,0.929,32,hex(0x171b13))
  ring(m,0.62,0.94,-5.48,0.061,0.004,beige);ring(m,0.7,0.868,-5.48,0.042,0.008,beige,0,true)
  ring(m,-0.24,0.792,-5.2,0.068,0.004,hex(0x5e6246),3)
  // Pen cup, six pens, rolodex on its axle, notebook and yellow memo.
  m.prism(1.02,-5.35,0.055,0.058,0.79,0.93,24,dark,MAT.lit,5,false)
  for(let i=0;i<6;i++) tube(m,[1+i*0.008,0.83,-5.35],[0.98+i*0.015,1.04+(i%3)*0.018,-5.35+(i%2)*0.025],0.003,hex(i%2?0x95947b:0x2a302c),5)
  box(m,1.34,0.795,-5.42,0.23,0.035,0.18,dark,0,0.012)
  for(let i=0;i<26;i++) box(m,1.34,0.83+i*0.001,-5.46+i*0.004,0.2,0.12,0.002,hex(0x999b84),6)
  for(const x of [1.21,1.47]) ring(m,x,0.88,-5.40,0.061,0.012,dark,0,true)
  box(m,0.54,0.792,-5.2,0.14,0.001,0.13,hex(0xb3ac62),6)
  for(let i=0;i<4;i++) box(m,0.54,0.794,-5.235+i*0.016,0.08-i*0.012,0.001,0.0018,hex(0x5e6143),6)
  box(m,1.4,0.795,-5.3,0.22,0.016,0.27,hex(0x576250),0,0.006)
  box(m,1.4,0.813,-5.3,0.20,0.002,0.25,paper,6)
  for(let i=0;i<13;i++) box(m,1.4,0.816,-5.4+i*0.016,0.175,0.001,0.0008,hex(0x667e77),6)
  tube(m,[1.33,0.825,-5.41],[1.46,0.825,-5.25],0.003,dark)
  plant(m,-2.2,0,-5.5)
  // Troffers: reflectors, dark housings, louvres. Only one tube is alive in each lit unit.
  for(const z of [5,0,-4,-7]) for(const x of [0,3.6,-3.6]) {
    box(m,x,2.87,z,0.36,0.06,1.12,hex(0x505a53),5)
    box(m,x,2.866,z,0.29,0.006,1.02,hex(0x888b79),5)
    for(const side of [-1,1]) box(m,x+side*0.085,2.80,z,0.035,0.025,0.95,hex(0xb6c3a8),x===0&&z===0&&side===1?7:x===-3.6&&z===-4&&side===1?7:0,0.01)
    for(let i=0;i<5;i++) box(m,x,2.83,z-0.49+i*0.24,0.31,0.028,0.008,hex(0x59645a),5)
  }
  return { data: packVerts(m.v), vertices: m.v.length/11 }
}
