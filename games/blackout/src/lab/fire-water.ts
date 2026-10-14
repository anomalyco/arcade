import { mat4 } from "wgpu-matrix"
import { FireWater, fireStyles, type ElementEffect } from "@arcade/kit/fx/fire-water"
import { GameSprites } from "@arcade/kit/lab/game-sprites"
import type { SectionFactory } from "@arcade/kit/lab/types"
import type { LabControl } from "@arcade/kit/lab-panel"
import type { LabLight } from "@arcade/kit/lab/stage"
import { blackoutEnvironment, unpackLevel } from "./environment"
import { getawayEnvironment } from "../../../getaway/src/lab/environment"
import { StreetProps } from "../../../getaway/src/game/props"
import { Game } from "../game/game"
import { Camera } from "../render/camera"
import { Sound } from "../audio/sound"
import { juiceSettings } from "../ui/debug-overlay"
import { seeded } from "@arcade/kit/lab/game-effects"
import type { LevelData } from "../render/level-mesh"

/** Keep the generated alley footprint, with a 3.2 m wall cutaway for the fixed study camera. */
function alleyCutaway(p:readonly number[]){
  const result:number[]=[],height=3.2
  for(let i=0;i<p.length;i+=36){
    const triangle=[p.slice(i,i+12),p.slice(i+12,i+24),p.slice(i+24,i+36)],polygon:number[][]=[]
    for(let j=0;j<3;j++){
      const a=triangle[j],b=triangle[(j+1)%3],inside=a[1]<=height
      if(inside)polygon.push(a)
      if(inside!==(b[1]<=height)){const t=(height-a[1])/(b[1]-a[1]);polygon.push(a.map((v,k)=>v+(b[k]-v)*t))}
    }
    for(let j=1;j<polygon.length-1;j++)for(const v of [polygon[0],polygon[j],polygon[j+1]])result.push(...v.slice(0,9),[2,5,8,9].includes(v[9])?1.5:0)
  }
  return result
}

