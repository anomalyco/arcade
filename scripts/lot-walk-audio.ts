import { mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { synthFoley, type FootSurface } from "../packages/kit/audio/footsteps"
import { Walk } from "../packages/kit/client/walk"
import { ambiencePcm } from "../packages/kit/audio/ambience"
import { walkDefaults } from "../games/lot/src/walk-settings"

// No playback: conservative mono levels, including the loudest 100 ms of every variant.
const rate=24000
function rms(a:Float32Array,gain=1){return Math.sqrt(a.reduce((n,x)=>n+x*x,0)/a.length)*gain}
function contact(a:Float32Array,gain=1){
  const count=Math.round(rate*.1);let sum=0,max=0
  for(let i=0;i<a.length;i++){sum+=a[i]!**2;if(i>=count)sum-=a[i-count]!**2;if(i>=count-1)max=Math.max(max,sum/count)}
  return Math.sqrt(max)*gain
}
const db=(x:number)=>20*Math.log10(Math.max(x,1e-12))
const settings=walkDefaults()
const air=Math.hypot(rms(ambiencePcm("wind"),settings.wind),rms(ambiencePcm("traffic"),settings.traffic))*settings.volume
const surfaces:FootSurface[]=["carpet","asphalt","wet-asphalt","puddle","gravel","dirt","grass","concrete","wood","tile","wet-grass","mud"]
const gain=(speed:number)=>{
  const walk=new Walk()
  for(let i=0;i<300;i++){
    walk.update({dx:0,dz:-speed/60,yaw:0,dt:1/60,active:true,amount:1,reduced:false,stride:.72,settling:.3})
    const event=walk.events.find(e=>e.kind==="step");if(event)return event.gain
  }
  throw Error("No foot contact")
}
const walkGain=gain(1.7),sprintGain=gain(3.06),slowGain=gain(.5)
if(Math.abs(walkGain-sprintGain)>1e-9)throw Error("Sprint raised contact loudness")
const rows=surfaces.map(surface=>{
  const values=Array.from({length:32},(_,seed)=>{
    const pcm=synthFoley("step",seed,rate,surface)
    return {seed,dbFS:db(contact(pcm,settings.volume*settings.footsteps*walkGain)),peak:Math.max(...pcm.map(Math.abs))}
  })
  const loudest=Math.max(...values.map(v=>v.dbFS))
  return {surface,loudestDbFS:loudest,relativeToOutdoorAirDb:loudest-db(air),variants:values}
})
const report={method:"Loudest 100ms RMS, 32 variants per material, mono; outdoor air is uncorrelated wind+traffic at default mix. No playback.",walkGain,sprintGain,slowGain,airDbFS:db(air),rows}
const out=resolve(process.argv[2]??"captures/lot/audio-levels.json")
mkdirSync(resolve(out,".."),{recursive:true});writeFileSync(out,JSON.stringify(report,null,2))
console.log(JSON.stringify({...report,rows:rows.map(({variants,...r})=>r)},null,2))
