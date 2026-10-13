import { gameEffects, seeded, type EffectGroup } from "@arcade/kit/lab/game-effects"
import { GameSprites } from "@arcade/kit/lab/game-sprites"
import type { SectionFactory } from "@arcade/kit/lab/types"
import type { LabLight } from "@arcade/kit/lab/stage"
import { getawayEffects } from "./settings"
import { getawayEnvironment, getawayRooms } from "./environment"
import { Fx } from "../game/fx"
import { StreetProps } from "../game/props"
import { VehicleEmissions, EmissionState, vehicleEffects } from "../game/vehicle-emissions"
import { VEHICLES } from "../../shared/config"
import { newBody } from "../../shared/sim/vehicle"
import type { CarView } from "../../shared/sim/world"
import { buildCar } from "../render/car-mesh"
import { splitChassis } from "../render/chassis-mesh"
import { Chassis, chassisSettings } from "../game/chassis"
import type { SpriteWriter } from "../game/props/particles"
import { tyreSettings } from "@arcade/kit/lab/tyre-settings"

const labels:Record<keyof typeof getawayEffects,string>={sparks:"Sparks",scrape:"Scrape",skids:"Skids",nitro:"Nitro flame",pops:"Exhaust pops",cold:"Cold exhaust",landing:"Landing",debris:"Clutter debris",hydrant:"Hydrant water",explosion:"Explosion",plumes:"Smoke plumes",headlights:"Headlights"}

