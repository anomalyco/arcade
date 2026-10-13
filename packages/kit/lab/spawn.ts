import type { LabContext, LabSection, LabWorldObject } from "./types"
import type { LabCharacter, SpawnAdapters, SpawnPoint } from "./spawn-types"
import type { LabLight } from "./stage"
import { effectOptions, effectSpecs } from "./effects"
import { rampVertices, yardGlassVertices, yardGround, yardWalls } from "./yard"
import { vehicleEffectSettings } from "../vehicle/effect-settings"

function column(height:number,radius:number,emission=0){
  const v:number[]=[],corners=[[-radius,0,-radius],[radius,0,-radius],[-radius,height,-radius],[radius,height,-radius],[-radius,0,radius],[radius,0,radius],[-radius,height,radius],[radius,height,radius]]
  for(const [a,b,c,d] of [[0,2,3,1],[4,5,7,6],[0,4,6,2],[1,3,7,5],[2,6,7,3],[0,1,5,4]]){
    const p=corners[a]!,q=corners[b]!,r=corners[c]!,u=q.map((x,i)=>x-p[i]!),w=r.map((x,i)=>x-p[i]!),n=[u[1]!*w[2]!-u[2]!*w[1]!,u[2]!*w[0]!-u[0]!*w[2]!,u[0]!*w[1]!-u[1]!*w[0]!],len=Math.hypot(...n)
    for(const i of [a,b,c,a,c,d])v.push(...corners[i]!,...n.map(x=>x/len),emission?1:.15,emission?.65:.18,emission?.2:.2,emission)
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
  environment: string
  seed: number
  characterId: string | null
  characterAt: SpawnPoint | null
  props: readonly { kind: string; x: number; y: number; z: number; yaw: number }[]
  lights: readonly { id: string; kind: string; at: SpawnPoint; light: LabLight }[]
}

export function createSpawn(context:LabContext,adapters:SpawnAdapters){
  const {stage,input,particles,volume,trail}=context,{items}=adapters,meshes=stage.meshes
  const envOptions=items.environments??[{value:"yard",label:"Proving Yard"}]
  const settings:Record<string,any>={
    environment:envOptions[0]!.value,
    seed:7,
    lockEffect:true,
    lockEnvironment:false,
    playing:true,
    character:adapters.characters[0]?.id??"",
    item:items.items[0]?.id??"",
    where:"front",
    distance:6,
    count:5,
    spacing:2,
    effect:"sparks",
    light:"lamp",
    skidsEnabled:true,
    smokeEnabled:true,
    selectedX:0,
    selectedZ:0,
    selectedYaw:0,
    selectedPower:2,
    selectedRadius:10,
  }
  Object.defineProperty(settings,"skidWidth",{
    enumerable:true,
    get:()=>vehicleEffectSettings.skids.width,
    set:(v:number)=>{vehicleEffectSettings.skids.width=Math.max(0.02,Number(v))},
  })
  Object.defineProperty(settings,"skidLife",{
    enumerable:true,
    get:()=>vehicleEffectSettings.skids.life,
    set:(v:number)=>{vehicleEffectSettings.skids.life=Math.max(0.5,Number(v))},
  })

  const ramp=meshes.add(rampVertices())
  const yardGlass=meshes.add(yardGlassVertices(),10,c=>c,0.22)
  const pole=meshes.add(column(3,.055))
  const bulb=meshes.add(column(.18,.13,2.5))

  let character:LabCharacter|undefined
  let characterId:string|null=null
  let authoredCharacterSpawn:SpawnPoint={x:0,y:0,z:8,yaw:Math.PI}
  let activeWalls:readonly (readonly [number,number,number,number])[]=yardWalls
  let activeGround:(x:number,z:number)=>number=yardGround
  let seed=7,time=0,nextLightId=1,nextEmitterId=1
  let selectedId:string|null=null
  let selectedIds:string[]=[]
  let ghost:SpawnGhostState|null=null
  const dropped:{id:string;kind:string;at:SpawnPoint;light:LabLight}[]=[]
  const sources:{uid:string;id:string;at:SpawnPoint;life:number;acc:number}[]=[]
  const random=()=>{seed=Math.imul(seed,1664525)+1013904223|0;return(seed>>>0)/4294967296}
  const origin=():SpawnPoint=>({...authoredCharacterSpawn})
  const isValidYardPoint=(x:number,z:number)=>x>-34.5&&x<34.5&&z>-40.5&&z<32.5

  function selectedObjects():LabWorldObject[]{
    const all=listObjects()
    const valid=selectedIds.map(id=>all.find(o=>o.id===id)).filter((o):o is LabWorldObject=>Boolean(o))
    if(valid.length!==selectedIds.length){
      selectedIds=valid.map(o=>o.id)
      selectedId=selectedIds.at(-1)??null
      section.selectedObjectId=selectedId??undefined
      section.selectedObjectIds=selectedIds
    }
    return valid
  }

  function syncSelectedFields(){
    const sel=selectedObjects()
    if(!sel.length){selectedId=null;section.selectedObjectId=undefined;section.selectedObjectIds=[];return}
    let sx=0,sz=0
    for(const o of sel){sx+=o.x;sz+=o.z}
    const cx=sx/sel.length,cz=sz/sel.length
    const primary=sel.at(-1)!
    settings.selectedX=Number(cx.toFixed(2))
    settings.selectedZ=Number(cz.toFixed(2))
    settings.selectedYaw=Math.round(((primary.yaw??0)*180)/Math.PI)
    const selLights=dropped.filter(l=>selectedIds.includes(l.id))
    if(selLights.length){
      const avgPower=selLights.reduce((a,l)=>a+l.light.power,0)/selLights.length
      const avgRadius=selLights.reduce((a,l)=>a+l.light.radius,0)/selLights.length
      settings.selectedPower=Number(avgPower.toFixed(2))
      settings.selectedRadius=Number(avgRadius.toFixed(1))
    }
  }

  function applyEnvironment(){
    const kind=String(settings.environment||"yard")
    const envSeed=Math.max(1,Math.round(Number(settings.seed)||7))
    const info=items.setEnvironment?.(kind,envSeed)??{
      kind:"yard",
      seed:envSeed,
      spawn:{x:0,y:0,z:8,yaw:Math.PI},
      walls:yardWalls,
      ground:yardGround,
      lights:[],
    }
    activeWalls=info.walls
    activeGround=info.ground
    authoredCharacterSpawn={...info.spawn,y:activeGround(info.spawn.x,info.spawn.z)}
    stage.sceneMode=kind==="yard"?3:4
    particles.reset()
    trail.reset()
    trail.seedWind(envSeed)
    volume.reset(activeWalls)
    items.clearSkids?.()
    if(character){
      if(character.setPoint){
        character.setPoint(authoredCharacterSpawn)
      }else if(characterId){
        spawnCharacterAt(characterId,authoredCharacterSpawn)
      }
      const p=character.point
      stage.focus.splice(0,3,p.x,p.y,p.z)
      syncSelectedFields()
    }
    context.sync()
  }

  function spawnCharacterAt(choiceId=String(settings.character),at:SpawnPoint=origin()){
    character?.leave?.()
    const spawnAt={...at,y:activeGround(at.x,at.z)}
    authoredCharacterSpawn={...spawnAt}
    const choice=adapters.characters.find(c=>c.id===choiceId)
    character=choice?.create(context,spawnAt)
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

  function resetScene(){
    items.reset()
    particles.reset()
    trail.reset()
    trail.seedWind(Math.max(1,Math.round(Number(settings.seed)||7)))
    volume.reset(activeWalls)
    if(character){
      if(character.setPoint)character.setPoint(authoredCharacterSpawn)
      else if(characterId)spawnCharacterAt(characterId,authoredCharacterSpawn)
      const p=character.point
      stage.focus.splice(0,3,p.x,p.y,p.z)
    }
    syncSelectedFields()
    context.sync()
  }

  const target=():SpawnPoint=>{
    const p=character?.point??origin(),d=settings.where==="front"?Number(settings.distance):0
    const x=p.x+Math.sin(p.yaw)*d,z=p.z+Math.cos(p.yaw)*d
    return {x,y:activeGround(x,z),z,yaw:p.yaw}
  }

  function batchPoints(base:SpawnPoint,shape:"one"|"row"|"grid"):SpawnPoint[]{
    const n=shape==="one"?1:Math.round(Number(settings.count)),rows=shape==="grid"?n:1,pts:SpawnPoint[]=[]
    for(let r=0;r<rows;r++)for(let i=0;i<n;i++){
      const along=(shape==="row"?i:r)*Number(settings.spacing),side=shape==="grid"?(i-(n-1)/2)*Number(settings.spacing):0
      const x=base.x+Math.sin(base.yaw)*along+Math.cos(base.yaw)*side,z=base.z+Math.cos(base.yaw)*along-Math.sin(base.yaw)*side
      pts.push({x,y:activeGround(x,z),z,yaw:base.yaw})
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
    const spec=effectSpecs[id==="explosion"?"fire":id]??effectSpecs.sparks!
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
    items.clear();dropped.length=sources.length=0;particles.reset();trail.reset();volume.reset(activeWalls)
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
    selectedIds=id?[id]:[]
    selectedId=id
    section.selectedObjectId=id??undefined
    section.selectedObjectIds=selectedIds
    syncSelectedFields()
    context.sync()
  }

  function selectObjects(ids:readonly string[]){
    const allIds=new Set(listObjects().map(o=>o.id))
    selectedIds=ids.filter((id,idx)=>allIds.has(id)&&ids.indexOf(id)===idx)
    selectedId=selectedIds.at(-1)??null
    section.selectedObjectId=selectedId??undefined
    section.selectedObjectIds=selectedIds
    syncSelectedFields()
    context.sync()
  }

  function moveObjectSilent(id:string,x:number,z:number,yaw?:number):boolean{
    if(!isValidYardPoint(x,z))return false
    const gy=activeGround(x,z)
    if(id==="character:active"&&character&&characterId){
      const nextYaw=yaw??character.point.yaw
      const nextAt={x,y:gy,z,yaw:nextYaw}
      authoredCharacterSpawn={...nextAt}
      if(character.setPoint)character.setPoint(nextAt)
      else spawnCharacterAt(characterId,nextAt)
      return true
    }
    if(id.startsWith("prop:")){
      const existing=items.entries?.().find(e=>e.id===id)
      return items.move?.(id,{x,y:gy,z,yaw:yaw??existing?.yaw??0})??false
    }
    const d=dropped.find(l=>l.id===id)
    if(d){
      const nextYaw=yaw??d.at.yaw
      d.at={x,y:gy,z,yaw:nextYaw}
      d.light.x=x;d.light.y=gy+(d.kind==="torch"?1.2:3);d.light.z=z
      d.light.dx=Math.sin(nextYaw)*.8;d.light.dz=Math.cos(nextYaw)*.8
      return true
    }
    const s=sources.find(e=>e.uid===id)
    if(s){
      s.at={x,y:gy,z,yaw:yaw??s.at.yaw}
      return true
    }
    return false
  }

  function moveObject(id:string,x:number,z:number,yaw?:number):boolean{
    const ok=moveObjectSilent(id,x,z,yaw)
    if(ok){syncSelectedFields();context.sync()}
    return ok
  }

  function deleteObjectSilent(id:string):boolean{
    if(id.startsWith("prop:")){
      return items.remove?.(id)??false
    }
    const li=dropped.findIndex(l=>l.id===id)
    if(li>=0){dropped.splice(li,1);return true}
    const si=sources.findIndex(s=>s.uid===id)
    if(si>=0){sources.splice(si,1);return true}
    return false
  }

  function deleteObject(id:string):boolean{
    const ok=deleteObjectSilent(id)
    if(ok){
      selectedIds=selectedIds.filter(x=>x!==id)
      selectedId=selectedIds.at(-1)??null
      section.selectedObjectId=selectedId??undefined
      section.selectedObjectIds=selectedIds
      syncSelectedFields()
      context.sync()
    }
    return ok
  }

  function deleteObjects(ids:readonly string[]=selectedIds):number{
    const targets=[...ids]
    let count=0
    for(const id of targets){
      if(deleteObjectSilent(id))count++
    }
    if(count>0){
      selectedIds=selectedIds.filter(x=>!targets.includes(x))
      selectedId=selectedIds.at(-1)??null
      section.selectedObjectId=selectedId??undefined
      section.selectedObjectIds=selectedIds
      syncSelectedFields()
      context.sync()
    }
    return count
  }

  function duplicateObjectSilent(id:string):string|null{
    const obj=listObjects().find(o=>o.id===id)
    if(!obj)return null
    const nx=Math.max(-32,Math.min(32,obj.x+1.5)),nz=Math.max(-38,Math.min(30,obj.z+1.2)),ny=activeGround(nx,nz),nyaw=obj.yaw??0
    if(id.startsWith("prop:")){
      const entry=items.entries?.().find(e=>e.id===id)
      if(!entry)return null
      const newId=items.spawn(entry.kind,{x:nx,y:ny,z:nz,yaw:nyaw})
      return typeof newId==="string"?newId:null
    }
    const d=dropped.find(l=>l.id===id)
    if(d){
      if(dropped.length>=4)return null
      const spot=d.kind==="spotlight",newId=`light:${nextLightId++}`
      dropped.push({id:newId,kind:d.kind,at:{x:nx,y:ny,z:nz,yaw:nyaw},light:{...d.light,x:nx,y:ny+(d.kind==="torch"?1.2:3),z:nz,dx:Math.sin(nyaw)*.8,dy:-.6,dz:Math.cos(nyaw)*.8,cone:spot?.8:-2}})
      return newId
    }
    return null
  }

  function duplicateObject(id:string):string|null{
    const newId=duplicateObjectSilent(id)
    if(newId){selectObject(newId);return newId}
    return null
  }

  function duplicateObjects(ids:readonly string[]=selectedIds):string[]{
    const targets=[...ids]
    const created:string[]=[]
    for(const id of targets){
      const newId=duplicateObjectSilent(id)
      if(newId)created.push(newId)
    }
    if(created.length>0){
      selectObjects(created)
    }
    return created
  }

  function prepare(){
    if(settings.environment==="yard"){
      meshes.instance(ramp,0,0,0)
      meshes.instance(yardGlass,0,0,0)
    }
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
    const yardFill:LabLight[]=settings.environment==="yard"?[
      {x:-6,y:6.5,z:-8,radius:34,r:.62,g:.74,b:1,power:1.35},
      {x:-18,y:6.5,z:10,radius:28,r:1,g:.82,b:.58,power:1.2},
      {x:14,y:6.5,z:-6,radius:28,r:.75,g:.85,b:1,power:1.1},
    ]:[{x:-6,y:5,z:-8,radius:28,r:.55,g:.7,b:1,power:1.2}]
    stage.dynamicLights=[...(character?.lights()??[]),...dropped.map(d=>d.light),...items.lights,...yardFill].slice(0,8)
  }

  const snapshot=():SpawnSceneSnapshot=>({
    environment:String(settings.environment),
    seed:Number(settings.seed),
    characterId,
    characterAt:character?{...character.point}:null,
    props:items.snapshot?.()??[],
    lights:dropped.map(d=>({id:d.id,kind:d.kind,at:{...d.at},light:{...d.light}})),
  })

  const restore=(snap:SpawnSceneSnapshot)=>{
    if(snap.environment&&snap.environment!==settings.environment){
      settings.environment=snap.environment
      settings.seed=snap.seed??settings.seed
      applyEnvironment()
    }
    items.restore?.(snap.props)
    dropped.length=0
    for(const l of snap.lights)dropped.push({id:l.id,kind:l.kind,at:{...l.at},light:{...l.light}})
    if(snap.characterId&&snap.characterAt)spawnCharacterAt(snap.characterId,snap.characterAt)
    else{character?.leave?.();character=undefined;characterId=null}
    context.sync()
  }

  const inspect=()=>{
    const sk=items.skidStats?.()
    return {
      environment:settings.environment,
      seed:settings.seed,
      character:character?.inspect()??null,
      items:items.inspect(),
      lights:dropped.length,
      effects:sources.length,
      particles:particles.count,
      skids:sk?.skids??0,
      skidBudget:sk?.budget??1600,
      tyreSmoke:sk?.tyreSmoke??trail.count,
    }
  }

  const section:LabSection={id:"spawn",label:"Spawn",settings,controls:[
    {key:"character",label:"Character",group:"Character",type:"select",options:adapters.characters.map(c=>({value:c.id,label:c.label}))},
    {key:"spawnCharacter",label:"Spawn character",group:"Character",type:"action",run:spawnCharacter},
    {key:"where",label:"At",group:"Character",type:"select",options:[{value:"front",label:"In front"},{value:"character",label:"Character"}]},
    {key:"distance",label:"Distance",group:"Character",type:"range",min:0,max:24,step:1,unit:"m"},
    {key:"skidsEnabled",label:"Skid marks",group:"Vehicle & Skids",change:v=>items.setSkidsEnabled?.(Boolean(v))},
    {key:"skidWidth",label:"Skid width",group:"Vehicle & Skids",type:"range",min:0.04,max:0.45,step:0.01,unit:"m"},
    {key:"skidLife",label:"Skid life",group:"Vehicle & Skids",type:"range",min:1,max:30,step:0.5,unit:"s"},
    {key:"smokeEnabled",label:"Tyre smoke",group:"Vehicle & Skids",change:v=>items.setSmokeEnabled?.(Boolean(v))},
    {key:"clearSkids",label:"Clear skids",group:"Vehicle & Skids",type:"action",run:()=>{items.clearSkids?.();context.sync()}},
    {key:"resetScene",label:"Reset scene",group:"Vehicle & Skids",type:"action",run:resetScene},
    {key:"selectedX",label:"Position X",group:"Selected Object",type:"range",min:-34,max:34,step:0.25,unit:"m",visible:()=>selectedIds.length>0,change:v=>{
      const sel=selectedObjects().filter(o=>o.movable)
      if(!sel.length)return
      const cx=sel.reduce((a,o)=>a+o.x,0)/sel.length
      const dx=Number(v)-cx
      for(const o of sel)moveObjectSilent(o.id,o.x+dx,o.z,o.yaw)
      syncSelectedFields();context.sync()
    }},
    {key:"selectedZ",label:"Position Z",group:"Selected Object",type:"range",min:-40,max:32,step:0.25,unit:"m",visible:()=>selectedIds.length>0,change:v=>{
      const sel=selectedObjects().filter(o=>o.movable)
      if(!sel.length)return
      const cz=sel.reduce((a,o)=>a+o.z,0)/sel.length
      const dz=Number(v)-cz
      for(const o of sel)moveObjectSilent(o.id,o.x,o.z+dz,o.yaw)
      syncSelectedFields();context.sync()
    }},
    {key:"selectedYaw",label:"Yaw",group:"Selected Object",type:"range",min:-180,max:180,step:5,unit:"°",visible:()=>selectedIds.length>0,change:v=>{
      const sel=selectedObjects().filter(o=>o.movable)
      if(!sel.length)return
      const primary=sel.at(-1)!
      const nextRad=(Number(v)*Math.PI)/180
      const dyaw=nextRad-(primary.yaw??0)
      for(const o of sel)moveObjectSilent(o.id,o.x,o.z,(o.yaw??0)+dyaw)
      syncSelectedFields();context.sync()
    }},
    {key:"selectedPower",label:"Light power",group:"Selected Object",type:"range",min:0.2,max:10,step:0.2,visible:()=>selectedIds.some(id=>id.startsWith("light:")),change:v=>{
      for(const d of dropped)if(selectedIds.includes(d.id))d.light.power=Number(v)
    }},
    {key:"selectedRadius",label:"Light radius",group:"Selected Object",type:"range",min:2,max:28,step:0.5,unit:"m",visible:()=>selectedIds.some(id=>id.startsWith("light:")),change:v=>{
      for(const d of dropped)if(selectedIds.includes(d.id))d.light.radius=Number(v)
    }},
    {key:"duplicateSelected",label:"Duplicate selected",group:"Selected Object",type:"action",visible:()=>selectedIds.some(id=>id!=="character:active"),run:()=>{
      const n=selectedIds.filter(id=>id!=="character:active").length
      const label=n>1?`Duplicate ${n} objects`:"Duplicate object"
      if(context.transact)context.transact(label,()=>{duplicateObjects()})
      else duplicateObjects()
    }},
    {key:"deleteSelected",label:"Delete selected",group:"Selected Object",type:"action",visible:()=>selectedIds.some(id=>id!=="character:active"),run:()=>{
      const n=selectedIds.filter(id=>id!=="character:active").length
      const label=n>1?`Delete ${n} objects`:"Delete object"
      if(context.transact)context.transact(label,()=>{deleteObjects()})
      else deleteObjects()
    }},
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
    {key:"environment",label:"Environment",group:"Environment",type:"select",options:envOptions,change:applyEnvironment},
    {key:"seed",label:"Room seed",group:"Environment",type:"range",min:1,max:9999,step:1,unit:"",change:applyEnvironment},
    {key:"lockEffect",label:"Lock effect",group:"Environment"},
    {key:"lockEnvironment",label:"Lock environment",group:"Environment"},
  ],
  enter(){
    input.enabled=new URLSearchParams(location.search).has("bench")
    stage.sceneMode=settings.environment==="yard"?3:4
    if(!volume.count)volume.reset(activeWalls)
  },
  leave(){input.enabled=false;input.release();ghost=null},
  retrigger:()=>effectAt(),
  reroll:()=>{
    if(!settings.lockEnvironment){
      settings.seed=((Number(settings.seed)*1664525+1013904223)>>>0)%9999+1
      applyEnvironment()
    }
    seed=(seed*1664525+1013904223>>>0)%9999+1
    stage.lighting.moonAzimuth=-45+((seed%7)-3)*18
    context.sync()
  },
  frameTarget:()=>{
    const sel=selectedId?listObjects().find(o=>o.id===selectedId):null
    if(sel)return{x:sel.x,y:sel.y,z:sel.z,dist:16}
    if(character)return{x:character.point.x,y:character.point.y,z:character.point.z,dist:18}
    return{x:0,y:0,z:4,dist:22}
  },
  objects:listObjects,
  selectedObjectId:undefined,
  selectedObjectIds:[],
  selectObject,
  selectObjects,
  moveObject,
  deleteObject,
  deleteObjects,
  duplicateObject,
  duplicateObjects,
  groundHeight:(x,z)=>activeGround(x,z),
  update(dt){
    if(!settings.playing)return
    time+=dt;character?.update(dt,input);items.update(dt)
    particles.update(dt,activeWalls,activeGround);volume.update(dt)
    if(!character?.updatesTrail)trail.update(dt)
    for(let i=sources.length-1;i>=0;i--){const s=sources[i]!;s.life-=dt;s.acc+=dt*75;const n=Math.floor(s.acc);s.acc-=n;emit(s.id,s.at,n);if(s.life<=0){if(selectedId===s.uid)selectedId=null;sources.splice(i,1)}}
    if(character&&(input.enabled||!stage.camCustom)){const p=character.point,k=1-Math.exp(-dt*7);stage.focus[0]+=(p.x-stage.focus[0])*k;stage.focus[1]+=(p.y-stage.focus[1])*k;stage.focus[2]+=(p.z-stage.focus[2])*k}
    if(selectedId==="character:active"||selectedId?.startsWith("prop:"))syncSelectedFields()
  },
  prepare,
  draw:pass=>items.draw?.(pass),
  telemetry:()=>{
    const sk=items.skidStats?.()
    return `${[...items.bodies].filter(b=>b.enabled).length} bodies · ${sk?.skids??0}/${sk?.budget??1600} skids · ${dropped.length}/4 placed lights`
  }}

  const physics={...items,get bodies(){return items.bodies},update(dt:number){
    // Coasting and emissions continue while the Physics section runs; input is disabled there.
    character?.update(dt,input);items.update(dt);particles.update(dt,activeWalls,activeGround);volume.update(dt)
    if(!character?.updatesTrail)trail.update(dt)
  },prepare,draw:(pass:GPURenderPassEncoder)=>items.draw?.(pass),inspect}

  return {
    section,
    physics,
    inspect,
    adapters,
    hasCharacter:()=>Boolean(character),
    hasActiveScene:()=>Boolean(character)||([...items.bodies].some(b=>b.enabled))||dropped.length>0||((items.skidStats?.().skids??0)>0),
    characterLabel:()=>adapters.characters.find(c=>c.id===characterId)?.label??null,
    spawnCharacterAt,
    spawnItems,
    effectAt,
    lightAt,
    clear,
    resetScene,
    applyEnvironment,
    activeWalls:()=>activeWalls,
    activeGround:(x:number,z:number)=>activeGround(x,z),
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
