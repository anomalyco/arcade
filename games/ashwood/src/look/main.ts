import * as THREE from "three/webgpu"
import { LabPanel, type LabSettings } from "@arcade/kit/lab-panel"
import { createLoader } from "../boot/loader"
import { heightAt } from "../world/height"
import { VIEWPOINTS, type ViewpointName } from "../world/layout"
import { bootWorld } from "../boot/world"
import { CAMERA_PRESETS, LOOK_PRESETS, QUALITY, type CameraPreset } from "./presets"
import { createLookUi } from "./ui"
import "./look.css"

// Realism Look Lab: the real game world under a controllable frame loop. Every frame renders one *settings layer
// stack*: the settings being edited (slot A or B, i.e. ctx.settings, which the Lab panel edits), then the quality
// override, then the freeze override. Stills (A/B compare, contact sheet) are rendered offscreen-in-place: the stack is
// swapped to the variant, a few frames settle the temporal AA on the same camera, and the canvas is copied out.

type Quality = keyof typeof QUALITY
type Status = { ready: boolean; complete: boolean; frames: number; errors: string[]; frameMs: number[] }

const params = new URLSearchParams(location.search)
const shot = params.has("shot")
const canvas = document.querySelector<HTMLCanvasElement>("#view")!
const stage = document.querySelector<HTMLDivElement>("#stage")!
const loader = createLoader(shot)
const status: Status = { ready: false, complete: false, frames: 0, errors: [], frameMs: [] }
;(globalThis as { __ashwood?: Status }).__ashwood = status
if (shot) document.body.classList.add("shot")

const world = await bootWorld(canvas, params, { view: "lot", errors: status.errors, onStep: (label, f) => loader.step(label, f) })
const { ctx, renderer, camera, player } = world

// ------------------------------------------------------------------------------------------- view size
/** CSS size of the 3D view; the stage keeps the concept art's 3:2 frame. */
const viewSize = { w: 1536, h: 1024 }
const sizeV = new THREE.Vector2()
const enforceSize = () => {
  renderer.getSize(sizeV)
  if (sizeV.x !== viewSize.w || sizeV.y !== viewSize.h) renderer.setSize(viewSize.w, viewSize.h, false)
  if (Math.abs(camera.aspect - viewSize.w / viewSize.h) > 1e-4) {
    camera.aspect = viewSize.w / viewSize.h
    camera.updateProjectionMatrix()
  }
}
const setViewSize = (w: number, h: number) => {
  viewSize.w = Math.max(32, Math.round(w))
  viewSize.h = Math.max(32, Math.round(h))
  canvas.style.width = `${viewSize.w}px`
  canvas.style.height = `${viewSize.h}px`
  enforceSize()
}

// ------------------------------------------------------------------------------------------- settings layers
const state = {
  freeze: true,
  quality: (params.get("quality") as Quality) ?? "balanced",
  time: 12,
}
/** Overrides applied on top of whatever settings render this frame (never written into snapshots). */
const overlay = (): LabSettings => ({
  // Dynamic resolution would read stills and wipes as slow frames; the Lab keeps a fixed resolution.
  "post.autoRes": false,
  ...QUALITY[state.quality],
  ...(state.freeze ? { "light.flicker": 0, "forest.wind": 0 } : {}),
})

const saved: LabSettings = {}
/** Renders one frame with `settings` (full snapshot or null for the live ctx.settings) under the overlay. */
const frame = (settings: LabSettings | null, dt: number) => {
  const live = ctx.settings
  for (const k of Object.keys(saved)) delete saved[k]
  Object.assign(saved, live)
  if (settings) Object.assign(live, settings)
  Object.assign(live, overlay())
  if (!state.freeze) state.time += dt
  enforceSize()
  world.render(dt, state.time)
  enforceSize()
  for (const k of Object.keys(live)) if (!(k in saved)) delete live[k]
  Object.assign(live, saved)
}

