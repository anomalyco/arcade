import { expect,test } from "bun:test"
import { synthFoley,type FootSurface } from "./footsteps"
test("each foot surface is seeded, distinct, finite and leaves peak headroom",()=>{
  const surfaces:FootSurface[]=["carpet","asphalt","wet-asphalt","puddle","gravel","dirt","grass","concrete","wood","tile"]
  const signatures=new Set<string>()
  for(const surface of surfaces){
    const a=synthFoley("step",3,24000,surface)
    expect(a).toEqual(synthFoley("step",3,24000,surface))
    expect(a.every(Number.isFinite)).toBe(true)
    expect(a.reduce((p,v)=>Math.max(p,Math.abs(v)),0)).toBeLessThan(.8)
    expect(Math.abs(a.at(-1)!)).toBeLessThan(.001)
    signatures.add(Bun.hash(a).toString())
  }
  expect(signatures.size).toBe(surfaces.length)
})
test("all contact variants stay within the quiet bank's 100ms RMS budget",()=>{
  const surfaces:FootSurface[]=["carpet","asphalt","wet-asphalt","puddle","gravel","dirt","grass","concrete","wood","tile"]
  for(const surface of surfaces)for(let seed=0;seed<32;seed++){
    const pcm=synthFoley("step",seed,24000,surface)
    let sum=0,peak=0
    for(let i=0;i<pcm.length;i++){sum+=pcm[i]!**2;if(i>=2400)sum-=pcm[i-2400]!**2;if(i>=2399)peak=Math.max(peak,sum/2400)}
    // At .20 contact × .8 footsteps × .55 master this is <= -56 dBFS.
    expect(Math.sqrt(peak)).toBeLessThan(.018)
  }
})
