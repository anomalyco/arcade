import { mat4 } from "wgpu-matrix"
import { FirstPerson } from "@arcade/kit/client/first-person"
import { keyPromptHtml } from "@arcade/kit/client/key-cap"
import { openGpu } from "@arcade/kit/gpu/boot"
import { loadGltf, imageTexture } from "@arcade/kit/gpu/gltf"
import { createLookSettings } from "@arcade/kit/gpu/look"
import { packVerts } from "@arcade/kit/gpu/mesh"
import { Renderer } from "@arcade/kit/gpu/renderer"
import { flatLighting, newSceneFrame, packSceneFrame, SceneLights } from "@arcade/kit/gpu/scene-frame"
import { makeSceneShader, spriteShader } from "@arcade/kit/gpu/shaders"
import { TexturedMeshPass, packTexturedVerts } from "@arcade/kit/gpu/textured-mesh"
import { TEMPORAL_DEFAULTS } from "@arcade/kit/gpu/temporal"
import { LabPanel } from "@arcade/kit/lab-panel"
import { controls, defaults } from "./settings"
import { hooks } from "./shaders"
import { buildWorld, CAR, START, walls } from "./world"

async function main() {
  const canvas = document.querySelector<HTMLCanvasElement>("#view")!
  const hud = document.getElementById("hud")!
  hud.textContent = "Loading the lot…"
  const gpu = await openGpu(canvas, "LOT")
  if (typeof gpu === "string") throw new Error(gpu)
  const shader = makeSceneShader(hooks)
  const renderer = new Renderer(gpu.device, gpu.context, gpu.format, { scene: shader, sprite: spriteShader(), lookScene: shader })
  const settings = defaults()
  const look = createLookSettings("current")
  Object.assign(look, { tonemap: 2, exposure: settings.exposure, bloom: 0.65, grain: 0.08, grainAnimated: false, vignette: 0.2 })
  renderer.setLook(look)
  renderer.setTemporal({ ...TEMPORAL_DEFAULTS, mode: "taa", sharpen: 0.12 })
  const world = buildWorld()
  const lighting = flatLighting(0, 0, [0, 0, 0])
  renderer.setLevel({ chunks: [{ data: packVerts(world.mesh.v), box: [-200, -130, 200, 250] }], glass: [], ...lighting })

  const base = import.meta.env.BASE_URL + "assets/"
  const transform = mat4.translation([CAR.x, 0.04, CAR.z])
  mat4.rotateY(transform, CAR.yaw, transform)
  const car = await loadGltf(gpu.device, base + "wagon.glb", transform)
  const textures = await Promise.all(["asphalt.jpg", "asphalt-normal.jpg", "asphalt-orm.jpg"].map(async (file, i) => {
    const r = await fetch(base + file)
    if (!r.ok) throw new Error(`${file}: ${r.status}`)
    return imageTexture(gpu.device, new Uint8Array(await r.arrayBuffer()), i === 0, "image/jpeg")
  }))
  const uv: number[] = []
  for (let i = 0; i < world.ground.v.length; i += 11) uv.push(world.ground.v[i]! / 6, world.ground.v[i + 2]! / 6)
  const meshes = new TexturedMeshPass(renderer.passContext, [{
    vertices: packTexturedVerts(world.ground.v, uv), base: textures[0]!, normal: textures[1]!, orm: textures[2]!,
    color: [1, 1, 1, 1], roughness: 1, metalness: 0, normalScale: 0.45, blend: false, aoStrength: 1,
  }, ...car.primitives], hooks)
  renderer.addPass("opaque", meshes)

  const camera = new FirstPerson(canvas, () => panel.visible)
  camera.body.x = START.x; camera.body.y = START.z; camera.yaw = START.yaw; camera.pitch = START.pitch
  const panel = new LabPanel(settings, controls(settings), new URLSearchParams(location.search), () => camera.release(), { open: false, pill: false, groupActions: false })
  // LabPanel owns Backquote, including when the canvas is pointer-locked.
  const lights = new SceneLights()
  lights.setBoxes([{ rect: walls[0]!, h: 19.6 }, { rect: walls[5]!, h: 1.55 }])
  const frameData = newSceneFrame(), custom = new Float32Array(12), empty = new Float32Array(0)
  const prompts = () => {
    hud.innerHTML = [document.pointerLockElement === canvas ? "" : keyPromptHtml("Mouse0", "Look"), keyPromptHtml("KeyW", "Move"), keyPromptHtml("KeyF", "Flashlight"), keyPromptHtml("Backquote", "Night")].join(" ")
  }
  prompts()
  document.addEventListener("pointerlockchange", prompts)
  let last = performance.now(), frames = 0
  function render(now: number) {
    const width = Math.max(1, Math.round(innerWidth * Math.min(devicePixelRatio, 1.5)))
    const height = Math.max(1, Math.round(innerHeight * Math.min(devicePixelRatio, 1.5)))
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; renderer.resize(width, height) }
    const dt = Math.min(0.05, (now - last) / 1000); last = now
    const vp = camera.update(dt, width / height, walls)
    lights.update([{ x: -6.5, y: 100, h: 9.1, r: 32, color: [1, 0.55, 0.18], power: settings.lamp, size: 0.6 }], [])
    custom.set([settings.density, settings.falloff, settings.sky, settings.lamp, settings.wetness, settings.haze, 0, 0, ...camera.direction, Number(camera.flashlight)])
    renderer.setCustomUniforms(custom)
    if (look.exposure !== settings.exposure) { look.exposure = settings.exposure; renderer.setLook(look) }
    packSceneFrame(frameData, { viewProj: vp, eye: camera.eye, time: 0, width, height, lightCount: lights.lightCount,
      ambient: [0.035 * settings.sky, 0.045 * settings.sky, 0.06 * settings.sky, 0], mapSize: [400, 400], ao: 0 })
    renderer.render({ frame: frameData, lights: lights.lights, lightCount: lights.lightCount, shadowLightCount: lights.shadowLightCount,
      occluders: lights.occ, occluderCount: lights.occCount, lampPower: lights.power, lampCount: 0,
      view: [-200, -130, 200, 250], batches: [], alphaSprites: empty, alphaCount: 0, addSprites: empty, addCount: 0, grade: [0, 0, 0, 1] })
    frames++
    requestAnimationFrame(render)
  }
  Object.assign(window, { lot: { camera, settings, renderer, get frames() { return frames }, ready: true } })
  requestAnimationFrame(render)
}
void main().catch(error => { console.error(error); document.getElementById("hud")!.textContent = String(error) })
