import { Particles, Emitter, type ParticleSpec } from "../fx/particles"
import { SmokeTrail } from "../fx/smoke-trail"
import { SmokeVolumes } from "../fx/volume"
import { Stage, walls, type CameraWriter } from "./stage"
import { LabPanel } from "../lab-panel"
import "./style.css"

const specs:Record<string,ParticleSpec>={
  sparks:{kind:"spark",life:1.8,size:0.07,growth:-0.02,gravity:12,drag:0.4,bounce:0.5,r:1,g:0.55,b:0.12,alpha:1},
  debris:{kind:"debris",life:5,size:0.14,growth:0,gravity:12,drag:0.3,bounce:0.35,r:0.5,g:0.42,b:0.3,alpha:1},
  water:{kind:"water",life:2.2,size:0.09,growth:-0.015,gravity:10,drag:0.4,bounce:0.2,r:0.3,g:0.7,b:1,alpha:0.75},
  fire:{kind:"fire",life:0.8,size:0.3,growth:0.2,gravity:-3,drag:3,bounce:0,r:1.3,g:0.28,b:0.025,alpha:0.8},
  nitro:{kind:"fire",life:0.10,size:0.22,growth:-1,gravity:0,drag:0,bounce:0,r:0.1,g:0.55,b:1.5,alpha:0.9},
}
export async function playground(camera:CameraWriter){
  document.body.innerHTML=`<canvas id="view" tabindex="0"></canvas>`
  const canvas=document.querySelector<HTMLCanvasElement>("canvas")!
  const adapter=await navigator.gpu?.requestAdapter({powerPreference:"high-performance"})
  if(!adapter)throw new Error("WebGPU unavailable")
  const device=await adapter.requestDevice({requiredFeatures:adapter.features.has("timestamp-query")?["timestamp-query"]:[]})
  device.addEventListener("uncapturederror",e=>console.error(e.error.message))
  const context=canvas.getContext("webgpu")!,format=navigator.gpu.getPreferredCanvasFormat()
  context.configure({device,format,alphaMode:"opaque"})
  const stage=new Stage(device,context,format,camera),particles=new Particles(),volume=new SmokeVolumes(),trail=new SmokeTrail(),emitter=new Emitter()
  const params={rate:75,size:1,speed:1,density:1,effect:"smoke",debug:0,playing:true,loop:true}
  let effect="smoke",time=0,seed=7
  const source={smokeDistance:0,smokeX:0,smokeZ:0,smokeActive:false,idle:0}
  const random=()=>{seed=Math.imul(seed,1664525)+1013904223|0;return(seed>>>0)/4294967296}
  const resize=()=>{canvas.width=innerWidth;canvas.height=innerHeight;stage.resize(canvas.width,canvas.height)}
  addEventListener("resize",resize);resize()
  const current:ParticleSpec={...specs.sparks}
  const emit=(x:number,y:number,z:number)=>{
    const name=effect==="explosion"?"fire":effect,spec=specs[name]??specs.sparks
    Object.assign(current,spec);current.size*=params.size;current.alpha*=params.density
    const angle=random()*Math.PI*2,speed=(effect==="nitro"?3:effect==="fire"?0.7:2+random()*6)*params.speed
    let vx=Math.cos(angle)*speed,vy=(2+random()*5)*params.speed,vz=Math.sin(angle)*speed
    if(effect==="water"){vx*=0.3;vz*=0.3;vy=8*params.speed+random()*3}
    if(effect==="fire"||effect==="explosion")vy=1+random()*2
    if(effect==="nitro"){vx=-8*params.speed;vy=0;vz=(random()-0.5)*0.5;x=-3.6;y=0.4;z=0.45}
    particles.spawn(current,x,y,z,vx,vy,vz,random()*6.28)
  }
  const reset=(name=effect)=>{
    effect=name;time=0;seed=7;particles.reset();trail.reset();trail.seedWind(7);emitter.reset();volume.reset(walls)
    Object.assign(source,{smokeDistance:0,smokeX:0,smokeZ:0,smokeActive:false,idle:0})
    if(effect==="smoke"||effect==="explosion")volume.spawn(-1,0,5.5*params.size,effect==="smoke"?9:5,params.density,effect==="explosion"?0.45:0)
    if(effect==="sparks"||effect==="debris"||effect==="explosion")for(let i=0;i<params.rate;i++)emit(-1,0.8,0)
    params.effect=effect;panel.sync()
  }
  const advance=(dt:number)=>{
    time+=dt
    if(effect==="tyre"&&time<3.5){trail.follow(source,-1+Math.sin(time*1.8)*2,Math.cos(time*1.8)*1.5,0,0,dt,params.density)}
    if(effect==="water"||effect==="fire"||effect==="nitro")emitter.step(-1,0.3,0,dt,params.rate,"rate",emit)
    particles.update(dt,walls);volume.update(dt);trail.update(dt)
    if(params.loop&&time>(effect==="smoke"?10:effect==="tyre"?8:5))reset()
  }
  const panel=new LabPanel(params,[
    {key:"effect",label:"Effect",type:"select",options:[
      {value:"smoke",label:"Grenade smoke"},{value:"tyre",label:"Tyre smoke"},{value:"nitro",label:"Nitro flame"},
      {value:"sparks",label:"Sparks"},{value:"explosion",label:"Explosion"},{value:"water",label:"Hydrant water"},
      {value:"debris",label:"Debris"},{value:"fire",label:"Fire"},
    ],change:value=>reset(String(value))},
    {key:"playing",label:"Play"},{key:"loop",label:"Loop"},
    {key:"trigger",label:"Retrigger",type:"action",run:()=>reset()},
    {key:"rate",label:"Rate",type:"range",min:5,max:180},
    {key:"size",label:"Size",type:"range",min:0.3,max:2,step:0.05},
    {key:"speed",label:"Speed",type:"range",min:0.2,max:2,step:0.05},
    {key:"density",label:"Density",type:"range",min:0.1,max:2,step:0.05},
    {key:"debug",label:"Debug view",type:"select",options:[
      {value:0,label:"Shaded"},{value:1,label:"Density"},{value:2,label:"Overdraw / optical depth"},
      {value:3,label:"Lighting only"},{value:4,label:"Volume bounds"},
    ]},
    {key:"copy",label:"Copy",type:"action",run:async button=>{
      try{await navigator.clipboard.writeText(JSON.stringify({effect,rate:params.rate,size:params.size,speed:params.speed,density:params.density},null,2));button.textContent="Copied"}
      catch{button.textContent="Copy failed"}
    }},
    {key:"carve",label:"Carve",type:"action",run:()=>volume.carve(-6,0,6,0,0.7)},
  ],new URLSearchParams(location.search),()=>{}, {open:true,presets:false,shortcut:true})
  const render=async(measure=false)=>{
    const ms=await stage.render(particles,volume,trail,params.debug,measure)
    panel.header.textContent=`${particles.count+trail.count} particles · ${volume.count}/4 volumes\nGPU ${stage.gpuMs?.toFixed(2)??"—"} ms${stage.gpuMs===null?" (unavailable)":""}`
    return ms
  }
  reset()
  const bench=new URLSearchParams(location.search).has("bench")
  let last=0
  const tick=async(now:number)=>{
    const dt=last?Math.min(0.033,(now-last)/1000):0;last=now
    if(!bench&&!document.hidden){if(params.playing)advance(dt);await render()}
    requestAnimationFrame(tick)
  }
  Object.assign(window,{fx:{adapter:adapter.info,reset,advance,render,debug:(n:number)=>{params.debug=n;panel.sync()},volume,particles,trail,stage,params}})
  requestAnimationFrame(tick)
}
