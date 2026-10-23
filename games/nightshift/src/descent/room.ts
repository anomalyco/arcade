import { Mesh, MAT, hex, packVerts, type Rgb } from "@arcade/kit/gpu/mesh"
import type { Rect } from "@arcade/kit/sim/geom"
import type { SceneLight } from "@arcade/kit/gpu/scene-frame"
import { buildElevator } from "../elevator"
import { BASEMENT_X as X } from "./state"

const iron=hex(0x343d36),edge=hex(0x626450),black=hex(0x141d19),brass=hex(0x88734f)
function box(m:Mesh,x:number,y:number,z:number,w:number,h:number,d:number,c:Rgb=iron,aux=5,bevel=0){
  const start=m.v.length
  if(bevel)m.bevelBox(x-w/2,y,z-d/2,x+w/2,y+h,z+d/2,bevel,c,c)
  else m.box(x-w/2,y,z-d/2,x+w/2,y+h,z+d/2,c,MAT.lit,aux,undefined,true)
  for(let i=start+10;i<m.v.length;i+=11)m.v[i]=aux
}
function tube(m:Mesh,a:number[],b:number[],r:number,c:Rgb=iron,sides=7){
  const d=b.map((v,i)=>v-a[i]),l=Math.hypot(...d),n=d.map(v=>v/l),ref=Math.abs(n[1])>.9?[1,0,0]:[0,1,0]
  const u=[n[1]*ref[2]-n[2]*ref[1],n[2]*ref[0]-n[0]*ref[2],n[0]*ref[1]-n[1]*ref[0]],ul=Math.hypot(...u);for(let i=0;i<3;i++)u[i]/=ul
  const v=[n[1]*u[2]-n[2]*u[1],n[2]*u[0]-n[0]*u[2],n[0]*u[1]-n[1]*u[0]]
  const p=(q:number[],t:number)=>q.map((f,i)=>f+r*(u[i]*Math.cos(t)+v[i]*Math.sin(t)))
  for(let i=0;i<sides;i++)m.quadAuto(p(a,i*2*Math.PI/sides),p(b,i*2*Math.PI/sides),p(b,(i+1)*2*Math.PI/sides),p(a,(i+1)*2*Math.PI/sides),c,MAT.lit,5)
}
export type HallScreen={x:number;y:number;z:number;width:number;height:number;index:number;yaw:number}
export function buildBasement(){
  const m=new Mesh(),walls:Rect[]=[],screens:HallScreen[]=[],lamps:SceneLight[]=[]
  // Same car in both locations. The origin moves only while its opaque doors are fully shut.
  buildElevator(m,walls)
  for(let i=0;i<m.v.length;i+=11)m.v[i]+=X
  for(let i=0;i<walls.length;i++){const w=walls[i];walls[i]=[w[0]+X,w[1],w[2]+X,w[3]]}
  box(m,X,-.12,-3.5,7.2,.12,25.2,hex(0x6b6553),5)
  box(m,X,2.9,-3.5,7.2,.14,25.2,hex(0x656451),4)
  for(const side of [-1,1]){
    const x=X+side*3.6
    box(m,x,0,-3.5,.18,3,25.2,hex(0x676555),4);walls.push([x-.1,-16.2,x+.1,9.1])
    box(m,X+side*2.35,0,9,2.7,3,.18,hex(0x676555),4);walls.push([X+side*2.35-1.35,8.9,X+side*2.35+1.35,9.1])
    for(let pipe=0;pipe<3;pipe++){
      const y=1.95+pipe*.27,px=x-side*.16
      tube(m,[px,y,8.8],[px,y,-16],.045+pipe*.012,brass,12)
      for(let z=7;z>-16;z-=2.5){
        box(m,px,y-.07,z,.15,.14,.055,edge)
        // Wet beads and long drips on the lower pipe surfaces catch the practicals.
        for(let j=0;j<4;j++){const zz=z+j*.19;tube(m,[px-side*.035,y-.025,zz],[px-side*.035,y-.09-(j%3)*.025,zz],.0035,hex(0xb4b6a0),5)}
      }
    }
  }
  box(m,X,0,-16.2,7.2,3,.2,hex(0x565442),4);walls.push([X-3.6,-16.3,X+3.6,-16.1])
  // One destination at the end. The authored office beyond it is deliberately absent.
  box(m,X,0,-16.04,1.15,2.28,.08,hex(0x806247),10,.012)
  for(const side of [-1,1])box(m,X+side*.64,0,-15.99,.09,2.4,.14,brass)
  box(m,X,2.32,-15.99,1.37,.08,.14,brass)
  box(m,X+.42,1,-15.96,.05,.12,.08,brass,.0,.008)
  box(m,X,2.43,-15.84,.44,.06,.15,hex(0xe6b36d),13)
  for(let z=8;z>-16;z-=1.2)box(m,X,2.88,z,7.1,.02,.012,edge)
  for(let x=-3;x<=3;x+=.6)box(m,X+x,2.88,-3.5,.012,.02,25,edge)
  let index=0
  for(const side of [-1,1])for(let row=0;row<7;row++){
    const x=X+side*2.3,z=5.6-row*2.9,w=1.12,h=2.35+(row%3)*.12
    box(m,x,.09,z,w,h,1.15,iron,5,.018);walls.push([x-w/2,z-.58,x+w/2,z+.58])
    box(m,x,0,z,w+.06,.09,1.2,black)
    for(const dx of [-.51,.51])box(m,x+dx,.13,z+.59,.025,h-.08,.035,edge)
    for(let unit=0;unit<12;unit++){
      const y=.19+unit*.18
      box(m,x,y,z+.592,.98,.155,.025,hex(unit%3?0x454839:0x242e28),5,.004)
      for(let slit=0;slit<5;slit++)box(m,x-.08,y+.025+slit*.021,z+.61,.69,.005,.008,black)
      for(let led=0;led<3;led++)box(m,x+.38+led*.04,y+.07,z+.615,.012,.013,.006,hex(led===0?0x89aa55:0xb78132),13)
      box(m,x-.44,y+.055,z+.616,.03,.04,.014,edge)
    }
    // Visible cable looms on the aisle-facing rack side.
    for(let cable=0;cable<5;cable++)for(let j=0;j<12;j++){
      const y0=.25+j*.15,y1=y0+.15,xx=x-side*.578
      tube(m,[xx,y0,z+Math.sin(j*.3+cable)*.15+cable*.035],[xx,y1,z+Math.sin((j+1)*.3+cable)*.15+cable*.035],.008,hex(cable%2?0x555a3c:0x282c23),5)
    }
    // Dense, mismatched CRT walls in the gaps; enough readable messages to reward approaching.
    const cx=X+side*2.05,cz=z+1.42,yaw=-side*Math.PI/4,cos=Math.cos(yaw),sin=Math.sin(yaw)
    walls.push([cx-.52,cz-.52,cx+.52,cz+.52])
    for(let tier=0;tier<(row%2?2:3);tier++){
      const first=m.v.length
      const cy=.06+tier*.62,cw=.69+(tier%2)*.08,ch=.48
      box(m,cx,cy,cz,cw+.1,ch+.08,.53,hex(tier%2?0x8f8a6d:0x6d715c),0,.025)
      box(m,cx,cy+.04,cz+.275,cw,ch,.035,black,0,.025)
      screens.push({x:cx+sin*.299,y:cy+.075,z:cz+cos*.299,width:cw-.065,height:ch-.07,index:index++,yaw})
      box(m,cx+cw*.4,cy+.012,cz+.288,.022,.009,.008,hex(0x749967),13)
      for(let i=first;i<m.v.length;i+=11){
        const dx=m.v[i]-cx,dz=m.v[i+2]-cz,nx=m.v[i+3],nz=m.v[i+5]
        m.v[i]=cx+cos*dx+sin*dz;m.v[i+2]=cz-sin*dx+cos*dz
        m.v[i+3]=cos*nx+sin*nz;m.v[i+5]=-sin*nx+cos*nz
      }
    }
    // Cables converge on the lit door but leave a wide collision-free aisle.
    for(let cable=0;cable<3;cable++){
      const startZ=z+.25,endZ=-15.9,steps=55
      const p=(t:number)=>[X+side*(1.72*(1-t)+.13+cable*.08)+Math.sin(t*8+row)*.18*Math.sin(Math.PI*t),.025+cable*.004,startZ+(endZ-startZ)*t]
      for(let j=0;j<steps;j++)tube(m,p(j/steps),p((j+1)/steps),.012+cable*.003,hex(0x242a22),5)
    }
  }
  for(const z of [6,-1,-8,-15.4]){
    const side=z===-1||z===-15.4?1:-1,x=X+side*3.32
    box(m,x,1.85,z,.13,.32,.2,brass,5,.02)
    box(m,x-side*.08,1.91,z,.08,.18,.12,hex(0xe6b36d),13,.02)
    lamps.push({id:30+lamps.length,x,y:z,h:2.1,r:7,color:[1,.49,.17],power:.85,size:.18,spot:{axis:[-side*.55,-.35,-.15],cosOuter:.05,cosInner:.5}})
  }
  lamps.push({id:39,x:X,y:-15.45,h:2.4,r:8,color:[1,.53,.22],power:1.8,size:.28,spot:{axis:[0,-.6,1],cosOuter:.1,cosInner:.6}})
  lamps.push({id:29,x:X,y:10,h:2.45,r:3.5,color:[1,.49,.16],power:1.5,size:.3,unshadowed:true})
  for(const z of [5,-2,-9]){
    box(m,X,2.78,z,.45,.07,.2,brass)
    box(m,X,2.765,z,.36,.015,.15,hex(0xe6b36d),13)
    lamps.push({id:50+lamps.length,x:X,y:z,h:2.7,r:6,color:[1,.52,.23],power:1.1,size:.24,unshadowed:true})
  }
  for(const z of [4,-3,-10]){
    box(m,X,.002,z,.7,.012,.65,black)
    for(let i=0;i<12;i++)box(m,X-.32+i*.058,.016,z,.012,.006,.62,edge)
    // Very faint green spill from the CRT banks; the warm practicals remain dominant.
    lamps.push({id:40+lamps.length,x:X,y:z,h:1.1,r:3,color:[.24,.63,.32],power:.06,size:.5,unshadowed:true})
  }
  const data=packVerts(m.v)
  return {data,vertices:data.byteLength/24,walls,screens,lamps,box:[X-3.8,-16.4,X+3.8,11] as Rect}
}