export const getawayEffectSection:SectionFactory=context=>gameEffects(context,"getaway-effects","Getaway effects",()=>{
  const {stage}=context,meshes=stage.meshes,sprites=new GameSprites(context),fx=new Fx(),emissions=new VehicleEmissions(context.trail)
  const settings={targetX:0,targetZ:0},groups=Object.fromEntries(Object.entries(getawayEffects).map(([id,settings])=>[id,{label:labels[id as keyof typeof labels],settings}])) as Record<string,EffectGroup>
  groups.landing.ranges={spring:[-8,-.1,.1]}
  groups.tyre={label:"Connected tyre smoke",settings:tyreSettings}
  let envModel=-1,props:StreetProps|undefined,lights:LabLight[]=[],time=0,active="",remaining=0,scrape=0
  let environment:ReturnType<typeof getawayEnvironment>|undefined
  const suspension=chassisSettings()
  const spec=VEHICLES[0],car:CarView={...newBody(0,0,0),id:1,ownerId:"lab",name:"Lab",role:spec.role,vehicle:spec.id,speed:0,drift:0,boost:1,human:true,impact:0,ghost:false}
  let model:ReturnType<typeof splitChassis>|undefined,bodyModel=0,wheels:number[]=[],chassis:Chassis|undefined,state=new EmissionState()
  const alpha=new Float32Array(4096*12),add=new Float32Array(4096*12)
  const addModel=(m:{v:number[]})=>meshes.add(m.v,12,c=>[2,5,8,9].includes(c)?1.5:0)
  const sprite:SpriteWriter=(list,x,y,z,size,r,g,b,a,kind,rot=0,stretch=1)=>{
    // Prop sprites keep the production counts, positions, lifetimes and color; only their Lab shader is shared.
    if(list==="a")sprites.push(x,y,z,size,r,g,b,a,kind===3?1:kind===20?4:0,rot,stretch)
    else pending.push([x,y,z,size,r,g,b,a,kind===2?2:0,rot,stretch])
  }
  const pending:number[][]=[]
  const clear=()=>{fx.add.length=0;fx.clearSkids();props?.clear();emissions.reset();state=new EmissionState();active="";remaining=0;scrape=0;time=0}
  return {settings,groups,effects:[...Object.entries(labels).map(([value,label])=>({value,label})),{value:"tyre",label:"Connected tyre smoke"}],environments:getawayRooms,
    controls:[{key:"targetX",label:"Target X",type:"range",min:-12,max:12,step:.25},{key:"targetZ",label:"Target Z",type:"range",min:-12,max:12,step:.25}],
    environment(kind,seed){
      clear();const env=environment=getawayEnvironment(kind,seed)
      if(envModel<0)envModel=meshes.add(env.vertices,12,c=>[2,5,8,9].includes(c)?1.5:0)
      else meshes.replace(envModel,env.vertices,12,c=>[2,5,8,9].includes(c)?1.5:0)
      lights=env.lights
      if(!props)props=new StreetProps({boxes:[],placements:[]},{addModel},()=>.02)
      if(!model){model=splitChassis(buildCar(spec));bodyModel=addModel(model.body);wheels=model.wheels.map(w=>addModel(w.mesh));chassis=new Chassis(car,model.wheels)}
      stage.sceneMode=4;stage.focus[0]=stage.focus[1]=stage.focus[2]=0
      seeded(seed,()=>{stage.lighting.moonPower=.15+Math.random()*.6;stage.lighting.exposure=Math.random()*.6;stage.lighting.temperature=Math.random()*.8-.4})
      context.trail.seedWind(seed)
    },
    trigger(effect,seed){
      if(!props)return
      seeded(seed,()=>{
        const x=settings.targetX,z=settings.targetZ;active=effect;remaining=effect==="headlights"?10:1.2
        Object.assign(car,{x,z,h:0,speed:0,vx:0,vz:0,drift:0})
        if(effect==="sparks"||effect==="scrape")fx.sparks(x,z,1,0,24,.3)
        if(effect==="skids")for(const side of [-.8,.8])fx.skidSegment(x+side,z-3,x+side,z+2,.6)
        if(effect==="plumes")props!.particles.emit(1,x,.3,z,14,.9)
        if(effect==="hydrant"||effect==="explosion"||effect==="debris")props!.trigger(effect==="hydrant"?"hydrant":effect==="explosion"?"propane":"crate",x,z)
        if(effect==="pops"){state.throttle=1;state.load=1;state.speed=20;car.speed=20;state.cooldown=0}
        if(effect==="landing"&&model&&environment){
          const world={...car,x:x+environment.origin.x,z:z+environment.origin.z}
          chassis=new Chassis(world,model.wheels)
          car.landings=(car.landings??0)+1;car.landing=11
        }
      })
    },
    update(dt){
      time+=dt;remaining=Math.max(0,remaining-dt);fx.update(dt);emissions.update(dt)
      props?.update([],dt,{x:0,z:0},true,()=>true)
      if(remaining>0){
        if(active==="scrape"){scrape+=dt*(getawayEffects.scrape.rate+getawayEffects.scrape.speedRate);const n=Math.floor(scrape);scrape-=n;fx.sparks(car.x,car.z,1,0,n,.12)}
        const cold=vehicleEffects.coldExhaust;vehicleEffects.coldExhaust=active==="cold"
        if(active==="tyre"){car.drift=12;car.speed=18}
        try{emissions.car(car,spec,state,{throttle:active==="pops"?0:1,brake:active==="tyre"?1:0,steer:0,handbrake:false,boost:active==="nitro"},dt,0,active==="tyre",active==="pops")}finally{vehicleEffects.coldExhaust=cold}
      }
      if(chassis&&environment)chassis.update({...car,x:car.x+environment.origin.x,z:car.z+environment.origin.z},spec,environment.city,dt,suspension,null)
    },
    prepare(){
      if(envModel<0)return
      meshes.instance(envModel,0,.001,0)
      if(model&&["nitro","pops","cold","tyre","landing","headlights"].includes(active)){
        const lift=chassis?.lift.x??0;meshes.instance(bodyModel,car.x,.18+lift,car.z,0,chassis?.roll.x??0,chassis?.pitch.x??0)
        model.wheels.forEach((w,i)=>meshes.instance(wheels[i],car.x+w.x,.18+(chassis?.contacts[i].y??w.y),car.z+w.z))
      }
      sprites.reset();pending.length=0
      const dynamic:LabLight[]=[]
      props?.draw((...args)=>meshes.instance(...args),sprite,(x,y,z,radius,r,g,b,power)=>dynamic.push({x,y,z,radius,r,g,b,power}),{x:0,z:0},false)
      const count=fx.emit(alpha,0,add,0,4096)
      sprites.batch(alpha,count.alpha,"getaway")
      emissions.emit(alpha,0,add,count.add,4096,true);sprites.batch(alpha,emissions.alphaCount,"getaway")
      sprites.additive();sprites.batch(add,emissions.addCount,"getaway")
      for(const p of pending)sprites.push(p[0],p[1],p[2],p[3],p[4],p[5],p[6],p[7],p[8],p[9],p[10])
      sprites.upload()
      if(active==="headlights")dynamic.push({x:car.x,y:1.3,z:car.z+3,radius:getawayEffects.headlights.radius,r:1,g:.92,b:.78,power:getawayEffects.headlights.power,dx:0,dy:-.3,dz:.95,cone:.8})
      stage.dynamicLights=[...dynamic,...lights].slice(0,8)
    },draw:sprites.draw,clear,inspect:()=>({particles:(props?.particles.count??0)+fx.add.length,skids:fx.skidCount,chunks:props?.chunks.length??0,water:props?.reactions.filter(r=>r.water).length??0,explosions:props?.stats.explosions??0,tyre:context.trail.count,time:+time.toFixed(2)}),
  }
})
