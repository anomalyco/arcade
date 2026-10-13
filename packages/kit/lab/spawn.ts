import type { LabContext, LabSection, LabWorldObject } from "./types"
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

export type SpawnGhostState = {
  category: "prop" | "light" | "effect"
  kind: string
  x: number
  y: number
  z: number
  yaw: number
  shape: "one" | "row" | "grid"
  valid: boolean
}

export type SpawnSceneSnapshot = {
  characterId: string | null
  characterAt: SpawnPoint | null
  props: readonly { kind: string; x: number; y: number; z: number; yaw: number }[]
  lights: readonly { id: string; kind: string; at: SpawnPoint; light: LabLight }[]
}

export function createSpawn(context:LabContext,adapters:SpawnAdapters){
  const {stage,input,particles,volume,trail}=context,{items}=adapters,meshes=stage.meshes
  const settings:Record<string,any>={
    character:adapters.characters[0]?.id??"",
    item:items.items[0]?.id??"",
    where:"front",
    distance:6,
    count:5,
    spacing:2,
    effect:"sparks",
    light:"lamp",
    selectedX:0,
    selectedZ:0,
    selectedYaw:0,
    selectedPower:2,
    selectedRadius:10,
  }
  const ramp=meshes.add(rampVertices()),pole=meshes.add(column(3,.055)),bulb=meshes.add(column(.18,.13,2.5))
  let character:LabCharacter|undefined,characterId:string|null=null,seed=7,time=0,nextLightId=1,nextEmitterId=1
  let selectedId:string|null=null
  let ghost:SpawnGhostState|null=null
  const dropped:{id:string;kind:string;at:SpawnPoint;light:LabLight}[]=[]
  const sources:{uid:string;id:string;at:SpawnPoint;life:number;acc:number}[]=[]
  const random=()=>{seed=Math.imul(seed,1664525)+1013904223|0;return(seed>>>0)/4294967296}
  const origin=():SpawnPoint=>({x:0,y:0,z:8,yaw:Math.PI})
  const isValidYardPoint=(x:number,z:number)=>x>-16.6&&x<16.6&&z>-26.6&&z<11.6

  function syncSelectedFields(){
    if(!selectedId)return
    const obj=listObjects().find(o=>o.id===selectedId)
    if(!obj){selectedId=null;section.selectedObjectId=undefined;return}
    settings.selectedX=Number(obj.x.toFixed(2))
    settings.selectedZ=Number(obj.z.toFixed(2))
    settings.selectedYaw=Math.round(((obj.yaw??0)*180)/Math.PI)
    const d=dropped.find(l=>l.id===selectedId)
    if(d){settings.selectedPower=Number(d.light.power.toFixed(2));settings.selectedRadius=Number(d.light.radius.toFixed(1))}
  }

  function spawnCharacterAt(choiceId=String(settings.character),at:SpawnPoint=origin()){
    character?.leave?.()
    const choice=adapters.characters.find(c=>c.id===choiceId)
    character=choice?.create(context,{...at,y:yardGround(at.x,at.z)})
    characterId=character?choiceId:null
    input.release()
    if(new URLSearchParams(location.search).has("bench"))input.enabled=true
    if(character){
      const p=character.point
      stage.focus.splice(0,3,p.x,p.y,p.z)
      selectObject("character:active")
    }
    context.sync()
  }

  function spawnCharacter(){
    spawnCharacterAt(String(settings.character),origin())
  }

  const target=():SpawnPoint=>{
    const p=character?.point??origin(),d=settings.where==="front"?Number(settings.distance):0
    const x=p.x+Math.sin(p.yaw)*d,z=p.z+Math.cos(p.yaw)*d
    return {x,y:yardGround(x,z),z,yaw:p.yaw}
  }

  function batchPoints(base:SpawnPoint,shape:"one"|"row"|"grid"):SpawnPoint[]{
    const n=shape==="one"?1:Math.round(Number(settings.count)),rows=shape==="grid"?n:1,pts:SpawnPoint[]=[]
    for(let r=0;r<rows;r++)for(let i=0;i<n;i++){
      const along=(shape==="row"?i:r)*Number(settings.spacing),side=shape==="grid"?(i-(n-1)/2)*Number(settings.spacing):0
      const x=base.x+Math.sin(base.yaw)*along+Math.cos(base.yaw)*side,z=base.z+Math.cos(base.yaw)*along-Math.sin(base.yaw)*side
      pts.push({x,y:yardGround(x,z),z,yaw:base.yaw})
    }
    return pts
  }

  function spawnItems(shape:"one"|"row"|"grid",at:SpawnPoint=target()){
    let lastId:string|undefined
    for(const pt of batchPoints(at,shape)){
      const res=items.spawn(String(settings.item),pt)
      if(typeof res==="string")lastId=res
    }
    if(lastId)selectObject(lastId)
    context.sync()
  }

  function emit(id:string,p:SpawnPoint,n:number){
    const spec=effectSpecs[id==="explosion"?"fire":id]??effectSpecs.sparks
    for(let i=0;i<n;i++){
      const a=random()*Math.PI*2,speed=2+random()*6
      particles.spawn(spec,p.x,p.y+.5,p.z,Math.cos(a)*speed*(id==="water"?.2:1),id==="water"?10:2+random()*5,Math.sin(a)*speed*(id==="water"?.2:1),a)
    }
  }

  function effectAt(at:SpawnPoint=target(),id=String(settings.effect)){
    if(id==="smoke"||id==="explosion")volume.spawn(at.x,at.z,id==="smoke"?5.5:3.5,id==="smoke"?9:4,1,id==="explosion"?.45:0)
    if(id==="tyre")for(let i=0;i<18;i++)trail.spawn(at.x+(random()-.5)*1.2,at.y+.3,at.z+(random()-.5)*1.2,0,0)
    else if(["fire","water","nitro"].includes(id)){
      if(sources.length<16){
        const uid=`emitter:${nextEmitterId++}`
        sources.push({uid,id,at:{...at},life:6,acc:0})
        selectObject(uid)
      }
    }
    else if(id!=="smoke")emit(id,at,75)
    context.sync()
  }

  function lightAt(at:SpawnPoint=target(),kind=String(settings.light)){
    if(dropped.length>=4)return null
    const spot=kind==="spotlight",id=`light:${nextLightId++}`
    dropped.push({id,kind,at:{...at},light:{x:at.x,y:at.y+(kind==="torch"?1.2:3),z:at.z,radius:spot?16:10,r:1.8,g:kind==="torch"?.45:1,b:.2,power:spot?5:2,
      dx:Math.sin(at.yaw)*.8,dy:-.6,dz:Math.cos(at.yaw)*.8,cone:spot?.8:-2}})
    selectObject(id)
    context.sync()
    return id
  }

  function clear(){
    items.clear();dropped.length=sources.length=0;particles.reset();trail.reset();volume.reset(yardWalls)
    if(selectedId&&selectedId!=="character:active")selectObject(character?"character:active":null)
    context.sync()
  }

  function listObjects():LabWorldObject[]{
    const out:LabWorldObject[]=[]
    if(character&&characterId){
      const label=adapters.characters.find(c=>c.id===characterId)?.label??"Character"
      out.push({id:"character:active",label,category:"character",x:character.point.x,y:character.point.y,z:character.point.z,yaw:character.point.yaw,radius:1.4,movable:true,deletable:false})
    }
    for(const p of items.entries?.()??[]){
      out.push({id:p.id,label:p.label,category:"prop",x:p.x,y:p.y,z:p.z,yaw:p.yaw,radius:p.radius,movable:true,deletable:true})
    }
    for(const d of dropped){
      const name=d.kind[0]!.toUpperCase()+d.kind.slice(1)
      out.push({id:d.id,label:`${name} (${d.id.split(":")[1]})`,category:"light",x:d.at.x,y:d.at.y,z:d.at.z,yaw:d.at.yaw,radius:0.85,movable:true,deletable:true})
    }
    for(const s of sources){
      out.push({id:s.uid,label:`${s.id} emitter`,category:"emitter",x:s.at.x,y:s.at.y,z:s.at.z,yaw:s.at.yaw,radius:0.8,movable:true,deletable:true})
    }
    return out
  }

  function selectObject(id:string|null){
    selectedId=id
    section.selectedObjectId=id??undefined
    syncSelectedFields()
    context.sync()
  }

  function moveObject(id:string,x:number,z:number,yaw?:number):boolean{
    if(!isValidYardPoint(x,z))return false
    const gy=yardGround(x,z)
    if(id==="character:active"&&character&&characterId){
      const nextYaw=yaw??character.point.yaw
      spawnCharacterAt(characterId,{x,y:gy,z,yaw:nextYaw})
      return true
    }
    if(id.startsWith("prop:")){
      const existing=items.entries?.().find(e=>e.id===id)
      const ok=items.move?.(id,{x,y:gy,z,yaw:yaw??existing?.yaw??0})??false
      if(ok){syncSelectedFields();context.sync()}
      return ok
    }
    const d=dropped.find(l=>l.id===id)
    if(d){
      const nextYaw=yaw??d.at.yaw
      d.at={x,y:gy,z,yaw:nextYaw}
      d.light.x=x;d.light.y=gy+(d.kind==="torch"?1.2:3);d.light.z=z
      d.light.dx=Math.sin(nextYaw)*.8;d.light.dz=Math.cos(nextYaw)*.8
      syncSelectedFields();context.sync()
      return true
    }
    const s=sources.find(e=>e.uid===id)
    if(s){
      s.at={x,y:gy,z,yaw:yaw??s.at.yaw}
      syncSelectedFields();context.sync()
      return true
    }
    return false
  }

  function deleteObject(id:string):boolean{
    if(id.startsWith("prop:")){
      const ok=items.remove?.(id)??false
      if(ok){if(selectedId===id)selectObject(null);context.sync()}
      return ok
    }
    const li=dropped.findIndex(l=>l.id===id)
    if(li>=0){dropped.splice(li,1);if(selectedId===id)selectObject(null);context.sync();return true}
    const si=sources.findIndex(s=>s.uid===id)
    if(si>=0){sources.splice(si,1);if(selectedId===id)selectObject(null);context.sync();return true}
    return false
  }

  function duplicateObject(id:string):string|null{
    const obj=listObjects().find(o=>o.id===id)
    if(!obj)return null
    const nx=Math.max(-16,Math.min(16,obj.x+1.5)),nz=Math.max(-26,Math.min(11,obj.z+1.2)),ny=yardGround(nx,nz),nyaw=obj.yaw??0
    if(id.startsWith("prop:")){
      const entry=items.entries?.().find(e=>e.id===id)
      if(!entry)return null
      const newId=items.spawn(entry.kind,{x:nx,y:ny,z:nz,yaw:nyaw})
      if(typeof newId==="string"){selectObject(newId);context.sync();return newId}
    }
    const d=dropped.find(l=>l.id===id)
    if(d)return lightAt({x:nx,y:ny,z:nz,yaw:nyaw},d.kind)
    return null
  }

  function prepare(){
    meshes.instance(ramp,0,0,0)
    items.prepare();character?.prepare()
    for(const d of dropped){const y=d.at.y,height=d.kind==="torch"?.4:1;meshes.instance(pole,d.at.x,y,d.at.z,0,0,0,height);meshes.instance(bulb,d.at.x,y+3*height,d.at.z);if(d.kind==="torch")d.light.power=2+.3*Math.sin(time*17)}
    if(ghost){
      const pts=ghost.category==="prop"?batchPoints({x:ghost.x,y:ghost.y,z:ghost.z,yaw:ghost.yaw},ghost.shape):[{x:ghost.x,y:ghost.y,z:ghost.z,yaw:ghost.yaw}]
      for(const pt of pts){
        if(ghost.category==="prop")items.drawGhost?.(ghost.kind,pt)
        else if(ghost.category==="light"){
          const h=ghost.kind==="torch"?.4:1
          meshes.instance(pole,pt.x,pt.y,pt.z,0,0,0,h,[0.45,0.95,0.8])
          meshes.instance(bulb,pt.x,pt.y+3*h,pt.z,0,0,0,1,[0.45,0.95,0.8])
        }
      }
    }
    const base:LabLight={x:-6,y:5,z:-8,radius:28,r:.55,g:.7,b:1,power:1.2}
    stage.dynamicLights=[...items.lights,...(character?.lights()??[]),...dropped.map(d=>d.light),base].slice(0,8)
  }

  const snapshot=():SpawnSceneSnapshot=>({
    characterId,
    characterAt:character?{...character.point}:null,
    props:items.snapshot?.()??[],
    lights:dropped.map(d=>({id:d.id,kind:d.kind,at:{...d.at},light:{...d.light}})),
  })

  const restore=(snap:SpawnSceneSnapshot)=>{
    items.restore?.(snap.props)
    dropped.length=0
    for(const l of snap.lights)dropped.push({id:l.id,kind:l.kind,at:{...l.at},light:{...l.light}})
    if(snap.characterId&&snap.characterAt)spawnCharacterAt(snap.characterId,snap.characterAt)
    else{character?.leave?.();character=undefined;characterId=null}
    context.sync()
  }

  const inspect=()=>({character:character?.inspect()??null,items:items.inspect(),lights:dropped.length,effects:sources.length,particles:particles.count})
  const section:LabSection={id:"spawn",label:"Spawn",settings,controls:[
    {key:"character",label:"Character",group:"Character",type:"select",options:adapters.characters.map(c=>({value:c.id,label:c.label}))},
    {key:"spawnCharacter",label:"Spawn character",group:"Character",type:"action",run:spawnCharacter},
    {key:"where",label:"At",group:"Character",type:"select",options:[{value:"front",label:"In front"},{value:"character",label:"Character"}]},
    {key:"distance",label:"Distance",group:"Character",type:"range",min:0,max:24,step:1,unit:"m"},
    {key:"selectedX",label:"Position X",group:"Selected Object",type:"range",min:-16,max:16,step:0.25,unit:"m",visible:()=>selectedId!==null,change:v=>{const o=listObjects().find(x=>x.id===selectedId);if(o)moveObject(o.id,Number(v),o.z,o.yaw)}},
    {key:"selectedZ",label:"Position Z",group:"Selected Object",type:"range",min:-26,max:11,step:0.25,unit:"m",visible:()=>selectedId!==null,change:v=>{const o=listObjects().find(x=>x.id===selectedId);if(o)moveObject(o.id,o.x,Number(v),o.yaw)}},
    {key:"selectedYaw",label:"Yaw",group:"Selected Object",type:"range",min:-180,max:180,step:5,unit:"°",visible:()=>selectedId!==null,change:v=>{const o=listObjects().find(x=>x.id===selectedId);if(o)moveObject(o.id,o.x,o.z,Number(v)*Math.PI/180)}},
    {key:"selectedPower",label:"Light power",group:"Selected Object",type:"range",min:0.2,max:10,step:0.2,visible:()=>Boolean(selectedId?.startsWith("light:")),change:v=>{const d=dropped.find(l=>l.id===selectedId);if(d)d.light.power=Number(v)}},
    {key:"selectedRadius",label:"Light radius",group:"Selected Object",type:"range",min:2,max:28,step:0.5,unit:"m",visible:()=>Boolean(selectedId?.startsWith("light:")),change:v=>{const d=dropped.find(l=>l.id===selectedId);if(d)d.light.radius=Number(v)}},
    {key:"duplicateSelected",label:"Duplicate selected",group:"Selected Object",type:"action",visible:()=>Boolean(selectedId&&selectedId!=="character:active"),run:()=>{if(selectedId)duplicateObject(selectedId)}},
    {key:"deleteSelected",label:"Delete selected",group:"Selected Object",type:"action",visible:()=>Boolean(selectedId&&selectedId!=="character:active"),run:()=>{if(selectedId)deleteObject(selectedId)}},
    {key:"item",label:"Item",type:"select",group:"Items",options:items.items.map(i=>({value:i.id,label:i.label}))},
    {key:"spawnItem",label:"Spawn item",group:"Items",type:"action",run:()=>spawnItems("one")},
    {key:"count",label:"Count",group:"Items",type:"range",min:1,max:8,step:1},
    {key:"spacing",label:"Spacing",group:"Items",type:"range",min:1,max:5,step:.5,unit:"m"},
    {key:"row",label:"Row",group:"Items",type:"action",run:()=>spawnItems("row")},{key:"grid",label:"Grid",group:"Items",type:"action",run:()=>spawnItems("grid")},
    {key:"clear",label:"Clear all",group:"Items",type:"action",run:clear},
    {key:"effect",label:"Effect",type:"select",group:"Effects",options:effectOptions},
    {key:"trigger",label:"Trigger effect",group:"Effects",type:"action",run:()=>effectAt()},
    {key:"light",label:"Light",type:"select",group:"Lights",options:[{value:"lamp",label:"Lamp"},{value:"spotlight",label:"Spotlight"},{value:"torch",label:"Torch"}]},
    {key:"dropLight",label:"Drop light",group:"Lights",type:"action",run:()=>{lightAt()}},
  ],
  enter(){
    input.enabled=new URLSearchParams(location.search).has("bench")
    volume.reset(yardWalls)
  },
  leave(){input.enabled=false;input.release();ghost=null},
  retrigger:()=>effectAt(),
  reroll:()=>{seed=(seed*1664525+1013904223>>>0)%9999+1;stage.lighting.moonAzimuth=-45+((seed%7)-3)*18;context.sync()},
  frameTarget:()=>{
    const sel=selectedId?listObjects().find(o=>o.id===selectedId):null
    if(sel)return{x:sel.x,y:sel.y,z:sel.z,dist:16}
    if(character)return{x:character.point.x,y:character.point.y,z:character.point.z,dist:18}
    return{x:0,y:0,z:4,dist:20}
  },
  objects:listObjects,
  selectObject,
  moveObject,
  deleteObject,
  duplicateObject,
  groundHeight:yardGround,
  update(dt){
    time+=dt;character?.update(dt,input);items.update(dt)
    particles.update(dt,yardWalls,yardGround);volume.update(dt)
    if(!character?.updatesTrail)trail.update(dt)
    for(let i=sources.length-1;i>=0;i--){const s=sources[i]!;s.life-=dt;s.acc+=dt*75;const n=Math.floor(s.acc);s.acc-=n;emit(s.id,s.at,n);if(s.life<=0){if(selectedId===s.uid)selectedId=null;sources.splice(i,1)}}
    if(character&&(input.enabled||!stage.camCustom)){const p=character.point,k=1-Math.exp(-dt*7);stage.focus[0]+=(p.x-stage.focus[0])*k;stage.focus[1]+=(p.y-stage.focus[1])*k;stage.focus[2]+=(p.z-stage.focus[2])*k}
    if(selectedId==="character:active"||selectedId?.startsWith("prop:"))syncSelectedFields()
  },prepare,telemetry:()=>`${[...items.bodies].filter(b=>b.enabled).length} bodies · ${dropped.length}/4 placed lights`}
  const physics={...items,get bodies(){return items.bodies},update(dt:number){
    // Coasting and emissions continue while the Physics section runs; input is disabled there.
    character?.update(dt,input);items.update(dt);particles.update(dt,yardWalls,yardGround);volume.update(dt)
    if(!character?.updatesTrail)trail.update(dt)
  },prepare,inspect}
  return {
    section,
    physics,
    inspect,
    adapters,
    hasCharacter:()=>Boolean(character),
    characterLabel:()=>adapters.characters.find(c=>c.id===characterId)?.label??null,
    spawnCharacterAt,
    spawnItems,
    effectAt,
    lightAt,
    clear,
    snapshot,
    restore,
    getGhost:()=>ghost,
    setGhost:(next:SpawnGhostState|null)=>{ghost=next},
    commitGhost:(shapeOverride?:"one"|"row"|"grid")=>{
      if(!ghost||!ghost.valid)return false
      const at={x:ghost.x,y:ghost.y,z:ghost.z,yaw:ghost.yaw}
      if(ghost.category==="prop"){settings.item=ghost.kind;spawnItems(shapeOverride??ghost.shape,at)}
      else if(ghost.category==="light"){settings.light=ghost.kind;lightAt(at,ghost.kind)}
      else if(ghost.category==="effect"){settings.effect=ghost.kind;effectAt(at,ghost.kind)}
      return true
    },
    isValidYardPoint,
  }
}
