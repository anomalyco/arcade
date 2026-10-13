import { test, expect } from "bun:test"
import { SmokeVolumes, GRID } from "../../../packages/kit/fx/volume"
import { Emitter, Particles, PARTICLE_CAPACITY, type ParticleSpec } from "../../../packages/kit/fx/particles"

function at(v:SmokeVolumes,x:number,z:number){return v.density[Math.floor((z-v.bounds[1])*2)*GRID+Math.floor((x-v.bounds[0])*2)]}
test("smoke cannot cross a thin sealed wall; an open door admits a delayed wave",()=>{
  const sealed=new SmokeVolumes();sealed.reset([[0.1,-12,0.15,12]]);sealed.spawn(-2,0,7,10)
  const door=new SmokeVolumes();door.reset([[0.1,-12,0.15,1],[0.1,3,0.15,12]]);door.spawn(-2,0,7,10)
  for(let i=0;i<50;i++){sealed.update(0.1);door.update(0.1)}
  expect(at(sealed,-1,0)).toBeGreaterThan(0);expect(at(sealed,1,0)).toBe(0)
  expect(at(door,1,0)).toBeGreaterThan(0);expect(at(door,0.25,0)).toBe(0)
})
test("bullet carve refills, then every cloud expires and releases its budget",()=>{
  const v=new SmokeVolumes();for(let i=0;i<4;i++)expect(v.spawn(i*0.1,0)).toBe(true)
  expect(v.spawn(1,1)).toBe(false)
  for(let i=0;i<30;i++)v.update(0.1)
  expect(at(v,0,0)).toBeGreaterThan(0)
  v.carve(-3,0.25,3,0.25,0.8);v.update(0)
  expect(at(v,0,0)).toBe(0)
  for(let i=0;i<10;i++)v.update(0.1)
  expect(at(v,0,0)).toBeGreaterThan(0)
  for(let i=0;i<100;i++)v.update(0.1)
  expect(v.count).toBe(0);expect(v.density.some(x=>x!==0)).toBe(false);expect(v.spawn(0,0)).toBe(true)
})
test("distance emission is frame-rate independent and rejects teleport trails",()=>{
  const run=(steps:number)=>{const e=new Emitter(),points:number[]=[];const emit=(x:number)=>points.push(x);e.step(0,0,0,0,4,"distance",emit);for(let i=1;i<=steps;i++)e.step(i/steps*5,0,0,1/steps,4,"distance",emit);e.step(100,0,0,1/60,4,"distance",emit);return points}
  const a=run(30),b=run(120);expect(a.length).toBe(20);expect(b.length).toBe(20);for(let i=0;i<a.length;i++)expect(a[i]).toBeCloseTo(b[i],5)
})
test("sparks bounce, chunky debris uses fixed storage, and over-budget births drop",()=>{
  const p=new Particles(),spec:ParticleSpec={kind:"spark",life:2,size:0.1,growth:0,gravity:10,drag:0,bounce:0.5,r:1,g:1,b:1,alpha:1}
  p.spawn(spec,0,0.05,0,0,-5,0);p.update(0.05);expect(p.data[5]).toBeGreaterThan(0)
  for(let i=1;i<PARTICLE_CAPACITY;i++)p.spawn(spec,0,1,0)
  const data=p.data;expect(p.spawn(spec,0,1,0)).toBe(false);expect(p.count).toBe(PARTICLE_CAPACITY)
  for(let i=0;i<60;i++)p.update(0.05)
  expect(p.count).toBe(0);expect(p.data).toBe(data)
})
