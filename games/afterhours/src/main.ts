performance.mark("boot:main")
import * as THREE from "three/webgpu"
import { LabPanel } from "@arcade/kit/lab-panel"
import { VIEWPOINTS } from "./world/layout"
import { createLoader } from "./boot/loader"
import { bootWorld } from "./boot/world"
import "./style.css"

// The game page: boot overlay, HUD, frame loop and automation status around the shared world boot (src/boot/world.ts).
// `__afterhours.frames` only counts frames once everything is in, so automation that waits for N frames still sees the
// complete world.

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

if (!shot) hud.innerHTML = `<div class="hint">Click to look · WASD move · Shift run · E doors / lift · F flashlight · N fly · 1–${Object.keys(VIEWPOINTS).length} viewpoints · \` lab</div>`

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
// While the world streams in, the main thread belongs to shader building (the frame loop took 22% of a 4× CPU boot at
// 15 fps): draw at ~5 fps, plus a frame as soon as something new appears (≥ 100 ms apart) and while the player moves.
// `bootFps` (automation/A-B only) overrides the streaming frame rate.
const STREAMING_FRAME_MS = 1000 / Number(params.get("bootFps") ?? 5)
const REVEAL_FRAME_MS = 100
let lastInput = -Infinity
for (const type of ["keydown", "pointermove", "pointerdown"]) addEventListener(type, () => (lastInput = performance.now()), { passive: true })
const keys = new Set<string>()
addEventListener("keydown", (e) => keys.add((e as KeyboardEvent).code))
addEventListener("keyup", (e) => keys.delete((e as KeyboardEvent).code))
addEventListener("blur", () => keys.clear())
let lastFrame = -Infinity
renderer.setAnimationLoop((now: number) => {
  const since = now - lastFrame
  const wanted = since >= STREAMING_FRAME_MS - 2 || (since >= REVEAL_FRAME_MS && (world.takeReveal() || keys.size > 0 || now - lastInput < 300))
  if (world.streaming && rendered > 2 && !wanted) return
  lastFrame = now
  tick()
})

loader.stream("streaming", 0, 1)
await world.stream({
  onShown: (name, done, total) => loader.stream(`streaming · ${name} in`, done, total),
  // Created once every module has added its controls.
  onBuilt: () => new LabPanel(world.ctx.settings, world.ctx.controls, params, () => player.release(), { open: false, presets: false }),
})
loader.done()
status.complete = true
status.completeAt = performance.now()
performance.mark("boot:complete")
