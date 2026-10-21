import { NodeIO } from "@gltf-transform/core"
import { vec3 } from "wgpu-matrix"
import { test, expect } from "bun:test"
import { cradleOn } from "../src/props"
import { CRADLE, RECEIVER_PAD } from "../src/world"

test("the receiver's two support pads land on the shipped phone mesh",async()=>{
const doc=await new NodeIO().read(`${import.meta.dir}/../public/props/phone.glb`),vertices:number[][]=[]
doc.getRoot().getDefaultScene()!.traverse(node=>{
  if(node.getName()==="Handle")return
  for(const p of node.getMesh()?.listPrimitives()??[]) {
    const positions=p.getAttribute("POSITION")!,indices=p.getIndices()!
    for(let i=0;i<indices.getCount();i++)vertices.push([...vec3.transformMat4(positions.getElement(indices.getScalar(i),[]),node.getWorldMatrix())])
  }
})
const lo=[0,1,2].map(k=>Math.min(...vertices.map(p=>p[k]))),hi=[0,1,2].map(k=>Math.max(...vertices.map(p=>p[k])))
vertices.forEach(p=>p.forEach((_,k)=>p[k]=[.12,.79,-5.4][k]+(p[k]-(k===1?lo[k]:(lo[k]+hi[k])/2))*[.416,.12,.494][k]/(hi[k]-lo[k])))
const packed=new Float32Array(vertices.length*8)
vertices.forEach((p,i)=>packed.set(p,i*8))
const fit=cradleOn([{vertices:packed.buffer}])
expect(fit.position.every(Number.isFinite)).toBe(true)
expect(fit.position[0]).toBe(CRADLE[0])
expect(fit.position[2]).toBe(CRADLE[2])
// Dimensions measured from the source base, not copied from the fitter's output.
expect(fit.supports.front).toBeGreaterThan(.83)
expect(fit.supports.front).toBeLessThan(.86)
expect(fit.supports.back).toBeGreaterThan(.895)
expect(fit.supports.back).toBeLessThan(.91)
for(const [side,support] of [[1,fit.supports.front],[-1,fit.supports.back]]) {
  const padBottom=fit.position[1]-.025*Math.cos(fit.roll)-side*RECEIVER_PAD*Math.sin(fit.roll)
  expect(padBottom-support).toBeGreaterThan(0)
  expect(padBottom-support).toBeLessThan(.001)
}
expect(()=>cradleOn([])).toThrow("Receiver support lies outside")
})
