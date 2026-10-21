import { expect, test } from "bun:test"
import { stepBody } from "@arcade/kit/sim/move"
import type { Rect } from "@arcade/kit/sim/geom"
import { splitStorefront } from "../src/interior/storefront"
import type { InteriorScene } from "../src/interior/types"

const path = `${import.meta.dir}/../public/`
const scene: InteriorScene = await Bun.file(path + "interior/scene.json").json()
const exterior = await Bun.file(path + "ashwood/scene.json").json()

test("native interior assets are complete, finite and triangle-aligned", async () => {
  expect(scene.records.length).toBeGreaterThan(30)
  for (const r of scene.records) {
    const bytes = Bun.gunzipSync(await Bun.file(path + "interior/" + r.file).bytes())
    expect(bytes.byteLength).toBe(r.triangles * 96)
    const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    for (let i=0;i<bytes.byteLength;i+=32) for(const k of [0,4,8,24,28]) {
      if(!Number.isFinite(data.getFloat32(i+k,true))) throw Error(`Non-finite ${r.file}:${i+k}`)
    }
  }
})

test("entrance backing becomes glass without changing exterior triangle count", async () => {
  let glass = 0
  for(const file of exterior.files.solid) {
    const bytes = Bun.gunzipSync(await Bun.file(path + "ashwood/" + file).bytes())
    const original = bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)
    const split = splitStorefront(original)
    expect(split.solid.byteLength/24+split.glass.byteLength/32).toBe(bytes.byteLength/24)
    glass+=split.glass.byteLength/96
  }
  expect(glass).toBeGreaterThan(0)
})

test("production collision solver walks the threshold, lobby link and corridor continuously", () => {
  const walls: Rect[] = [...exterior.colliders,...scene.colliders]
    .filter(b=>b.max[1]>0.5&&b.min[1]<1.5&&b.max[2]>=-3.2)
    .map(b=>[b.min[0],b.min[2],b.max[0],b.max[2]])
  walls.push([-55,-22,35,-3.2])
  const body={x:0,y:30,vx:0,vy:0}
  for(const [x,z] of [[0,19],[0,10],[0,5],[0,0.2],[-11,0.2],[-25,0.2]]) {
    for(let step=0;step<2400&&Math.hypot(x!-body.x,z!-body.y)>0.08;step++) {
      const dx=x!-body.x,dz=z!-body.y,d=Math.hypot(dx,dz)
      stepBody(body,dx/d,dz/d,2.1,walls,1/60,0.28,18)
    }
    expect(Math.hypot(x!-body.x,z!-body.y)).toBeLessThan(0.1)
  }
})
