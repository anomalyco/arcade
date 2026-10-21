import {expect,test} from "bun:test"
import {Walk, type FoleyEvent} from "../src/walk"
import {synth,durations,type Sound} from "../src/foley"

const input={dx:0,dz:0,yaw:0,dt:1/60,active:true,amount:1,reduced:false,stride:.72,settling:.3}
test("distance contacts agree across frame rates; reduced motion does not silence feet",()=>{
  for(const hz of [30,60,120,144])for(const reduced of [false,true]){
    const walk=new Walk(),events:FoleyEvent[]=[]
    for(let i=0;i<hz*6;i++){walk.update({...input,dt:1/hz,dz:-1.44/hz,reduced});events.push(...walk.events.filter(e=>e.kind==="step"))}
    expect(events.length).toBe(12)
    for(let i=0;i<events.length;i++)expect(events[i].time).toBeCloseTo(.28+i*.5,6)
    if(reduced)expect([walk.vertical,walk.lateral,walk.roll]).toEqual([0,0,0])
  }
})
test("stop, turn, toggle, focus loss and a stalled frame retain bounded camera continuity",()=>{
  const w=new Walk();let old=[0,0,0],maxSpeed=0,maxRollSpeed=0,steps=0
  for(let i=0;i<720;i++){
    const dt=i===200?.05:1/60,moving=i>60&&i<300,active=i<450,reduced=i>=360
    w.update({...input,dt,dz:moving?-1.7*dt:0,yaw:i>180&&i<240?(i-180)*.02:1.2,active,reduced})
    maxSpeed=Math.max(maxSpeed,Math.hypot(w.lateral-old[0],w.vertical-old[1])/dt)
    maxRollSpeed=Math.max(maxRollSpeed,Math.abs(w.roll-old[2])/dt);old=[w.lateral,w.vertical,w.roll]
    steps+=w.events.filter(e=>e.kind==="step").length
    expect(Math.abs(w.vertical)).toBeLessThan(.016);expect(Math.abs(w.roll)).toBeLessThan(.0046)
    if(!moving)expect(w.events.some(e=>e.kind==="step")).toBe(false)
  }
  expect(steps).toBeGreaterThan(5);expect(maxSpeed).toBeLessThan(.20);expect(maxRollSpeed).toBeLessThan(.08)
  expect(Math.hypot(...old)).toBeLessThan(1e-10)
})
test("no footsteps against a wall or on a camera teleport; slow contacts are quieter",()=>{
  const blocked=new Walk();for(let i=0;i<180;i++){blocked.update(input);expect(blocked.events.some(e=>e.kind==="step")).toBe(false)}
  blocked.update({...input,dz:8});expect(blocked.events.some(e=>e.kind==="step")).toBe(false)
  const gain=(speed:number)=>{const w=new Walk();for(let i=0;i<300;i++){w.update({...input,dz:-speed/60});const e=w.events.find(e=>e.kind==="step");if(e)return e.gain}throw Error("No contact")}
  expect(gain(.5)).toBeLessThan(gain(1.7))
})
test("audible contacts land within 35 ms of the camera's footfall dip",()=>{
  const w=new Walk(),frames:{time:number;y:number}[]=[],events:FoleyEvent[]=[]
  for(let i=0;i<600;i++){w.update({...input,dt:1/120,dz:-1.7/120});frames.push({time:w.time,y:w.vertical});events.push(...w.events.filter(e=>e.kind==="step"))}
  for(const e of events.filter(e=>e.time>1&&e.time<4.8)){
    const nearby=frames.filter(f=>Math.abs(f.time-e.time)<.12),trough=nearby.reduce((a,b)=>a.y<b.y?a:b)
    expect(Math.abs(trough.time-e.time)).toBeLessThan(.035)
  }
})
test("holding into a chair makes one impact, then rearms after leaving contact",()=>{
  const w=new Walk(),bumps:FoleyEvent[]=[]
  for(let i=0;i<180;i++){w.update({...input,bump:i<120||i>150});bumps.push(...w.events.filter(e=>e.kind==="bump"))}
  expect(bumps.length).toBe(2)
})
test("synthesized foley is reproducible, finite, unclipped and varies between steps",()=>{
  for(const kind of Object.keys(durations) as Sound[]){const a=synth(kind,1);expect(a).toEqual(synth(kind,1));expect(a.every(Number.isFinite)).toBe(true);expect(a.reduce((p,v)=>Math.max(p,Math.abs(v)),0)).toBeLessThan(.8)}
  expect(synth("step",1)).not.toEqual(synth("step",2))
})
