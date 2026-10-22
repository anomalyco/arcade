import { mkdir } from "node:fs/promises"
import { OfficePhysics } from "../src/polish/props"
import { DustField } from "../src/polish/dust"
import { tubeSignal } from "../src/polish/tube"
import { polishDefaults } from "../src/polish/settings"

const out=process.env.POLISH_OUT??"captures/nightshift-polish"
await mkdir(out,{recursive:true})
const s=polishDefaults(),physics=new OfficePhysics([[-.28,-.28,.28,.28]]),dust=new DustField(),trace=[]
for(let i=0;i<60*40;i++){
  const time=i/60,moving=i<60,body={x:-.3,y:moving?.65:3,vx:0,vy:moving?-1.7:0}
  physics.step(1/60,body,[physics.chairs[0].collider],s)
  physics.cord(1/60,[i<60?i/60*.4:.4,0,0],s)
  dust.step(1/60,time,0,3-Math.min(time,2),s.dustWake)
  const signal=tubeSignal(time,1),c=physics.chairs[0]
  trace.push({frame:i,time,tube:signal,light:signal.level,emissive:signal.level,hum:signal.level,chair:{x:c.x,z:c.z,yaw:c.yaw,vx:c.vx,vz:c.vz,spin:c.spin},cord:[...physics.swing],paper:physics.paper,mote:Array.from(dust.data.slice(0,4))})
}
await Bun.write(`${out}/polish-trace.json`,JSON.stringify(trace))
console.log(JSON.stringify({frames:trace.length,starterFrames:trace.filter(f=>f.tube.crackle>0).length,final:trace.at(-1)}))
