import {mkdir} from "node:fs/promises"
import {resolve} from "node:path"
import {Walk} from "../src/walk"
const out=resolve(process.env.NIGHTSHIFT_WALK_DIR??"captures/nightshift-walk")
await mkdir(out,{recursive:true})
const summaries=[]
for(const hz of [30,60,120,144]){
  const w=new Walk(),trace=[]
  for(let i=0;i<hz*16;i++){
    const t=i/hz,speed=t<1?0:t<5?1.7:t<6?.5:t<7?0:t<10?2.8:t<12?1.7:0,yaw=t<3?0:t<4?(t-3)*1.2:t<8?1.2:t<9?1.2-(t-8)*1.8:-.6
    w.update({dt:1/hz,dx:-Math.sin(yaw)*speed/hz,dz:-Math.cos(yaw)*speed/hz,yaw,active:t<14,amount:1,reduced:t>=11,stride:.72,settling:.3})
    trace.push({time:w.time,phase:w.phase,speed:w.speed,x:w.lateral,y:w.vertical,roll:w.roll,events:w.events})
  }
  let maxSpeed=0,maxRollSpeed=0,maxDelta=0
  for(let i=1;i<trace.length;i++){const a=trace[i-1],b=trace[i],d=Math.hypot(b.x-a.x,b.y-a.y);maxDelta=Math.max(maxDelta,d);maxSpeed=Math.max(maxSpeed,d*hz);maxRollSpeed=Math.max(maxRollSpeed,Math.abs(b.roll-a.roll)*hz)}
  const report={hz,frames:trace.length,maxFrameTranslationMm:maxDelta*1000,maxTranslationSpeed:maxSpeed,maxRollSpeed,verticalRangeMm:[Math.min(...trace.map(x=>x.y))*1000,Math.max(...trace.map(x=>x.y))*1000],maxRollDegrees:Math.max(...trace.map(x=>Math.abs(x.roll)))*180/Math.PI,steps:trace.flatMap(x=>x.events).filter(e=>e.kind==="step").length,rest:trace.at(-1),passed:maxSpeed<.2&&maxRollSpeed<.08}
  await Bun.write(resolve(out,`trace-${hz}.json`),JSON.stringify({report,trace},null,2));summaries.push(report)
}
await Bun.write(resolve(out,"motion-metrics.json"),JSON.stringify({method:"Distance-clock gait, exact critically damped envelopes; start/slow/stop/sprint/turn/reverse/reduce/focus-loss; bounds on presentation offsets, not mouse input",summaries},null,2))
console.log(JSON.stringify(summaries,null,2));if(summaries.some(r=>!r.passed))process.exit(1)