/** Side-by-side study of the current emitters and their shared-FX replacements. */
export const fireWaterSection:SectionFactory=context=>{
  const {stage}=context,meshes=stage.meshes,fx=new FireWater(context.device),legacy=new GameSprites(context)
  let previousLighting={...stage.lighting}
  const settings={effect:"fire",style:1,environment:"downtown",seed:7,zoom:1,playing:true,loop:true,sirens:true,age:0}
  let environmentModel=-1,game:Game|undefined,props:StreetProps|undefined,time=0,dt=0,lights:LabLight[]=[]
  const camera=new Camera();camera.snap(12,10);camera.dist=40
  const addModel=(m:{v:number[]})=>meshes.add(m.v,12,c=>[2,5,8,9].includes(c)?1.5:0)
  const trigger=()=>{
    time=0;dt=0;settings.age=0;fx.reset(settings.effect as ElementEffect);game?.labClear();props?.clear()
    if(settings.effect==="water")props?.trigger("hydrant",0,0)
    else if(settings.effect==="fireball")props?.trigger("propane",0,0)
    else game?.labTrigger(settings.effect,"rifle","wall",12,10)
    context.emit?.({type:"effect",section:"fire-water",effect:settings.effect,x:0,y:.2,z:0})
    context.sync()
  }
  const load=()=>{
    let vertices:number[]=[]
    const envSeed=Math.max(1,Math.round(settings.seed))
    if(settings.environment==="alley"){
      const env=getawayEnvironment("alley",envSeed);lights=env.lights.slice(0,4)
      vertices=alleyCutaway(env.vertices)
    }else{
      const generated=blackoutEnvironment(settings.environment==="office"?"office":"downtown",envSeed)
      const map={...generated,walls:generated.walls.slice(3),props:generated.props.slice(1),glass:generated.glass.slice(1)}
      // The same production builder as the Blackout effects environment, centered for shared FX.
      levelSink=(level:LevelData)=>{for(const chunk of level.chunks){const p=unpackLevel(chunk.data);for(let i=0;i<p.length;i+=10){p[i]-=12;p[i+2]-=10}for(const value of p)vertices.push(value)}}
      game!.labLoad(map)
      lights=map.lights.slice(0,3).map(l=>({x:l.x-12,y:l.h,z:l.y-10,radius:l.r,r:l.color[0],g:l.color[1],b:l.color[2],power:l.power}))
    }
    if(environmentModel<0)environmentModel=meshes.add(vertices)
    else meshes.replace(environmentModel,vertices)
    if(!props)props=new StreetProps({boxes:[],placements:[]},{addModel},()=>.03)
    stage.sceneMode=4;stage.focus[0]=0;stage.focus[1]=1;stage.focus[2]=0
    stage.lighting.moonPower=.12;stage.lighting.exposure=-.12;stage.lighting.temperature=0
    trigger()
  }
  let levelSink:(level:LevelData)=>void=()=>{}
  const controls:LabControl[]=[
    {key:"effect",label:"Effect",group:"Emitter",type:"select",options:[{value:"fire",label:"Fire"},{value:"wreck",label:"Burning wreck"},{value:"explosion",label:"Grenade fire"},{value:"fireball",label:"Getaway fireball"},{value:"water",label:"Hydrant water"}],change:trigger},
    {key:"style",label:"Style",group:"Emitter",type:"select",options:fireStyles,change:()=>context.sync()},
    {key:"environment",label:"Environment",group:"Emitter",type:"select",options:[{value:"downtown",label:"Downtown night"},{value:"office",label:"Office"},{value:"alley",label:"Getaway alley"}],change:load},
    {key:"zoom",label:"Zoom",group:"Emitter",type:"range",min:1,max:2.8,step:.1,unit:"×"},
    {key:"playing",label:"Play",group:"Emitter"},{key:"loop",label:"Loop",group:"Emitter"},{key:"sirens",label:"Siren lights",group:"Emitter"},
    {key:"trigger",label:"Retrigger",group:"Emitter",type:"action",run:trigger},
  ]
  const ranges:Record<string,[number,number,number]>={height:[1,7,.1],width:[.2,2,.05],speed:[.2,5,.1],erosion:[.05,1.2,.05],embers:[0,100,1],smoke:[0,1,.05],light:[0,8,.1],shimmer:[0,4,.1],spray:[0,220,1],mist:[0,1,.05],puddle:[1,6,.1],sheen:[0,6,.1],roughness:[0,1,.05],foam:[0,2,.05]}
  for(const [family,variants] of [["fire",fx.fire],["water",fx.water]] as const){
    for(const key of Object.keys(variants[1])){
      const name=`${family}.${key}`,[min,max,step]=ranges[key]
      Object.defineProperty(settings,name,{enumerable:true,get:()=>Reflect.get(variants[Math.max(1,settings.style)],key),set:(value:number)=>Reflect.set(variants[Math.max(1,settings.style)],key,value)})
      controls.push({
        key:name,label:key[0].toUpperCase()+key.slice(1),group:family==="fire"?"Flame":"Water",type:"range",min,max,step,
        visible:s=>(s.effect==="water")===(family==="water"),
        enabled:()=>settings.style>0&&(settings.effect==="water")===(family==="water"),
      })
    }
  }
  controls.push({key:"copy",label:"Copy JSON",group:"Emitter",type:"action",run:async()=>navigator.clipboard.writeText(JSON.stringify({settings,fire:fx.fire,water:fx.water},null,2))})
  return {id:"fire-water",label:"Fire and water",settings,controls,
    retrigger:trigger,
    reroll:()=>{settings.seed=(settings.seed*1664525+1013904223>>>0)%999+1;load()},
    frameTarget:()=>({x:0,y:1,z:0,dist:14}),
    objects:()=>[{id:"emitter:fire-water",label:`${settings.effect} Emitter`,category:"emitter",x:0,y:0.2,z:0,radius:1.1}],
    enter(){
      previousLighting={...stage.lighting}
      // The wrapper keeps subsequent environment rebuilds bound to the current geometry sink.
      if(!game){const map=blackoutEnvironment("office",7);game=seeded(1,()=>new Game({addModel:m=>meshes.add(m.v,11,c=>c===8?-1.5:[2,3].includes(c)?1.5:0),setLevel:l=>levelSink(l),updateBounce:()=>{},width:1000,height:720},{myId:"lab",room:null,latest:()=>null,roster:()=>[],drainEvents:()=>[],send:()=>{},status:()=>null,update:()=>{},close:()=>{}},new Sound(),{...juiceSettings(),volumes:false},map))}
      stage.cameraOverride=(w,h,vp,inverse,eye,focus)=>{const z=settings.zoom;eye.set([focus[0]+9/z,focus[1]+22/z,focus[2]+23/z]);mat4.multiply(mat4.perspective(.65,w/h,.1,150),mat4.lookAt(eye,focus,[0,1,0]),vp);mat4.inverse(vp,inverse)}
      stage.afterScene=(...args)=>fx.shimmer(...args)
      load()
    },
    leave(){stage.cameraOverride=undefined;stage.afterScene=undefined;Object.assign(stage.lighting,previousLighting)},
    update(delta){if(!settings.playing)return;time+=delta;dt+=delta;settings.age=time;fx.update(delta);seeded(73+Math.round(time*60),()=>{game?.labAdvance(delta);props?.update([],delta,{x:0,z:0},true,()=>true)});if(settings.loop&&["explosion","fireball"].includes(settings.effect)&&time>4)trigger()},
    prepare(){
      if(!game||environmentModel<0)return
      meshes.instance(environmentModel,0,.002,0)
      const frame=seeded(71+Math.floor(time*60),()=>game!.build(camera,1000,720,dt));dt=0
      if(settings.effect!=="water"&&settings.effect!=="fireball")for(const batch of frame.batches)for(let i=0;i<batch.count;i++){const o=i*12,p=batch.data;meshes.instance(batch.model,p[o]-12,p[o+1],p[o+2]-10,-p[o+3],p[o+8],p[o+9],p[o+7],[p[o+4],p[o+5],p[o+6]])}
      legacy.reset()
      const legacyLights:LabLight[]=[]
      if(settings.effect==="water"||settings.effect==="fireball"){
        const additive:number[][]=[]
        props?.draw((...a)=>meshes.instance(...a),(list,x,y,z,size,r,g,b,a,kind,rot=0,stretch=1)=>{
          if(list==="a")legacy.push(x,y,z,size,r,g,b,a,kind===3?1:0,rot,stretch)
          else additive.push([x,y,z,size,r,g,b,a,kind===2?2:0,rot,stretch])
        },(x,y,z,radius,r,g,b,power)=>legacyLights.push({x,y,z,radius,r,g,b,power}),{x:0,z:0},false)
        legacy.additive();for(const a of additive)legacy.push(a[0],a[1],a[2],a[3],a[4],a[5],a[6],a[7],a[8],a[9],a[10])
      }else{
        for(const [data,n] of [[frame.alphaSprites,frame.alphaCount],[frame.addSprites,frame.addCount]] as const)for(let i=0;i<n;i++){data[i*12]-=12;data[i*12+2]-=10}
        legacy.batch(frame.alphaSprites,frame.alphaCount,"blackout");legacy.additive();legacy.batch(frame.addSprites,frame.addCount,"blackout")
      }
      if(settings.style===0)legacy.upload()
      fx.style=settings.style;fx.effect=settings.effect as ElementEffect
      const dynamic:LabLight[]=[{x:-3,y:3.4,z:-3,radius:13,r:1,g:.67,b:.32,power:4}]
      const flame=fx.light();if(flame)dynamic.push(flame)
      if(settings.style===0){
        if(settings.effect==="fireball")dynamic.push(...legacyLights.slice(0,2))
        else if(settings.effect!=="water")for(let i=0;i<Math.min(frame.lightCount,2);i++){const o=i*16,p=frame.lights;dynamic.push({x:p[o]-12,y:p[o+1],z:p[o+2]-10,radius:p[o+3],r:p[o+4],g:p[o+5],b:p[o+6],power:p[o+7]})}
      }
      if(settings.sirens){const red=.3+.7*Math.max(0,Math.sin(time*5)),blue=.3+.7*Math.max(0,-Math.sin(time*5));dynamic.push({x:-2,y:1.3,z:-3,radius:8,r:1,g:.015,b:.025,power:red*4},{x:2,y:1.3,z:-3,radius:8,r:.02,g:.18,b:1,power:blue*4})}
      stage.dynamicLights=[...dynamic,...lights].slice(0,8);fx.prepare(stage.viewProj,stage.eye,stage.dynamicLights)
    },draw(pass){if(settings.style===0)legacy.draw(pass);else fx.draw(pass)},telemetry:()=>`${settings.effect} · ${time.toFixed(2)} s · ${fx.count} quads`,
  }
}
