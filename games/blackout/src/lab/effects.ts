import { gameEffects, seeded, type EffectGroup } from "@arcade/kit/lab/game-effects"
import { GameSprites } from "@arcade/kit/lab/game-sprites"
import type { SectionFactory } from "@arcade/kit/lab/types"
import type { LabLight } from "@arcade/kit/lab/stage"
import { Game } from "../game/game"
import { Camera } from "../render/camera"
import { Sound } from "../audio/sound"
import { juiceSettings } from "../ui/debug-overlay"
import { GUN_IDS } from "../../shared/config"
import { blackoutEffects } from "./settings"
import { blackoutEnvironment, blackoutRooms, unpackLevel } from "./environment"
import type { LevelData } from "../render/level-mesh"
import type { FrameInput } from "../render/renderer"

const labels:Record<keyof typeof blackoutEffects,string>={muzzle:"Muzzle flash and light",tracer:"Tracers",holes:"Bullet holes",scorch:"Scorches",blood:"Blood",splats:"Blood splats",impact:"Impact sparks",dust:"Dust",glass:"Glass shards",paper:"Paper sheets",monitor:"Monitor sparks",casings:"Casings",magazines:"Magazines",lamps:"Lamp brownout",explosion:"Grenade explosion",corpse:"Ragdoll and corpse pool",vehicle:"Vehicle impact",fire:"Fire",wreck:"Wreck smoke"}

const specimenTargets:Record<string,{label:string;x:number;y:number;z:number;radius:number}>={
  glass:{label:"Glass Pane",x:8.5,y:0.9,z:9.05,radius:1.2},
  desk:{label:"Office Desk",x:12,y:0.5,z:8.9,radius:1.1},
  monitor:{label:"Desk Monitor",x:12,y:1.1,z:8.9,radius:0.7},
  wall:{label:"Brick Wall",x:12,y:0.9,z:5.6,radius:1.1},
  metal:{label:"Server Rack",x:16,y:0.9,z:8.25,radius:1.1},
  partition:{label:"Office Partition",x:8,y:0.7,z:5.6,radius:1.1},
}

