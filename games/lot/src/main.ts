import { mat4 } from "wgpu-matrix"
import { FirstPerson } from "@arcade/kit/client/first-person"
import { keyPromptHtml } from "@arcade/kit/client/key-cap"
import { openGpu } from "@arcade/kit/gpu/boot"
import { loadGltf, imageTexture } from "@arcade/kit/gpu/gltf"
import { Renderer } from "@arcade/kit/gpu/renderer"
import { flatLighting, newSceneFrame, packSceneFrame, SceneLights, type SceneLight } from "@arcade/kit/gpu/scene-frame"
import { SpotShadows, spotShadowControls } from "@arcade/kit/gpu/shadows/spot-shadows"
import { FogScatter, fogControls, fogCone, type FogLamp } from "@arcade/kit/gpu/fog-scatter"
import { makeSceneShader, spriteShader } from "@arcade/kit/gpu/shaders"
import { TexturedMeshPass, type TexturedPrimitive } from "@arcade/kit/gpu/textured-mesh"
import { TEMPORAL_DEFAULTS } from "@arcade/kit/gpu/temporal"
import { LabPanel } from "@arcade/kit/lab-panel"
import { controls, defaults } from "./settings"
import { hooks, texturedHooks, glassHooks, fenceHooks, fogVolume } from "./shaders"
import { buildWorld, CAR, START, walls } from "./world"
import { foliageTexture, solidTexture } from "./foliage"
import { post } from "./post"

