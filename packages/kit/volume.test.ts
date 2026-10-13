import { expect, test } from "bun:test"
import { GRID, SmokeVolumes, type Wall } from "./fx/volume"
import { smokeDefaults, smokeRanges, smokeSettings, type SmokeKey } from "./fx/volume-settings"

function cloud(walls: readonly Wall[] = []) {
  const v=new SmokeVolumes();v.reset(walls);expect(v.spawn(0,0,6,12)).toBe(true);return v
}
function cell(v:SmokeVolumes,x:number,z:number){return Math.floor((z-v.bounds[1])*2)*GRID+Math.floor((x-v.bounds[0])*2)}
// Reconstruction sampled by the GPU, including the separate geometry guard.
function sample(v:SmokeVolumes,x:number,z:number){
  if(v.solid[cell(v,x,z)])return 0
  const gx=(x-v.bounds[0])*2-0.5,gz=(z-v.bounds[1])*2-0.5,ix=Math.floor(gx),iz=Math.floor(gz),fx=gx-ix,fz=gz-iz
  const nearest=cell(v,x,z),cx=nearest%GRID,cz=Math.floor(nearest/GRID)
  const tap=(tx:number,tz:number)=>{
    if(tx!==cx&&tz!==cz&&(v.solid[cz*GRID+tx]||v.solid[tz*GRID+cx]))return 0
    return v.density[tz*GRID+tx]
  }
  const a=tap(ix,iz)*(1-fx)+tap(ix+1,iz)*fx
  const b=tap(ix,iz+1)*(1-fx)+tap(ix+1,iz+1)*fx
  return a*(1-fz)+b*fz
}
function radius(v:SmokeVolumes,angle:number,threshold=0.2){
  let lo=0,hi=9
  for(let i=0;i<22;i++){const r=(lo+hi)/2;if(sample(v,Math.cos(angle)*r,Math.sin(angle)*r)>threshold)lo=r;else hi=r}
  return (lo+hi)/2
}

test("unoccluded filtered front advances continuously, monotonically, without cell-sized jumps",()=>{
  const v=cloud();let previous=0,maxJump=0
  // Ignore opacity ramp while the chosen contour first appears. 0.12m is <1/4 of a cell,
  // but >2x expected 60Hz travel; a whole-cell activation cannot pass.
  for(let f=1;f<=114;f++){
    v.update(1/60)
    const r=radius(v,0.31)
    if(f>24){expect(r+1e-5).toBeGreaterThanOrEqual(previous);maxJump=Math.max(maxJump,r-previous)}
    previous=r
  }
  expect(maxJump).toBeLessThan(0.12)
  expect(maxJump).toBeGreaterThan(0.015)
})
test("axis, diagonal and intermediate mature radii agree within 5%",()=>{
  const v=cloud();v.update(2)
  const radii=Array.from({length:64},(_,i)=>radius(v,i*Math.PI/32))
  // Allows 2.75% chamfer error plus interpolation error; rejects 8-way (8.2%) and Manhattan (29%).
  expect(Math.min(...radii)/Math.max(...radii)).toBeGreaterThan(0.95)
  expect(Math.min(...radii)).toBeGreaterThan(4.8)
})
test("thin full wall blocks both filtered and cell density",()=>{
  const v=cloud([[1.1,-20,1.12,20]]);v.update(3)
  for(let z=-5;z<=5;z+=0.2)for(let x=1.1;x<6;x+=0.2)expect(sample(v,x,z)).toBe(0)
})
test("touching diagonal corners do not connect sealed regions",()=>{
  const v=cloud([[0.26,-20,0.74,0.24],[-20,0.26,0.24,0.74]])
  v.update(3)
  for(let z=0.26;z<=4;z+=0.2)for(let x=0.26;x<=4;x+=0.2)expect(sample(v,x,z)).toBe(0)
})
test("door admits a connected front after travelling around its jamb",()=>{
  const v=cloud([[1.1,-20,1.12,1],[1.1,2.6,1.12,20]])
  v.update(0.4);expect(sample(v,2,1.8)).toBe(0)
  v.update(2.6);expect(sample(v,2,1.8)).toBeGreaterThan(0.2)
  expect(sample(v,1.11,0)).toBe(0)
})
test("carve opens, refills, and never changes the solid mask",()=>{
  const v=cloud([[1.1,-20,1.12,20]]);v.update(3)
  const before=sample(v,0,0),solid=v.solid.slice()
  v.carve(-3,0,3,0,0.7);v.update(0)
  expect(sample(v,0,0)).toBe(0)
  let previous=0
  for(let i=0;i<45;i++){v.update(1/60);const d=sample(v,0,0);expect(d).toBeGreaterThanOrEqual(previous);previous=d}
  expect(previous).toBeCloseTo(before,5);expect(v.solid).toEqual(solid);expect(sample(v,2,0)).toBe(0)
})
test("reset replay is deterministic including noise seed, occupancy and upload bytes",()=>{
  const v=cloud([[1,-2,1.1,1]])
  for(let i=0;i<80;i++)v.update(1/60)
  const field=v.field.slice(),density=v.density.slice(),motion=v.advection.slice()
  v.reset();v.spawn(0,0,6,12);for(let i=0;i<80;i++)v.update(1/60)
  expect(v.field).toEqual(field);expect(v.density).toEqual(density);expect(v.advection).toEqual(motion)
})
test("different frame/substep schedules agree at the same elapsed time",()=>{
  const a=cloud(),b=cloud(),c=cloud()
  for(let i=0;i<80;i++)a.update(1/60)
  for(let i=0;i<40;i++)b.update(1/30)
  c.update(80/60)
  for(let i=0;i<a.density.length;i++){expect(Math.abs(a.density[i]-b.density[i])).toBeLessThan(1e-6);expect(Math.abs(a.density[i]-c.density[i])).toBeLessThan(1e-6)}
  for(let i=0;i<3;i++)expect(Math.abs(a.advection[i]-c.advection[i])).toBeLessThan(0.0001)
})
test("fade is monotonic to exact zero with no visible eviction",()=>{
  const v=cloud();v.update(9)
  let previous=sample(v,0,0)
  for(let i=0;i<181;i++){v.update(1/60);const d=sample(v,0,0);expect(d).toBeLessThanOrEqual(previous);previous=d}
  expect(previous).toBe(0);expect(v.count).toBe(0);expect(v.field.every(x=>x===0)).toBe(true)
})
test("finite bounded settings, half-float onset and fixed storage",()=>{
  expect(smokeSettings({height:NaN,extinction:Infinity,radius:-1})).toEqual({...smokeDefaults,radius:2})
  for(const key of Object.keys(smokeDefaults) as SmokeKey[]){
    const [min,max]=smokeRanges[key]
    for(const value of [min,max]){
      const v=new SmokeVolumes({[key]:value});v.spawn(0,0);v.update(1/600)
      expect(v.density.every(Number.isFinite)).toBe(true)
    }
  }
  const v=cloud(),field=v.field,density=v.density
  v.update(1/120);expect(v.density[cell(v,0,0)]).toBeGreaterThan(0);expect(v.density[cell(v,0,0)]).toBeLessThan(1/255)
  expect(v.field[cell(v,0,0)*2]).toBeGreaterThan(0)
  for(let i=0;i<600;i++)v.update(1/60)
  expect(v.field).toBe(field);expect(v.density).toBe(density)
})
