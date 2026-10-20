// Deterministic still capture for pixel-identity proofs (copied into a snapshot root and built with
// bench/pixel/vite.config.ts; never part of the game). Boots the real world exactly as the game does, waits until
// everything is streamed and the background warm-up is done, then takes over the clock: performance.now/Date.now
// return a virtual time advanced by exactly 1/60 s per frame, Math.random is seeded, lamp flicker, wind, grain,
// lightning and rain are off and temporal AA is off (no jitter/history), so the same build renders the same pixels.
// For each requested camera it renders `frames` frames at the fixed time and copies the canvas into a 2-D canvas in
// the same task (pixels in `__pixel.shots[name]` as base64 RGBA).
import * as THREE from "three/webgpu"
import { bootWorld } from "./src/boot/world"
import { VIEWPOINTS, type ViewpointName } from "./src/world/layout"

type Cam = { name: string; view?: string; pos?: [number, number, number]; yaw?: number; pitch?: number }
const g = globalThis as unknown as {
  __vclock: number | null
  __pixel: { ready: boolean; errors: string[]; shots: Record<string, string>; run?: (cams: Cam[], frames: number) => Promise<void> }
  __afterhours?: unknown
}
const params = new URLSearchParams(location.search)
const canvas = document.querySelector<HTMLCanvasElement>("#view")!
const P: typeof g.__pixel = (g.__pixel = { ready: false, errors: [], shots: {} })
;(g as { __afterhours?: unknown }).__afterhours = { errors: P.errors, complete: false, frames: 0, frameMs: [] }
const world = await bootWorld(canvas, params, { view: (params.get("view") as ViewpointName) ?? "lot", errors: P.errors, input: false })
const { ctx, renderer, camera, player } = world
let time = 0
let frames = 0
renderer.setAnimationLoop(() => {
  if (g.__vclock !== null) return
  time += 1 / 60
  frames++
  world.render(1 / 60, time)
})
await world.stream({})
// `world.background` never settles (it keeps warming late arrivals); wait for its first pass, then a quiet spell.
for (let i = 0; i < 1200 && !performance.getEntriesByName("boot:background").length; i++) await new Promise((r) => setTimeout(r, 100))
await new Promise((r) => setTimeout(r, 4000))
for (let i = 0; i < 30; i++) await new Promise((r) => requestAnimationFrame(r))

// `?live` keeps lamp flicker and wind (both follow the fixed clocks, so they're deterministic too).
const FROZEN: Record<string, unknown> = {
  ...(params.has("live") ? {} : { "light.flicker": 0, "forest.wind": 0 }),
  "grade.grain": 0,
  "post.taa": false,
  "post.autoRes": false,
  "weather.lightning": 0,
  "weather.rain": 0,
}

P.run = async (cams: Cam[], n: number) => {
  Object.assign(ctx.settings, FROZEN)
  renderer.setAnimationLoop(null)
  // three's own clock (NodeFrame: TSL `time`, frame ids) is advanced here, once per drawn frame, not by its rAF loop.
  const anim = (renderer as unknown as { _animation: { stop(): void; info: { reset(): void; frame: number; autoReset: boolean } } })._animation
  anim.stop()
  const nf = (renderer as unknown as { _nodes: { nodeFrame: { frameId: number; time: number; deltaTime: number; lastTime: number } } })._nodes.nodeFrame
  let tsl = 0
  const draw = (t: number) => {
    nf.frameId++
    nf.deltaTime = 1 / 60
    tsl += 1 / 60
    nf.time = tsl
    nf.lastTime = g.__vclock!
    if (anim.info.autoReset) anim.info.reset()
    anim.info.frame = nf.frameId
    world.render(1 / 60, t)
  }
  const out = document.createElement("canvas")
  for (const c of cams) {
    // Same clock, same random sequence for every camera and every build.
    g.__vclock = 1_000_000
    seed(12345)
    if (c.view) player.teleport(c.view as ViewpointName)
    else {
      player.pos.x = c.pos![0]
      player.pos.y = c.pos![1]
      player.pos.z = c.pos![2]
      player.yaw = c.yaw ?? 0
      player.pitch = c.pitch ?? 0
      player.resetMotion()
    }
    // The post chain's noise and dither advance with its own frame counter (frame % 64): pad so every capture lands
    // on the same phase, whatever the boot drew. Teleports are camera cuts, which restart the temporal histories.
    const pad = (64 - (frames % 64)) % 64
    let t = 12
    for (let i = 0; i < pad; i++) {
      g.__vclock += 1000 / 60
      player.update(0)
      draw(t)
      frames++
    }
    // Same clocks and random sequence from here on, whatever the padding was.
    tsl = 100
    g.__vclock = 2_000_000
    seed(54321)
    for (let i = 0; i < n; i++) {
      g.__vclock += 1000 / 60
      t += 1 / 60
      player.update(0)
      draw(t)
      frames++
      if (i === n - 1) {
        out.width = canvas.width
        out.height = canvas.height
        const g2 = out.getContext("2d", { willReadFrequently: true })!
        g2.drawImage(canvas, 0, 0)
        const px = g2.getImageData(0, 0, out.width, out.height).data
        let s = ""
        const CH = 0x8000
        for (let k = 0; k < px.length; k += CH) s += String.fromCharCode(...px.subarray(k, k + CH))
        P.shots[c.name] = `${out.width}x${out.height}:${btoa(s)}`
      }
      await (renderer.backend as unknown as { device: GPUDevice }).device.queue.onSubmittedWorkDone()
    }
  }
}
P.ready = true
void THREE
void VIEWPOINTS

function seed(s: number) {
  let a = s >>> 0
  Math.random = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let x = a
    x = Math.imul(x ^ (x >>> 15), x | 1)
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61)
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}
