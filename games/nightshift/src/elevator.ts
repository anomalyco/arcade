import { Mesh, MAT, hex } from "@arcade/kit/gpu/mesh"
import type { Rect } from "@arcade/kit/sim/geom"
import { smooth } from "./opening"

const metal=hex(0x77725f),bronze=hex(0x857052)
function block(m:Mesh,x:number,y:number,z:number,w:number,h:number,d:number,color=metal,aux=5){
  m.box(x-w/2,y,z-d/2,x+w/2,y+h,z+d/2,color,MAT.lit,aux,undefined,true)
}
export function buildElevator(m:Mesh,walls:Rect[]){
  for(const x of [-1.1,1.1]){block(m,x,0,9,.22,2.65,.34);block(m,x,0,9.9,.12,2.55,1.8,bronze);walls.push([x-.12,8.8,x+.12,10.85])}
  block(m,0,2.4,9,2.42,.3,.34);block(m,0,0,10.85,2.3,2.6,.12,bronze)
  walls.push([-1.22,10.78,1.22,10.95])
  block(m,0,-.015,9.85,2.2,.035,2.0,hex(0x78644a),10)
  block(m,0,2.55,9.85,2.2,.08,2.0,bronze)
  block(m,0,2.5,10,.65,.025,.38,hex(0xe6b36d),13)
  block(m,0,1.0,10.74,1.95,.045,.06)
  for(const x of [-1.01,1.01])block(m,x,1,10,.045,.045,1.4)
  block(m,0,.008,8.96,1.98,.012,.25)
  for(const z of [8.88,8.94,9])block(m,0,.021,z,1.98,.003,.009,hex(0x272c28))
  block(m,0,2.46,8.817,.42,.18,.015,hex(0x232a27))
  block(m,0,2.515,8.801,.018,.095,.006,hex(0xf5ae42),13)
  for(const side of [-1,1])for(let i=0;i<6;i++)block(m,side*(.005+i*.008),2.51+i*.008,8.799,.013,.013,.008,hex(0xf5ae42),13)
  block(m,1.4,1.0,8.82,.13,.29,.025)
  block(m,1.4,1.115,8.8,.042,.042,.008,hex(0xf5ae42),13)
}
export function elevatorLeaf(){const m=new Mesh();block(m,0,.025,0,.975,2.37,.065,bronze);return m}
export class Elevator {
  elapsed=0;closing=false
  step(dt:number,ended:boolean,x:number,z:number){
    if(ended&&Math.abs(x)<.7&&z>9.5)this.closing=true
    if(this.closing)this.elapsed+=Math.max(0,Math.min(dt,.05))
  }
  get closure(){return smooth((this.elapsed-.25)/2.2)}
  get fade(){return smooth((this.elapsed-2.6)/1.4)}
  get done(){return this.elapsed>=4}
  get leafX(){return 1.5-1.01*this.closure}
}
