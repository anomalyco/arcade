import { mat4 } from "wgpu-matrix"
import { FirstPerson } from "@arcade/kit/client/first-person"
import { keyPromptHtml } from "@arcade/kit/client/key-cap"
import { openGpu } from "@arcade/kit/gpu/boot"
import { loadGltf } from "@arcade/kit/gpu/gltf"
import { Renderer, type FrameInput } from "@arcade/kit/gpu/renderer"
import { flatLighting, newSceneFrame, packSceneFrame, SceneLights, type SceneLight } from "@arcade/kit/gpu/scene-frame"
import { SpotShadows, spotShadowControls } from "@arcade/kit/gpu/shadows/spot-shadows"
import { FogScatter, atmosphereControls, createFogSettings, fogControls, fogCone, type FogLamp } from "@arcade/kit/gpu/fog-scatter"
import { Ssr, createSsrSettings, ssrControls } from "@arcade/kit/gpu/reflections/ssr"
import { WET_DEFAULTS, packWet, wetControls } from "@arcade/kit/gpu/reflections/wet"
import { makeSceneShader, spriteShader } from "@arcade/kit/gpu/shaders"
import { TexturedMeshPass, type TexturedPrimitive } from "@arcade/kit/gpu/textured-mesh"
import { TEMPORAL_DEFAULTS } from "@arcade/kit/gpu/temporal"
import { ForestPass, FOREST_PRESETS, cardShadingHooks, forestControls, forestDefaults } from "@arcade/kit/gpu/forest"
import { LabPanel } from "@arcade/kit/lab-panel"
import { createGlassSettings, createRoomSettings, glassControls, packGlassKnobs, roomControls } from "@arcade/kit/gpu/materials/glass"
import { loadRoomAtlas } from "@arcade/kit/gpu/materials/rooms"
import { contactShadowControls, contactShadowInput, createContactShadowSettings, packContactShadowKnobs } from "@arcade/kit/gpu/contact-shadows"
import type { ScenePass } from "@arcade/kit/gpu/pass-graph"
import { ATMOSPHERE, SSR_MOTION, controls, defaults } from "./settings"
import { hooks, texturedHooks, glassHooks, fenceHooks, stainHooks, fogVolume, reflectionVolume, thinGlassHooksLot, windowHooks, contactVolume, NIGHT_FLOATS } from "./shaders"
import { buildWorld, CAR, START, walls } from "./world"
import { canvasTexture, foliageTexture, solidTexture } from "./foliage"
import { post } from "./post"
import { compareCamera } from "./compare-camera"
import { dressingControls, dressingDefaults, groundHeight, leafTemplate, paintLeafAtlas, paperTemplate, pebbleTemplate, placeDressing } from "./dressing"
import { bakeScatter, type ScatterPlacement } from "@arcade/kit/gpu/scatter-mesh"
import { loadInterior } from "./interior/load"
import { interiorDefaults, interiorControls } from "./interior/settings"
import { lobbyTroffer, trofferFog } from "./interior/fixtures"
import { createStreetLampSettings, packStreetLamp, streetLampControls } from "@arcade/kit/gpu/lights/street"
import { fluxGain, lensChunk, streetLamps } from "./lamps"
import { sourceSurfaces } from "./surfaces"

