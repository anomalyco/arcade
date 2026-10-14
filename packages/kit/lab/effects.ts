import { Emitter, type ParticleSpec } from "../fx/particles"
import {
  applyExplosionSmokeLive,
  explosionDefaults,
  explosionFlashLight,
  explosionRanges,
  spawnExplosion,
  type ExplosionNumericKey,
} from "../fx/explosion"
import { smokeDefaults, smokeRanges, type SmokeKey } from "../fx/volume-settings"
import type { LabControl } from "../lab-panel"
import { walls, type LabLight } from "./stage"
import type { LabContext, LabSection } from "./types"

export const effectSpecs:Record<string,ParticleSpec>={
  sparks:{kind:"spark",life:1.8,size:0.07,growth:-0.02,gravity:12,drag:0.4,bounce:0.5,r:1,g:0.55,b:0.12,alpha:1},
  debris:{kind:"debris",life:5,size:0.14,growth:0,gravity:12,drag:0.3,bounce:0.35,r:0.5,g:0.42,b:0.3,alpha:1},
  water:{kind:"water",life:2.2,size:0.09,growth:-0.015,gravity:10,drag:0.4,bounce:0.2,r:0.3,g:0.7,b:1,alpha:0.75},
  fire:{kind:"fire",life:0.8,size:0.3,growth:0.2,gravity:-3,drag:3,bounce:0,r:1.3,g:0.28,b:0.025,alpha:0.8},
  nitro:{kind:"fire",life:0.10,size:0.22,growth:-1,gravity:0,drag:0,bounce:0,r:0.1,g:0.55,b:1.5,alpha:0.9},
}
export const effectOptions=[
  {value:"smoke",label:"Grenade smoke"},{value:"tyre",label:"Tyre smoke"},{value:"nitro",label:"Nitro flame"},
  {value:"sparks",label:"Sparks"},{value:"explosion",label:"Explosion"},{value:"water",label:"Hydrant water"},
  {value:"debris",label:"Debris"},{value:"fire",label:"Fire"},
]
const specs=effectSpecs
const stageLightX=[-4,4,-4,4,0,0,-7,7],stageLightZ=[-2,2,3,-3,-6,6,0,0]

