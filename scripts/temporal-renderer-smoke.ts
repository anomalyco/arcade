/**
 * Off-browser integration smoke for the shared Renderer's temporal path: constructs `@arcade/kit/gpu/renderer` with
 * Outbreak's real shaders on the machine's WebGPU (Deno's wgpu on Metal), then draws frames in every anti-aliasing
 * mode (MSAA, TAA, TAA + upscale) with sprites (reactive mask), the volumetric light, look pipelines and a resize,
 * and fails on any WebGPU validation error.
 *
 *   deno run -A --sloppy-imports scripts/temporal-renderer-smoke.ts
 */
import { mat4 } from "wgpu-matrix"
import { LIGHT_FLOATS, MAX_LIGHTS, MAX_OCCLUDERS, OCC_FLOATS, MAX_MAP_LIGHTS } from "../packages/kit/limits"
import { FRAME_FLOATS } from "../packages/kit/gpu/shaders"
import { Renderer, SPRITE_FLOATS, type FrameInput, type TemporalSettings } from "../packages/kit/gpu/renderer"
import { createLookSettings } from "../packages/kit/gpu/look"
import { shaders } from "../games/outbreak/src/shaders"

const adapter = await navigator.gpu.requestAdapter()
if (!adapter) throw new Error("no WebGPU adapter")
const device = await adapter.requestDevice()
const errors: string[] = []
device.addEventListener("uncapturederror", (e) => errors.push((e as GPUUncapturedErrorEvent).error.message))
const format: GPUTextureFormat = "bgra8unorm"
const ctx = { getCurrentTexture: () => target } as unknown as GPUCanvasContext
let target = device.createTexture({ size: [640, 360], format, usage: GPUTextureUsage.RENDER_ATTACHMENT })

const renderer = new Renderer(device, ctx, format, shaders)
renderer.resize(640, 360)

const frame = new Float32Array(FRAME_FLOATS)
const vp = mat4.multiply(mat4.perspective(0.6, 640 / 360, 1, 200), mat4.lookAt([0, 30, 20], [0, 0, 0], [0, 1, 0]))
frame.set(vp, 0)
frame.set([0, 30, 20, 1], 16)
frame.set([640, 360, 2, 0], 20)
frame.set([0.05, 0.06, 0.08, 0.2], 28)
const lights = new Float32Array(MAX_LIGHTS * LIGHT_FLOATS)
lights.set([0, 1.2, 0, 12, 1, 0.9, 0.7, 1, 0, -1, 0.9, 1, -1, 0, 0, -1], 0)
lights.set([3, 2, 3, 6, 1, 0.6, 0.3, 1, 0, 0, 0, 0, -1, 0, 0, -1], LIGHT_FLOATS)
const alpha = new Float32Array(64 * SPRITE_FLOATS)
const add = new Float32Array(64 * SPRITE_FLOATS)
for (let i = 0; i < 16; i++) {
  alpha.set([i - 8, 0.5, 2, 0.6, 0.3, 0.3, 0.3, 0.5, 0, 0, 0, 0], i * SPRITE_FLOATS)
  add.set([i - 8, 1, -2, 0.4, 1, 0.5, 0.1, 1, 0, 0, 0, 0], i * SPRITE_FLOATS)
}
const f: FrameInput = {
  frame,
  lights,
  lightCount: 2,
  shadowLightCount: 1,
  occluders: new Float32Array(MAX_OCCLUDERS * OCC_FLOATS),
  occluderCount: 0,
  lampPower: new Float32Array(MAX_MAP_LIGHTS),
  lampCount: 0,
  view: [-30, -30, 30, 30],
  batches: [],
  alphaSprites: alpha,
  alphaCount: 16,
  addSprites: add,
  addCount: 16,
  volume: { downscale: 2 },
  grade: [0, 0, 0, 1],
}

const modes: (TemporalSettings | null)[] = [
  null,
  { mode: "taa", renderScale: 1, sharpen: 0.35, history: 0.9 },
  { mode: "taau", renderScale: 0.67, sharpen: 0.35, history: 0.9 },
  { mode: "taau", renderScale: 0.5, sharpen: 0, history: 0.85 },
  null,
]
const report: Record<string, unknown>[] = []
for (const m of modes) {
  for (const look of [null, createLookSettings("noir")]) {
    renderer.setTemporal(m)
    f.look = look
    for (let i = 0; i < 6; i++) {
      frame[16] += 0.05
      renderer.drawTo(f, target.createView())
      await device.queue.onSubmittedWorkDone()
    }
    report.push({ mode: m?.mode ?? "msaa", scale: m?.renderScale ?? 1, look: look ? "noir" : "none", internal: [renderer.internalWidth, renderer.internalHeight], state: renderer.temporalState })
  }
}
// Resize under upscale, then a camera cut.
renderer.setTemporal(modes[2]!)
target = device.createTexture({ size: [800, 450], format, usage: GPUTextureUsage.RENDER_ATTACHMENT })
renderer.resize(800, 450)
frame[20] = 800
frame[21] = 450
for (let i = 0; i < 3; i++) renderer.drawTo(f, target.createView())
frame[16] += 50
renderer.drawTo(f, target.createView())
await device.queue.onSubmittedWorkDone()
report.push({ afterResizeAndCut: renderer.temporalState })
const restored = frame[20] === 800 && frame[21] === 450 && frame[0] === vp[0]
await new Promise((r) => setTimeout(r, 200))
console.log(JSON.stringify(report, null, 1))
console.log(`frame restored after draw: ${restored}`)
console.log(errors.length ? `ERRORS (${errors.length}):\n${[...new Set(errors)].join("\n")}` : "no WebGPU errors")
if (errors.length || !restored) throw new Error("temporal renderer smoke failed")
console.log("PASS")
