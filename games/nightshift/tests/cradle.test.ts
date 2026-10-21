import { NodeIO } from "@gltf-transform/core"
import { EXTTextureWebP } from "@gltf-transform/extensions"
import { vec3 } from "wgpu-matrix"
import { test, expect } from "bun:test"
import { cradleOn, phoneSurface, PROP_DEFINITIONS } from "../src/props"
import { CRADLE, RECEIVER_PAD, PHONE_INDICATOR } from "../src/world"

test("the receiver's two support pads land on the shipped phone mesh",async()=>{
const definition=PROP_DEFINITIONS.find(p=>p.kind==="phone")!
const doc=await new NodeIO().registerExtensions([EXTTextureWebP]).read(`${import.meta.dir}/../public/props/${definition.file}.glb`),vertices:number[][]=[]
doc.getRoot().getDefaultScene()!.traverse(node=>{
  if(node.getName()==="Handle")return
  for(const p of node.getMesh()?.listPrimitives()??[]) {
    const positions=p.getAttribute("POSITION")!,indices=p.getIndices()!
    for(let i=0;i<indices.getCount();i++)vertices.push([...vec3.transformMat4(positions.getElement(indices.getScalar(i),[]),node.getWorldMatrix())])
  }
})
const lo=[0,1,2].map(k=>vertices.reduce((v,p)=>Math.min(v,p[k]),Infinity)),hi=[0,1,2].map(k=>vertices.reduce((v,p)=>Math.max(v,p[k]),-Infinity))
vertices.forEach(p=>{
  p.forEach((_,k)=>p[k]=(p[k]-(k===1?lo[k]:(lo[k]+hi[k])/2))*definition.size[k]/(hi[k]-lo[k]))
  const [x,y,z]=p,c=Math.cos(definition.yaw),s=Math.sin(definition.yaw)
  p[0]=definition.at[0]+c*x+s*z;p[1]=definition.at[1]+y;p[2]=definition.at[2]-s*x+c*z
})
const packed=new Float32Array(vertices.length*8)
vertices.forEach((p,i)=>packed.set(p,i*8))
const fit=cradleOn([{vertices:packed.buffer}])
expect(fit.position.every(Number.isFinite)).toBe(true)
expect(fit.position[0]).toBe(CRADLE[0])
expect(fit.position[2]).toBe(CRADLE[2])
// Dimensions measured from the source base, not copied from the fitter's output.
expect(fit.supports.front).toBeGreaterThan(definition.at[1])
expect(fit.supports.front).toBeLessThan(definition.at[1]+definition.size[1])
expect(fit.supports.back).toBeGreaterThan(definition.at[1])
expect(fit.supports.back).toBeLessThan(definition.at[1]+definition.size[1])
for(const [side,support] of [[1,fit.supports.front],[-1,fit.supports.back]]) {
  const padBottom=fit.position[1]-.025*Math.cos(fit.roll)-side*RECEIVER_PAD*Math.sin(fit.roll)
  expect(padBottom-support).toBeGreaterThan(0)
  expect(padBottom-support).toBeLessThan(.001)
}
const led=phoneSurface([{vertices:packed.buffer}],PHONE_INDICATOR[0],PHONE_INDICATOR[1])
expect(led).toBeGreaterThan(definition.at[1])
expect(led).toBeLessThan(definition.at[1]+definition.size[1])
expect(()=>cradleOn([])).toThrow("Phone contact lies outside")
})
