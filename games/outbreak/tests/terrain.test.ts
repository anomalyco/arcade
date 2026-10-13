import { expect, test } from "bun:test"
import { makeTown, sightRects, solidRects, propShape, frontageEnd } from "../shared/map"
import { clearLine, distToRect } from "@arcade/kit/sim/geom"
import { groundHeight, supportHeight } from "../shared/terrain"
import { buildLevel } from "../src/level"
import { Vision } from "../shared/vision"
import { SceneryMemory } from "../shared/scenery-memory"

test("procedural mesh and masks repeat, while house palette and relief keep topology and door paths", () => {
  const town=makeTown(7),a=buildLevel(town)
  expect(buildLevel(makeTown(7))).toBe(a)
  // Evict the bounded cache so repeatability checks a fresh compilation, not the same object.
  for(const seed of [40,41,42])buildLevel(makeTown(seed))
  const b=buildLevel(makeTown(7))
  expect(b).not.toBe(a)
  expect(a).toEqual(b)
  const variant=makeTown(7,12,.4)
  expect(variant.doors).toEqual(town.doors)
  expect(variant.buildings.map(b=>b.rect)).toEqual(town.buildings.map(b=>b.rect))
  expect(buildLevel(variant).chunks).not.toEqual(a.chunks)
  // Six full mesh/mask generations exceed Bun's default 5s on the shared Linux runner.
}, 20_000)

test("foot support agrees with actual packed terrain and paved triangles, including curb ramps", () => {
  const town=makeTown(7), level=buildLevel(town)
  const triangles:number[][]=[]
  for(const chunk of level.chunks) {
    const f=new Float32Array(chunk.data),h=new Uint16Array(chunk.data)
    for(let offset=0;offset<chunk.data.byteLength;offset+=72) {
      if(h[(offset+20)/2]!==0x4d00) continue // MAT.ground (20), packed f16
      const a=offset/4
      triangles.push([f[a]!,f[a+1]!,f[a+2]!,f[a+6]!,f[a+7]!,f[a+8]!,f[a+12]!,f[a+13]!,f[a+14]!])
    }
  }
  const samples=[[10.2,11.8],[19.25,30.35],[20.3,38.7],[27.7,38.8],[27.7,36],[27.7,29.6],[39.9,22.3],[48.1,31.6],[44.2,44.3],[52.3,70.2]]
  for(let i=0;i<30;i++) samples.push([2.35+i*2.91,7.12+(i*7.13)%80])
  for(const [x,z] of samples) {
    let top=-Infinity
    for(const t of triangles) {
      const [ax,ay,az,bx,by,bz,cx,cy,cz]=t as [number,number,number,number,number,number,number,number,number]
      const det=(bz-cz)*(ax-cx)+(cx-bx)*(az-cz)
      if(Math.abs(det)<1e-10) continue
      const u=((bz-cz)*(x!-cx)+(cx-bx)*(z!-cz))/det,v=((cz-az)*(x!-cx)+(ax-cx)*(z!-cz))/det
      if(u>=-1e-5&&v>=-1e-5&&u+v<=1.00001) top=Math.max(top,u*ay+v*by+(1-u-v)*cy)
    }
    expect(top).toBeCloseTo(supportHeight(town,x!,z!),4)
  }
  expect(groundHeight(town,10.2,11.8)).toBeGreaterThan(.01)
})

test("room scenery discovery does not grant actor visibility through a closed door or behind the player", () => {
  const town=makeTown(7), v=new Vision(), memory=new SceneryMemory()
  v.update(27.7,31,-Math.PI/2,sightRects(town)); memory.update(town,v)
  expect(v.visible(27.7,27)).toBe(false)
  expect(memory.mask[54*192+55]).toBe(0)
  town.doors[1]!.open=true
  v.update(27.7,31,-Math.PI/2,sightRects(town)); memory.update(town,v)
  expect(v.visible(27.7,27)).toBe(true)
  town.doors[1]!.open=false
  v.update(27.7,31,Math.PI/2,sightRects(town)); memory.update(town,v)
  expect(v.visible(27.7,27)).toBe(false)
  expect(memory.mask[54*192+55]).toBe(255)
})

test("furnished houses retain a clear entrance-to-room lane and supported setback paths", () => {
  for(const seed of [1,7,19,31]) {
    const town=makeTown(seed)
    town.doors.forEach(d=>{d.open=true})
    for(const house of town.buildings.filter(b=>b.kind==="house")) {
      const x=house.rect[0]+5.7,z=house.rect[3]
      expect(frontageEnd(house)-z).toBe(2.5)
      for(const side of [-.3,0,.3])expect(clearLine(x+side,z+2,x+side,house.rect[1]+3,solidRects(town))).toBe(true)
      for(let pz=z;pz<frontageEnd(house);pz+=.2)expect(supportHeight(town,x,pz)).toBeCloseTo(.13)
      for(const p of town.props){const shape=propShape(p);if(shape)expect(distToRect(x,z-.4,shape.rect)).toBeGreaterThan(.35)}
    }
  }
})
