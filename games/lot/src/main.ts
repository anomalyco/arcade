import { mat4 } from "wgpu-matrix"
import { FirstPerson } from "@arcade/kit/client/first-person"
import { keyPromptHtml } from "@arcade/kit/client/key-cap"
import { openGpu } from "@arcade/kit/gpu/boot"
import { loadGltf, imageTexture } from "@arcade/kit/gpu/gltf"
import { Renderer } from "@arcade/kit/gpu/renderer"
import { flatLighting, newSceneFrame, packSceneFrame, SceneLights } from "@arcade/kit/gpu/scene-frame"
import { makeSceneShader, spriteShader } from "@arcade/kit/gpu/shaders"
import { TexturedMeshPass, type TexturedPrimitive } from "@arcade/kit/gpu/textured-mesh"
import { TEMPORAL_DEFAULTS } from "@arcade/kit/gpu/temporal"
import { LabPanel } from "@arcade/kit/lab-panel"
import { controls, defaults } from "./settings"
import { hooks, fenceHooks } from "./shaders"
import { buildWorld, CAR, START, walls } from "./world"
import { foliageTexture, solidTexture } from "./foliage"
import { post } from "./post"

async function main() {
  const canvas = document.querySelector<HTMLCanvasElement>("#view")!
  const hud = document.getElementById("hud")!
  hud.textContent = "Loading the lot…"
  const gpu = await openGpu(canvas, "LOT")
  if (typeof gpu === "string") throw new Error(gpu)
  const shader = makeSceneShader(hooks)
  const renderer = new Renderer(gpu.device, gpu.context, gpu.format, { scene: shader, sprite: spriteShader(), post })
  const settings = defaults()
  renderer.setTemporal({ ...TEMPORAL_DEFAULTS, mode: "taa", sharpen: 0.12 })
  const world = await buildWorld()
  const lighting = flatLighting(0, 0, [0, 0, 0])
  renderer.setLevel({ chunks: [...world.solid,world.extra].map(data=>({data,box:[-700,-700,700,700] as const})), glass: [], ...lighting })

  const base = import.meta.env.BASE_URL + "assets/"
  const transform = mat4.translation([CAR.x, 0.04, CAR.z])
  mat4.rotateY(transform, CAR.yaw, transform)
  const car = await loadGltf(gpu.device, base + "wagon.glb", transform)
  const textures = await Promise.all(["asphalt.jpg", "asphalt-normal.jpg", "asphalt-orm.jpg"].map(async (file, i) => {
    const r = await fetch(base + file)
    if (!r.ok) throw new Error(`${file}: ${r.status}`)
    return imageTexture(gpu.device, new Uint8Array(await r.arrayBuffer()), i === 0, "image/jpeg")
  }))
  const normal=solidTexture(gpu.device,[128,128,255,255]), orm=solidTexture(gpu.device,[255,255,0,255])
  const leaves=await foliageTexture(gpu.device,import.meta.env.BASE_URL+"ashwood/paint.js")
  const meshes = new TexturedMeshPass(renderer.passContext, [...world.ground.map((vertices):TexturedPrimitive=>({
    vertices, base: textures[0]!, normal: textures[1]!, orm: textures[2]!,
    color: [1, 1, 1, 1], roughness: 1, metalness: 0, normalScale: 0.45, blend: false, aoStrength: 1,
  })), ...car.primitives, ...world.foliage.map((vertices):TexturedPrimitive=>({vertices,base:leaves,normal,orm,color:[1,1,1,1],roughness:1,metalness:0,normalScale:0,blend:false,alphaCutoff:0.5}))], hooks)
  renderer.addPass("opaque", meshes)
  const white=solidTexture(gpu.device,[255,255,255,255])
  renderer.addPass("opaque",new TexturedMeshPass(renderer.passContext,world.fence.map((vertices):TexturedPrimitive=>({
    vertices,base:white,normal,orm,color:[1,1,1,1],roughness:0.6,metalness:0.85,normalScale:0,blend:false,
  })),fenceHooks))

  const camera = new FirstPerson(canvas, () => panel.visible)
  camera.body.x = START.x; camera.body.y = START.z; camera.yaw = START.yaw; camera.pitch = START.pitch
  camera.height=START.height; camera.near=0.15; camera.far=1200
  const panel = new LabPanel(settings, controls(settings), new URLSearchParams(location.search), () => camera.release(), { open: false, pill: false, groupActions: false })
  // LabPanel owns Backquote, including when the canvas is pointer-locked.
  const lights = new SceneLights()
  lights.setBoxes([{ rect: [-55,-22,35,22], h: 19.6 }])
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
    lights.update(world.scene.lamps.filter(l=>l.kind==="sodium" || l.kind==="incandescent").map(l=>({x:l.position[0],y:l.position[2],h:l.position[1],r:l.range,color:l.color,power:l.intensity*settings.lamp,size:0.45})), [])
    custom.set([settings.density, settings.falloff, settings.sky, settings.lamp, settings.wetness, settings.haze, 0, 0, ...camera.direction, Number(camera.flashlight)])
    renderer.setCustomUniforms(custom)
    packSceneFrame(frameData, { viewProj: vp, eye: camera.eye, time: 0, width, height, lightCount: lights.lightCount,
      ambient: [0,0,0,0], mapSize: [1400, 1400], ao: 0 })
    renderer.render({ frame: frameData, lights: lights.lights, lightCount: lights.lightCount, shadowLightCount: lights.shadowLightCount,
      occluders: lights.occ, occluderCount: lights.occCount, lampPower: lights.power, lampCount: 0,
      view: [-700, -700, 700, 700], batches: [], alphaSprites: empty, alphaCount: 0, addSprites: empty, addCount: 0, grade: [0, 0, 0, settings.exposure] })
    frames++
    requestAnimationFrame(render)
  }
  Object.assign(window, { lot: { camera, settings, renderer, get frames() { return frames }, get paused() { return paused }, set paused(value:boolean) { paused=value }, ready: true } })
  requestAnimationFrame(render)
}
void main().catch(error => { console.error(error); document.getElementById("hud")!.textContent = String(error) })