async function main() {
  const canvas = document.querySelector<HTMLCanvasElement>("#view")!
  const hud = document.getElementById("hud")!
  hud.textContent = "Loading the lot…"
  const gpu = await openGpu(canvas, "LOT")
  if (typeof gpu === "string") throw new Error(gpu)
  const device=gpu.device
  const query = new URLSearchParams(location.search)
  const smoke = query.has("smoke")
  // Automation only: freezes the bank and cloud drift at a time in seconds.
  const fixedTime = query.has("time") ? Number(query.get("time")) : null
  const shader = makeSceneShader(hooks)
  // Software-GPU smoke keeps Today and compiles nothing it does not draw.
  const renderer = new Renderer(gpu.device, gpu.context, gpu.format, { scene: shader, sprite: spriteShader(), post, volume: smoke ? [reflectionVolume, fogVolume(false)] : [contactVolume, reflectionVolume, fogVolume(true)] })
  // The CI smoke keeps the atmosphere at Today: its software GPU cost is noted in docs/rendering-techniques.md.
  const fog=new FogScatter(createFogSettings(smoke ? {} : ATMOSPHERE)), ssr=new Ssr(createSsrSettings(SSR_MOTION)), wet={...WET_DEFAULTS}
  const settings = defaults()
  renderer.setTemporal({ ...TEMPORAL_DEFAULTS, mode: "taa", sharpen: 0.12 })
  const t0=performance.now()
  const world = await buildWorld()
  const worldMs=performance.now()-t0
  const interior = await loadInterior(device), indoor = interiorDefaults()
  walls.push(...interior.colliders.map(b=>[b.min[0]!,b.min[2]!,b.max[0]!,b.max[2]!] as const))
  const lighting = flatLighting(0, 0, [0, 0, 0])
  // The CI smoke keeps the street lamps at Today too (its shaders leave the street path out: SwiftShader compile time).
  const street=createStreetLampSettings(smoke ? {mode:"today"} : {}), streets=streetLamps(world.scene)
  renderer.setLevel({ chunks: [...world.solid,world.extra,lensChunk(streets)].map(data=>({data,box:[-700,-700,700,700] as const})), glass: [], ...lighting })

  const base = import.meta.env.BASE_URL + "assets/"
  const transform = mat4.translation([CAR.x, 0.04, CAR.z])
  mat4.rotateY(transform, CAR.yaw, transform)
  const car = await loadGltf(gpu.device, base + "wagon.glb", transform)
  const surfaces=await sourceSurfaces(device,world)
  const normal=solidTexture(gpu.device,[128,128,255,255]), orm=solidTexture(gpu.device,[255,255,0,255])
  const leaves=await foliageTexture(gpu.device,import.meta.env.BASE_URL+"ashwood/paint.js")
  const undergrowth=await foliageTexture(gpu.device,import.meta.env.BASE_URL+"ashwood/paint.js","undergrowthAtlas")
  const impostors=await foliageTexture(gpu.device,import.meta.env.BASE_URL+"ashwood/paint.js","impostors")
  const meshes = new TexturedMeshPass(renderer.passContext, [...surfaces,...car.primitives], texturedHooks)
  renderer.addPass("opaque", meshes)
  const insideMeshes = new TexturedMeshPass(renderer.passContext,interior.primitives.filter(p=>!p.blend),texturedHooks)
  renderer.addPass("opaque",insideMeshes)
  const white=solidTexture(gpu.device,[255,255,255,255])
  const forestSettings=forestDefaults()
  const forest=new ForestPass(renderer.passContext,world.forest.models,world.forest.trees,{ hooks:texturedHooks, impostorGrid:world.forest.impostorGrid,
    textures:{ leaves, bark:white, impostors, normal, orm } })
  renderer.addPass("opaque",forest)
  renderer.addPass("opaque",new TexturedMeshPass(renderer.passContext,world.undergrowth.map((vertices):TexturedPrimitive=>({vertices,base:undergrowth,normal,orm,color:[1,1,1,1],roughness:1,metalness:0,normalScale:0,blend:false,alphaCutoff:0.5})),
    cardShadingHooks(texturedHooks,"N.forest.x","N.forest.y")))
  // Rule-placed ground dressing, rebuilt (debounced) when its Lab settings change.
  const can=await loadGltf(gpu.device,base+"can_rusted.glb")
  const leafAtlas=await canvasTexture(gpu.device,import.meta.env.BASE_URL+"ashwood/paint.js",paintLeafAtlas())
  const templates={ leaf:[0,1,2,3].map(leafTemplate), pebble:[1,2,3,4].map(pebbleTemplate), paper:[1,2,3].map(paperTemplate) }
  const dressingSettings=dressingDefaults()
  let dressingPasses:TexturedMeshPass[]=[], dressingKey="", dressingTimer=0, dressingCount=0
  const buildDressing=()=>{
    for(const p of dressingPasses) { renderer.removePass(p); p.dispose() }
    dressingPasses=[]
    const items=placeDressing(world.scene.ground,world.scene.colliders,dressingSettings)
    dressingCount=items.length
    const groups=new Map<ArrayBuffer,ScatterPlacement[]>()
    const add=(template:ArrayBuffer,p:ScatterPlacement)=>{ const list=groups.get(template); if(list) list.push(p); else groups.set(template,[p]) }
    const cans:ScatterPlacement[]=[]
    for(const d of items) {
      const y=groundHeight(world.scene.ground,d.x,d.z), tint=0.72+0.28*d.seed
      if(d.item==="leaf") add(templates.leaf[Math.floor(d.seed*4)]!,{x:d.x,y,z:d.z,yaw:d.yaw,scale:d.scale,tilt:(d.seed-0.5)*0.3,tint})
      else if(d.item==="pebble") add(templates.pebble[Math.floor(d.seed*4)]!,{x:d.x,y,z:d.z,yaw:d.yaw,scale:d.scale,tint})
      else if(d.item==="paper") add(templates.paper[Math.floor(d.seed*3)]!,{x:d.x,y,z:d.z,yaw:d.yaw,scale:d.scale})
      else if(d.item==="can") cans.push({x:d.x,y:y+0.062,z:d.z,yaw:d.yaw,scale:d.scale,tilt:Math.PI/2})
      else add(world.forest.plants[d.item as keyof typeof world.forest.plants],{x:d.x,y,z:d.z,yaw:d.yaw,scale:d.scale,tint})
    }
    const card=(t:ArrayBuffer[],texture:GPUTexture)=>t.flatMap(template=>groups.has(template) ? [{vertices:bakeScatter(template,groups.get(template)!),base:texture,normal,orm,color:[1,1,1,1],roughness:1,metalness:0,normalScale:0,blend:false,alphaCutoff:0.5} satisfies TexturedPrimitive] : [])
    const plants=card(Object.values(world.forest.plants),undergrowth), leaves=card(templates.leaf,leafAtlas)
    const props:TexturedPrimitive[]=[...templates.pebble,...templates.paper].flatMap(template=>groups.has(template) ? [{vertices:bakeScatter(template,groups.get(template)!),base:white,normal,orm,color:[1,1,1,1],roughness:0.9,metalness:0,normalScale:0,blend:false} satisfies TexturedPrimitive] : [])
    if(cans.length) props.push(...can.primitives.map(p=>({...p,vertices:bakeScatter(p.vertices,cans)})))
    if(plants.length+leaves.length) dressingPasses.push(new TexturedMeshPass(renderer.passContext,[...plants,...leaves],cardShadingHooks(texturedHooks,"N.forest.x","N.forest.y")))
    if(props.length) dressingPasses.push(new TexturedMeshPass(renderer.passContext,props,texturedHooks))
    for(const p of dressingPasses) renderer.addPass("opaque",p)
  }
  const refreshDressing=()=>{
    const key=JSON.stringify(dressingSettings)
    if(key===dressingKey) return
    dressingKey=key
    clearTimeout(dressingTimer)
    dressingTimer=window.setTimeout(buildDressing,150)
  }
  dressingKey=JSON.stringify(dressingSettings); buildDressing()
  renderer.addPass("opaque",new TexturedMeshPass(renderer.passContext,world.fence.map((vertices):TexturedPrimitive=>({
    vertices,base:white,normal,orm,color:[1,1,1,1],roughness:0.6,metalness:0.85,normalScale:0,blend:false,
  })),fenceHooks))
  // Each new look is its own pass, built the first time it is switched on, so Today draws exactly what it drew before.
  const glass=createGlassSettings({mode:smoke?"today":"thin"}), rooms=createRoomSettings({mode:smoke?"today":"rooms",mullions:"box"}), contact=createContactShadowSettings({mode:smoke?"today":"screen",historyMoving:0.25})
  const lazy=(make:()=>ScenePass)=>{ let pass:ScenePass|null=null; return { draw:(p:GPURenderPassEncoder)=>(pass??=make()).draw(p) } }
  const glassPrimitives=world.glass.map((vertices):TexturedPrimitive=>({vertices,base:white,normal,orm,color:[1,1,1,0.35],roughness:0.06,metalness:0,normalScale:0,blend:true}))
  const todayGlass=new TexturedMeshPass(renderer.passContext,glassPrimitives,glassHooks)
  const thinGlass=lazy(()=>new TexturedMeshPass(renderer.passContext,glassPrimitives,thinGlassHooksLot))
  renderer.addPass("alpha",{draw:p=>(glass.mode==="thin"?thinGlass:todayGlass).draw(p)})
  const roomAtlas=smoke ? null : loadRoomAtlas(gpu.device)
  let atlas:GPUTexture|null=null
  void roomAtlas?.then(t=>{atlas=t})
  const windows=lazy(()=>new TexturedMeshPass(renderer.passContext,world.windows.map((vertices):TexturedPrimitive=>({vertices,base:atlas!,normal,orm,color:[1,1,1,1],roughness:1,metalness:0,normalScale:0,blend:false})),windowHooks))
  renderer.addPass("opaque",{draw:p=>{ if(rooms.mode==="rooms" && atlas) windows.draw(p) }})
  renderer.addPass("alpha",new TexturedMeshPass(renderer.passContext,world.stain.map((vertices):TexturedPrimitive=>({
    vertices,base:white,normal,orm,color:[1,1,1,1],roughness:1,metalness:0,normalScale:0,blend:true,
  })),stainHooks))

  const entrancePrimitives=world.storefront.map((vertices):TexturedPrimitive=>({
    vertices,base:white,normal,orm,color:[1,1,1,0.12],roughness:0.04,metalness:0,normalScale:0,blend:true,
  })).concat(interior.primitives.filter(p=>p.blend && p.roughness<0.1))
  const entranceToday=new TexturedMeshPass(renderer.passContext,entrancePrimitives,texturedHooks)
  const entranceGlass=lazy(()=>new TexturedMeshPass(renderer.passContext,entrancePrimitives,thinGlassHooksLot))
  renderer.addPass("alpha",{draw:p=>(glass.mode==="thin"?entranceGlass:entranceToday).draw(p)})
  renderer.addPass("alpha",new TexturedMeshPass(renderer.passContext,interior.primitives.filter(p=>p.blend && p.roughness>=0.1),texturedHooks))
  const camera = new FirstPerson(canvas, () => panel.visible)
  camera.body.x = START.x; camera.body.y = START.z; camera.yaw = START.yaw; camera.pitch = START.pitch
  camera.height=START.height; camera.near=0.15; camera.far=1200
  const panel = new LabPanel(settings, controls(settings), new URLSearchParams(location.search), () => camera.release(), { open: false, pill: false, groupActions: false })
  const comparison=compareCamera(camera,()=>panel.visible)
  panel.addControls(street,streetLampControls("Lamps","lamps."))
  panel.addControls(forestSettings,forestControls(forestSettings))
  panel.addControls(dressingSettings,dressingControls(dressingSettings))
  panel.addControls(indoor,interiorControls)
  panel.addControls(fog.settings,fogControls("Fog","fog.").filter(c=>!["density","falloff","brightness","strength"].includes(c.field ?? "")))
  panel.addControls(ssr.settings,ssrControls("Reflections","ssr."))
  panel.addControls(wet,wetControls("Wet ground","wet.").filter(c=>c.field!=="wetness"))
  panel.addControls(glass,glassControls("Glass"))
  panel.addControls(rooms,roomControls("Glass"))
  panel.addControls(contact,contactShadowControls("Shadows"))
  panel.addControls(fog.settings,atmosphereControls("Atmosphere","atmo."))
  // LabPanel owns Backquote, including when the canvas is pointer-locked.
  const lights = new SceneLights()
  lights.setBoxes([...world.scene.colliders,...interior.colliders].filter(b=>b.max[1]!>0.5 && b.min[1]!<1.5).map(b=>({rect:[b.min[0]!,b.min[2]!,b.max[0]!,b.max[2]!] as const,h:b.max[1]!})))
  const spots=new SpotShadows(gpu.device,{count:3})
  panel.addControls(spots.settings,spotShadowControls())
  renderer.setSpotShadows(spots.bindings())
  const casters=world.solid.map(data=>{
    const buffer=gpu.device.createBuffer({size:data.byteLength,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST})
    gpu.device.queue.writeBuffer(buffer,0,data)
    return {buffer,count:data.byteLength/24,stride:24}
  }).concat(meshes.shadowCasters(),insideMeshes.shadowCasters())
  // Source lighting offsets a head 12 cm along its axis, out of the luminaire's own shadow caster.
  const practicals=[...world.scene.lamps,...interior.lamps].map(l=>{
    const direction=l.kind==="incandescent" ? [0,-1,0] as [number,number,number] : l.direction
    return { ...l, street:streets.get(l), gain:streets.has(l) ? ()=>fluxGain(l,street) : ()=>1,
    // A downward ceiling fixture keeps the warm booth spill, while its walls and
    // plinth now stop it from shining straight through the hut onto the road.
    ...(l.kind==="incandescent" ? {direction,angle:1.3,penumbra:0.15,shadow:true} : {}),
    position:l.position.map((v,i)=>v+(direction?.[i] ?? 0)*0.12) as [number,number,number],
  }})
  const shadowLamps=practicals.flatMap((l,id)=>l.shadow && l.angle ? [{id,pos:l.position,axis:l.direction ?? [0,-1,0] as const,range:l.range,intensity:l.intensity,cosOuter:Math.cos(l.angle)}] : [])
  // Trunks within reach of a shadowed sodium head cast into its pool.
  casters.push(...forest.staticCasters(shadowLamps.map(l=>({x:l.pos[0],z:l.pos[2]})),40))
  const indoorStart=practicals.length-interior.lamps.length
  const frameData = newSceneFrame(), custom = new Float32Array(NIGHT_FLOATS), empty = new Float32Array(0)
  const prompts = () => {
    hud.innerHTML = [document.pointerLockElement === canvas ? "" : keyPromptHtml("Mouse0", "Look"), keyPromptHtml("KeyW", "Move"), keyPromptHtml("KeyF", "Flashlight"), keyPromptHtml("Backquote", "Night"), comparison.available ? keyPromptHtml("KeyP", "Compare position") : ""].join(" ")
  }
  prompts()
  document.addEventListener("pointerlockchange", prompts)
  let last = performance.now(), frames = 0, paused = false, lastFrame: FrameInput | null = null
  const readyMs=performance.now()-t0
  // Slot order: contact shadows darken the lit scene before reflections and fog add to it.
  const volumes = () => {
    const inside=camera.body.x>-55 && camera.body.x<35 && camera.body.y>-3.2 && camera.body.y<22
    const reflections=ssr.volumeInput({indoor:inside,wet:inside?{...wet,wetness:0,puddles:0,ripple:0}:wet})
    return smoke ? [reflections,fog.volumeInput()] : [contactShadowInput(contact),reflections,fog.volumeInput()]
  }
  /** GPU ms of n frames of the last frame's input (Renderer.measure), each after `warm` untimed frames so the GPU is at clock. */
  const measureFrames = async (n = 24, warm = 3) => {
    if(!lastFrame) return null
    const samples:number[] = []
    for(let i=0;i<n;i++) { for(let w=0;w<warm;w++) renderer.render(lastFrame); samples.push(await renderer.measure(lastFrame)) }
    samples.sort((a,b)=>a-b)
    return { median: samples[Math.floor(samples.length/2)] ?? null, samples }
  }
  function render(now: number) {
    if(paused) { last=now; requestAnimationFrame(render); return }
    frame(now)
    requestAnimationFrame(render)
  }
  function frame(now: number) {
    const width = Math.max(1, Math.round(innerWidth * Math.min(devicePixelRatio, 1.5)))
    const height = Math.max(1, Math.round(innerHeight * Math.min(devicePixelRatio, 1.5)))
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; renderer.resize(width, height) }
    const dt = Math.min(0.05, (now - last) / 1000); last = now
    const vp = camera.update(dt, width / height, walls)
    comparison.frame()
    // Street mode: the lens emitter and roadway profile replace the round spot, at the same flux (lamps.ts).
    const area=street.mode==="area"
    const panels=!smoke && indoor.mode!=="today" && indoor.emitters==="area"
    const fixtureGain=(l:{position:readonly number[]},id:number)=>id<indoorStart ? settings.lamp : l.position[2]!>9 && Math.abs(l.position[0]!)<9 ? indoor.lobbyFixtures : indoor.fixtures
    const frameLights:SceneLight[]=practicals.map((l,id)=>({id,x:l.position[0],y:l.position[2],h:l.position[1],r:l.range,color:l.color,power:l.intensity*fixtureGain(l,id)/5*(area ? l.gain() : 1),size:(l.size ?? 0.1)*0.5,
      ...(area && l.street ? { street: { arm: l.street.arm, a: l.street.a, b: l.street.b } } : l.angle ? { spot: { axis: l.direction ?? [0,-1,0] as const, cosOuter: Math.cos(l.angle), cosInner: Math.cos(l.angle*(1-(l.penumbra ?? 0.55))) } } : {}),
      ...(panels ? {rect:lobbyTroffer(l)} : {}),
    }))
    if(camera.flashlight) frameLights.push({id:-1,x:camera.eye[0],y:camera.eye[2],h:camera.eye[1],r:35,color:[0.85,0.92,1],power:56,size:0.4,unshadowed:true,beam:{axis:camera.direction,halfAngle:0.27}})
    lights.update(frameLights, [])
    const shadowEncoder=device.createCommandEncoder()
    if(spots.update(shadowEncoder,shadowLamps,camera.eye,dt,id=>lights.indexOf(id),casters)) renderer.setSpotShadows(spots.bindings())
    device.queue.submit([shadowEncoder.finish()])
    wet.wetness=settings.wetness
    custom.set([settings.density, settings.falloff, settings.sky, settings.lamp, settings.wetness, settings.haze, settings.reflectionCap, settings.specularAA, ...camera.direction, Number(camera.flashlight)])
    custom.set(packWet(wet),12)
    custom.set([forestSettings.inner,forestSettings.face,settings.decalDepth,0],20)
    packGlassKnobs(glass,rooms,custom,24)
    packContactShadowKnobs(contact,custom,36)
    packStreetLamp(street,custom,44)
    custom.set([indoor.wear,indoor.sheen,indoor.wax,indoor.glow],56)
    forest.update(camera.eye, forestSettings)
    refreshDressing()
    custom.set([indoor.fixtures,indoor.mode==="today"?0:indoor.bounce,indoor.mode==="today"?1:indoor.air,indoor.mode==="today"?0:indoor.lobbyBounce],16)
    renderer.setCustomUniforms(custom)
    Object.assign(fog.settings,{density:settings.density,falloff:settings.falloff,brightness:0.034*settings.sky,strength:settings.haze})
    // Scattering consumes emitter radiance, not the surface BRDF's radiance / π.
    // Include the booth bulb: its reflection is the second, nearer wet streak.
    const fogLamps:FogLamp[]=practicals.flatMap((l,id)=>trofferFog({id,x:l.position[0],y:l.position[1],z:l.position[2],range:l.range,color:l.color,intensity:l.intensity*fixtureGain(l,id)*(id>=indoorStart?indoor.air:1)*(area ? l.gain() : 1),
      axis:l.direction,size:(l.size ?? 0.2)*0.5,...(l.angle ? fogCone(l.angle,1-(l.penumbra ?? 0.55)) : {}),
      ...(area && l.street ? { lens: { arm: l.street.arm, a: l.street.a, b: l.street.b }, uplight: street.uplight } : {}),
    },panels ? lobbyTroffer(l) : undefined))
    packSceneFrame(frameData, { viewProj: vp, eye: camera.eye, time: 0, width, height, lightCount: lights.lightCount,
      ambient: [0,0,0,0], mapSize: [1400, 1400], ao: 0 })
    lastFrame={ frame: frameData, lights: lights.lights, lightCount: lights.lightCount, shadowLightCount: lights.shadowLightCount,
      occluders: lights.occ, occluderCount: lights.occCount, lampPower: lights.power, lampCount: 0,
      view: [-700, -700, 700, 700], batches: [], alphaSprites: empty, alphaCount: 0, addSprites: empty, addCount: 0, grade: [0, 0, 0, settings.exposure],
      fog:fog.update({eye:camera.eye,viewProj:vp,lamps:fogLamps,time:fixedTime ?? now/1000,street}),volume:volumes(),fogBlur:fog.blurInput() }
    // The smoke draws synchronously: render() defers a frame while the previous one is in flight, so a mark taken
    // after it would time the shadow pass, not the frame.
    if(stepping || smoke) renderer.drawTo(lastFrame); else renderer.render(lastFrame)
    frames++
    if(smoke) { const n=frames-1; performance.mark(`lot:frame-${n}-submitted`); void device.queue.onSubmittedWorkDone().then(()=>performance.mark(`lot:frame-${n}-complete`)) }
    // Software-GPU smoke must submit exactly two real frames; readiness polling can otherwise build a long queue.
    if(smoke && frames >= 2) paused = true
  }
  /** Automation only: renders one frame `ms` after the last on a synthetic clock while paused (scripted camera paths). */
  // It draws synchronously, so the caller can copy the canvas texture in the same task.
  let stepping = false
  const step = (ms: number) => { stepping = true; try { frame(last + ms) } finally { stepping = false } }
  /** Paired whole-frame GPU time, reflections Today vs on, alternating order (automation only). */
  async function measure(rounds=12) {
    paused=true
    const mode=ssr.settings.mode, out={today:[] as number[],ssr:[] as number[]}
    for(let i=0;i<rounds+2;i++) for(const m of i%2 ? ["ssr","today"] as const : ["today","ssr"] as const) {
      ssr.settings.mode=m
      const ms=await renderer.measure({...lastFrame!,volume:volumes()})
      if(i>=2) out[m].push(ms)
    }
    ssr.settings.mode=mode; paused=false
    return out
  }
  /** Paired whole-frame GPU time, street lamps Today vs the lens emitter, alternating order (automation only). */
  async function measureLamps(rounds=12) {
    const mode=street.mode, out={today:[] as number[],area:[] as number[]}
    const settle=()=>new Promise<void>(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r())))
    for(let i=0;i<rounds+2;i++) for(const m of i%2 ? ["area","today"] as const : ["today","area"] as const) {
      street.mode=m; paused=false; await settle(); paused=true
      const ms=await renderer.measure(lastFrame!)
      if(i>=2) out[m].push(ms)
    }
    street.mode=mode; paused=false
    return out
  }
  // measureFrame(): GPU ms of the last frame's input (timestamp-query), for scripts/atmosphere.ts.
  Object.assign(window, { lot: { measureLamps, camera, settings, street, indoor, walls, ssr, wet, measure, measureFrames, measureFrame: () => lastFrame ? renderer.measure(lastFrame) : null, step, spots, forestPresets:FOREST_PRESETS, get input() { return lastFrame }, glass, rooms, contact, forest:forestSettings, forestStats:()=>forest.stats(), timings:{worldMs,readyMs}, dressing:dressingSettings, get dressingCount() { return dressingCount }, fog, renderer, comparison, get frames() { return frames }, get paused() { return paused }, set paused(value:boolean) { paused=value }, ready: true } })
  requestAnimationFrame(render)
}
void main().catch(error => { console.error(error); document.getElementById("hud")!.textContent = String(error) })
