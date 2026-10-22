import {expect,test} from "bun:test"
import {buildWorld,stackContacts} from "../src/world"

test("every storage stack contacts real supporting triangles without penetration",()=>{
  const {data}=buildWorld(),view=new DataView(data)
  const point=(i:number)=>[0,4,8].map(o=>view.getFloat32(i*24+o,true))
  expect(stackContacts.length).toBe(12)
  for(const {id,support,prop} of stackContacts){
    const vertices=Array.from({length:prop.count},(_,i)=>point(prop.first+i)),bottom=Math.min(...vertices.map(p=>p[1]))
    const surface=(x:number,z:number)=>{
      let highest=-Infinity
      for(let i=support.first;i<support.first+support.count;i+=3){
        const [a,b,c]=[point(i),point(i+1),point(i+2)],den=(b[2]-c[2])*(a[0]-c[0])+(c[0]-b[0])*(a[2]-c[2])
        if(Math.abs(den)<1e-10)continue
        const u=((b[2]-c[2])*(x-c[0])+(c[0]-b[0])*(z-c[2]))/den,v=((c[2]-a[2])*(x-c[0])+(a[0]-c[0])*(z-c[2]))/den
        if(u>=-1e-6&&v>=-1e-6&&u+v<=1+1e-6)highest=Math.max(highest,u*a[1]+v*b[1]+(1-u-v)*c[1])
      }
      return highest
    }
    let contacts=0
    for(const p of vertices.filter(p=>Math.abs(p[1]-bottom)<1e-6)){
      const gap=p[1]-surface(p[0],p[2])
      expect(gap,`${id} penetrates support`).toBeGreaterThan(-2e-6)
      if(Math.abs(gap)<2e-6)contacts++
    }
    expect(contacts,`${id} floats`).toBeGreaterThan(2)
  }
})
