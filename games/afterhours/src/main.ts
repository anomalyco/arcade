performance.mark("boot:main")
import * as THREE from "three/webgpu"
import { LabPanel } from "@arcade/kit/lab-panel"
import type { WorldContext, WorldModule } from "./world/context"
import { VIEWPOINTS, type ViewpointName } from "./world/layout"
import { MATERIAL_CONTROLS, MATERIAL_SETTINGS, bindMaterialSettings, loadMaterials } from "./render/materials"
import { createAtmosphere, insideBuilding } from "./render/atmosphere"
import { createLighting } from "./render/lighting"
import { createPost } from "./render/post"
import { Player } from "./player"
import { createLoader } from "./boot/loader"
import { nextFrame, yieldToMain } from "./boot/schedule"
import { createWarmup } from "./boot/warmup"
import { distanceTo } from "./boot/priority"
import { decodeTexturesOffThread } from "./boot/textures"
import "./style.css"

// Boot is progressive: only terrain builds before the first frame (terrain, sky, fog). The remaining modules build
// after it (the light rig adopts their lamps as they register) and stream in nearest to the player first, each one's pipelines compiled in the background before it joins the scene, so no
// frame stalls on shader compilation. `__afterhours.frames` only counts frames once everything is in, so automation
// that waits for N frames still sees the complete world.

type Status = {
  ready: boolean
  complete: boolean
  completeAt: number | null
  frames: number
  errors: string[]
  frameMs: number[]
  gpuMs: number | null
}
const status: Status = { ready: false, complete: false, completeAt: null, frames: 0, errors: [], frameMs: [], gpuMs: null }
;(globalThis as { __afterhours?: Status }).__afterhours = status

type Builder = { build: (ctx: WorldContext) => WorldModule | void | Promise<WorldModule | void> }
// Each world module loads on its own so a broken module removes only its part of the world. Terrain builds before the
// first frame; the rest build after it (the light rig adopts lamps registered later) and stream in nearest first.
const MODULES: Record<string, () => Promise<Builder>> = {
  terrain: () => import("./world/terrain"),
  roads: () => import("./world/roads"),
  compound: () => import("./world/compound"),
  facility: () => import("./world/facility"),
  forest: () => import("./world/forest"),
  interior: () => import("./world/interior"),
}
const FIRST_FRAME = new Set(["terrain"])
/** Build order after the first frame (each is shown as soon as it's the nearest built one). */
const OUTDOOR_ORDER = ["forest", "roads", "compound", "facility", "interior"]
const INDOOR_ORDER = ["interior", "facility", "compound", "roads", "forest"]

const params = new URLSearchParams(location.search)
const shot = params.has("shot")
const canvas = document.querySelector<HTMLCanvasElement>("#view")!
const hud = document.querySelector<HTMLDivElement>("#hud")!
const loader = createLoader(shot)

const fail = (message: string) => {
  status.errors.push(message)
  console.error(message)
}

const only = params.get("only")?.split(",")
const wanted = Object.entries(MODULES).filter(([name]) => !only || only.includes(name))
// Start every module download now; in dev each is a tree of unbundled files.
const imports = new Map(wanted.map(([name, load]) => [name, load().catch((e: unknown) => e)]))

