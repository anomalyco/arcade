import { expect,test } from "bun:test"
import { SplatterSurfaces,newSurfaceHit } from "./fx/splatter-surfaces"
import { Splatter,splatterPresets,DECAL_STRIDE,SPLATTER_DECALS } from "./fx/splatter"

const floor=[-8,0,-8,-8,0,8,8,0,-8,0, 8,0,-8,-8,0,8,8,0,8,0]
const wall=[-8,0,0,8,0,0,-8,4,0,0, 8,0,0,8,4,0,-8,4,0,0]
const shot={id:1,seed:17,x:0,y:1,z:1,dx:.3,dy:0,dz:-1}
const tick=(s:Splatter,seconds:number,hz=60)=>{for(let i=0;i<seconds*hz;i++)s.update(1/hz)}

test("swept hits stop at a thin wall, retain its normal, and exclude perpendicular receivers",()=>{
  const surfaces=new SplatterSurfaces([...floor,...wall]),hit=newSurfaceHit()
  expect(surfaces.sweep(0,1,2,0,0,-20,hit)).toBe(true)
  expect(hit.z).toBeCloseTo(0);expect(hit.ny).toBe(0);expect(hit.nz).toBe(1)
  const receivers=new Int32Array(12),n=surfaces.receivers(hit,1,receivers,0,12)
  expect(n).toBe(2);expect([...receivers.slice(0,n)].every(id=>id>=2)).toBe(true)
})
test("seeded splatter agrees across tick partitions, keeps wall planes and inherits detached velocity",()=>{
  const surfaces=new SplatterSurfaces([...floor,...wall]),a=new Splatter(surfaces),b=new Splatter(surfaces)
  const event={...shot,limbId:4,vx:2,vy:1,vz:-1}
  a.emit(event,splatterPresets.blood);b.emit(event,splatterPresets.blood)
  expect(a.emit(event,splatterPresets.blood)).toBe(false)
  expect(a.emit({...event,limbId:5}, {...splatterPresets.blood,amount:0})).toBe(true)
  tick(a,1,30);tick(b,1,120)
  expect(a.particles).toEqual(b.particles);expect(a.decals).toEqual(b.decals)
  expect(a.inspect().walls).toBeGreaterThan(0)
  for(let i=0;i<SPLATTER_DECALS;i++){const k=i*DECAL_STRIDE;if(a.decals[k+7]>0&&a.decals[k+9]===0){expect(a.decals[k+2]).toBeCloseTo(0);expect(a.decals[k+10]).toBe(1)}}
})
test("an exact furniture top catches drops before the floor; glass blocks without receiving stains",()=>{
  const top=(material:number)=>[-1,.75,-1,-1,.75,1,1,.75,-1,material, 1,.75,-1,-1,.75,1,1,.75,1,material]
  for(const material of [0,3]){
    const s=new Splatter(new SplatterSurfaces([...floor,...top(material)]))
    s.emit({...shot,z:0,y:1.5,dx:0,dy:-1,dz:0},{...splatterPresets.blood,spread:0});tick(s,1)
    expect(s.inspect().decals).toBe(material===3?0:32)
    for(let i=0;i<SPLATTER_DECALS;i++)if(s.decals[i*DECAL_STRIDE+7]>0)expect(s.decals[i*DECAL_STRIDE+1]).toBeCloseTo(.75)
  }
})
test("back-face receivers retain coplanar neighbors and material response changes spread and persistence",()=>{
  const surfaces=new SplatterSurfaces(wall),hit=newSurfaceHit(),ids=new Int32Array(12)
  surfaces.sweep(0,1,-1,0,0,2,hit)
  expect(hit.nz).toBe(-1);expect(surfaces.receivers(hit,1,ids,0,12)).toBe(2)
  const stained=(material:number)=>{
    const source=[...floor];source[9]=source[19]=material
    const s=new Splatter(new SplatterSurfaces(source))
    s.emit({...shot,z:0,dx:0,dy:-1,dz:0},{...splatterPresets.blood,amount:1,spread:0});tick(s,.5)
    return s
  }
  const sealed=stained(0),absorbent=stained(1)
  expect(absorbent.decals[3]).toBeLessThan(sealed.decals[3]);expect(absorbent.decals[18]).toBeLessThan(sealed.decals[18])
  sealed.emit({...shot,id:2},{...splatterPresets.blood,amount:256,budget:256})
  sealed.emit({...shot,id:3},{...splatterPresets.blood,amount:16,budget:16})
  expect(sealed.inspect().particles).toBe(16)
})
test("grazing incidence elongates along surface velocity; pooled deposits fade and storage stays fixed",()=>{
  const surfaces=new SplatterSurfaces(wall),normal=new Splatter(surfaces),grazing=new Splatter(surfaces)
  const settings={...splatterPresets.blood,amount:1,spread:0,gravity:0,drag:0,persistence:1,budget:16}
  normal.emit({...shot,dx:0},settings);grazing.emit({...shot,z:.1,dx:1,dz:-.2},settings);tick(normal,1/2);tick(grazing,1/2)
  const ratio=(s:Splatter)=>s.decals[3]/s.decals[11]
  expect(ratio(grazing)).toBeGreaterThan(ratio(normal)*2)
  const particles=grazing.particles,decals=grazing.decals
  for(let i=0;i<300;i++){grazing.emit({...shot,id:i+10,z:.1},settings);tick(grazing,.1)}
  expect(grazing.inspect().particles).toBeLessThanOrEqual(16);expect(grazing.inspect().decals).toBeLessThanOrEqual(16)
  tick(grazing,5);expect(grazing.inspect().particles).toBe(0);expect(grazing.inspect().decals).toBe(0)
  expect(grazing.particles).toBe(particles);expect(grazing.decals).toBe(decals)
})
