import * as THREE from "three/webgpu"
import { LabPanel } from "@arcade/kit/lab-panel"
import type { WorldContext, WorldModule } from "./world/context"
import { VIEWPOINTS, type ViewpointName } from "./world/layout"
import { MATERIAL_CONTROLS, MATERIAL_SETTINGS, bindMaterialSettings, loadMaterials } from "./render/materials"
import { createAtmosphere } from "./render/atmosphere"
import { createLighting } from "./render/lighting"
import { createPost } from "./render/post"
import { Player } from "./player"
import "./style.css"

type Status = { ready: boolean; frames: number; errors: string[]; frameMs: number[]; gpuMs: number | null }
const status: Status = { ready: false, frames: 0, errors: [], frameMs: [], gpuMs: null }
;(globalThis as { __afterhours?: Status }).__afterhours = status

// Each world module loads on its own so a broken module removes only its part of the world.
const MODULES: Record<string, () => Promise<{ build: (ctx: WorldContext) => WorldModule | void | Promise<WorldModule | void> }>> = {
  terrain: () => import("./world/terrain"),
  forest: () => import("./world/forest"),
  roads: () => import("./world/roads"),
  compound: () => import("./world/compound"),
  facility: () => import("./world/facility"),
  interior: () => import("./world/interior"),
}

const params = new URLSearchParams(location.search)
const shot = params.has("shot")
const canvas = document.querySelector<HTMLCanvasElement>("#view")!
const hud = document.querySelector<HTMLDivElement>("#hud")!


const fail = (message: string) => {
  status.errors.push(message)
  console.error(message)
}

const renderer = new THREE.WebGPURenderer({ canvas, antialias: false, trackTimestamp: params.has("perf") })
await renderer.init()
if (!(renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend) fail("WebGPU unavailable: running on the WebGL fallback")
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.setSize(innerWidth, innerHeight, false)
renderer.toneMapping = THREE.AgXToneMapping
renderer.toneMappingExposure = 1
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFSoftShadowMap

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(68, innerWidth / innerHeight, 0.08, 1600)
const ctx: WorldContext = {
  scene,
  renderer,
  camera,
  colliders: [],
  floors: [],
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
await loadMaterials(renderer).catch((e) => fail(`materials: ${e}`))
const only = params.get("only")?.split(",")
const updates: NonNullable<WorldModule["update"]>[] = []
for (const [name, load] of Object.entries(MODULES)) {
  if (only && !only.includes(name)) continue
  try {
    const mod = await (await load()).build(ctx)
    if (mod?.update) updates.push(mod.update)
  } catch (e) {
    fail(`${name}: ${e instanceof Error ? (e.stack ?? e.message) : e}`)
  }
}

const player = new Player(camera, canvas, ctx, !shot)
const atmosphere = createAtmosphere(ctx)
const lighting = createLighting(ctx, player)
const post = createPost(ctx)

const view = (params.get("view") ?? "road") as ViewpointName
player.teleport(VIEWPOINTS[view] ? view : "road")
if (params.get("flashlight") === "1") player.flashlight = true

new LabPanel(ctx.settings, ctx.controls, params, () => player.release(), { open: false, presets: false })

addEventListener("resize", () => {
  renderer.setSize(innerWidth, innerHeight, false)
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
})

if (!shot) hud.innerHTML = `<div class="hint">Click to look · WASD move · Shift run · F flashlight · N fly · 1–${Object.keys(VIEWPOINTS).length} viewpoints · \` lab</div>`

let last = performance.now()
let time = 0
renderer.setAnimationLoop(() => {
  const now = performance.now()
  const dt = Math.min((now - last) / 1000, 0.1)
  last = now
  time += dt
  if (!shot) player.update(dt)
  for (const u of updates) u(dt, time, camera)
  atmosphere.update(dt, time)
  lighting.update(dt, time)
  post.render()
  status.frames++
  status.frameMs.push(dt * 1000)
  if (status.frameMs.length > 240) status.frameMs.shift()
  if (status.frames === 3) status.ready = true
  if (params.has("perf") && status.frames % 30 === 0) {
    renderer.resolveTimestampsAsync(THREE.TimestampQuery.RENDER).then((ms) => {
      if (typeof ms === "number") status.gpuMs = ms
    })
  }
})
