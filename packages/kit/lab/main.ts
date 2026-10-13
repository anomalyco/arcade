import { LabPanel, type LabControl } from "../lab-panel"
import { Particles } from "../fx/particles"
import { SmokeTrail } from "../fx/smoke-trail"
import { SmokeVolumes } from "../fx/volume"
import { Stage, type CameraWriter } from "./stage"
import { createEffects } from "./effects"
import { createLighting } from "./lighting"
import { createMaterials } from "./materials"
import { createPhysics } from "./physics"
import type { LabContext, LabSection, MaterialAdapter, PhysicsAdapter, SectionFactory } from "./types"
import "./style.css"
import { LabInput } from "./input"
import { createSpawn } from "./spawn"
import type { SpawnFactory } from "./spawn-types"

export type { LabContext, LabSection, MaterialAdapter, PhysicsAdapter, SectionFactory } from "./types"
export type { SpawnFactory, SpawnAdapters, CharacterSpawnable, LabCharacter, ItemWorld, SpawnPoint } from "./spawn-types"

export type LabOptions = {
  camera:CameraWriter
  materials?:readonly MaterialAdapter[]
  physics?:(context:LabContext)=>PhysicsAdapter
  sections?:readonly SectionFactory[]
  spawn?:SpawnFactory
}
export async function lab(options:LabOptions) {
  document.title="Lab"
  document.body.innerHTML='<canvas tabindex="0" aria-label="Lab scene"></canvas>'
  const canvas=document.querySelector("canvas")!
  const adapter=await navigator.gpu?.requestAdapter({powerPreference:"high-performance"})
  if(!adapter)throw new Error("WebGPU unavailable")
  const device=await adapter.requestDevice({requiredFeatures:adapter.features.has("timestamp-query")?["timestamp-query"]:[]})
  device.addEventListener("uncapturederror",event=>console.error(event.error.message))
  const gpu=canvas.getContext("webgpu")!,format=navigator.gpu.getPreferredCanvasFormat()
  gpu.configure({device,format,alphaMode:"opaque",usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_DST})
  const stage=new Stage(device,gpu,format,options.camera)
  const particles=new Particles(),volume=new SmokeVolumes(),trail=new SmokeTrail()
  const input=new LabInput(canvas)
  let panel:LabPanel|undefined,active:LabSection
  const context:LabContext={device,stage,particles,volume,trail,input,sync:()=>panel?.sync()}
  const spawn=options.spawn?createSpawn(context,options.spawn(context)):undefined
  const effects=createEffects(context),physics=createPhysics(context,spawn?.physics??options.physics?.(context))
  const sections=[effects.section,createLighting(context),createMaterials(context,options.materials??[]),physics.section,...(spawn?[spawn.section]:[]),...(options.sections??[]).map(create=>create(context))]
  const ids=new Set<string>()
  for(const section of sections){if(ids.has(section.id))throw new Error(`Duplicate Lab section: ${section.id}`);ids.add(section.id)}
  const settings={section:"effects",debug:0}
  const debugOptions=[
    {value:0,label:"Shaded"},{value:1,label:"Density"},{value:2,label:"Overdraw / optical depth"},
    {value:3,label:"Lighting only"},{value:4,label:"Volume bounds"},{value:5,label:"Normals"},
  ]
  const debugControl={key:"debug",label:"Debug view",type:"select",options:debugOptions} satisfies LabControl
  const controls:LabControl[]=[
    {key:"section",label:"Section",type:"select",options:sections.map(s=>({value:s.id,label:s.label})),change:value=>select(String(value))},
    debugControl,
  ]
  function select(id:string) {
    const next=sections.find(s=>s.id===id)
    if(!next)throw new Error(`Unknown Lab section: ${id}`)
    active?.leave?.()
    input.enabled=false;input.release();stage.dynamicLights=null
    if(id!=="spawn"&&id!=="physics")stage.focus.fill(0)
    particles.reset();volume.reset();trail.reset()
    active=next;settings.section=id
    debugControl.options=id==="effects"?debugOptions:debugOptions.filter(o=>[0,3,5].includes(o.value))
    if(!debugControl.options.some(o=>o.value===settings.debug))settings.debug=0
    stage.sceneMode=id==="spawn"||id==="physics"&&spawn?3:id==="lighting"?1:id==="materials"?2:0
    panel?.clearControls();panel?.addControls(settings,controls);panel?.addControls(active.settings,active.controls)
    active.enter?.()
  }
  panel=new LabPanel(settings,[],new URLSearchParams(),()=>input.release(), {open:true,presets:false,shortcut:true})
  select("effects")
  const render=async(measure=false)=>{
    const width=Math.max(1,innerWidth),height=Math.max(1,innerHeight)
    if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height}
    stage.resize(width,height)
    stage.updateCamera();stage.meshes.reset();stage.transients.reset()
    active.prepare?.()
    const ms=await stage.render(particles,volume,trail,settings.debug,measure,active.draw)
    panel!.header.textContent=`${active.telemetry?.()??active.label}\nGPU ${stage.gpuMs?.toFixed(2)??"—"} ms${stage.gpuMs===null?" (unavailable)":""}`
    return ms
  }
  const advance=(dt:number)=>active.update?.(Math.max(0,Math.min(dt,1/15)))
  const api={adapter:adapter.info,context,sections,settings,select,render,advance,attachPhysics:physics.attach,spawn:spawn?{inspect:spawn.inspect}:undefined}
  // Deterministic drivers are available only in automation mode. All interactive settings live in LabPanel.
  const bench=new URLSearchParams(location.search).has("bench")
  let last=0
  const tick=async(now:number)=>{
    const dt=last?Math.max(0,Math.min(0.033,(now-last)/1000)):0;last=now
    if(!bench&&!document.hidden){advance(dt);await render()}
    requestAnimationFrame(tick)
  }
  await render()
  if(bench)Object.assign(window,{lab:api,fx:{adapter:adapter.info,...effects,particles,volume,trail,stage,render,debug:(n:number)=>{settings.debug=n;panel!.sync()}}})
  requestAnimationFrame(tick)
  return api
}
