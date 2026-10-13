import type { LabContext, LabSection } from "./types"
import type { LabCharacter, SpawnAdapters, SpawnPoint } from "./spawn-types"
import type { LabLight } from "./stage"
import { effectOptions, effectSpecs } from "./effects"
import { rampVertices, yardGround, yardWalls } from "./yard"

function column(height:number,radius:number,emission=0){
  const v:number[]=[],corners=[[-radius,0,-radius],[radius,0,-radius],[-radius,height,-radius],[radius,height,-radius],[-radius,0,radius],[radius,0,radius],[-radius,height,radius],[radius,height,radius]]
  for(const [a,b,c,d] of [[0,2,3,1],[4,5,7,6],[0,4,6,2],[1,3,7,5],[2,6,7,3],[0,1,5,4]]){
    const p=corners[a],q=corners[b],r=corners[c],u=q.map((x,i)=>x-p[i]),w=r.map((x,i)=>x-p[i]),n=[u[1]*w[2]-u[2]*w[1],u[2]*w[0]-u[0]*w[2],u[0]*w[1]-u[1]*w[0]],len=Math.hypot(...n)
    for(const i of [a,b,c,a,c,d])v.push(...corners[i],...n.map(x=>x/len),emission?1:.15,emission?.65:.18,emission?.2:.2,emission)
  }
  return v
}