loader.step("starting webgpu", 0.05)
const renderer = new THREE.WebGPURenderer({ canvas, antialias: false, trackTimestamp: params.has("perf") })
performance.mark("gpu:init:start")
await renderer.init()
performance.mark("gpu:init:end")
if (!(renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend) fail("WebGPU unavailable: running on the WebGL fallback")
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.setSize(innerWidth, innerHeight, false)
renderer.toneMapping = THREE.AgXToneMapping
renderer.toneMappingExposure = 1
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFShadowMap

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(68, innerWidth / innerHeight, 0.08, 1600)
;(globalThis as { __afterhoursDebug?: unknown }).__afterhoursDebug = { renderer, scene, camera }
const ctx: WorldContext = {
  scene,
  renderer,
  camera,
  colliders: [],
  floors: [],
  ladders: [],
  lamps: [],
  settings: { "player.walk": 1.9, "player.sensitivity": 1 },
  controls: [
    { key: "player.walk", label: "Walk speed", group: "Player", unit: "m/s", min: 0.8, max: 4, step: 0.1 },
    { key: "player.sensitivity", label: "Mouse sensitivity", group: "Player", min: 0.2, max: 3, step: 0.05 },
  ],
  params,
}

Object.assign(ctx.settings, MATERIAL_SETTINGS)
bindMaterialSettings(ctx.settings)
ctx.controls.push(...MATERIAL_CONTROLS)
// Textures download and decode while the modules build; only the first frame waits for them.
performance.mark("materials:start")
decodeTexturesOffThread()
const materials = loadMaterials(renderer)
  .catch((e) => fail(`materials: ${e}`))
  .finally(() => performance.mark("materials:end"))

// ------------------------------------------------------------------------------------------- CPU builds
type Staged = { name: string; root: THREE.Object3D }
const staged: Staged[] = []
const updates: NonNullable<WorldModule["update"]>[] = []

async function buildModule(name: string) {
  performance.mark(`mod:${name}:import:start`)
  const m = await imports.get(name)!
  performance.mark(`mod:${name}:build:start`)
  try {
    if (m instanceof Error || !m || typeof (m as Builder).build !== "function") throw m
    // Non-first-frame modules build into a detached group so they can be compiled before they're shown.
    const root = FIRST_FRAME.has(name) ? scene : new THREE.Group()
    root.name ||= name
    const mod = await (m as Builder).build({ ...ctx, scene: root as THREE.Scene })
    if (mod?.update) updates.push(mod.update)
    // Lamps (adopted by the light rig on its next update) light the world right away: sodium pools and halos in the fog
    // read before their poles finish compiling.
    if (root !== scene) staged.push({ name, root })
  } catch (e) {
    fail(`${name}: ${e instanceof Error ? (e.stack ?? e.message) : e}`)
  }
  performance.mark(`mod:${name}:build:end`)
  await yieldToMain()
}

for (const [name] of wanted) {
  if (!FIRST_FRAME.has(name)) continue
  loader.step(`building ${name}`, 0.4)
  await buildModule(name)
}

// ------------------------------------------------------------------------------------------- render rig
performance.mark("rig:start")
loader.step("lighting", 0.75)
const player = new Player(camera, canvas, ctx, !shot)
const atmosphere = createAtmosphere(ctx)
const lighting = createLighting(ctx, player)
const post = createPost(ctx)
// `bootSlice` (ms, automation/A-B only): compile time allowed per frame while streaming.
const warmup = createWarmup(renderer, scene, camera, Number(params.get("bootSlice") ?? 8))
// Dynamic resolution would read capped streaming frames as slow ones; paused until the world is in.
post.setBooting(true)

const view = (params.get("view") ?? "road") as ViewpointName
player.teleport(VIEWPOINTS[view] ? view : "road")
if (params.get("flashlight") === "1") player.flashlight = true

performance.mark("rig:end")

addEventListener("resize", () => {
  renderer.setSize(innerWidth, innerHeight, false)
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
})

if (!shot) hud.innerHTML = `<div class="hint">Click to look · WASD move · Shift run · F flashlight · N fly · 1–${Object.keys(VIEWPOINTS).length} viewpoints · \` lab</div>`

loader.step("textures", 0.85)
await materials
loader.step("compiling", 0.95)

// ------------------------------------------------------------------------------------------- frame loop
const device = (renderer.backend as unknown as { device?: GPUDevice }).device
let rendered = 0
let last = performance.now()
let time = 0
const tick = () => {
  const now = performance.now()
  const dt = Math.min((now - last) / 1000, 0.1)
  last = now
  time += dt
  if (!shot) player.update(dt)
  for (const u of updates) u(dt, time, camera)
  atmosphere.update(dt, time)
  lighting.update(dt, time)
  const t0 = performance.now()
  post.render()
  rendered++
  if (rendered <= 3) {
    const n = rendered
    performance.measure(`frame:${n}`, { start: t0 })
    device?.queue.onSubmittedWorkDone().then(() => performance.mark(`frame:${n}:gpu`))
    if (n === 1) loader.live()
  }
  if (!status.complete) return
  status.frames++
  status.frameMs.push(dt * 1000)
  if (status.frameMs.length > 240) status.frameMs.shift()
  if (status.frames === 3) status.ready = true
  if (params.has("perf") && status.frames % 30 === 0) {
    renderer.resolveTimestampsAsync(THREE.TimestampQuery.RENDER).then((ms) => {
      if (typeof ms === "number") status.gpuMs = ms
    })
  }
}
// While the world streams in, frames are capped: at full rate the render loop took ~30% of the main thread that
// shader building needs (measured at 4× CPU throttling), so everything arrived much later.
const STREAMING_FRAME_MS = 1000 / 15
let lastFrame = -Infinity
renderer.setAnimationLoop((now: number) => {
  if (!status.complete && rendered > 2 && now - lastFrame < STREAMING_FRAME_MS - 2) return
  lastFrame = now
  warmup.frame(tick)
})

// ------------------------------------------------------------------------------------------- streaming
for (let i = 0; i < 120 && !warmup.ready; i++) await nextFrame()
// Producer: build the remaining modules (yielding between them) in a view-dependent order. Consumer: warm up and show
// whichever built module is nearest, one at a time (the GPU process compiles pipelines roughly one after another, so
// side-by-side warm-ups only delay the nearest one).
const eye = camera.getWorldPosition(new THREE.Vector3())
const order = insideBuilding(eye) ? INDOOR_ORDER : OUTDOOR_ORDER
const pending = wanted.map(([name]) => name).filter((n) => !FIRST_FRAME.has(n))
pending.sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99))
const total = pending.length
let builtAll = false
const signal: { wake: (() => void) | null } = { wake: null }
const ready: { s: Staged; d: number }[] = []
const producer = (async () => {
  for (const name of pending) {
    const before = staged.length
    await buildModule(name)
    for (const s of staged.slice(before)) {
      warmup.track(s.root)
      const d = distanceTo(s.root, eye)
      performance.mark(`queue:${s.name}:${Math.round(d)}m`)
      ready.push({ s, d })
    }
    signal.wake?.()
  }
  builtAll = true
  signal.wake?.()
  // Created once every module has added its controls.
  new LabPanel(ctx.settings, ctx.controls, params, () => player.release(), { open: false, presets: false })
})()

let shown = 0
loader.stream(`streaming ${pending[0] ?? ""}`, 0, total)
while (!builtAll || ready.length) {
  if (!ready.length) {
    await new Promise<void>((resolve) => (signal.wake = resolve))
    signal.wake = null
    continue
  }
  ready.sort((a, b) => a.d - b.d)
  const { s } = ready.shift()!
  performance.mark(`mod:${s.name}:compile:start`)
  try {
    await warmup.warm(s.root)
  } catch (e) {
    fail(`${s.name} warm-up: ${e instanceof Error ? e.message : e}`)
  }
  performance.mark(`mod:${s.name}:compile:end`)
  scene.add(s.root)
  performance.mark(`mod:${s.name}:shown`)
  loader.stream(`streaming ${ready[0]?.s.name ?? pending[shown + 1] ?? ""}`, ++shown, total)
}
await producer

// Models that already arrived are warming on their own; let them land before calling the world complete.
await warmup.idle()
post.setBooting(false)
loader.done()
status.complete = true
status.completeAt = performance.now()
performance.mark("boot:complete")
