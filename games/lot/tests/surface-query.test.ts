import { expect,test } from "bun:test"
import { SurfaceQuery } from "../src/surface-query"
import { Mesh,MAT } from "@arcade/kit/gpu/mesh"
import { packTexturedVerts } from "@arcade/kit/gpu/textured-mesh"

test("feet select the top floor under the ceiling, never a wall or an overlapping substrate",()=>{
  const plane=(name:string,y:number)=>{const m=new Mesh();m.box(-2,y-.1,-2,2,y,2,[1,1,1],MAT.lit);return {name,vertices:[packTexturedVerts(m.v,new Float32Array(m.v.length/11*2))]}}
  const q=new SurfaceQuery([plane("dirt",-.1),plane("concrete",.2),plane("roof",3)])
  expect(q.at(0,0).name).toBe("concrete")
  expect(q.at(0,0,.1).name).toBe("dirt")
  expect(q.at(3,0).name).toBe("unknown")
  expect(q.region(0,.2,0)).toBe("concrete")
})
