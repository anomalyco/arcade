import { mat4 } from "wgpu-matrix"
import { SplatterRenderer } from "@arcade/kit/fx/splatter-renderer"
import { splatterPresets, type SplatterImpact } from "@arcade/kit/fx/splatter"
import { GameSprites } from "@arcade/kit/lab/game-sprites"
import { seeded } from "@arcade/kit/lab/game-effects"
import type { SectionFactory } from "@arcade/kit/lab/types"
import type { LabControl } from "@arcade/kit/lab-panel"
import { Game } from "../game/game"
import { Camera } from "../render/camera"
import { Sound } from "../audio/sound"
import { juiceSettings } from "../ui/debug-overlay"
import type { LevelData } from "../render/level-mesh"
import { blackoutEnvironment,unpackLevel } from "./environment"

export const splatterSection:SectionFactory=context=>{
  const {stage}=context,meshes=stage.meshes,renderer=new SplatterRenderer(context.device),legacy=new GameSprites(context),camera=new Camera()
  const s={style:1,preset:"blood",target:"floor",environment:"office",seed:19,roomSeed:7,zoom:1.4,playing:true,loop:true,slowMotion:1,...splatterPresets.blood}
  let game:Game|undefined,model=-1,glass=-1,dt=0,time=0,serial=0,previousLighting={...stage.lighting}
  const impact:SplatterImpact={id:1,seed:19,x:13.5,y:1.05,z:11.5,dx:1,dy:-.1,dz:0}
  const setLevel=(level:LevelData)=>{
    const vertices:number[]=[],windows:number[]=[]
    // The city backdrop lies outside this cropped room; its foreground roofs hide the receiver bay.
    for(const chunk of level.chunks){const p=unpackLevel(chunk.data);for(let i=0;i<p.length;i+=30){
      if([0,10,20].every(j=>p[i+j+2]>=20)||[0,10,20].every(j=>p[i+j+2]<=0)||[0,10,20].every(j=>p[i+j]>=24)||[0,10,20].every(j=>p[i+j]<=0))continue
      for(let j=0;j<30;j++)vertices.push(p[i+j])
    }}
    for(const chunk of level.glass)for(const v of unpackLevel(chunk.data))windows.push(v)
    if(model<0){model=meshes.add(vertices);glass=meshes.add(windows,10,c=>c,.2)}
    else{meshes.replace(model,vertices);meshes.replace(glass,windows)}
  }
  const trigger=()=>{
    if(!game)return
    dt=time=0;game.labClear();impact.id=++serial;impact.seed=s.seed;impact.amount=1
    if(s.target==="wall")Object.assign(impact,{x:12,y:1.05,z:6.7,dx:.18,dy:.08,dz:-1})
    else if(s.target==="grazing")Object.assign(impact,{x:11.3,y:1.05,z:6.1,dx:1,dy:0,dz:-.3})
    else if(s.target==="desk")Object.assign(impact,{x:12,y:1.65,z:9,dx:.2,dy:-1,dz:.05})
    else if(s.target==="glass")Object.assign(impact,{x:8.5,y:1.05,z:9.7,dx:0,dy:0,dz:-1})
    else Object.assign(impact,{x:13.5,y:1.05,z:11.5,dx:1,dy:-.1,dz:.2})
    stage.focus[0]=impact.x;stage.focus[1]=.3;stage.focus[2]=impact.z;camera.snap(impact.x,impact.z)
    game.splatterStyle=0;seeded(s.seed,()=>game!.labBlood(impact))
    game.splatterStyle=1;game.cosmeticSplatter(impact,s)
  }
  const load=()=>{
    const generated=blackoutEnvironment(s.environment,s.roomSeed)
    const map={...generated,floors:[{rect:[0,0,24,20] as const,kind:s.environment==="downtown"?"asphalt" as const:"tile" as const}]}
    if(!game)game=seeded(1,()=>new Game({addModel:m=>meshes.add(m.v,11,c=>[2,3].includes(c)?1.5:0),setLevel,updateBounce:()=>{},width:1000,height:720},{myId:"lab",room:null,latest:()=>null,roster:()=>[],drainEvents:()=>[],send:()=>{},status:()=>null,update:()=>{},close:()=>{}},new Sound(),{...juiceSettings(),volumes:false},map))
    else game.labLoad(map)
    stage.sceneMode=5;stage.lighting.moonPower=s.environment==="downtown"?.08:.32;stage.lighting.exposure=0;stage.lighting.temperature=0
    trigger()
  }
  const advance=(delta:number)=>{time+=delta;dt+=delta;game?.labAdvance(delta)}
  const controls:LabControl[]=[
    {key:"style",label:"Style",group:"Emitter",type:"select",options:[{value:0,label:"Current blood"},{value:1,label:"Surface splatter"}],change:()=>context.sync()},
    {key:"preset",label:"Preset",group:"Emitter",type:"select",options:Object.keys(splatterPresets).map(value=>({value,label:value[0].toUpperCase()+value.slice(1)})),change:()=>{Object.assign(s,splatterPresets[s.preset as keyof typeof splatterPresets]);trigger();context.sync()}},
    {key:"target",label:"Target",group:"Emitter",type:"select",options:[{value:"floor",label:"Floor"},{value:"wall",label:"Wall"},{value:"grazing",label:"Grazing wall"},{value:"desk",label:"Desk top"},{value:"glass",label:"Glass blocker"}],change:trigger},
    {key:"environment",label:"Room",group:"Emitter",type:"select",options:[{value:"office",label:"Pale tile"},{value:"downtown",label:"Dark street"}],change:load},
    {key:"roomSeed",label:"Room seed",group:"Emitter",type:"range",min:1,max:999,step:1,unit:"",change:load},
    {key:"seed",label:"Impact seed",group:"Emitter",type:"range",min:1,max:999,step:1,unit:"",change:trigger},
    {key:"zoom",label:"Zoom",group:"Emitter",type:"range",min:1,max:3,step:.1,unit:"×"},
    {key:"playing",label:"Play",group:"Emitter"},{key:"loop",label:"Loop",group:"Emitter"},{key:"slowMotion",label:"Speed",group:"Emitter",type:"range",min:.05,max:1,step:.05,unit:"×"},
    {key:"trigger",label:"Retrigger",group:"Emitter",type:"action",run:trigger},
    {key:"step",label:"Step frame",group:"Emitter",type:"action",run:()=>{s.playing=false;advance(1/60);context.sync()}},
    {key:"copy",label:"Copy JSON",group:"Emitter",type:"action",run:async()=>navigator.clipboard.writeText(JSON.stringify(s,null,2))},
  ]
  const ranges:Record<keyof typeof splatterPresets.blood,readonly [number,number,number]>={amount:[1,128,1],impulse:[.1,15,.1],spread:[0,2,.05],sizeMin:[.01,.1,.005],sizeMax:[.03,.2,.005],drag:[0,5,.1],gravity:[0,20,.1],r:[0,1,.01],g:[0,1,.01],b:[0,1,.01],opacity:[.1,1,.05],decalSize:[1,8,.1],persistence:[1,60,1],pooling:[0,1,.05],budget:[16,256,16]}
  const labels:Record<string,string>={r:"Red",g:"Green",b:"Blue",sizeMin:"Small drops",sizeMax:"Large drops",decalSize:"Decal size"}
  const primaryKeys=new Set(["amount","impulse","spread","decalSize","opacity","pooling"])
  for(const [key,range] of Object.entries(ranges)){
    const adv=!primaryKeys.has(key)
    controls.push({key,label:labels[key]??key[0].toUpperCase()+key.slice(1),group:adv?"Advanced Splatter":"Splatter",folded:adv,type:"range",min:range[0],max:range[1],step:range[2],enabled:()=>s.style===1,change:trigger})
  }
  const targets:Record<string,{label:string;x:number;y:number;z:number}>={
    floor:{label:"Floor Target",x:13.5,y:0.2,z:11.5},
    wall:{label:"Wall Target",x:12,y:1.05,z:6.7},
    grazing:{label:"Grazing Wall",x:11.3,y:1.05,z:6.1},
    desk:{label:"Desk Top",x:12,y:0.9,z:9},
    glass:{label:"Glass Blocker",x:8.5,y:1.05,z:9.7},
  }
  return{id:"splatter",label:"Splatter",settings:s,controls,
    retrigger:trigger,
    reroll:()=>{s.roomSeed=(s.roomSeed*1664525+1013904223>>>0)%999+1;load();context.sync()},
    frameTarget:()=>({x:impact.x,y:0.4,z:impact.z,dist:13}),
    objects:()=>Object.entries(targets).map(([k,t])=>({id:`target:${k}`,label:t.label,category:"specimen" as const,x:t.x,y:t.y,z:t.z,radius:0.9})),
    selectObject:(id)=>{
      if(!id?.startsWith("target:"))return
      const k=id.slice("target:".length)
      if(k in targets){s.target=k;trigger();context.sync()}
    },
    enter(){previousLighting={...stage.lighting};stage.cameraOverride=(w,h,vp,inverse,eye,focus)=>{eye.set([focus[0]+3/s.zoom,focus[1]+25/s.zoom,focus[2]+12/s.zoom]);mat4.multiply(mat4.perspective(.65,w/h,.1,150),mat4.lookAt(eye,focus,[0,1,0]),vp);mat4.inverse(vp,inverse)};load()},
    leave(){stage.cameraOverride=undefined;Object.assign(stage.lighting,previousLighting)},
    update(delta){if(s.playing){advance(delta*s.slowMotion);if(s.loop&&time>4)trigger()}},
    prepare(){
      if(!game)return
      meshes.instance(model,0,0,0);meshes.instance(glass,0,0,0)
      const frame=seeded(s.seed,()=>game!.build(camera,1000,720,dt));dt=0
      legacy.reset();legacy.batch(frame.alphaSprites,frame.alphaCount,"blackout");legacy.additive();legacy.batch(frame.addSprites,frame.addCount,"blackout");legacy.upload()
      if(game.splatterFx)renderer.prepare(game.splatterFx,stage.viewProj,stage.eye)
      stage.dynamicLights=[{x:12,y:3,z:10,radius:16,r:1,g:.86,b:.65,power:s.environment==="downtown"?.6:3},{x:7,y:3,z:6,radius:10,r:.45,g:.62,b:1,power:s.environment==="downtown"?.3:1.5}]
    },
    draw(pass){if(s.style===0)legacy.draw(pass);else renderer.draw(pass)},
    telemetry:()=>`${s.preset} · ${time.toFixed(2)} s · ${JSON.stringify(game?.splatterFx?.inspect()??{})}`,
  }
}
