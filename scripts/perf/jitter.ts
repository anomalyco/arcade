import { appendFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { World } from "../../games/getaway/shared/sim/world"
import { NetClient } from "../../games/getaway/src/game/netcode"

// Ordered delivery: a delayed WebSocket packet holds up the following packets too.
// Actual Getaway interpolation; Blackout's two render formulas transcribed below.
const root=join(import.meta.dir,"../..")
const world=new World(7,[{id:"human",name:"human",human:true,picks:{robber:"muscle",cop:"cruiser"}},{id:"other",name:"other",human:true,picks:{robber:"muscle",cop:"cruiser"}}])
const view=world.view("human"), template=view.cars[0]!
const median=(x:number[])=>[...x].sort((a,b)=>a-b)[Math.floor(x.length/2)]!
const summary=(x:number[])=>({median:median(x),mad:median(x.map(y=>Math.abs(y-median(x)))),min:Math.min(...x),max:Math.max(...x),runs:x})
const results=[]
for(const hz of [15,10,7.5]) for(const jitter of [0,30,60,100]) for(const stall of [0,150]) {
  const runs=[]
  for(let run=0;run<8;run++) {
    const client=new NetClient(world.city,"observer",()=>{})
    let rng=100+run;const random=()=>{rng=(Math.imul(rng,1664525)+1013904223)>>>0;return rng/2**32}
    const packets=[];let arrival=0
    for(let t=0;t<20;t+=1/hz) {
      arrival=Math.max(arrival,t+.05+random()*jitter/1000+(stall&&Math.floor(t*hz)%Math.round(hz*2)===0?stall/1000:0))
      packets.push({at:arrival,t,tick:Math.round(t*30)+1,x:100+10*t,v:10})
    }
    let next=0, unbracketed=0,total=0,blackX=100,vehicleX=100,last:any=null, receivedAt=0
    const getError=[],blackError=[],vehicleError=[],blackSpeed=[],getSpeed=[]
    let prevG=100,prevB=100
    for(let t=0;t<20;t+=1/60) {
      while(next<packets.length&&packets[next]!.at<=t) {
        last=packets[next++]!;receivedAt=t
        client.receive({type:"snapshot",tick:last.tick,ack:0,you:null,view:{...view,cars:[{...template,x:last.x,z:100,vx:10,vz:0,h:0}],t:last.t}})
      }
      const v=client.update(1/60,{throttle:0,brake:0,steer:0,boost:false,handbrake:false})
      if(!last||!v)continue
      const target=(client as any).est-3
      if(target>client.latest!.tick)unbracketed++
      blackX+=(last.x+last.v*.05-blackX)*(1-Math.exp(-16/60))
      vehicleX+=(last.x+last.v*Math.min(.25,t-receivedAt)-vehicleX)*(1-Math.exp(-14/60))
      if(t>1) {
        total++
        const drawn=v.cars[0]!.x
        getError.push(Math.abs(drawn-(100+10*(t-.15))))
        blackError.push(Math.abs(blackX-(100+10*t)))
        vehicleError.push(Math.abs(vehicleX-(100+10*t)))
        getSpeed.push(Math.abs((drawn-prevG)*60-10));blackSpeed.push(Math.abs((blackX-prevB)*60-10))
      }
      prevG=v.cars[0]!.x;prevB=blackX
    }
    const avg=(x:number[])=>x.reduce((a,b)=>a+b,0)/x.length
    runs.push({run,warmup:run===0,unbracketed_pct:unbracketed/(20*60)*100,getaway_error_m:avg(getError),blackout_avatar_error_m:avg(blackError),blackout_vehicle_error_m:avg(vehicleError),getaway_speed_error_mps:avg(getSpeed),blackout_avatar_speed_error_mps:avg(blackSpeed)})
  }
  const measured=runs.slice(1)
  const record={experiment:"proposals-jitter",hz,jitter_ms:jitter,stall_ms:stall,warmup:1,measured:7,metrics:Object.fromEntries(Object.keys(measured[0]!).filter(k=>!['run','warmup'].includes(k)).map(k=>[k,summary(measured.map(r=>(r as any)[k]))])),runs,note:"20s constant-speed 10m/s synthetic trajectory; one-way base latency 50ms; uniform positive jitter; optional 150ms ordered stall every 2s. Getaway uses NetClient with you:null to isolate remote interpolation; Blackout reproduces avatar/vehicle smoothing formulas, not full Game integration. Error for Getaway is against nominal 150ms delayed truth; Blackout against current truth. Not comparable cross-game accuracy scores."}
  results.push(record);appendFileSync(join(root,"perf/results.jsonl"),JSON.stringify(record)+"\n")
}
writeFileSync(join(root,"perf/proposals-data/jitter.json"),JSON.stringify(results,null,2))
console.log("Jitter matrix: 24 scenarios, 1 warmup + 7 seeded schedules each")
