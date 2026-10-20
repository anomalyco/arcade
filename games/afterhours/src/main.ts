performance.mark("boot:main")
import * as THREE from "three/webgpu"
import { LabPanel } from "@arcade/kit/lab-panel"
import { keyLabel, moveClusterLabel, onKeyLayoutChange } from "@arcade/kit/client/controls"
import { VIEWPOINTS } from "./world/layout"
import { createLoader } from "./boot/loader"
import { bootWorld } from "./boot/world"
import { resolveMode } from "./game/shell/mode"
import { createPlayShell } from "./game/shell/play"
import { createMap } from "./game/map"
import { hunterControls } from "./game/hunter/settings"
import "./style.css"

// The game page: boot overlay, HUD, frame loop and automation status around the shared world boot (src/boot/world.ts).
// The loading screen stays up until the whole world is built, compiled and settled; `__afterhours.frames` counts frames
// from then on, so automation that waits for N frames sees the complete world.
//
// Two shells (src/game/shell/mode.ts): "play" (the game: home screen, title card, intro, explore, pause; no debug
// tools, no query overrides) and "debug" (/debug in dev, or any ?query from automation: fly, viewpoints, Lab panel).

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

const mode = resolveMode()
const debug = mode === "debug"
if (debug) document.title = "ASHWOOD · debug"
// Play mode ignores the query string: no automation overrides reach the world.
const params = debug ? new URLSearchParams(location.search) : new URLSearchParams()
const shot = params.has("shot")
const canvas = document.querySelector<HTMLCanvasElement>("#view")!
const hud = document.querySelector<HTMLDivElement>("#hud")!
// The play shell mounts its home screen before the boot overlay goes, so the page never flashes empty.
const shell = debug ? null : createPlayShell(canvas, hud)
const loader = createLoader(shot || !debug)

const world = await bootWorld(canvas, params, {
  errors: status.errors,
  onStep: shell ? (label, f) => shell.progress(label, f * 0.15) : loader.step,
  ...(shell ? { view: "lot" as const } : {}),
}).catch((e: unknown) => {
  shell?.fail("")
  throw e
})
const { renderer, camera, player } = world
shell?.attach(world)
// The Wendigo hunter's Lab controls exist before the panel is built; the hunter itself loads after streaming.
hunterControls(world.ctx)
let hunter: { update(dt: number): void } | null = null
// Debug has no run phases: the clipboard map (M) is there from the start. Play creates it at explore (shell/play.ts).
if (!shell) createMap(world)

addEventListener("resize", () => {
  renderer.setSize(innerWidth, innerHeight, false)
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
})

const hint = () =>
  `<div class="hint">Click to look · ${moveClusterLabel()} move · ${keyLabel("ShiftLeft")} run · ${keyLabel("KeyC")} crouch · ${keyLabel("Space")} jump · ${keyLabel("KeyE")} doors / lift · ${keyLabel("KeyF")} flashlight · ${keyLabel("KeyN")} fly · 1–${Object.keys(VIEWPOINTS).length} viewpoints · ${keyLabel("Backquote")} lab</div>`
if (debug && !shot) {
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
  if (shell) shell.frame(dt, time)
  else if (!shot) {
    player.update(dt)
    hunter?.update(dt)
  }
  const t0 = performance.now()
  world.render(dt, time)
  shell?.afterRender(renderer.domElement)
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
  shell?.ready()
  status.complete = true
  status.completeAt = performance.now()
  performance.mark("boot:complete")
}

// Debug: Lab → Story, the dev chapter select (src/game/chapters.ts): jump to a point in the story by its checkpoint.
if (debug && !shot) {
  const chapters = await import("./game/chapters")
  const { heightAt } = await import("./world/height")
  for (const ch of chapters.CHAPTERS)
    world.ctx.controls.push({
      key: `story.${ch.id}`,
      label: ch.label,
      group: "Story",
      type: "action",
      run: () => {
        if (!chapters.chapterReachable(ch)) location.href = `${location.pathname}?view=corridor&story=${ch.id}`
        else void chapters.jumpToChapter(ch, player, heightAt)
      },
    })
  const at = params.get("story")
  if (at) {
    const ch = chapters.chapterById(at)
    if (ch) setTimeout(() => void chapters.jumpToChapter(ch, player, heightAt), 2500)
  }
}
await world.stream({
  onProgress: (stage, f) => (shell ? shell.progress(stage, 0.15 + 0.85 * f) : loader.progress(stage, f)),
  // Created once every module has added its controls (debug only).
  onBuilt: () => {
    if (debug) new LabPanel(world.ctx.settings, world.ctx.controls, params, () => player.release(), { open: false, presets: false })
  },
})
// `?intro` (debug): the opening cutscene straight after boot (src/game/intro), its car warmed behind the loader.
// Debug: the hunter (src/game/hunter), dormant until the 3-08 transmitter is switched off; `?hunter` starts it now.
if (debug && !shot) hunter = (await import("./game/hunter")).installHunter(world, { start: params.get("hunter"), debug: params.has("hunterDebug") })
const intro = params.has("intro") ? await import("./game/intro") : null
if (intro) await intro.prepareIntro(world)
if (shell) shell.progress("settling", 1)
else loader.progress("settling", 1)
settle = SETTLE_FRAMES
if (intro) void intro.runIntro({ world, startAt: Number(params.get("introAt") ?? 0) })
