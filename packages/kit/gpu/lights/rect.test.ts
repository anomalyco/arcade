import { expect, test } from "bun:test"
import { rectCone, rectIrradiance, type RectEmitter } from "./rect"
import { SceneLights } from "../scene-frame"

type Vec3 = readonly [number,number,number]
// Independent midpoint quadrature over emitted area, including receiver and emitter cosines.
function reference(center:Vec3,rect:RectEmitter,p:Vec3,n:Vec3) {
  const size=160,c=Math.cos(rect.yaw??0),s=Math.sin(rect.yaw??0)
  let sum=0
  for(let y=0;y<size;y++) for(let x=0;x<size;x++) {
    const u=((x+0.5)/size*2-1)*rect.halfWidth,v=((y+0.5)/size*2-1)*rect.halfLength
    const d=[center[0]+c*u-s*v-p[0],center[1]-p[1],center[2]+s*u+c*v-p[2]]
    const d2=d.reduce((a,b)=>a+b*b,0)
    sum+=Math.max(d[1]!,0)*Math.max(d[0]!*n[0]+d[1]!*n[1]+d[2]!*n[2],0)/(d2*d2)
  }
  return sum/(size*size)
}

test("panel diffuse agrees with area integration on floor, wall and horizon-clipped surfaces",()=>{
  const center:Vec3=[0,3,0],rect={halfWidth:0.3,halfLength:0.6,yaw:0.4}
  const cases:[Vec3,Vec3][]=[[[0,0,0],[0,1,0]],[[2,1,-1],[-1,0,0]],[[0,2.5,0],[1,0,0]],[[0.15,2.8,0.2],[0,1,0]],[[0,4,0],[0,-1,0]]]
  for(const [p,n] of cases) {
    const exact=rectIrradiance(center,rect,p,n),numeric=reference(center,rect,p,n)
    expect(Number.isFinite(exact)).toBe(true)
    expect(Math.abs(exact-numeric)).toBeLessThan(Math.max(0.00001,numeric*0.001))
  }
  expect(rectIrradiance(center,rect,[0,0,0],[0,-1,0])).toBe(0)
  expect(rectIrradiance(center,rect,[0,-97,0],[0,1,0])*10000).toBeCloseTo(1,3)
})

test("panel dimensions occupy a distinct packed cone tag and retain stable shadow identity",()=>{
  const lights=new SceneLights()
  lights.update([{id:12,x:0,y:15.6,h:3,r:7,color:[1,0.86,0.55],power:3,rect:{halfWidth:0.3,halfLength:0.6}}],[])
  expect(lights.indexOf(12)).toBe(0)
  expect(Array.from(lights.lights.subarray(8,12))).toEqual([Math.fround(0.3),Math.fround(0.6),0,-3])
  for(const x of [0,-1,NaN,Infinity]) expect(()=>rectCone({halfWidth:x,halfLength:0.6})).toThrow()
})
