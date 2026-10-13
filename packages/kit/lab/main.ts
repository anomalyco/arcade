import { LabPanel, type LabSettings } from "../lab-panel"
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
import { createWorkbench } from "./workbench"
import { hubCommands } from "../dev-hub-model"

export type { LabContext, LabSection, LabWorldObject, MaterialAdapter, PhysicsAdapter, SectionFactory } from "./types"
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
  document.body.innerHTML=`
    <div class="lab-workbench" data-lab-workbench>
      <header class="lab-topbar" aria-label="Workbench toolbar">
        <a class="lab-btn" href="${hubCommands[0].href}" aria-label="Dev Hub">Hub</a>
        <div class="lab-topbar-group">
          <div class="lab-mode-seg" role="group" aria-label="Interaction mode">
            <button type="button" class="lab-btn" data-action="mode-edit" aria-label="Edit mode" aria-pressed="true">Edit</button>
            <button type="button" class="lab-btn" data-action="mode-play" aria-label="Play mode" aria-pressed="false" title="Possess character (P)">Play · P</button>
          </div>
          <div class="lab-divider"></div>
          <span class="lab-topbar-group" data-row="section">
            <span class="lab-field-label">Section</span>
            <select class="lab-select" data-control="section" aria-label="Section"></select>
          </span>
          <div class="lab-divider"></div>
          <span class="lab-field-label">Env</span>
          <select class="lab-select" data-control="environment" aria-label="Scene environment"></select>
          <span class="lab-mono lab-field-label" data-readout="seed">Seed 7</span>
          <button type="button" class="lab-btn" data-action="reroll" aria-label="Reroll room seed" title="Reroll room seed keeping effect locked (R)">Reroll · R</button>
          <button type="button" class="lab-btn" data-action="lock-effect" aria-label="Lock effect seed" aria-pressed="true" title="Keep effect locked while rerolling room">Lock FX</button>
          <button type="button" class="lab-btn" data-action="lock-env" aria-label="Lock environment seed" aria-pressed="false" title="Lock room seed">Lock Env</button>
          <div class="lab-divider"></div>
          <span class="lab-field-label">View</span>
          <select class="lab-select" data-control="debug" aria-label="Debug view"></select>
        </div>
        <div class="lab-topbar-right">
          <button type="button" class="lab-btn" data-action="frame" aria-label="Frame target" title="Frame selected object or emitter (F)">Frame · F</button>
          <div class="lab-divider"></div>
          <button type="button" class="lab-btn" data-action="undo" aria-label="Undo edit" disabled>Undo</button>
          <button type="button" class="lab-btn" data-action="redo" aria-label="Redo edit" disabled>Redo</button>
          <div class="lab-divider"></div>
          <button type="button" class="lab-btn" data-action="export" aria-label="Export preset">Export</button>
          <button type="button" class="lab-btn" data-action="import" aria-label="Import preset">Import</button>
        </div>
      </header>
      <aside class="lab-library" aria-label="Workbench library">
        <div class="lab-library-header">
          <div class="lab-search-wrap">
            <input type="search" class="lab-input" data-control="library-search" aria-label="Search library" placeholder="Search effects, props, audio…" />
            <span class="lab-kbd">⌘K</span>
          </div>
          <div class="lab-cat-tabs" role="tablist" aria-label="Library categories">
            <button type="button" class="lab-btn" data-cat="effects" aria-label="Category Effects" aria-pressed="true">Effects</button>
            <button type="button" class="lab-btn" data-cat="objects" aria-label="Category Objects" aria-pressed="false">Objects</button>
            <button type="button" class="lab-btn" data-cat="lighting" aria-label="Category Lighting" aria-pressed="false">Lighting</button>
            <button type="button" class="lab-btn" data-cat="audio" aria-label="Category Audio" aria-pressed="false">Audio</button>
          </div>
          <div class="lab-filter-pills" role="group" aria-label="Collection filter">
            <button type="button" class="lab-btn" data-collection="all" aria-label="Filter All" aria-pressed="true">All</button>
            <button type="button" class="lab-btn" data-collection="fixtures" aria-label="Filter Fixtures" aria-pressed="false">Fixtures</button>
            <button type="button" class="lab-btn" data-collection="blackout" aria-label="Filter Blackout" aria-pressed="false">Blackout</button>
            <button type="button" class="lab-btn" data-collection="getaway" aria-label="Filter Getaway" aria-pressed="false">Getaway</button>
            <button type="button" class="lab-btn" data-collection="shared" aria-label="Filter Shared" aria-pressed="false">Shared</button>
          </div>
        </div>
        <div class="lab-catalog-list" role="listbox" aria-label="Catalog items"></div>
      </aside>
      <main class="lab-viewport" data-lab-viewport>
        <canvas tabindex="0" aria-label="Lab scene"></canvas>
        <div class="lab-viewport-hud">
          <div class="lab-hud-badge lab-mono" data-hud-badge>Effects · Grenade smoke</div>
          <div class="lab-hud-toast" data-hud-toast hidden role="status" aria-live="polite"></div>
        </div>
      </main>
      <aside class="lab-inspector" aria-label="Selected item inspector">
        <div class="lab-inspector-header">
          <span class="lab-inspector-title">Grenade smoke</span>
          <span class="lab-inspector-sub">Effects</span>
        </div>
        <div class="lab-inspector-body" data-inspector-mount></div>
      </aside>
      <footer class="lab-bottombar" aria-label="Transport and shortcuts">
        <div class="lab-transport">
          <button type="button" class="lab-btn" data-action="transport-play" aria-label="Transport play" aria-pressed="true">Pause</button>
          <button type="button" class="lab-btn" data-action="transport-retrigger" aria-label="Transport retrigger" title="Retrigger with same seed (Space)">Retrigger</button>
          <button type="button" class="lab-btn" data-action="transport-step" aria-label="Transport step" title="Step 1/60s frame">Step</button>
          <button type="button" class="lab-btn" data-action="transport-loop" aria-label="Transport loop" aria-pressed="true">Loop</button>
          <span class="lab-field-label">Speed</span>
          <select class="lab-select" data-control="transport-speed" aria-label="Simulation speed">
            <option value="0.1">0.1×</option>
            <option value="0.25">0.25×</option>
            <option value="0.5">0.5×</option>
            <option value="1" selected>1×</option>
            <option value="2">2×</option>
          </select>
          <span class="lab-mono lab-field-label" data-readout="elapsed">0.00s · f0</span>
        </div>
        <div class="lab-hints">
          <span class="lab-focus-pill" data-focus-pill>Edit · Canvas</span>
          <span data-hint-text>Space Retrigger · F Frame · R Reroll Room · Q/E Cycle · Tab Inspector · ⌘K Search</span>
        </div>
      </footer>
      <div class="lab-modal-backdrop" data-preset-modal hidden>
        <div class="lab-modal" role="dialog" aria-label="Preset JSON">
          <div style="display:flex;align-items:center;justify-content:space-between">
            <strong data-modal-title>Preset JSON</strong>
            <button type="button" class="lab-btn" data-action="modal-close" aria-label="Close preset dialog">Esc</button>
          </div>
          <textarea aria-label="Preset JSON content" spellcheck="false"></textarea>
          <div class="lab-hud-toast" data-preset-error data-error="true" hidden style="position:static"></div>
          <div style="display:flex;justify-content:flex-end;gap:6px">
            <button type="button" class="lab-btn" data-action="modal-copy" aria-label="Copy preset JSON">Copy</button>
            <button type="button" class="lab-btn" data-action="modal-apply" aria-label="Apply preset JSON">Apply Preset</button>
          </div>
        </div>
      </div>
    </div>
  `
  const workbenchRoot=document.querySelector<HTMLElement>("[data-lab-workbench]")!
  const viewportHost=document.querySelector<HTMLElement>("[data-lab-viewport]")!
  const inspectorMount=document.querySelector<HTMLElement>("[data-inspector-mount]")!
  const canvas=viewportHost.querySelector("canvas")!
  const sectionSelect=workbenchRoot.querySelector<HTMLSelectElement>('[data-control="section"]')!
  const debugSelect=workbenchRoot.querySelector<HTMLSelectElement>('[data-control="debug"]')!

  const adapter=await navigator.gpu?.requestAdapter({powerPreference:"high-performance"})
  if(!adapter)throw new Error("WebGPU unavailable")
  const device=await adapter.requestDevice({requiredFeatures:adapter.features.has("timestamp-query")?["timestamp-query"]:[]})
  device.addEventListener("uncapturederror",event=>console.error(event.error.message))
  const gpu=canvas.getContext("webgpu")!,format=navigator.gpu.getPreferredCanvasFormat()
  gpu.configure({device,format,alphaMode:"opaque",usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_DST})
  const stage=new Stage(device,gpu,format,options.camera)
  const particles=new Particles(),volume=new SmokeVolumes(),trail=new SmokeTrail()
  const input=new LabInput(canvas)
  let panel:LabPanel|undefined,active:LabSection,workbench:ReturnType<typeof createWorkbench>|undefined
  const context:LabContext={device,stage,particles,volume,trail,input,sync:()=>{panel?.sync();workbench?.syncChrome()}}
  const spawn=options.spawn?createSpawn(context,options.spawn(context)):undefined
  const effects=createEffects(context),physics=createPhysics(context,spawn?.physics??options.physics?.(context))
  const sections=[effects.section,createLighting(context),createMaterials(context,options.materials??[]),physics.section,...(spawn?[spawn.section]:[]),...(options.sections??[]).map(create=>create(context))]
  const ids=new Set<string>()
  for(const section of sections){if(ids.has(section.id))throw new Error(`Duplicate Lab section: ${section.id}`);ids.add(section.id)}
  for(const s of sections)sectionSelect.add(new Option(s.label,s.id))
  const settings={section:"effects",debug:0}
  const allDebugOptions=[
    {value:0,label:"Shaded"},{value:1,label:"Density"},{value:2,label:"Overdraw / optical depth"},
    {value:3,label:"Lighting only"},{value:4,label:"Volume bounds"},{value:5,label:"Normals"},
  ]
  function syncDebugOptions(id:string){
    const allowed=id==="effects"?allDebugOptions:allDebugOptions.filter(o=>[0,3,5].includes(o.value))
    if(!allowed.some(o=>o.value===settings.debug))settings.debug=0
    debugSelect.replaceChildren()
    for(const opt of allowed)debugSelect.add(new Option(opt.label,String(opt.value)))
    debugSelect.value=String(settings.debug)
  }
  function select(id:string) {
    const next=sections.find(s=>s.id===id)
    if(!next)throw new Error(`Unknown Lab section: ${id}`)
    active?.leave?.()
    input.enabled=false;input.release();stage.dynamicLights=null
    stage.resetCamera()
    if(id!=="spawn"&&id!=="physics")stage.focus.fill(0)
    particles.reset();volume.reset();trail.reset()
    active=next;settings.section=id
    sectionSelect.value=id
    syncDebugOptions(id)
    stage.sceneMode=id==="spawn"||id==="physics"&&spawn?3:id==="lighting"?1:id==="materials"?2:0
    panel?.clearControls();panel?.addControls(active.settings,active.controls)
    active.enter?.()
    workbench?.onSectionChanged()
  }
  panel=new LabPanel(settings,[],new URLSearchParams(),()=>input.release(),{
    open:true,
    presets:false,
    shortcut:true,
    capture:"focus",
    layout:"inspector",
    onTransaction:(label,before)=>workbench?.onPanelTransaction(label,before as LabSettings),
    onFocusChange:focused=>workbench?.onPanelFocusChange(focused),
    onToggle:visible=>{
      workbench?.onPanelToggle(visible)
      void render()
    },
  })
  inspectorMount.append(panel.host)

  const formatHeaderTelemetry=(raw:string)=>{
    const idx=raw.indexOf("{")
    if(idx<0)return raw
    const prefix=raw.slice(0,idx).trim()
    try{
      const obj=JSON.parse(raw.slice(idx)) as Record<string,unknown>
      const parts=Object.entries(obj)
        .filter(([,v])=>typeof v==="number"||typeof v==="string")
        .filter(([k,v])=>Number(v)>0||["particles","sheets","holes","tyre","decals","time"].includes(k))
        .slice(0,4)
        .map(([k,v])=>`${v} ${k}`)
      return `${prefix}${parts.length?`\n${parts.join(" · ")}`:""}`
    }catch{
      return prefix||raw
    }
  }
  const render=async(measure=false)=>{
    const width=Math.max(1,Math.round(viewportHost.clientWidth||innerWidth))
    const height=Math.max(1,Math.round(viewportHost.clientHeight||innerHeight))
    if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height}
    stage.resize(width,height)
    stage.updateCamera();stage.meshes.reset();stage.transients.reset()
    active.prepare?.()
    const ms=await stage.render(particles,volume,trail,settings.debug,measure,active.draw)
    panel!.header.textContent=`${formatHeaderTelemetry(active.telemetry?.()??active.label)}\nGPU ${stage.gpuMs?.toFixed(2)??"—"} ms${stage.gpuMs===null?" (unavailable)":""}`
    return ms
  }
  const advance=(dt:number)=>{
    const step=Math.max(0,Math.min(dt,1/15))*(workbench?.speed??1)
    active.update?.(step)
    workbench?.onTick(dt)
  }

  workbench=createWorkbench({
    root:workbenchRoot,
    canvas,
    ViewportHost:viewportHost,
    panel,
    context,
    sections,
    globalSettings:settings,
    selectSection:select,
    renderNow:()=>render(false),
    advanceSim:dt=>active.update?.(Math.max(0,Math.min(dt,1/15))),
    spawn,
  })

  select("effects")
  const bench=new URLSearchParams(location.search).has("bench")
  if(!bench){
    // Frame the initial smoke room at a readable scale for interactive workbench sessions.
    stage.frameTarget(-1,0.5,0,15)
  }
  const api={
    adapter:adapter.info,
    context,
    sections,
    settings,
    select,
    render,
    advance,
    attachPhysics:physics.attach,
    spawn:spawn?{inspect:spawn.inspect}:undefined,
    workbench:{
      undo:()=>workbench!.undo(),
      redo:()=>workbench!.redo(),
      exportPreset:()=>workbench!.exportPresetJson(),
      importPreset:(json:string)=>workbench!.applyPresetJson(json),
      setMode:(m:"edit"|"play")=>workbench!.setPlayMode(m),
      getMode:()=>workbench!.mode,
      frame:()=>workbench!.frameActiveTarget(),
    },
  }
  let last=0
  const tick=async(now:number)=>{
    const dt=last?Math.max(0,Math.min(0.033,(now-last)/1000)):0;last=now
    if(!bench&&!document.hidden){advance(dt);await render()}
    requestAnimationFrame(tick)
  }
  await render()
  if(bench)Object.assign(window,{lab:api,fx:{adapter:adapter.info,...effects,particles,volume,trail,stage,render,debug:(n:number)=>{settings.debug=n;syncDebugOptions(settings.section);panel!.sync()}}})
  requestAnimationFrame(tick)
  return api
}