async function main() {
  const canvas = document.querySelector<HTMLCanvasElement>("#view")!
  const hud = document.getElementById("hud")!
  hud.textContent = "Loading the lot…"
  const gpu = await openGpu(canvas, "LOT")
  if (typeof gpu === "string") throw new Error(gpu)
  const device=gpu.device
  const shader = makeSceneShader(hooks)
  const renderer = new Renderer(gpu.device, gpu.context, gpu.format, { scene: shader, sprite: spriteShader(), post, volume: [fogVolume] })
  const fog=new FogScatter()
  const settings = defaults()
  renderer.setTemporal({ ...TEMPORAL_DEFAULTS, mode: "taa", sharpen: 0.12 })
  const world = await buildWorld()
  const lighting = flatLighting(0, 0, [0, 0, 0])
  renderer.setLevel({ chunks: [...world.solid,world.extra].map(data=>({data,box:[-700,-700,700,700] as const})), glass: [], ...lighting })

  const base = import.meta.env.BASE_URL + "assets/"
  const transform = mat4.translation([CAR.x, 0.04, CAR.z])
  mat4.rotateY(transform, CAR.yaw, transform)
  const car = await loadGltf(gpu.device, base + "wagon.glb", transform)
  const dressing=await Promise.all([
    {file:"metal_trash_can",pos:[11.25,0.12,128.4],yaw:-Math.PI/2},
    {file:"utility_box_01",pos:[10.1,0.12,125.65],yaw:0},
  ].map(async p=>{
    const transform=mat4.translation(p.pos)
    mat4.rotateY(transform,p.yaw,transform)
    return loadGltf(gpu.device,base+p.file+".glb",transform)
  }))
  const textures = await Promise.all(["asphalt.jpg", "asphalt-normal.jpg", "asphalt-orm.jpg"].map(async (file, i) => {
    const r = await fetch(base + file)
    if (!r.ok) throw new Error(`${file}: ${r.status}`)
    return imageTexture(gpu.device, new Uint8Array(await r.arrayBuffer()), i === 0, "image/jpeg")
  }))
  const normal=solidTexture(gpu.device,[128,128,255,255]), orm=solidTexture(gpu.device,[255,255,0,255])
  const leaves=await foliageTexture(gpu.device,import.meta.env.BASE_URL+"ashwood/paint.js")
  const undergrowth=await foliageTexture(gpu.device,import.meta.env.BASE_URL+"ashwood/paint.js","undergrowthAtlas")
  const impostors=await foliageTexture(gpu.device,import.meta.env.BASE_URL+"ashwood/paint.js","impostors")
  const meshes = new TexturedMeshPass(renderer.passContext, [...world.ground.map((vertices):TexturedPrimitive=>({
    vertices, base: textures[0]!, normal: textures[1]!, orm: textures[2]!,
    color: [1, 1, 1, 1], roughness: 1, metalness: 0, normalScale: 0.45, blend: false, aoStrength: 1,
  })), ...car.primitives, ...dressing.flatMap(d=>d.primitives), ...world.foliage.map((vertices):TexturedPrimitive=>({vertices,base:leaves,normal,orm,color:[1,1,1,1],roughness:1,metalness:0,normalScale:0,blend:false,alphaCutoff:0.5})), ...world.undergrowth.map((vertices):TexturedPrimitive=>({vertices,base:undergrowth,normal,orm,color:[1,1,1,1],roughness:1,metalness:0,normalScale:0,blend:false,alphaCutoff:0.5}))], texturedHooks)
  renderer.addPass("opaque", meshes)
  renderer.addPass("opaque",new TexturedMeshPass(renderer.passContext,world.impostors.map((vertices):TexturedPrimitive=>({vertices,base:impostors,normal,orm,color:[1,1,1,1],roughness:1,metalness:0,normalScale:0,blend:false,alphaCutoff:0.5})),texturedHooks))
  const white=solidTexture(gpu.device,[255,255,255,255])
  renderer.addPass("opaque",new TexturedMeshPass(renderer.passContext,world.fence.map((vertices):TexturedPrimitive=>({
    vertices,base:white,normal,orm,color:[1,1,1,1],roughness:0.6,metalness:0.85,normalScale:0,blend:false,
  })),fenceHooks))
  renderer.addPass("alpha",new TexturedMeshPass(renderer.passContext,world.glass.map((vertices):TexturedPrimitive=>({
    vertices,base:white,normal,orm,color:[1,1,1,0.35],roughness:0.06,metalness:0,normalScale:0,blend:true,
  })),glassHooks))

  const camera = new FirstPerson(canvas, () => panel.visible)
  camera.body.x = START.x; camera.body.y = START.z; camera.yaw = START.yaw; camera.pitch = START.pitch
  camera.height=START.height; camera.near=0.15; camera.far=1200
  const panel = new LabPanel(settings, controls(settings), new URLSearchParams(location.search), () => camera.release(), { open: false, pill: false, groupActions: false })
  panel.addControls(fog.settings,fogControls("Fog","fog.").filter(c=>!["density","falloff","brightness","strength"].includes(c.field ?? "")))
  // LabPanel owns Backquote, including when the canvas is pointer-locked.
  const lights = new SceneLights()
  lights.setBoxes([{ rect: [-55,-22,35,22], h: 19.6 }])
  const spots=new SpotShadows(gpu.device,{count:2})
  panel.addControls(spots.settings,spotShadowControls())
  renderer.setSpotShadows(spots.bindings())
  const casters=world.solid.map(data=>{
    const buffer=gpu.device.createBuffer({size:data.byteLength,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST})
    gpu.device.queue.writeBuffer(buffer,0,data)
    return {buffer,count:data.byteLength/24,stride:24}
  }).concat(meshes.shadowCasters())
  const practicals=world.scene.lamps.filter(l=>l.kind==="sodium" || l.kind==="incandescent")
  const shadowLamps=practicals.flatMap((l,id)=>l.shadow && l.angle ? [{id,pos:l.position,axis:l.direction ?? [0,-1,0] as const,range:l.range,intensity:l.intensity,cosOuter:Math.cos(l.angle)}] : [])
  const frameData = newSceneFrame(), custom = new Float32Array(12), empty = new Float32Array(0)
  const prompts = () => {
    hud.innerHTML = [document.pointerLockElement === canvas ? "" : keyPromptHtml("Mouse0", "Look"), keyPromptHtml("KeyW", "Move"), keyPromptHtml("KeyF", "Flashlight"), keyPromptHtml("Backquote", "Night")].join(" ")
  }
  prompts()
  document.addEventListener("pointerlockchange", prompts)
  let last = performance.now(), frames = 0, paused = false
  function render(now: number) {
    if(paused) { last=now; requestAnimationFrame(render); return }
    const width = Math.max(1, Math.round(innerWidth * Math.min(devicePixelRatio, 1.5)))
    const height = Math.max(1, Math.round(innerHeight * Math.min(devicePixelRatio, 1.5)))
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; renderer.resize(width, height) }
    const dt = Math.min(0.05, (now - last) / 1000); last = now
    const vp = camera.update(dt, width / height, walls)
    const frameLights:SceneLight[]=practicals.map((l,id)=>({id,x:l.position[0],y:l.position[2],h:l.position[1],r:l.range,color:l.color,power:l.intensity*settings.lamp/5,size:0.45,
      ...(l.angle ? { spot: { axis: l.direction ?? [0,-1,0] as const, cosOuter: Math.cos(l.angle), cosInner: Math.cos(l.angle*(1-(l.penumbra ?? 0.55))) } } : {}),
    }))
    if(camera.flashlight) frameLights.push({id:-1,x:camera.eye[0],y:camera.eye[2],h:camera.eye[1],r:35,color:[0.85,0.92,1],power:56,size:0.4,unshadowed:true,beam:{axis:camera.direction,halfAngle:0.27}})
    lights.update(frameLights, [])
    const shadowEncoder=device.createCommandEncoder()
    if(spots.update(shadowEncoder,shadowLamps,camera.eye,dt,id=>lights.indexOf(id),casters)) renderer.setSpotShadows(spots.bindings())
    device.queue.submit([shadowEncoder.finish()])
    custom.set([settings.density, settings.falloff, settings.sky, settings.lamp, settings.wetness, settings.haze, 0, 0, ...camera.direction, Number(camera.flashlight)])
    renderer.setCustomUniforms(custom)
    Object.assign(fog.settings,{density:settings.density,falloff:settings.falloff,brightness:0.034*settings.sky,strength:settings.haze})
    const fogLamps:FogLamp[]=practicals.flatMap((l,id)=>l.kind==="sodium"?[{id,x:l.position[0],y:l.position[1],z:l.position[2],range:l.range,color:l.color,intensity:l.intensity*settings.lamp/Math.PI,
      axis:l.direction,size:0.45,...fogCone(l.angle ?? 1.1,1-(l.penumbra ?? 0.55)),
    }]:[])
    packSceneFrame(frameData, { viewProj: vp, eye: camera.eye, time: 0, width, height, lightCount: lights.lightCount,
      ambient: [0,0,0,0], mapSize: [1400, 1400], ao: 0 })
    renderer.render({ frame: frameData, lights: lights.lights, lightCount: lights.lightCount, shadowLightCount: lights.shadowLightCount,
      occluders: lights.occ, occluderCount: lights.occCount, lampPower: lights.power, lampCount: 0,
      view: [-700, -700, 700, 700], batches: [], alphaSprites: empty, alphaCount: 0, addSprites: empty, addCount: 0, grade: [0, 0, 0, settings.exposure],
      fog:fog.update({eye:camera.eye,viewProj:vp,lamps:fogLamps}),volume:[fog.volumeInput()] })
    frames++
    requestAnimationFrame(render)
  }
  Object.assign(window, { lot: { camera, settings, fog, renderer, get frames() { return frames }, get paused() { return paused }, set paused(value:boolean) { paused=value }, ready: true } })
  requestAnimationFrame(render)
}
void main().catch(error => { console.error(error); document.getElementById("hud")!.textContent = String(error) })