export function createEffects(context:LabContext) {
  const {particles,volume,trail,stage}=context,emitter=new Emitter()
  const params={
    ...smokeDefaults,
    ...explosionDefaults,
    rate:75,
    size:1,
    speed:1,
    density:1,
    interval:2.2,
    effect:"smoke",
    playing:true,
    loop:true,
    targetX:-1,
    targetZ:0,
    seed:7,
    roomSeed:1,
    tuningSeed:137,
  }
  const applySmoke=()=>{
    for(const key of Object.keys(smokeDefaults) as SmokeKey[])volume.settings[key]=params[key]
    if(effect==="explosion")applyExplosionSmokeLive(volume,params,params.density)
    else{volume.colorShift=0;volume.coreGlow=0}
  }
  let effect="smoke",time=0,seed=7
  const source={smokeDistance:0,smokeX:0,smokeZ:0,smokeActive:false,idle:0}
  const random=()=>{seed=Math.imul(seed,1664525)+1013904223|0;return(seed>>>0)/4294967296}
  const nextTuningRng=()=>{
    let s=Math.max(1,Math.round(params.tuningSeed))|0
    params.tuningSeed=(s%9999)+1
    return()=>{s=s+0x6D2B79F5|0;let t=Math.imul(s^s>>>15,1|s);t^=t+Math.imul(t^t>>>7,61|t);return((t^t>>>14)>>>0)/4294967296}
  }
  const current:ParticleSpec={...specs.sparks}
  const emit=(x:number,y:number,z:number)=>{
    const name=effect==="explosion"?"fire":effect,spec=specs[name]??specs.sparks
    Object.assign(current,spec);current.size*=params.size;current.alpha*=params.density
    const angle=random()*Math.PI*2,speed=(effect==="nitro"?3:effect==="fire"?0.7:2+random()*6)*params.speed
    let vx=Math.cos(angle)*speed,vy=(2+random()*5)*params.speed,vz=Math.sin(angle)*speed
    if(effect==="water"){vx*=0.3;vz*=0.3;vy=8*params.speed+random()*3}
    if(effect==="fire"||effect==="explosion")vy=1+random()*2
    if(effect==="nitro"){vx=-8*params.speed;vy=0;vz=(random()-0.5)*0.5;x=params.targetX-2.6;y=0.4;z=params.targetZ+0.45}
    particles.spawn(current,x,y,z,vx,vy,vz,random()*6.28)
  }
  const reset=(name=String(params.effect||effect))=>{
    effect=name;params.effect=effect;time=0;seed=Math.max(1,Math.round(params.seed))
    const activeWalls=context.activeWalls?.()??walls
    particles.reset()
    if(!context.hasPlaygroundScene?.()||effect==="tyre"){trail.reset();trail.seedWind(seed)}
    emitter.reset();volume.reset(activeWalls,seed)
    Object.assign(source,{smokeDistance:0,smokeX:0,smokeZ:0,smokeActive:false,idle:0})
    const tx=params.targetX,tz=params.targetZ
    const gy=context.activeGround?context.activeGround(tx,tz):0
    applySmoke()
    if(effect==="smoke")volume.spawn(tx,tz)
    if(effect==="explosion")spawnExplosion(particles,volume,tx,gy,tz,params,random,params.size,params.density)
    if(effect==="sparks"||effect==="debris")for(let i=0;i<params.rate;i++)emit(tx,gy+0.8,tz)
    params.effect=effect;context.sync()
  }
  const retriggerIfOneShot=()=>{
    applySmoke()
    if(effect==="explosion"||effect==="sparks"||effect==="debris")reset()
    else context.sync()
  }
  const reroll=()=>{
    params.roomSeed=(params.roomSeed*1664525+1013904223>>>0)%9999+1
    const s=params.roomSeed
    stage.lighting.spotYaw=-120+((s%7)-3)*18
    stage.lighting.moonAzimuth=-45+(((s>>3)%7)-3)*20
    stage.lighting.temperature=(((s>>6)%5)-2)*0.15
    reset(effect)
  }
  const advance=(dt:number)=>{
    time+=dt
    const tx=params.targetX,tz=params.targetZ
    const activeWalls=context.activeWalls?.()??walls
    const groundFn=context.activeGround
    if(effect==="tyre"&&time<3.5){trail.follow(source,tx+Math.sin(time*1.8)*2,tz+Math.cos(time*1.8)*1.5,0,0,dt,params.density)}
    if(effect==="water"||effect==="fire"||effect==="nitro")emitter.step(tx,0.3,tz,dt,params.rate,"rate",emit)
    if(effect==="explosion")applyExplosionSmokeLive(volume,params,params.density)
    particles.update(dt,activeWalls,groundFn);volume.update(dt);trail.update(dt)
    const loopPeriod=effect==="smoke"?params.growthTime+params.hold+params.fade+0.6:effect==="tyre"?Math.max(4,params.interval*2.5):params.interval
    if(params.loop&&time>=loopPeriod-1e-6)reset()
  }
  const prepare=()=>{
    if(context.hasPlaygroundScene?.())return
    if(effect!=="explosion"){
      stage.dynamicLights=null
      return
    }
    const tx=params.targetX,tz=params.targetZ,gy=context.activeGround?context.activeGround(tx,tz):0
    const flash=explosionFlashLight(tx,gy,tz,time,params)
    if(!flash){
      stage.dynamicLights=null
      return
    }
    const s=stage.lighting,deg=Math.PI/180,count=Math.max(0,Math.min(7,Math.round(s.count)))
    const lights:LabLight[]=[flash]
    for(let i=0;i<count;i++){
      const spot=i===1,cool=i%2===1
      const power=spot?(s.spot?s.spotPower:0):(s.lamps?s.lampPower:0)
      lights.push({
        x:stageLightX[i]!,
        y:s.lampHeight,
        z:stageLightZ[i]!,
        radius:s.lampRadius,
        r:cool?0.28:1.8,
        g:cool?0.85:0.95,
        b:cool?1.6:0.4,
        power,
        dx:Math.sin(s.spotYaw*deg)*Math.cos(s.spotPitch*deg),
        dy:-Math.sin(s.spotPitch*deg),
        dz:Math.cos(s.spotYaw*deg)*Math.cos(s.spotPitch*deg),
        cone:spot?Math.cos(s.spotAngle*deg):-2,
      })
    }
    stage.dynamicLights=lights
  }
  const controls:LabControl[]=[
    {key:"effect",label:"Effect",group:"Emitter",type:"select",options:effectOptions,change:value=>reset(String(value))},
    {key:"playing",label:"Play",group:"Emitter"},{key:"loop",label:"Loop",group:"Emitter"},
    {key:"interval",label:"Loop interval",group:"Emitter",type:"range",min:0.5,max:8,step:0.1,unit:"s",visible:s=>Boolean(s.loop)&&s.effect!=="smoke"&&s.effect!=="water"&&s.effect!=="fire"&&s.effect!=="nitro"},
    {key:"trigger",label:"Retrigger",group:"Emitter",type:"action",run:()=>reset()},
    {key:"rate",label:"Rate",group:"Parameters",type:"range",min:5,max:180,step:1,unit:"/s",visible:s=>s.effect!=="smoke"&&s.effect!=="tyre"&&s.effect!=="explosion",change:retriggerIfOneShot},
    {key:"size",label:"Size",group:"Parameters",type:"range",min:0.3,max:2,step:0.05,unit:"m",visible:s=>s.effect!=="tyre"&&s.effect!=="smoke"&&s.effect!=="explosion",change:retriggerIfOneShot},
    {key:"speed",label:"Speed",group:"Parameters",type:"range",min:0.2,max:2,step:0.05,unit:"m/s",visible:s=>s.effect!=="smoke"&&s.effect!=="tyre"&&s.effect!=="explosion",change:retriggerIfOneShot},
    {key:"density",label:"Density",group:"Parameters",type:"range",min:0.1,max:2,step:0.05,unit:"",visible:s=>s.effect!=="smoke"&&s.effect!=="explosion",change:retriggerIfOneShot},
    {key:"random-Parameters",label:"Randomize Parameters",group:"Parameters",type:"action",visible:s=>s.effect!=="smoke"&&s.effect!=="explosion",run:()=>{
      const rng=nextTuningRng()
      if(effect!=="tyre"){
        params.rate=Math.round(25+rng()*120)
        params.size=Number((Math.round((0.5+rng()*1.2)/0.05)*0.05).toFixed(2))
        params.speed=Number((Math.round((0.5+rng()*1.2)/0.05)*0.05).toFixed(2))
      }
      params.density=Number((Math.round((0.4+rng()*1.3)/0.05)*0.05).toFixed(2))
      reset()
    }},
    ...(Object.keys(explosionRanges) as ExplosionNumericKey[]).map((key):LabControl=>{
      const [min,max,step,unit,group,label]=explosionRanges[key]
      return {
        key,
        label,
        group,
        type:"range",
        min,
        max,
        step,
        unit,
        visible:s=>s.effect==="explosion",
        change:()=>{
          applyExplosionSmokeLive(volume,params,params.density)
          if(params.playing&&(unit.includes("retrigger")||time>1.6))reset()
          else context.sync()
        },
      }
    }),
    {
      key:"scorch",
      label:"Scorch decal",
      group:"Blast & Debris",
      visible:s=>s.effect==="explosion",
      change:()=>{if(params.playing)reset();else context.sync()},
    },
    ...(["Fireball","Explosion Smoke","Blast & Debris"] as const).map((group):LabControl=>({
      key:`random-${group}`,
      label:`Randomize ${group}`,
      group,
      type:"action",
      visible:s=>s.effect==="explosion",
      run:()=>{
        const rng=nextTuningRng()
        for(const key of Object.keys(explosionRanges) as ExplosionNumericKey[]){
          const [min,max,step,,g]=explosionRanges[key]
          if(g===group){
            params[key]=Number((Math.round((min+(max-min)*(0.18+rng()*0.64))/step)*step).toFixed(3))
          }
        }
        reset()
      },
    })),
    ...(Object.keys(smokeDefaults) as SmokeKey[]).map((key):LabControl=>{
      const [min,max,step,unit,group]=smokeRanges[key]
      const labels:Record<SmokeKey,string>={radius:"Radius",height:"Height",softness:"Edge softness",billowScale:"Billow scale",growthTime:"Growth time",rise:"Rise",wind:"Wind",turbulence:"Turbulence",extinction:"Extinction",lighting:"Lighting",hold:"Hold",fade:"Fade"}
      return {key,label:labels[key],group,type:"range",min,max,step,unit,visible:s=>s.effect==="smoke",change:()=>{
        applySmoke()
        if(unit.includes("retrigger")&&params.playing)reset()
      }}
    }),
    ...["Shape","Motion","Appearance","Lifetime"].map((group):LabControl=>({
      key:`random-${group}`,label:`Randomize ${group}`,group,type:"action",visible:s=>s.effect==="smoke",run:()=>{
        // Deliberately use the middle 60% of documented ranges for useful starting points.
        const rng=nextTuningRng()
        for(const key of Object.keys(smokeDefaults) as SmokeKey[]){
          const [min,max,step,,g]=smokeRanges[key]
          if(g===group)params[key]=Number((Math.round((min+(max-min)*(0.2+rng()*0.6))/step)*step).toFixed(3))
        }
        if(group==="Shape")params.softness=Math.min(params.softness,params.radius*0.4)
        applySmoke()
        if(params.playing||group!=="Appearance")reset()
        else context.sync()
      },
    })),
    {key:"targetX",label:"Origin X",group:"Origin & Seed",type:"range",min:-4.8,max:4.8,step:0.2,unit:"m",change:()=>reset()},
    {key:"targetZ",label:"Origin Z",group:"Origin & Seed",type:"range",min:-3.2,max:4.0,step:0.2,unit:"m",change:()=>reset()},
    {key:"seed",label:"Effect seed",group:"Origin & Seed",type:"range",min:1,max:999,step:1,unit:"",change:()=>reset()},
    {key:"copy",label:"Copy",group:"Actions",type:"action",run:async button=>{
      try{await navigator.clipboard.writeText(JSON.stringify(params,null,2));button.textContent="Copied"}
      catch{button.textContent="Copy failed"}
    }},
    {key:"carve",label:"Carve",group:"Actions",type:"action",run:()=>volume.carve(-6,0,6,0,0.7),visible:s=>s.effect==="smoke"||s.effect==="explosion"},
  ]
  const section:LabSection={
    id:"effects",label:"Effects",settings:params,controls,
    enter:()=>reset(),
    leave:()=>{if(!context.hasPlaygroundScene?.())stage.dynamicLights=null},
    update:dt=>{if(params.playing)advance(dt)},
    prepare,
    retrigger:()=>reset(),
    reroll,
    frameTarget:()=>({x:params.targetX,y:0.5,z:params.targetZ,dist:16}),
    objects:()=>[{id:"emitter:origin",label:`${effectOptions.find(o=>o.value===effect)?.label??effect} Origin`,category:"emitter",x:params.targetX,y:0.1,z:params.targetZ,radius:0.9,movable:true}],
    moveObject:(id,x,z)=>{
      if(id!=="emitter:origin")return false
      params.targetX=Math.max(-4.8,Math.min(4.8,Number(x.toFixed(2))))
      params.targetZ=Math.max(-3.2,Math.min(4.0,Number(z.toFixed(2))))
      reset()
      return true
    },
    telemetry:()=>`${particles.count+trail.count} particles · ${volume.count}/4 volumes`,
  }
  return {section,params,reset,advance}
}
