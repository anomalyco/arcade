import { LabPanel, type LabSettings } from "../lab-panel"
import { Particles } from "../fx/particles"
import { SmokeTrail } from "../fx/smoke-trail"
import { SmokeVolumes } from "../fx/volume"
import { Stage, type CameraWriter } from "./stage"
import { createEffects } from "./effects"
import { createFoliage } from "./foliage"
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
  const game=location.pathname.match(/\/arcade\/([^/]+)\//)?.[1]??""
  document.body.innerHTML=`
    <div class="lab-workbench" data-lab-workbench>
      <header class="lab-topbar" aria-label="Workbench toolbar">
        <a class="lab-btn lab-hub" href="${hubCommands[0].href}" aria-label="Dev Hub" title="Dev Hub">Hub</a>
        <span class="lab-brand"><b>Lab</b><span data-readout="game">${game?game[0]!.toUpperCase()+game.slice(1):""}</span></span>
        <div class="lab-mode-seg" role="group" aria-label="Interaction mode">
          <button type="button" class="lab-btn" data-action="mode-edit" aria-label="Edit mode" aria-pressed="true">Edit</button>
          <button type="button" class="lab-btn" data-action="mode-play" aria-label="Play mode" aria-pressed="false" title="Possess character (P)">Play</button>
        </div>
        <div class="lab-divider"></div>
        <div class="lab-transport" role="group" aria-label="Transport">
          <button type="button" class="lab-btn lab-icon-btn" data-action="transport-retrigger" aria-label="Transport retrigger" title="Retrigger with same seed (Space)">⟲</button>
          <button type="button" class="lab-btn lab-icon-btn" data-action="transport-play" aria-label="Transport play" aria-pressed="true" title="Pause / play (K)">❚❚</button>
          <button type="button" class="lab-btn lab-icon-btn" data-action="transport-step" aria-label="Transport step" title="Step 1/60 s frame (.)">⏭</button>
          <button type="button" class="lab-btn lab-icon-btn" data-action="transport-loop" aria-label="Transport loop" aria-pressed="true" title="Loop">↻</button>
          <select class="lab-select lab-speed" data-control="transport-speed" aria-label="Simulation speed">
            <option value="0.1">0.1×</option>
            <option value="0.25">0.25×</option>
            <option value="0.5">0.5×</option>
            <option value="1" selected>1×</option>
            <option value="2">2×</option>
          </select>
          <span class="lab-mono lab-clock" data-readout="elapsed">0.00s · f0</span>
        </div>
        <div class="lab-topbar-right">
          <select class="lab-select lab-view" data-control="debug" aria-label="Debug view" title="Debug view"></select>
          <button type="button" class="lab-search-btn" data-action="palette" aria-label="Search everything" title="Search scene, library, commands and settings (⌘K)">
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><circle cx="7" cy="7" r="4.2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M10.2 10.2 13.5 13.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
            <span>Search</span><kbd>⌘K</kbd>
          </button>
          <button type="button" class="lab-btn lab-icon-btn" data-action="frame" aria-label="Frame target" title="Frame selected object or emitter (F)">⌖</button>
          <button type="button" class="lab-btn lab-icon-btn" data-action="undo" aria-label="Undo edit" disabled>↶</button>
          <button type="button" class="lab-btn lab-icon-btn" data-action="redo" aria-label="Redo edit" disabled>↷</button>
          <div class="lab-more">
            <button type="button" class="lab-btn lab-icon-btn" data-action="more" aria-label="More actions" aria-haspopup="menu" aria-expanded="false" title="Recipe, export, import">⋯</button>
            <div class="lab-menu" data-more-menu role="menu" hidden>
              <button type="button" class="lab-menu-item" role="menuitem" data-action="export" aria-label="Export preset">Export preset JSON</button>
              <button type="button" class="lab-menu-item" role="menuitem" data-action="import" aria-label="Import preset">Import preset JSON</button>
            </div>
          </div>
        </div>
      </header>
      <aside class="lab-outliner" aria-label="Outliner">
        <div class="lab-outliner-tree" data-outliner-mount></div>
        <div class="lab-world" aria-label="World">
          <div class="lab-panel-head lab-world-head"><span class="lab-panel-title">World</span></div>
          <label class="lab-world-row" data-row="section"><span class="lab-field-label">Section</span><select class="lab-select" data-control="section" aria-label="Section"></select></label>
          <label class="lab-world-row"><span class="lab-field-label">Env</span><select class="lab-select" data-control="environment" aria-label="Scene environment"></select></label>
          <div class="lab-world-row">
            <span class="lab-mono lab-field-label" data-readout="seed">Seed 7</span>
            <span class="lab-fill"></span>
            <button type="button" class="lab-btn" data-action="reroll" aria-label="Reroll room seed" title="Reroll room seed keeping effect locked (R)">Reroll</button>
            <button type="button" class="lab-btn" data-action="lock-effect" aria-label="Lock effect seed" aria-pressed="true" title="Keep effect locked while rerolling room">Lock FX</button>
            <button type="button" class="lab-btn" data-action="lock-env" aria-label="Lock environment seed" aria-pressed="false" title="Lock room seed">Lock Env</button>
          </div>
        </div>
      </aside>
      <main class="lab-viewport" data-lab-viewport>
        <canvas tabindex="0" aria-label="Lab scene"></canvas>
        <div class="lab-viewport-hud">
          <div class="lab-hud-badge lab-mono" data-hud-badge>Effects · Grenade smoke</div>
          <div class="lab-hud-toast" data-hud-toast hidden role="status" aria-live="polite"></div>
        </div>
      </main>
      <section class="lab-library" aria-label="Library" data-library-mount></section>
      <aside class="lab-inspector" aria-label="Details">
        <div class="lab-panel-head"><span class="lab-panel-title">Details</span><span class="lab-fill"></span><span class="lab-inspector-sub">Effects</span></div>
        <div class="lab-details-head">
          <span class="lab-details-icon" data-details-icon aria-hidden="true">✺</span>
          <div class="lab-details-names"><span class="lab-inspector-title">Grenade smoke</span><span class="lab-details-meta" data-details-meta></span></div>
        </div>
        <div class="lab-details-actions" data-details-actions></div>
        <div class="lab-details-tools">
          <label class="lab-search"><svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><circle cx="7" cy="7" r="4.2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M10.2 10.2 13.5 13.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg><input type="search" data-control="details-search" aria-label="Search details" placeholder="Search details" /></label>
          <button type="button" class="lab-chip" data-action="details-modified" aria-pressed="false" title="Show only settings that differ from their defaults">Modified<span class="lab-chip-n" data-modified-count></span></button>
          <button type="button" class="lab-chip" data-action="details-all" aria-pressed="false" title="Show section settings unrelated to the selection" hidden>All</button>
        </div>
        <div class="lab-inspector-body" data-inspector-mount></div>
      </aside>
      <footer class="lab-bottombar" aria-label="Status and shortcuts">
        <span class="lab-focus-pill" data-focus-pill>Edit · Canvas</span>
        <span class="lab-mono lab-stats" data-readout="stats"></span>
        <span class="lab-fill"></span>
        <span class="lab-hints" data-hint-text>2F/RMB Orbit · ⇧Pan · Pinch/Wheel Zoom · RMB Tap Radial · Space Retrigger · F Frame · R Reroll · ⌘K Search</span>
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
  let spawn:ReturnType<typeof createSpawn>|undefined
  const isPlaygroundSection=(id:string)=>id==="spawn"||id==="effects"||id==="lighting"||id==="physics"
  const context:LabContext={
    device,
    stage,
    particles,
    volume,
    trail,
    input,
    sync:()=>{panel?.sync();workbench?.syncChrome()},
    transact:(label,run)=>{
      const before=workbench?.captureSnapshot()
      run()
      if(before)workbench?.recordHistory(label,before)
      panel?.sync()
      workbench?.syncChrome()
    },
    activeWalls:()=>spawn?.activeWalls()??[],
    activeGround:(x,z)=>spawn?spawn.activeGround(x,z):0,
    hasPlaygroundScene:()=>Boolean(spawn?.hasActiveScene()),
  }
  spawn=options.spawn?createSpawn(context,options.spawn(context)):undefined
  const effects=createEffects(context),physics=createPhysics(context,spawn?.physics??options.physics?.(context))
  const sections=[effects.section,createLighting(context),createMaterials(context,options.materials??[]),createFoliage(context),physics.section,...(spawn?[spawn.section]:[]),...(options.sections??[]).map(create=>create(context))]
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
    const keepPlayground=Boolean(spawn?.hasActiveScene()&&active&&isPlaygroundSection(active.id)&&isPlaygroundSection(id))
    active?.leave?.()
    input.enabled=false;input.release()
    if(!keepPlayground){
      stage.dynamicLights=null
      stage.resetCamera()
      if(id!=="spawn"&&id!=="physics")stage.focus.fill(0)
      particles.reset();volume.reset();trail.reset()
    }
    active=next;settings.section=id
    sectionSelect.value=id
    syncDebugOptions(id)
    const inPlayground=Boolean(spawn?.hasActiveScene()&&isPlaygroundSection(id))
    stage.sceneMode=inPlayground||(id==="spawn"||id==="physics"&&spawn)?(spawn?.section.settings.environment==="yard"?3:4):id==="lighting"?1:id==="materials"?2:0
    panel?.clearControls();panel?.addControls(active.settings,active.controls,workbench?.sectionDefaults(id))
    if(!keepPlayground||id==="effects")active.enter?.()
    else if(id==="spawn")spawn?.section.enter?.()
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
    onPin:(control,group)=>workbench?.togglePin(control,group),
    isPinned:key=>Boolean(workbench?.isPinned(key)),
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
    const sharePlayground=Boolean(spawn?.hasActiveScene()&&(active.id==="effects"||active.id==="lighting"))
    if(sharePlayground){
      stage.sceneMode=spawn!.section.settings.environment==="yard"?3:4
      spawn!.section.prepare?.()
      if(active.id==="lighting")stage.dynamicLights=null
    }
    active.prepare?.()
    const drawPass=sharePlayground
      ?(pass:GPURenderPassEncoder)=>{spawn!.section.draw?.(pass);active.draw?.(pass)}
      :active.draw
    const ms=await stage.render(particles,volume,trail,settings.debug,measure,drawPass)
    panel!.header.textContent=`${formatHeaderTelemetry(active.telemetry?.()??active.label)}\nGPU ${stage.gpuMs?.toFixed(2)??"—"} ms${stage.gpuMs===null?" (unavailable)":""}`
    workbench?.setTelemetry(panel!.header.textContent)
    return ms
  }
  const advance=(dt:number)=>{
    const step=Math.max(0,Math.min(dt,1/15))*(workbench?.speed??1)
    if(spawn?.hasActiveScene()&&(active.id==="effects"||active.id==="lighting")){
      spawn.section.update?.(step)
    }
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
    advanceSim:dt=>{
      const s=Math.max(0,Math.min(dt,1/15))
      if(spawn?.hasActiveScene()&&(active.id==="effects"||active.id==="lighting"))spawn.section.update?.(s)
      active.update?.(s)
    },
    spawn,
  })

  select("effects")
  const searchParams=new URLSearchParams(location.search)
  const bench=searchParams.has("bench")
  const resolveDeepSection=()=>{
    const rawHash=location.hash.replace(/^#/, "").trim().toLowerCase()
    const fromHash=rawHash.startsWith("section=")?rawHash.slice("section=".length):rawHash
    const candidate=fromHash||searchParams.get("section")?.trim().toLowerCase()||""
    return sections.find(s=>s.id.toLowerCase()===candidate)?.id??null
  }
  const initialSection=resolveDeepSection()
  if(initialSection){
    select(initialSection)
  }else if(!bench){
    if(spawn){
      select("spawn")
      spawn.section.settings.character="getaway:muscle"
      spawn.spawnCharacterAt("getaway:muscle",{x:0,y:0,z:8,yaw:Math.PI})
      spawn.section.settings.item="cone"
      spawn.section.settings.count=5
      spawn.section.settings.spacing=2
      spawn.spawnItems("row",{x:0,y:0,z:2,yaw:Math.PI})
      spawn.section.settings.item="propane"
      spawn.spawnItems("one",{x:0,y:0,z:-10,yaw:Math.PI})
      spawn.section.settings.item="hydrant"
      spawn.spawnItems("one",{x:-13,y:0,z:-7,yaw:0})
      stage.frameTarget(0,0.4,2,20)
    }else{
      stage.frameTarget(-1,0.5,0,15)
    }
  }
  window.addEventListener("hashchange",()=>{
    const target=resolveDeepSection()
    if(target&&settings.section!==target){
      select(target)
      void render()
    }
  })
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
      commands:workbench!.commands,
      state:()=>workbench!.state(),
      invoke:(id:string,args?:Record<string,unknown>)=>workbench!.invoke(id,args),
      radial:workbench!.radial,
      getSelectedIds:()=>workbench!.getSelectedIds(),
      setBoxSelectMode:(enabled:boolean)=>workbench!.setBoxSelectMode(enabled),
      transform:workbench!.transform,
      compare:workbench!.compare,
      cursor:workbench!.cursor,
      exportGameRecipe:()=>workbench!.exportGameRecipe(),
      applyGameRecipe:(raw:unknown)=>workbench!.applyGameRecipe(raw),
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