// ------------------------------------------------------------------------------------------- camera presets
let cameraPreset: CameraPreset | null = null
const groundAt = (x: number, z: number) => {
  let g = heightAt(x, z)
  for (const f of ctx.floors) if (x >= f.min[0] && x <= f.max[0] && z >= f.min[1] && z <= f.max[1] && f.y > g && f.y < g + 3) g = f.y
  return g
}
const setCamera = (id: string | CameraPreset) => {
  const p = typeof id === "string" ? CAMERA_PRESETS.find((c) => c.id === id) : id
  const vp = typeof id === "string" ? VIEWPOINTS[id as ViewpointName] : undefined
  if (p) {
    cameraPreset = p
    player.fly = true
    player.pos.x = p.eye[0]
    player.pos.z = p.eye[2]
    player.pos.y = groundAt(p.eye[0], p.eye[2]) + p.eye[1] - 1.65
    player.yaw = p.yaw
    player.pitch = p.pitch
    camera.fov = p.fov
  } else if (vp) {
    cameraPreset = null
    player.fly = false
    player.teleport(id as ViewpointName)
    camera.fov = 68
  } else return
  camera.updateProjectionMatrix()
  player.update(0)
}
/** The live camera as a preset (to paste into presets.ts while tuning a concept match). */
const cameraNow = () => ({
  eye: [+player.pos.x.toFixed(2), +(player.pos.y + 1.65 - groundAt(player.pos.x, player.pos.z)).toFixed(2), +player.pos.z.toFixed(2)],
  yaw: +player.yaw.toFixed(3),
  pitch: +player.pitch.toFixed(3),
  fov: camera.fov,
})

// ------------------------------------------------------------------------------------------- stills
type Job = { variants: (LabSettings | null)[]; targets: HTMLCanvasElement[]; i: number; n: number; settle: number; resolve: () => void }
let job: Job | null = null
const settleFrames = () => (state.quality === "max" ? 36 : state.quality === "fast" ? 16 : 24)
/** Renders each variant on the current camera and copies the frame into the matching canvas. */
const renderStills = (variants: (LabSettings | null)[], targets: HTMLCanvasElement[]) =>
  new Promise<void>((resolve) => {
    job?.resolve()
    job = { variants, targets, i: 0, n: 0, settle: settleFrames(), resolve }
  })
const stepJob = (j: Job) => {
  frame(j.variants[j.i] ?? null, 1 / 60)
  if (++j.n < j.settle) return
  const out = j.targets[j.i]!
  const g = out.getContext("2d")!
  // Same task as the render: the WebGPU canvas still holds this frame.
  g.drawImage(canvas, 0, 0, out.width, out.height)
  j.i++
  j.n = 0
  if (j.i >= j.variants.length) {
    job = null
    j.resolve()
  }
}

// ------------------------------------------------------------------------------------------- frame loop
let last = performance.now()
let rendered = 0
renderer.setAnimationLoop(() => {
  const now = performance.now()
  const dt = Math.min((now - last) / 1000, 0.1)
  last = now
  if (!shot) player.update(dt)
  if (job) stepJob(job)
  else frame(null, dt)
  if (++rendered === 1) loader.live()
  if (!status.complete) return
  status.frames++
  status.frameMs.push(dt * 1000)
  if (status.frameMs.length > 240) status.frameMs.shift()
  if (status.frames === 3) status.ready = true
})

// ------------------------------------------------------------------------------------------- automation + boot
const lookApi = {
  ctx,
  state,
  setCamera,
  cameraNow,
  applyLook: (id: string) => ui?.applyLook(id),
  presets: { camera: CAMERA_PRESETS, look: LOOK_PRESETS },
}
;(globalThis as { __look?: unknown }).__look = lookApi

let ui: ReturnType<typeof createLookUi> | null = null
setViewSize(shot ? innerWidth : 1536, shot ? innerHeight : 1024)
const initialCam = params.get("cam") ?? "r3-01"
setCamera(initialCam)

await world.stream({
  onBuilt: () => {
    const defaults = structuredClone(ctx.settings)
    if (shot) {
      const look = LOOK_PRESETS.find((p) => p.id === params.get("look"))
      if (look) Object.assign(ctx.settings, look.settings)
      addEventListener("resize", () => setViewSize(innerWidth, innerHeight))
      return
    }
    const panel = new LabPanel(ctx.settings, ctx.controls, params, () => player.release(), { open: false, presets: false })
    ui = createLookUi({ ctx, stage, canvas, panel, defaults, state, setViewSize, setCamera, cameraNow, renderStills, getCameraPreset: () => cameraPreset })
    ui.setCamera(initialCam)
  },
  onShown: (name, done, total) => loader.stream(`streaming ${name}`, done, total),
})
// The camera may have been placed before every floor existed (interiors): re-seat it on the finished world.
setCamera((cameraPreset as CameraPreset | null)?.id ?? initialCam)
loader.done()
status.complete = true