export function createSpawn(context:LabContext,adapters:SpawnAdapters){
  const {stage,input,particles,volume,trail}=context,{items}=adapters,meshes=stage.meshes
  const settings={character:adapters.characters[0]?.id??"",item:items.items[0]?.id??"",where:"front",distance:6,count:5,spacing:2,effect:"sparks",light:"lamp"}
  const ramp=meshes.add(rampVertices()),pole=meshes.add(column(3,.055)),bulb=meshes.add(column(.18,.13,2.5))
  let character:LabCharacter|undefined,seed=7,time=0
  const dropped:{kind:string;at:SpawnPoint;light:LabLight}[]=[],sources:{id:string;at:SpawnPoint;life:number;acc:number}[]=[]
  const random=()=>{seed=Math.imul(seed,1664525)+1013904223|0;return(seed>>>0)/4294967296}
  const origin=():SpawnPoint=>({x:0,y:0,z:8,yaw:Math.PI})
  function spawnCharacter(){
    character?.leave?.();const choice=adapters.characters.find(c=>c.id===settings.character)
    character=choice?.create(context,origin());input.release()
    if(character){const p=character.point;stage.focus.splice(0,3,p.x,p.y,p.z)}
  }
  const target=()=>{
    const p=character?.point??origin(),d=settings.where==="front"?settings.distance:0
    const x=p.x+Math.sin(p.yaw)*d,z=p.z+Math.cos(p.yaw)*d
    return {x,y:yardGround(x,z),z,yaw:p.yaw}
  }
  function spawnItems(shape:"one"|"row"|"grid"){
    const p=target(),n=shape==="one"?1:Math.round(settings.count),rows=shape==="grid"?n:1
    for(let r=0;r<rows;r++)for(let i=0;i<n;i++){
      const along=(shape==="row"?i:r)*settings.spacing,side=shape==="grid"?(i-(n-1)/2)*settings.spacing:0
      const x=p.x+Math.sin(p.yaw)*along+Math.cos(p.yaw)*side,z=p.z+Math.cos(p.yaw)*along-Math.sin(p.yaw)*side
      items.spawn(settings.item,{x,y:yardGround(x,z),z,yaw:p.yaw})
    }
  }
  function emit(id:string,p:SpawnPoint,n:number){
    const spec=effectSpecs[id==="explosion"?"fire":id]??effectSpecs.sparks
    for(let i=0;i<n;i++){
      const a=random()*Math.PI*2,speed=2+random()*6
      particles.spawn(spec,p.x,p.y+.5,p.z,Math.cos(a)*speed*(id==="water"?.2:1),id==="water"?10:2+random()*5,Math.sin(a)*speed*(id==="water"?.2:1),a)
    }
  }
  function effect(){
    const at=target(),id=settings.effect
    if(id==="smoke"||id==="explosion")volume.spawn(at.x,at.z,id==="smoke"?5.5:3.5,id==="smoke"?9:4,1,id==="explosion"?.45:0)
    if(id==="tyre")for(let i=0;i<18;i++)trail.spawn(at.x+(random()-.5)*1.2,at.y+.3,at.z+(random()-.5)*1.2,0,0)
    else if(["fire","water","nitro"].includes(id)){if(sources.length<16)sources.push({id,at,life:3,acc:0})}
    else if(id!=="smoke")emit(id,at,75)
  }
  function light(){
    if(dropped.length===4)return
    const at=target(),kind=settings.light,spot=kind==="spotlight"
    dropped.push({kind,at,light:{x:at.x,y:at.y+(kind==="torch"?1.2:3),z:at.z,radius:spot?16:10,r:1.8,g:kind==="torch"?.45:1,b:.2,power:spot?5:2,
      dx:Math.sin(at.yaw)*.8,dy:-.6,dz:Math.cos(at.yaw)*.8,cone:spot?.8:-2}})
  }
  function clear(){items.clear();dropped.length=sources.length=0;particles.reset();trail.reset();volume.reset(yardWalls)}
  function prepare(){
    meshes.instance(ramp,0,0,0)
    items.prepare();character?.prepare()
    for(const d of dropped){const y=d.at.y,height=d.kind==="torch"?.4:1;meshes.instance(pole,d.at.x,y,d.at.z,0,0,0,height);meshes.instance(bulb,d.at.x,y+3*height,d.at.z);if(d.kind==="torch")d.light.power=2+.3*Math.sin(time*17)}
    const base:LabLight={x:-6,y:5,z:-8,radius:28,r:.55,g:.7,b:1,power:1.2}
    stage.dynamicLights=[...items.lights,...(character?.lights()??[]),...dropped.map(d=>d.light),base].slice(0,8)
  }
  const inspect=()=>({character:character?.inspect()??null,items:items.inspect(),lights:dropped.length,effects:sources.length,particles:particles.count})
  const section:LabSection={id:"spawn",label:"Spawn",settings,controls:[
    {key:"character",label:"Character",type:"select",options:adapters.characters.map(c=>({value:c.id,label:c.label}))},
    {key:"spawnCharacter",label:"Spawn character",type:"action",run:spawnCharacter},
    {key:"where",label:"At",type:"select",options:[{value:"front",label:"In front"},{value:"character",label:"Character"}]},
    {key:"distance",label:"Distance",type:"range",min:0,max:24,step:1},
    {key:"item",label:"Item",type:"select",group:"Items",options:items.items.map(i=>({value:i.id,label:i.label}))},
    {key:"spawnItem",label:"Spawn item",type:"action",run:()=>spawnItems("one")},
    {key:"count",label:"Count",type:"range",min:1,max:8},
    {key:"spacing",label:"Spacing",type:"range",min:1,max:5,step:.5},
    {key:"row",label:"Row",type:"action",run:()=>spawnItems("row")},{key:"grid",label:"Grid",type:"action",run:()=>spawnItems("grid")},
    {key:"clear",label:"Clear all",type:"action",run:clear},
    {key:"effect",label:"Effect",type:"select",group:"Effects",options:effectOptions},
    {key:"trigger",label:"Trigger effect",type:"action",run:effect},
    {key:"light",label:"Light",type:"select",group:"Lights",options:[{value:"lamp",label:"Lamp"},{value:"spotlight",label:"Spotlight"},{value:"torch",label:"Torch"}]},
    {key:"dropLight",label:"Drop light",type:"action",run:light},
  ],enter(){input.enabled=true;volume.reset(yardWalls)},leave(){input.enabled=false;input.release()},update(dt){
    time+=dt;character?.update(dt,input);items.update(dt)
    particles.update(dt,yardWalls,yardGround);volume.update(dt)
    if(!character?.updatesTrail)trail.update(dt)
    for(let i=sources.length-1;i>=0;i--){const s=sources[i];s.life-=dt;s.acc+=dt*75;const n=Math.floor(s.acc);s.acc-=n;emit(s.id,s.at,n);if(s.life<=0)sources.splice(i,1)}
    if(character){const p=character.point,k=1-Math.exp(-dt*7);stage.focus[0]+=(p.x-stage.focus[0])*k;stage.focus[1]+=(p.y-stage.focus[1])*k;stage.focus[2]+=(p.z-stage.focus[2])*k}
  },prepare,telemetry:()=>`${[...items.bodies].filter(b=>b.enabled).length} bodies · ${dropped.length}/4 placed lights`}
  const physics={...items,get bodies(){return items.bodies},update(dt:number){
    // Coasting and emissions continue while the Physics section runs; input is disabled there.
    character?.update(dt,input);items.update(dt);particles.update(dt,yardWalls,yardGround);volume.update(dt)
    if(!character?.updatesTrail)trail.update(dt)
  },prepare,inspect}
  return {section,physics,inspect}
}
