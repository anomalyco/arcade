import { expect, test } from "bun:test"
import { mat4 } from "wgpu-matrix"
import { Continuity } from "../src/polish/continuity"
import { OfficePhysics } from "../src/polish/props"
import { polishDefaults } from "../src/polish/settings"
import { DustField } from "../src/polish/dust"
import { tubeSignal } from "../src/polish/tube"
import { lampFlicker } from "@arcade/kit/gpu/lights/flicker"

const view=(away:boolean)=>mat4.multiply(mat4.perspective(68*Math.PI/180,16/9,.045,45),mat4.lookAt([0,1.65,15],[0,1.65,away?20:0],[0,1,0]))
test("continuity never changes a visible or recently seen swept bound; replay is seeded",()=>{
  const s=polishDefaults(),a=new Continuity(),b=new Continuity(),events=[]
  for(let i=0;i<600*60;i++){
    const t=i/60,vp=view(t%90<60)
    a.step(t,vp,t>150,s);b.step(t,vp,t>150,s)
    if(a.events.length>events.length){const e=a.events.at(-1)!;expect(e.visible).toBe(false);expect(e.time-e.lastSeen).toBeGreaterThanOrEqual(s.unseenDelay);events.push(e)}
  }
  expect(a.events).toEqual(b.events);expect(a.events.length).toBeGreaterThan(3)
  const held=new Continuity();for(let i=0;i<600;i++)held.step(i,view(false),true,s)
  expect(held.events).toHaveLength(0)
})
test("caster impulses roll and spin, collide, then sleep with no resting jitter",()=>{
  const s=polishDefaults(),p=new OfficePhysics([[-.28,-.28,.28,.28]]),c=p.chairs[0]
  const wall:[number,number,number,number]=[-2,-.9,2,-.7]
  for(let i=0;i<60;i++)p.step(1/60,{x:-.3,y:.6,vx:0,vy:-1.7},[c.collider,wall],s)
  expect(Math.hypot(c.x,c.z)).toBeGreaterThan(.01);expect(Math.abs(c.yaw)).toBeGreaterThan(.01)
  expect(c.z).toBeGreaterThan(-.4)
  for(let i=0;i<1800;i++)p.step(1/60,{x:3,y:3,vx:0,vy:0},[c.collider,wall],s)
  const rest=[c.x,c.z,c.yaw,p.paper]
  for(let i=0;i<60;i++)p.step(1/60,{x:3,y:3,vx:0,vy:0},[c.collider,wall],s)
  expect([c.x,c.z,c.yaw,p.paper]).toEqual(rest);expect([c.vx,c.vz,c.spin]).toEqual([0,0,0])
})
test("cord keeps momentum on retarget then sleeps; dust wake is deterministic",()=>{
  const s=polishDefaults(),p=new OfficePhysics([])
  p.cord(1/60,[0,0,0],s);p.cord(1/60,[.04,.02,0],s)
  expect(Math.abs(p.swing[0])).toBeGreaterThan(0)
  for(let i=0;i<1800;i++)p.cord(1/60,[.04,.02,0],s)
  expect(p.swing).toEqual([0,0,0])
  const a=new DustField(),b=new DustField(),still=new DustField()
  for(let i=0;i<120;i++){a.step(1/60,i/60,0,3-i/60,.45);b.step(1/60,i/60,0,3-i/60,.45);still.step(1/60,i/60,0,3-i/60,0)}
  expect(a.data).toEqual(b.data);expect(a.data).not.toEqual(still.data)
})
test("paper follows actual travel and settles even when requested movement stays blocked",()=>{
  const s=polishDefaults(),p=new OfficePhysics([]),body={x:-1,y:-5.1,vx:0,vy:1.7}
  for(let i=0;i<60;i++){p.step(1/60,body,[],s);p.flutter(1/60,body.x,body.y,0,s)}
  expect(p.paper).toBe(0)
  for(let i=0;i<60;i++)p.flutter(1/60,body.x,body.y,1.7,s)
  expect(p.paper).toBeGreaterThan(.01)
  for(let i=0;i<1800;i++){p.step(1/60,body,[],s);p.flutter(1/60,body.x,body.y,0,s)}
  expect([p.paper,p.paperVelocity]).toEqual([0,0])
})
test("tube reuses the exact stateless kit signal and starter stays quiet when steady",()=>{
  let edges=0
  for(let i=0;i<60*240;i++){const t=i/240,s=tubeSignal(t,1);expect(s.level).toBe(lampFlicker("fluorescent",87,t,1).level);if(s.crackle>0)edges++}
  expect(edges).toBeGreaterThan(0);expect(tubeSignal(4,0)).toEqual({level:1,crackle:0})
})
