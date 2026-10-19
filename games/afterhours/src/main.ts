performance.mark("boot:main")
import * as THREE from "three/webgpu"
import { LabPanel } from "@arcade/kit/lab-panel"
import { keyLabel, moveClusterLabel, onKeyLayoutChange } from "@arcade/kit/client/controls"
import { VIEWPOINTS } from "./world/layout"
import { createLoader } from "./boot/loader"
import { bootWorld } from "./boot/world"
import "./style.css"

// The game page: boot overlay, HUD, frame loop and automation status around the shared world boot (src/boot/world.ts).
// The loading screen stays up until the whole world is built, compiled and settled; `__afterhours.frames` counts frames
// from then on, so automation that waits for N frames sees the complete world.

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

const params = new URLSearchParams(location.search)
const shot = params.has("shot")
const canvas = document.querySelector<HTMLCanvasElement>("#view")!
const hud = document.querySelector<HTMLDivElement>("#hud")!
const loader = createLoader(shot)

const world = await bootWorld(canvas, params, { errors: status.errors, onStep: loader.step })
const { renderer, camera, player } = world

addEventListener("resize", () => {
  renderer.setSize(innerWidth, innerHeight, false)
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
})

const hint = () =>
  `<div class="hint">Click to look · ${moveClusterLabel()} move · ${keyLabel("ShiftLeft")} run · ${keyLabel("KeyC")} crouch · ${keyLabel("Space")} jump · ${keyLabel("KeyE")} doors / lift · ${keyLabel("KeyF")} flashlight · ${keyLabel("KeyN")} fly · 1–${Object.keys(VIEWPOINTS).length} viewpoints · ${keyLabel("Backquote")} lab</div>`
if (!shot) {
  hud.innerHTML = hint()
  onKeyLayoutChange(() => (hud.innerHTML = hint()))
}

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
  const t0 = performance.now()
  world.render(dt, time)
  rendered++
  if (rendered <= 3) {
    const n = rendered
    performance.measure(`frame:${n}`, { start: t0 })
    device?.queue.onSubmittedWorkDone().then(() => performance.mark(`frame:${n}:gpu`))
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
// Behind the loading screen the main thread belongs to warming the world: draw only now and then (a frame keeps the
// near-terrain patch and lamp adoption moving and shows the boot is alive). Once it's warm, a few full-rate frames still
// under the cover let temporal AA history, shadow maps and auto exposure settle before the reveal.
const COVERED_FRAME_MS = 500
const SETTLE_FRAMES = 12
let settle = -1
let lastFrame = -Infinity
renderer.setAnimationLoop((now: number) => {
  if (world.streaming && rendered > 2 && now - lastFrame < COVERED_FRAME_MS) return
  lastFrame = now
  tick()
  if (settle > 0 && --settle === 0) reveal()
})

const reveal = () => {
  loader.done()
  status.complete = true
  status.completeAt = performance.now()
  performance.mark("boot:complete")
}

await world.stream({
  onProgress: (stage, f) => loader.progress(stage, f),
  // Created once every module has added its controls.
  onBuilt: () => new LabPanel(world.ctx.settings, world.ctx.controls, params, () => player.release(), { open: false, presets: false }),
})
loader.progress("settling", 1)
settle = SETTLE_FRAMES