export const blackoutEffectSection:SectionFactory=context=>gameEffects(context,"blackout-effects","Blackout effects",()=>{
  const {stage}=context,meshes=stage.meshes,sprites=new GameSprites(context),camera=new Camera()
  const settings={weapon:"rifle",surface:"glass",targetX:12,targetZ:11}
  const groups=Object.fromEntries(Object.entries(blackoutEffects).map(([id,settings])=>[id,{label:labels[id as keyof typeof labels],settings}])) satisfies Record<string,EffectGroup>
  let game:Game|undefined,environmentModel=-1,glassModel=-1,paperSheetModel=-1,glassSheetModel=-1,modelCount=0,frame:FrameInput|undefined,dt=0
  const lights:LabLight[]=[]
  const setLevel=(level:LevelData)=>{
    const vertices:number[]=[]
    for(const chunk of level.chunks)for(const v of unpackLevel(chunk.data))vertices.push(v)
    if(environmentModel<0)environmentModel=meshes.add(vertices)
    else meshes.replace(environmentModel,vertices)
    const glass:number[]=[]
    for(const chunk of level.glass)for(const v of unpackLevel(chunk.data))glass.push(v)
    if(glassModel<0)glassModel=meshes.add(glass,10,c=>c,.2)
    else meshes.replace(glassModel,glass)
  }
  return {settings,groups,effects:[{value:"shot",label:"Fire at surface"},...Object.entries(labels).map(([value,label])=>({value,label}))],environments:blackoutRooms,
    controls:[
      {key:"weapon",label:"Weapon",type:"select",options:GUN_IDS.map(value=>({value,label:value})),visible:s=>["shot","muzzle","tracer","impact","casings","magazines","corpse"].includes(String(s.effect))},
      {key:"surface",label:"Surface",type:"select",options:["glass","desk","monitor","wall","metal","partition"].map(value=>({value,label:value})),visible:s=>s.effect==="shot"},
      {key:"targetX",label:"Target X",type:"range",min:3,max:21,step:.25,unit:"m"},
      {key:"targetZ",label:"Target Z",type:"range",min:3,max:17,step:.25,unit:"m"},
    ],
    relevantGroups(s){
      const eff=String(s.effect),surf=String(s.surface)
      if(eff==="shot"){
        if(surf==="glass")return{primary:["glass"],advanced:["muzzle","tracer"]}
        if(surf==="desk")return{primary:["paper"],advanced:["muzzle","tracer"]}
        if(surf==="monitor")return{primary:["monitor"],advanced:["muzzle","tracer"]}
        return{primary:["holes","impact","dust"],advanced:["muzzle","tracer"]}
      }
      if(eff==="blood")return{primary:["blood","splats"]}
      if(eff==="splats")return{primary:["splats","blood"]}
      if(eff==="explosion")return{primary:["explosion","scorch"]}
      if(eff==="scorch")return{primary:["scorch","explosion"]}
      if(eff==="wreck")return{primary:["wreck","vehicle"]}
      if(eff==="vehicle")return{primary:["vehicle","wreck"]}
      return{primary:[eff]}
    },
    frameTarget(s){
      if(s.effect==="shot"){
        const spec=specimenTargets[String(s.surface)]??specimenTargets.glass!
        return{x:spec.x,y:spec.y,z:spec.z,dist:14}
      }
      return{x:Number(s.targetX),y:0.7,z:Number(s.targetZ),dist:15}
    },
    objects(s){
      return[
        {id:"emitter:target",label:"Emitter Target",category:"emitter",x:Number(s.targetX),y:0.15,z:Number(s.targetZ),radius:0.85,movable:true},
        ...Object.entries(specimenTargets).map(([key,spec])=>({
          id:`specimen:${key}`,label:spec.label,category:"specimen" as const,x:spec.x,y:spec.y,z:spec.z,radius:spec.radius,
        })),
      ]
    },
    selectObject(id,s){
      if(id.startsWith("specimen:")){
        const surf=id.slice("specimen:".length)
        const spec=specimenTargets[surf]
        if(!spec)return false
        s.surface=surf
        s.targetX=spec.x;s.targetZ=Number(spec.z.toFixed(2))
        if(s.effect!=="shot"&&surf==="glass")s.effect="glass"
        else if(s.effect!=="shot"&&surf==="desk")s.effect="paper"
        else if(s.effect!=="shot"&&surf==="monitor")s.effect="monitor"
        return true
      }
      return id==="emitter:target"
    },
    moveObject(id,x,z,s){
      if(id!=="emitter:target")return false
      s.targetX=Math.max(3,Math.min(21,Number((Math.round(x*4)/4).toFixed(2))))
      s.targetZ=Math.max(3,Math.min(17,Number((Math.round(z*4)/4).toFixed(2))))
      if(game){game.labClear();seeded(Number(s.effectSeed),()=>game!.labTrigger(String(s.effect),GUN_IDS.find(g=>g===settings.weapon)??"rifle",settings.surface,settings.targetX,settings.targetZ))}
      context.sync()
      return true
    },
    environment(kind,seed){
      const map=blackoutEnvironment(kind,seed)
      if(!game){
        // Sound stays locked: no AudioContext, fetch, listeners or production session are started.
        game=seeded(1,()=>new Game({addModel:m=>{
          const id=meshes.add(m.v,11,c=>c===8?-1.5:[2,3].includes(c)?1.5:0)
          if(modelCount===0)paperSheetModel=id
          else if(modelCount===1)glassSheetModel=id
          modelCount++
          return id
        },setLevel,updateBounce:()=>{},width:1100,height:760},{myId:"lab",room:null,latest:()=>null,roster:()=>[],drainEvents:()=>[],send:()=>{},status:()=>null,update:()=>{},close:()=>{}},new Sound(),{...juiceSettings(),volumes:false},map))
      }else game.labLoad(map)
      dt=0;frame=undefined;stage.sceneMode=4;stage.focus[0]=12;stage.focus[1]=0;stage.focus[2]=10;camera.snap(12,10);camera.dist=40
      seeded(seed,()=>{stage.lighting.moonPower=.2+Math.random()*.6;stage.lighting.temperature=Math.random()*.8-.4;stage.lighting.exposure=Math.random()*.7})
    },
    trigger(effect,seed){if(game)seeded(seed,()=>game!.labTrigger(effect,GUN_IDS.find(g=>g===settings.weapon)??"rifle",settings.surface,settings.targetX,settings.targetZ))},
    update(delta){dt+=delta;game?.labAdvance(delta)},
    prepare(){
      if(!game)return
      frame=seeded(Math.floor(game.map.seed+dt*1e6),()=>game!.build(camera,1100,760,dt));dt=0
      meshes.instance(environmentModel,0,.002,0)
      meshes.instance(glassModel,0,.002,0)
      for(const batch of frame.batches)for(let i=0;i<batch.count;i++){
        const p=i*12,d=batch.data
        const scale=d[p+7]*(batch.model===glassSheetModel?blackoutEffects.glass.size:batch.model===paperSheetModel?blackoutEffects.paper.size:1)
        meshes.instance(batch.model,d[p],d[p+1],d[p+2],-d[p+3],d[p+8],d[p+9],scale,[d[p+4],d[p+5],d[p+6]])
      }
      sprites.reset();sprites.batch(frame.alphaSprites,frame.alphaCount,"blackout");sprites.additive();sprites.batch(frame.addSprites,frame.addCount,"blackout");sprites.upload()
      lights.length=0
      for(let i=0;i<frame.lightCount;i++){const o=i*16,l=frame.lights;lights.push({x:l[o],y:l[o+1],z:l[o+2],radius:l[o+3],r:l[o+4],g:l[o+5],b:l[o+6],power:l[o+7]})}
      stage.dynamicLights=lights.slice(-8)
    },draw:sprites.draw,clear(){game?.labClear()},inspect:()=>game?.labInspect()??{},
  }
})
