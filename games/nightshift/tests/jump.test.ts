import {expect,test} from "bun:test"
import {Walk,type FoleyEvent} from "../src/walk"
import {defaults} from "../src/settings"

// Playtest Oct 21 (03:16): "I can't jump. That's my biggest..." Kit: "I'll make you jumpable."
const noop=()=>{}
Object.assign(globalThis,{window:globalThis.window??{addEventListener:noop},document:globalThis.document??{addEventListener:noop,pointerLockElement:null}})
const {WalkCamera}=await import("@arcade/kit/client/walk-camera")
const canvas={addEventListener:noop} as unknown as HTMLCanvasElement

function hop(hz:number,reduced:boolean){
  const settings={...defaults(),reduceMotion:reduced},cam=new WalkCamera(canvas,()=>false,settings,()=>true,{jump:true})
  cam.height=1.65;let peak=0,low=0,events:FoleyEvent[]=[],landedAt=-1,airSteps=0
  const eye=()=>cam.eye[1]-1.65
  expect(cam.jump()).toBe(true);expect(cam.jump()).toBe(false)
  for(let i=0;i<hz*1.5;i++){
    cam.update(1/hz,16/9,[])
    if(cam.air.airborne)airSteps+=cam.walk.events.filter(e=>e.kind==="step").length
    if(landedAt<0&&!cam.air.airborne)landedAt=i/hz
    peak=Math.max(peak,eye());if(landedAt>=0)low=Math.min(low,eye())
    events.push(...cam.walk.events)
  }
  return {peak,low,landedAt,events,airSteps,rest:eye(),cam,settings}
}

test("Space hops 0.3 m, the knees dip on landing and come back, alike across frame rates",()=>{
  for(const hz of [30,60,120,144]){
    const r=hop(hz,false)
    expect(r.peak).toBeGreaterThan(.27);expect(r.peak).toBeLessThan(.31)
    expect(r.landedAt).toBeGreaterThan(.45);expect(r.landedAt).toBeLessThan(.55)
    expect(r.low).toBeLessThan(-.025);expect(r.low).toBeGreaterThan(-.04)
    expect(Math.abs(r.rest)).toBeLessThan(.002)
  }
})

test("the landing is a soft two-foot contact, and no steps sound in the air",()=>{
  const r=hop(60,false),steps=r.events.filter(e=>e.kind==="step")
  expect(r.airSteps).toBe(0)
  expect(steps.length).toBe(2);expect(steps.every(e=>e.gain<=.2)).toBe(true)
  expect(r.events.some(e=>e.kind==="cloth")).toBe(true)
  expect(Math.abs(steps[1]!.time-steps[0]!.time-.028)).toBeLessThan(1e-9)
})

test("Reduce camera motion keeps the hop and its sound but drops the landing dip",()=>{
  const r=hop(60,true)
  expect(r.peak).toBeGreaterThan(.27);expect(r.low).toBeGreaterThan(-1e-6)
  expect(r.events.filter(e=>e.kind==="step").length).toBe(2)
})

test("without the option the camera never jumps (the Lot keeps Space)",()=>{
  const cam=new WalkCamera(canvas,()=>false,defaults(),()=>true)
  expect(cam.jump()).toBe(false)
  const w=new Walk();w.update({dx:0,dz:-.03,yaw:0,dt:1/60,active:true,amount:1,reduced:false,stride:.72,settling:.3,airborne:true})
  expect(w.speed).toBe(0)
})

test("a hop mid-walk neither scuffs in the air nor steps on top of the landing",()=>{
  const w=new Walk(),dt=1/60,v=1.5,events:FoleyEvent[]=[]
  const go=(airborne:boolean,yaw=0)=>{w.update({dx:0,dz:-v*dt,yaw,dt,active:true,amount:1,reduced:false,stride:.72,settling:.3,airborne});events.push(...w.events)}
  for(let i=0;i<30;i++)go(false)
  const takeoff=events.length
  // Half a second in the air, turning hard: no scuff, no steps.
  for(let i=0;i<30;i++)go(true,i*.08)
  expect(events.slice(takeoff).length).toBe(0)
  // The landing frame counts as air, then both feet come down.
  go(true,2.4);w.land(1);events.push(...w.events)
  const landing=events.length,landedAt=w.time
  for(let i=0;i<30;i++)go(false,2.4)
  const after=events.slice(landing)
  expect(after.some(e=>e.kind==="scuff")).toBe(false)
  const next=after.find(e=>e.kind==="step")!
  expect(next.time-landedAt).toBeGreaterThan(.15)
})
