performance.mark("boot:main")
import * as THREE from "three/webgpu"
import { LabPanel } from "@arcade/kit/lab-panel"
import type { WorldContext, WorldModule } from "./world/context"
import { VIEWPOINTS, type ViewpointName } from "./world/layout"
import { MATERIAL_CONTROLS, MATERIAL_SETTINGS, bindMaterialSettings, loadMaterials } from "./render/materials"
import { createAtmosphere } from "./render/atmosphere"
import { createLighting } from "./render/lighting"
import { createPost } from "./render/post"
import { Player } from "./player"
import { createLoader } from "./boot/loader"
import { nextFrame, yieldToMain } from "./boot/schedule"
import { createWarmup } from "./boot/warmup"
import { distanceTo } from "./boot/priority"
import { decodeTexturesOffThread } from "./boot/textures"
import "./style.css"

// Boot is progressive: every module builds on the CPU first (yielding between them), the light rig is created once
// all lamps are known, and the first frame shows only terrain, sky and fog. The remaining modules then stream in,
// nearest to the player first, each one's pipelines compiled in the background before it joins the scene, so no
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
// Each world module loads on its own so a broken module removes only its part of the world. Build order; terrain is
// shown in the first frame, the rest stream in by distance. LATE modules register no lamps, so they can build after the
// first frame (the light rig turns `ctx.lamps` into lights once, when it is created).
const MODULES: Record<string, () => Promise<Builder>> = {
  terrain: () => import("./world/terrain"),
  roads: () => import("./world/roads"),
  compound: () => import("./world/compound"),
  facility: () => import("./world/facility"),
  forest: () => import("./world/forest"),
  interior: () => import("./world/interior"),
}
const FIRST_FRAME = new Set(["terrain"])
const LATE = new Set(["forest"])

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

let rigCreated = false
async function buildModule(name: string) {
  performance.mark(`mod:${name}:import:start`)
  const m = await imports.get(name)!
  performance.mark(`mod:${name}:build:start`)
  try {
    if (m instanceof Error || !m || typeof (m as Builder).build !== "function") throw m
    // Non-first-frame modules build into a detached group so they can be compiled before they're shown.
    const root = FIRST_FRAME.has(name) ? scene : new THREE.Group()
    root.name ||= name
    const lampStart = ctx.lamps.length
    const mod = await (m as Builder).build({ ...ctx, scene: root as THREE.Scene })
    if (mod?.update) updates.push(mod.update)
    const lamps = ctx.lamps.slice(lampStart)
    if (rigCreated && lamps.length) fail(`${name} registered ${lamps.length} lamps after the light rig was created: remove it from LATE in main.ts`)
    // Lamps light the world from the first frame: sodium pools and halos in the fog read before their poles arrive.
    if (root !== scene) staged.push({ name, root })
  } catch (e) {
    fail(`${name}: ${e instanceof Error ? (e.stack ?? e.message) : e}`)
  }
  performance.mark(`mod:${name}:build:end`)
  await yieldToMain()
}

const early = wanted.filter(([name]) => !LATE.has(name))
for (const [i, [name]] of early.entries()) {
  loader.step(`building ${name}`, 0.1 + (0.6 * i) / early.length)
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
rigCreated = true

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
// Post's dynamic resolution would read the capped frames as slow ones and ratchet the 3D resolution (and its back-off)
// down; hold it off until the world is in.
const autoRes = ctx.settings["post.autoRes"]
if (autoRes) ctx.settings["post.autoRes"] = false
let lastFrame = -Infinity
renderer.setAnimationLoop((now: number) => {
  if (!status.complete && rendered > 2 && now - lastFrame < STREAMING_FRAME_MS - 2) return
  lastFrame = now
  warmup.frame(tick)
})

// ------------------------------------------------------------------------------------------- streaming
for (let i = 0; i < 120 && !warmup.ready; i++) await nextFrame()
for (const [name] of wanted) if (LATE.has(name)) await buildModule(name)
// Created once every module has added its controls.
new LabPanel(ctx.settings, ctx.controls, params, () => player.release(), { open: false, presets: false })

for (const s of staged) warmup.track(s.root)
const eye = camera.getWorldPosition(new THREE.Vector3())
const queue = staged.map((s) => ({ s, d: distanceTo(s.root, eye) })).sort((a, b) => a.d - b.d)
queue.forEach(({ s, d }, i) => performance.mark(`queue:${i}:${s.name}:${Math.round(d)}m`))
let shown = 0
const stream = async (s: Staged) => {
  performance.mark(`mod:${s.name}:compile:start`)
  try {
    await warmup.warm(s.root)
  } catch (e) {
    fail(`${s.name} warm-up: ${e instanceof Error ? e.message : e}`)
  }
  performance.mark(`mod:${s.name}:compile:end`)
  scene.add(s.root)
  performance.mark(`mod:${s.name}:shown`)
  loader.stream(`streaming ${queue[shown + 1]?.s.name ?? ""}`, ++shown, queue.length)
}
// One module at a time: the GPU process compiles pipelines roughly one after another, so running modules side by side
// only delays the nearest one.
const STREAMS = 1
if (queue[0]) loader.stream(`streaming ${queue[0].s.name}`, 0, queue.length)
let next = 0
await Promise.all(
  Array.from({ length: STREAMS }, async () => {
    while (next < queue.length) await stream(queue[next++]!.s)
  }),
)

// Models that already arrived are warming on their own; let them land before calling the world complete.
await warmup.idle()
if (autoRes && ctx.settings["post.autoRes"] === false) ctx.settings["post.autoRes"] = autoRes
loader.done()
status.complete = true
status.completeAt = performance.now()
performance.mark("boot:complete")
