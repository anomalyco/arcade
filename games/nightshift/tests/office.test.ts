import { expect,test } from "bun:test"
import { stepBody } from "@arcade/kit/sim/move"
import { buildWorld, CLOSE, OFFICE, walls } from "../src/world"

test("the player can walk from the phone around the chair and pillar into Jay's office",()=>{
  buildWorld()
  const body={x:CLOSE.x,y:CLOSE.z,vx:0,vy:0}
  for(const [x,z] of [[-.08,-3.65],[3.9,-3.65],[OFFICE.x,OFFICE.z]]) {
    for(let i=0;i<600&&Math.hypot(x-body.x,z-body.y)>.06;i++) {
      const dx=x-body.x,dz=z-body.y,d=Math.hypot(dx,dz)
      stepBody(body,dx/d,dz/d,1.7,walls,1/60,.28,18)
    }
    expect(Math.hypot(x-body.x,z-body.y)).toBeLessThan(.08)
    body.vx=body.vy=0
  }
})

test("long partition faces have only one surface at fabric depth",()=>{
  const {data}=buildWorld(),view=new DataView(data)
  for(const x of [-1.135,1.135]) {
    let hits=0
    for(let b=0;b<data.byteLength;b+=72) {
      const p=[0,24,48].map(o=>[view.getFloat32(b+o,true),view.getFloat32(b+o+4,true),view.getFloat32(b+o+8,true)])
      if(!p.every(v=>Math.abs(v[0]-x)<1e-5))continue
      const cross=(a:number[],b:number[])=> (b[1]-a[1])*(.63-a[2])-(b[2]-a[2])*(.73-a[1])
      const sides=[cross(p[0],p[1]),cross(p[1],p[2]),cross(p[2],p[0])]
      if(sides.every(v=>v>1e-8)||sides.every(v=>v< -1e-8))hits++
    }
    expect(hits).toBe(1)
  }
})
